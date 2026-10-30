# The assistant's schedule is server-owned: intent lives in the assistant folder, run state in the state dir, and times follow the user

**Status:** accepted

The assistant (spec `assistant-session-and-channels`) schedules its own jobs. We run them from a scheduler inside the wherever server rather than the system crontab, because a crontab entry spawns a detached `pi -p` whose output has no session and no channel to go to, while the server can inject an inline job into the live assistant session or start an isolated session in `<assistantFolder>/jobs/` and route its `assistant_notify`.

The schedule is split by who writes it. `<assistantFolder>/schedule.json` holds only INTENT (`cron` or `at`, optional `tz`, mode, prompt, enabled, origin) so the user can read, hand-edit and version it with the rest of the assistant's memory; the server never writes run bookkeeping into it, so it can never clobber a hand edit. Run history is an append-only `assistant-runs.jsonl` in the STATE dir (ADR 0006: the config dir may be read-only, and run state is server-written), from which last/next run are derived. Tool writes to `schedule.json` are serialised through one in-process queue on the server (CLI-bridge tool calls reach the server over the bridge, ADR 0016), atomic, and re-read-and-retry when the file changed on disk.

Times follow the USER by default: a job without `tz` is evaluated in the user's current timezone, which is server state (it changes when travelling), reported by the web client and settable by the assistant; a job with `tz` is pinned ("call mom at 6pm her time"). The alternative, the server's system timezone, is wrong for a NixOS service that typically runs in UTC and for a travelling user.

Considered and rejected: run state inside `schedule.json` (read-modify-write races with hand edits); everything in the state dir (opaque to the user, loses "the folder is the memory").
