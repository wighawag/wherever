# `conversation-mode-hint` lockstep test compares two independent `Date.now()` stamps

2026-09-10 — noticed while running the full server suite for `new-session-clone-via-registry`.

`server/test/conversation-mode-hint.test.ts > lockstep with the CLI-bridge extension twin > places the tail reminder identically` failed with a 2 ms difference in the reminder message's `timestamp` (expected `...151`, received `...149`): the test deep-equals the output of the server's `withConversationModeReminder` against the extension's twin, and each stamps its own `Date.now()` (`server/src/conversation-mode-hint.ts:161`, `extension/src/conversation-mode-hint.ts:152`). It passes whenever both calls land in the same millisecond, so it is a real race that only shows under load. Out of scope for this task; the fix is presumably to compare with the timestamp excluded (or to freeze time) rather than to change either implementation.
