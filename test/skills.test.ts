import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { collectClaudeSkills, applyExclusions, dedupeSkills } from "../reporter/skills";

// Builds a personal-skills directory: each entry becomes <dir>/<name>/, and only
// the ones listed in withSkillMd get a SKILL.md — the marker that makes a folder
// an actual skill rather than a stray directory.
function makeSkillsDir(root: string, names: string[], withSkillMd: string[]): string {
  const dir = path.join(root, "skills");
  fs.rmSync(dir, { recursive: true, force: true });
  for (const name of names) {
    fs.mkdirSync(path.join(dir, name), { recursive: true });
    if (withSkillMd.includes(name)) {
      fs.writeFileSync(path.join(dir, name, "SKILL.md"), "---\nname: " + name + "\n---\n");
    }
  }
  return dir;
}

describe("collectClaudeSkills", () => {
  let tmpDir;
  let manifestPath;
  // These cases cover the plugin manifest only. Without an explicit skills
  // directory the default is the real ~/.claude/skills, which would make the
  // results depend on whatever the developer running the suite has installed.
  let noSkillsDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-skills-"));
    manifestPath = path.join(tmpDir, "installed_plugins.json");
    noSkillsDir = path.join(tmpDir, "absent-skills-dir");
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    if (fs.existsSync(manifestPath)) fs.unlinkSync(manifestPath);
  });

  it("returns [] when the manifest file is missing", () => {
    assert.deepEqual(collectClaudeSkills(manifestPath, noSkillsDir), []);
  });

  it("returns [] when the manifest is malformed JSON", () => {
    fs.writeFileSync(manifestPath, "{ not valid json");
    assert.deepEqual(collectClaudeSkills(manifestPath, noSkillsDir), []);
  });

  it("returns [] when the manifest has no plugins field", () => {
    fs.writeFileSync(manifestPath, JSON.stringify({}));
    assert.deepEqual(collectClaudeSkills(manifestPath, noSkillsDir), []);
  });

  it("extracts plugin names and strips the @marketplace suffix", () => {
    fs.writeFileSync(manifestPath, JSON.stringify({
      plugins: {
        "superpowers@claude-plugins-official": {},
        "swift-lsp@claude-plugins-official": {},
      },
    }));
    assert.deepEqual(collectClaudeSkills(manifestPath, noSkillsDir), ["superpowers", "swift-lsp"]);
  });

  it("returns results sorted alphabetically for a stable config hash", () => {
    fs.writeFileSync(manifestPath, JSON.stringify({
      plugins: {
        "zebra@marketplace": {},
        "alpha@marketplace": {},
        "mango@marketplace": {},
      },
    }));
    assert.deepEqual(collectClaudeSkills(manifestPath, noSkillsDir), ["alpha", "mango", "zebra"]);
  });

  it("deduplicates plugins with the same name from different marketplaces", () => {
    fs.writeFileSync(manifestPath, JSON.stringify({
      plugins: {
        "superpowers@official": {},
        "superpowers@fork": {},
      },
    }));
    assert.deepEqual(collectClaudeSkills(manifestPath, noSkillsDir), ["superpowers"]);
  });
});

describe("collectClaudeSkills — personal skills directory", () => {
  let tmpDir;
  let manifestPath;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-personal-"));
    manifestPath = path.join(tmpDir, "installed_plugins.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ plugins: { "superpowers@official": {} } }));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports a directory only when it contains SKILL.md", () => {
    const dir = makeSkillsDir(tmpDir, ["roborev", "babysit-pr", "not-a-skill"], ["roborev", "babysit-pr"]);
    assert.deepEqual(collectClaudeSkills(manifestPath, dir), ["babysit-pr", "roborev", "superpowers"]);
  });

  it("merges personal skills with plugins, sorted and deduplicated", () => {
    // "superpowers" exists as both a plugin and a personal skill; it must appear once.
    const dir = makeSkillsDir(tmpDir, ["zebra", "superpowers", "alpha"], ["zebra", "superpowers", "alpha"]);
    assert.deepEqual(collectClaudeSkills(manifestPath, dir), ["alpha", "superpowers", "zebra"]);
  });

  it("returns the plugin list unchanged when the skills directory is missing", () => {
    const missing = path.join(tmpDir, "no-such-dir");
    assert.deepEqual(collectClaudeSkills(manifestPath, missing), ["superpowers"]);
  });

  it("ignores loose files sitting alongside the skill directories", () => {
    const dir = makeSkillsDir(tmpDir, ["roborev"], ["roborev"]);
    fs.writeFileSync(path.join(dir, "README.md"), "not a skill");
    assert.deepEqual(collectClaudeSkills(manifestPath, dir), ["roborev", "superpowers"]);
  });

  it("still returns personal skills when the plugin manifest is missing", () => {
    const dir = makeSkillsDir(tmpDir, ["roborev"], ["roborev"]);
    assert.deepEqual(collectClaudeSkills(path.join(tmpDir, "gone.json"), dir), ["roborev"]);
  });

  // Skills are commonly symlinked in from a shared repo rather than copied.
  // Dirent.isDirectory() is false for a symlink, so checking it directly skips
  // every linked skill — on a real machine that silently hid 10 of 13.
  it("follows symlinked skill directories", () => {
    const dir = makeSkillsDir(tmpDir, ["roborev"], ["roborev"]);
    const target = path.join(tmpDir, "elsewhere", "clerk-orgs");
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, "SKILL.md"), "---\nname: clerk-orgs\n---\n");
    fs.symlinkSync(target, path.join(dir, "clerk-orgs"));

    assert.deepEqual(collectClaudeSkills(manifestPath, dir), ["clerk-orgs", "roborev", "superpowers"]);
  });

  it("ignores a broken symlink instead of throwing", () => {
    const dir = makeSkillsDir(tmpDir, ["roborev"], ["roborev"]);
    fs.symlinkSync(path.join(tmpDir, "does-not-exist"), path.join(dir, "dangling"));

    assert.deepEqual(collectClaudeSkills(manifestPath, dir), ["roborev", "superpowers"]);
  });
});

