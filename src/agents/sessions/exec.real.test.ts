import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execCommand } from "./exec.js";

const cleanupPids = new Set<number>();

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function forceKillPid(pid: number): void {
  if (!isProcessAlive(pid)) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/F", "/T", "/PID", String(pid)], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The process exited between the liveness check and cleanup.
  }
}

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  await vi.waitFor(() => expect(existsSync(filePath)).toBe(true), {
    timeout: timeoutMs,
    interval: 25,
  });
}

describe("execCommand process-tree cleanup", () => {
  afterEach(() => {
    for (const pid of cleanupPids) {
      forceKillPid(pid);
    }
    cleanupPids.clear();
  });

  it("does not resolve a timeout while a SIGTERM-resistant descendant is alive", async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "openclaw-exec-tree-"));
    const readyPath = join(dir, "ready.json");
    const descendantScript = [
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const parentScript = [
      'const { spawn } = require("node:child_process");',
      'const fs = require("node:fs");',
      `const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { stdio: "ignore", windowsHide: true });`,
      `child.once("spawn", () => fs.writeFileSync(${JSON.stringify(readyPath)}, JSON.stringify({ parentPid: process.pid, childPid: child.pid })));`,
      "child.once('error', () => process.exit(1));",
      "setInterval(() => {}, 1000);",
    ].join("\n");

    try {
      const resultPromise = execCommand(process.execPath, ["-e", parentScript], process.cwd(), {
        timeout: 1_000,
      });
      await waitForFile(readyPath, 3_000);
      const pids = JSON.parse(readFileSync(readyPath, "utf8")) as {
        parentPid: number;
        childPid: number;
      };
      cleanupPids.add(pids.parentPid);
      cleanupPids.add(pids.childPid);

      await expect(resultPromise).resolves.toMatchObject({ killed: true });
      await vi.waitFor(
        () => {
          expect(isProcessAlive(pids.parentPid)).toBe(false);
          expect(isProcessAlive(pids.childPid)).toBe(false);
        },
        { timeout: 500, interval: 25 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 12_000);
});
