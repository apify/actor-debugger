#!/usr/bin/env node
/**
 * actor-debugger - launch an Apify Node/TS Actor under the Node inspector, reachable over the
 * run's container URL, with a one-line Dockerfile change:
 *
 *   CMD ["npx", "actor-debugger"]                    # auto-detect the Actor's entrypoint
 *   CMD ["npx", "actor-debugger", "dist/x.js"]       # explicit entrypoint
 *   CMD ["npx", "actor-debugger", "--brk"]           # pause on the first line until attached
 *
 * Running through this command is what enables debugging - revert the CMD to the normal
 * entrypoint to turn it off.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';

import { startDebugServer } from '../lib/debug_server.mjs';

const INSPECTOR_PORT = 9229;
const TAG = '[actor-debugger]';

/** Locate chii's prebuilt Chrome DevTools frontend (chrome-devtools-frontend npm ships unbuilt source). */
function findFrontendDir() {
    const req = createRequire(import.meta.url);
    for (const spec of ['chii/public/front_end/js_app.html', 'chii/package.json']) {
        try {
            const resolved = req.resolve(spec);
            const dir = spec.endsWith('package.json')
                ? path.join(path.dirname(resolved), 'public', 'front_end')
                : path.dirname(resolved);
            if (fs.existsSync(path.join(dir, 'js_app.html'))) return dir;
        } catch {
            // try next
        }
    }
    return null;
}

function resolveEntry(argEntry) {
    if (argEntry) return path.resolve(argEntry);
    const candidates = [];
    try {
        const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
        const startMatch = pkg.scripts?.start && /node\s+(?:--\S+\s+)*(\S+)/.exec(pkg.scripts.start);
        if (startMatch) candidates.push(startMatch[1]);
        if (pkg.main) candidates.push(pkg.main);
    } catch {
        // no/invalid package.json - fall through to conventional paths
    }
    candidates.push('dist/main.js', 'dist/index.js', 'build/main.js', 'src/main.js', 'main.js', 'index.js');
    for (const candidate of candidates) {
        if (candidate && fs.existsSync(candidate)) return path.resolve(candidate);
    }
    return null;
}

function fetchInspectorUuid(retries = 40) {
    return new Promise((resolve) => {
        const attempt = (left) => {
            const req = http.get(
                { host: '127.0.0.1', port: INSPECTOR_PORT, path: '/json/list', timeout: 500 },
                (res) => {
                    let body = '';
                    res.on('data', (c) => (body += c));
                    res.on('end', () => {
                        try {
                            const id = JSON.parse(body)[0]?.id;
                            if (id) return resolve(id);
                        } catch {
                            // not ready yet
                        }
                        left > 0 ? setTimeout(() => attempt(left - 1), 250) : resolve(null);
                    });
                },
            );
            req.on('error', () => (left > 0 ? setTimeout(() => attempt(left - 1), 250) : resolve(null)));
            req.on('timeout', () => req.destroy());
        };
        attempt(retries);
    });
}

async function announce(webServerUrl, hasFrontend) {
    const uuid = await fetchInspectorUuid();
    if (!uuid) {
        console.error(`${TAG} inspector did not come up on 127.0.0.1:${INSPECTOR_PORT}.`);
        return;
    }
    const base = webServerUrl.replace(/\/$/, '');
    const host = base.replace(/^https?:\/\//, '');
    console.error('='.repeat(72));
    console.error(`${TAG} debugging is ON - reachable over the container URL.`);
    if (hasFrontend) {
        console.error(`${TAG} OPEN THIS in your local browser for a full DevTools UI (no local setup):`);
        console.error(`${TAG}   ${base}/devtools/js_app.html?wss=${host}/${uuid}`);
    }
    console.error(`${TAG} or verify the raw CDP channel: npx wscat -c "wss://${host}/${uuid}"`);
    console.error(`${TAG}   then send {"id":1,"method":"Runtime.evaluate","params":{"expression":"2+2"}}`);
    console.error('='.repeat(72));
}

const args = process.argv.slice(2);
const brk = args.includes('--brk');
const entry = resolveEntry(args.find((a) => !a.startsWith('--')));
if (!entry) {
    console.error(`${TAG} could not find an Actor entrypoint. Pass one explicitly:`);
    console.error(`${TAG}   CMD ["npx", "actor-debugger", "dist/main.js"]`);
    process.exit(1);
}

const inspectFlag = brk ? '--inspect-brk' : '--inspect';
const nodeArgs = ['--enable-source-maps', `${inspectFlag}=127.0.0.1:${INSPECTOR_PORT}`];

const child = spawn(process.execPath, [...nodeArgs, entry], { stdio: 'inherit', env: process.env });

let server;
const { ACTOR_WEB_SERVER_PORT: port, ACTOR_WEB_SERVER_URL: url } = process.env;
if (port && url) {
    const frontendDir = findFrontendDir();
    if (!frontendDir) console.error(`${TAG} DevTools frontend (chii) not found - serving CDP only, no UI.`);
    server = startDebugServer({ listenPort: Number(port), inspectorPort: INSPECTOR_PORT, frontendDir });
    announce(url, Boolean(frontendDir));
} else {
    console.error(`${TAG} ACTOR_WEB_SERVER_URL/PORT not set - inspector on 127.0.0.1:${INSPECTOR_PORT} only (no container-URL bridge).`);
}

child.on('exit', (code, signal) => {
    server?.close();
    process.exit(code ?? (signal ? 1 : 0));
});
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
