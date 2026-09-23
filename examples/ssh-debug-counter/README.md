# SSH debug counter — a shell inside a running Actor, with nothing to install

A minimal Actor that counts from 1 to 100 (one tick per second, each count logged and pushed to the
dataset), built to demonstrate **a real SSH session into a run executing on the Apify platform**.

The point of this sample is the client side: you connect with the `ssh` and `openssl` already on
your machine. No `wstunnel`, no `cloudflared`, no bastion host, no public IP, no inbound port on
your laptop.

```
ssh ── ProxyCommand: printf + openssl s_client ── wss:// (the run's container URL)
                                                    │
                                                    ▼
                                    WebSocket upgrade, then raw bytes
                                                    │
                                                    ▼
                                      ssh_bridge.ts (in the run)
                                                    │  tcp://127.0.0.1:2222 (loopback only)
                                                    ▼
                                            sshd (in the run)
```

## How it works

The platform publishes no raw TCP port for a container — `apify-worker` maps exactly two container
ports, the web server and Standby ports, and the host firewall drops everything else. The only way
in is the run's HTTPS container URL.

That URL does carry WebSocket upgrades end to end, and this sample exploits one property of that
path: **once the container answers `101 Switching Protocols`, nothing in front of it looks at the
stream again.** The worker proxies upgrades with `http-proxy`, whose `ws-incoming` pass validates
only that the request is a `GET` carrying `Upgrade: websocket`, and then splices the two sockets
together (`proxySocket.pipe(socket).pipe(proxySocket)`). No frame parsing. So the handshake has to
*look* like WebSocket, but everything after it can be — and here is — the SSH wire protocol,
unframed.

The other half is on your side. RFC 4253 §4.2 requires an SSH client to skip any lines a server
sends before its `SSH-2.0-` identification string, and OpenSSH does. That means the `101` response
headers are simply discarded by your `ssh`, so no program is needed to strip them, and the whole
client side collapses into one `ProxyCommand`:

```
sh -c '{ printf "GET /<secret> HTTP/1.1\r\nHost: <host>\r\nUpgrade: websocket\r\n..."; cat; } | openssl s_client -quiet -connect <host>:443 -servername <host> 2>/dev/null'
```

`printf` writes the handshake, `cat` passes your SSH client's bytes through, `openssl s_client`
carries it over TLS. `-quiet` is load-bearing: it implies `-ign_eof`, which stops `s_client` from
interpreting the binary SSH stream as interactive commands. The `sh -c` wrapper is load-bearing
too — OpenSSH runs `ProxyCommand` as `exec <command>`, and `exec { …; } | …` is a shell syntax
error.

## Prerequisites on your machine

`ssh` and `openssl`. Both ship with macOS and every Linux distribution. That is the whole list.

## Deploy and run

```bash
cd examples/ssh-debug-counter
apify push
```

Start a run with input:

```json
{
    "debug": true,
    "sshPublicKey": "ssh-ed25519 AAAAC3Nza... you@laptop",
    "waitForConnection": true
}
```

`sshPublicKey` is the contents of e.g. `~/.ssh/id_ed25519.pub`. Password login is off, so that key
is the only credential that opens the session.

With `waitForConnection: true` (default) the Actor pauses before counting until you connect — there
is no timeout, the run timeout is the safety net, so abort the run if you change your mind. Set it
to `false` to start counting immediately and connect mid-run.

## Connect

The run log prints a ready-to-paste block:

```
Host apify-<runId>
    HostName <conductorKey>.runs.apify.net
    User root
    ProxyCommand sh -c '{ printf "GET /<secret> HTTP/1.1\r\n..."; cat; } | openssl s_client -quiet -connect ... 2>/dev/null'
    UserKnownHostsFile /dev/null
    StrictHostKeyChecking ask
    ServerAliveInterval 30
```

Paste it into `~/.ssh/config` and run `ssh apify-<runId>`. The log also prints the same thing as a
single `ssh …` command if you would rather not touch the config file.

Everything a normal SSH connection gives you works: `scp` and `sftp`, `-L` and `-R` forwards, and
VS Code Remote-SSH (point it at the `Host` alias).

If your key is not one of the defaults, add `IdentityFile ~/.ssh/your_key` to the block.

### Host key

A fresh host key is generated per run, so nothing secret is baked into the image. That is why the
config sets `UserKnownHostsFile /dev/null` — a persistent entry would only ever produce "host key
changed" errors. `StrictHostKeyChecking ask` still shows you the fingerprint on connect; compare it
with the one the run log prints. You get asked once per connection, which is the price of not
pinning a key that legitimately changes every run.

## Safety notes

- **`debug` defaults to off.** Only turn it on for runs you are actively working on, and never ship
  a published Actor with it reachable.
- **An SSH session is full code execution inside the run**, including access to its environment and
  `APIFY_TOKEN`. Prefer a run started with a restricted token.
- **The secret path is obfuscation, not access control.** It is printed to the run log, so it is
  only as secret as read access to the run. `sshd`'s public key authentication is what actually
  guards the session.
- **The container URL is unauthenticated**, so anyone who learns it can reach the bridge — and then
  gets stopped by `sshd` asking for a key they do not have.
- **A waiting run still burns compute and run time.** `waitForConnection` blocks indefinitely.
- The Dockerfile sets `USER root`, because `sshd` needs root to authenticate a login. That differs
  from how a normal Actor image runs.

## Standby

The bridge works the same on a Standby run — by default the Standby container port resolves to
`ACTOR_WEB_SERVER_PORT`, so one bridge serves both. But going in through the run's own container
URL does **not** reset the Standby idle timer, so the run is still reaped after `idleTimeoutSecs`
(default 300s) with no Standby traffic. Going in through the Standby URL does reset it, but it
consumes one of `maxRequestsPerActorRun` and load-balances across runs, so you cannot be sure which
container you land on. For interactive work, use an on-demand run.

## Idle timeout

The ingress drops idle sockets after ~5 minutes (`SOCKET_TIMEOUT_MILLIS` is 310s in apify-core,
below the 330s ELB limit). `ServerAliveInterval 30` in the printed config keeps the connection
alive; don't remove it.

## Local development

`apify run` skips the bridge: there is no https container URL locally, and you already have a shell
on the machine. The Actor logs a warning and just counts.
