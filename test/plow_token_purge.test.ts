import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { standIns, PLOW_TOKEN, ASSERTION, MINTED_KEY, type StandIns } from "./fake-plow-index";

// The standalone client is the copy that ships inside a container, so these
// drive the real script rather than a re-implementation of it.
const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");

/** Run the client in a throwaway HOME. Never reaches the network: --dry-run
 *  prints what it would send and returns before any POST. */
function childEnvFor(home: string, env: Record<string, string | undefined>): NodeJS.ProcessEnv {
  // PLOW_API_BASE defaults to a closed loopback port for the same reason
  // AGENT_INDEX_API does: a test that forgets to set one must fail to connect,
  // not reach the real api.plow.co with whatever token is lying around.
  const base: NodeJS.ProcessEnv = {
    ...process.env, HOME: home,
    AGENT_INDEX_API: "http://127.0.0.1:1", PLOW_API_BASE: "http://127.0.0.1:1",
  };
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete base[k]; else base[k] = v;
  }
  return base;
}

function client(args: string[], home: string, env: Record<string, string | undefined> = {}) {
  const base = childEnvFor(home, env);
  try {
    return { code: 0, out: execFileSync("python3", [CLIENT, ...args], { encoding: "utf8", env: base }) };
  } catch (e: any) {
    return { code: e.status ?? 1, out: String(e.stdout || "") + String(e.stderr || "") };
  }
}

/** Same run, asynchronously. The stand-in servers below are in THIS process,
 *  and execFileSync blocks the event loop for the whole child lifetime -- so a
 *  test that talks to them has to let the loop turn. */
function clientAsync(args: string[], home: string, env: Record<string, string | undefined> = {}) {
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn("python3", [CLIENT, ...args], { env: childEnvFor(home, env) });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
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

/** The path the client stores its minted Index key at, inside a test HOME. */
const tokenPath = (home: string) => path.join(home, ".agent-index", "token");

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
        // Ours, so it is kept exactly where it is. A report reads the layout
        // it finds and moves nothing; registering is what upgrades an install.
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
  // is the unreachable API this test points at. That API is now PLOW, not the
  // Index -- the exchange is the first hop -- and an unreachable Plow is the
  // ORDINARY case at container boot, so it has to be a reported failure and
  // never a traceback carrying the URL it was handed.
  const ok = register(homeWith(), PLOW);
  assert.notEqual(ok.code, 0);
  assert.doesNotMatch(ok.out, /no PLOW_AGENT_TOKEN/, "an exported token is enough on any host");
  assert.doesNotMatch(ok.out, /Traceback/, "reported, not raised");
  assert.match(ok.out, /could not reach.*127\.0\.0\.1/);
  assert.doesNotMatch(ok.out, new RegExp(PLOW.PLOW_AGENT_TOKEN), "and never quotes the token back");
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

  // And it keeps what a recreated container must not lose. HERMES_HOME holds
  // the usage ledger and this install's identity; inside the writable layer,
  // a recreated container registers as a stranger, is given a new install id,
  // and its numbers arrive beside the ones it wrote instead of on top of them.
  const home = dockerfile.match(/ENV HERMES_HOME=(\S+)/)?.[1];
  assert.ok(home, "the image must say where Hermes keeps its state");
  assert.match(dockerfile, new RegExp(`VOLUME ${home}\\b`),
    `${home} holds the install id, so the image has to declare it as a volume`);
});

/** Install a stand-in agentsview in a home, running `body`.
 *
 *  Always, even where a test does not care what the collector says: the client
 *  falls back to /opt/homebrew/bin and /usr/local/bin, which are ABSOLUTE, so
 *  a machine with the real agentsview installed would run it and collect that
 *  developer's own usage into the test.
 */
function stubAgentsView(home: string, body: string) {
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, "agentsview"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(home, ".local"), { recursive: true });
  fs.symlinkSync(bin, path.join(home, ".local", "bin"));   // where the client looks
}

/** A home with a stand-in agentsview that records the environment it was given.
 *  Both env tests need the same thing: an installed collector, a place for it
 *  to write what it saw, and a client run that invokes it. */
function withFakeAgentsView() {
  const home = homeWith(KEY);   // a report needs a stored key BEFORE it collects
  const seen = path.join(home, "seen.txt");
  stubAgentsView(home, `env > ${seen}\necho '[]'`);
  return {
    home,
    /** Run a collection and return the environment the child actually received. */
    childEnv(env: Record<string, string | undefined>) {
      client(["--agent", "x", "--dry-run"], home, env);
      assert.ok(fs.existsSync(seen), "the stand-in agentsview should have run");
      return fs.readFileSync(seen, "utf8");
    },
  };
}

