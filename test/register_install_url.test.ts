import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { standIns, PLOW_TOKEN } from "./fake-plow-index";

// The standalone client is the copy that ships inside a container, so this
// drives the real script rather than a re-implementation of it.
const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");

/** One registration against the stand-ins, in a throwaway HOME -- `just test`
 *  inherits the developer's real one, and a run must not touch a credential on
 *  their machine. Async because the stand-ins live in THIS process. */
function register(args: string[], s: { plow: string; index: string }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aic-install-url-"));
  const env = {
    ...process.env, HOME: home,
    PLOW_AGENT_TOKEN: PLOW_TOKEN, PLOW_API_BASE: s.plow, AGENT_INDEX_API: s.index,
  };
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn("python3", [CLIENT, "--register", "--agent", "domo", ...args], { env });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 30000);
    child.on("close", (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });
}

const sent = (s: { indexHits: { path: string; body?: unknown }[] }) =>
  s.indexHits.find((h) => h.path === "/v1/agents")?.body as Record<string, unknown>;

test("--install-url reaches the Index with the registration", async () => {
  const s = await standIns();
  try {
    const r = await register(["--name", "Domo", "--install-url", "https://example.com/how-to-install"], s);
    assert.equal(r.code, 0, r.out);
    assert.equal(sent(s).install_url, "https://example.com/how-to-install");
  } finally { await s.close(); }
});

test("an empty --install-url is SENT, because that is how a bad link comes off the page", async () => {
  // Every other field is dropped when empty, and this one may not be: the
  // server reads "" as a clear and an absent field as "leave what is on record
  // alone", so filtering it out would leave a publisher no way to remove a
  // link anyone can read.
  const s = await standIns();
  try {
    const r = await register(["--install-url", ""], s);
    assert.equal(r.code, 0, r.out);
    assert.equal(sent(s).install_url, "");
  } finally { await s.close(); }
});

test("registering without the flag says nothing about the link", async () => {
  const s = await standIns();
  try {
    const r = await register(["--name", "Domo"], s);
    assert.equal(r.code, 0, r.out);
    assert.ok(!("install_url" in sent(s)),
      "an omitted flag must not clear a tutorial the owner set earlier");
  } finally { await s.close(); }
});
