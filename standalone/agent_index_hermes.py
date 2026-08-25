#!/usr/bin/env python3
"""agentmaxxing — usage reporting for AGENTS, forked from tokenmaxxing.

tokenmaxxing answers "how much AI did this PERSON use this month".
Its unit is (username, date, model): one human, one machine, daily totals,
a leaderboard of people. Every one of those assumptions breaks for agents.

What changes, and why:

  human                          agent
  -----------------------------  ------------------------------------------
  one stable username            many agents, spawned and killed per task
  client_id == the machine       the machine is a container that dies; the
                                 agent identity has to outlive it
  daily totals                   per-RUN rows: the question is what one task
                                 cost, not what August cost
  tokens are the score           tokens alone say nothing — an agent that
                                 burns 2M and finishes beats one that burns
                                 200k and gives up. Work done is the score.
  cost in dollars                subscription-billed agents report $0.00
                                 (cost_status='included'), so a dollar
                                 leaderboard ranks them all equal at zero
  flat list of users             agents delegate: runs form a tree via
                                 parent_run_id

So the wire unit here is a RUN, not a day, and it carries the work counters
(api_calls, tool_calls, end_reason) that make tokens interpretable.

Reads Hermes' own store — $HERMES_HOME/state.db — because it has to run
inside the container next to the agent. Python stdlib only: no node, no
agentsview, no build step.

Usage:
    agentmax_hermes.py --dry-run
    agentmax_hermes.py --self-check
    agentmax_hermes.py                 # POST to AGENTMAX_SERVER_URL
"""

import json
import os
import sqlite3
import sys
import urllib.error
import urllib.request

RUNTIME = "hermes"

# One row per agent run. `cost_status` is carried rather than folded into a
# number: 'included' means a subscription paid for it, which is NOT the same
# fact as "it cost zero", and collapsing the two is how a fleet of
# subscription agents shows up as free.
SQL = """
  SELECT id                                   AS run_id,
         parent_session_id                    AS parent_run_id,
         COALESCE(NULLIF(model, ''), 'unknown')   AS model,
         COALESCE(billing_provider, '')        AS provider,
         COALESCE(NULLIF(title, ''), '')       AS task,
         COALESCE(NULLIF(source, ''), '')      AS channel,
         COALESCE(end_reason, '')              AS end_reason,
         started_at, ended_at,
         COALESCE(input_tokens, 0)             AS input_tokens,
         COALESCE(output_tokens, 0)            AS output_tokens,
         COALESCE(cache_read_tokens, 0)        AS cache_read_tokens,
         COALESCE(cache_write_tokens, 0)       AS cache_write_tokens,
         COALESCE(reasoning_tokens, 0)         AS reasoning_tokens,
         COALESCE(actual_cost_usd, estimated_cost_usd, 0) AS cost_usd,
         COALESCE(cost_status, 'unknown')      AS cost_status,
         COALESCE(api_call_count, 0)           AS api_calls,
         COALESCE(tool_call_count, 0)          AS tool_calls,
         COALESCE(message_count, 0)            AS messages
    FROM sessions
   WHERE started_at IS NOT NULL AND started_at >= :since_epoch
   ORDER BY started_at
"""


def state_db_path(env=os.environ):
    root = env.get("HERMES_HOME") or os.path.join(os.path.expanduser("~"), ".hermes")
    return os.path.join(root, "state.db")


def collect_runs(db_path, since_epoch=0.0):
    """-> [run, ...]. Missing store means no agent here; unreadable store raises.

    A silent empty report and a genuinely idle agent look identical on a
    leaderboard, so only ABSENCE is allowed to be quiet.
    """
    if not os.path.exists(db_path):
        return []
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        rows = conn.execute(SQL, {"since_epoch": since_epoch}).fetchall()
    finally:
        conn.close()

    runs = []
    for r in rows:
        tokens = {
            "input": r["input_tokens"],
            "output": r["output_tokens"],
            "cache_read": r["cache_read_tokens"],
            "cache_write": r["cache_write_tokens"],
            "reasoning": r["reasoning_tokens"],
        }
        # Hermes' counters are disjoint: CanonicalUsage defines
        # prompt_tokens = input + cache_read + cache_write, and reasoning is
        # a SUBSET of output — so reasoning is reported but never added.
        tokens["total"] = (
            tokens["input"] + tokens["output"] + tokens["cache_read"] + tokens["cache_write"]
        )
        if tokens["total"] == 0:
            continue  # a session that never called a model is not a run
        runs.append(
            {
                "run_id": r["run_id"],
                "parent_run_id": r["parent_run_id"] or None,
                "runtime": RUNTIME,
                "model": r["model"],
                "provider": r["provider"],
                "task": r["task"],
                "channel": r["channel"],
                "end_reason": r["end_reason"],
                "started_at": r["started_at"],
                "ended_at": r["ended_at"],
                "tokens": tokens,
                "cost": {"usd": round(r["cost_usd"], 6), "status": r["cost_status"]},
                "work": {
                    "api_calls": r["api_calls"],
                    "tool_calls": r["tool_calls"],
                    "messages": r["messages"],
                },
            }
        )
    return runs


