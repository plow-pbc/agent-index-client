import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  collectSkillLinks,
  linksForReportedSkills,
  normalizeRepoUrl,
  resolveEntryUrl,
} from "../reporter/skill-links";

// Lays out the three files collectSkillLinks reads, in the same shape
// ~/.claude/plugins has them: which plugins are installed, which marketplaces
// are known and what repo each is, and each marketplace's own plugin manifest.
function writePluginsRoot(
  root: string,
  installed: Record<string, unknown>,
  known: Record<string, unknown>,
  manifests: Record<string, unknown[]>,
): string {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "installed_plugins.json"), JSON.stringify({ plugins: installed }));
  fs.writeFileSync(path.join(root, "known_marketplaces.json"), JSON.stringify(known));
  for (const [marketplace, plugins] of Object.entries(manifests)) {
    const dir = path.join(root, "marketplaces", marketplace, ".claude-plugin");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "marketplace.json"), JSON.stringify({ plugins }));
  }
  return root;
}

const OFFICIAL = { "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" } } };

describe("normalizeRepoUrl", () => {
  it("strips the .git suffix a clone URL carries", () => {
    assert.equal(
      normalizeRepoUrl("https://github.com/obra/superpowers.git"),
      "https://github.com/obra/superpowers",
    );
  });

  it("keeps a plain https homepage as-is", () => {
    assert.equal(normalizeRepoUrl("https://42crunch.com"), "https://42crunch.com");
  });

  // The whole point of the allowlist: these would each publish something
  // private or unreachable onto a public profile page.
  it("drops a local filesystem path", () => {
    assert.equal(normalizeRepoUrl("file:///Users/someone/dev/my-marketplace"), null);
  });

  it("drops an scp-style git remote", () => {
    assert.equal(normalizeRepoUrl("git@github.com:someone/private-plugins.git"), null);
  });

  it("drops plain http rather than upgrading it", () => {
    assert.equal(normalizeRepoUrl("http://github.com/obra/superpowers"), null);
  });

  it("drops localhost", () => {
    assert.equal(normalizeRepoUrl("https://localhost:8080/plugins"), null);
  });

  it("drops empty and missing input", () => {
    assert.equal(normalizeRepoUrl(""), null);
    assert.equal(normalizeRepoUrl(null), null);
    assert.equal(normalizeRepoUrl(undefined), null);
  });
});

describe("resolveEntryUrl", () => {
  it("prefers the author's homepage over the source repo", () => {
    const url = resolveEntryUrl(
      { name: "x", homepage: "https://42crunch.com", source: { url: "https://github.com/o/r.git" } },
      "https://github.com/anthropics/claude-plugins-official",
    );
    assert.equal(url, "https://42crunch.com");
  });

  it("deep-links into the subdirectory for a git-subdir plugin", () => {
    const url = resolveEntryUrl(
      { name: "x", source: { url: "https://github.com/adobe/skills.git", path: "plugins/creative-cloud/x", ref: "main" } },
      null,
    );
    assert.equal(url, "https://github.com/adobe/skills/tree/main/plugins/creative-cloud/x");
  });

  it("falls back to HEAD when the entry pins no ref", () => {
    const url = resolveEntryUrl(
      { name: "x", source: { url: "https://github.com/adobe/skills.git", path: "plugins/x" } },
      null,
    );
    assert.equal(url, "https://github.com/adobe/skills/tree/HEAD/plugins/x");
  });

  // gopls-lsp is the real shape here: homepage null, source a repo-relative
  // string that only means something against the marketplace's own repo.
  it("resolves a repo-relative source against the marketplace repo", () => {
    const url = resolveEntryUrl(
      { name: "gopls-lsp", homepage: null, source: "./plugins/gopls-lsp" },
      "https://github.com/anthropics/claude-plugins-official",
    );
    assert.equal(
      url,
      "https://github.com/anthropics/claude-plugins-official/tree/HEAD/plugins/gopls-lsp",
    );
  });

  it("falls back to the marketplace repo for an entry it cannot find", () => {
    assert.equal(
      resolveEntryUrl(undefined, "https://github.com/anthropics/claude-plugins-official"),
      "https://github.com/anthropics/claude-plugins-official",
    );
  });

  it("returns null when there is nothing public to point at", () => {
    assert.equal(resolveEntryUrl(undefined, null), null);
    assert.equal(resolveEntryUrl({ name: "x", homepage: "file:///tmp/x" }, null), null);
  });
});

