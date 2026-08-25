// Removes one badge from a profile list (TOOLS / PROJECTS / COMMUNITIES).
//
// Why this exists as its own command rather than a setting in .env: the badge
// lists are additive on the server. `/api/usage` unions what you post into what
// it already stored, so shortening a line in .env — or blanking it — can never
// take an entry off your profile. Removal is a different verb, and the server
// has always had one: DELETE /api/user/:username/:field/:tag, authenticated
// with your own API key. Nothing here needs an admin.
//
// The asymmetry is worth knowing about: adding a badge is a side effect of a
// report you were making anyway, so a typo becomes a permanent extra chip. That
// makes this the tool you reach for after a misspelling, not a rare admin path.
//
// Removal is matched case-insensitively by the server, mirroring the merge —
// which dedupes on a lowercased tag but not a whitespace-stripped one, so
// "WisprFlow" and "Wispr Flow" are two separate badges and each needs its own
// removal.

import * as http from "node:http";
import * as https from "node:https";
import { errMessage } from "./errors";

export const TAG_FIELDS = ["tools", "projects", "communities"] as const;
type TagField = (typeof TAG_FIELDS)[number];

type UntagArgs =
  | { mode: "list" }
  | { mode: "remove"; field: TagField; tag: string };

const USAGE =
  'usage: npm run untag -- <tools|projects|communities> "<exact badge text>"\n' +
  "       npm run untag -- --list";

function isTagField(value: string): value is TagField {
  return (TAG_FIELDS as readonly string[]).includes(value);
}

// Parses the command line. Throws with the usage text on anything malformed:
// this is an interactive command, so a wrong invocation should say what the
// right one looks like rather than silently doing nothing.
export function parseUntagArgs(argv: readonly string[]): UntagArgs {
  const args = argv.filter((a) => a !== "");
  if (args.length === 1 && args[0] === "--list") {
    return { mode: "list" };
  }
  if (args.length !== 2) {
    throw new Error(USAGE);
  }
  const [field, rawTag] = args;
  if (!isTagField(field)) {
    throw new Error(`field must be one of: ${TAG_FIELDS.join(", ")}\n${USAGE}`);
  }
  const tag = rawTag.trim();
  if (!tag) {
    throw new Error(`badge text is empty\n${USAGE}`);
  }
  return { mode: "remove", field, tag };
}

// The tag travels as a URL path segment, which constrains what can be removed.
// A tag containing a slash cannot be addressed: percent-encoding it is not
// reliably preserved across the proxy in front of the API, so the request may
// route somewhere else entirely and report a cheerful no-op. Refusing here is
// honest — the alternative is telling someone their badge was removed when it
// wasn't.
//
// This is a reachable state, not a defensive guard: the reporter sends TOOLS
// verbatim, so putting "a/b" in .env creates a badge that this command then
// cannot take off again. Removal for those needs a request that carries the tag
// in the body rather than the path.
export function buildUntagUrl(
  serverUrl: string,
  username: string,
  field: TagField,
  tag: string,
): URL {
  if (tag.includes("/")) {
    throw new Error(
      `cannot remove a badge containing "/" — it can't be addressed as a URL path segment. Ask an admin to remove "${tag}" directly.`,
    );
  }
  const path =
    `/api/user/${encodeURIComponent(username)}` +
    `/${encodeURIComponent(field)}/${encodeURIComponent(tag)}`;
  return new URL(path, serverUrl);
}

// The profile read is served with `cache-control: public` and no `max-age`, so
// a plain GET can return a copy from before a removal that has already
// succeeded. That is the worst possible failure for this command: `--list` is
// how you CHECK a removal, so a stale read reports the badge still present and
// makes a working removal look like it did nothing. Observed for real — a list
// taken straight after five successful removals showed all five still present,
// while the same URL with a unique query param showed them gone.
//
// A unique parameter is what actually fixes it. `Cache-Control: no-cache` and
// `Pragma: no-cache` request headers were both tried against the live host and
// neither bypassed it; only varying the URL did.
export function buildListUrl(serverUrl: string, username: string, nonce: number): URL {
  const url = new URL(`/api/user/${encodeURIComponent(username)}`, serverUrl);
  url.searchParams.set("_", String(nonce));
  return url;
}

type UntagOutcome = { ok: boolean; message: string };

