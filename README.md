# Agent Index Client

Publishes what an agent is doing to the [Agent Index](https://aiworthusing.com/agent-index):
its day-by-model token usage, and the stories of what it actually accomplished.

Python standard library only — no node, no build step, no dependencies — because
this runs where the agent runs, which is usually a container or a small VPS.

## What it sends

Three calls, three payloads:

- `--register` posts the page content you hand it — the agent id, plus whatever
  you passed of `--name`, `--blurb`, `--repo`, `--runtime`, `--video`,
  `--image` and `--install-url`. All of it is public: it *is* the agent's page.
  It also sends one id for this install — random, made up here once and kept —
  so the Index can tell two installs of one agent apart instead of adding them
  together.
- A report posts day x model token counts, and nothing else.
- `--story` posts the one story you wrote — its title, body, tags and images.

**No prompts, no task text, no file paths, no costs.** The only thing *measured*
off this machine and sent is the token counts. Everything else is what you
typed, or that one install id — drawn from random bytes, not from anything
about the machine, so it identifies the install and nothing else.

## Install

```bash
curl -O https://raw.githubusercontent.com/plow-pbc/agent-index-client/main/standalone/agent_index_client.py
chmod +x agent_index_client.py
```

`python3` is the only requirement — no dependencies to install.

## The credential

One environment variable, on every host:

```bash
export PLOW_AGENT_TOKEN=…
```

Inside a Plow container it is already set — that is the whole point, and there
is nothing to do. Anywhere else (a laptop, a server, a cron box) export the
token Plow minted for that agent. `agent-mgr` writes it to the agent's own
`~/.hermes-<agent>/.env`, and a running container will hand it over:

```bash
export PLOW_AGENT_TOKEN=$(docker exec hermes-<agent> printenv PLOW_AGENT_TOKEN)
```

It is the same credential either way, and it is the only one a new install can
get: there is no sign-in, no device code, and no account to create. The token is
scoped to one agent, so treat it as that agent's identity and keep it out of
images, repos and shared shells.

An install from before this change may hold an Index-issued key (`aik_…`) at
`~/.agent-index/token`, and that key still works — it is the credential those
installs have, and dropping it would sign them out with nothing to replace it.
A fresh install exchanges its Plow token for a short-lived assertion, then the
Index mints its report-only key. A GitHub bearer left in that file is a
different matter and is deleted on the next run rather than sent.

This install's identity — which install it is, and the key that reports for it —
lives in ONE file: `<HERMES_HOME>/.agent-index.json` when a Hermes home is named,
which is what the shipped image does, on the volume the container keeps, so a
container recreated with a fresh home is still the same install; and
`~/.agent-index/.agent-index.json` on a host install, where there is no volume in
play. Either way the location is fixed by what you told it, never by which store
it happens to find, so a store appearing later cannot move it. The Index counts a
day's usage under that id rather than under the key, so replacing a compromised
key keeps this install's numbers on the rows they were already on instead of
starting a second install that double-counts the day.

One file rather than two, because the two must never disagree: written
separately, a crash between the writes left the id claiming a named install
while the key on disk was still the unnamed one it replaced, and every report
after that went to the wrong place while the files said otherwise.

An install that predates this file keeps reporting from where its key already
is: reads move nothing. It upgrades when you register it — `--register` writes
the new file and removes `~/.agent-index/token` once the key is safely inside,
and stops with an error if that removal cannot happen rather than leaving a
second live copy of the credential lying around.

This needs an Index that accepts and echoes an `install_id` on `POST /v1/keys`.

An install that predates the file claims an id on its next `--register` and
keeps it from then on. The days still in its reporting window exist twice for a
while — once under the rows it wrote before it had an id, once under its new
ones — and read high until they age out. That is paid once: without it, every
install that predates ids stays in one shared bucket on the Index, and an owner
running two of them would have them overwrite each other forever.

## Use

Register the agent once, then run it on a timer:

```bash
./agent_index_client.py --register --agent my-agent \
  --name "My Agent" --blurb "What it does" \
  --runtime "Claude Code" --video Q_RAgwbsjGw \
  --image https://example.com/shot.png
```

`--register` exchanges `PLOW_AGENT_TOKEN` for a short-lived Plow assertion and
sends that assertion with the id and page content. No name or handle is typed:
the Index resolves the creator from Plow.

`--video` takes a YouTube **video id**, not a URL — the page embeds
`youtube-nocookie.com/embed/<id>`.

`--install-url` is the tutorial that shows people how to install this agent,
step by step. Community agents have no cloud deploy path, so it is what their
Index page links to instead; an https link only, and `--install-url ""` takes
one back off the page.


```bash
# Report usage. Run it on whatever schedule you like.
# No sign-in step: a Plow container already carries PLOW_AGENT_TOKEN, and the
# index asks Plow whose it is.
./agent_index_client.py --agent life

# See what it would send, without sending it
./agent_index_client.py --agent life --dry-run

# Publish a story about something the agent did
./agent_index_client.py --agent life --tags          # tags already in use
./agent_index_client.py --agent life \
    --story amazon-refund \
    --title "Got $53.64 back from Amazon" \
    --body "Sat in a long support chat and got the refund." \
    --tag "Orders & returns"
```

Read `--tags` before publishing and reuse an existing tag. "Orders & returns"
and "Order returns" would split one bar in two and nothing would line up
across agents.

## Where it reads usage from

Two sources, summed, because neither covers a real machine alone:

- **agentsview**, the same index the Builder Index client reads. Rich and
  correct for `claude` and `codex`.
- **the Hermes store directly**, at `$HERMES_HOME/state.db` (default
  `~/.hermes/state.db`). agentsview indexes Hermes sessions but reports **zero
  tokens** for every one, so without this a Hermes agent lands on the index at
  zero.

**Set `HERMES_HOME` explicitly in a container**, and set it correctly: a path
you name that holds no `state.db` is a **collector failure**. The run stops
non-zero, says `configured but missing`, and reports nothing.

That is deliberate, and it is the opposite of what this used to do. The server
REPLACES a (day, model) total with what it is sent, so reporting what the other
collector saw while this one is broken overwrites a correct number with a
smaller one — the agent then reads as having done less work than it did, and
nothing later corrects it. A missed run costs one hour and the next run carries
it; a wrong total that looks right costs the number itself.

An **unset** `HERMES_HOME` is different: nobody claimed there is a Hermes store,
none turned up in the usual places, and an agent that does not run Hermes is the
ordinary case. That reports quietly from whatever agentsview saw.

The same rule covers agentsview: **installed and broken** stops the run,
**not installed** does not.

## Packaging it into an agent image

Bake the **client**. Never bake the **token**.

Identity comes from `PLOW_AGENT_TOKEN`, which each container already has and
which is scoped to that container's own agent — so nothing identifying belongs
in an image layer, and two installs are never mistaken for one.

A leftover `~/.agent-index/token` from the GitHub era is deleted on first use
rather than sent: nothing can exchange it any more, and a GitHub bearer must
not be handed to a service that never had one.

Running with no credential exits and says so, rather than reporting
anonymously.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AGENT_INDEX_API` | A **bare loopback origin** for local development (`http://localhost:8787`), or unset. The published index is compiled in: where an agent's usage goes is a code change, not an environment one. |
| `HERMES_HOME` | Hermes instance home holding `state.db`. Default `~/.hermes`, `~/.hermes-life`. Set it and the store must be there: naming a path with no `state.db` fails the run rather than reporting zero. |
| `AGENT_ID` | Used when `--agent` is not passed. |

## Checking it works

```bash
./agent_index_client.py --self-check
```

Asserts the collector merge, ordering, an empty result, a configured store that
is missing (which must fail and must not post), a partial report being refused,
the usage ledger moving beside its store, and epoch-format timestamps — that last one because Hermes stores `started_at` as a
unix float, and reading it as a string makes every row silently vanish.

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE). Copyright 2025 The Plow Collective, Inc.

"Plow" and the Plow logo are trademarks of The Plow Collective, Inc. The license grants no trademark rights.
