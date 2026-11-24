---
"wherever-dev": minor
---

The session list gains a "By folder / By owner" toggle (main list only, remembered on this device, shown only when shipmates is available and some listed session has an owner). "By owner" groups each orchestration into one tree across folders: spawned sessions nest under their owner, hand-made forks under the session they were forked from, each row tagged with its folder. Groups are ordered by their latest activity; a session whose owner is not listed becomes a root marked "spawned by (not listed)"; closed sessions follow "Show closed", with a closed owner of an open session kept as dimmed context. Cycles in ownership never hide a session. The grouping is the pure, unit-tested `ownerTree` in `web/src/lib/core/owner-tree.ts`. "By folder" is unchanged.
