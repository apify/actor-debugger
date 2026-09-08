"""Minimal server-side RFC 6455 WebSocket implementation (stdlib only).

Just enough for the debugger bridge: handshake, text frames, fragmentation,
ping/pong, and close. Server-to-client frames are never masked (per spec);
client-to-server frames must be masked and are rejected otherwise.
"""

from __future__ import annotations

import base64
import hashlib
import socket
import struct
import threading

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

OP_CONT = 0x0
OP_TEXT = 0x1
OP_BINARY = 0x2
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA


def accept_key(sec_websocket_key: str) -> str:
    digest = hashlib.sha1((sec_websocket_key + _GUID).encode()).digest()
    return base64.b64encode(digest).decode()


class WebSocketClosed(Exception):
    pass


class WebSocketConnection:
    """A WebSocket over an already-upgraded socket."""

    def __init__(self, sock: socket.socket) -> None:
        self._sock = sock
        self._send_lock = threading.Lock()
        self._closed = False

    def _read_exact(self, n: int) -> bytes:
        chunks = b""
        while len(chunks) < n:
            chunk = self._sock.recv(n - len(chunks))
            if not chunk:
                raise WebSocketClosed()
            chunks += chunk
        return chunks

    def _read_frame(self) -> tuple[bool, int, bytes]:
        header = self._read_exact(2)
        fin = bool(header[0] & 0x80)
        opcode = header[0] & 0x0F
        masked = bool(header[1] & 0x80)
        length = header[1] & 0x7F
        if length == 126:
            length = struct.unpack(">H", self._read_exact(2))[0]
        elif length == 127:
            length = struct.unpack(">Q", self._read_exact(8))[0]
        if not masked:
            raise WebSocketClosed()  # client frames must be masked
        mask = self._read_exact(4)
        payload = bytearray(self._read_exact(length))
        for i in range(length):
            payload[i] ^= mask[i % 4]
        return fin, opcode, bytes(payload)

    def recv_text(self) -> str:
        """Block until a full text/binary message arrives; handle control frames inline.

        Raises WebSocketClosed when the peer closes or the socket drops.
        """
        message = b""
        message_opcode = None
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == OP_PING:
                self._send_frame(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                self.close()
                raise WebSocketClosed()
            if opcode in (OP_TEXT, OP_BINARY):
                message_opcode = opcode
                message = payload
            elif opcode == OP_CONT and message_opcode is not None:
                message += payload
            else:
                raise WebSocketClosed()
            if fin:
                return message.decode("utf-8", errors="replace")

    def _send_frame(self, opcode: int, payload: bytes) -> None:
        length = len(payload)
        if length < 126:
            header = struct.pack(">BB", 0x80 | opcode, length)
        elif length < 1 << 16:
            header = struct.pack(">BBH", 0x80 | opcode, 126, length)
        else:
            header = struct.pack(">BBQ", 0x80 | opcode, 127, length)
        with self._send_lock:
            self._sock.sendall(header + payload)

    def send_text(self, text: str) -> None:
        if self._closed:
            raise WebSocketClosed()
        self._send_frame(OP_TEXT, text.encode())

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._send_frame(OP_CLOSE, struct.pack(">H", 1000))
        except OSError:
            pass
        try:
            self._sock.close()
        except OSError:
            pass
