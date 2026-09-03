#!/usr/bin/env python3
"""Publish one agent's token usage to the Agent Index.

    agent_index_client.py --agent life              # then: report usage
    agent_index_client.py --agent life --dry-run    # show what would be sent
    agent_index_client.py --agent life --tags       # tags already in use
    agent_index_client.py --agent life --story ID --title T [--body B] [--tag T]...
    agent_index_client.py --self-check

Collects from two places, because neither alone covers a real machine:
  * agentsview, the same index the Builder Index client reads. Rich and correct
    for claude and codex. Measured on v0.38.1: grok reports zero, fixed
    upstream in 0.39.0; hermes reports zero with no fix known.
  * the Hermes store directly, because of that hermes gap — Hermes is what our
    own agents run on, so relying on agentsview alone puts them on the board at
    zero.

Sends day x model token counts and nothing else: no prompts, no task titles,
no file paths, no costs. Identity is the container's own Plow token, which the
index resolves by asking Plow -- there is no sign-in and no second account.
"""
import datetime
import json, os, sqlite3, subprocess, sys, time, urllib.error, urllib.parse, urllib.request
from collections import defaultdict

# Line-buffer stdout. Under a supervisor the output is a pipe, not a terminal,
# so Python block-buffers it — and the login instruction ("open this URL, enter
# this code") sits in a buffer while the user waits at a blank log wondering
# whether anything is happening. Everything this prints is meant to be read as
# it happens.
try:
    sys.stdout.reconfigure(line_buffering=True)
except AttributeError:          # Python < 3.7
    pass

LOOPBACK = False

def _shown(url):
    """A URL safe to print: scheme, host and port, nothing else.

    Everything this prints goes to a supervisor log that outlives the run, and a
    URL can carry a secret anywhere in it -- userinfo, a path segment, a query
    parameter. Enough to fix a typo, not enough to leak one.
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or "?"
    return f"{parts.scheme}://{host}" + (f":{parts.port}" if parts.port else "")




def _api(url):
    """Refuse to send the Plow token over cleartext http.

    The bearer identifies its owner to Plow, so anyone on the path gets it and
    can report as that person until it is rotated. Localhost is the exception,
    and only localhost: that traffic never leaves the machine, and developing
    against a local server is the reason this variable exists.
    """
    parts = urllib.parse.urlsplit(url)
    # Userinfo is refused outright, before anything looks at the host. Splitting
    # the string by hand read "http://localhost:80@attacker.example" as
    # localhost, while urllib -- the thing that actually opens the socket --
    # reads the host as attacker.example and the rest as a username. That is a
    # cleartext bearer to a stranger, past a check that said it never left the
    # machine. Nothing here has any use for credentials in a URL.
    if parts.username or parts.password or "@" in parts.netloc:
        # The URL is NOT echoed: it holds the credential we are refusing, and
        # this runs unattended under a supervisor whose log outlives the run.
        # Naming the scheme and host is enough to fix a typo; printing the
        # password would move it from one place we do not want it to another.
        sys.exit(f"AGENT_INDEX_API must not carry credentials ({_shown(url)}) — "
                 f"the host urllib connects to is not the one such a URL looks like")
    if parts.scheme == "https":
        return url
    if parts.scheme == "http" and parts.hostname in ("localhost", "127.0.0.1", "::1"):
        # Only true with the proxy bypassed. urllib reads HTTP_PROXY from the
        # environment, so on a machine with a proxy set and loopback missing
        # from NO_PROXY -- a normal corporate box -- "it never leaves the
        # machine" becomes "it goes to the proxy in cleartext, with the bearer".
        global LOOPBACK
        LOOPBACK = True
        return url
    # Same reason: scheme and host, never the whole URL. A path or query can
    # carry a secret too, and this message lands in the same logs.
    sys.exit(f"AGENT_INDEX_API must be https ({_shown(url)}) — the Plow token would "
             f"travel in cleartext, and anyone on the path could then report as you")


API = _api(os.environ.get("AGENT_INDEX_API", "https://agent-index-server.vercel.app"))
TOKEN_PATH = os.path.expanduser("~/.agent-index/token")
KEYS = ("input", "output", "cache_read", "cache_write")

# Collectors append here when a read genuinely FAILED, as opposed to finding
# nothing. Without the distinction a broken agentsview or a SQLite error is
# reported as an idle agent, which is the one thing this client must never do:
# it publishes a number people compare agents on.
FAILURES = []


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect. urlopen follows them by default, which would
    forward the GitHub bearer to wherever a 30x points — so a compromised or
    misconfigured API host could harvest the token by answering with a
    redirect. Matches ld-shared/scripts/bearer_http.py in the agent repo."""

    def redirect_request(self, *_args, **_kwargs):
        return None


def _open_no_redirect(req, timeout=30):
    # An empty ProxyHandler for loopback: it disables urllib's environment
    # proxy lookup for this request, which is what makes the http exception
    # above safe. Everything else keeps the default handlers, proxy included --
    # that traffic is https, so a proxy sees a CONNECT and not the token.
    handlers = [_NoRedirect] + ([urllib.request.ProxyHandler({})] if LOOPBACK else [])
    return urllib.request.build_opener(*handlers).open(req, timeout=timeout)


def _post(url, body, headers):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json",
                                          "accept": "application/json", **headers},
                                 method="POST")
    try:
        with _open_no_redirect(req) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        # A refused redirect surfaces here as the 30x itself, which is what we
        # want: reported, never followed with the token attached.
        return e.code, json.loads(e.read() or b"{}")
    except urllib.error.URLError as e:
        # Unreachable server, DNS failure, no network yet at container boot.
        # This ran as an unhandled traceback in a supervised loop's logs; a
        # status of 0 reports the same failure without the noise, and callers
        # already treat anything other than 200 as a failure.
        # Scheme and host only: the path and query of a report URL carry an
        # agent id, and any URL can carry more than that.
        return 0, {"error": f"could not reach {_shown(url)}: {e.reason}"}



