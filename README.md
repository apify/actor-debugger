# actor-debugger

Drop-in remote debugging for **any Apify Node/TS Actor** with a one-line Dockerfile change. It
launches your Actor under the Node inspector **and serves a full Chrome DevTools UI over the run's
container URL** — so you open one link in your own browser and debug. No wstunnel, no local setup,
no rebuild of your source, and **no browser in the Actor**.

```dockerfile
# Get the package (globally, so the Actor's own node_modules and lockfile are untouched)
RUN npm install --global actor-debugger

# Recommended: wrap the image's existing CMD. Docker appends it to the ENTRYPOINT, so your real
# start command is used as-is, and an ENTRYPOINT in your own Dockerfile can't swallow it.
# `--brk` pauses on the first line until a debugger attaches (for short-lived Actors).
ENTRYPOINT ["actor-debugger", "--brk"]

# Or replace the CMD instead - the entrypoint is then auto-detected, or given explicitly:
CMD ["npx", "actor-debugger", "--brk"]
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

## Activation

Running the Actor through `actor-debugger` **is** the switch — debugging is on whenever the
`ENTRYPOINT` (or `CMD`) line above is in place. To turn it off, drop that line and rebuild. Pass
`--brk` to pause on the first line until a debugger attaches — useful for Actors that would
otherwise finish before you connect.

## Connect

Open the URL the run log prints, in your own browser:

```
https://<run>.runs.apify.net/devtools/js_app.html?wss=<run>.runs.apify.net/<uuid>
```

That page **is** Chrome DevTools; it connects to your Actor over the container URL. Set breakpoints
in your sources (via source maps), step, inspect — no `devtools://` URL, no local install.
Prefer the raw channel? `npx wscat -c "wss://<run>.runs.apify.net/<uuid>"`, or point
`Playwright/Puppeteer connectOverCDP` at that wss URL.

The WebSocket scheme in the printed URL follows the container URL's scheme: `wss` on the platform
(https container URLs), plain `ws` on a local Apify dev stack (http on localhost). Always use the
URL exactly as printed in the run log.

## TypeScript sources (automatic)

A remote DevTools frontend can never fetch `file://` URLs from the container, so external
`.js.map` files — the standard `"sourceMap": true` tsc output — are unreachable to it, and
DevTools would fall back to the generated JS ("Source map failed to load"). The debugger fixes
this itself at startup: it scans the compiled output, reads each external `.map` from the
container's disk, embeds the original TS text into it (`sourcesContent`, read from the `.ts`
files in the image), and rewrites the reference into an inline `data:` URL. Any tsc setup that
emits source maps at all (`sourceMap` or `inlineSourceMap`) therefore just works — no tsconfig
changes needed.

The one unrecoverable case is a build with no source maps: then the run log prints a hint to
compile with `"sourceMap": true`. If the `.ts` files aren't in the image (a multi-stage build
copying only `dist/`), mappings still inline but sources can't be shown — the log says so; `COPY`
your `src/` into the final stage to fix it.

## Entrypoint detection order

Anything after `--brk` is treated as the Actor's start command. As `ENTRYPOINT`, that is the image's
own `CMD`, appended by Docker — so the Actor starts the way it normally does, with its Node flags and
arguments intact, instead of being guessed at.

Understood start commands:

| Passed-through command | Resolves to |
| --- | --- |
| `node [flags] <script> [args]` | that script, keeping flags (incl. `-r x`/`--import x`) and args |
| `npm start`, `npm run <s>`, `pnpm …`, `yarn …` | the matching `package.json` script, parsed again |
| `sh -c "<command>"` | the inner command, parsed again |
| `dist/main.js` | that file directly (the explicit-path form) |

Chained scripts are handled by trying the segments from the last back, so `npm run build && node
dist/main.js` debugs `dist/main.js` rather than the build step.

With **no** command passed (the plain `CMD ["npx", "actor-debugger"]` form), the entrypoint is
auto-detected instead:

1. The file in `package.json` `scripts.start` (e.g. `node dist/main.js` → `dist/main.js`).
2. `package.json` `main`.
3. Conventional paths: `dist/main.js`, `dist/index.js`, `build/main.js`, `src/main.js`, `main.js`, `index.js`.

If a command is passed but no Node.js entrypoint can be derived from it (e.g. a `tsx`/`ts-node`
launcher), the debugger **fails fast** with the reason rather than starting the Actor without a
debugger attached — a run you asked to debug should not silently run undebuggable. Pass the
entrypoint explicitly in that case: `ENTRYPOINT ["actor-debugger", "--brk", "dist/main.js"]`.

## Security

The debug endpoint is **unauthenticated** — anyone who reaches the container URL and the run's
`uuid` can execute code in your run (and read its env, including `APIFY_TOKEN`). Keep the
`actor-debugger` `CMD` only in builds you are actively debugging, prefer a restricted run/token,
never ship it in a published Actor, and gate the endpoint (owner-only) before any non-prototype
use.

## Verified

Tested end-to-end against a **browserless** generic sample TS Actor (`example-actor/`, plain
`apify/actor-node`, no Chrome):

- The one-line `CMD` detects the entrypoint and runs the Actor under `--inspect`; explicit path
  and auto-detect modes both pass.
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
