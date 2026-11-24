---
title: Close a session (hide it from the list and from search, without deleting it)
slug: closed-sessions
taskedAfter: [session-list-live-strip]
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Problem Statement

Sessions only ever accumulate. With agents spawning sessions, a single piece of work can leave five or ten sessions behind, and the sidebar fills with finished conversations the user will never open again but does not want to delete (they are history, and memonaut search should still be able to reach them when asked). Today the only ways out are deletion (destructive, even with the cascade undo) or retention (`maxAgeDays` / `maxSessions`, blind to what the user is done with). There is no "I am done with this, get it out of my way".

## Solution

A **Close** action on every session (a row button beside star and delete, and the top bar), the opposite of a star. A closed session keeps its transcript on disk, untouched; it simply stops being listed in the sidebar and stops appearing in conversation search and the sidebar filter, unless the user turns on a **Show closed** toggle, in which case closed sessions appear dimmed and can be reopened. Closing a session that owns spawned sessions offers to close its whole owned subtree in one go. A closed session that comes back to life (someone writes to it) reopens on its own, so nothing that needs the user can silently disappear.

## User Stories

1. As a user, I want to close a session from a button on its row in the sidebar (beside star and delete, main list only), so that finished work stops cluttering my list.
2. As a user, I want to close the session I have open from the top bar, so that I can close it at the natural moment, right after finishing with it.
3. As a user, I want closing to never touch the transcript on disk, so that closing is always safe and reversible.
4. As a user, I want closed sessions hidden from the main session list by default, so that the list shows only what I still care about.
5. As a user, I want a "Show closed" toggle in the sidebar that brings closed sessions back into the list, dimmed and marked closed, so that I can find and reopen them.
6. As a user, I want a Reopen action on a closed session, so that I can bring it back permanently.
7. As a user, I want a folder whose sessions are all closed to disappear from the list (while "Show closed" is off), so that dead projects do not leave empty headers.
8. As a user, when I close a session that owns spawned sessions, I want to be asked whether to also close the N sessions it owns (default: yes), so that I can put away a whole orchestration in one click.
9. As a user, I want the cascade to follow ownership transitively (children's children), wherever the owned sessions live, so that worktree sessions go away with their orchestrator.
10. As a user, I want closed sessions excluded from conversation search by default, with an "Include closed" toggle in the search panel (remembered on this device; closed threads shown dimmed when included), so that search focuses on live work but history stays reachable.
11. As a user, I want the sidebar filter box to skip closed sessions unless "Show closed" is on, so that the filter and the list agree.
12. As a user, I want a closed session to reopen automatically when it gets new activity (a message from me on any channel, a shipmates delivery that wakes it, an agent turn starting), so that a session that needs me never hides behind "closed".
13. As a user, I want a closed session that raises an inbox item to reopen, and the inbox to link to it as usual, so that "Needs you" and the list never disagree.
14. As a user, I want a session that is currently working to show up in the Live strip even if closed (the strip computes over the full listing, closed included), so that a running agent is never invisible.
15. As a user, I want closing to work from any device and show on every device, so that closing on the phone hides it on the laptop too.
16. As a user, I want a fork tree with a closed parent and an open child to still show the child, with the closed parent shown dimmed as context (not hidden), so that the tree stays readable.
17. As a user, I want deleting a closed session to work as before (the close flag goes with it), so that close and delete do not conflict.
18. As a user, I want retention (`maxAgeDays` / `maxSessions`) unchanged by close (closed sessions are not exempt the way starred ones are), so that close does not grow the kept set.
19. As a user, I want an undo right after I close something (a short "Closed X (and N owned). Undo" banner, like the cascade-delete banner) that reopens the whole batch and restores any star the close removed, so that a misclick costs nothing.
20. As a maintainer, I want one server-side module to be the only writer of the closed set, so that concurrency and corruption are handled once.

### Autonomy notes

- **`humanOnly`:** omitted. Ordinary product work.
- **`taskedAfter: [session-list-live-strip]`:** story 14 changes the strip's membership, so the strip's tasks must exist first.
- **`needsAnswers`:** omitted. The four launch questions are resolved (below).

## Resolved decisions (the four launch open questions)

1. **Storage: a wherever-owned `closed-sessions.json`**, not shipmates' `archived` marker (D24). Reasons: close must work without shipmates; shipmates' archive means "archived headless children are never woken", which conflicts with auto-reopen; and its undo window / `expiredArchives()` semantics are designed around delete. shipmates' ownership record is still what the cascade walks.
2. **Auto-reopen on any activity:** a user message from any channel, a shipmates delivery that wakes it, an `agent_start`, or an inbox item it raises. A working session is also always shown in the Live strip even while still flagged closed.
3. **Close and star are exclusive:** closing a starred session unstars it; starring a closed session reopens it.
4. **Agent-initiated close is out of scope** for this spec. Ship manual close, use it, then decide (a `session_close` tool would hide work without the human noticing, which needs its own thought).

> Tasked: the implementation and testing detail moved into the tasks `closed-sessions-store-and-endpoint`, `closed-sessions-auto-reopen`, `closed-sessions-in-the-sidebar`, `closed-sessions-cascade-and-undo` and `closed-sessions-in-search` (`work/tasks/`); the durable rationale is ADR `docs/adr/0025-closing-a-session-is-a-wherever-flag-not-a-shipmates-archive.md`.

## Out of Scope

- Agent-initiated close (resolved decision 4).
- Auto-closing stale sessions (a later "N stale sessions, close them?" suggestion could build on this).
- Changing retention or delete semantics.

## Further Notes

Tasked after `session-list-live-strip` (story 14 edits its membership). `session-list-by-owner-view` reads the closed flag and is tasked after this spec. The search-panel part shares files with `conversation-search-sort-by-time`, which is tasked after this spec.