def auth_headers():
    """The container's own Plow token, which is the only identity there is.

    Every Plow container already carries PLOW_AGENT_TOKEN, and the index
    resolves it to the person who owns the agent by asking Plow -- so a
    container needs no sign-in of any kind, and there is no GitHub here.

    A stored key still works for an install that has one, but nothing mints
    new ones: minting required proving a GitHub identity, and that is gone.
    """
    plow = os.environ.get("PLOW_AGENT_TOKEN")
    if plow:
        return {"authorization": "Bearer " + plow}
    return {"authorization": "Bearer " + token()}


# What a stored credential may look like now. A gho_/ghu_/ghp_ value is a
# GitHub bearer from before this client dropped GitHub; there is nothing left
# that can exchange it, and sending it as Plow auth would hand a GitHub token
# to a service that never had one -- so it is removed rather than used.
GITHUB_PREFIXES = ("gho_", "ghu_", "ghp_")


def purge_legacy_github_token(path=None):
    """Delete a stored GitHub bearer, wherever this run happens to be going.

    Deleted, not ignored: leaving it on disk leaves a live GitHub credential in
    a file whose whole point was to stop holding one. It has to happen on
    STARTUP rather than inside token(), because the case that matters most --
    a container that has PLOW_AGENT_TOKEN and a leftover gho_ from the old
    sign-in -- never reaches token() at all, so hanging the cleanup off the
    fallback path is a cleanup that runs precisely where it is not needed.

    Returns whether a token was actually removed, so nothing claims a deletion
    that a read-only mount or a permission refused.
    """
    path = path or TOKEN_PATH
    try:
        t = open(path).read().strip()
    except OSError:
        return False                    # absent, or not ours to read
    if not t.startswith(GITHUB_PREFIXES):
        return False
    try:
        os.remove(path)
    except OSError as e:
        # Stop the run. Continuing would leave a live GitHub credential in a
        # file this client can no longer use, on a machine whose owner believes
        # it is gone -- and the next run would find it and fail the same way,
        # silently, forever. A read-only home is a five-second fix once someone
        # is told; nothing tells them if we report normally.
        sys.exit(f"  a leftover GitHub token at {path} could NOT be removed: {e}\n"
                 f"  refusing to run while it is still there — delete it, or make "
                 f"{os.path.dirname(path)} writable")
    print("  removed a leftover GitHub token; this client no longer uses one")
    return True


def token(path=None):
    path = path or TOKEN_PATH
    if os.path.exists(path):
        t = open(path).read().strip()
        # A GitHub value cannot get past startup's purge, so reaching here with
        # one means the delete failed. Refuse it either way: sending it as Plow
        # auth would hand a GitHub token to a service that never wanted one.
        if t and not t.startswith(GITHUB_PREFIXES):
            return t
    sys.exit("no PLOW_AGENT_TOKEN in the environment, and no stored key.\n"
             "Inside a Plow container it is already there. Anywhere else, export the\n"
             "one Plow minted for your agent — agent-mgr writes it to that agent's\n"
             "own ~/.hermes-<agent>/.env, and a running container will print it:\n"
             "  export PLOW_AGENT_TOKEN=$(docker exec hermes-<agent> printenv PLOW_AGENT_TOKEN)")


def from_agentsview(days):
    """date -> model -> counters, for whatever agentsview covers."""
    exe = next((p for p in (os.path.expanduser("~/.local/bin/agentsview"),
                            "/opt/homebrew/bin/agentsview", "/usr/local/bin/agentsview")
                if os.access(p, os.X_OK)), None)
    if not exe:
        print("  agentsview not installed — skipping that collector")
        return {}
    try:
        raw = subprocess.run([exe, "usage", "daily", "--json"], capture_output=True,
                             text=True, timeout=120).stdout
        rows = json.loads(raw)
    except Exception as e:
        # Say it. Swallowing this made a broken agentsview indistinguishable
        # from an agent that did nothing, and the index would show it idle.
        FAILURES.append(f"agentsview: {type(e).__name__}: {e}")
        return {}
    rows = rows if isinstance(rows, list) else rows.get("daily") or rows.get("data") or []
    out = {}
    for r in rows[-days:]:
        models = {}
        for m in r.get("modelBreakdowns") or []:
            name = m.get("modelName") or m.get("model")
            if not name:
                continue
            models[name] = {"input": m.get("inputTokens") or 0,
                            "output": m.get("outputTokens") or 0,
                            "cache_read": m.get("cacheReadTokens") or 0,
                            "cache_write": m.get("cacheCreationTokens") or 0}
        if models:
            out[r["date"]] = models
    return out


STATE_PATH = os.path.expanduser("~/.agent-index/hermes-state.json")


def _load_state(path=None):
    """Previous counters and the per-day ledger. A corrupt file is not fatal:
    losing it costs one run's delta, while refusing to report costs every run."""
    path = path or STATE_PATH
    try:
        with open(path) as f:
            st = json.load(f)
        if isinstance(st, dict):
            return st
    except FileNotFoundError:
        return {}                       # never written: a genuine first run
    except (OSError, ValueError):
        pass
    # It exists and we cannot read it. That is a LOST ledger on an install that
    # has been reporting, not a fresh one, and the difference decides whether
    # the next run backfills. Say which it is rather than returning the same
    # empty dict for both.
    print(f"  state file at {path} is unreadable — rebaselining, reporting nothing this run")
    return {"unreadable": True}