test("the Plow token is never handed to the agentsview binary", () => {
  // agentsview is separately installed: we do not ship it, cannot audit it, and
  // it has no use for the credential that identifies this agent's owner. The
  // inherited environment handed it over on every run.
  const av = withFakeAgentsView();
  const childEnv = av.childEnv({
    PLOW_AGENT_TOKEN: "plow-token-that-must-not-travel",   // pragma: allowlist secret
    SOME_OTHER_SECRET: "also-not-for-a-child",             // pragma: allowlist secret
  });
  assert.doesNotMatch(childEnv, /plow-token-that-must-not-travel/,  // pragma: allowlist secret
    "the child must never see the Plow token");
  assert.doesNotMatch(childEnv, /also-not-for-a-child/,             // pragma: allowlist secret
    "an allowlist, so a secret we have not thought of yet is also withheld");
  assert.match(childEnv, /^PATH=/m, "but it still gets what it needs to run");
});

test("agentsview keeps its own configuration", () => {
  // Withholding a secret must not withhold the tool's own settings: an install
  // that points agentsview at its data through one of these and does not get it
  // back reads the DEFAULT location and reports a total that is WRONG rather
  // than absent. The list comes from `agentsview --help` (v0.38.1).
  const CONFIG = {
    AGENTSVIEW_DATA_DIR: "/tmp/av-data",
    CLAUDE_PROJECTS_DIR: "/tmp/claude-projects",
    CODEX_SESSIONS_DIR: "/tmp/codex-sessions",
    CURSOR_PROJECTS_DIR: "/tmp/cursor-projects",
    OPENCODE_DIR: "/tmp/opencode",
    ZED_DIR: "/tmp/zed",
  };
  const av = withFakeAgentsView();
  const childEnv = av.childEnv({ ...CONFIG, PLOW_AGENT_TOKEN: "plow-token-that-must-not-travel" }); // pragma: allowlist secret
  for (const [k, v] of Object.entries(CONFIG)) {
    assert.match(childEnv, new RegExp(`^${k}=${v}$`, "m"), `${k} must reach agentsview`);
  }
  assert.doesNotMatch(childEnv, /plow-token-that-must-not-travel/,  // pragma: allowlist secret
    "and the token still must not");
});

test("a failed tag read fails the command", () => {
  // Returning [] said "no tags are in use", which is a real answer to a
  // different question, and --tags exited 0 having read nothing.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-tags-"));
  const r = client(["--agent", "x", "--tags"], home,
    { PLOW_AGENT_TOKEN: "plow-token", AGENT_INDEX_API: "http://127.0.0.1:1" }); // pragma: allowlist secret
  assert.notEqual(r.code, 0, "a read that failed is not an empty list");
  assert.match(r.out, /could not read tags/);
  assert.match(r.out, /127\.0\.0\.1/, "says which host");
  assert.doesNotMatch(r.out, /Traceback/);
});


test("a credential we cannot read is never deleted, and stops the run", () => {
  // Unreadable is unclassifiable, and the two wrong answers are opposites:
  // carrying on leaves a legacy credential on disk while we report past it,
  // and deleting it signs out an install whose perfectly good key happens to
  // be unreadable this minute (a permissions change, an EIO). Neither: stop,
  // and name the error.
  for (const stored of ["gho_cannotevenbereadanymore", "aik_" + "k".repeat(43)]) {  // pragma: allowlist secret
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-unreadable-"));
    fs.mkdirSync(path.join(home, ".agent-index"));
    const token = path.join(home, ".agent-index", "token");
    fs.writeFileSync(token, stored);
    fs.chmodSync(token, 0o000);
    try {
      const r = client(["--agent", "x", "--dry-run"], home, { PLOW_AGENT_TOKEN: "plow-token" }); // pragma: allowlist secret
      assert.notEqual(r.code, 0, "an unclassifiable credential must stop the run");
      assert.match(r.out, /could not be READ/);
      assert.ok(fs.existsSync(token), "and must NOT be deleted: it may be a key that still works");
    } finally {
      fs.chmodSync(token, 0o600);
    }
  }
});

