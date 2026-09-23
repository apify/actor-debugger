# actor-debugger

Drop-in remote debugging for Apify Actors: a one-line `CMD` change in the Dockerfile launches the
Actor under a debugger and serves a full debugger UI over the run's container URL. Open one link in
your own browser and debug — no local setup, no tunnel, no rebuild of your code, no browser or IDE
inside the Actor.

| Runtime | Package | Integration | Details |
|---|---|---|---|
| Node.js / TypeScript | [`actor-debugger` on npm](https://www.npmjs.com/package/actor-debugger) | `RUN npm install actor-debugger` + `CMD ["npx", "actor-debugger", "--brk"]` | [`javascript/README.md`](javascript/README.md) |
| Python | [`actor-debugger` on PyPI](https://pypi.org/project/actor-debugger/) | `RUN pip install actor-debugger` + `CMD ["python3", "-m", "actor_debugger", "--brk"]` | [`python/README.md`](python/README.md) |

Both variants share the same architecture: your Actor runs under its native debugger (the Node
inspector, or debugpy for Python), and one HTTP server on `ACTOR_WEB_SERVER_PORT` serves the
frontend and bridges the debug protocol to it. The run log prints the URL to open.

## Examples

[`examples/ssh-debug-counter`](examples/ssh-debug-counter/README.md) is a standalone sample Actor
that takes the same "one port, over the container URL" idea in a different direction: instead of a
debugger UI, it serves an SSH session. It needs no tunnel client either — you connect with the
`ssh` and `openssl` already on your machine.

## Security

The debug endpoint is unauthenticated: anyone who reaches the container URL can execute code in the
run and read its environment, including `APIFY_TOKEN`. Keep the debugger `CMD` only in builds you are
actively debugging, and never ship it in a published Actor. See each README for details.

## License

Apache-2.0 — see [`LICENSE`](LICENSE).
