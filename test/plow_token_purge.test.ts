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
function client(args: string[], home: string, env: Record<string, string | undefined> = {}) {
  const base: NodeJS.ProcessEnv = { ...process.env, HOME: home, AGENT_INDEX_API: "http://127.0.0.1:1" };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k]; else base[k] = v;
  }
  try {
    return { code: 0, out: execFileSync("python3", [CLIENT, ...args], { encoding: "utf8", env: base }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

// The two things a run can be: a report, or the registration a fresh install
// starts with. Same seam, different argv -- they were duplicated.
const run = (home: string, env: Record<string, string | undefined> = {}) =>
  client(["--agent", "purge-test", "--dry-run"], home, env);
const register = (home: string, env: Record<string, string | undefined> = {}) =>
  client(["--register", "--agent", "purge-test", "--name", "Purge Test"], home, env);

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
const KEY = "aik_" + "k".repeat(43);   // the shape the index mints  // pragma: allowlist secret
const CASES: Array<{ name: string; stored?: string; env: Record<string, string | undefined>; purged: boolean }> = [
  { name: "a container that has a Plow token and a leftover gho_", stored: "gho_leftoverfromtheoldsignin", env: PLOW, purged: true }, // pragma: allowlist secret
  { name: "a host with no Plow token and a leftover ghu_", stored: "ghu_anotherleftover", env: NO_PLOW, purged: true }, // pragma: allowlist secret
  // The namespaces a prefix blocklist missed. Each was treated as an Index key
  // and sent as authorization to the index.
  { name: "a github_pat_ token", stored: "github_pat_11ABCDE_abcdefghij", env: NO_PLOW, purged: true }, // pragma: allowlist secret
  { name: "a ghs_ token", stored: "ghs_aserverkey", env: NO_PLOW, purged: true },   // pragma: allowlist secret
  { name: "a ghr_ token", stored: "ghr_arefreshtoken", env: NO_PLOW, purged: true }, // pragma: allowlist secret
  { name: "something else entirely", stored: "sk-or-a-note-to-self", env: NO_PLOW, purged: true }, // pragma: allowlist secret
  { name: "an install holding an Index key", stored: KEY, env: NO_PLOW, purged: false },
  { name: "a fresh install with nothing stored", env: PLOW, purged: false },
];

for (const c of CASES) {
  test(`the GitHub purge covers ${c.name}`, () => {
    const home = homeWith(c.stored);
    const { out } = run(home, c.env);
    const tokenFile = path.join(home, ".agent-index", "token");
    if (c.purged) {
      assert.ok(!fs.existsSync(tokenFile), "the GitHub token must not survive the run");
      assert.match(out, /removed a stored credential/);
    } else {
      assert.doesNotMatch(out, /removed a stored credential/);
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
    assert.doesNotMatch(out, /removed a stored credential/, "nothing may claim a removal that did not happen");
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

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

test("reports can only go to the index, or to a bare loopback origin", () => {
  // The origin is hard-coded. An environment override that could name any host
  // needed a scheme check, a host check, userinfo, whitespace, a proxy bypass
  // and a redactor for everything it might print -- and each of those was a
  // separate hole. What is left is one shape: loopback, nothing else, so there
  // is no path or query to leak and no remote host to reach.
  const run = (api: string) =>
    client(["--agent", "x", "--dry-run"], fs.mkdtempSync(path.join(os.tmpdir(), "aic-")),
      { AGENT_INDEX_API: api });

  for (const ok of ["http://127.0.0.1:3000", "http://localhost:8080", "http://[::1]:8000", ""]) {
    assert.doesNotMatch(run(ok).out, /may only be a bare loopback origin/, `${ok} is allowed`);
  }

  // Every shape that cost a fix while the override was general.
  for (const bad of [
    "https://index.example",                       // a remote host at all
    "https://index.example/collect bad?k=secret",  // whitespace urllib refuses  // pragma: allowlist secret
    "http://localhost:80@attacker.example",        // userinfo that reads as loopback
    "https://someone:hunter2@index.example",       // credentials in a URL       // pragma: allowlist secret
    "http://127.0.0.1:3000/path?k=secret",         // a query to print           // pragma: allowlist secret
    "ftp://index.example",
    "https:///nohost",
    "https://index.example:supersecrettoken",       // a secret smuggled as a port // pragma: allowlist secret
    "http://127.0.0.1:99999",                       // a port urlsplit accepts and then raises on
  ]) {
    const r = run(bad);
    assert.notEqual(r.code, 0, `${bad} must be refused`);
    assert.doesNotMatch(r.out, /Traceback/, "refused, not raised");
    assert.doesNotMatch(r.out, /secret|hunter2/, "and never quoted back"); // pragma: allowlist secret
  }

  const src = fs.readFileSync(CLIENT, "utf8");
  // The redactor is total. It is what every error path calls to make a URL safe
  // to print, so it must not be the thing that raises: urlsplit(...).port
  // throws on an out-of-range port, and a traceback out of here would carry the
  // URL it was handed.
  const shownAt = src.indexOf("def _shown(");
  const shown = src.slice(shownAt, src.indexOf("\n\n\n", shownAt));
  assert.match(shown, /except ValueError/, "the redactor must not raise");

  // A loopback request still bypasses the environment proxy: HTTP_PROXY would
  // otherwise send it, and the bearer, to a remote proxy.
  const opener = src.slice(src.indexOf("def _open_no_redirect"), src.indexOf("def _post("));
  assert.match(opener, /ProxyHandler\(\{\}\)/);
  assert.match(opener, /LOOPBACK/);
});

test("the image ships the client this repo builds", () => {
  // A rebuild used to install hermes_client.py -- the tokenmaxxing-format fork
  // kept for lineage, which wants TKMX_API_KEY and posts to tokenmaxxing. The
  // container came up with a reporter that cannot reach the Agent Index.
  const dockerfile = fs.readFileSync(path.join(__dirname, "..", "..", "standalone", "Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY[^\n]*agent_index_client\.py \/usr\/local\/bin\/agent-index-client/,
    "the image must install this client, under the name the reporter service execs");
  assert.doesNotMatch(dockerfile, /COPY[^\n]*hermes_client\.py/, "and not the tokenmaxxing fork");
});

test("the Plow token is never handed to the agentsview binary", () => {
  // agentsview is separately installed: we do not ship it, cannot audit it, and
  // it has no use for the credential that identifies this agent's owner. The
  // inherited environment handed it over on every run.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-child-"));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  // A stand-in agentsview that reports what it was given.
  const seen = path.join(home, "seen.txt");
  fs.writeFileSync(path.join(bin, "agentsview"),
    `#!/bin/sh
env > ${seen}
echo '[]'
`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".local"));
  fs.symlinkSync(bin, path.join(home, ".local", "bin"));   // where the client looks

  client(["--agent", "x", "--dry-run"], home, {
    PLOW_AGENT_TOKEN: "plow-token-that-must-not-travel",   // pragma: allowlist secret
    SOME_OTHER_SECRET: "also-not-for-a-child",             // pragma: allowlist secret
  });

  assert.ok(fs.existsSync(seen), "the stand-in agentsview should have run");
  const childEnv = fs.readFileSync(seen, "utf8");
  assert.doesNotMatch(childEnv, /plow-token-that-must-not-travel/,  // pragma: allowlist secret
    "the child must never see the Plow token");
  assert.doesNotMatch(childEnv, /also-not-for-a-child/,             // pragma: allowlist secret
    "an allowlist, so a secret we have not thought of yet is also withheld");
  assert.match(childEnv, /^PATH=/m, "but it still gets what it needs to run");
});

