# What this fork is

Seeded from `plow-pbc/tkmx-client` (tokenmaxxing). Tokenmaxxing indexes what a
**person** used. This indexes what an **agent** used.

That is a different product, not a flag:

| tokenmaxxing | agent-index |
| --- | --- |
| one stable human username | many agents, spawned and killed per task |
| `client_id` is the machine | the machine is a container that dies; the agent identity has to outlive it |
| daily totals per user | daily totals per AGENT, keyed on the agent id, not the person running it |
| tokens are the score | tokens alone say nothing; an agent that burns 2M and finishes beats one that burns 200k and gives up |
| cost in dollars | subscription-billed agents report `$0.00` (`cost_status: included`), so a dollar ranking puts a whole fleet at zero |
| flat list of users | one row per agent, with the person behind it resolved from their Plow token |

## What this fork does NOT keep

Two earlier collectors lived in `standalone/`: `hermes_client.py`, which emitted
the tokenmaxxing wire format and authenticated with `TKMX_API_KEY`, and
`agent_index_hermes.py`, which emitted a per-run agent schema (`api_calls`,
`end_reason`, `parent_run_id`, a delegation tree). Both are deleted, and neither
shape is sent today: the client reports day x model token counts, because that is
what the server accepts and what the page draws. Git history holds them if that
shape is ever wanted again.

**Hermes cannot go through AgentsView.** AgentsView indexes Hermes sessions but
reports zero tokens for every one, so a Hermes machine reads as idle. The client
reads `$HERMES_HOME/state.db` directly for those, and merges them with what
AgentsView reports for claude and codex, which it does invoke. Hermes' four
token counters are disjoint (`prompt_tokens = input + cache_read + cache_write`)
and reasoning is a subset of output, so nothing is added twice.

## How to run it

[README.md](README.md), which is the single live contract: what the client
needs, which credential it accepts, and what it sends. This file is provenance
only -- how this repo differs from the one it was seeded from -- so that a
reader never has two documents to reconcile, and a change never has two places
to be wrong in.
