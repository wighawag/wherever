---
"@wherever-dev/client": minor
---

Rename: the client option `kenningCards` is now `shipmatesCards` (shipmates is the new name of kenning, shipmates spec D38). With it the client asks for `shipmates=1` on the socket URL and receives `shipmates_delivery` frames and history messages of role `shipmates` with a `shipmates` field (were `kenning=1`, `kenning_delivery`, role and field `kenning`). What users must change: rename `kenningCards` to `shipmatesCards` and the `kenning` role, field and frame names they handle; it needs a wherever-dev server from this release.
