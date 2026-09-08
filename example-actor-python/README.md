# Python browser-debugger demo (self-contained, testable today)

A self-contained sample Actor showing the **browser-based Python debugger**: the run prints one
URL, you open it in a plain browser, and you get breakpoints, stepping, call stack, variables,
and an in-frame REPL against the live run. No IDE, no tunnel, nothing installed locally.

This folder is fully standalone — the `actor_debugger/` package is **vendored** (copied from
[`../python/src/actor_debugger`](../python/src/actor_debugger)) so it builds without the package
being on PyPI. Once it's published, replace the vendored folder with `pip install actor-debugger`.

## Test it in 3 steps

```bash
cd example-actor-python
apify push        # builds and deploys under your account
apify call        # or press Run in the Console (default input: 120 ticks x 2 s)
```

Then open the run **log** and click the URL that `[actor-debugger]` prints:

```
[actor-debugger] OPEN THIS in your local browser for a full debugger UI (no local setup):
[actor-debugger]   https://<run>.runs.apify.net/ui/
```

Because the Dockerfile uses `--brk`, the Actor waits, paused on its first line, until you open
that page — so you can't miss the start. Hit **▶ Resume** to let it run.

## Things to try once attached

1. Open `src/main.py` from the Sources panel and click the gutter on the `features = ...` line
   inside `score_page` → next tick pauses there; inspect `page` and `features` in the Variables
   panel.
2. Step **Into** `extract_features` (F11), step **Over** a few lines (F10), step **Out**
   (Shift+F11).
3. In the console at the bottom, evaluate `sum(features.values())` — or mutate live state:
   `page['depth'] = 99` and watch the pushed dataset item change.
4. Tick **break on raised exceptions**: every ~5th tick `flaky_lookup` raises (and handles) a
   `KeyError`, and the debugger drops you on the raise site with the full stack.
5. Reload the browser tab mid-run — it re-attaches and your breakpoints survive.

Meanwhile the run log keeps streaming `tick N: ...` lines and the dataset keeps filling — the
Actor behaves normally except when you pause it.

## Turning the debugger off

Edit the `Dockerfile` `CMD` back to `["python3", "-m", "src"]` and push again. **The debug
endpoint is unauthenticated** — anyone with the container URL can execute code in the run and
read its env (including `APIFY_TOKEN`) — so keep debug builds out of published Actors and prefer
runs under a restricted token.
