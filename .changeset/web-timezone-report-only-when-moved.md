---
"wherever-dev": minor
---

The web now reports its timezone to the assistant only when the device actually moved (ADR 0019). Each browser remembers the last zone it reported and sends a `client_timezone` report only when its zone differs, marking its first-ever report with `first: true`. The server applies a first report only when the user's timezone was not set explicitly with `assistant_set_timezone`, so reconnecting a web client no longer undoes "I'm in Tokyo", and two devices in different zones no longer keep switching the setting. A device whose zone really changes (travel with the laptop) still updates it. An older web (no `first` flag) is treated as a non-first report, and an older server simply ignores the new field.
