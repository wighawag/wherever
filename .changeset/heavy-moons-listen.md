---
'wherever-dev': minor
---

Serve on a unix socket, with `--socket <path>` or `--socket fd://<n>`.

`--socket /run/wherever/wherever.sock` binds a unix socket instead of a TCP port, for running behind nginx or Caddy (`reverse_proxy unix/<path>`). A stale socket file left by a crashed server is removed first; a socket something is still *serving* is refused rather than unlinked, because stealing it would leave the incumbent running and permanently unreachable. A path that exists and is not a socket is refused outright, so a typo in a unit file cannot destroy a file. The mode is set deliberately (`--socket-mode`, default 0660) rather than inherited from the ambient umask, which otherwise decides whether the proxy can connect based on whichever shell happened to launch the service.

`--socket fd://3` adopts a socket a supervisor already created, bound, chowned and chmodded, which is what systemd socket activation passes. This is the better form for a supervised service: systemd applies `SocketUser=`/`SocketGroup=`/`SocketMode=` as root before the process starts, so the socket can be owned by one account and connectable by a proxy running as a different uid, with no shared group, no setgid parent directory and no privileged code in the server. The descriptor is verified to be an open socket before use, and `LISTEN_FDS`/`LISTEN_PID` are honoured: a mismatched `LISTEN_PID` warns rather than refusing, since the descriptor was named explicitly and an inherited fd survives a fork perfectly well.

Three things that are not the listen call but would otherwise be wrong: the startup banner describes the socket instead of interpolating a `host:port` that does not exist; the no-token warning gets its own branch, because a socket is neither the off-loopback case (that warning would misstate what is exposed) nor the quiet loopback case (a socket's reach is its file mode, which is routinely widened for a proxy), and without it an unauthenticated socket warned nothing at all; and `--http-localhost-fallback` is refused alongside `--socket` rather than silently kept, since it opens a second TCP listener and so hands an operator who asked for no TCP surface one anyway.

A unix socket also no longer mints a self-signed certificate. TLS over a unix socket protects nothing, the generated certificate is `CN=localhost` and a socket has no hostname to match, and minting it writes a keypair unasked. Explicit `--ssl-key`/`--ssl-cert` are still honoured.

Also fixes test isolation: `test/harness.ts` neutralises `WHEREVER_STATE_DIR` alongside the `WHEREVER_CONFIG_DIR` it already isolated. Drafts live in the state dir, so without this the suite read and appended to the real one whenever it was run from inside a wherever session, where the server's own `WHEREVER_STATE_DIR` is inherited by every descendant shell.
