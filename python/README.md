# actor-debugger (Python)

Drop-in remote debugging for **any Apify Python Actor** with a two-line Dockerfile change. It
launches your Actor under **debugpy** (the debugger that powers VS Code's Python debugging) **and
serves a full browser debugger UI over the run's container URL** — so you open one link in your
own browser and debug. No IDE, no tunnel, no local setup, no rebuild of your source, and **no
browser or IDE inside the Actor**.

This is the Python sibling of the Node/TS [`actor-debugger`](../README.md) npm package, injected
the same way:

```dockerfile
# Get the package
RUN pip install actor-debugger

# Swap the entrypoint for the debug launcher (revert this line to disable debugging):
CMD ["python3", "-m", "actor_debugger", "--brk"]     # was e.g.: CMD ["python3", "-m", "src"]
```

That's the entire integration — no code changes, no new ports, no platform configuration. Build,
run, and the run log prints one URL:

```
[actor-debugger] OPEN THIS in your local browser for a full debugger UI (no local setup):
[actor-debugger]   https://<run>.runs.apify.net/ui/
```

Open it: click line numbers to set breakpoints, step, inspect the call stack and variables,
evaluate expressions in the paused frame, break on exceptions. `--brk` pauses the Actor on its
first line until you attach — drop it to let the Actor run and attach mid-flight instead.

Until the package is published to PyPI, install it from the repository instead:

```dockerfile
RUN pip install "actor-debugger @ git+https://github.com/apify/actor-debugger.git@master#subdirectory=python"
```

## CLI forms

```dockerfile
CMD ["python3", "-m", "actor_debugger"]              # auto-detect the Actor's entrypoint
CMD ["python3", "-m", "actor_debugger", "--brk"]     # pause on the first line until attached
CMD ["python3", "-m", "actor_debugger", "-m", "src"] # explicit module
CMD ["python3", "-m", "actor_debugger", "main.py"]   # explicit file
```

(`actor-debugger` also works as a console command; the `python3 -m` form is immune to PATH
surprises in slim images.)

Entrypoint detection order: explicit `-m <module>`/`<file.py>` argument → `src/__main__.py`
(the Apify template's `python3 -m src`) → `src/main.py` → `main.py` / `__main__.py` / `app.py`.

## How it works

1. It launches your Actor as `python -m debugpy --listen 127.0.0.1:5678 <entry>` — the debugger
   runs on **your** code, in its own process, exactly as it normally runs. debugpy speaks the
   [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) (DAP), the same
   protocol VS Code uses.
2. It runs one HTTP server on `ACTOR_WEB_SERVER_PORT` that:
   - **serves a browser debugger UI** (~30 KB of static files bundled with the package) — the DAP
     *client* is JavaScript running in your browser;
   - **bridges a WebSocket at `/dap`** to debugpy's DAP-over-TCP socket, translating framing (one
     WebSocket message per DAP JSON message ↔ `Content-Length`-framed TCP), injecting the
     adapter's loopback address into `attach` requests, and sending a `disconnect` on the
     browser's behalf when a tab closes abruptly — which is what makes page reloads re-attach
     cleanly;
   - serves `/source?path=...` so the UI can display files that exist only on the container's
     disk (the same problem the Node version solves by inlining source maps).
3. The run log prints the one URL above. Program stdout keeps flowing to the Actor run log as
   usual; breakpoints live in the browser's `localStorage`, so they survive reloads and
   re-attach automatically.

Because the container side is a dumb byte bridge, all protocol intelligence lives in the served
frontend — the Actor image gains only `debugpy` (~3 MB) plus the static files. The platform is
used exactly as-is: the standard container web-server port is the only channel. Prefer a raw
channel? `wss://<run>.runs.apify.net/dap` speaks DAP directly, one JSON message per WebSocket
text frame — any DAP client can drive it.

## Verified on the Apify platform

The full loop has been exercised against a real platform run: the UI served over
`https://<run>.runs.apify.net/ui/`, the `wss://…/dap` WebSocket passed the platform ingress, and
a live run was attached, paused, and driven from a plain browser. Automated coverage in this
repo: a protocol test drives a complete DAP session through the bridge (breakpoint, stack,
scopes, variables, evaluate, resume, re-attach after disconnect), and a headless-Chromium test
drives the real UI end to end (entry pause under `--brk`, gutter breakpoints, stepping,
variables, in-frame evaluate, resume, re-attach after page reload), including idle sessions.

## Security

The debug endpoint is **unauthenticated** — anyone who reaches the container URL can execute code
in your run (and read its env, including `APIFY_TOKEN`); `/source` additionally serves any file
readable in the container. Keep the debug `CMD` only in builds you are actively debugging, prefer
a restricted run/token, never ship it in a published Actor, and gate the endpoint (owner-only)
before any non-prototype use. This matches the security posture of the Node version; both need
the same hardening pass.

## Design notes: the routes considered

The constraint was: **no platform/infrastructure changes, and nothing but a browser on the
debugging machine.** Everything must therefore run inside the Actor container and be served over
the one exposed web-server port. Options considered:

| Approach | Verdict |
| --- | --- |
| **debugpy + served browser DAP client** (this package) | CPython unchanged, actor code and deps run exactly as in production; debugpy is the canonical Python debugger; image cost ~3 MB. The UI is ours to grow. **Chosen.** |
| **GraalPy `--inspect`** — GraalVM's Python speaks the Chrome DevTools Protocol natively, so the Node version's chii DevTools frontend + CDP proxy would work *unchanged* | Elegant symmetry, but it swaps the runtime under the Actor: a different base image, slower startup, and C-extension compatibility risk for real-world deps (`lxml`, `pydantic`, `cryptography`, …). Debugging a different interpreter than production undermines the point. |
| **DAP→CDP translation shim** — keep CPython + debugpy, translate DAP into the Chrome DevTools Protocol and serve the same chii DevTools frontend the Node version uses | Best possible UI for free, one frontend for both languages, but the DevTools frontend is picky about `Debugger`/`Runtime` lifecycle — a meaningful project on its own. The `/dap` WebSocket this package exposes is where such a shim would slot in later. |
| **code-server / openvscode-server in the container** | Great UX, zero custom code, but ~300 MB and a Node runtime in every Python Actor image, plus auth wiring. Overkill for "set a breakpoint in a run". |
| **`web-pdb` / xterm.js + pdb over WebSocket** | Tiny, but a terminal `pdb` UX (no gutter breakpoints, no variable tree) and pdb can't attach to a running program the way debugpy can. |
| **Jupyter server in the container** (JupyterLab's debugger also speaks debugpy) | The kernel model doesn't fit debugging an already-running script; heavyweight. |
| **[`dap-python`](https://pypi.org/project/dap-python/)** — a typed Python DAP *client* library | The DAP client here is the browser; the container side is a protocol-agnostic byte bridge. Useful only for a server-orchestrated variant, at the cost of a Pydantic dependency and a Python ≥3.12 floor. |

The same architecture extends beyond Python: any language with a DAP adapter (Node via js-debug,
Go via Delve — which speaks DAP natively — Rust via lldb-dap, …) can sit behind the identical
bridge and frontend; only the adapter spawn command and entrypoint detection differ.

## Releasing

Publishing to PyPI is automated by
[`.github/workflows/publish-python.yml`](../.github/workflows/publish-python.yml), which fires on
`py-v*` tags. To cut a release:

```bash
# bump version in python/pyproject.toml and python/src/actor_debugger/__init__.py, commit, then:
git tag py-v0.1.0
git push --tags
```

One-time setup: create a PyPI API token for the project (or an account-scoped token for the very
first upload, which claims the `actor-debugger` name) and save it as the repository secret
`PYPI_TOKEN`. The publish job runs in the `pypi` GitHub environment, so you can add required
reviewers there to gate releases.

## Notes

- Only runtime dependency is `debugpy`; the HTTP server and the RFC 6455 WebSocket implementation
  are pure stdlib (Python ≥3.9).
- A crashed or closed debugger tab never blocks a *running* Actor — the process only waits at
  startup, and only with `--brk`.
- "Just my code" is applied on (re)connect; untick it in the UI header to step into library code.
