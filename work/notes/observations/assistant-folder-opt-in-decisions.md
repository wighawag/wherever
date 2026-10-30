# Decisions taken while building `assistant-folder-opt-in-and-lock` (2026-07)

Recorded per the work contract so a reviewer can ratify or reverse them. Code site: `server/src/assistant-folder.ts` (JSDoc at each choice).

1. **Status shape.** `GET /config` carries `assistant: { configured, folder, active, lock }`. `active` is a NEW concept: configured AND this server holds the folder lock. Later assistant tasks (pointer, scheduler, channels, tools) should gate on `active`, not on `configured`. Alternative: only `configured` + `lock.state`, leaving every consumer to combine them. Touches: `assistant-pointer-and-reset`, `channel-seam-notify-and-web-push`, `telegram-token-and-pairing`, `assistant-schedule-tools-server` (they add fields to this object).
2. **A refused server writes nothing into the folder.** Startup seeding and the `createNewSession` re-seed hook run only when the lock is HELD (the pool gets the folder via `SessionPool.setAssistantFolder` only when active). The AC asked for "only when the folder equals the configured `assistantFolder`"; this is strictly narrower. Alternative: seed whenever configured (harmless since create-only, but it writes into a folder another server owns).
3. **A corrupt (unparseable) lock file is taken over**, with a warning. Likeliest cause is a crash mid-write; refusing would wedge the assistant behind a file nobody can attribute. Alternative: refuse and ask for manual removal like a foreign-host lock.
4. **The lock is released** on graceful shutdown and on `process.on('exit')`, only if it is still this process's (pid + start time). A SIGKILLed server leaves it behind, which the staleness rules then take over on the next start.
5. **Path resolution.** `~` is expanded and a relative `assistantFolder` is resolved against the server's cwd (`searchFolder` does not resolve relatives). Alternative: reject relative paths.
6. **A seeding failure does not disable the assistant**: the lock is kept and the error logged, since the seed files are a convenience. A lock or mkdir failure does disable it (`lock.state: 'error'`).
7. **Changeset bump is `minor`** (new user-visible config key).