describe("collectSkillLinks", () => {
  let root: string;

  before(() => {
    root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "tkmx-links-")), "plugins");
  });

  after(() => {
    fs.rmSync(path.dirname(root), { recursive: true, force: true });
  });

  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("returns {} when there is no plugins directory at all", () => {
    assert.deepEqual(collectSkillLinks(path.join(root, "absent")), {});
  });

  it("returns {} when the installed-plugins manifest is malformed", () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "installed_plugins.json"), "{not json");
    assert.deepEqual(collectSkillLinks(root), {});
  });

  it("maps an installed plugin to its homepage", () => {
    writePluginsRoot(
      root,
      { "superpowers@claude-plugins-official": [{ scope: "user" }] },
      OFFICIAL,
      { "claude-plugins-official": [{ name: "superpowers", homepage: "https://github.com/obra/superpowers.git" }] },
    );
    assert.deepEqual(collectSkillLinks(root), {
      superpowers: "https://github.com/obra/superpowers",
    });
  });

  // A marketplace registered but never fetched has no manifest on disk. Its
  // plugins should still reach the marketplace rather than going unlinkable.
  it("falls back to the marketplace repo when the manifest is absent", () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(
      path.join(root, "installed_plugins.json"),
      JSON.stringify({ plugins: { "gopls-lsp@claude-plugins-official": [{}] } }),
    );
    fs.writeFileSync(path.join(root, "known_marketplaces.json"), JSON.stringify(OFFICIAL));
    assert.deepEqual(collectSkillLinks(root), {
      "gopls-lsp": "https://github.com/anthropics/claude-plugins-official",
    });
  });

  it("omits a plugin from an unknown marketplace rather than guessing", () => {
    writePluginsRoot(root, { "mystery@somewhere-else": [{}] }, OFFICIAL, {});
    assert.deepEqual(collectSkillLinks(root), {});
  });

  it("omits a marketplace installed from a local checkout", () => {
    writePluginsRoot(
      root,
      { "internal-thing@local-mp": [{}] },
      { "local-mp": { source: { source: "directory" } } },
      { "local-mp": [{ name: "internal-thing", homepage: "file:///Users/someone/mp" }] },
    );
    assert.deepEqual(collectSkillLinks(root), {});
  });

  it("reads each marketplace manifest once across many plugins", () => {
    writePluginsRoot(
      root,
      { "a@claude-plugins-official": [{}], "b@claude-plugins-official": [{}] },
      OFFICIAL,
      {
        "claude-plugins-official": [
          { name: "a", source: "./plugins/a" },
          { name: "b", homepage: "https://example.com/b" },
        ],
      },
    );
    assert.deepEqual(collectSkillLinks(root), {
      a: "https://github.com/anthropics/claude-plugins-official/tree/HEAD/plugins/a",
      b: "https://example.com/b",
    });
  });
});

describe("linksForReportedSkills", () => {
  const links = { superpowers: "https://github.com/obra/superpowers" };

  it("keeps a link whose name is being reported", () => {
    assert.deepEqual(linksForReportedSkills(links, ["superpowers", "herder"]), {
      superpowers: "https://github.com/obra/superpowers",
    });
  });

  // The reported list is deduped case-insensitively, so the spelling that
  // survives is not always the plugin manifest's. The chip still needs its link.
  it("matches case-insensitively but keys by the reported spelling", () => {
    assert.deepEqual(linksForReportedSkills(links, ["Superpowers"]), {
      Superpowers: "https://github.com/obra/superpowers",
    });
  });

  // SKILLS_EXCLUDE is the user saying "do not publish this". A link is just as
  // published as the name, so it has to be dropped with it.
  it("drops a link for a name the user excluded", () => {
    assert.deepEqual(linksForReportedSkills(links, ["herder"]), {});
  });

  it("returns {} for an entry with no resolvable target", () => {
    assert.deepEqual(linksForReportedSkills({}, ["herder", "superconductor"]), {});
  });
});
