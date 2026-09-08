import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The standalone client is the copy that ships inside a container, so these
// drive the real script rather than a re-implementation of it.
const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");
const KEY = "aik_" + "k".repeat(43); // pragma: allowlist secret

/** A throwaway install. HOME is isolated because `just test` inherits a real
 *  one, and nothing here may reach the token in a developer's own home. */
function home(state?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aic-status-"));
  if (state !== undefined) fs.writeFileSync(path.join(dir, ".agent-index.json"), state);
  return dir;
}

/** `status`, and the exit code IS the answer -- so it is what we return.
 *  AGENT_INDEX_API and PLOW_API_BASE point at a closed loopback port: a status
 *  that ever reached the network must fail to connect, loudly, not answer from
 *  api.plow.co with whatever credential is lying around. */
function status(dir: string, extra: Record<string, string> = {}): { code: number; out: string } {
  const env = {
    ...process.env, HOME: dir, HERMES_HOME: dir,
    AGENT_INDEX_API: "http://127.0.0.1:1", PLOW_API_BASE: "http://127.0.0.1:1",
    ...extra,
  };
  try {
    return { code: 0, out: execFileSync("python3", [CLIENT, "status"], { encoding: "utf8", env }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

for (const [name, state, code, says] of [
  ["a registered install answers 0", JSON.stringify({ install_id: "i".repeat(32), key: KEY }), 0, /registered: install i{32}/],
  // 3 rather than 1: the caller registers on this one, and only on this one.
  ["no state at all answers 3", undefined, 3, /not registered/],
  // The distinction the whole contract exists for. A caller that collapsed 2
  // into 3 would register over state we merely could not read, minting against
  // a new install id and stranding every row the first one published. It has to
  // say WHICH file, or nobody can fix it.
  ["state that cannot be read answers 2, naming the file", "not json at all", 2, /\.agent-index\.json/],
] as const) {
  test(name, () => {
    const { code: got, out } = status(home(state));
    assert.equal(got, code);
    assert.match(out, says);
  });
}

test("a key in the layout that shipped answers 0, with no state file", () => {
  // The case no caller can get right on its own: registration MOVES the key out
  // of ~/.agent-index/token into the state file, so a shell test on either path
  // is wrong for one of these two installs. This client knows both.
  const dir = home();
  fs.mkdirSync(path.join(dir, ".agent-index"));
  fs.writeFileSync(path.join(dir, ".agent-index", "token"), KEY);
  const { code, out } = status(dir);
  assert.equal(code, 0);
  assert.match(out, /pre-dates install ids/);
});

test("asking does not change the answer", () => {
  // status runs before the startup purge, which deletes a stored credential
  // this client cannot use. That purge is right on a run that is about to
  // report and wrong on a question: a caller polling "am I registered" every
  // hour must not be quietly deleting things, and must be able to ask twice and
  // be told the same thing.
  const dir = home();
  fs.mkdirSync(path.join(dir, ".agent-index"));
  const stale = path.join(dir, ".agent-index", "token");
  fs.writeFileSync(stale, "gho_aleftoverfromtheoldsignin"); // pragma: allowlist secret
  assert.equal(status(dir).code, 3);
  assert.ok(fs.existsSync(stale), "a query must not delete what it read");
  assert.equal(status(dir).code, 3, "and must answer the same the second time");
});

test("a malformed API override cannot stop it answering", () => {
  // The overrides were resolved -- and REFUSED -- at import, so a typo in the
  // environment killed status before main() ran: exit 1 for all three answers.
  // A supervisor reading that as "not registered" registers on every tick,
  // which is the failure this command exists to end. status is local-only, so
  // it owes an answer whatever is in the environment.
  const { code } = status(home(), { AGENT_INDEX_API: "https://not-a-loopback.example.com" });
  assert.equal(code, 3);
});

test("but a command that does reach the Index still refuses that override", () => {
  // The validation is deferred, not dropped. Reports go to the index this
  // client was built to publish to.
  const dir = home(JSON.stringify({ install_id: "i".repeat(32), key: KEY }));
  const env = {
    ...process.env, HOME: dir, HERMES_HOME: dir,
    AGENT_INDEX_API: "https://not-a-loopback.example.com",
  };
  const ran = () => execFileSync("python3", [CLIENT, "--agent", "life", "--dry-run"],
    { encoding: "utf8", env });
  assert.throws(ran, (e: any) => String(e.stderr).includes("bare loopback origin"));
});
