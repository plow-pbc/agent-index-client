# Agent Index Client

Publishes what an agent is doing to the [Agent Index](https://aiworthusing.com/agent-index):
its day-by-model token usage, and the stories of what it actually accomplished.

Python standard library only — no node, no build step, no dependencies — because
this runs where the agent runs, which is usually a container or a small VPS.

## What it sends

Token counts per day per model, and stories you choose to publish. **Nothing
else.** No prompts, no task text, no file paths, no costs.

## Install

```bash
curl -O https://raw.githubusercontent.com/plow-pbc/agent-index-client/main/standalone/agent_index_client.py
chmod +x agent_index_client.py
```

`python3` is the only requirement — no dependencies to install.

## Use

Register the agent once, then run it on a timer:

```bash
./agent_index_client.py --register --agent my-agent \
  --name "My Agent" --blurb "What it does" \
  --runtime "Claude Code" --video Q_RAgwbsjGw \
  --image https://example.com/shot.png
```

`--register` opens the GitHub device flow, claims the id, and stores an
Index-scoped key. That key reports usage and publishes stories; it is refused
by registration itself, so a leaked key cannot claim ids. Revoke it any time
with `DELETE /v1/keys` using your GitHub token.

`--video` takes a YouTube **video id**, not a URL — the page embeds
`youtube-nocookie.com/embed/<id>`.


```bash
# Once: prove who you are. Prints a code, you approve it on any device.
# No browser needed on this machine, and no secret is stored in the image.
./agent_index_client.py --agent life --login

# Then: report usage. Run it on whatever schedule you like.
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

**Set `HERMES_HOME` explicitly in a container.** A wrong path is not an error —
it reads as zero tokens, which looks like an idle agent rather than a
misconfiguration.

## Packaging it into an agent image

Bake the **client**. Never bake the **token**.

`~/.agent-index/token` is a real GitHub credential identifying a *person*, not
a machine. In an image layer, anyone who pulls the image can extract it and
report as that person — and every container from that image counts as one
install instead of many. Make `~/.agent-index` a writable volume and let each
install run `--login` once.

Running with no token exits and says so, rather than reporting anonymously.

## Configuration

| Variable | Meaning |
| --- | --- |
| `AGENT_INDEX_API` | Server base URL. Defaults to the live one. |
| `HERMES_HOME` | Hermes instance home holding `state.db`. Default `~/.hermes`. |
| `AGENT_ID` | Used when `--agent` is not passed. |

## Checking it works

```bash
./agent_index_client.py --self-check
```

Asserts the collector merge, ordering, an empty result, a missing store, and
epoch-format timestamps — that last one because Hermes stores `started_at` as a
unix float, and reading it as a string makes every row silently vanish.