def _save_state(path, state):
    """Written atomically at 0600 — a half-written ledger would misreport, and a
    partial rename would lose the baseline and re-dump history on the next run."""
    path = path or STATE_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, path)


def _has_usage_table(db):
    """A store without session_model_usage is not the one we want."""
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            return bool(c.execute(
                "SELECT 1 FROM sqlite_master WHERE name='session_model_usage'").fetchone())
        finally:
            c.close()
    except sqlite3.Error:
        return False


def from_hermes(days, home=None, state_path=None):
    """Hermes' own store, which agentsview indexes but reports as all zeros.

    Its four counters are disjoint (prompt = input + cache_read + cache_write)
    and reasoning is a subset of output, so nothing here is double counted.
    """
    # Try each known Hermes home and take the first store that really carries
    # the table. ~/.hermes can exist while holding a different schema, and the
    # old code errored on it instead of trying ~/.hermes-life next door, which
    # is where a Plow agent's store actually lives. Measured, not assumed.
    if home:
        homes = [home]
    elif os.environ.get("HERMES_HOME"):
        homes = [os.environ["HERMES_HOME"]]
    else:
        homes = [os.path.expanduser("~/.hermes"), os.path.expanduser("~/.hermes-life")]
    db = next((c for c in (os.path.join(h, "state.db") for h in homes)
               if os.path.exists(c) and _has_usage_table(c)), os.path.join(homes[0], "state.db"))
    legacy_lost = False
    # The store is resolved BEFORE the ledger moves anywhere: a wrong or unset
    # HERMES_HOME would otherwise move the only copy into a directory that holds
    # no store, and delete the original on the way. See the gate below.
    if state_path is None:
        # Beside the store it snapshots, NOT in the home directory. A container
        # recreated with a persistent Hermes volume but a fresh home lost the
        # ledger and the next run read as a first install -- which now means it
        # backfills, so the loss is not silent, it is wrong. Same volume as the
        # store means the two cannot be separated.
        state_path = os.path.join(os.path.dirname(db), ".agent-index-state.json")
        # Only migrate to a home that actually holds the store this ledger
        # describes. A misconfigured HERMES_HOME points at a directory with no
        # state.db, and moving the only ledger there -- then deleting the
        # original -- loses it for the correctly configured run that follows.
        # _has_usage_table, not os.path.exists: a state.db belonging to something
        # else passes an existence check, and the ledger would be moved and the
        # original deleted before the missing table is ever discovered. The
        # resolver above already prefers a store that carries the table; this
        # refuses to migrate when it had to fall back to one that does not.
        if (_has_usage_table(db) and not os.path.exists(state_path)
                and os.path.exists(STATE_PATH)):
            # An install that predates this move already has a ledger. Carrying
            # it over is the whole point: leaving it behind would cause exactly
            # the re-baseline this change exists to prevent.
            legacy = _load_state(STATE_PATH)
            if legacy.get("unreadable"):
                # Corrupt, but its EXISTENCE is the fact that matters: this
                # install has been reporting. Dropping the marker here left the
                # destination looking untouched, which reads as a first install
                # and replays -- the corrupt case sneaking back in through the
                # migration instead of the front door.
                legacy_lost = True
            elif legacy:
                # Copy, verify, then delete. The original is the only copy until
                # the new one is readable and says what the old one said.
                _save_state(state_path, legacy)
                if _load_state(state_path) == legacy:
                    try:
                        os.remove(STATE_PATH)
                    except OSError:
                        pass            # readable but not removable: harmless, it is no longer read
                    print(f"  moved the usage ledger next to the Hermes store ({state_path})")
                else:
                    # Keep both rather than lose one. The destination is what
                    # gets read from here, and the original is still there to
                    # recover from if it turns out to be wrong.
                    print(f"  copied the usage ledger to {state_path}, keeping {STATE_PATH}")
    if not os.path.exists(db):
        # Say so. A wrong HERMES_HOME otherwise reports zero tokens, which
        # reads as an idle agent rather than a misconfiguration — and inside a
        # container nobody is watching the path resolve.
        print(f"  no Hermes store at {db} (set HERMES_HOME if that is wrong)")
        return {}
    # Snapshot-and-diff, because the counters are CUMULATIVE per session.
    #
    # session_model_usage holds one row per (session, model, provider, base_url,
    # mode, task) whose counters accumulate for the life of that session. Any
    # attempt to date those totals by a column on the row is wrong:
    #   - grouping on started_at put weeks of tokens on the day a chat opened,
    #     and reported ZERO once that day left the window while the agent was busy;
    #   - grouping on last_seen put a session's ENTIRE lifetime on its last active
    #     day, so one long-lived chat published all its pre-window history as
    #     today's usage. Measured: 13.6% of tokens landing on the wrong day.
    # There is no per-day billed source to date them by instead — messages.token_count
    # is NULL on every row and carries no model — so the only correct answer is to
    # remember what we last saw and report the difference.
    #
    # Each run diffs the current counters against the previous snapshot and credits
    # the difference to TODAY, then accumulates into a local per-day ledger. The
    # ledger matters: the server upserts a (agent, user, date, model) row with
    # DO UPDATE SET = excluded, replacing it, so sending just the newest delta would
    # clobber earlier deltas from the same day. We send the day's running total.
    #
    # The first run has no snapshot to diff against. Reporting nothing at all
    # was a real gap -- an agent used for months, opted in, then quiet never
    # reports anything, because "no further deltas" is exactly what a finished
    # agent produces -- but the counters are CUMULATIVE per session, so a
    # session that ran across 40 days cannot be split into days, and pinning its
    # lifetime to any single one of them invents a day's usage.
    #
    # A session whose first_seen and last_seen fall on the SAME day can be
    # placed, because every token it holds was spent that day. Those are
    # backfilled; anything spanning days, or undated, is baselined and reported
    # from the next run on. That is the whole truthful subset, and it is most of
    # a real store.
    state = _load_state(state_path)
    # `snapshot` MISSING means we have never looked; `snapshot` present but
    # EMPTY means we looked and the agent had not run yet. Conflating the two
    # cost a brand-new agent its first session permanently: the empty snapshot
    # read as "never baselined", so the first run that finally found rows
    # re-baselined and reported nothing. A fresh install has no data by
    # definition, which made this the normal path, not an edge case.
    snap = state.get("snapshot")
    # MISSING snapshot means one of two very different things. A state file that
    # was never written is a first run, and its dated history can be placed. A
    # state file that exists but will not parse is a LOST ledger on an install
    # that has already been reporting -- backfilling there would republish
    # today's same-day sessions as a whole new day's total, over reports that
    # were already correct. So: baseline it, report nothing, resume next run.
    # A lost ledger is not a first run and not a normal run either: with no
    # snapshot, every counter would diff against zero and the whole lifetime of
    # every session would land on today, over reports that were already correct.
    # It re-snapshots and credits nothing.
    lost = bool(state.get("unreadable")) or legacy_lost
    fresh_install = snap is None and not lost
    snap, ledger = snap or {}, state.get("daily") or {}
    cur, today = {}, datetime.date.today().isoformat()
    # The row's identity is its primary key, but older stores predate some of
    # those columns. Take whichever exist: dropping one only risks merging two
    # rows that differ solely by it, and their deltas still sum correctly.
    try:
        c = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        try:
            have = {r[1] for r in c.execute("PRAGMA table_info(session_model_usage)")}
            keycols = [k for k in ("session_id", "model", "billing_provider",
                                   "billing_base_url", "billing_mode", "task") if k in have]
            sel = ", ".join(f"COALESCE({k},'')" for k in keycols)
            # last_seen is when this session last spent anything, so it is the
            # day those tokens belong to. Older stores predate the column; they
            # get the old behaviour rather than a guess.
            dated = "last_seen" in have and "first_seen" in have
            rows = c.execute(
                f"""SELECT {sel}, COALESCE(input_tokens,0), COALESCE(output_tokens,0),
                           COALESCE(cache_read_tokens,0), COALESCE(cache_write_tokens,0),
                           {"COALESCE(first_seen,0), COALESCE(last_seen,0)" if dated else "0, 0"}
                    FROM session_model_usage""").fetchall()
        finally:
            c.close()
    except sqlite3.Error as e:
        FAILURES.append(f"hermes store {db}: {e}")
        return {}

    n = len(keycols)
    mi = keycols.index("model") if "model" in keycols else None
    fresh = fresh_install

    def _day(ts):
        try:
            return datetime.date.fromtimestamp(float(ts)).isoformat() if ts else None
        except (OverflowError, OSError, ValueError):
            return None

    def day_of(first_seen, last_seen):
        """The one day a session's whole total belongs to, or None if there is
        no such day -- it spanned several, or the store cannot say.

        Clamped to today: a clock skewed forward would otherwise open a day in
        the future that no window reports and nothing can correct."""
        a, b = _day(first_seen), _day(last_seen)
        return min(b, today) if a and a == b else None

    for row in rows:
        key = "\x1f".join(str(x) for x in row[:n])
        m = str(row[mi]) if mi is not None else "unknown"
        if not m:
            m = "unknown"
        i, o, cr, cw = row[n:n + 4]
        cur[key] = [i, o, cr, cw]
        if lost:
            continue
        placed = day_of(row[n + 4], row[n + 5]) if fresh else None
        if fresh and placed is None:
            # It spanned days, or is undated: any day we picked would be
            # invented. Baseline it and report from the next run on.
            continue
        prev = snap.get(key) or [0, 0, 0, 0]
        # A counter that went backwards means the session was reset or replaced;
        # credit nothing rather than a negative, which would silently subtract
        # from a day that was already reported correctly.
        d = [max(0, n - p) for n, p in zip(cur[key], prev)]
        if not any(d):
            continue
        # A delta seen since the last run was spent since the last run, so it
        # belongs to today. Only a first-run backfill places a session anywhere
        # else, and only when its own timestamps name a single day.
        day = ledger.setdefault(placed or today, {})
        acc = day.setdefault(m, {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
        acc["input"] += d[0]; acc["output"] += d[1]
        acc["cache_read"] += d[2]; acc["cache_write"] += d[3]

    # Keep the ledger bounded; nothing older than the window can be reported.
    cutoff = (datetime.date.today() - datetime.timedelta(days=max(days, 28) + 7)).isoformat()
    ledger = {d: v for d, v in ledger.items() if d >= cutoff}
    _save_state(state_path, {"version": 1, "snapshot": cur, "daily": ledger})
    if fresh:
        filled = len(ledger)
        print(f"  Hermes baseline recorded — {filled} day(s) of same-day history recovered."
              if filled else
              "  Hermes baseline recorded — usage is reported from the next run on.")
    window = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    return {d: v for d, v in ledger.items() if d >= window and any(
        any(x.values()) for x in v.values())}


def merge(*sources):
    """Same (day, model) from two collectors adds up rather than one winning."""
    out = defaultdict(lambda: defaultdict(lambda: dict.fromkeys(KEYS, 0)))
    for src in sources:
        for date, models in src.items():
            for model, row in models.items():
                for k in KEYS:
                    out[date][model][k] += int(row.get(k) or 0)
    return [{"date": d, "models": [{"model": m, **v} for m, v in sorted(ms.items())]}
            for d, ms in sorted(out.items())]


def tags():
    """Tags already in use across the index, commonest first.

    Pick from these rather than inventing a near-duplicate: "Orders & returns"
    and "Order returns" would split one bar in two and nothing would line up
    across agents.
    """
    req = urllib.request.Request(f"{API}/v1/tags", headers={"accept": "application/json"})
    with _open_no_redirect(req) as r:
        return json.loads(r.read()).get("tags", [])


def register(agent, argv):
    """Create this agent's row on the Index, so it has a page to report into.

    Registration is refused a key we issued ourselves, because claiming an id
    is the one thing its owner cannot undo. It takes the container's Plow
    token, which only Plow can vouch for, so a stranger's whole path is: curl
    the file, --register, then run it on a timer.
    """
    def opt(flag, default=None):
        return argv[argv.index(flag) + 1] if flag in argv else default
    body = {k: v for k, v in {
        "name": opt("--name"), "blurb": opt("--blurb"), "repo": opt("--repo"),
        "runtime": opt("--runtime"), "builder_name": opt("--builder-name"),
        "builder_handle": (opt("--builder-handle") or "").lstrip("@") or None,
    }.items() if v}
    if opt("--video"):
        # The page embeds youtube-nocookie.com/embed/<id>, so this is an id,
        # not a URL — passing a URL renders a broken player on a public page.
        vid = opt("--video")
        if "/" in vid or ":" in vid:
            sys.exit("  --video takes a YouTube VIDEO ID, not a URL (e.g. Q_RAgwbsjGw)")
        body["video"] = {"provider": "youtube", "id": vid, "title": opt("--name") or agent}
    images = [argv[i + 1] for i, a in enumerate(argv) if a == "--image"]
    if images:
        body["images"] = images

    code, out = _post(f"{API}/v1/agents?agent_id={agent}", body, auth_headers())
    if code != 200:
        sys.exit(f"  registration failed: {code} {out}")
    print(f"  {out.get('result')} {agent} — {out.get('url')}")
    if out.get("dropped"):
        # The server tells us what it threw away; passing that silently on
        # would recreate exactly the trap the server side just removed.
        print(f"  WARNING: some values were not stored: {out['dropped']}")
    print("  Now run it on a timer to report usage.")
    return 0


def publish_story(agent, argv):
    """Publish one thing this agent did: a title, what happened, up to 3 tags."""
    def opt(flag, default=None):
        return argv[argv.index(flag) + 1] if flag in argv else default
    story_id = opt("--story")
    title = opt("--title")
    if not story_id or not title:
        sys.exit("--story ID and --title TEXT are both required")
    chosen = [argv[i + 1] for i, a in enumerate(argv) if a == "--tag"][:3]
    if len(chosen) > 3:
        sys.exit("at most 3 tags")
    body = {
        "story_id": story_id, "title": title, "body": opt("--body", ""),
        "tags": chosen,
        "images": [{"url": u, "caption": ""} for i, a in enumerate(argv) if a == "--image" for u in [argv[i + 1]]],
    }
    code, out = _post(f"{API}/v1/stories?agent_id={agent}", body,
                      auth_headers())
    print(f"  {code} {out}")
    sys.exit(0 if code == 200 else 1)


VALUE_FLAGS = {"--agent", "--days", "--title", "--body", "--tag", "--image",
               "--name", "--blurb", "--repo", "--runtime", "--video",
               "--builder-name", "--builder-handle"}
KNOWN_FLAGS = {"--self-check", "--register", "--agent", "--tags", "--story",
               "--title", "--body", "--tag", "--image", "--days", "--dry-run",
               "--name", "--blurb", "--repo", "--runtime", "--video",
               "--builder-name", "--builder-handle", "--help", "-h"}


def _unknown_flags(argv):
    """Flags we do not recognise, ignoring the VALUES of value-taking flags.

    A story body legitimately starts with a dash ("-1 week of work..."), so
    scanning every dash-leading token rejected exactly the use cases agents
    publish. Skip the token after a value flag.
    """
    unknown, skip = [], False
    for a in argv:
        if skip:
            skip = False
            continue
        if a in VALUE_FLAGS:
            skip = True
            continue
        if a.startswith("-") and a not in KNOWN_FLAGS:
            unknown.append(a)
    return unknown


def main(argv):
    # Reject unknown flags BEFORE any collection or POST. Without this, main()
    # fell through to the live _post for anything it did not recognise, so
    # `client.py --help` — the first thing a new user types — silently sent a
    # real report to production. An unrecognised flag is a typo, not consent.
    # Skip the VALUE after a value-taking flag: a story body legitimately starts
    # with a dash ("-1 week of work..."), and treating it as an unknown option
    # rejected exactly the use cases agents publish.
    unknown = _unknown_flags(argv)
    if "--help" in argv or "-h" in argv or unknown:
        if unknown:
            print(f"unknown option: {unknown[0]}\n", file=sys.stderr)
        print(__doc__.strip(), file=sys.stderr)
        return 2 if unknown else 0
    # --self-check first: it is an offline assertion run that needs no
    # credential, and `just test` inherits the developer's real HOME -- purging
    # first deleted the token off the machine of whoever ran the tests.
    if "--self-check" in argv:
        return self_check()
    purge_legacy_github_token()
    agent = argv[argv.index("--agent") + 1] if "--agent" in argv else os.environ.get("AGENT_ID")
    if not agent:
        sys.exit(__doc__)
    if "--register" in argv:
        return register(agent, argv)
    if "--tags" in argv:
        for t in tags():
            print(f"  {t['tag']:<28} {t['uses']} uses across {t['agents']} agent(s)")
        return
    if "--story" in argv:
        return publish_story(agent, argv)
    days = int(argv[argv.index("--days") + 1]) if "--days" in argv else 28
    payload = {"days": merge(from_agentsview(days), from_hermes(days))}
    total = sum(m[k] for d in payload["days"] for m in d["models"] for k in KEYS)
    for f in FAILURES:
        print(f"  COLLECTOR FAILED — {f}")
    print(f"  agent={agent} days={len(payload['days'])} tokens={total:,}")
    if not payload["days"]:
        if FAILURES:
            # Reporting nothing here would publish "idle" for an agent we simply
            # failed to read. Exit non-zero so a supervisor notices.
            sys.exit("  every collector failed and nothing was collected — NOT reporting")
        print("  nothing collected — check HERMES_HOME and that agentsview is installed")
    if "--dry-run" in argv:
        return print(json.dumps(payload, indent=1)[:2000])
    if not payload["days"]:
        # Announce that we are measuring but have nothing yet, so the page can
        # say "measurement pending" instead of implying the agent is idle. The
        # server latches once real usage lands, so sending this on a genuinely
        # quiet day cannot reopen the state.
        #
        # Best-effort and SILENT by deliberate design. This runs at container
        # boot, when the network is least likely to be up, and the announcement
        # is not the measurement: letting it fail a run would mean a new agent's
        # first act dies on a network hiccup, having measured and lost nothing.
        # token() exits the process when there is no credential, and SystemExit
        # is a BaseException that `except Exception` would not catch — so check
        # that a credential EXISTS before announcing, rather than letting a
        # quiet run on an unconfigured machine turn into a failure.
        #
        # The check is "have we any credential", not "is there a token file":
        # a container has PLOW_AGENT_TOKEN and no file at all, and gating on
        # the file skipped the announcement for exactly the installs this
        # client now exists to serve.
        if os.environ.get("PLOW_AGENT_TOKEN") or os.path.exists(TOKEN_PATH):
            try:
                _post(f"{API}/v1/usage?agent_id={agent}", {"days": [], "status": "pending"},
                      auth_headers())
            except Exception:
                pass
        return print("  nothing to report yet — measuring from the next run")
    code, body = _post(f"{API}/v1/usage?agent_id={agent}", payload,
                       auth_headers())
    print(f"  {code} {body}")
    sys.exit(0 if code == 200 else 1)


def self_check():
    a = {"2026-09-01": {"gpt": {"input": 1, "output": 2, "cache_read": 0, "cache_write": 0}}}
    h = {"2026-09-01": {"gpt": {"input": 10, "output": 0, "cache_read": 5, "cache_write": 0}},
         "2026-08-31": {"opus": {"input": 3, "output": 4, "cache_read": 0, "cache_write": 0}}}
    m = merge(a, h)
    assert [d["date"] for d in m] == ["2026-08-31", "2026-09-01"], m
    gpt = [x for x in m[1]["models"] if x["model"] == "gpt"][0]
    assert gpt == {"model": "gpt", "input": 11, "output": 2, "cache_read": 5, "cache_write": 0}, gpt
    assert merge({}, {}) == [], "no data must send no days, not a day of zeros"
    assert from_hermes(28, home="/nonexistent") == {}, "a missing store is empty, not a crash"

    # The counters are CUMULATIVE per session, so the collector diffs against a
    # snapshot rather than dating them by a column. These assertions pin the
    # behaviour the last_seen version got wrong: a long-lived session that is
    # merely ACTIVE today must not republish its lifetime as today's usage.
    import tempfile
    def make_store(dirpath, rows=(), keyed=False):
        """A Hermes store to diff against.

        `keyed` adds the columns that make up a row's identity. Older stores do
        not have them and the collector takes whichever exist, so both shapes
        have to be exercised -- that is the only reason there is a flag here.
        """
        cols = ("session_id TEXT, model TEXT, billing_provider TEXT,"
                " billing_base_url TEXT, billing_mode TEXT, task TEXT," if keyed
                else "session_id TEXT, model TEXT,")
        c = sqlite3.connect(os.path.join(dirpath, "state.db"))
        c.execute(f"CREATE TABLE session_model_usage ({cols}"
                  " input_tokens INT, output_tokens INT, cache_read_tokens INT,"
                  " cache_write_tokens INT, first_seen REAL, last_seen REAL)")
        for row in rows:
            c.execute(f"INSERT INTO session_model_usage VALUES ({','.join('?' * len(row))})", row)
        c.commit()
        return c

    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "state.db")
        st = os.path.join(tmp, "state.json")
        now = time.time()
        c = make_store(tmp, keyed=True, rows=[
            ("s1", "gpt-5.5", "", "", "", "", 1000, 2000, 3000, 4000,
             now - 40 * 86400, now - 3600),
        ])

        assert from_hermes(28, home=tmp, state_path=st) == {}, \
            "the first run records a baseline and reports nothing"
        today = datetime.date.today().isoformat()

        assert from_hermes(28, home=tmp, state_path=st) == {}, \
            "an unchanged session must not republish its lifetime total"

        c.execute("UPDATE session_model_usage SET input_tokens = 1050 WHERE session_id='s1'")
        c.commit()
        got = from_hermes(28, home=tmp, state_path=st)
        assert got == {today: {"gpt-5.5": {"input": 50, "output": 0,
                                           "cache_read": 0, "cache_write": 0}}}, got

        # A second run the same day ACCUMULATES rather than replacing: the server
        # upserts a day's row with DO UPDATE SET = excluded, so sending only the
        # newest delta would clobber the earlier one.
        c.execute("UPDATE session_model_usage SET output_tokens = 2007 WHERE session_id='s1'")
        c.commit()
        got = from_hermes(28, home=tmp, state_path=st)
        assert got[today]["gpt-5.5"] == {"input": 50, "output": 7,
                                         "cache_read": 0, "cache_write": 0}, got

        # A counter going backwards (session reset) credits nothing, never a
        # negative that would subtract from an already-correct day.
        c.execute("UPDATE session_model_usage SET input_tokens = 1 WHERE session_id='s1'")
        c.commit()
        got = from_hermes(28, home=tmp, state_path=st)
        assert got[today]["gpt-5.5"]["input"] == 50, f"no negative delta: {got}"

        c.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                  ("s1", "claude-opus-5", "", "", "", "", 9, 0, 0, 0, now, now))
        c.commit()
        got = from_hermes(28, home=tmp, state_path=st)
        assert got[today]["claude-opus-5"]["input"] == 9, got
        c.close()

        # A BRAND-NEW agent: the first run finds an empty store, so there is
        # nothing to baseline. Its first real turn must still be reported —
        # treating the empty snapshot as "never baselined" silently ate a new
        # agent's first session, which is the most visible session it has.
        with tempfile.TemporaryDirectory() as fresh_home:
            st2 = os.path.join(fresh_home, "state.json")
            c2 = make_store(fresh_home)
            assert from_hermes(28, home=fresh_home, state_path=st2) == {}, \
                "an empty store reports nothing"
            c2.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?)",
                       ("first", "gpt-5.5", 100, 20, 0, 0, time.time(), time.time()))
            c2.commit()
            got = from_hermes(28, home=fresh_home, state_path=st2)
            c2.close()
            assert got and list(got.values())[0]["gpt-5.5"]["input"] == 100, \
                f"a new agent's FIRST turn must be reported, not swallowed: {got}"

        # An agent USED BEFORE it opted in. Its finished same-day sessions land
        # on the days they actually ran, so an agent that goes quiet right after
        # opting in still reports the work it did -- "no further deltas" is
        # exactly what a finished agent produces, and reporting nothing left it
        # blank forever. A session that spanned days holds one cumulative number
        # for all of them, so it cannot be split and is not invented onto one.
        with tempfile.TemporaryDirectory() as used:
            st3 = os.path.join(used, "state.json")
            # Midday, so an hour either side cannot cross midnight and flake.
            ran = datetime.date.today() - datetime.timedelta(days=3)
            noon = datetime.datetime.combine(ran, datetime.time(12, 0)).timestamp()
            c3 = make_store(used, rows=[
                ("done", "gpt-5.5", 7, 3, 0, 0, noon, noon + 3600),
                ("spanning", "gpt-5.5", 500, 0, 0, 0, noon - 9 * 86400, noon),
            ])
            got = from_hermes(28, home=used, state_path=st3)
            c3.close()
            assert list(got) == [ran.isoformat()], \
                f"a finished same-day session belongs to the day it ran: {got}"
            assert got[ran.isoformat()]["gpt-5.5"] == {"input": 7, "output": 3,
                                                       "cache_read": 0, "cache_write": 0}, got

        # The ledger lives next to the store, not in the home directory: a
        # container recreated with a persistent Hermes volume and a fresh home
        # would otherwise lose it and re-baseline. An install that predates the
        # move carries its ledger across rather than starting over.
        with tempfile.TemporaryDirectory() as moved:
            c4 = make_store(moved, rows=[("s", "gpt-5.5", 100, 0, 0, 0, time.time(), time.time())])
            beside = os.path.join(moved, ".agent-index-state.json")
            from_hermes(28, home=moved)
            assert os.path.exists(beside), "the ledger belongs beside the store it snapshots"

            # And a run that finds a legacy ledger in the home directory adopts
            # it instead of treating the install as new.
            os.remove(beside)
            legacy_home = tempfile.mkdtemp()
            os.makedirs(os.path.join(legacy_home, ".agent-index"))
            legacy = os.path.join(legacy_home, ".agent-index", "hermes-state.json")
            _save_state(legacy, {"version": 1, "snapshot": {"x": [1, 1, 1, 1]}, "daily": {}})
            global STATE_PATH
            was, STATE_PATH = STATE_PATH, legacy
            try:
                import contextlib, io
                buf = io.StringIO()
                with contextlib.redirect_stdout(buf):
                    from_hermes(28, home=moved)
                said = buf.getvalue()
                assert os.path.exists(beside), "the legacy ledger must be carried over"
                assert not os.path.exists(legacy), "and not left behind to be read again"
                # The point of carrying it: this install is NOT new, so the run
                # must not baseline. (The snapshot it saves is the store as it
                # is now -- that part is supposed to be replaced every run.)
                assert "baseline recorded" not in said, \
                    f"an install with a ledger must not start over: {said}"
            finally:
                STATE_PATH = was

            # A WRONG home must not consume the ledger. HERMES_HOME pointing
            # somewhere with no store is a configuration mistake, and moving the
            # only copy there -- then deleting the original -- turns it into
            # data loss for the run that gets it right afterwards.
            os.remove(beside)
            nowhere = tempfile.mkdtemp()          # no state.db in it
            keep_home = tempfile.mkdtemp()
            os.makedirs(os.path.join(keep_home, ".agent-index"))
            keep = os.path.join(keep_home, ".agent-index", "hermes-state.json")
            _save_state(keep, {"version": 1, "snapshot": {"y": [2, 2, 2, 2]}, "daily": {}})
            was, STATE_PATH = STATE_PATH, keep
            try:
                from_hermes(28, home=nowhere)
                assert os.path.exists(keep), "a home with no store must not consume the ledger"
                assert not os.path.exists(os.path.join(nowhere, ".agent-index-state.json")), \
                    "and must not leave a ledger where there is nothing to snapshot"
                # The correctly configured run still gets it.
                from_hermes(28, home=moved)
                assert os.path.exists(beside) and not os.path.exists(keep), \
                    "the right home adopts it"
            finally:
                STATE_PATH = was

            # A state.db belonging to something ELSE is not a Hermes store.
            # It passes an existence check, so the ledger was moved and the
            # original deleted before the missing table was ever discovered.
            os.remove(beside)
            impostor = tempfile.mkdtemp()
            sqlite3.connect(os.path.join(impostor, "state.db")).close()   # no usage table
            other_home = tempfile.mkdtemp()
            os.makedirs(os.path.join(other_home, ".agent-index"))
            other = os.path.join(other_home, ".agent-index", "hermes-state.json")
            _save_state(other, {"version": 1, "snapshot": {"z": [3, 3, 3, 3]}, "daily": {}})
            was, STATE_PATH = STATE_PATH, other
            try:
                from_hermes(28, home=impostor)
                assert os.path.exists(other), \
                    "a database with no usage table must not consume the ledger"
                assert not os.path.exists(os.path.join(impostor, ".agent-index-state.json"))
            finally:
                STATE_PATH = was
            from_hermes(28, home=moved)          # put the ledger back for the next case

            # A CORRUPT legacy ledger is still evidence that this install has
            # been reporting. Recognising it and then dropping it left the
            # destination absent, which reads as a first install and replays --
            # the migration letting the corrupt case in through the side door.
            os.remove(beside)
            broken_home = tempfile.mkdtemp()
            os.makedirs(os.path.join(broken_home, ".agent-index"))
            broken = os.path.join(broken_home, ".agent-index", "hermes-state.json")
            open(broken, "w").write("{not json")
            was, STATE_PATH = STATE_PATH, broken
            try:
                assert from_hermes(28, home=moved) == {}, \
                    "a corrupt ledger in the old location must not become a replay"
            finally:
                STATE_PATH = was
            c4.close()

        # A corrupt state file costs the ledger, never the whole report, and it
        # must not be mistaken for a first run: this install has been reporting,
        # so anything "recovered" here would land on top of days that were
        # already right. It re-snapshots, reports nothing, resumes next run.
        open(st, "w").write("{not json")
        assert from_hermes(28, home=tmp, state_path=st) == {}, \
            "a lost ledger rebaselines rather than replaying history onto today"
        c = sqlite3.connect(db)
        c.execute("UPDATE session_model_usage SET input_tokens = 2 WHERE session_id='s1'")
        c.commit(); c.close()
        got = from_hermes(28, home=tmp, state_path=st)
        assert got[today]["gpt-5.5"]["input"] == 1, \
            f"and the run after it reports the delta, not the lifetime: {got}"

    # --video takes a YouTube id because the page embeds
    # youtube-nocookie.com/embed/<id>; a URL there renders a broken player on a
    # public page. Reject it before anything is sent, so a typo costs a message
    # rather than a live page with a broken player on it.
    # Every child here re-enters main(), which purges a legacy token on startup.
    # Run them against a throwaway HOME: `just test` inherits a developer's real
    # one, and a test run must not delete a credential on their machine.
    with tempfile.TemporaryDirectory() as sandbox:
        child_env = dict(os.environ, HOME=sandbox)
        for bad in ("https://youtu.be/abc", "youtube.com/watch?v=abc"):
            r = subprocess.run([sys.executable, os.path.abspath(__file__),
                                "--register", "--agent", "x", "--video", bad],
                               capture_output=True, text=True, env=child_env)
            assert r.returncode != 0 and "VIDEO ID" in r.stdout + r.stderr, \
                f"a video URL must be refused before it is sent: {bad} -> {r.stdout+r.stderr}"
            assert "registration failed" not in r.stdout, \
                "the arguments must be checked before anything is sent"

    # A Plow container carries its own token and needs no sign-in at all, and
    # it must be PREFERRED over any stored key: the key is a leftover from the
    # GitHub era and nothing mints new ones.
    os.environ["PLOW_AGENT_TOKEN"] = "plow_tok_selfcheck"
    try:
        h = auth_headers()
        assert h["authorization"] == "Bearer plow_tok_selfcheck", h
    finally:
        del os.environ["PLOW_AGENT_TOKEN"]


    # An unreachable server is a reported failure, not a traceback in a
    # supervised loop's logs. Port 9 is discard: nothing listens there.
    code, body = _post("http://127.0.0.1:9/v1/usage", {"days": []}, {})
    assert code == 0 and "could not reach" in body.get("error", ""), (code, body)

    # A quiet run must never fail because we could not ANNOUNCE that it was
    # quiet. The announcement is not the measurement.
    with tempfile.TemporaryDirectory() as empty_home:
        quiet = subprocess.run(
            [sys.executable, os.path.abspath(__file__), "--agent", "selfcheck-none"],
            capture_output=True, text=True,
            env={**os.environ, "HERMES_HOME": "/nonexistent", "HOME": empty_home,
                 "AGENT_INDEX_API": "http://127.0.0.1:9"})
    assert "Traceback" not in quiet.stderr, \
        f"a quiet run must not crash, with or without a reachable server: {quiet.stderr[-300:]}"
    assert quiet.returncode == 0, \
        f"a quiet run reports nothing and succeeds; it must not fail: {quiet.stdout[-200:]}"

    assert _unknown_flags(["--oops"]) == ["--oops"], "a typo must be caught"
    assert _unknown_flags(["--body", "-1 week of work"]) == [], \
        "a dash-leading VALUE is not a flag"
    assert _unknown_flags(["--dry-run", "--agent", "x"]) == [], "known flags pass"
    assert _unknown_flags(["--body", "-a", "--oops"]) == ["--oops"], \
        "a typo after a skipped value is still caught"

    print("self-check OK — merge, flag parsing, and the Hermes delta collector")


if __name__ == "__main__":
    main(sys.argv[1:])