def build_body(runs, env=os.environ):
    return {
        # Identity is the AGENT, not the machine it happens to be in.
        # AGENT_ID must be assigned by whatever spawns the agent and must
        # outlive the container: a container id here would make every
        # restart look like a brand-new agent with no history.
        "agent_id": env["AGENT_ID"],
        "owner": env["AGENT_OWNER"],
        "role": env.get("AGENT_ROLE", ""),
        "runtime": RUNTIME,
        "runs": runs,
    }


def post(server_url, api_key, body):
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    req = urllib.request.Request(
        server_url.rstrip("/") + "/v1/runs",
        data=json.dumps(body).encode(),
        headers=headers,
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
    db = env.get("HERMES_STATE_DB") or state_db_path(env)
    runs = collect_runs(db, float(env.get("AGENTMAX_SINCE_EPOCH", "0")))
    body = build_body(runs, env)

    print(f"agentmax({RUNTIME}): {db}")
    print(f"  agent={body['agent_id']} owner={body['owner']} runs={len(runs)}")
    if "--dry-run" in argv:
        print(json.dumps(body, indent=2))
        return 0
    if not runs:
        print("  nothing to report")
        return 0
    status, text = post(env["AGENTMAX_SERVER_URL"], env.get("AGENTMAX_API_KEY"), body)
    print(f"  Server responded {status}: {text}")
    return 0 if status == 200 else 1


def self_check():
    """One runnable check: a known Hermes store in, known run rows out."""
    import tempfile

    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "state.db")
        conn = sqlite3.connect(db)
        conn.execute(
            "CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, user_id TEXT,"
            " model TEXT, parent_session_id TEXT, started_at REAL, ended_at REAL,"
            " end_reason TEXT, message_count INT, tool_call_count INT,"
            " input_tokens INT, output_tokens INT, cache_read_tokens INT,"
            " cache_write_tokens INT, reasoning_tokens INT, billing_provider TEXT,"
            " estimated_cost_usd REAL, actual_cost_usd REAL, cost_status TEXT,"
            " title TEXT, api_call_count INT)"
        )
        conn.executemany(
            "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                # A real run, subscription-billed.
                ("run-a", "cli", "", "gpt-5.4", None, 1000.0, 1100.0, "agent_close",
                 6, 2, 1469, 99, 34304, 0, 40, "openai-codex", 0.0, None, "included",
                 "Write proof2.txt", 3),
                # A delegated child run — the shape a human client has no
                # column for at all.
                ("run-b", "cli", "", "gpt-5.4", "run-a", 1010.0, 1050.0, "agent_close",
                 2, 0, 500, 10, 0, 0, 0, "openai-codex", 0.25, None, "estimated",
                 "subtask", 1),
                # Never called a model -> not a run.
                ("run-c", "cli", "", "gpt-5.4", None, 1020.0, None, "", 0, 0,
                 0, 0, 0, 0, 0, "", None, None, "unknown", "", 0),
            ],
        )
        conn.commit()
        conn.close()

        runs = collect_runs(db)
        assert [r["run_id"] for r in runs] == ["run-a", "run-b"], runs

        a = runs[0]
        # Disjoint counters sum; reasoning is a subset of output and must NOT
        # be added on top of it.
        assert a["tokens"]["total"] == 1469 + 99 + 34304, a["tokens"]
        assert a["tokens"]["reasoning"] == 40, a["tokens"]
        assert a["work"] == {"api_calls": 3, "tool_calls": 2, "messages": 6}, a["work"]
        # Subscription-billed: $0.00 but explicitly 'included', not "free".
        assert a["cost"] == {"usd": 0.0, "status": "included"}, a["cost"]
        assert a["parent_run_id"] is None and a["task"] == "Write proof2.txt", a

        # Delegation survives the wire.
        assert runs[1]["parent_run_id"] == "run-a", runs[1]
        # actual_cost_usd absent -> estimated is used.
        assert runs[1]["cost"] == {"usd": 0.25, "status": "estimated"}, runs[1]["cost"]

        # since filter is on the run's start, not its end.
        assert [r["run_id"] for r in collect_runs(db, 1005.0)] == ["run-b"]

        assert collect_runs(os.path.join(tmp, "nope.db")) == []

        body = build_body(runs, {"AGENT_ID": "eng-494", "AGENT_OWNER": "danedelattre"})
        assert body["agent_id"] == "eng-494" and body["runtime"] == "hermes", body

    print("self-check OK")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
