// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isKnownWorkspacePath } from "./path.ts";
import { recentPlaces } from "./recent-places.ts";

describe("recentPlaces", () => {
  it("groups basenames, caps, skips the workspace and unknown nodes, and prefers exec cwd", () => {
    expect(
      recentPlaces(
        [
          { execCwd: "/workspace" },
          { execCwd: "/node/repo", execNode: "macbook" },
          { execCwd: "/node/repo", execNode: "macbook" },
          { execCwd: "/gateway/repo" },
          { execCwd: "/gone/repo", execNode: "retired" },
          {
            execCwd: "/preferred/selected",
            worktree: { repoRoot: "/ignored/worktree" },
          },
          { worktree: { repoRoot: "/worktree/one" } },
          { execCwd: "  /cwd/two  " },
          { worktree: { repoRoot: "/capped/out" } },
        ],
        {
          workspace: "/workspace",
          execNodes: [{ nodeId: "macbook" }],
          allowGatewayFolder: () => true,
        },
      ),
    ).toEqual([
      { folder: "/node/repo", execNode: "macbook" },
      { folder: "/preferred/selected", execNode: "" },
      { folder: "/worktree/one", execNode: "" },
      { folder: "/cwd/two", execNode: "" },
    ]);
  });

  it("filters Gateway recents through the viewer's folder boundary", () => {
    expect(
      recentPlaces(
        [
          { execCwd: "/workspace/packages/app" },
          { execCwd: "/workspace-other/private" },
          { execCwd: "/node/repo", execNode: "macbook" },
        ],
        {
          workspace: "/workspace",
          execNodes: [],
          allowGatewayFolder: (folder) => isKnownWorkspacePath(["/workspace"], folder),
        },
      ),
    ).toEqual([{ folder: "/workspace/packages/app", execNode: "" }]);
  });
});
