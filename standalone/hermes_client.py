#!/usr/bin/env python3
"""tkmx-hermes — a tokenmaxxing client for a Hermes agent.

A whole tkmx client, not a plugin for the Node one. Python stdlib only, no
node, no agentsview, no build step: it runs wherever the Hermes agent runs,
which is the point — Hermes lives in containers and on $5 VPSes, and the
existing client cannot follow it there.

Why it exists at all: AgentsView indexes Hermes sessions but reports zero
tokens for every one of them, so the Node client — which gets all its local
usage from AgentsView — reports a Hermes machine as idle. This reads Hermes'
own store instead.

Store: $HERMES_HOME/state.db (HERMES_HOME defaults to ~/.hermes). Table
`sessions` keeps running per-session totals. Its four token counters are
DISJOINT — hermes' CanonicalUsage defines
prompt_tokens = input + cache_read + cache_write — which is already what
the tkmx wire format wants, so nothing is subtracted here.

Usage:
    tkmx_hermes.py              # collect and POST
    tkmx_hermes.py --dry-run    # print the body, POST nothing
    tkmx_hermes.py --self-check # run the built-in assertions
"""

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request
from datetime import date, timedelta

SOURCE = "hermes"

# Bucket on the session's LOCAL start date, matching every other tkmx
# collector, so rows don't split across two days near local midnight.
#
# ponytail: a session is billed wholly to the day it STARTED, because Hermes
# stores one running total per session, not per-turn rows. A session held
# open across midnight lands on the wrong day. Ceiling accepted; the upgrade
# path is per-API-call rows, which Hermes does not persist today.
SQL = """
  SELECT date(started_at, 'unixepoch', 'localtime')            AS d,
         COALESCE(NULLIF(model, ''), 'unknown')                AS model,
         SUM(COALESCE(input_tokens, 0))                        AS input,
         SUM(COALESCE(output_tokens, 0))                       AS output,
         SUM(COALESCE(cache_write_tokens, 0))                  AS cache_write,
         SUM(COALESCE(cache_read_tokens, 0))                   AS cache_read,
         SUM(COALESCE(actual_cost_usd, estimated_cost_usd, 0)) AS cost
    FROM sessions
   WHERE started_at IS NOT NULL
     AND date(started_at, 'unixepoch', 'localtime') >= :since
   GROUP BY d, model
   ORDER BY d, model
"""


def state_db_path(env=os.environ):
    root = env.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
    return os.path.join(root, "state.db")


def collect(db_path, since):
    """-> [{date, modelBreakdowns: [...]}] for days at/after `since` (YYYY-MM-DD).

    A missing store means "no Hermes here" and yields nothing. A store that
    exists but will not open raises: reporting zero for a machine that does
    run Hermes is indistinguishable from a quiet day, and that silent zero is
    the exact failure this client was written to end.
    """
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        rows = conn.execute(SQL, {"since": since}).fetchall()
    finally:
        conn.close()

    days = {}
    for d, model, inp, out, cw, cr, cost in rows:
        total = inp + out + cw + cr
        if total == 0:
            continue
        breakdown = {
            "modelName": model,
            "inputTokens": inp,
            "outputTokens": out,
            "cacheCreationTokens": cw,
            "cacheReadTokens": cr,
            "totalTokens": total,
            "source": SOURCE,
        }
        if cost > 0:
            breakdown["cost"] = round(cost, 6)
        days.setdefault(d, {"date": d, "modelBreakdowns": []})["modelBreakdowns"].append(breakdown)
    return [days[d] for d in sorted(days)]


def post(server_url, api_key, body):
    req = urllib.request.Request(
        server_url.rstrip("/") + "/api/usage",
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()


def main(argv):
    if "--self-check" in argv:
        return self_check()

    env = os.environ
    days = int(env.get("TKMX_REPORT_DAYS", "7"))
    since = (date.today() - timedelta(days=days - 1)).isoformat()
    db = env.get("HERMES_STATE_DB") or state_db_path(env)

    data = collect(db, since)
    body = {
        "username": env["TKMX_USERNAME"],
        "team": env.get("TKMX_TEAM", "default"),
        # Stable per-machine id. The server DELETEs existing rows for
        # (username, date, client_id) before inserting, so two machines
        # sharing one id silently erase each other. A container gets its own.
        "client_id": env["TKMX_CLIENT_ID"],
        "report_days": days,
        "data": data,
        "machine_config": {"client": "tkmx-hermes", "runtime": "hermes"},
    }

    rows = sum(len(d["modelBreakdowns"]) for d in data)
    print(f"tkmx-hermes: {db}")
    print(f"  {len(data)} day(s), {rows} model row(s) since {since}")
    if "--dry-run" in argv:
        print(json.dumps(body, indent=2))
        return 0
    if not data:
        print("  nothing to report")
        return 0

    status, text = post(env.get("TKMX_SERVER_URL", "https://tokenmaxxing.odio.dev"),
                        env["TKMX_API_KEY"], body)
    print(f"  Server responded {status}: {text}")
    return 0 if status == 200 else 1


def self_check():
    """One runnable check: a known store in, known wire rows out."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "state.db")
        conn = sqlite3.connect(db)
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, model TEXT, started_at REAL,"
            " input_tokens INT, output_tokens INT, cache_read_tokens INT,"
            " cache_write_tokens INT, estimated_cost_usd REAL, actual_cost_usd REAL)"
        )
        # Two sessions, same model, same local day -> must SUM into one row.
        noon = "2026-08-25 12:00:00"
        conn.executemany(
            "INSERT INTO sessions VALUES (?,?,strftime('%s',?,'utc'),?,?,?,?,?,?)",
            [
                ("a", "qwen3:1.7b", noon, 100, 10, 5, 1, 0.5, None),
                ("b", "qwen3:1.7b", noon, 200, 20, 0, 0, None, 0.25),
                # Zero-token session must not create a phantom row.
                ("c", "qwen3:1.7b", noon, 0, 0, 0, 0, None, None),
                # Older than `since` -> filtered out.
                ("d", "qwen3:1.7b", "2026-01-01 12:00:00", 999, 999, 0, 0, None, None),
            ],
        )
        conn.commit()
        conn.close()

        got = collect(db, "2026-08-01")
        assert len(got) == 1, got
        assert got[0]["date"] == "2026-08-25", got
        (m,) = got[0]["modelBreakdowns"]
        assert m["inputTokens"] == 300, m
        assert m["outputTokens"] == 30, m
        assert m["cacheReadTokens"] == 5, m
        assert m["cacheCreationTokens"] == 1, m
        # Disjoint counters: total is their plain sum, nothing double-counted.
        assert m["totalTokens"] == 336, m
        # actual_cost_usd wins over estimated where both exist.
        assert m["cost"] == 0.75, m
        assert m["source"] == "hermes", m

        assert collect(os.path.join(tmp, "absent.db"), "2026-08-01") == []

    print("self-check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
