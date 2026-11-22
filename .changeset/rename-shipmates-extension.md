---
"@wherever-dev/pi": minor
---

Rename: the bridge's kenning host is now the shipmates host (shipmates is the new name of kenning, shipmates spec D38). It registers on `Symbol.for('shipmates.host')` (was `kenning.host`), emits `shipmates:human-input` (was `kenning:human-input`), and uses the server's `shipmates_host_info`, `shipmates_spawn` and `shipmates_stop` ops (were `kenning_*`), so it needs a wherever-dev server from this release. What users must change: install `npm:@shipmates/pi` instead of `npm:kenning-pi` in the same pi settings as `@wherever-dev/pi`, and update `@wherever-dev/pi` and `wherever-dev` together.
