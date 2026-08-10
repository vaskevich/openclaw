// Doctor migrates model credentials before removing plaintext from generated catalogs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import {
  encodePluginModelCatalogRelativePath,
  loadPersistedPluginModelCatalogsReadOnly,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "../agents/plugin-model-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeMigrateModelCatalogCredentials } from "./doctor-model-catalog-credentials.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const tempDirs: string[] = [];

function createAgentDir(): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-catalog-credentials-"));
  tempDirs.push(agentDir);
  return agentDir;
}

function provider(apiKey: string) {
  return {
    api: "openai-responses" as const,
    apiKey,
    baseUrl: "https://models.example/v1",
    models: [{ id: "example-model", name: "Example model" }],
  };
}

function migrationParams(agentDir: string, cfg: OpenClawConfig) {
  return {
    cfg,
    agentDirs: [agentDir],
    prompter: { shouldRepair: true } as DoctorPrompter,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv,
    note: vi.fn(),
  };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("doctor model catalog credential migration", () => {
  it("moves config, root, and plugin catalog keys into SQLite before replacing them", async () => {
    const agentDir = createAgentDir();
    const cfg: OpenClawConfig = {
      models: { providers: { configured: provider("configured-secret") } },
    };
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      `${JSON.stringify({ providers: { root: provider("root-secret") } }, null, 2)}\n`,
    );
    replacePersistedPluginModelCatalogs({
      agentDir,
      pluginCatalogWrites: {
        [encodePluginModelCatalogRelativePath("plugin-owner")]: `${JSON.stringify(
          {
            generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
            providers: { plugin: provider("plugin-secret") },
          },
          null,
          2,
        )}\n`,
      },
    });

    const first = await maybeMigrateModelCatalogCredentials(migrationParams(agentDir, cfg));

    expect(first.detected).toBe(3);
    expect(first.migrated).toBe(3);
    expect(first.warnings).toEqual([]);
    expect(first.config.models?.providers?.configured?.apiKey).toBe("configured:config");
    expect(loadPersistedAuthProfileStore(agentDir)?.profiles).toMatchObject({
      "configured:config": {
        type: "api_key",
        provider: "configured",
        key: "configured-secret",
      },
      "root:default": { type: "api_key", provider: "root", key: "root-secret" },
      "plugin:default": { type: "api_key", provider: "plugin", key: "plugin-secret" },
    });
    const root = JSON.parse(fs.readFileSync(path.join(agentDir, "models.json"), "utf8")) as {
      providers: Record<string, { apiKey?: string }>;
    };
    expect(root.providers.root.apiKey).toBe("root:default");
    const pluginCatalog = loadPersistedPluginModelCatalogsReadOnly(agentDir)[0];
    const plugin = JSON.parse(pluginCatalog?.contents ?? "{}") as {
      providers?: Record<string, { apiKey?: string }>;
    };
    expect(plugin.providers?.plugin?.apiKey).toBe("plugin:default");

    const second = await maybeMigrateModelCatalogCredentials(
      migrationParams(agentDir, first.config),
    );
    expect(second).toMatchObject({ detected: 0, migrated: 0, warnings: [] });
  });

  it("never overwrites an occupied default profile while preserving the catalog key", async () => {
    const agentDir = createAgentDir();
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          "custom:default": {
            type: "api_key",
            provider: "custom",
            key: "existing-secret",
          },
        },
        order: { custom: ["custom:default"] },
      },
      agentDir,
    );
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      `${JSON.stringify({ providers: { custom: provider("catalog-secret") } }, null, 2)}\n`,
    );

    await maybeMigrateModelCatalogCredentials(migrationParams(agentDir, {}));

    const store = loadPersistedAuthProfileStore(agentDir);
    expect(store?.profiles["custom:default"]).toMatchObject({ key: "existing-secret" });
    expect(store?.profiles["custom:models-json"]).toMatchObject({ key: "catalog-secret" });
    expect(store?.order?.custom).toEqual(["custom:default", "custom:models-json"]);
  });
});
