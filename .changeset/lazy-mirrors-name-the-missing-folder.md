---
'wherever-dev': minor
---

Make "this session's folder does not exist on this machine" an explicit, safe, explained state instead of a silently broken one.

Transcripts and the folders they refer to travel separately: a transcript syncs (syncthing, a backup, a new laptop), the git clone it talks about does not. Opening such a session used to look fine and then quietly hand you a live agent pointed at a directory that is not there: pi's `SettingsManager.create()` and `DefaultResourceLoader.reload()` both succeed against a nonexistent cwd, so nothing threw and the first sign of trouble was every file and bash tool misbehaving for no stated reason.

- The cheap session-meta read now also answers whether the working folder EXISTS (one `stat`, beside the read-only verdict it already computes from the cwd), so both the warm and the cold load path share the answer.
- When it does not exist, the transcript still paints (reading never needed the folder), the client is marked read-only, and the cold path does **not** build the live agent at all. There is no `session_ready`, so the composer stays disabled.
- New `folder_missing` frame (plus a `folderMissing` flag on `session_created`) carries the **absolute** missing path, and the dashboard replaces the composer with a notice naming it. The shared client package mirrors it as `WhereverState.folderMissing`.
- A message sent anyway is refused out loud, naming the path, instead of being dropped in silence.
- Read-only precedence is now explicit and lives in one predicate: a configured `sessions.readOnly` folder is hard and never lifted, a missing folder is hard and lifted only by restoring the folder and reloading, and a folder conflict remains the only dismissible one. "Continue anyway" can no longer lift a missing-folder lock.
- Detection is load-time only, deliberately: a session that is already RESIDENT when its folder is found missing is locked read-only for anyone loading it, but its running agent is left alone.

Older clients degrade safely: they simply do not render the notice, and the server's own refusal is what protects them. The restore ACTIONS (clone/create with progress) are separate, later work; until they land this state is locked with no in-app remedy, which is strictly better than an agent running against a directory that is not there. See the new `CONTEXT.md` sections and `docs/adr/0009` / `0010`.
