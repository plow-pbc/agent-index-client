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

export type Hit = { method: string; path: string; bearer: string };

function bearerOf(req: http.IncomingMessage): string {
  return String(req.headers["authorization"] || "");
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
export async function standIns(): Promise<StandIns> {
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

  const index = await listen((req, res) => {
    const path = new URL(req.url || "/", "http://x").pathname;
    const bearer = bearerOf(req);
    indexHits.push({ method: req.method || "", path, bearer });
    // Registration and minting are the assertion's job, and ONLY the
    // assertion's: a Plow token here is the leak, so it is a 401.
    if (path === "/v1/agents" || path === "/v1/keys") {
      if (bearer !== `Bearer ${ASSERTION}`) {
        return json(res, 401, { error: "the Index takes an assertion, not a Plow token" });
      }
      return path === "/v1/keys"
        ? json(res, 200, { key: MINTED_KEY })
        : json(res, 200, { result: "registered", url: "https://agents.plow.co/purge-test" });
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
