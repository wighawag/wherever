---
"wherever-dev": patch
---

Assistant notifications settings: a failed "Push notifications on this device" toggle no longer stays checked; it rolls back to the device's real subscription state. Errors now show their name with the message, plus a hint for an `AbortError` (browser push disabled or unreachable: on Firefox and LibreWolf check `about:config` `dom.push.enabled` and `dom.push.connection.enabled`) and for a denied permission. New "Send test notification" button (while subscribed), backed by the token-gated `POST /push/test`, which delivers through the same path as `assistant_notify` and reports the result per channel.
