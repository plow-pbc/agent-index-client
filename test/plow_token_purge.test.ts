import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// The standalone client is the copy that ships inside a container, so these
// drive the real script rather than a re-implementation of it.
const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");

/** Run the client in a throwaway HOME. Never reaches the network: --dry-run
 *  prints what it would send and returns before any POST. */
function run(home: string, env: Record<string, string | undefined> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: home, AGENT_INDEX_API: "http://127.0.0.1:1" };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k]; else base[k] = v;
  }
  try {
    return { code: 0, out: execFileSync("python3", [CLIENT, "--agent", "purge-test", "--dry-run"],
      { encoding: "utf8", env: base }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

function homeWith(token?: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-"));
  if (token !== undefined) {
    fs.mkdirSync(path.join(home, ".agent-index"));
    fs.writeFileSync(path.join(home, ".agent-index", "token"), token);
  }
  return home;
}

const PLOW = { PLOW_AGENT_TOKEN: "plow-token-for-this-container" }; // pragma: allowlist secret
const NO_PLOW = { PLOW_AGENT_TOKEN: undefined };

// One flow, four situations. The distinction that matters is only ever
// "was there a GitHub bearer on disk", NOT which credential the run was going
// to use — the whole bug was a cleanup that ran on one path and not the other.
const CASES: Array<{ name: string; stored?: string; env: Record<string, string | undefined>; purged: boolean }> = [
  { name: "a container that has a Plow token and a leftover gho_", stored: "gho_leftoverfromtheoldsignin", env: PLOW, purged: true }, // pragma: allowlist secret
  { name: "a host with no Plow token and a leftover ghu_", stored: "ghu_anotherleftover", env: NO_PLOW, purged: true }, // pragma: allowlist secret
  { name: "an install holding an aik_ key", stored: "aik_akeythisclientstilluses", env: NO_PLOW, purged: false }, // pragma: allowlist secret
  { name: "a fresh install with nothing stored", env: PLOW, purged: false },
];

for (const c of CASES) {
  test(`the GitHub purge covers ${c.name}`, () => {
    const home = homeWith(c.stored);
    const { out } = run(home, c.env);
    const tokenFile = path.join(home, ".agent-index", "token");
    if (c.purged) {
      assert.ok(!fs.existsSync(tokenFile), "the GitHub token must not survive the run");
      assert.match(out, /removed a leftover GitHub token/);
    } else {
      assert.doesNotMatch(out, /removed a leftover/);
      if (c.stored !== undefined) {
        assert.equal(fs.readFileSync(tokenFile, "utf8"), c.stored, "only GitHub bearers are legacy");
      }
    }
  });
}

test("a purge that cannot finish stops the run", () => {
  // A read-only home is the real shape of this. Reporting normally would leave
  // a live credential on disk behind a log line, and every later run would hit
  // the same wall just as quietly.
  const home = homeWith("ghp_cannotberemoved"); // pragma: allowlist secret
  const dir = path.join(home, ".agent-index");
  fs.chmodSync(dir, 0o555);
  try {
    const { code, out } = run(home, PLOW);
    assert.notEqual(code, 0, "the run must fail, not carry on");
    assert.match(out, /could NOT be removed/);
    assert.doesNotMatch(out, /removed a leftover GitHub token/, "nothing may claim a removal that did not happen");
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

/** The registration path, which is where a fresh install actually starts. */
function register(home: string, env: Record<string, string | undefined> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: home, AGENT_INDEX_API: "http://127.0.0.1:1" };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k]; else base[k] = v;
  }
  try {
    return { code: 0, out: execFileSync("python3",
      [CLIENT, "--register", "--agent", "purge-test", "--name", "Purge Test"],
      { encoding: "utf8", env: base }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

test("a host install registers on PLOW_AGENT_TOKEN alone, and is told where to get one", () => {
  // A fresh install outside a container has no stored key and nothing sets the
  // variable for it. Exiting with just the variable's name left that install
  // with no way forward and -- deliberately -- no GitHub sign-in to fall back
  // to, so the message has to carry the way forward itself.
  const missing = register(homeWith(), NO_PLOW);
  assert.notEqual(missing.code, 0);
  assert.match(missing.out, /PLOW_AGENT_TOKEN/);
  assert.match(missing.out, /\.hermes-|docker exec/, "say where to get one, not just that it is absent");
  assert.doesNotMatch(missing.out, /github|GitHub/i, "there is no sign-in to fall back to");

  // With the token exported it gets as far as the network, which is the proof
  // that the credential alone is the whole setup: the only thing left to fail
  // is the unreachable API this test points at.
  const ok = register(homeWith(), PLOW);
  assert.doesNotMatch(ok.out, /no PLOW_AGENT_TOKEN/, "an exported token is enough on any host");
  assert.match(ok.out, /could not reach|127\.0\.0\.1/);
});