test("a run with no credential fails before it does any work", () => {
  // A run that collected nothing never reached the credential check, so an
  // install with none read its stores, sent a best-effort pending request and
  // exited 0 -- success, hourly, from a machine that cannot report.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-nocred-"));
  const r = client(["--agent", "x"], home, { PLOW_AGENT_TOKEN: undefined });
  assert.notEqual(r.code, 0, "no credential is a failure, not a quiet success");
  assert.match(r.out, /no PLOW_AGENT_TOKEN/);
  assert.doesNotMatch(r.out, /agent=|days=/, "and it must fail before collecting anything");

  // Reading the docs does not require a credential: the check sits after the
  // flag handling, so a fresh install can find out what this thing wants
  // before it has what it wants.
  const help = client(["--help"], home, { PLOW_AGENT_TOKEN: undefined });
  assert.equal(help.code, 0);
  assert.doesNotMatch(help.out, /no PLOW_AGENT_TOKEN/);
});


// ---------------------------------------------------------------------------
// The credential exchange, end to end, against stand-in Plow and Index servers.
//
// Every assertion above this line is about what the client REFUSES. These are
// about what it does when everything works, which is the half that decides
// whether the Plow token stays home: that is only observable from the far end,
// so it needs servers rather than a dry run.
// ---------------------------------------------------------------------------

/** The two stand-ins, closed however the case ends. Every integration case
 *  below wants exactly this and nothing else, and the identical try/finally in
 *  each of them was one more place for a server to be left listening. */
async function withStandIns<T>(body: (s: StandIns) => Promise<T>, mintDelayMs = 0): Promise<T> {
  const s = await standIns(mintDelayMs);
  try {
    return await body(s);
  } finally {
    await s.close();
  }
}

/** A home wired to the stand-ins, with a collector that finds nothing. */
function bootstrapHome(s: { plow: string; index: string }) {
  const home = homeWith();               // a fresh install: nothing stored
  stubAgentsView(home, "echo '[]'");
  return {
    home,
    env: {
      PLOW_AGENT_TOKEN: PLOW_TOKEN,
      PLOW_API_BASE: s.plow,
      AGENT_INDEX_API: s.index,
      HERMES_HOME: undefined,            // guess, do not fail: an absent store
    } as Record<string, string | undefined>,                // nobody named is not an error
  };
}

test("registration trades the Plow token for an assertion, and stores what the Index mints", () =>
  withStandIns(async (s) => {
    const { home, env } = bootstrapHome(s);
    const r = await clientAsync(["--register", "--agent", "purge-test", "--name", "Purge Test"], home, env);
    assert.equal(r.code, 0, r.out);

    // Plow is asked once, with the container's own token. That is the only
    // place that token is ever allowed to go.
    assert.deepEqual(s.plowHits.map((h) => `${h.method} ${h.path}`),
      ["GET /v1/auth/index-identity"], "one exchange, on the identity route");
    assert.equal(s.plowHits[0].bearer, `Bearer ${PLOW_TOKEN}`);

    // The Index is shown the assertion and NOTHING else. Both halves matter:
    // the stand-in 401s a Plow token, so a leak fails the run, and this also
    // catches one smuggled somewhere a 401 would not look.
    assert.deepEqual(s.indexHits.map((h) => `${h.method} ${h.path}`),
      ["POST /v1/agents", "POST /v1/keys"], "register, then mint");
    for (const h of s.indexHits) {
      assert.equal(h.bearer, `Bearer ${ASSERTION}`, `${h.path} must carry the assertion`);
    }
    assert.doesNotMatch(s.indexSaw(), new RegExp(PLOW_TOKEN),
      "the Plow token must never reach the Index");

    // What lands on disk is the minted key, privately, by rename: a reader
    // that opens the file mid-write must never see a half-written credential.
    const state = path.join(home, ".agent-index", ".agent-index.json");
    assert.equal(JSON.parse(fs.readFileSync(state, "utf8")).key, MINTED_KEY);
    assert.equal(fs.statSync(state).mode & 0o777, 0o600, "the key is not world-readable");
    assert.ok(!fs.existsSync(state + ".new"), "no temp file survives the write");
  }));

