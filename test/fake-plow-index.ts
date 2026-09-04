import * as http from "node:http";
import type { AddressInfo } from "node:net";

// Stand-ins for the two servers the credential flow talks to. They exist to
// prove WHICH credential reached WHICH host: the whole point of the flow is
// that the Plow token buys an assertion and then stays home, and that is only
// observable from the far end.

/** The credential a Plow container is born with. */
export const PLOW_TOKEN = "plow-token-for-this-container";   // pragma: allowlist secret
/** What Plow hands back: short-lived, and the only thing the Index is shown. */
export const ASSERTION = "plow_index_" + "a".repeat(40);     // pragma: allowlist secret
/** What the Index mints in exchange, and every later report carries. */
export const MINTED_KEY = "aik_" + "m".repeat(43);           // pragma: allowlist secret
/** The unnamed install: what a key gets when its holder did not say which
 *  install it is. The real Index stores '' and keeps that key on the rows an
 *  install with no id of its own has always written. */
const UNNAMED_INSTALL = "";

export type Hit = { method: string; path: string; bearer: string; body?: unknown };

function bearerOf(req: http.IncomingMessage): string {
  return String(req.headers["authorization"] || "");
}

/** What the caller SENT, so a hit can be checked for content and not only for
 *  which credential carried it. A body that will not parse throws HERE: the
 *  client serialises every one of these, so unparseable is a transport failure,
 *  and swallowing it would surface as a puzzling assertion much further away. */
async function bodyOf(req: http.IncomingMessage): Promise<unknown> {
  const raw = await new Promise<string>((r) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b));
  });
  return raw ? JSON.parse(raw) : undefined;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function listen(handler: http.RequestListener) {
  const server = http.createServer(handler);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${port}` };
}

export type StandIns = {
  plow: string;
  index: string;
  plowHits: Hit[];
  indexHits: Hit[];
  /** Everything the INDEX was shown, for "was the token ever seen there" checks.
   *  Scoped to the Index on purpose: the Plow token appearing in the Plow
   *  server's own log is the flow working, not the leak. */
  indexSaw(): string;
  close(): Promise<void>;
};

/**
 * A fake Plow and a fake Index, wired to the flow the CEO signed off on.
 *
 * Both REFUSE the wrong credential rather than accepting anything, because a
 * permissive stand-in turns the bug this flow exists to prevent -- the Plow
 * token travelling to the Index -- into a green test.
 */
export async function standIns(
  mintDelayMs = 0,
  { echoInstall = true }: { echoInstall?: boolean } = {},
): Promise<StandIns> {
  const plowHits: Hit[] = [];
  const indexHits: Hit[] = [];

  const plow = await listen((req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname;
    plowHits.push({ method: req.method || "", path, bearer: bearerOf(req) });
    // The route the client asks for, with or without the /assertion suffix --
    // a rename must not turn this into a 404 that reads as a different failure.
    if (!path.startsWith("/v1/auth/index-identity")) return json(res, 404, {});
    if (bearerOf(req) !== `Bearer ${PLOW_TOKEN}`) return json(res, 401, {});
    json(res, 200, { assertion: ASSERTION });
  });

  const index = await listen(async (req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname;
    const bearer = bearerOf(req);
    const body = await bodyOf(req);
    indexHits.push({ method: req.method || "", path, bearer, body });
    // Registration and minting are the assertion's job, and ONLY the
    // assertion's: a Plow token here is the leak, so it is a 401.
    if (path === "/v1/agents" || path === "/v1/keys") {
      if (bearer !== `Bearer ${ASSERTION}`) {
        return json(res, 401, { error: "the Index takes an assertion, not a Plow token" });
      }
      // Store what you are told, and nothing if you are told nothing -- the
      // Index generates no id of its own, so a stand-in that invented one
      // would hide a client that stopped sending its install.
      const asked = String((body as { install_id?: unknown } | undefined)?.install_id || UNNAMED_INSTALL);
      if (path !== "/v1/keys") {
        return json(res, 200, { result: "registered", url: "https://agents.plow.co/purge-test" });
      }
      // A mint that holds the line, so a second registration is INSIDE the
      // first one's while it runs. Without it two processes started together
      // can still finish one after the other, and a test for what happens when
      // they overlap would pass without them ever overlapping.
      // An Index that predates install ids answers with the key alone.
      const minted = echoInstall ? { key: MINTED_KEY, install_id: asked } : { key: MINTED_KEY };
      return setTimeout(() => json(res, 200, minted), mintDelayMs);
    }
    // Everything else is reporting, which may use the minted key and nothing else.
    if (bearer !== `Bearer ${MINTED_KEY}`) {
      return json(res, 401, { error: "reports take the minted key" });
    }
    json(res, 200, { ok: true });
  });

  return {
    plow: plow.origin,
    index: index.origin,
    plowHits,
    indexHits,
    indexSaw: () => JSON.stringify(indexHits),
    close: async () => {
      await new Promise<void>((r) => plow.server.close(() => r()));
      await new Promise<void>((r) => index.server.close(() => r()));
    },
  };
}
