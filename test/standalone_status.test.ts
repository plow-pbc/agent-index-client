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
function status(dir: string): { code: number; out: string } {
  const env = {
    ...process.env, HOME: dir, HERMES_HOME: dir,
    AGENT_INDEX_API: "http://127.0.0.1:1", PLOW_API_BASE: "http://127.0.0.1:1",
  };
  try {
    return { code: 0, out: execFileSync("python3", [CLIENT, "status"], { encoding: "utf8", env }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

test("a registered install answers 0", () => {
  const { code, out } = status(home(JSON.stringify({ install_id: "i".repeat(32), key: KEY })));
  assert.equal(code, 0);
  assert.match(out, /registered: install i{32}/);
});

test("an install with no state answers 3", () => {
  // 3 rather than 1: the caller registers on this one, and only on this one.
  const { code, out } = status(home());
  assert.equal(code, 3);
  assert.match(out, /not registered/);
});

test("state that is there and unreadable answers 2, naming the file", () => {
  // The distinction the whole contract exists for. A caller that collapsed 2
  // into 3 would register over state we merely could not read, minting against
  // a new install id and stranding every row the first one published.
  const { code, out } = status(home("not json at all"));
  assert.equal(code, 2);
  assert.match(out, /\.agent-index\.json/, "it says WHICH file, or nobody can fix it");
});

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
