# Decisions: web-timezone-report-only-when-the-device-moves (2026-10-31)

Non-obvious in-scope choices made while implementing ADR 0019.

1. **The device remembers a zone as soon as it sends it, whether or not the server applied it.** Chosen because ADR 0019 defines the trigger as "differs from the last zone THAT browser reported", and there is no ack frame to wait for. Alternative considered: remember only after the server confirms an applied change (needs a new server reply frame, and would make an ignored first report resend on every connect). Consequence: a browser that reported while the assistant was not active (or to an older server) will not report again until its zone changes, so enabling `assistantFolder` later does not pick up that browser's zone; the system zone or `assistant_set_timezone` covers that case. Touches: `web/src/lib/core/timezone-report.ts` only (module JSDoc).

2. **Storage key `wherever-timezone-reported`, per browser origin, not per server.** Follows the existing `wherever-*` localStorage naming. Alternative: key it by the stamped server (like the conversation cache, ADR 0013). Not done: the remembered value describes the DEVICE's last report, and a per-server key would only matter for a user pointing one browser at several assistant servers.

3. **Unreadable storage reads as "nothing remembered", so the report is a first one.** A first report never overrides an explicit setting, so this fails safe; the cost is one report per connect in such a browser. Alternative: send nothing when storage is unusable (would never report a real move).

4. **Wire shape: `first` is always a boolean from the new web; the server tests `first === true`.** So an older web (field absent) and any non-boolean value read as non-first, which is exactly the old "applies when it differs" behaviour (the task's compatibility requirement). An older server ignores the unknown field.

5. **"Set explicitly" = the latest timezone history entry's source is `assistant_set_timezone` (`SET_TIMEZONE_SOURCE`).** Exposed as `getUserTimezoneSource()` on the scheduler and added (required) to `AssistantScheduleBackend`. CLI tool twins' `set_timezone` op uses the same default source, so it counts as explicit too. The decision lives in `webTimezoneReport` in `server/src/assistant-tools.ts` (JSDoc).

6. **An ignored first report still answers `ok: true` with `details.ignored: true`** (not an error), so the server does not log a warning for the normal case; only an unknown zone is logged.
