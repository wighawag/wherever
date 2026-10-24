# Upload test payloads found in the real os.tmpdir()

2026-10-24, noticed while doing `post-upload-progress-and-gate`: `/tmp` on telemaque holds about eight `<timestamp>_note.txt` files of 31 bytes (`this must never reach the disk\n`, the payload of `server/test/file-upload-read-only.test.ts`), dated over the previous day. The current tests set `uploads.type: 'session'`, so these probably come from older revisions or other worktrees that wrote with the default `'tmp'` type. Source not confirmed; worth checking whether any suite still uploads with `uploads.type` unset.
