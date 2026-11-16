---
title: A `bash -c` whose stdin is a socket sources the system bashrc, which resets PATH on NixOS
slug: bash-c-with-socket-stdin-sources-bashrc-and-resets-path
source: 'captured trace, 2026-07 (assistant-folder-opt-in-and-lock drive): the live dorfl gate vitest processes inspected by the drive conductor; bash(1) INVOCATION ("invoked by the remote shell daemon"); NixOS /etc/bashrc (`__ETC_PROFILE_DONE`, `NOSYSBASHRC` guards). Fixed on the caller side in dorfl and my-boxes.'
---

# A `bash -c` whose stdin is a socket sources the system bashrc, which resets PATH on NixOS

Node's default piped stdio for a child (`spawn(..., { stdio: 'pipe' })`) is implemented by libuv as a UNIX socketpair, not a pipe. Bash treats a NON-interactive shell whose stdin is a socket as "started by rshd/sshd" and sources the system bashrc. On NixOS `/etc/bashrc` then sources `/etc/profile` (when `__ETC_PROFILE_DONE` is not in the environment), which RESETS `PATH` to the system and profile dirs. Any tool the caller had on PATH only through a nix store path (a systemd unit's `path =`, a devshell) disappears inside that `bash -c`.

Seen as: dorfl ran the acceptance gate as `bash -c "<verify>"` with default stdio, and `server/test/readonly-config-deployment.test.ts`'s TLS tests failed with `spawnSync openssl ENOENT` although the dorfl process itself had `openssl` on PATH (provided by the wherever unit).

Caller-side remedies: spawn with `stdio: ['ignore', 'pipe', 'pipe']` (stdin not a socket), or set `NOSYSBASHRC=1` (the guard at the top of NixOS `/etc/bashrc`). Fixed on the caller side in dorfl and my-boxes. wherever's own guard: the TLS suite fails fast naming the missing binary (`server/test/require-binary.ts`), and the server's self-signed fallback says "`openssl` was not found on PATH".
