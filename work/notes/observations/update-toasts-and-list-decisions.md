# update-toasts-and-list: decisions (2026-11-25)

In-scope choices made while building task `update-toasts-and-list` (spec `notifications-compact`, stories 12 to 17). Each is cheap to reverse; the model is `web/src/lib/core/notifications/update-toasts.ts`, the views `web/src/lib/components/UpdateToast.svelte` (toast) and `NotificationToasts.svelte` (bar and list).

1. **A sibling model, not one merged model.** "Extend the pure model" is done as `createUpdateToasts` beside `createQuestionToasts` in the same folder, both exported from `core/notifications/index.ts`, rather than one model owning both kinds. The two share nothing but the hold idea (different delays, slots, persistence and removal rules), so merging would only couple them. The old `createNotificationsService` / `notifications` store (the interim render) is removed; its click test moved to the new model.
2. **What persists.** Every update not yet opened or dismissed is stored, including the one on screen and the queued ones, not only the folded ones. A reload brings them all back FOLDED in the list (no re-toast), so a reload mid-toast loses nothing. The cap (50) counts all of them and drops the oldest not on screen. Alternatives: persist only folded ones (a reload mid-toast would lose it), or re-toast after reload (shows the same thing twice).
3. **Clear all** empties the list only; the toast on screen and the queue stay (they are not in the list yet, and clearing what the user has not seen would lose it).
4. **Question and update toasts can show at the same time**, since they now live in different places (under the top bar, above the composer). The interim rule "an update waits behind a question" is dropped.
5. **No swipe on the update toast.** The spec gives ✕ for updates (swipe up is a question-toast rule, story 7); a swipe up on a toast at the bottom of the screen would also read oddly. Only ✕ and tap.
6. **Toast title layout**: the server writes "<source>: <title>", shown as the source in bold and the rest muted (`splitUpdateTitle`, the first ": "), as in the mockup ("drive-sidebar-tasks finished"). The icon is 🔔 for every update (the mockup's ☑ fits "finished" but not every `assistant_notify`).
7. **Bar wording.** Questions alone: "N questions for you … View ›" (unchanged). Updates alone: "🔔 N update(s) … View ›" in a blue-bordered bar. Both: an amber bar, "🙋 N questions for you · N update(s) ›", each part its own button. The spec writes the updates part as "N updates", the mockup shows only the questions bar.
8. **List rows**: title (source bold), two lines of body, age (`updateAge`: "now", "5 min", "3 h", "2 d", read when the list opens), "Open ›" (only when the update has a target) and "Dismiss"; Dismiss keeps the list open, Open closes it (it navigates); the list closes itself once empty. Clear all is a plain item after a separator, not red: nothing it removes is unrecoverable work.
9. **`/#` is the main screen in place.** `openNotificationTarget` treated `/#` (no session id, the test notification with no session open) as a real navigation because `URL.hash` is '' for an empty fragment; it now sets `location.hash = ''` (fires `hashchange`, which leaves the open session) when the target ends in "#".
10. **Re-push**: an update whose id (the push's `update-<uuid>` tag) is already known is ignored. An older server sends no tag, so an id is made up and every push is new.

## Manual browser check (2026-11-25)

Run against `vite dev` with no server (headless Chromium over CDP), with two question ids put in `localStorage['wherever-question-bar']` and update pushes posted through `receivePushNotification`, at 390x844 (phone) and 1440x900 (desktop):

- The update toast shows above the composer (phone: toast bottom 689 px, composer top 732 px with the "Connecting to remote server" line between; desktop: centred at 760 px), with 🔔, "drive-sidebar-tasks" bold, "finished" muted, two lines of body, ✕, and "+1 more update" above it.
- After 6 s the second update showed; after 12 s both folded: the bar read "🙋 2 questions for you · 2 updates ›"; `localStorage['wherever-updates']` held both, newest first.
- The updates part opened the list as a bottom sheet on the phone and a popover under the bar on desktop: "Updates · 2", each with title, body, "now", Open › and Dismiss, then Clear all.
- With the hash set to `#somewhere`, Open on the `/#` update cleared it in place (`http://localhost:5391/#`, the main screen, no reload) and the bar read "· 1 update ›"; Clear all left "2 questions for you · View ›" and removed the storage key.
- Tapping a new toast set `location.hash` to `#tapped` and removed it; ✕ removed another without opening anything.
- An update pushed then the page reloaded: the bar came back with "1 update" (no toast); with no questions the bar read "🔔 1 update · View ›".
