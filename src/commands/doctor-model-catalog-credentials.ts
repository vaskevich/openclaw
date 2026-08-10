/** Doctor-owned migration of plaintext model-catalog credentials into agent SQLite. */
import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { runAuthProfileWriteTransaction } from "../agents/auth-profiles/sqlite.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import type { AuthProfileCredential, AuthProfileStore } from "../agents/auth-profiles/types.js";
import { isNonSecretApiKeyMarker } from "../agents/model-auth-markers.js";
import {
  encodePluginModelCatalogRelativePath,
  isGeneratedPluginModelCatalog,
  loadPersistedPluginModelCatalogsReadOnly,
  replacePersistedPluginModelCatalogs,
  type PersistedPluginModelCatalog,
} from "../agents/plugin-model-catalog.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { privateFileStore } from "../infra/private-file-store.js";
import type { RuntimeEnv } from "../runtime.js";
import { listAuthProfileStoreAgentDirs } from "../secrets/storage-scan.js";
import { shortenHomePath } from "../utils.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

type PlaintextCredential = { apiKey: string; provider: string };
type ParsedCatalog = { parsed: Record<string, unknown>; raw: string };
type AgentCatalogSources = {
  agentDir: string;
  pluginCatalogs: readonly PersistedPluginModelCatalog[];
  root: ParsedCatalog | null;
  store: AuthProfileStore;
};

function emptyStore(): AuthProfileStore {
  return { version: 1, profiles: {} };
}

function credentialMatches(
  credential: AuthProfileCredential | undefined,
  provider: string,
  apiKey: string,
): boolean {
  if (normalizeProviderId(credential?.provider ?? "") !== normalizeProviderId(provider)) {
    return false;
  }
  return (
    (credential?.type === "api_key" && credential.key === apiKey) ||
    (credential?.type === "token" && credential.token === apiKey)
  );
}

function isPlaintextCredential(value: unknown, store: AuthProfileStore): value is string {
  if (typeof value !== "string" || !value.trim() || isNonSecretApiKeyMarker(value)) {
    return false;
  }
  return store.profiles[value] === undefined;
}

function collectCatalogCredentials(
  parsed: Record<string, unknown>,
  store: AuthProfileStore,
): PlaintextCredential[] {
  if (!isRecord(parsed.providers)) {
    return [];
  }
  return Object.entries(parsed.providers).flatMap(([provider, entry]) => {
    if (!isRecord(entry) || !isPlaintextCredential(entry.apiKey, store)) {
      return [];
    }
    return [{ provider, apiKey: entry.apiKey }];
  });
}

