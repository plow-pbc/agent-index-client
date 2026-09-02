import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const CLIENT = path.join(__dirname, "..", "..", "standalone", "agent_index_client.py");

test("the standalone client's own --self-check passes", () => {
  // It carries the spec for the delta collector -- what a first run may place,
  // what it must never invent -- and nothing in `npm test` ran it, so a change
  // that broke those assertions still went green here. It runs offline.
  const out = execFileSync("python3", [CLIENT, "--self-check"], { encoding: "utf8" });
  assert.match(out, /self-check OK/);
});