// --install-url is the one registration field a publisher can UNSET, so its
// three states are checked at the wire rather than in the argv parser: a link
// is sent, an empty one is sent, and an omitted flag says nothing at all. The
// server reads absent as "leave what is on record alone", so a client that
// dropped the empty value -- as it does for every other empty field -- would
// leave an owner no way to take a bad link off a page anyone can read.
test("--install-url sends a link, sends a clear, and stays silent when omitted", async () => {
  for (const [label, args, sent] of [
    ["a link is sent", ["--install-url", "https://example.com/how-to-install"], "https://example.com/how-to-install"],
    ["an empty one is sent, and clears", ["--install-url", ""], ""],
    ["an omitted flag must not clear a tutorial the owner set earlier", [], undefined],
  ] as const) {
    const s = await standIns();
    try {
      const { home, env } = bootstrapHome(s);
      const r = await clientAsync(["--register", "--agent", "purge-test", ...args], home, env);
      assert.equal(r.code, 0, r.out);
      const body = s.indexHits.find((h) => h.path === "/v1/agents")?.body as Record<string, unknown>;
      if (sent === undefined) assert.ok(!("install_url" in body), label);
      else assert.equal(body.install_url, sent, label);
    } finally {
      await s.close();
    }
  }
});

test("every later report carries the stored key alone, and never goes back to Plow", () =>
  withStandIns(async (s) => {
    const { home, env } = bootstrapHome(s);
    const boot = await clientAsync(["--register", "--agent", "purge-test"], home, env);
    assert.equal(boot.code, 0, boot.out);
    const plowCallsAfterBootstrap = s.plowHits.length;

    const r = await clientAsync(["--agent", "purge-test"], home, env);
    assert.equal(r.code, 0, r.out);

    // The stand-in 401s anything but the minted key on a report route, so this
    // failing is the flow being wrong rather than an assertion being stale.
    const reports = s.indexHits.filter((h) => h.path === "/v1/usage");
    assert.equal(reports.length, 1, `exactly one report: ${r.out}`);
    assert.equal(reports[0].bearer, `Bearer ${MINTED_KEY}`,
      "reports are authorised by the key the Index issued");

    // The token is still exported -- a container never stops carrying it --
    // and is still not used, which is the whole point of storing a key.
    assert.equal(s.plowHits.length, plowCallsAfterBootstrap,
      "the exchange happens at bootstrap and never again");
  }));

