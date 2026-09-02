# actor-debugger

Drop-in remote debugging for **any Apify Node/TS Actor** with a one-line Dockerfile change. It
launches your Actor under the Node inspector **and serves a full Chrome DevTools UI over the run's
container URL** — so you open one link in your own browser and debug. No wstunnel, no local setup,
no rebuild of your source, and **no browser in the Actor**.

```dockerfile
# auto-detect the Actor's entrypoint:
CMD ["npx", "actor-debugger"]

# or point at a specific entry:
CMD ["npx", "actor-debugger", "dist/main.js"]
```

## How it works

1. It resolves your Actor's entrypoint (see detection order below) and launches it as
   `node --inspect=127.0.0.1:9229 <entry>` — so the inspector is on **your** code, in its own
   process, exactly as it normally runs.
2. It runs one HTTP server on `ACTOR_WEB_SERVER_PORT` that:
   - **serves the Chrome DevTools frontend** (static files) so your *local* browser opens it — no
     Chrome, Xvfb, or VNC in the Actor;
   - **proxies the CDP WebSocket** to the inspector, rewriting `Host` to a loopback IP and dropping
     `Origin`. Node's inspector rejects DNS-name hosts (anti-DNS-rebinding), so this rewrite is
     what lets a browser reach it over `<run>.runs.apify.net`.
3. The run log prints one URL. Open it in your browser → real DevTools attached to your Actor.

The DevTools frontend comes from **[`chii`](https://github.com/liriliri/chii)** (MIT), which ships
a *prebuilt* Chrome DevTools frontend. The `chrome-devtools-frontend` npm package is unbuilt
TypeScript source (needs Chromium's GN/ninja toolchain to compile), so it can't be served as-is —
chii's build is the same frontend, ready to serve.

## Activation (safe to leave in permanently)

Debugging only turns on when the env var **`APIFY_NODE_DEBUGGER`** is truthy. Without it, the Actor
runs normally (no inspector, no server), so the `CMD` line is safe in production — flip it on
per-run by setting the env var in the Console or via the API. Set `APIFY_NODE_DEBUGGER_BRK=1` to
pause on the first line until a debugger attaches.

## Connect

Open the URL the run log prints, in your own browser:

```
https://<run>.runs.apify.net/devtools/js_app.html?wss=<run>.runs.apify.net/<uuid>
```

That page **is** Chrome DevTools; it connects to your Actor over the container URL. Set breakpoints
in your sources (via source maps), step, inspect — no `devtools://` URL, no local install.
Prefer the raw channel? `npx wscat -c "wss://<run>.runs.apify.net/<uuid>"`, or point
`Playwright/Puppeteer connectOverCDP` at that wss URL.

## Entrypoint detection order

1. An explicit path argument, if given.
2. The file in `package.json` `scripts.start` (e.g. `node dist/main.js` → `dist/main.js`).
3. `package.json` `main`.
4. Conventional paths: `dist/main.js`, `dist/index.js`, `build/main.js`, `src/main.js`, `main.js`, `index.js`.

## Security

The debug endpoint is **unauthenticated** — anyone who reaches the container URL and the run's
`uuid` can execute code in your run (and read its env, including `APIFY_TOKEN`). Only enable it on
runs you are actively debugging, prefer a restricted run/token, never leave `APIFY_NODE_DEBUGGER`
set on a published Actor, and gate the endpoint (owner-only) before any non-prototype use.

## Verified

Tested end-to-end against a **browserless** generic sample TS Actor (`example-actor/`, plain
`apify/actor-node`, no Chrome):

- The one-line `CMD` detects the entrypoint and runs the Actor under `--inspect`; disabled/explicit
  path/auto-detect modes all pass.
- `/devtools/js_app.html` and its assets are served (200); `/json` is proxied; a CDP client
  round-trips `Runtime.evaluate` through the proxy with browser-like `Host`/`Origin`.
- **Headless Chromium loaded the served DevTools frontend and the Node inspector reported
  "Debugger attached"** — i.e. the served Chrome DevTools UI genuinely connects to the Actor with no
  browser in the image.

One thing to confirm on real infrastructure: the frontend's `wss://` connection through Apify's
ingress when the ingress negotiates HTTP/2 (WebSocket-over-h2). See the sibling
`typescript-debug-browser` handoff for the `curl --http1.1` probe that settles it.

## Releasing

Publishing to npm is automated by [`.github/workflows/publish.yml`](.github/workflows/publish.yml),
which fires on `v*` tags. To cut a release:

```bash
npm version patch   # or minor / major - bumps package.json, commits, tags vX.Y.Z
git push --follow-tags
```

The workflow syntax-checks the sources, smoke-tests both modes (disabled pass-through and the
debug server with `/json/list` + DevTools frontend), verifies the tag matches `package.json`
`version`, and then runs `npm publish`.

One-time setup: create a granular npm access token with publish rights for this package and save
it as the repository secret `NPM_TOKEN`. The publish job runs in the `npm` GitHub environment, so
you can optionally add required reviewers there to gate releases.

## Notes

- Depends on `chii` for the prebuilt DevTools frontend (~16 MB of static assets, no runtime browser).
- Pure Node otherwise — works on any `apify/actor-node*` base image, no Xvfb / Chrome / apt.
