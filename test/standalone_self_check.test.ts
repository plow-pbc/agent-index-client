import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");

test("the standalone client's own --self-check passes", () => {
  // It carries the spec for the delta collector -- what a first run may place,
  // what it must never invent -- and nothing in `npm test` ran it, so a change
  // that broke those assertions still went green here. It runs offline.
  // HOME is isolated on purpose: this runs on a developer's machine, and a
  // startup step that deletes a stale credential must never reach the token in
  // their real ~/.agent-index because they ran the tests.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-selfcheck-"));
  const out = execFileSync("python3", [CLIENT, "--self-check"],
    { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.match(out, /self-check OK/);
});

test("running the tests never touches the developer's own token", () => {
  // `just test` inherits a real HOME. --self-check needs no credential at all,
  // so it must not be a path that removes one.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-home-"));
  fs.mkdirSync(path.join(home, ".agent-index"));
  const token = path.join(home, ".agent-index", "token");
  fs.writeFileSync(token, "gho_thedevelopersleftovertoken"); // pragma: allowlist secret
  execFileSync("python3", [CLIENT, "--self-check"], { encoding: "utf8", env: { ...process.env, HOME: home } });
  assert.ok(fs.existsSync(token), "a test run must not delete files in a real home");
});

test("the client refuses to send the Plow token over cleartext http", () => {
  const run = (api: string) => {
    try {
      return execFileSync("python3", [CLIENT, "--agent", "x", "--dry-run"],
        { encoding: "utf8", env: { ...process.env, AGENT_INDEX_API: api, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "aic-")) } });
    } catch (e: any) {
      return String(e.stdout || "") + String(e.stderr || "");
    }
  };
  assert.match(run("http://agent-index-server.example.com"), /must be https/);
  // Localhost is the exception, and only localhost: that traffic never leaves
  // the machine, and a local server is why this variable exists.
  assert.doesNotMatch(run("http://127.0.0.1:3000"), /must be https/);
  assert.doesNotMatch(run("https://agent-index-server.example.com"), /must be https/);
});