function readRootCatalog(agentDir: string, warnings: string[]): ParsedCatalog | null {
  const pathname = path.join(agentDir, "models.json");
  let raw: string;
  try {
    raw = fs.readFileSync(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    warnings.push(`Could not read model catalog: ${shortenHomePath(pathname)}`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) {
      warnings.push(`Could not migrate non-object model catalog: ${shortenHomePath(pathname)}`);
      return null;
    }
    return { parsed, raw };
  } catch {
    warnings.push(`Could not parse model catalog: ${shortenHomePath(pathname)}`);
    return null;
  }
}

function parsePluginCatalog(
  catalog: PersistedPluginModelCatalog,
  warnings: string[],
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(catalog.contents) as unknown;
    if (!isRecord(parsed) || !isGeneratedPluginModelCatalog(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    warnings.push(`Could not parse generated model catalog for plugin ${catalog.pluginId}.`);
    return null;
  }
}

function catalogCredentialKey(provider: string, apiKey: string): string {
  return `${normalizeProviderId(provider)}\0${apiKey}`;
}

function rewriteCatalogCredentials(
  parsed: Record<string, unknown>,
  profileIds: ReadonlyMap<string, string>,
): Record<string, unknown> {
  if (!isRecord(parsed.providers)) {
    return parsed;
  }
  let changed = false;
  const providers = Object.fromEntries(
    Object.entries(parsed.providers).map(([provider, entry]) => {
      if (!isRecord(entry) || typeof entry.apiKey !== "string") {
        return [provider, entry];
      }
      const profileId = profileIds.get(catalogCredentialKey(provider, entry.apiKey));
      if (!profileId) {
        return [provider, entry];
      }
      changed = true;
      return [provider, { ...entry, apiKey: profileId }];
    }),
  );
  return changed ? { ...parsed, providers } : parsed;
}

function findMatchingProfileId(
  store: AuthProfileStore,
  credential: PlaintextCredential,
): string | undefined {
  return Object.entries(store.profiles).find(([, stored]) =>
    credentialMatches(stored, credential.provider, credential.apiKey),
  )?.[0];
}

function allocateProfileId(store: AuthProfileStore, credential: PlaintextCredential): string {
  const existing = findMatchingProfileId(store, credential);
  if (existing) {
    return existing;
  }
  const provider = normalizeProviderId(credential.provider);
  const candidates = [`${provider}:default`, `${provider}:models-json`];
  for (let suffix = 2; ; suffix += 1) {
    const profileId = candidates.shift() ?? `${provider}:models-json-${suffix}`;
    const stored = store.profiles[profileId];
    if (!stored || credentialMatches(stored, provider, credential.apiKey)) {
      return profileId;
    }
  }
}

function addCredential(
  store: AuthProfileStore,
  credential: PlaintextCredential,
  profileId: string,
): boolean {
  if (credentialMatches(store.profiles[profileId], credential.provider, credential.apiKey)) {
    return false;
  }
  store.profiles[profileId] = {
    type: "api_key",
    provider: normalizeProviderId(credential.provider),
    key: credential.apiKey,
  };
  const provider = normalizeProviderId(credential.provider);
  const ordered = store.order?.[provider];
  if (ordered && !ordered.includes(profileId)) {
    store.order = { ...store.order, [provider]: [...ordered, profileId] };
  }
  return true;
}

function collectConfigCredentials(
  cfg: OpenClawConfig,
  stores: readonly AuthProfileStore[],
): PlaintextCredential[] {
  return Object.entries(cfg.models?.providers ?? {}).flatMap(([provider, entry]) => {
    const value = entry.apiKey;
    if (typeof value !== "string" || !value.trim() || isNonSecretApiKeyMarker(value)) {
      return [];
    }
    if (stores.some((store) => store.profiles[value] !== undefined)) {
      return [];
    }
    return [{ provider, apiKey: value }];
  });
}

function chooseSharedConfigProfileIds(
  credentials: readonly PlaintextCredential[],
  stores: readonly AuthProfileStore[],
): Map<string, string> {
  const result = new Map<string, string>();
  for (const credential of credentials) {
    const provider = normalizeProviderId(credential.provider);
    for (let suffix = 1; ; suffix += 1) {
      const profileId = `${provider}:config${suffix === 1 ? "" : `-${suffix}`}`;
      if (
        stores.every((store) => {
          const existing = store.profiles[profileId];
          return !existing || credentialMatches(existing, provider, credential.apiKey);
        })
      ) {
        result.set(catalogCredentialKey(provider, credential.apiKey), profileId);
        break;
      }
    }
  }
  return result;
}

function rewriteConfigCredentials(
  cfg: OpenClawConfig,
  profileIds: ReadonlyMap<string, string>,
): OpenClawConfig {
  const providers = cfg.models?.providers;
  if (!providers) {
    return cfg;
  }
  let changed = false;
  const nextProviders = Object.fromEntries(
    Object.entries(providers).map(([provider, entry]) => {
      if (typeof entry.apiKey !== "string") {
        return [provider, entry];
      }
      const profileId = profileIds.get(catalogCredentialKey(provider, entry.apiKey));
      if (!profileId) {
        return [provider, entry];
      }
      changed = true;
      return [provider, { ...entry, apiKey: profileId }];
    }),
  );
  return changed ? { ...cfg, models: { ...cfg.models, providers: nextProviders } } : cfg;
}

function collectAgentSources(agentDir: string, warnings: string[]): AgentCatalogSources {
  return {
    agentDir,
    root: readRootCatalog(agentDir, warnings),
    pluginCatalogs: loadPersistedPluginModelCatalogsReadOnly(agentDir),
    store: loadPersistedAuthProfileStore(agentDir) ?? emptyStore(),
  };
}

/** Moves catalog credentials to SQLite, verifies them, then rewrites every source to profile ids. */
export async function maybeMigrateModelCatalogCredentials(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  agentDirs?: readonly string[];
  prompter: DoctorPrompter;
  runtime: RuntimeEnv;
  note?: typeof note;
}): Promise<{ config: OpenClawConfig; detected: number; migrated: number; warnings: string[] }> {
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  const agentDirs = params.agentDirs
    ? [...new Set(params.agentDirs)]
    : listAuthProfileStoreAgentDirs(params.cfg, stateDir);
  const sources = agentDirs.map((agentDir) => collectAgentSources(agentDir, warnings));
  const configCredentials = collectConfigCredentials(
    params.cfg,
    sources.map((source) => source.store),
  );
  const sharedConfigProfileIds = chooseSharedConfigProfileIds(
    configCredentials,
    sources.map((source) => source.store),
  );
  const detected =
    configCredentials.length +
    sources.reduce((count, source) => {
      const rootCount = source.root
        ? collectCatalogCredentials(source.root.parsed, source.store).length
        : 0;
      const pluginCount = source.pluginCatalogs.reduce((sum, catalog) => {
        const parsed = parsePluginCatalog(catalog, warnings);
        return sum + (parsed ? collectCatalogCredentials(parsed, source.store).length : 0);
      }, 0);
      return count + rootCount + pluginCount;
    }, 0);

  for (const warning of warnings) {
    params.runtime.error(warning);
  }
  if (detected === 0) {
    return { config: params.cfg, detected, migrated: 0, warnings };
  }

  const emitNote = params.note ?? note;
  emitNote(
    `Found ${detected} plaintext model credential${detected === 1 ? "" : "s"}. Run openclaw doctor --fix to move them into agent SQLite before catalogs are regenerated.`,
    "Model catalog credentials",
  );
  const shouldRepair =
    params.prompter.shouldRepair ||
    (await params.prompter.confirmAutoFix({
      message: "Move model credentials into agent SQLite now?",
      initialValue: true,
    }));
  if (!shouldRepair) {
    return { config: params.cfg, detected, migrated: 0, warnings };
  }

  let migrated = 0;
  let allAgentsMigrated = true;
  for (const source of sources) {
    const rootCredentials = source.root
      ? collectCatalogCredentials(source.root.parsed, source.store)
      : [];
    const parsedPluginCatalogs = source.pluginCatalogs.map((catalog) => ({
      catalog,
      parsed: parsePluginCatalog(catalog, warnings),
    }));
    const pluginCredentials = parsedPluginCatalogs.flatMap(({ parsed }) =>
      parsed ? collectCatalogCredentials(parsed, source.store) : [],
    );
    const credentials = [...configCredentials, ...rootCredentials, ...pluginCredentials];
    if (credentials.length === 0) {
      continue;
    }
    try {
      const profileIds = new Map(sharedConfigProfileIds);
      let nextRootContents: string | undefined;
      let pluginCatalogWrites: Record<string, string> | undefined;
      runAuthProfileWriteTransaction(source.agentDir, (database) => {
        const store = loadPersistedAuthProfileStore(source.agentDir, { database }) ?? emptyStore();
        let added = 0;
        for (const credential of credentials) {
          const key = catalogCredentialKey(credential.provider, credential.apiKey);
          const profileId =
            sharedConfigProfileIds.get(key) ??
            profileIds.get(key) ??
            allocateProfileId(store, credential);
          profileIds.set(key, profileId);
          if (addCredential(store, credential, profileId)) {
            added += 1;
          }
        }
        saveAuthProfileStore(store, source.agentDir, undefined, database);
        const verified = loadPersistedAuthProfileStore(source.agentDir, { database });
        for (const [key, profileId] of profileIds) {
          const separator = key.indexOf("\0");
          const provider = key.slice(0, separator);
          const apiKey = key.slice(separator + 1);
          if (!credentialMatches(verified?.profiles[profileId], provider, apiKey)) {
            throw new Error(`Credential verification failed for provider "${provider}".`);
          }
        }

        pluginCatalogWrites = Object.fromEntries(
          parsedPluginCatalogs.map(({ catalog, parsed }) => [
            encodePluginModelCatalogRelativePath(catalog.pluginId),
            parsed
              ? `${JSON.stringify(rewriteCatalogCredentials(parsed, profileIds), null, 2)}\n`
              : catalog.contents,
          ]),
        );
        if (source.root) {
          nextRootContents = `${JSON.stringify(
            rewriteCatalogCredentials(source.root.parsed, profileIds),
            null,
            2,
          )}\n`;
        }
        migrated += added;
      });
      if (pluginCatalogWrites) {
        replacePersistedPluginModelCatalogs({
          agentDir: source.agentDir,
          pluginCatalogWrites,
        });
      }
      if (source.root && nextRootContents !== undefined && nextRootContents !== source.root.raw) {
        await privateFileStore(source.agentDir).writeText("models.json", nextRootContents);
      }
    } catch (error) {
      allAgentsMigrated = false;
      const warning = `Could not migrate model credentials for ${shortenHomePath(source.agentDir)}: ${error instanceof Error ? error.message : String(error)}`;
      warnings.push(warning);
      params.runtime.error(warning);
    }
  }

  const config = allAgentsMigrated
    ? rewriteConfigCredentials(params.cfg, sharedConfigProfileIds)
    : params.cfg;
  if (migrated > 0) {
    emitNote(
      `Migrated and verified ${migrated} model credential${migrated === 1 ? "" : "s"} in agent SQLite.`,
      "Doctor changes",
    );
  }
  return { config, detected, migrated, warnings };
}
