import fs from "node:fs";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveWorkboardSqlitePath } from "./sqlite-store.js";

const POISONED_AGENT_PREDICATE =
  "agent_id IS NOT NULL AND (trim(agent_id) = '' OR lower(trim(agent_id)) = 'workboard-dispatcher')";

function hasCardsTable(databasePath: string): boolean {
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'workboard_cards'")
        .get(),
    );
  } finally {
    db.close();
  }
}

export function countAmbiguousWorkboardAgentIds(env: NodeJS.ProcessEnv = process.env): number {
  const databasePath = resolveWorkboardSqlitePath(env);
  if (!fs.existsSync(databasePath) || !hasCardsTable(databasePath)) {
    return 0;
  }
  const db = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    const row = db
      .prepare(`SELECT count(*) AS count FROM workboard_cards WHERE ${POISONED_AGENT_PREDICATE}`)
      .get() as { count?: number | bigint } | undefined;
    return Number(row?.count ?? 0);
  } finally {
    db.close();
  }
}

export function normalizeAmbiguousWorkboardAgentIds(env: NodeJS.ProcessEnv = process.env): number {
  const databasePath = resolveWorkboardSqlitePath(env);
  if (!fs.existsSync(databasePath) || !hasCardsTable(databasePath)) {
    return 0;
  }
  const db = openNodeSqliteDatabase(databasePath);
  try {
    db.exec("PRAGMA busy_timeout = 5000; BEGIN IMMEDIATE;");
    const result = db
      .prepare(`UPDATE workboard_cards SET agent_id = NULL WHERE ${POISONED_AGENT_PREDICATE}`)
      .run();
    db.exec("COMMIT");
    return Number(result.changes);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}
