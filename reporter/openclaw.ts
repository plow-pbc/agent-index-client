import { readFile, readdir, stat } from "node:fs/promises";
import type { DailyUsage } from "./usage";
import { mergeDailyUsage } from "./merge";

interface OpenclawUsageRecord {
  date: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  responseId: string;
}

function toIsoDate(input: string | number | undefined): string | null {
  if (input === undefined) return null;
  const d = new Date(input);
  if (isNaN(d.getTime())) return null;
  // Local calendar date (mirrors reporter/openai.ts:97) so openclaw rows
  // bucket on the same day as claude/codex rows — a UTC date would split
  // a single user-perceived day across two buckets near local midnight.
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

export function parseUsageLine(line: string): OpenclawUsageRecord | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (obj?.type !== "message") return null;
  const msg = obj.message;
  if (msg?.role !== "assistant") return null;
  if (!msg.usage || !msg.model || !msg.responseId) return null;
  const date = toIsoDate(obj.timestamp) ?? toIsoDate(msg.timestamp);
  if (!date) return null;
  const inputTokens = Number(msg.usage.input ?? 0);
  const outputTokens = Number(msg.usage.output ?? 0);
  const cacheReadTokens = Number(msg.usage.cacheRead ?? 0);
  const cacheCreationTokens = Number(msg.usage.cacheWrite ?? 0);
  // Compute totalTokens from the four counters (the contract every other
  // producer follows; ignores wire `usage.totalTokens` so a malformed
  // upstream record can't desync component vs total fields).
  return {
    date,
    modelName: String(msg.model),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheCreationTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens,
    responseId: String(msg.responseId),
  };
}

const OPENCLAW_SOURCE = "openclaw";

const STANDALONE_REL = ".openclaw/agents/main/sessions";
// The segment between the app bundle and `gateway/` is NOT named here. Plow
// renamed it `openclaw` → `agent-runtime`, and because discovery just returns
// the roots that exist, the rename read as "this machine has no Plow usage":
// zero roots, no error, exit 0, POST 200, and 22.5M tokens over 9 active days
// silently absent from the profile. Globbing that level costs one readdir and
// survives the next rename; naming the new one just re-arms the same bug.
const PLOW_REL_TAIL = "gateway/agents/main/sessions";

async function exists(p: string): Promise<boolean> {
  try { await stat(p); return true; } catch { return false; }
}

interface DiscoverOpts {
  env: NodeJS.ProcessEnv;
  homeDir: string;
  platform: NodeJS.Platform;
}

export async function discoverOpenclawSessionsDirs(opts: DiscoverOpts): Promise<string[]> {
  const override = opts.env.OPENCLAW_SESSIONS_DIRS;
  if (override && override.trim().length > 0) {
    return override.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  const candidates: string[] = [];
  candidates.push(`${opts.homeDir}/${STANDALONE_REL}`);
  if (opts.platform === "darwin") {
    const appSupport = `${opts.homeDir}/Library/Application Support`;
    let entries: string[] = [];
    try { entries = await readdir(appSupport); } catch { entries = []; }
    for (const name of entries) {
      // Match co.plow.app and any variant (co.plow.app.wt1, co.plow.app.dev, co.plow.app.dev.wt1, ...)
      if (name !== "co.plow.app" && !name.startsWith("co.plow.app.")) continue;
      // Caught, unlike a configured EXTRA_*_CONFIGS home. These bundles are
      // auto-discovered, and this machine carries 23 of them (dev worktrees,
      // test variants) that nobody declared — so throwing would let one
      // unreadable throwaway abort the whole cycle and drop claude, codex and
      // everything else with it. Worse than the undercount it guards. It also
      // absorbs a stray *file* named co.plow.app.something, which is why no
      // directory filter is needed here: a Dirent check would be lstat-based
      // and would silently drop a symlinked bundle, while exists() below
      // stats (following symlinks) and drops non-directories anyway. Zero
      // roots still shows up: report.ts prints the root count unconditionally.
      const bundle = `${appSupport}/${name}`;
      let subdirs: string[] = [];
      try { subdirs = await readdir(bundle); } catch { subdirs = []; }
      for (const sub of subdirs) {
        candidates.push(`${bundle}/${sub}/${PLOW_REL_TAIL}`);
      }
    }
  }
  // Linux/Windows: standalone path only — Plow is macOS-only.
  const present: string[] = [];
  for (const c of candidates) {
    if (await exists(c)) present.push(c);
  }
  return present;
}

export function aggregateRecords(records: OpenclawUsageRecord[]): DailyUsage[] {
  // Dedupe by responseId (the unique-per-LLM-call key — handles checkpoint
  // forks and cross-root dupes), then let mergeDailyUsage do the
  // (date, modelName, source) summing it already owns for every other source.
  const seen = new Set<string>();
  const rows: DailyUsage[] = [];
  for (const rec of records) {
    if (seen.has(rec.responseId)) continue;
    seen.add(rec.responseId);
    rows.push({
      date: rec.date,
      modelBreakdowns: [{
        modelName: rec.modelName,
        inputTokens: rec.inputTokens,
        outputTokens: rec.outputTokens,
        cacheCreationTokens: rec.cacheCreationTokens,
        cacheReadTokens: rec.cacheReadTokens,
        totalTokens: rec.totalTokens,
        source: OPENCLAW_SOURCE,
      }],
    });
  }
  return mergeDailyUsage(rows);
}

interface CollectOpenclawUsageOpts {
  sinceDateStr: string;
  /** Each entry is a sessions dir (e.g. `<root>/agents/main/sessions`). All are scanned and aggregated together. */
  sessionsDirs: string[];
}

export async function collectOpenclawUsage(
  opts: CollectOpenclawUsageOpts,
): Promise<DailyUsage[]> {
  if (opts.sessionsDirs.length === 0) return [];
  // sinceDateStr is YYYYMMDD (the format formatSinceStr in window.ts emits;
  // matches every other collector's input contract). r.date is YYYY-MM-DD
  // from toIsoDate, so convert sinceDateStr to ISO before the >= compare.
  const sinceIso = `${opts.sinceDateStr.slice(0, 4)}-${opts.sinceDateStr.slice(4, 6)}-${opts.sinceDateStr.slice(6, 8)}`;
  const records: OpenclawUsageRecord[] = [];
  for (const dir of opts.sessionsDirs) {
    // Fail loud on ENOENT / read errors — discoverOpenclawSessionsDirs has
    // already filtered to dirs that exist, so a missing dir here means
    // either a user-typo'd OPENCLAW_SESSIONS_DIRS or a real FS issue. Silent
    // skip would silently undercount; an exception surfaces the cause.
    const entries = await readdir(dir);
    const sessionFiles = entries.filter(
      (name) =>
        name.endsWith(".jsonl") &&
        !name.endsWith(".trajectory.jsonl") &&
        name !== "sessions.json",
    );
    for (const name of sessionFiles) {
      const contents = await readFile(`${dir}/${name}`, "utf8");
      for (const line of contents.split("\n")) {
        if (!line.trim()) continue;
        const r = parseUsageLine(line);
        if (r && r.date >= sinceIso) records.push(r);
      }
    }
  }
  return aggregateRecords(records);
}
