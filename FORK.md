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

- `agent_index_client.py` — the client. Reads the runtime's own store, reports
  to the Agent Index as the container's `PLOW_AGENT_TOKEN`. Carries
  `--self-check` (assert-based, no framework) and `--dry-run`.
- `Dockerfile` — Hermes plus that client in one image.

Two earlier collectors lived here — `hermes_client.py`, which emitted the
tokenmaxxing wire format, and `agent_index_hermes.py`, which emitted a per-run
agent schema. Both are gone: the first authenticated against tokenmaxxing with
`TKMX_API_KEY` and could not talk to this index at all, and the image was still
building from it. Git history has them if the shape is ever wanted again; a
copy sitting in the tree only waits to be shipped by mistake.

**Hermes cannot go through AgentsView.** AgentsView indexes Hermes sessions but
reports zero tokens for every one, so a Hermes machine reads as idle. These
clients read `$HERMES_HOME/state.db` instead. Its four token counters are
disjoint (`prompt_tokens = input + cache_read + cache_write`) and reasoning is a
subset of output, so nothing is added twice.

## Next

Change the row key from user to agent, and repoint the container at
`agent-index-server` instead of tokenmaxxing.
