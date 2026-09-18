import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.map': 'application/json; charset=utf-8',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.avif': 'image/avif',
};

const UI_PREFIX = '/devtools/';

/**
 * A single HTTP server on the container's web-server port that:
 *  - serves the Chrome DevTools frontend (static files) so your LOCAL browser opens it - no Chrome
 *    in the Actor;
 *  - proxies the `/json*` discovery endpoints to the inspector;
 *  - proxies the CDP WebSocket upgrade to the inspector, rewriting `Host` to a loopback IP and
 *    dropping `Origin` so Node's inspector guard accepts the browser's connection.
 *
 * @param {{ listenPort: number, inspectorPort: number, frontendDir: string|null }} options
 * @returns {import('node:http').Server}
 */
export function startDebugServer({ listenPort, inspectorPort, frontendDir }) {
    const rewriteHost = `127.0.0.1:${inspectorPort}`;

    const serveStatic = (res, relPath) => {
        if (!frontendDir) {
            res.writeHead(404).end('DevTools frontend not bundled');
            return;
        }
        const safeRel = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
        const filePath = path.join(frontendDir, safeRel);
        if (!filePath.startsWith(frontendDir)) {
            res.writeHead(403).end('forbidden');
            return;
        }
        fs.stat(filePath, (err, stat) => {
            if (err || !stat.isFile()) {
                res.writeHead(404).end('not found');
                return;
            }
            res.writeHead(200, { 'content-type': MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream' });
            fs.createReadStream(filePath).pipe(res);
        });
    };

    const proxyJson = (req, res) => {
        const headers = { ...req.headers, host: rewriteHost };
        delete headers.origin;
        const upstream = http.request(
            { host: '127.0.0.1', port: inspectorPort, path: req.url, method: req.method, headers },
            (up) => {
                res.writeHead(up.statusCode ?? 502, up.headers);
                up.pipe(res);
            },
        );
        upstream.on('error', () => res.writeHead(502).end('inspector unavailable'));
        req.pipe(upstream);
    };

    const server = http.createServer((req, res) => {
        const urlPath = (req.url ?? '/').split('?')[0];
        if (urlPath === '/' || urlPath === '') {
            res.writeHead(302, { location: `${UI_PREFIX}js_app.html` }).end();
            return;
        }
        if (urlPath.startsWith('/json')) {
            proxyJson(req, res);
            return;
        }
        // Serve any other GET as a static frontend asset (js_app.html loads assets by relative and
        // root paths), so both /devtools/js_app.html and /core/... resolve into the frontend dir.
        const rel = urlPath.startsWith(UI_PREFIX) ? urlPath.slice(UI_PREFIX.length) : urlPath.replace(/^\//, '');
        serveStatic(res, rel);
    });

    // CDP WebSocket: rewrite Host -> loopback IP, drop Origin, then splice the sockets.
    server.on('upgrade', (req, clientSocket, head) => {
        const upstream = net.connect(inspectorPort, '127.0.0.1', () => {
            const lines = [`${req.method} ${req.url} HTTP/1.1`];
            const raw = req.rawHeaders;
            for (let i = 0; i < raw.length; i += 2) {
                const key = raw[i];
                if (/^host$/i.test(key)) lines.push(`Host: ${rewriteHost}`);
                else if (/^origin$/i.test(key)) continue;
                else lines.push(`${key}: ${raw[i + 1]}`);
            }
            upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
            if (head && head.length) upstream.write(head);
            upstream.pipe(clientSocket);
            clientSocket.pipe(upstream);
        });
        const close = () => {
            clientSocket.destroy();
            upstream.destroy();
        };
        upstream.on('error', close);
        clientSocket.on('error', close);
        clientSocket.on('close', close);
        upstream.on('close', close);
    });

    server.listen(listenPort, '0.0.0.0');
    return server;
}