test("a report prefers the stored key even while a Plow token is exported", async () => {
  // The ordering inside auth_headers(). With both present the Plow token is
  // the tempting one -- it is the credential the container was given -- and
  // sending it would authorise reports with a token the Index cannot scope.
  const s = await standIns();
  try {
    const home = homeWith(MINTED_KEY);       // already bootstrapped
    stubAgentsView(home, "echo '[]'");
    const r = await clientAsync(["--agent", "purge-test"], home, {
      PLOW_AGENT_TOKEN: PLOW_TOKEN, PLOW_API_BASE: s.plow,
      AGENT_INDEX_API: s.index, HERMES_HOME: undefined,
    });
    assert.equal(r.code, 0, r.out);
    assert.equal(s.plowHits.length, 0, "a stored key needs no exchange");
    assert.doesNotMatch(s.indexSaw(), new RegExp(PLOW_TOKEN));
    assert.ok(s.indexHits.length > 0, "the report must actually have been sent");
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// Which INSTALL is reporting. The Index counts a day's usage under an install
// rather than under the key that authenticated it, so everything below is
// about one question: does this container still know which install it is.
// ---------------------------------------------------------------------------

/** A home plus the volume a container keeps across recreations. The shipped
 *  image sets HERMES_HOME=/opt/data and mounts it, which is what this is. */
function volumeHome(s: { plow: string; index: string }, volume?: string) {
  const home = homeWith();
  stubAgentsView(home, "echo '[]'");
  const data = volume || fs.mkdtempSync(path.join(os.tmpdir(), "aic-volume-"));
  return {
    home, data,
    env: {
      PLOW_AGENT_TOKEN: PLOW_TOKEN, PLOW_API_BASE: s.plow, AGENT_INDEX_API: s.index,
      HERMES_HOME: data,
    } as Record<string, string | undefined>,
  };
}

/** The one file: which install this is, and the key that reports for it. */
const stateFile = (dir: string) => path.join(dir, ".agent-index.json");
/** A Hermes store with nothing in it: enough for the collector to read, which
 *  is all these cases need. One schema, because two drift. */
function createEmptyHermesStore(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, "state.db"));
  db.exec("CREATE TABLE session_model_usage (session_id TEXT, model TEXT, input_tokens INT," +
          " output_tokens INT, cache_read_tokens INT, cache_write_tokens INT, first_seen REAL, last_seen REAL)");
  db.close();
}
const stateOf = (dir: string) =>
  JSON.parse(fs.readFileSync(stateFile(dir), "utf8")) as { install_id?: string; key?: string };
const askedInstall = (s: { indexHits: { path: string; body?: unknown }[] }) =>
  (s.indexHits.filter((h) => h.path === "/v1/keys").at(-1)!.body as { install_id?: string }).install_id;

// One lifecycle, three ways in. Each row is a state a container can start
// from; all three then do the same thing, which is the point: claim an id
// once, keep it on the volume, and still be that install after a recreation
// that takes the home away.
for (const [start, seed] of [
  ["a first install", () => {}],
  ["an install with a ledger and no token", (home: string, data: string) =>
    fs.writeFileSync(path.join(data, ".agent-index-state.json"), '{"version":1,"snapshot":{},"daily":{}}')],
  ["an install that registered before install ids", (home: string) => {
    fs.mkdirSync(path.dirname(tokenPath(home)), { recursive: true });
    fs.writeFileSync(tokenPath(home), MINTED_KEY);      // the file this used to keep
  }],
] as [string, (home: string, data: string) => void][]) {
  test(`${start} names itself once, and is still that install after a recreation`, () =>
    withStandIns(async (s) => {
      // Every install that predates install ids shares ONE unnamed bucket on
      // the Index, so staying there would leave an owner's two old installs
      // overwriting each other permanently. Each claims an id. What none of
      // them may do is claim a DIFFERENT one each time it comes back.
      const one = volumeHome(s);
      seed(one.home, one.data);
      assert.equal((await clientAsync(["--register", "--agent", "purge-test"], one.home, one.env)).code, 0);
      const claimed = String(askedInstall(s));
      assert.match(claimed, /^[A-Za-z0-9_-]{8,64}$/);
      assert.deepEqual(stateOf(one.data), { install_id: claimed, key: MINTED_KEY },
        "the install and the key that reports for it, in one file");
      assert.equal(fs.statSync(stateFile(one.data)).mode & 0o777, 0o600, "not world-readable");

      // Recreated: same volume, brand new home, no token. Kept in the home the
      // id would be gone here, and this install would mint a second one and
      // strand every row it has written.
      const two = volumeHome(s, one.data);
      assert.equal((await clientAsync(["--register", "--agent", "purge-test"], two.home, two.env)).code, 0);
      assert.equal(askedInstall(s), claimed, "the same install, not a new one");
    }));
}

// State a file can be in that is not a state to carry on from. Each one used to
// have a quiet reading -- "this install has no id" -- and each quiet reading
// mints a second install and strands every row the first one wrote.
for (const [what, content] of [
  ["unparseable", "{not json at all"],
  ["holding an id it cannot use", JSON.stringify({ install_id: "not an id!!", key: MINTED_KEY })],
  ["holding an id and no key", JSON.stringify({ install_id: "install-abcdef01" })],
  ["holding a credential that is not ours", JSON.stringify({ install_id: "install-abcdef01", key: "gho_x" })],
]) {
  test(`a state file ${what} stops the run instead of quietly becoming a new install`, () =>
    withStandIns(async (s) => {
      const { home, data, env } = volumeHome(s);
      fs.mkdirSync(data, { recursive: true });
      fs.writeFileSync(stateFile(data), content);
      const r = await clientAsync(["--register", "--agent", "purge-test"], home, env);
      assert.notEqual(r.code, 0, "a state we cannot read is not a state we may register over");
      assert.match(r.out, new RegExp(stateFile(data).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
        "and says which file to look at");
      assert.equal(s.indexHits.filter((h) => h.path === "/v1/keys").length, 0, "nothing was minted");
    }));
}

test("a crash during a legacy re-registration leaves the old pair or the new one, never a mix", () =>
  withStandIns(async (s) => {
    // The install this is about: registered before ids existed, so it holds a
    // key and no id, and its rows are in the Index's unnamed bucket. Naming it
    // replaces BOTH -- and written as two files, a crash in between left the id
    // claiming a named install while the key on disk was still the unnamed one,
    // so every later report went to the old bucket while the file said
    // otherwise, and nothing on the next run could tell.
    const { home, data, env } = volumeHome(s);
    const OLD_KEY = "aik_" + "o".repeat(43);          // pragma: allowlist secret
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(stateFile(data), JSON.stringify({ key: OLD_KEY }));
    // A real store on the volume, so the reporting run below is the ordinary
    // path rather than a configured-and-missing failure.
    createEmptyHermesStore(data);

    // The crash: the write that replaces them dies after its temp file exists
    // and before the rename. That is the only window there is now, and what is
    // in the temp file is deliberately a mismatched pair.
    fs.writeFileSync(stateFile(data) + ".new",
      JSON.stringify({ install_id: "install-halfway", key: "aik_" + "n".repeat(43) })); // pragma: allowlist secret

    const before = stateOf(data);
    assert.deepEqual(before, { key: OLD_KEY }, "the old pair, untouched by a write that did not land");

    // The next run reads the state, not the wreckage beside it, and reports
    // with the key that is actually current.
    assert.equal((await clientAsync(["--agent", "purge-test"], home, env)).code, 0);
    assert.equal(s.indexHits.filter((h) => h.path.startsWith("/v1/usage")).at(-1)!.bearer,
      `Bearer ${OLD_KEY}`, "the key in the state file is the one that reports");

    // And when the replacement does land, it lands whole.
    assert.equal((await clientAsync(["--register", "--agent", "purge-test"], home, env)).code, 0);
    const after = stateOf(data);
    assert.match(String(after.install_id), /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(after.key, MINTED_KEY, "the id and the key that replaced it, together");
  }));

test("an install that predates the state file reports from where its key is, and upgrades when registered", () =>
  withStandIns(async (s) => {
    // Reads have no side effects: a report from a legacy install works off the
    // layout that shipped and changes nothing. Migrating underneath it bought
    // nothing and cost a whole-run lock, a cleanup retried on every load, and
    // a reader that wrote.
    const { home, data, env } = volumeHome(s);
    fs.mkdirSync(path.dirname(tokenPath(home)), { recursive: true });
    fs.writeFileSync(tokenPath(home), MINTED_KEY);
    createEmptyHermesStore(data);

    assert.equal((await clientAsync(["--agent", "purge-test"], home, env)).code, 0);
    assert.equal(s.indexHits.filter((h) => h.path.startsWith("/v1/usage")).at(-1)!.bearer,
      `Bearer ${MINTED_KEY}`, "it reports with the key it has");
    assert.ok(fs.existsSync(tokenPath(home)), "and nothing moved under it");
    assert.ok(!fs.existsSync(stateFile(data)));

    // Registering is the explicit upgrade, and the only one.
    assert.equal((await clientAsync(["--register", "--agent", "purge-test"], home, env)).code, 0);
    assert.match(String(stateOf(data).install_id), /^[A-Za-z0-9_-]{8,64}$/);
    assert.equal(stateOf(data).key, MINTED_KEY);
    assert.ok(!fs.existsSync(tokenPath(home)),
      "and the file the key used to live in is gone, now that this one holds it");
  }));

test("the install id does not move when a Hermes store appears later", () =>
  withStandIns(async (s) => {
    // Nobody says where Hermes lives, so the store is DISCOVERED: ~/.hermes
    // today, ~/.hermes-life the moment one appears there. Hang identity off
    // that discovery and the id is written under one and read from the other --
    // the install arrives at its next registration with no id, mints a second
    // one, and strands everything the first wrote.
    const home = homeWith();
    stubAgentsView(home, "echo '[]'");
    const env = { PLOW_AGENT_TOKEN: PLOW_TOKEN, PLOW_API_BASE: s.plow, AGENT_INDEX_API: s.index,
                  HERMES_HOME: undefined } as Record<string, string | undefined>;
    assert.equal((await clientAsync(["--register", "--agent", "purge-test"], home, env)).code, 0);
    const mine = String(askedInstall(s));

    createEmptyHermesStore(path.join(home, ".hermes-life"));

    assert.equal((await clientAsync(["--register", "--agent", "purge-test"], home, env)).code, 0);
    assert.equal(askedInstall(s), mine, "the store moved; the install did not");
  }));

test("two registrations at once agree on one install", async () => {
  // The mint holds the line, so the second registration is genuinely inside the
  // first. Unserialised, both read "no id", both generate their own, and their
  // renames interleave: the id file holds one process's install and the token
  // file the other process's key.
  const s = await standIns(400);
  try {
    const { home, data, env } = volumeHome(s);
    const both = await Promise.all([
      clientAsync(["--register", "--agent", "purge-test"], home, env),
      clientAsync(["--register", "--agent", "purge-test"], home, env),
    ]);
    for (const r of both) assert.equal(r.code, 0, r.out);
    const mints = s.indexHits.filter((h) => h.path === "/v1/keys")
      .map((h) => (h.body as { install_id?: string }).install_id);
    assert.equal(mints.length, 2);
    assert.equal(mints[0], mints[1], "the second reads the id the first wrote, and mints for that install");
    assert.equal(stateOf(data).install_id, mints[0], "which is the id on disk");
  } finally {
    await s.close();
  }
});
