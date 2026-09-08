"""One HTTP server on the container's web-server port that:

- serves the bundled browser debugger UI (static files) so your LOCAL browser opens it -
  no IDE, no local setup;
- bridges a WebSocket at /dap to the debugpy adapter's DAP-over-TCP socket on loopback,
  translating framing (one WebSocket text message per DAP JSON message <-> Content-Length
  framed TCP) so the browser client stays trivial;
- rewrites `attach` requests in flight to inject the adapter's loopback connect address,
  which the browser cannot know (and which is what makes debugpy accept re-attach after
  a page reload);
- serves /source?path=... so the remote frontend can display files that only exist on the
  container's disk (a browser can never fetch file:// URLs from the container);
- serves /config with the working directory so the frontend can group project files apart
  from library code.
"""

from __future__ import annotations

import json
import mimetypes
import os
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from .websocket import WebSocketConnection, WebSocketClosed, accept_key

UI_PREFIX = "/ui/"


def _read_dap_messages(sock: socket.socket):
    """Yield DAP message bodies (bytes) from a Content-Length framed TCP stream."""
    buf = b""
    while True:
        while b"\r\n\r\n" not in buf:
            chunk = sock.recv(65536)
            if not chunk:
                return
            buf += chunk
        header, buf = buf.split(b"\r\n\r\n", 1)
        length = None
        for line in header.split(b"\r\n"):
            name, _, value = line.partition(b":")
            if name.strip().lower() == b"content-length":
                length = int(value.strip())
        if length is None:
            return
        while len(buf) < length:
            chunk = sock.recv(65536)
            if not chunk:
                return
            buf += chunk
        body, buf = buf[:length], buf[length:]
        yield body


class DebugRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    # Injected by start_debug_server():
    frontend_dir: str = ""
    adapter_host: str = "127.0.0.1"
    adapter_port: int = 5678
    brk: bool = False
    entry_path: str = ""

    def log_message(self, format, *args):  # noqa: A002 - stdlib signature
        pass  # keep the Actor log clean

    # -- HTTP ---------------------------------------------------------------

    def do_GET(self):  # noqa: N802 - stdlib naming
        parsed = urlparse(self.path)
        if parsed.path == "/dap" and "websocket" in self.headers.get("Upgrade", "").lower():
            self._handle_websocket()
            return
        if parsed.path in ("", "/"):
            self.send_response(302)
            self.send_header("Location", f"{UI_PREFIX}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if parsed.path == "/config":
            self._send_json({"cwd": os.getcwd(), "brk": self.brk, "entryPath": self.entry_path})
            return
        if parsed.path == "/source":
            self._serve_source(parsed)
            return
        self._serve_static(parsed.path)

    def _send_json(self, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _send_plain(self, status: int, text: str) -> None:
        body = text.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_source(self, parsed) -> None:
        path = (parse_qs(parsed.query).get("path") or [""])[0]
        if not path or not os.path.isabs(path) or not os.path.isfile(path):
            self._send_plain(404, "not found")
            return
        try:
            with open(path, "rb") as f:
                body = f.read(4 * 1024 * 1024)
        except OSError:
            self._send_plain(404, "not found")
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _serve_static(self, url_path: str) -> None:
        rel = url_path[len(UI_PREFIX):] if url_path.startswith(UI_PREFIX) else url_path.lstrip("/")
        rel = rel or "index.html"
        file_path = os.path.normpath(os.path.join(self.frontend_dir, rel))
        if not file_path.startswith(os.path.abspath(self.frontend_dir)):
            self._send_plain(403, "forbidden")
            return
        if not os.path.isfile(file_path):
            self._send_plain(404, "not found")
            return
        ctype = mimetypes.guess_type(file_path)[0] or "application/octet-stream"
        with open(file_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- WebSocket <-> DAP bridge --------------------------------------------

    def _handle_websocket(self) -> None:
        key = self.headers.get("Sec-WebSocket-Key")
        if not key:
            self._send_plain(400, "bad websocket handshake")
            return
        upstream = None
        deadline = time.monotonic() + 15
        while upstream is None:
            try:
                upstream = socket.create_connection((self.adapter_host, self.adapter_port), timeout=5)
            except OSError:
                if time.monotonic() >= deadline:
                    self._send_plain(502, "debug adapter unavailable")
                    return
                time.sleep(0.5)
        # The connect timeout must not linger on the established socket: it would make the
        # idle recv() in the pump thread time out and tear the session down after 5 quiet
        # seconds. A debug session idles for minutes while the developer reads code.
        upstream.settimeout(None)
        self.connection.sendall(
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\n"
            b"Connection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + accept_key(key).encode() + b"\r\n\r\n"
        )
        self.close_connection = True
        ws = WebSocketConnection(self.connection)

        def pump_adapter_to_browser():
            try:
                for body in _read_dap_messages(upstream):
                    ws.send_text(body.decode("utf-8", errors="replace"))
            except (OSError, WebSocketClosed):
                pass
            finally:
                ws.close()

        pump = threading.Thread(target=pump_adapter_to_browser, daemon=True)
        pump.start()
        saw_disconnect = False
        try:
            while True:
                text = ws.recv_text()
                if '"disconnect"' in text:
                    try:
                        parsed = json.loads(text)
                        if parsed.get("type") == "request" and parsed.get("command") == "disconnect":
                            saw_disconnect = True
                    except ValueError:
                        pass
                body = self._rewrite_attach(text).encode()
                upstream.sendall(b"Content-Length: %d\r\n\r\n%b" % (len(body), body))
        except (OSError, WebSocketClosed):
            pass
        finally:
            if not saw_disconnect:
                # The browser vanished (tab closed, page reloaded) without a DAP disconnect.
                # An abruptly dropped client makes debugpy's adapter stop listening, killing
                # re-attach - so say goodbye on the browser's behalf.
                goodbye = json.dumps({
                    "seq": 2_000_000_000,
                    "type": "request",
                    "command": "disconnect",
                    "arguments": {"terminateDebuggee": False},
                }).encode()
                try:
                    upstream.sendall(b"Content-Length: %d\r\n\r\n%b" % (len(goodbye), goodbye))
                    time.sleep(0.5)
                except OSError:
                    pass
            try:
                upstream.close()
            except OSError:
                pass
            ws.close()

    def _rewrite_attach(self, text: str) -> str:
        """Inject the adapter's connect address into `attach` requests.

        debugpy treats an attach with `connect` as a socket attach and then accepts later
        re-attaches on the same listen port - which is what makes browser reloads work.
        The browser cannot know the loopback port, so the bridge fills it in.
        """
        try:
            message = json.loads(text)
        except ValueError:
            return text
        if message.get("type") == "request" and message.get("command") == "attach":
            arguments = message.setdefault("arguments", {})
            arguments["connect"] = {"host": self.adapter_host, "port": self.adapter_port}
            return json.dumps(message)
        return text


def start_debug_server(
    listen_port: int,
    adapter_port: int,
    frontend_dir: str,
    brk: bool = False,
    entry_path: str = "",
) -> ThreadingHTTPServer:
    handler = type(
        "BoundDebugRequestHandler",
        (DebugRequestHandler,),
        {
            "frontend_dir": os.path.abspath(frontend_dir),
            "adapter_port": adapter_port,
            "brk": brk,
            "entry_path": entry_path,
        },
    )
    server = ThreadingHTTPServer(("0.0.0.0", listen_port), handler)
    server.daemon_threads = True
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server
