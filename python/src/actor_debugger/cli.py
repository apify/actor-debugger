"""actor-debugger - launch an Apify Python Actor under debugpy, debuggable from a plain
browser over the run's container URL, with a one-line Dockerfile change:

    CMD ["python3", "-m", "actor_debugger"]              # auto-detect the Actor's entrypoint
    CMD ["python3", "-m", "actor_debugger", "-m", "src"] # explicit module
    CMD ["python3", "-m", "actor_debugger", "main.py"]   # explicit file
    CMD ["python3", "-m", "actor_debugger", "--brk"]     # pause on the first line until attached

Running through this command is what enables debugging - revert the CMD to the normal
entrypoint to turn it off.
"""

from __future__ import annotations

import os
import signal
import socket
import subprocess
import sys
import threading
import time

from .debug_server import start_debug_server

ADAPTER_PORT = 5678
TAG = "[actor-debugger]"


def log(message: str) -> None:
    print(f"{TAG} {message}", file=sys.stderr, flush=True)


# The apify/actor-python base image ships a placeholder src/ package (default CMD is
# `python -m src`) that only prints a "replace this file" warning - it exists in EVERY
# image built on that base, so auto-detection must never mistake it for the Actor's code.
_PLACEHOLDER_MARKER = b"set up your Docker image correctly"


def _is_placeholder(*paths: str) -> bool:
    for path in paths:
        try:
            with open(path, "rb") as f:
                if _PLACEHOLDER_MARKER in f.read(65536):
                    return True
        except OSError:
            continue
    return False


def resolve_entry(args: list[str]) -> list[str] | None:
    """Return the argv tail (["-m", "pkg"] or ["path.py"]) for the Actor's entrypoint."""
    if "-m" in args:
        module = args[args.index("-m") + 1 :][:1]
        if module:
            return ["-m", module[0]]
    positional = [a for a in args if not a.startswith("-")]
    if positional:
        return [os.path.abspath(positional[0])]
    skipped_placeholders = []
    # The Apify Python templates run `python3 -m src` (src/__main__.py + src/main.py).
    for module, files in (("src", ("src/__main__.py",)), ("src.main", ("src/main.py",))):
        if all(os.path.isfile(f) for f in files):
            if _is_placeholder("src/__main__.py", "src/main.py"):
                skipped_placeholders.append(f"-m {module}")
                break  # both src candidates are the same placeholder package
            return ["-m", module]
    for candidate in ("main.py", "__main__.py", "app.py"):
        if os.path.isfile(candidate):
            if _is_placeholder(candidate):
                skipped_placeholders.append(candidate)
                continue
            return [os.path.abspath(candidate)]
    for skipped in skipped_placeholders:
        log(f"ignored {skipped}: it is the apify/actor-python base-image placeholder, not your code.")
    return None


def entry_file_path(entry: list[str]) -> str:
    """Best-effort path of the file that runs first, for the frontend's --brk entry stop."""
    if entry[0] != "-m":
        return entry[0]
    base = entry[1].replace(".", os.sep)
    for candidate in (os.path.join(base, "__main__.py"), base + ".py"):
        if os.path.isfile(candidate):
            return os.path.abspath(candidate)
    return ""


def wait_for_adapter(port: int, timeout: float = 30.0) -> bool:
    """Wait until something listens on the adapter port WITHOUT connecting to it.

    debugpy treats the first accepted connection as its DAP client and shuts the session
    down when it drops, so probing with a real connect would kill the adapter. A bind
    attempt failing with EADDRINUSE detects the listener without ever touching it.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            probe.bind(("127.0.0.1", port))
        except OSError:
            return True
        finally:
            probe.close()
        time.sleep(0.25)
    return False


def announce(web_server_url: str) -> None:
    if not wait_for_adapter(ADAPTER_PORT):
        log(f"debugpy adapter did not come up on 127.0.0.1:{ADAPTER_PORT}.")
        return
    base = web_server_url.rstrip("/")
    log("=" * 64)
    log("debugging is ON - reachable over the container URL.")
    log("OPEN THIS in your local browser for a full debugger UI (no local setup):")
    log(f"  {base}/ui/")
    host = base.split("://", 1)[-1]
    log(f"raw DAP-over-WebSocket channel (one JSON message per frame): wss://{host}/dap")
    log("=" * 64)


def main() -> None:
    args = sys.argv[1:]
    brk = "--brk" in args
    entry = resolve_entry([a for a in args if a != "--brk"])
    if not entry:
        log("could not find an Actor entrypoint. Pass one explicitly, e.g.:")
        log('  CMD ["python3", "-m", "actor_debugger", "-m", "src"]')
        log('  CMD ["python3", "-m", "actor_debugger", "server.py"]')
        sys.exit(1)
    log(f"entrypoint: {' '.join(entry)}")

    debugpy_argv = [
        sys.executable,
        "-Xfrozen_modules=off",
        "-m",
        "debugpy",
        "--listen",
        f"127.0.0.1:{ADAPTER_PORT}",
        *(["--wait-for-client"] if brk else []),
        *entry,
    ]
    env = {**os.environ, "PYDEVD_DISABLE_FILE_VALIDATION": "1"}
    child = subprocess.Popen(debugpy_argv, env=env)

    server = None
    port = os.environ.get("ACTOR_WEB_SERVER_PORT")
    url = os.environ.get("ACTOR_WEB_SERVER_URL")
    if port and url:
        frontend_dir = os.path.join(os.path.dirname(__file__), "frontend")
        server = start_debug_server(int(port), ADAPTER_PORT, frontend_dir, brk=brk, entry_path=entry_file_path(entry))
        threading.Thread(target=announce, args=(url,), daemon=True).start()
        if brk:
            log("--brk: the Actor is paused on its first line until you attach from the browser.")
    else:
        log(f"ACTOR_WEB_SERVER_URL/PORT not set - DAP on 127.0.0.1:{ADAPTER_PORT} only (no container-URL bridge).")

    def forward(signum, _frame):
        child.send_signal(signum)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)

    code = child.wait()
    if server:
        server.shutdown()
    sys.exit(code)


if __name__ == "__main__":
    main()
