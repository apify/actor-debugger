/**
 * Serves the run's container URL and turns a WebSocket upgrade into a raw pipe to the local sshd.
 *
 * The platform publishes no raw TCP port for a container: the only way in is the run's HTTPS
 * container URL. That path does carry WebSocket upgrades end to end, and once the container
 * answers `101 Switching Protocols` every hop in front of it (ALB, Conductor, the worker's
 * `http-proxy`) stops interpreting the stream and just splices the sockets. Nothing checks that
 * what follows is really WebSocket framing - so what follows here is the SSH wire protocol,
 * unframed. That is what lets a plain `ssh` client reach the run with no tunnel helper installed.
 *
 * The handshake must still *look* like WebSocket, because `http-proxy` destroys the socket unless
 * the request is a GET carrying `Upgrade: websocket`.
 */

import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';

/** RFC 6455 handshake GUID, used to derive `Sec-WebSocket-Accept` from the client's key. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface SshBridgeOptions {
    /** Port to serve on - always `ACTOR_WEB_SERVER_PORT`, the one the platform publishes. */
    listenPort: number;
    /** Loopback port the in-container sshd listens on. */
    sshdPort: number;
    /** Unguessable path an upgrade must target, e.g. `/HqE0...`. Anything else gets a 404. */
    secretPath: string;
}

export interface SshBridge {
    server: http.Server;
    /** Resolves the first time an SSH session is spliced through. */
    firstConnection: Promise<void>;
}

function acceptHeaderFor(clientKey: string | undefined): string {
    return createHash('sha1').update(`${clientKey ?? ''}${WS_GUID}`).digest('base64');
}

export function startSshBridge({ listenPort, sshdPort, secretPath }: SshBridgeOptions): SshBridge {
    let markConnected: () => void = () => {};
    const firstConnection = new Promise<void>((resolve) => {
        markConnected = resolve;
    });

    // Any plain GET answers 200. The worker probes `GET /` to decide the container server is up
    // (it accepts any status), so without this the run never reports itself as ready.
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('ssh-debug-counter: SSH bridge is up. Use the ssh command printed in the run log.\n');
    });

    server.on('upgrade', (req, socket, head) => {
        if (req.url !== secretPath) {
            socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
            return;
        }

        // Typed as a Duplex on the `upgrade` event, but it is always the underlying TCP socket.
        const clientSocket = socket as net.Socket;

        const sshd = net.connect(sshdPort, '127.0.0.1', () => {
            // Nagle would add up to 40ms to every keystroke of an interactive session.
            clientSocket.setNoDelay(true);
            sshd.setNoDelay(true);
            // The upgraded socket outlives any HTTP-level timeout.
            clientSocket.setTimeout(0);

            socket.write(
                'HTTP/1.1 101 Switching Protocols\r\n'
                    + 'Upgrade: websocket\r\n'
                    + 'Connection: Upgrade\r\n'
                    + `Sec-WebSocket-Accept: ${acceptHeaderFor(req.headers['sec-websocket-key'])}\r\n\r\n`,
            );

            // Bytes the client sent in the same packet as the handshake.
            if (head?.length) sshd.write(head);

            // From here the stream is raw SSH in both directions. The client skips the 101 lines
            // above as pre-banner noise, which RFC 4253 section 4.2 requires it to tolerate.
            socket.pipe(sshd).pipe(socket);
            markConnected();
        });

        sshd.on('error', () => socket.destroy());
        socket.on('error', () => sshd.destroy());
    });

    server.listen(listenPort, '0.0.0.0');

    return { server, firstConnection };
}
