/**
 * Sample Actor: counts from 1 to 100, one tick per second, optionally with a live SSH session
 * into the running container.
 *
 * With input `{"debug": true, "sshPublicKey": "ssh-ed25519 AAAA..."}` the run starts an sshd on
 * loopback and serves a WebSocket-to-SSH bridge on the container URL. The run log then prints an
 * `~/.ssh/config` block you paste and use with plain `ssh` - no tunnel client to install, no
 * bastion, no inbound port on your machine.
 */

import type { ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import { Actor, log } from 'apify';

import { buildClientConfig } from './client_config.js';
import { startSshBridge, type SshBridge } from './ssh_bridge.js';
import { startSshd } from './sshd.js';

/** Loopback-only. Never published - the bridge is the single way in. */
const SSHD_PORT = 2222;

interface Input {
    debug?: boolean;
    sshPublicKey?: string;
    waitForConnection?: boolean;
}

function startDebugSession(sshPublicKey: string): { bridge: SshBridge; sshd: ChildProcess } | undefined {
    const webServerPort = Number(process.env.ACTOR_WEB_SERVER_PORT);
    const webServerUrl = process.env.ACTOR_WEB_SERVER_URL;

    if (!webServerPort || !webServerUrl) {
        log.warning(
            'ACTOR_WEB_SERVER_PORT/URL are not set (running locally?) - skipping the SSH bridge. '
                + 'Locally you already have a shell, so just run the Actor under your own tooling.',
        );
        return undefined;
    }

    const { protocol, hostname } = new URL(webServerUrl);
    if (protocol !== 'https:') {
        log.warning(
            `Container URL is ${webServerUrl}, not https - this looks like a local dev stack. `
                + 'The printed config assumes the platform\'s https container URL, so skipping the SSH bridge.',
        );
        return undefined;
    }

    // Per-run secret path. Anyone who can read this run can read it, so it is obfuscation, not
    // access control - sshd's public key auth is what actually guards the session.
    const secretPath = `/${randomBytes(18).toString('base64url')}`;

    const sshd = startSshd({ port: SSHD_PORT, authorizedKey: sshPublicKey });
    const bridge = startSshBridge({ listenPort: webServerPort, sshdPort: SSHD_PORT, secretPath });

    const runId = process.env.ACTOR_RUN_ID ?? 'run';
    const { config, oneLiner } = buildClientConfig({ host: hostname, secretPath, runId });

    log.info('='.repeat(78));
    log.info('SSH is ON for this run. Paste this into ~/.ssh/config:');
    log.info(`\n${config}\n`);
    log.info(`Then connect with:  ssh apify-${runId}`);
    log.info('');
    log.info('Or as a single command, without touching ~/.ssh/config:');
    log.info(`\n${oneLiner}\n`);
    log.info(`Host key fingerprint (compare with what ssh shows on connect): ${sshd.hostKeyFingerprint}`);
    log.info('Requires only ssh and openssl, both preinstalled on macOS and Linux.');
    log.info('='.repeat(78));

    return { bridge, sshd: sshd.process };
}

await Actor.init();

const input = (await Actor.getInput<Input>()) ?? {};
let session: { bridge: SshBridge; sshd: ChildProcess } | undefined;

if (input.debug) {
    if (!input.sshPublicKey?.trim()) {
        throw new Error('debug=true requires sshPublicKey - paste the contents of e.g. ~/.ssh/id_ed25519.pub.');
    }
    session = startDebugSession(input.sshPublicKey);

    if (session && (input.waitForConnection ?? true)) {
        log.info('Waiting for an SSH session to connect (no timeout - abort the run to give up)...');
        await session.bridge.firstConnection;
        log.info('SSH session connected.');
    }
}

try {
    for (let count = 1; count <= 100; count++) {
        log.info(`Count: ${count}`);
        await Actor.pushData({ count });
        if (count % 10 === 0) {
            await Actor.setStatusMessage(`Counted to ${count}/100`);
        }
        await sleep(1000);
    }
    await Actor.setStatusMessage('Finished counting to 100');
} finally {
    session?.sshd.kill();
    session?.bridge.server.close();
}

await Actor.exit();
