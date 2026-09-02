#!/usr/bin/env python3
"""Publish one agent's token usage to the Agent Index.

    agent_index_client.py --agent life --login      # once: prove your GitHub
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
no file paths, no costs. Identity is your GitHub account, proven once by device
flow; the token is stored 0600 and only ever sent to github.com and the index.
"""
import datetime
import json, os, sqlite3, subprocess, sys, time, urllib.error, urllib.request
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

CLIENT_ID = "Ov23lirUZHTGqWCMVUXV"          # public by design; device flow uses no secret
API = os.environ.get("AGENT_INDEX_API", "https://agent-index-server.vercel.app")
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
    return urllib.request.build_opener(_NoRedirect).open(req, timeout=timeout)


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
        return 0, {"error": f"could not reach {url}: {e.reason}"}


def _write_token(value, path=None):
    """0600, and the directory too: a world-readable parent makes the mode moot."""
    path = path or TOKEN_PATH
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        os.chmod(os.path.dirname(path), 0o700)
    except OSError:
        pass
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(value)


def login():
    """GitHub device flow. Works with no browser on this machine and no secret."""
    # No scope. The server only reads the `login` field of GET /user, which is
    # public profile data and needs no scope at all — verified against a token
    # holding gist/read:org/repo and NOT read:user, which still returned it.
    # This token is forwarded on every report, so it should grant as close to
    # nothing as GitHub allows.
    _, d = _post("https://github.com/login/device/code",
                 {"client_id": CLIENT_ID, "scope": ""}, {})
    if "device_code" not in d:
        sys.exit(f"github refused the device request: {d}")
    print(f"\n  Open {d['verification_uri']} and enter:  {d['user_code']}\n")
    deadline = time.time() + int(d.get("expires_in", 900))
    interval = int(d.get("interval", 5))
    while time.time() < deadline:
        time.sleep(interval)
        _, t = _post("https://github.com/login/oauth/access_token",
                     {"client_id": CLIENT_ID, "device_code": d["device_code"],
                      "grant_type": "urn:ietf:params:oauth:grant-type:device_code"}, {})
        if t.get("access_token"):
            # Exchange the GitHub bearer for an Index-scoped key and keep only
            # that. 0600 stops other Unix users, but the agent's own runtime
            # runs as the same user and a prompt-injected turn can read its
            # credential file — so what sits there must be worth as little as
            # possible. This key reports usage and publishes stories, both of
            # which its owner can undo; it is refused by agent registration,
            # which is the one permanent act (a claimed id cannot be released).
            # Revoke it with DELETE /v1/keys using the GitHub login.
            code, k = _post(f"{API}/v1/keys", {"label": os.uname().nodename[:80]},
                            {"Authorization": "Bearer " + t["access_token"]})
            if code != 200 or not k.get("key"):
                sys.exit(f"  could not mint an Index key: {k}")
            _write_token(k["key"])
            print(f"  Signed in as {k.get('login')}. Index-scoped key stored at "
                  f"{TOKEN_PATH} (0600); the GitHub token was discarded.")
            return k["key"]
        if t.get("error") == "slow_down":
            interval += int(t.get("interval", 5))
        elif t.get("error") not in ("authorization_pending", None):
            sys.exit(f"  device flow failed: {t.get('error_description') or t['error']}")
    sys.exit("  code expired, run --login again")