describe("dedupeSkills", () => {
  // Exclusion matching is case-insensitive, so merging must be too. A
  // case-sensitive Set would let "Superpowers" and "superpowers" both through,
  // and near-duplicates render as two separate chips on a profile.
  it("treats names differing only in case as one entry", () => {
    assert.deepEqual(dedupeSkills(["Superpowers", "superpowers"]), ["Superpowers"]);
  });

  it("keeps the first spelling it saw", () => {
    assert.deepEqual(dedupeSkills(["linear", "Linear"]), ["linear"]);
    assert.deepEqual(dedupeSkills(["Linear", "linear"]), ["Linear"]);
  });

  // Deliberately a capital that must sort BEFORE an earlier lowercase letter.
  // All-lowercase inputs order identically under the default comparator and
  // under localeCompare, so they cannot tell the two apart — and the comparator
  // is the point: this order feeds the config hash that gates reporting, and a
  // locale-aware one collates differently between the interactive and launchd
  // environments, flipping the hash on alternating runs.
  it("sorts by code unit, not locale, for a stable config hash", () => {
    assert.deepEqual(dedupeSkills(["alpha", "Zebra"]), ["Zebra", "alpha"]);
  });

  it("drops empty and whitespace-only names", () => {
    assert.deepEqual(dedupeSkills(["roborev", "", "   "]), ["roborev"]);
  });
});

describe("collectClaudeSkills — case-insensitive merge across sources", () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-case-"));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not report a plugin and a personal skill that differ only in case", () => {
    const manifestPath = path.join(tmpDir, "installed_plugins.json");
    fs.writeFileSync(manifestPath, JSON.stringify({ plugins: { "Superpowers@official": {} } }));
    const dir = makeSkillsDir(tmpDir, ["superpowers"], ["superpowers"]);

    assert.deepEqual(collectClaudeSkills(manifestPath, dir), ["Superpowers"]);
  });
});

describe("applyExclusions", () => {
  const exclusionCases = [
    { name: "removes excluded names regardless of which source produced them",
      names: ["roborev", "superpowers", "warp"], exclude: "warp", expected: ["roborev", "superpowers"] },
    { name: "matches a differently-cased entry",
      names: ["Warp", "roborev"], exclude: "warp", expected: ["roborev"] },
    { name: "matches a differently-cased exclusion",
      names: ["warp", "roborev"], exclude: "WARP", expected: ["roborev"] },
    { name: "tolerates whitespace around entries",
      names: ["warp", "vercel", "roborev"], exclude: " warp , vercel ", expected: ["roborev"] },
    { name: "excludes nothing when unset",
      names: ["warp", "roborev"], exclude: undefined, expected: ["warp", "roborev"] },
    { name: "excludes nothing when empty",
      names: ["warp", "roborev"], exclude: "", expected: ["warp", "roborev"] },
    { name: "excludes nothing when whitespace only",
      names: ["warp", "roborev"], exclude: "   ", expected: ["warp", "roborev"] },
    { name: "ignores empty entries produced by stray commas",
      names: ["warp", "roborev"], exclude: "warp,,", expected: ["roborev"] },
    { name: "preserves the incoming order of the survivors",
      names: ["a", "b", "c"], exclude: "b", expected: ["a", "c"] },
  ];

  for (const { name, names, exclude, expected } of exclusionCases) {
    it(name, () => {
      assert.deepEqual(applyExclusions(names, exclude), expected);
    });
  }
});
