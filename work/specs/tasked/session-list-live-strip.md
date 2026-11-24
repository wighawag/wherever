---
title: Live strip at the top of the session list (what is running, what waits for me)
slug: session-list-live-strip
---

> Launch snapshot (records intent at creation, NOT maintained). Current truth: `docs/adr/` (decisions) + `CONTEXT.md` + the code; remaining work: the tasks sliced from this spec. (The technical-detail sections below are trimmed by `to-task` once the work is tasked.)

## Problem Statement

Since shipmates, agents spawn sessions themselves (`session_spawn`), often in other folders (worktrees). The sidebar is grouped by folder and sorted by modification time, so the sessions that are doing something right now are scattered across folders and mixed with dozens of idle ones. To answer "what is going on right now, and what is waiting for me?" the user has to scroll every folder and read each row's presence line. The "🙋 Needs you" inbox answers part of it (open `human_ask` items), but not "which sessions are running" nor "which session is stuck waiting on another session".

## Solution

A compact **Live** strip pinned at the top of the main session list, above the folders. It lists every session that is currently active, whatever folder it lives in, with a state badge, and orders them by how much they need the human: waiting for you first, then waiting on another session, then running. Each row opens the session. The strip disappears when nothing is live, and can be collapsed. The same sessions stay in their folders below; the strip is a view, not a move.

## User Stories

1. As a user, I want a "Live" section at the top of the session list showing every session whose agent is currently working, so that I see at a glance what is running without scrolling through folders.
2. As a user, I want sessions whose shipmates presence is `waiting-for-human` listed first in the strip and visually highlighted in amber text (as the presence line already does), with the "running" badge in a different colour, so that the sessions that need me stand out from the amber "working" dot.
3. As a user, I want sessions whose presence is `waiting-for-session` shown in the strip with the session they wait on, named like the sidebar names sessions (falling back to "waiting on a session" when it cannot be resolved), so that I can see chains of agents blocked on each other.
4. As a user, I want each strip row to show the session's label (its first shipmates role if it has one, else the sidebar label: name, then first-message preview), its folder as a small tag, and its presence status line, so that I can recognise it without opening it.
5. As a user, I want each strip row to carry a state badge (running, waiting for you, waiting on a session), so that the state reads without parsing text.
6. As a user, I want sessions that are working but have no shipmates presence (plain sessions, CLI-bridged sessions, shipmates off) to appear in the strip as "running", so that the strip is useful even without shipmates.
7. As a user, I want a spawned session in the strip to show "↳ <owner>" so that I can tell which orchestration it belongs to.
8. As a user, I want clicking a strip row to open that session exactly like clicking it in its folder (a plain click switches session, a modifier-click opens a new tab), so that the strip is a shortcut and nothing more.
9. As a user, I want the session I currently have open marked in the strip the same way it is marked in the folder list, so that I keep my bearings.
10. As a user, I want the strip header to show counts ("Live · 4 · 1 waiting for you") and to be collapsible, with the collapsed state remembered on this device, so that it does not take space when I do not want it.
11. As a user, I want the strip hidden entirely when no session is live, so that it costs nothing in the common idle case.
12. As a user, I want the strip to update live as sessions start, settle, and change presence, without a manual refresh, so that it reflects reality.
13. As a user, I want the strip to respect the sidebar filter box with the same matching rule as the list (name, first message, folder name), so that filtering behaves consistently.
14. As a user on mobile, I want the strip to fit the narrow sidebar (one line per session, truncating), and the mobile menu dot to keep reflecting the inbox only, so that the phone layout stays usable.
15. As a user, I want a cap on the strip's visible rows (with "+N more" expanding it), so that a fan-out of twenty workers does not push the folder list off screen.
16. As a user, I want the strip to appear only in the main list, not in the read-only page, so that read-only sessions (which cannot be worked) do not clutter it.

### Autonomy notes

- **`humanOnly`:** omitted. Ordinary UI work.
- **`needsAnswers`:** omitted. One small server addition is needed (story 3, below); everything else is already on the wire: `isWorking` per session in `/sessions` for server AND CLI-bridged sessions (kept live by `session_working` frames) and `presence[]` in `shipmates_update`.

> Tasked: the implementation and testing detail moved into the tasks `live-strip-in-session-list` and `live-strip-names-the-session-waited-on` (`work/tasks/`).

## Out of Scope

- Stop / steer buttons on strip rows (possible follow-up: `session_stop` for owned sessions).
- An "unread since I last looked" marker (separate idea).
- Grouping the strip by orchestration (see `session-list-by-owner-view`).
- How closed sessions behave in the strip: owned by `closed-sessions` (which is tasked after this spec).
- Changing the inbox panel; it already lists open `human_ask` items.

## Further Notes

Ships first. `closed-sessions` and `session-list-by-owner-view` both build on it (`taskedAfter`).