def token(path=None):
    path = path or TOKEN_PATH
    if not os.path.exists(path):
        sys.exit("no token — run with --login first")
    t = open(path).read().strip()
    if not t.startswith(("gho_", "ghu_", "ghp_")):
        return t
    # An instance authorised before scoped keys existed still holds the GitHub
    # bearer on disk, where the agent's own runtime can read it. Upgrade on any
    # run rather than only on --login: a supervisor never calls --login, so the
    # old credential would sit there until a human remembered a documented
    # step, and documented one-time steps get skipped. The bearer is still
    # valid, so the exchange needs nobody present.
    try:
        code, k = _post(f"{API}/v1/keys", {"label": os.uname().nodename[:80]},
                        {"Authorization": "Bearer " + t})
        if code == 200 and k.get("key"):
            _write_token(k["key"], path)
            print("  upgraded the stored GitHub token to an Index-scoped key")
            return k["key"]
    except Exception:
        pass
    # Offline, or the server is down. Keep reporting with what we have rather
    # than failing the run; the next run tries again.
    return t


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
    try:
        with open(path or STATE_PATH) as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


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
    # The first run has nothing to diff against, so it records a baseline and
    # reports nothing rather than dumping all history onto today — the very bug
    # this replaces. History before the first run is not recoverable and is not
    # meant to be.
    state = _load_state(state_path)
    # `snapshot` MISSING means we have never looked; `snapshot` present but
    # EMPTY means we looked and the agent had not run yet. Conflating the two
    # cost a brand-new agent its first session permanently: the empty snapshot
    # read as "never baselined", so the first run that finally found rows
    # re-baselined and reported nothing. A fresh install has no data by
    # definition, which made this the normal path, not an edge case.
    snap = state.get("snapshot")
    fresh_install = snap is None
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
            rows = c.execute(
                f"""SELECT {sel}, COALESCE(input_tokens,0), COALESCE(output_tokens,0),
                           COALESCE(cache_read_tokens,0), COALESCE(cache_write_tokens,0)
                    FROM session_model_usage""").fetchall()
        finally:
            c.close()
    except sqlite3.Error as e:
        FAILURES.append(f"hermes store {db}: {e}")
        return {}

    n = len(keycols)
    mi = keycols.index("model") if "model" in keycols else None
    fresh = fresh_install
    for row in rows:
        key = "\x1f".join(str(x) for x in row[:n])
        m = str(row[mi]) if mi is not None else "unknown"
        if not m:
            m = "unknown"
        i, o, cr, cw = row[n:]
        cur[key] = [i, o, cr, cw]
        if fresh:
            continue
        prev = snap.get(key) or [0, 0, 0, 0]
        # A counter that went backwards means the session was reset or replaced;
        # credit nothing rather than a negative, which would silently subtract
        # from a day that was already reported correctly.
        d = [max(0, n - p) for n, p in zip(cur[key], prev)]
        if not any(d):
            continue
        day = ledger.setdefault(today, {})
        acc = day.setdefault(m, {"input": 0, "output": 0, "cache_read": 0, "cache_write": 0})
        acc["input"] += d[0]; acc["output"] += d[1]
        acc["cache_read"] += d[2]; acc["cache_write"] += d[3]

    # Keep the ledger bounded; nothing older than the window can be reported.
    cutoff = (datetime.date.today() - datetime.timedelta(days=max(days, 28) + 7)).isoformat()
    ledger = {d: v for d, v in ledger.items() if d >= cutoff}
    _save_state(state_path, {"version": 1, "snapshot": cur, "daily": ledger})
    if fresh:
        print("  Hermes baseline recorded — usage is reported from the next run on.")
        return {}
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
                      {"authorization": f"Bearer {token()}"})
    print(f"  {code} {out}")
    sys.exit(0 if code == 200 else 1)


