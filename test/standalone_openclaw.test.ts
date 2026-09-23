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
function collected(root: string): Record<string, Record<string, Record<string, number>>> {
  const out = execFileSync("python3", ["-c", `
import json, sys
source = open(sys.argv[1]).read().split("def main(")[0]
namespace = {"__name__": "collector"}
exec(compile(source, sys.argv[1], "exec"), namespace)
days = namespace["from_openclaw"](28, state=sys.argv[2])
print(json.dumps({d: {m: dict(v) for m, v in ms.items()} for d, ms in days.items()}))
print(json.dumps(namespace["FAILURES"]))
`, CLIENT, root], { encoding: "utf8" });
  const [days, failures] = out.trim().split("\n");
  assert.deepEqual(JSON.parse(failures), [], "a readable store must not report a failure");
  return JSON.parse(days);
}

const usage = (model: string, u: object, timestamp = "2026-09-23T11:52:38.505Z") =>
  ({ type: "message", timestamp, message: { role: "assistant", model, usage: u } });

test("an assistant message's usage lands under its day and model", () => {
  const days = collected(store([
    usage("z-ai/glm-5.2", { input: 18064, output: 93, cacheRead: 66112, cacheWrite: 0 }),
  ]));
  assert.deepEqual(days, {
    "2026-09-23": { "z-ai/glm-5.2": { input: 18064, output: 93, cache_read: 66112, cache_write: 0 } },
  });
});

test("events add up rather than overwrite, and a turn without usage is not a zero row", () => {
  const days = collected(store([
    usage("z-ai/glm-5.2", { input: 10, output: 1, cacheRead: 5, cacheWrite: 0 }),
    usage("z-ai/glm-5.2", { input: 20, output: 2, cacheRead: 0, cacheWrite: 7 }),
    { type: "message", timestamp: "2026-09-23T11:53:00.000Z", message: { role: "user", content: "hi" } },
  ]));
  assert.deepEqual(days["2026-09-23"], {
    "z-ai/glm-5.2": { input: 30, output: 3, cache_read: 5, cache_write: 7 },
  });
});

test("an OpenClaw root with no store collects nothing, and says nothing failed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aic-openclaw-empty-"));
  assert.deepEqual(collected(root), {});
});
