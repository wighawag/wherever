---
"wherever-dev": patch
---

The assistant scheduler now catches up a new job's first run missed while the server was down. When it first saw each job, and when it last saw one re-enabled or its `cron` / `at` / `tz` edited, is persisted in the state dir (`assistant-first-seen.json`, never in `schedule.json`), so after a restart the normal grace rule applies to the first run too: a 9:00 reminder seen at 8:58 with the server down from 8:59 to 9:10 now fires on restart (and is skipped and recorded when the server was down past the grace window). A job hand-added while the server was down still starts from when it is first seen. A corrupt or missing file falls back to the previous behaviour with a warning.
