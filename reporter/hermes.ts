import path from "node:path";
import type Database from "better-sqlite3";
import type { DailyUsage, ModelBreakdown } from "./usage";

// Hermes (NousResearch/hermes-agent) as a first-class tkmx source.
//
// Deliberately NOT routed through AgentsView the way claude/codex are.
// AgentsView indexes hermes sessions — 0.38.1 lists them under agent
// `hermes` — but emits ZERO usage for every one of them, so a hermes slice
// collected that way is silently always 0 and looks like "nobody runs
// Hermes" rather than "the parser is missing". This reads Hermes' own
// store instead, which is the source AgentsView would have to read anyway.
//
// Store: `$HERMES_HOME/state.db` (HERMES_HOME defaults to ~/.hermes;
// hermes_constants.py). Table `sessions` (hermes_state.py) carries running
// per-session totals: input_tokens, output_tokens, cache_read_tokens,
// cache_write_tokens, model, started_at (unix seconds), and both
// estimated_cost_usd and actual_cost_usd.
//
// The four counters are DISJOINT — CanonicalUsage in agent/usage_pricing.py
// defines `prompt_tokens = input + cache_read + cache_write` — which is
// already the tkmx contract, so nothing is subtracted here.

const HERMES_SOURCE = "hermes";

export function resolveHermesStateDb(env: NodeJS.ProcessEnv = process.env): string {
  const root =
    env.HERMES_HOME || path.join(env.HOME || env.USERPROFILE || "", ".hermes");
  return path.join(root, "state.db");
}

interface HermesRow {
  date: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

// ponytail: buckets a session on its START date, because Hermes stores one
// running total per session rather than per-turn rows. A session held open
// across local midnight lands wholly on the day it began. Same ceiling grok
// has upstream in AgentsView. Upgrade path: read per-message token_count
// from the `messages` table once Hermes records a model + timestamp per
// API call there.
export function rowsToDaily(rows: HermesRow[]): DailyUsage[] {
  const byDate: Record<string, DailyUsage> = {};
  for (const r of rows) {
    const day = byDate[r.date] || (byDate[r.date] = { date: r.date, modelBreakdowns: [] });
    const breakdown: ModelBreakdown = {
      modelName: r.modelName,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      cacheCreationTokens: r.cacheCreationTokens,
      cacheReadTokens: r.cacheReadTokens,
      totalTokens:
        r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens,
      source: HERMES_SOURCE,
    };
    if (r.cost > 0) breakdown.cost = r.cost;
    day.modelBreakdowns.push(breakdown);
  }
  return Object.values(byDate)
    .filter((d) => d.modelBreakdowns.some((m) => m.totalTokens > 0))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// Local calendar date, matching openclaw.ts / openai.ts, so hermes rows
// bucket on the same day as every other source near local midnight.
const SQL = `
  SELECT date(started_at, 'unixepoch', 'localtime')       AS date,
         COALESCE(NULLIF(model, ''), 'unknown')           AS modelName,
         SUM(COALESCE(input_tokens, 0))                   AS inputTokens,
         SUM(COALESCE(output_tokens, 0))                  AS outputTokens,
         SUM(COALESCE(cache_write_tokens, 0))             AS cacheCreationTokens,
         SUM(COALESCE(cache_read_tokens, 0))              AS cacheReadTokens,
         SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) AS cost
    FROM sessions
   WHERE started_at IS NOT NULL
     AND date(started_at, 'unixepoch', 'localtime') >= ?
   GROUP BY date, modelName
   ORDER BY date, modelName
`;

export interface CollectOpts {
  sinceIsoDate: string;
  dbPath?: string;
  env?: NodeJS.ProcessEnv;
}

// Returns [] when Hermes simply isn't installed — an absent store is "no
// Hermes on this machine", not a failure. A store that exists but can't be
// read IS a failure and throws: that is the silent-zero shape this whole
// module exists to avoid (see REVIEW.md, loud breaks over silent skips).
export function collectHermesUsage(opts: CollectOpts): DailyUsage[] {
  const dbPath = opts.dbPath || resolveHermesStateDb(opts.env);
  let DatabaseCtor: typeof Database;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    DatabaseCtor = require("better-sqlite3");
  } catch {
    throw new Error("better-sqlite3 is required to collect Hermes usage");
  }
  let db: Database.Database;
  try {
    db = new DatabaseCtor(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "SQLITE_CANTOPEN") return [];
    throw err;
  }
  try {
    return rowsToDaily(db.prepare(SQL).all(opts.sinceIsoDate) as HermesRow[]);
  } finally {
    db.close();
  }
}
