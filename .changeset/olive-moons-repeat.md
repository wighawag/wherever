---
'wherever-dev': patch
---

Apply the instance appearance from the layout rather than from the config fetch.

`fetchConfig()` in `session-store.ts` wrote directly to `document.documentElement` via `applyAppearance()`, putting a DOM side effect in the module that talks to the server. The store is now the only thing it publishes, and `+layout.svelte` re-themes off that store: it already owns `app.css`, where the `--color-brand-*` tokens and the frame/pattern rules the appearance drives actually live.

Driving the effect off the store rather than off the fetch also means any future writer re-themes too, instead of the palette only updating on the one code path that happened to remember to call it.

Adds coverage for the `/config` appearance mapping, which had none: the accent/label/frame/pattern payload, the compiled defaults for a server that configures no appearance, and the last-known appearance surviving an unreachable server.