// Turns an HTTP response into something worth printing. Each status gets its
// own explanation because they fail for genuinely different reasons and the
// fixes are different — in particular a 404 here is far more likely to mean
// "this host doesn't route DELETE" than "no such user", since the public
// Builder Index host proxies GET and POST to the API but not DELETE.
export function describeUntagResult(
  status: number,
  body: string,
  ctx: { field: TagField; tag: string; host: string },
): UntagOutcome {
  let parsed: { ok?: boolean; removed?: boolean; error?: string } = {};
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    // Non-JSON body — a proxy error page rather than the API answering.
  }

  if (status === 200) {
    // `removed: false` is a successful request that matched nothing. Almost
    // always a spelling mismatch, and the list is the way to settle that.
    if (parsed.removed === false) {
      return {
        ok: false,
        message:
          `No badge matching "${ctx.tag}" in ${ctx.field} — nothing was removed.\n` +
          `Matching ignores case but not spacing, so "WisprFlow" will not match "Wispr Flow".\n` +
          `Run: npm run untag -- --list`,
      };
    }
    return { ok: true, message: `Removed "${ctx.tag}" from ${ctx.field}.` };
  }

  if (status === 401 || status === 403) {
    return {
      ok: false,
      message:
        `${status} — the server rejected your API key for this username.\n` +
        `Check USERNAME and API_KEY in .env; the key must be the one issued for that username.`,
    };
  }

  if (status === 404) {
    return {
      ok: false,
      message:
        `404 from ${ctx.host} — this host does not route DELETE to the API.\n` +
        `The public Builder Index host proxies GET and POST but drops DELETE, so removal has to go\n` +
        `to the API host directly. Set SERVER_URL in .env to the API host and try again.`,
    };
  }

  return {
    ok: false,
    message: `Server returned ${status}: ${parsed.error || body || "(empty body)"}`,
  };
}

type HttpResult = { status: number; body: string };

function request(url: URL, options: http.RequestOptions): Promise<HttpResult> {
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

// The stored lists, as the server has them. Printed before a removal is worth
// doing because the exact text has to match: what you set in .env is not
// necessarily what is stored, since every machine that ever reported has been
// unioned into it.
export function formatStoredTags(body: string): string {
  const profile = JSON.parse(body) as Record<string, unknown>;
  const lines: string[] = [];
  for (const field of TAG_FIELDS) {
    const raw = String(profile[field] || "");
    const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
    lines.push(`${field} (${tags.length}):`);
    for (const tag of tags) lines.push(`  ${tag}`);
    if (tags.length === 0) lines.push("  (none)");
  }
  return lines.join("\n");
}

// Config is read inside main() rather than at module scope so importing this
// file for its pure helpers — which is what the tests do — never touches .env.
async function main(): Promise<void> {
  const path = await import("node:path");
  const dotenv = await import("dotenv");
  // After build this file is dist/reporter/untag.js, so the repo is two up.
  const projectRoot = path.resolve(__dirname, "..", "..");
  const envFile = dotenv.config({ path: path.join(projectRoot, ".env") }).parsed || {};

  const username = process.env.TKMX_USERNAME || envFile.USERNAME;
  const apiKey = process.env.API_KEY;
  // Same default as the reporter: removal has to reach the API host, which is
  // not the human-facing Builder Index host.
  const serverUrl = process.env.SERVER_URL || "https://tokenmaxxing.odio.dev";

  if (!username || !apiKey) {
    console.error("USERNAME and API_KEY must be set in .env");
    process.exit(1);
  }

  const args = parseUntagArgs(process.argv.slice(2));

  if (args.mode === "list") {
    const url = buildListUrl(serverUrl, username, Date.now());
    const { status, body } = await request(url, { method: "GET" });
    if (status !== 200) {
      console.error(`Server returned ${status}: ${body}`);
      process.exit(1);
    }
    console.log(formatStoredTags(body));
    return;
  }

  const url = buildUntagUrl(serverUrl, username, args.field, args.tag);
  const { status, body } = await request(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const outcome = describeUntagResult(status, body, {
    field: args.field,
    tag: args.tag,
    host: url.host,
  });
  console.log(outcome.message);
  if (!outcome.ok) process.exit(1);
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(errMessage(err));
    process.exit(1);
  });
}
