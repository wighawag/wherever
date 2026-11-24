---
"wherever-dev": patch
---

Refactor: the sidebar session row (link, working dot, name, "spawned by" hint, presence line, star / close / delete buttons, owned-session chips) is now its own `SessionRow` component, with its text helpers (`relativeTime`, `ownedChipLabel`, `rowNestMarker`) unit-tested in `web/src/lib/core/session-row.ts`. No visible or behavioural change; this prepares the upcoming "By owner" view of the session list.
