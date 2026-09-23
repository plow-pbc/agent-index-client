import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The standalone client is the copy that ships inside a container, so this
// drives the real script rather than a re-implementation of it.
const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");

/** One OpenClaw state root holding one agent's store, the shape current
 *  OpenClaw writes: `agents/<id>/agent/openclaw-agent.sqlite`, one row per
 *  transcript event, usage carried by the assistant message that spent it. */
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
  const out = execFileSync("python3", ["-c", `
import json, sys
source = open(sys.argv[1]).read().split("def main(")[0]
namespace = {"__name__": "collector"}
exec(compile(source, sys.argv[1], "exec"), namespace)
days = namespace["from_openclaw"](28, state=sys.argv[2])
print(json.dumps({d: {m: dict(v) for m, v in ms.items()} for d, ms in days.items()}))
print(json.dumps(namespace["FAILURES"]))
`, CLIENT, root], { encoding: "utf8", env: { ...process.env, ...env } });
  const [days, failures] = out.trim().split("\n");
  assert.deepEqual(JSON.parse(failures), [], "a readable store must not report a failure");
  return JSON.parse(days);
}

const usage = (model: string, u: object, timestamp = "2026-09-23T11:52:38.505Z") =>
  ({ type: "message", timestamp, message: { role: "assistant", model, usage: u } });

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
