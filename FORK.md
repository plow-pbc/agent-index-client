# What this fork is

Seeded from `plow-pbc/tkmx-client` (tokenmaxxing). Tokenmaxxing indexes what a
**person** used. This indexes what an **agent** used.

That is a different product, not a flag:

| tokenmaxxing | agent-index |
| --- | --- |
| one stable human username | many agents, spawned and killed per task |
| `client_id` is the machine | the machine is a container that dies; the agent identity has to outlive it |
| daily totals per user | per-run rows — what one task cost |
| tokens are the score | tokens alone say nothing; an agent that burns 2M and finishes beats one that burns 200k and gives up |
| cost in dollars | subscription-billed agents report `$0.00` (`cost_status: included`), so a dollar ranking puts a whole fleet at zero |
| flat list of users | agents delegate — runs form a tree via `parent_run_id` |

## `standalone/`

The Node reporter needs node, npm and AgentsView. Agents live in containers and
on $5 VPSes, so the standalone clients are Python stdlib only — no node, no
AgentsView, no build step — and read each runtime's own store directly.

- `hermes_client.py` — reports Hermes usage in the tokenmaxxing wire format.
  Proven end to end: Hermes in a container, its own Codex device-code
  credential, `200 {"ok":true,"rows":1}`, `source=hermes` live on the feed.
- `agent_index_hermes.py` — the same collector emitting the **agent** schema:
  one row per run, carrying `api_calls`, `tool_calls`, `end_reason`, `task` and
  `parent_run_id`. This is the shape the server fork has to accept.
- `Dockerfile` — Hermes plus its client in one image.

Both carry `--self-check` (assert-based, no framework) and `--dry-run`.

**Hermes cannot go through AgentsView.** AgentsView indexes Hermes sessions but
reports zero tokens for every one, so a Hermes machine reads as idle. These
clients read `$HERMES_HOME/state.db` instead. Its four token counters are
disjoint (`prompt_tokens = input + cache_read + cache_write`) and reasoning is a
subset of output, so nothing is added twice.

## Next

Change the row key from user to agent, and repoint the container at
`agent-index-server` instead of tokenmaxxing.
