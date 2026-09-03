# actor-debugger (Python)

Drop-in remote debugging for **any Apify Python Actor** with a one-line Dockerfile change. It
launches your Actor under **debugpy** (the standard Python debugger that powers VS Code) **and
serves a full browser debugger UI over the run's container URL** — so you open one link in your
own browser and debug. No IDE, no wstunnel, no local setup, no rebuild of your source, and **no
browser or IDE in the Actor**.

```dockerfile
# Get the package
RUN pip install actor-debugger

# pause on the first executable line until you attach (for short-lived Actors):
CMD ["python3", "-m", "actor_debugger", "--brk"]

# or point at a specific module / file:
CMD ["python3", "-m", "actor_debugger", "-m", "src"]
CMD ["python3", "-m", "actor_debugger", "main.py"]
```

## How it works

This is the Python sibling of the Node/TS `actor-debugger` npm package in the repository root,
built on the same architecture — swap `node --inspect` for debugpy and Chrome DevTools for a
served DAP client:

1. It resolves your Actor's entrypoint (see detection order below) and launches it as
   `python -m debugpy --listen 127.0.0.1:5678 <entry>` — so the debugger runs on **your** code,
   in its own process, exactly as it normally runs. debugpy speaks the
   [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) (DAP), the same
   protocol VS Code uses to debug Python.
2. It runs one HTTP server on `ACTOR_WEB_SERVER_PORT` that:
   - **serves a browser debugger UI** (static files, bundled with the package) so your *local*
     browser opens it — the DAP *client* is JavaScript running in your browser;
   - **bridges a WebSocket at `/dap`** to debugpy's DAP-over-TCP socket on loopback, translating
     framing (one WebSocket message per DAP JSON message ↔ `Content-Length` framed TCP) and
     injecting the adapter's loopback address into `attach` requests — which is also what makes
     re-attach after a browser reload work;
   - serves `/source?path=...` so the UI can display files that exist only on the container's
     disk (a remote frontend can never fetch `file://` URLs — the same problem the Node version
     solves by inlining source maps).
3. The run log prints one URL. Open it in your browser → a debugger attached to your Actor:
   click line numbers to set breakpoints, step, inspect the stack and variables, evaluate
   expressions in any frame, break on exceptions.

Because the container side is a dumb byte bridge, all protocol intelligence lives in the served
frontend — the Actor image gains only `debugpy` (~3 MB) and ~30 KB of static files. There is no
IDE, browser, Xvfb, or VNC in the image, and the Apify platform is used exactly as-is: the
standard container web server port is the only channel.

## Activation

Running the Actor through `python3 -m actor_debugger` **is** the switch — debugging is on
whenever the `CMD` line above is in place. To turn it off, revert the `CMD` to the Actor's normal
entrypoint (e.g. `CMD ["python3", "-m", "src"]`) and rebuild. Pass `--brk` to pause on the first
executable line of the entry file until you attach — useful for Actors that would otherwise
finish before you connect. (`--brk` maps to debugpy's `--wait-for-client` plus a synthetic
first-line breakpoint that the UI sets before resuming and removes after the first stop.)

## Connect

Open the URL the run log prints, in your own browser:

```
https://<run>.runs.apify.net/ui/
```

That page is the debugger; it connects back to the same host over `wss://…/dap`. Breakpoints are
kept in `localStorage`, so they survive page reloads and re-attach automatically. Program stdout
stays in the Actor run log as usual; the UI console is a REPL into the paused frame (plus
debugger events and exception details).

Prefer a raw channel? `wss://<run>.runs.apify.net/dap` speaks DAP directly, one JSON message per
WebSocket text frame — any DAP client can drive it.

## Entrypoint detection order

1. An explicit `-m <module>` or `<file.py>` argument, if given.
2. `src/__main__.py` → runs `-m src` (the Apify Python Actor template convention).
3. `src/main.py` → runs `-m src.main`.
4. Conventional files: `main.py`, `__main__.py`, `app.py`.

## Security

The debug endpoint is **unauthenticated** — anyone who reaches the container URL can execute code
in your run (and read its env, including `APIFY_TOKEN`); `/source` additionally serves any file
readable in the container. Keep the `actor_debugger` `CMD` only in builds you are actively
debugging, prefer a restricted run/token, never ship it in a published Actor, and gate the
endpoint (owner-only) before any non-prototype use. This matches the security posture of the Node
version; both need the same hardening pass.

