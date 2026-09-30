import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { zstdCompressSync } from "node:zlib";
import Database from "better-sqlite3";
import { createEmptyHermesStore } from "./hermes-store";

// The standalone client is the copy that ships inside a container, so this
// drives the real script rather than a re-implementation of it.
const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");

/** One OpenClaw state root holding one agent's store, in the shape OpenClaw
 *  wrote before transcript schema 23: `agents/<id>/agent/openclaw-agent.sqlite`,
 *  one row per transcript event, usage carried by the assistant message that
 *  spent it, and no compression columns at all. Kept as that older shape on
 *  purpose -- a client that names `event_zstd` unconditionally cannot read it. */
function store(events: object[], agentId = "main"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-openclaw-"));
  const dir = path.join(root, "agents", agentId, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const rows = events.map((event, seq) => [seq, JSON.stringify(event), Date.now()]);
  execFileSync("python3", ["-c", `
import json, sqlite3, sys
db = sqlite3.connect(sys.argv[1])
db.execute("CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER)")
db.executemany("INSERT INTO transcript_events VALUES ('s', ?, ?, ?)", json.loads(sys.argv[2]))
db.commit()
`, path.join(dir, "openclaw-agent.sqlite"), JSON.stringify(rows)]);
  return root;
}

/** What the collector makes of that root, read back through the client itself. */
function collected(root: string, env: Record<string, string> = {}): Record<string, Record<string, Record<string, number>>> {
  const { days, failures } = collectedWithFailures(root, env);
  assert.deepEqual(failures, [], "a readable store must not report a failure");
  return days;
}

let call = 0;
const usage = (model: string, u: object, timestamp = "2026-09-23T11:52:38.505Z", responseId = `gen-${++call}`) =>
  ({ type: "message", timestamp, message: { role: "assistant", model, responseId, usage: u } });

// What OpenClaw compresses at: any event whose JSON reaches this many UTF-8
// bytes goes to `event_zstd` with `event_json` NULL.
const MIN_COMPRESS_BYTES = 1024;

/** The same root, in the shape OpenClaw writes from transcript schema 23 on,
 *  compressing by the rule the store itself uses rather than by hand. The real
 *  table's CHECK makes `event_json` and `event_zstd` mutually exclusive, so each
 *  row here carries exactly one of them, as a real store does. */
function schema23Store(events: object[], agentId = "main"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-openclaw-zstd-"));
  const dir = path.join(root, "agents", agentId, "agent");
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "openclaw-agent.sqlite"));
  db.exec(`
    CREATE TABLE transcript_events (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      event_json TEXT,
      created_at INTEGER NOT NULL,
      event_zstd BLOB,
      event_utf8_bytes INTEGER,
      navigation_json TEXT,
      PRIMARY KEY (session_id, seq),
      CHECK (
        (event_json IS NOT NULL AND event_zstd IS NULL)
        OR (event_json IS NULL AND event_zstd IS NOT NULL AND event_utf8_bytes IS NOT NULL)
      )
    )
  `);
  const insert = db.prepare(
    "INSERT INTO transcript_events (session_id, seq, event_json, created_at, event_zstd, event_utf8_bytes)"
    + " VALUES ('s', ?, ?, ?, ?, ?)");
  events.forEach((event, seq) => {
    const json = JSON.stringify(event);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes >= MIN_COMPRESS_BYTES) insert.run(seq, null, Date.now(), zstdCompressSync(Buffer.from(json, "utf8")), bytes);
    else insert.run(seq, json, Date.now(), null, null);
  });
  db.close();
  return root;
}

/** An assistant message big enough to be compressed, carrying real usage: the
 *  row a substantive turn actually writes. `filler` is inert text on the event,
 *  not on the usage, so the numbers under test stay small and legible. */
const bigUsage = (model: string, u: object, responseId: string) =>
  ({ ...usage(model, u, undefined, responseId), filler: "x".repeat(MIN_COMPRESS_BYTES * 2) });

test("usage lands under its day and model, events add up, and a turn without usage adds no row", () => {
  const days = collected(store([
    usage("z-ai/glm-5.2", { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 }),
    usage("z-ai/glm-5.2", { input: 20, output: 2, cacheRead: 0, cacheWrite: 7 }),
    { type: "message", timestamp: "2026-09-23T13:53:00.000Z", message: { role: "user", content: "hi" } },
  ]));
  assert.deepEqual(days, {
    "2026-09-23": { "z-ai/glm-5.2": { input: 30, output: 3, cache_read: 5, cache_write: 7 } },
  });
});

test("the same call is counted once, however many times the store repeats it", () => {
  // A checkpoint fork, or a store copied between roots, repeats the event.
  const once = usage("z-ai/glm-5.2", { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 }, undefined, "gen-same");
  const days = collected(store([once, once, JSON.parse(JSON.stringify(once))]));
  assert.deepEqual(days["2026-09-23"], {
    "z-ai/glm-5.2": { input: 10, output: 1, cache_read: 0, cache_write: 0 },
  });
});

