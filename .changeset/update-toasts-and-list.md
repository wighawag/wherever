---
"wherever-dev": patch
---

Foreground updates (`assistant_notify`, a lane finished, any non-question push) now show as a compact dark toast with a blue accent above the composer, hide after 6 s (paused while touched or hovered) and fold into the slim bar, which reads "2 questions for you · 1 update" when both kinds wait. The updates part opens the updates list (a sheet on the phone, a popover on desktop) with Open and Dismiss for each update and Clear all; updates are kept on the device (localStorage, newest first, capped at 50) until opened or dismissed. A `/#` target (no session) now opens the main screen in place.