## Design notes: the routes considered

The constraint was: **no platform/infrastructure changes, and nothing but a browser on the
debugging machine.** Everything must therefore run inside the Actor container and be served over
the one exposed web-server port. Options considered:

| Approach | Verdict |
| --- | --- |
| **debugpy + served browser DAP client** (this package) | CPython unchanged, actor code and deps run exactly as in production; debugpy is the canonical Python debugger; image cost ~3 MB. The UI is ours to grow. **Chosen.** |
| **GraalPy `--inspect`** — GraalVM's Python speaks the Chrome DevTools Protocol natively, so the Node version's chii DevTools frontend + CDP proxy would work *unchanged* | Elegant symmetry (identical UI and proxy for JS and Python), but it swaps the runtime under the Actor: a different base image, slower startup/warmup, and C-extension compatibility risk for real-world scraping deps (`lxml`, `pydantic`, `cryptography`, …). Debugging a different interpreter than production undermines the point. Worth a spike for pure-Python Actors; not the default. |
| **DAP→CDP translation shim** — keep CPython + debugpy, translate DAP into the Chrome DevTools Protocol in the bridge, and serve the same chii DevTools frontend the Node version uses | Best possible UI for free, one frontend for both languages. The mapping (breakpoints, stepping, stack, scopes, evaluate) is tractable, but the DevTools frontend is picky about `Debugger`/`Runtime` domain lifecycle, script IDs, and object groups — a meaningful project on its own. The `/dap` WebSocket this package exposes is exactly where such a shim would slot in later. |
| **code-server / openvscode-server in the container** — full VS Code in a browser tab, attach to debugpy | Great UX, zero custom code, but adds ~300 MB and a Node runtime to every Python Actor image, needs auth wiring, and its multiplexed WebSockets are more ingress-sensitive. Overkill for "set a breakpoint in a run". |
| **`web-pdb` / xterm.js + pdb over WebSocket** | Tiny and dependency-free, but a terminal `pdb` UX (no gutter breakpoints, no variable tree) and pdb can't attach to a running program the way debugpy can. Good fallback, not the goal. |
| **Jupyter server in the container** (JupyterLab's visual debugger also speaks debugpy) | The kernel model doesn't fit debugging an already-running script/Actor process; heavyweight. |
| **[`dap-python`](https://pypi.org/project/dap-python/)** — a typed Python DAP *client* library | Sits on the wrong side of this design's wire: the DAP client here is the browser, and the container side is a protocol-agnostic byte bridge. It would fit a server-orchestrated variant (Python translating DAP to a custom browser protocol), at the cost of a Pydantic dependency in every Actor image and a Python ≥3.12 floor. Noted as a building block if the bridge ever needs server-side smarts. |

## Verified

Tested end-to-end against a generic sample Python Actor (`example-actor-python/` in the repo):

- The one-line `CMD` detects the entrypoint (`-m src`) and runs the Actor under debugpy; explicit
  module/file and auto-detect modes all pass.
- `/ui/` and `/config` are served; `/source` returns container files; the `/dap` WebSocket
  round-trips the full DAP handshake (`initialize` → `attach` → `setBreakpoints` →
  `configurationDone`), hits a breakpoint, walks the stack/scopes/variables, evaluates in-frame,
  and resumes — through the bridge with browser framing.
- **Headless Chromium loaded the served UI and drove a real session**: attached, auto-paused on
  the entry line under `--brk`, rendered sources, stepped, hit a gutter-set breakpoint, showed
  stack + variables, evaluated in the paused frame, and resumed. Re-attach after page reload
  works.

One thing to confirm on real infrastructure (shared with the Node version): the `wss://`
connection through Apify's ingress when it negotiates HTTP/2.

## Notes

- Only runtime dependency is `debugpy`; the server and WebSocket implementation are stdlib.
- `--wait-for-client` means a crashed debug UI never blocks a *running* Actor — the process only
  waits at startup with `--brk`.
- The frontend applies "just my code" on (re)connect; untick it to step into library code.