VALUE_FLAGS = {"--agent", "--days", "--title", "--body", "--tag", "--image"}
KNOWN_FLAGS = {"--self-check", "--login", "--agent", "--tags", "--story", "--title",
               "--body", "--tag", "--image", "--days", "--dry-run", "--help", "-h"}


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
    if "--self-check" in argv:
        return self_check()
    if "--login" in argv:
        login()
        if "--agent" not in argv:
            return
    agent = argv[argv.index("--agent") + 1] if "--agent" in argv else os.environ.get("AGENT_ID")
    if not agent:
        sys.exit(__doc__)
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
        # for the file first rather than letting the announcement turn a quiet
        # run on an unconfigured machine into a failure.
        if os.path.exists(TOKEN_PATH):
            try:
                _post(f"{API}/v1/usage?agent_id={agent}", {"days": [], "status": "pending"},
                      {"authorization": f"Bearer {token()}"})
            except Exception:
                pass
        return print("  nothing to report yet — measuring from the next run")
    code, body = _post(f"{API}/v1/usage?agent_id={agent}", payload,
                       {"authorization": f"Bearer {token()}"})
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
    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "state.db")
        st = os.path.join(tmp, "state.json")
        c = sqlite3.connect(db)
        c.execute("CREATE TABLE session_model_usage (session_id TEXT, model TEXT,"
                  " billing_provider TEXT, billing_base_url TEXT, billing_mode TEXT,"
                  " task TEXT, input_tokens INT, output_tokens INT, cache_read_tokens INT,"
                  " cache_write_tokens INT, first_seen REAL, last_seen REAL)")
        now = time.time()
        c.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                  ("s1", "gpt-5.5", "", "", "", "", 1000, 2000, 3000, 4000,
                   now - 40 * 86400, now - 3600))
        c.commit()

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
            c2 = sqlite3.connect(os.path.join(fresh_home, "state.db"))
            c2.execute("CREATE TABLE session_model_usage (session_id TEXT, model TEXT,"
                       " input_tokens INT, output_tokens INT, cache_read_tokens INT,"
                       " cache_write_tokens INT, first_seen REAL, last_seen REAL)")
            c2.commit()
            assert from_hermes(28, home=fresh_home, state_path=st2) == {}, \
                "an empty store reports nothing"
            c2.execute("INSERT INTO session_model_usage VALUES (?,?,?,?,?,?,?,?)",
                       ("first", "gpt-5.5", 100, 20, 0, 0, time.time(), time.time()))
            c2.commit()
            got = from_hermes(28, home=fresh_home, state_path=st2)
            c2.close()
            assert got and list(got.values())[0]["gpt-5.5"]["input"] == 100, \
                f"a new agent's FIRST turn must be reported, not swallowed: {got}"

        # A corrupt state file costs one delta, never the whole report.
        open(st, "w").write("{not json")
        assert from_hermes(28, home=tmp, state_path=st) == {}, \
            "a corrupt state file rebaselines rather than crashing"

    # A legacy GitHub bearer must upgrade itself on an ORDINARY run, because a
    # supervisor never calls --login and a documented one-time step gets
    # skipped. And a failed upgrade must never cost the report.
    global _post
    real_post = _post
    with tempfile.TemporaryDirectory() as tdir:
        tp = os.path.join(tdir, "token")
        open(tp, "w").write("gho_legacybearer")
        _post = lambda url, body, headers: (200, {"key": "aik_upgraded", "login": "x"})
        try:
            assert token(tp) == "aik_upgraded", "a legacy bearer must be exchanged"
            on_disk = open(tp).read().strip()
            assert on_disk == "aik_upgraded", f"and rewritten on disk: {on_disk}"
            assert not on_disk.startswith("gho_"), "a GitHub token must never be left behind"

            # Exchange fails: keep working, do not destroy the credential.
            open(tp, "w").write("gho_legacybearer")
            # Non-200 WITH a key-shaped body: an error page or a proxy reply
            # must never be adopted as a credential, so the status is what
            # decides, not the presence of the field.
            _post = lambda url, body, headers: (500, {"key": "aik_from_an_error_body"})
            assert token(tp) == "gho_legacybearer", \
                "a failed upgrade must not break reporting"
            assert open(tp).read().strip() == "gho_legacybearer", \
                "a failed upgrade must not blank the only credential we have"

            # An already-scoped key is left completely alone: no network call.
            open(tp, "w").write("aik_already")
            def _boom(*a, **k):
                raise AssertionError("must not call the server for an existing key")
            _post = _boom
            assert token(tp) == "aik_already"
        finally:
            _post = real_post

    # An unreachable server is a reported failure, not a traceback in a
    # supervised loop's logs. Port 9 is discard: nothing listens there.
    code, body = _post("http://127.0.0.1:9/v1/usage", {"days": []}, {})
    assert code == 0 and "could not reach" in body.get("error", ""), (code, body)

    # A quiet run must never fail because we could not ANNOUNCE that it was
    # quiet. The announcement is not the measurement.
    import subprocess
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
