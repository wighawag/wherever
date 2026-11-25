# question-toasts-and-bar: decisions (2026-11-25)

In-scope choices made while building task `question-toasts-and-bar` (spec `notifications-compact`, stories 1 to 11 and 22). Each is cheap to reverse; the model is `web/src/lib/core/notifications/question-toasts.ts`, the view `web/src/lib/components/NotificationToasts.svelte`.

1. **Opening Needs you while a toast shows.** The shown toast folds into the bar (it did show on this device, which is what resolved decision 2 counts); questions still QUEUED behind it are dropped like any question suppressed by an open panel (never shown, and the user is now looking at them). Alternatives: keep the toast hidden and resume it when the panel closes (re-shows something just seen), or drop the shown one too (it then vanishes from the bar although it toasted). Touches: only this model.
2. **Opening the asking session.** Likewise, the shown toast and any queued question from that session fold into the bar (they are now "from the session on screen"). "Open ›" folds the toast explicitly before navigating, so the result is the same whether the context change or the click comes first.
3. **A fallback toast ignores the Needs you rule.** A fallback exists only because no good snapshot arrived in 5 s, so the panel is probably stale and may not list the question either; suppressing it would show the question nowhere, which the task forbids. It still obeys "from the session on screen" (the session is read from the push's `/#<sessionId>` target) and goes to the bar then.
4. **Pause semantics.** Releasing the last hold (hover, touch, sending, error) restarts the FULL 8 s rather than the remaining time: simpler and kinder after reading. An error holds until the user acts (another chip, ✕, Open); answering again clears it.
5. **A successful answer from the toast** removes it at once (toast and bar) instead of waiting for the next snapshot, so the toast never lingers on an answered question.
6. **Re-push of a known question** (shown, queued, waiting for its snapshot, or in the bar) is ignored: the bar already counts it, and a second toast would be a duplicate.
7. **Bar layout.** "N questions for you" on the left, "View ›" on the right, as in the mockup (the spec writes it "N questions for you · View"). The bar is one button opening Needs you; the updates part (next task) can be added beside it.
8. **Interim updates.** Non-question pushes use the same dark shell with a blue accent, in the SAME slot under the top bar (not yet above the composer: that placement, the 6 s hide and folding are `update-toasts-and-list`). One at a time with "+N more", no auto-hide (as before: nothing is lost), tap opens the target via the existing tested `notifications.onClick` / `openNotificationTarget`, ✕ or swipe up closes. While a question toast shows, an update waits behind it.
9. **Swipe up** is a small local pointer handler (captures the pointer only past an 8 px slop so chip taps still click; dismisses past 40 px up), not the row-swipe helper, as the task asked.
10. **"Desktop"** for "Needs you is open" is the `md` breakpoint (`(min-width: 48rem)`, tracked with `matchMedia` in `+page.svelte`), the same breakpoint the drawer / rail classes use.
11. **Snapshot feed.** `NotificationToasts.svelte` subscribes to `shipmatesStore` and passes every value to the model. Every `shipmates_update` frame produces a new object, so every frame reaches the model; the initial value at mount is treated like a received snapshot (at page start it is the empty, unavailable state, which the model ignores).

## Manual browser check (2026-11-25)

Run against `vite dev` with no server (headless Chromium driven over CDP), injecting a shipmates snapshot and posting pushes through `receivePushNotification`, at 390x844 (phone) and 1440x900 (desktop):

- Question toast under the top bar with "<from> asks", 2-line clamp, three option chips, Open ›, ✕ and "+1 more question"; desktop centred at the chat width (760 px), not over the composer.
- Tapping a chip while not connected shows "not connected" in the toast and the toast stays.
- ✕ shows the next (free-text) toast with "Answer in Needs you" and Open ›; a mouse drag up by 70 px also dismissed the first toast.
- After 8 s the free-text toast folded into the amber "1 question for you · View ›" bar; `localStorage['wherever-question-bar']` was `["h_2"]`.
- An update push showed the interim blue-accent toast; tapping it set `location.hash` to `#target`.
- View opened the phone drawer on the Needs you tab; a new question pushed while it was open produced no toast.
- A good snapshot without the item removed the bar and cleared the storage key.