test("a configured root with no store is a failure, not an idle day", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-openclaw-configured-"));
  const out = execFileSync("python3", ["-c", `
import json, sys
namespace = {"__name__": "collector"}
exec(compile(open(sys.argv[1]).read().split("def main(")[0], sys.argv[1], "exec"), namespace)
namespace["from_openclaw"](28, state=sys.argv[2])
print(json.dumps(namespace["FAILURES"]))
`, CLIENT, root], { encoding: "utf8" });
  // Silence here would let the other collectors' totals overwrite a larger
  // number the server already holds for the same day and model.
  assert.match(JSON.parse(out.trim())[0], /openclaw: no store under/);
});

test("an event near local midnight buckets on the local day, like every other collector", () => {
  const days = collected(store([
    // 23:30 in Los Angeles on Sep 22 is Sep 23 in UTC.
    usage("z-ai/glm-5.2", { input: 5, output: 1, cacheRead: 0, cacheWrite: 0 }, "2026-09-23T06:30:00.000Z"),
  ]), { TZ: "America/Los_Angeles" });
  assert.deepEqual(Object.keys(days), ["2026-09-22"]);
});

test("a machine that simply does not run OpenClaw collects nothing and says nothing failed", () => {
  // No OPENCLAW_STATE_DIR: the default root is a guess, and a guess that finds
  // nothing means "no OpenClaw here", not a misconfiguration to shout about.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-openclaw-none-"));
  const out = execFileSync("python3", ["-c", `
import json, sys
namespace = {"__name__": "collector"}
exec(compile(open(sys.argv[1]).read().split("def main(")[0], sys.argv[1], "exec"), namespace)
print(json.dumps(namespace["from_openclaw"](28)))
print(json.dumps(namespace["FAILURES"]))
`, CLIENT], { encoding: "utf8", env: { ...process.env, HOME: dir, OPENCLAW_STATE_DIR: "" } });
  const [days, failures] = out.trim().split("\n");
  assert.deepEqual(JSON.parse(days), {});
  assert.deepEqual(JSON.parse(failures), []);
});

test("a compressed event is read, so a substantive turn is not dropped", () => {
  // The bug this covers: `SELECT event_json` alone leaves `raw` NULL for a
  // compressed row, json.loads raises TypeError, and the skip is indistinguishable
  // from a row with no usage. The small turn survived it and the big one did not,
  // so the client reported a real number that was 2.5% of the truth.
  const days = collected(schema23Store([
    usage("z-ai/glm-5.2", { input: 111, output: 222, cacheRead: 0, cacheWrite: 0 }, undefined, "gen-small"),
    bigUsage("z-ai/glm-5.2", { input: 4321, output: 8765, cacheRead: 0, cacheWrite: 0 }, "gen-big"),
  ]));
  assert.deepEqual(days, {
    "2026-09-23": {
      "z-ai/glm-5.2": { input: 4432, output: 8987, cache_read: 0, cache_write: 0 },
    },
  });
});

