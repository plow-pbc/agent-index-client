import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PLUGINS_ROOT = path.join(os.homedir(), ".claude", "plugins");

// A skill chip on the profile is a bare name — "superpowers", "herder", "warp".
// That is enough to render text and not enough to render a link, which is why
// the Builder Index shows every one of them as inert. This module answers the
// one question the server cannot answer for itself: does this name have a
// canonical public home, and if so where?
//
// Only names that came from a plugin marketplace can be answered. Personal
// skills (~/.claude/skills/<name>/) and MCP server names carry no upstream, and
// a name typed into TOOLS by hand carries less than that. Those simply do not
// appear in the returned map — absence is the signal the server styles as
// "unlinkable", so a chip is never rendered as a link to nowhere.

interface MarketplaceEntrySource {
  url?: string;
  path?: string;
  ref?: string;
}

interface MarketplaceEntry {
  name?: string;
  // Either a {url, path, ref} object or a repo-relative string like
  // "./plugins/gopls-lsp". Both spellings appear in the same manifest.
  source?: MarketplaceEntrySource | string;
  homepage?: string | null;
}

interface KnownMarketplace {
  source?: { source?: string; repo?: string };
}

// Everything published here lands on a public profile page, so a URL is emitted
// only when it is unambiguously a public web address. A marketplace installed
// from a local checkout yields file paths and `git@host:owner/repo` remotes;
// publishing either would leak a home directory or an internal host onto the
// public Builder Index. Anything that is not https with a real hostname is
// dropped rather than cleaned up — a skipped link costs a chip its underline,
// a leaked one cannot be taken back.
export function normalizeRepoUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  if (!parsed.hostname || !parsed.hostname.includes(".")) return null;
  // A hostname that resolves only on this machine is not a canonical home.
  if (/(^|\.)localhost$/i.test(parsed.hostname)) return null;

  // Clone URLs are stored with the .git suffix ("https://github.com/obra/
  // superpowers.git"); a browser wants the same URL without it.
  parsed.pathname = parsed.pathname.replace(/\.git$/, "");
  return parsed.toString().replace(/\/$/, "");
}

// Joins a repo URL to a subdirectory the way a code host expects. `ref` is the
// tag or branch the plugin was pinned to; HEAD is the honest fallback when the
// manifest does not say, since it follows the repo's default branch.
function subdirUrl(repoUrl: string, subPath: string | undefined, ref: string | undefined): string {
  if (!subPath) return repoUrl;
  const cleanPath = subPath.replace(/^\.?\//, "").replace(/\/$/, "");
  if (cleanPath.length === 0) return repoUrl;
  return `${repoUrl}/tree/${ref || "HEAD"}/${cleanPath}`;
}

// Resolves one marketplace entry to its best public URL, preferring what the
// author nominated over what we can infer.
//
//   1. homepage      — the author's own answer to "where does this live?"
//   2. source.url    — the upstream repo, plus the subdirectory when the plugin
//                      is one of many in it
//   3. a relative source ("./plugins/x") against the marketplace's own repo
//
// A marketplace whose repo we know but whose entry we do not is still worth a
// link to the marketplace itself, which is handled by the caller.
export function resolveEntryUrl(
  entry: MarketplaceEntry | undefined,
  marketplaceRepoUrl: string | null,
): string | null {
  if (entry) {
    const homepage = normalizeRepoUrl(entry.homepage);
    if (homepage) return homepage;

    if (typeof entry.source === "string") {
      if (marketplaceRepoUrl) return subdirUrl(marketplaceRepoUrl, entry.source, "HEAD");
    } else if (entry.source) {
      const repo = normalizeRepoUrl(entry.source.url);
      if (repo) return subdirUrl(repo, entry.source.path, entry.source.ref);
    }
  }
  return marketplaceRepoUrl;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    // A marketplace that is registered but not yet fetched has no manifest on
    // disk. That costs its plugins a deep link, not the whole report.
    return null;
  }
}

// Builds name -> canonical URL for every installed plugin. The installed-plugins
// manifest is the only source that ties a chip name to the marketplace it came
// from: its keys are "superpowers@claude-plugins-official", and the part after
// the @ is exactly what the reported skill list throws away.
export function collectSkillLinks(pluginsRoot: string = DEFAULT_PLUGINS_ROOT): Record<string, string> {
  const installed = readJson<{ plugins?: Record<string, unknown> }>(
    path.join(pluginsRoot, "installed_plugins.json"),
  );
  if (!installed?.plugins) return {};

  const known = readJson<Record<string, KnownMarketplace>>(
    path.join(pluginsRoot, "known_marketplaces.json"),
  ) || {};

  // One manifest read per marketplace, not one per plugin: a marketplace
  // manifest holds hundreds of entries and the official one is ~300.
  const entriesByMarketplace = new Map<string, Map<string, MarketplaceEntry>>();
  function entriesFor(marketplace: string): Map<string, MarketplaceEntry> {
    const cached = entriesByMarketplace.get(marketplace);
    if (cached) return cached;
    const manifest = readJson<{ plugins?: MarketplaceEntry[] }>(
      path.join(pluginsRoot, "marketplaces", marketplace, ".claude-plugin", "marketplace.json"),
    );
    const byName = new Map<string, MarketplaceEntry>();
    for (const entry of manifest?.plugins || []) {
      if (entry?.name) byName.set(entry.name, entry);
    }
    entriesByMarketplace.set(marketplace, byName);
    return byName;
  }

  const links: Record<string, string> = {};
  for (const pluginKey of Object.keys(installed.plugins)) {
    // Mirrors the split in skills.ts so the keys here line up with the names in
    // claude_skills. A key with no @ has no marketplace to look up.
    const atIndex = pluginKey.indexOf("@");
    if (atIndex <= 0) continue;
    const name = pluginKey.slice(0, atIndex);
    const marketplace = pluginKey.slice(atIndex + 1);

    const repo = known[marketplace]?.source?.repo;
    const marketplaceRepoUrl = repo ? normalizeRepoUrl(`https://github.com/${repo}`) : null;

    const url = resolveEntryUrl(entriesFor(marketplace).get(name), marketplaceRepoUrl);
    if (url) links[name] = url;
  }
  return links;
}

// Narrows the link map to the names actually being reported. The skill list is
// filtered by SKILLS_EXCLUDE and deduped case-insensitively before it is sent,
// and a link for a name the user deliberately withheld must not ride along in
// its place.
export function linksForReportedSkills(
  links: Record<string, string>,
  reportedNames: string[],
): Record<string, string> {
  const byLowerName = new Map<string, string>();
  for (const [name, url] of Object.entries(links)) byLowerName.set(name.toLowerCase(), url);

  const scoped: Record<string, string> = {};
  // Keyed by the reported spelling, so the server can look a chip up by the
  // exact string it renders.
  for (const reported of reportedNames) {
    const url = byLowerName.get(reported.trim().toLowerCase());
    if (url) scoped[reported] = url;
  }
  return scoped;
}
