/**
 * Runs an OpenSSH server inside the Actor container, on loopback only.
 *
 * It is never exposed as a TCP port - the only route to it is the WebSocket bridge in
 * `ssh_bridge.ts`. Authentication is the public key you pass in the Actor input, so the bridge's
 * unguessable URL is obfuscation and sshd is the actual access control.
 */

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';

const SSHD_BINARY = '/usr/sbin/sshd';
const CONFIG_PATH = '/etc/ssh/sshd_config.actor-debug';
const HOST_KEY_PATH = '/etc/ssh/ssh_host_ed25519_key.actor-debug';
const AUTHORIZED_KEYS_PATH = '/root/.ssh/authorized_keys';

export interface SshdOptions {
    port: number;
    /** A single OpenSSH public key line, e.g. `ssh-ed25519 AAAA... you@laptop`. */
    authorizedKey: string;
}

export interface Sshd {
    process: ChildProcess;
    /** `ssh-keygen -lf` output for the host key, to compare with what ssh shows on first connect. */
    hostKeyFingerprint: string;
}

export function startSshd({ port, authorizedKey }: SshdOptions): Sshd {
    fs.mkdirSync('/root/.ssh', { recursive: true, mode: 0o700 });
    fs.writeFileSync(AUTHORIZED_KEYS_PATH, `${authorizedKey.trim()}\n`, { mode: 0o600 });

    // Privilege separation directories. Alpine's package expects /var/empty, Debian's /run/sshd.
    fs.mkdirSync('/var/empty', { recursive: true });
    fs.mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });

    // A fresh host key per run, so no private key is ever baked into the image. The cost is that
    // the fingerprint changes every run - hence the `UserKnownHostsFile /dev/null` in the printed
    // client config, and the fingerprint in the log to compare against.
    fs.rmSync(HOST_KEY_PATH, { force: true });
    fs.rmSync(`${HOST_KEY_PATH}.pub`, { force: true });
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'actor-debug-run', '-f', HOST_KEY_PATH]);

    fs.writeFileSync(
        CONFIG_PATH,
        [
            `Port ${port}`,
            'ListenAddress 127.0.0.1',
            `HostKey ${HOST_KEY_PATH}`,
            'PermitRootLogin prohibit-password',
            'PasswordAuthentication no',
            'KbdInteractiveAuthentication no',
            'PubkeyAuthentication yes',
            `AuthorizedKeysFile ${AUTHORIZED_KEYS_PATH}`,
            // No UsePAM here: Alpine's sshd is built without PAM and logs "Unsupported option"
            // for it. Password and keyboard-interactive auth are already off above.
            'X11Forwarding no',
            'PrintMotd no',
            'PidFile /run/sshd.actor-debug.pid',
            // internal-sftp keeps scp/sftp working without depending on where the distro puts
            // sftp-server (Alpine and Debian disagree).
            'Subsystem sftp internal-sftp',
            '',
        ].join('\n'),
        { mode: 0o600 },
    );

    // `-D` keeps it in the foreground so it dies with the Actor; `-e` sends its log to stderr,
    // which lands in the run log.
    const process_ = spawn(SSHD_BINARY, ['-D', '-e', '-f', CONFIG_PATH], { stdio: 'inherit' });

    const hostKeyFingerprint = execFileSync('ssh-keygen', ['-lf', `${HOST_KEY_PATH}.pub`]).toString().trim();

    return { process: process_, hostKeyFingerprint };
}
