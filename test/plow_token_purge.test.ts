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

test("the loopback exception bypasses the proxy it would otherwise leak through", () => {
  // urllib reads HTTP_PROXY from the environment, so on a machine with a proxy
  // set and loopback missing from NO_PROXY -- an ordinary corporate box -- the
  // cleartext exception stopped meaning "never leaves the machine" and started
  // meaning "goes to the proxy, with the bearer in it".
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-proxy-"));
  const out = client(["--agent", "x", "--dry-run"], home, {
    AGENT_INDEX_API: "http://127.0.0.1:1",
    HTTP_PROXY: "http://proxy.invalid:3128",
    http_proxy: "http://proxy.invalid:3128",
    NO_PROXY: undefined,
    no_proxy: undefined,
  });
  assert.doesNotMatch(out.out, /must be https/, "loopback is still allowed");

  // The exact string from the review: a hand-rolled split reads the host as
  // "localhost" while urllib -- the thing that opens the socket -- reads it as
  // attacker.example with "localhost:80" as a username. The check said the
  // token never left the machine; it would have gone to a stranger in the clear.
  const smuggled = client(["--agent", "x", "--dry-run"], fs.mkdtempSync(path.join(os.tmpdir(), "aic-")),
    { AGENT_INDEX_API: "http://localhost:80@attacker.example" });
  assert.notEqual(smuggled.code, 0, "userinfo must not get past the loopback check");
  assert.match(smuggled.out, /must not carry credentials/);
  assert.doesNotMatch(smuggled.out, /attacker\.example.*localhost|localhost:80@/,
    "the message must not echo the URL it is refusing");

  // A password in a rejection message is a password in the supervisor log that
  // outlives the run -- moved from one place we do not want it to another.
  const secret = client(["--agent", "x", "--dry-run"], fs.mkdtempSync(path.join(os.tmpdir(), "aic-")),
    { AGENT_INDEX_API: "https://someone:hunter2@index.example" }); // pragma: allowlist secret
  assert.notEqual(secret.code, 0);
  assert.doesNotMatch(secret.out, /hunter2/, "a refused credential must not be printed"); // pragma: allowlist secret
  assert.match(secret.out, /index\.example/, "but say enough to fix the typo");
  assert.doesNotMatch(smuggled.out, /agentsview/, "and it must fail before any work is done");

  // Credentials in a URL have no use here at all, https included.
  const overTls = client(["--agent", "x", "--dry-run"], fs.mkdtempSync(path.join(os.tmpdir(), "aic-")),
    { AGENT_INDEX_API: "https://user:pass@index.example" });
  assert.notEqual(overTls.code, 0);

  // The real loopback forms still work, including IPv6.
  for (const ok of ["http://127.0.0.1:3000", "http://localhost:8080", "http://[::1]:8000"]) {
    const r = client(["--agent", "x", "--dry-run"], fs.mkdtempSync(path.join(os.tmpdir(), "aic-")),
      { AGENT_INDEX_API: ok });
    assert.doesNotMatch(r.out, /must be https|must not carry credentials/, `${ok} is loopback`);
  }

  // Anything this prints lands in a supervisor log that outlives the run, and a
  // URL can carry a secret anywhere in it -- not only in userinfo. An
  // unreachable host is the path that prints one on an ordinary run.
  const unreachable = client(["--register", "--agent", "x", "--name", "X"],
    fs.mkdtempSync(path.join(os.tmpdir(), "aic-")),
    { AGENT_INDEX_API: "https://index.example/collect?k=supersecrettoken",  // pragma: allowlist secret
      PLOW_AGENT_TOKEN: "plow-token" });                                    // pragma: allowlist secret
  assert.doesNotMatch(unreachable.out, /supersecrettoken/,                  // pragma: allowlist secret
    "a query parameter must not reach the log");
  assert.doesNotMatch(unreachable.out, /\/collect/, "nor the path");
  assert.match(unreachable.out, /index\.example/, "but say which host, so a typo is findable");

  const src = fs.readFileSync(CLIENT, "utf8");
  const opener = src.slice(src.indexOf("def _open_no_redirect"), src.indexOf("def _post("));
  assert.match(opener, /ProxyHandler\(\{\}\)/, "loopback requests must disable the environment proxy");
  assert.match(opener, /LOOPBACK/, "and only loopback: https keeps the default handlers");
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

test("a URL urllib would choke on is refused before it can be printed", () => {
  // A space in the path is accepted by urlsplit and rejected by http.client,
  // which raises InvalidURL carrying the WHOLE url -- query string included --
  // and an uncaught traceback prints it into a supervisor log. Refusing it in
  // one place, up front, is what keeps every later path from having to be
  // careful.
  const bad = client(["--agent", "x", "--dry-run"], fs.mkdtempSync(path.join(os.tmpdir(), "aic-")),
    { AGENT_INDEX_API: "https://index.example/collect bad?k=supersecret" }); // pragma: allowlist secret
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /spaces or control characters/);
  assert.doesNotMatch(bad.out, /supersecret/, "the query must not reach the log"); // pragma: allowlist secret
  assert.doesNotMatch(bad.out, /Traceback/, "and it must not arrive as a traceback");
  assert.match(bad.out, /index\.example/, "but say which host");

  // The other shapes urllib would accept and we should not.
  for (const url of ["https:///nohost", "ftp://index.example", "https://index.example/a\tb"]) {
    const r = client(["--agent", "x", "--dry-run"], fs.mkdtempSync(path.join(os.tmpdir(), "aic-")),
      { AGENT_INDEX_API: url });
    assert.notEqual(r.code, 0, `${url} should be refused`);
    assert.doesNotMatch(r.out, /Traceback/);
  }

  // Every failure path reports through the redactor, so none of them can print
  // a raw URL even when something inside the stack hands one back.
  const src = fs.readFileSync(CLIENT, "utf8");
  for (const m of src.matchAll(/(?:print|sys\.exit|"error":)[^\n]*\{url[^\n]*/g)) {
    assert.match(m[0], /_shown\(url\)/, `a raw URL is printed here: ${m[0].trim()}`);
  }
});
