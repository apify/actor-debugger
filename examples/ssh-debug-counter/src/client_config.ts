/**
 * Builds the `ssh` client configuration for a run, which the Actor prints to the run log.
 *
 * The connection is a shell pipeline: `printf` writes the WebSocket handshake, `cat` then passes
 * the SSH client's bytes through unchanged, and `openssl s_client` carries the whole thing over
 * TLS. `-quiet` implies `-ign_eof`, which is what stops s_client from treating the binary SSH
 * stream as interactive commands.
 *
 * The pipeline has to be wrapped in `sh -c`, not written inline: OpenSSH runs `ProxyCommand` as
 * `exec <command>`, and `exec { ...; } | ...` is a shell syntax error.
 *
 * The SSH client tolerates the server's `101 Switching Protocols` lines because RFC 4253
 * section 4.2 requires it to skip anything before the `SSH-2.0-` identification string.
 */

export interface ClientConfigOptions {
    /** Hostname of the run's container URL, e.g. `<conductorKey>.runs.apify.net`. */
    host: string;
    /** Path the bridge accepts upgrades on, with its leading slash. */
    secretPath: string;
    /** Used only to name the `Host` alias in the config block. */
    runId: string;
    /** TLS port. Always 443 on the platform; a parameter so tests can point at a local stack. */
    port?: number;
}

export interface ClientConfig {
    /** A block to paste into `~/.ssh/config`. */
    config: string;
    /** The same thing as one shell command, for people who would rather not edit a config file. */
    oneLiner: string;
}

export function buildClientConfig({ host, secretPath, runId, port = 443 }: ClientConfigOptions): ClientConfig {
    const handshake = [
        `GET ${secretPath} HTTP/1.1`,
        `Host: ${host}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
    ].join('\\r\\n');

    // Double quotes around the printf format, so the whole pipeline can live inside the single
    // quotes of `sh -c '...'` without any escaping.
    const pipeline = `{ printf "${handshake}"; cat; } `
        + `| openssl s_client -quiet -connect ${host}:${port} -servername ${host} 2>/dev/null`;

    const proxyCommand = `sh -c '${pipeline}'`;

    const config = [
        `Host apify-${runId}`,
        `    HostName ${host}`,
        '    User root',
        `    ProxyCommand ${proxyCommand}`,
        // The host key is regenerated every run, so a persistent known_hosts entry would only
        // produce "host key changed" errors. StrictHostKeyChecking=ask still shows the
        // fingerprint, to compare against the one in the run log.
        '    UserKnownHostsFile /dev/null',
        '    StrictHostKeyChecking ask',
        // The ingress drops idle sockets after ~5 minutes (the ELB limit the worker codes to).
        '    ServerAliveInterval 30',
    ].join('\n');

    // One shell level further out than the config block: the option value is double quoted, so the
    // pipeline's own double quotes are escaped.
    const oneLiner = `ssh -o "ProxyCommand=sh -c '${pipeline.replaceAll('"', '\\"')}'" `
        + '-o UserKnownHostsFile=/dev/null -o StrictHostKeyChecking=ask '
        + `-o ServerAliveInterval=30 root@${host}`;

    return { config, oneLiner };
}
