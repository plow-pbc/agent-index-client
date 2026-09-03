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

## `standalone/`

The Node reporter needs node, npm and AgentsView. Agents live in containers and
on $5 VPSes, so the standalone client is Python stdlib only — no node, no npm,
no build step.

It is not AgentsView-free, and the distinction matters when reading a report:
it CALLS `agentsview usage daily --json` when that binary is installed, because
for claude and codex those numbers are the correct ones, and says so when it is
absent rather than reporting a zero it never measured. What it does not do is
depend on AgentsView for Hermes, which AgentsView indexes but reports as all
zeros — that it reads from `$HERMES_HOME/state.db` itself, and merges the two.

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

## What ships today

The row key is the **agent**, and the container reports to `agent-index-server`,
not tokenmaxxing. Identity is the container's own `PLOW_AGENT_TOKEN`, which the
index resolves by asking Plow — no sign-in, no GitHub, no second account.

Per-run rows (`api_calls`, `end_reason`, `parent_run_id`, a delegation tree) are
NOT shipped. The collector sends day x model token counts, because that is what
the server accepts and what the page draws. If that shape is ever wanted, the
starting point is in git history rather than in this tree.

## Next

Nothing planned. The cutover above is done.
