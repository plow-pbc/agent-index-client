import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The standalone client is the copy that ships inside a container, so these
// drive the real script rather than a re-implementation of it.
const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");

function runIn(home: string, env: NodeJS.ProcessEnv = {}) {
  return execFileSync("python3", [CLIENT, "--agent", "purge-test", "--dry-run"], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, AGENT_INDEX_API: "http://127.0.0.1:1", ...env },
  });
}

function homeWithToken(value: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-"));
  fs.mkdirSync(path.join(home, ".agent-index"));
  fs.writeFileSync(path.join(home, ".agent-index", "token"), value);
  return home;
}

test("a leftover GitHub token is deleted even when a Plow token makes it unnecessary", () => {
  // The case that matters: a container that already has PLOW_AGENT_TOKEN never
  // reaches the stored-key path, so a cleanup hanging off that path runs only
  // where there is nothing to clean.
  const home = homeWithToken("gho_leftoverfromtheoldsignin"); // pragma: allowlist secret
  const out = runIn(home, { PLOW_AGENT_TOKEN: "plow-token-for-this-container" }); // pragma: allowlist secret
  assert.ok(!fs.existsSync(path.join(home, ".agent-index", "token")),
    "the GitHub token must not survive a run that had a Plow token");
  assert.match(out, /removed a leftover GitHub token/);
});

test("a run without a Plow token deletes it too", () => {
  const home = homeWithToken("ghu_anotherleftover"); // pragma: allowlist secret
  const env = { ...process.env } as NodeJS.ProcessEnv;
  delete env.PLOW_AGENT_TOKEN;
  let out = "";
  try {
    out = execFileSync("python3", [CLIENT, "--agent", "purge-test", "--dry-run"],
      { encoding: "utf8", env: { ...env, HOME: home, AGENT_INDEX_API: "http://127.0.0.1:1" } });
  } catch (e: any) {
    out = String(e.stdout || "") + String(e.stderr || "");
  }
  assert.ok(!fs.existsSync(path.join(home, ".agent-index", "token")));
  assert.match(out, /removed a leftover GitHub token/);
});

test("a stored agent key is left alone", () => {
  // Only GitHub bearers are legacy. An install holding an aik_ key still works,
  // and a purge that took it would sign that install out.
  const home = homeWithToken("aik_akeythisclientstilluses"); // pragma: allowlist secret
  const out = runIn(home);
  assert.equal(fs.readFileSync(path.join(home, ".agent-index", "token"), "utf8"),
    "aik_akeythisclientstilluses"); // pragma: allowlist secret
  assert.doesNotMatch(out, /removed a leftover/);
});

test("nothing claims a removal that did not happen", () => {
  // A read-only mount is the real shape of this: reporting success there would
  // leave a live credential on disk behind a log line saying it was gone.
  const home = homeWithToken("ghp_cannotberemoved"); // pragma: allowlist secret
  const dir = path.join(home, ".agent-index");
  fs.chmodSync(dir, 0o555);
  try {
    const out = runIn(home, { PLOW_AGENT_TOKEN: "plow-token" }); // pragma: allowlist secret
    assert.match(out, /could NOT be removed/);
    assert.doesNotMatch(out, /removed a leftover GitHub token/);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});
