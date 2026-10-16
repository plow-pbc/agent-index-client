import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const REPO_ROOT = path.join(__dirname, "..", "..");

// A single `.env*` rule covers `.env` itself and every backup spelling of it.
// This repo is public, so an untracked `.env*` holding a live API_KEY is one
// `git add -A` away from publishing a credential. The list below tests real
// `git check-ignore` behaviour rather than matching literal .gitignore lines,
// so reformatting the file cannot silently drop the guarantee.
const MUST_BE_IGNORED = [
  ".env",
  ".env.bak-20260724",
  ".env.bak-concierge-20260806-021701",
  // Hand-rolled backups don't follow one convention, so cover the class.
  ".env.bak",
  ".env.backup",
  ".env.old",
  ".env.2",
  ".env.save",
];

// `git check-ignore` exits 0 when the path is ignored, 1 when it is not. It is
// index-aware: a *tracked* path is reported as not-ignored regardless of the
// rules, so a backup that somehow got staged trips the alarm.
function checkIgnore(relativePath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", relativePath], { cwd: REPO_ROOT, stdio: "ignore" });
    return true;
  } catch (err) {
    // Exit 1 is the real answer "not ignored". Anything else is git failing
    // (128 when there's no work tree, for instance); that is not an answer.
    if ((err as { status?: number }).status !== 1) throw err;
    return false;
  }
}

test("backups of .env are git-ignored so a credential can't be committed", () => {
  for (const candidate of MUST_BE_IGNORED) {
    assert.ok(
      checkIgnore(candidate),
      `${candidate} must be git-ignored — it contains a live API_KEY and this repo is public`,
    );
  }
});
