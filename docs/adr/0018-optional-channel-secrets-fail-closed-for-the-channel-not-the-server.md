# An unreadable secret for an OPTIONAL channel disables that channel; it does not fail the server

**Status:** accepted

ADR 0007 makes a set-but-unreadable `WHEREVER_TOKEN_FILE` fatal, because the auth token gates every API route and a missing one fails OPEN (an unauthenticated server that looks healthy). The assistant's Telegram bot token (`WHEREVER_TELEGRAM_TOKEN` / `WHEREVER_TELEGRAM_TOKEN_FILE`, spec `assistant-session-and-channels`) follows ADR 0007's resolution order and env scrub, but deliberately NOT its fatal rule: a missing bot token fails CLOSED (the channel simply cannot connect), so the right response is to disable Telegram with a loud error and keep the server, its sessions and the other channels running. The same applies to any future optional channel secret. The env variables are still scrubbed from `process.env` after reading, because the agent's `bash` inherits the server environment.

The assistant's folder lock is a related placement choice: it lives in `<assistantFolder>/.assistant.lock`, not in the state dir, because the case it exists to catch (two servers configured on one assistant folder, e.g. a dev instance beside the real one) usually involves two DIFFERENT state dirs, which a state-dir lock would never see. It only reports the misconfiguration loudly; it is not a supported mode.