test("a compressed event that will not decompress is a failure, not a smaller total", () => {
  // Reporting the readable rows here would replace the server's correct total
  // for that day and model with a smaller one, which is the failure mode the
  // whole collector is written against.
  const root = schema23Store([
    usage("z-ai/glm-5.2", { input: 111, output: 222, cacheRead: 0, cacheWrite: 0 }, undefined, "gen-small"),
    bigUsage("z-ai/glm-5.2", { input: 4321, output: 8765, cacheRead: 0, cacheWrite: 0 }, "gen-big"),
  ]);
  const db = new Database(path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"));
  db.prepare("UPDATE transcript_events SET event_zstd = ? WHERE event_zstd IS NOT NULL")
    .run(Buffer.from("not a zstd frame"));
  db.close();
  const out = execFileSync("python3", ["-c", `
import json, sys
namespace = {"__name__": "collector"}
exec(compile(open(sys.argv[1]).read().split("def main(")[0], sys.argv[1], "exec"), namespace)
namespace["from_openclaw"](28, state=sys.argv[2])
print(json.dumps(namespace["FAILURES"]))
`, CLIENT, root], { encoding: "utf8" });
  assert.match(JSON.parse(out.trim())[0], /compressed transcript event would not decompress/);
});

/** from_openclaw over a root (or, omitted, wherever it finds one), returning
 *  what it collected AND what it called a failure. */
function collectedWithFailures(root?: string, env: Record<string, string> = {}) {
  const out = execFileSync("python3", ["-c", `
import json, sys
source = open(sys.argv[1]).read().split("def main(")[0]
namespace = {"__name__": "collector"}
exec(compile(source, sys.argv[1], "exec"), namespace)
days = namespace["from_openclaw"](28, state=sys.argv[2] or None)
print(json.dumps({d: {m: dict(v) for m, v in ms.items()} for d, ms in days.items()}))
print(json.dumps(namespace["FAILURES"]))
`, CLIENT, root ?? ""], { encoding: "utf8", env: { ...process.env, OPENCLAW_AGENT_ID: "", ...env } });
  // The last two lines: a collector may print a note before them.
  const [days, failures] = out.trim().split("\n").slice(-2);
  return { days: JSON.parse(days), failures: JSON.parse(failures) as string[] };
}

/** Two agents under one OpenClaw root -- a laptop that runs both. */
function twoAgentRoot(): string {
  const root = store([usage("m", { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 })], "milo");
  const other = store([usage("m", { input: 99, output: 0, cacheRead: 0, cacheWrite: 0 })], "sitemaxxing");
  fs.cpSync(path.join(other, "agents", "sitemaxxing"), path.join(root, "agents", "sitemaxxing"), { recursive: true });
  return root;
}

test("several agents and no OPENCLAW_AGENT_ID is a failure, never their sum", () => {
  const { days, failures } = collectedWithFailures(twoAgentRoot());
  assert.deepEqual(days, {}, "neither agent's usage may be reported as this install's");
  assert.equal(failures.length, 1);
  assert.match(failures[0], /2 agents .*OPENCLAW_AGENT_ID/);
});

test("OPENCLAW_AGENT_ID reports that one agent's store and nothing else", () => {
  const { days, failures } = collectedWithFailures(twoAgentRoot(), { OPENCLAW_AGENT_ID: "milo" });
  assert.deepEqual(failures, []);
  assert.deepEqual(days, { "2026-09-23": { m: { input: 10, output: 0, cache_read: 0, cache_write: 0 } } });
  const missing = collectedWithFailures(twoAgentRoot(), { OPENCLAW_AGENT_ID: "nope" });
  assert.deepEqual(missing.days, {});
  assert.match(missing.failures[0], /no store for agent 'nope'/);
});

test("nothing else on the machine is reported: a coding tool's usage never reaches the payload", () => {
  // The whole-machine scan this replaced: an agentsview on the machine that
  // would have added the laptop's Claude Code day to this agent's report.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-machine-"));
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "agentsview"), `#!/bin/sh
echo '[{"date":"2026-09-23","modelBreakdowns":[{"modelName":"claude-opus-5","inputTokens":580000000}]}]'
`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".agent-index"));
  fs.writeFileSync(path.join(home, ".agent-index", ".agent-index.json"),
    JSON.stringify({ install_id: "install-test", key: "aik_" + "k".repeat(43) }), { mode: 0o600 });
  const root = store([usage("z-ai/glm-5.2", { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 })]);
  const out = execFileSync("python3", [CLIENT, "--agent", "x", "--dry-run"], {
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, HOME: home, OPENCLAW_STATE_DIR: root,
           AGENT_INDEX_API: "http://127.0.0.1:9" },
  });
  assert.match(out, /z-ai\/glm-5\.2/, "the agent's own usage is reported");
  assert.doesNotMatch(out, /claude-opus-5/, "the machine's other usage is not");
});

test("the host's default ~/.openclaw is not claimed without an id, and is not a failure", () => {
  // Nothing ties a guessed root's only store to --agent: on a laptop it is
  // whatever OpenClaw the host runs.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-host-"));
  fs.cpSync(store([usage("m", { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 })]), path.join(home, ".openclaw"), { recursive: true });
  const run = (id: string) => collectedWithFailures(undefined,
    { HOME: home, OPENCLAW_STATE_DIR: "", OPENCLAW_AGENT_ID: id });
  assert.deepEqual(run(""), { days: {}, failures: [] }, "unclaimed: nothing reported, nothing failed");
  const named = run("main");
  assert.deepEqual(named.failures, []);
  assert.deepEqual(Object.keys(named.days), ["2026-09-23"], "named by id: that store is reported");
});

/** The whole client, dry-run, on a machine whose only OpenClaw is the default ~/.openclaw. */
function hostRun(withHermes: boolean) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-hostrun-"));
  fs.cpSync(store([usage("m", { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 })], "helper"),
            path.join(home, ".openclaw"), { recursive: true });
  fs.mkdirSync(path.join(home, ".agent-index"));
  fs.writeFileSync(path.join(home, ".agent-index", ".agent-index.json"),
    JSON.stringify({ install_id: "install-test", key: "aik_" + "k".repeat(43) }), { mode: 0o600 });
  if (withHermes) createEmptyHermesStore(path.join(home, ".hermes"));
  try {
    const out = execFileSync("python3", [CLIENT, "--agent", "x", "--dry-run"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH!, HOME: home, AGENT_INDEX_API: "http://127.0.0.1:9" },
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ""}${err.stderr ?? ""}` };
  }
}

test("an unclaimed default OpenClaw that is the only thing found fails loudly, naming the one setting", () => {
  // A single-agent host install relying on ~/.openclaw used to report its
  // agent; reporting nothing in silence would read as a broken agent for days.
  const { ok, out } = hostRun(false);
  assert.equal(ok, false, "it must not pass as a quiet zero");
  assert.match(out, /Set OPENCLAW_AGENT_ID to your agent's id/);
  assert.match(out, /found: helper/, "and it names the agent it saw");
  assert.match(out, /Nothing is wrong with your setup/);
});

test("a Hermes reporter on a machine that also runs OpenClaw keeps reporting", () => {
  const { ok, out } = hostRun(true);
  assert.equal(ok, true, out);
  assert.doesNotMatch(out, /COLLECTOR FAILED/);
});
