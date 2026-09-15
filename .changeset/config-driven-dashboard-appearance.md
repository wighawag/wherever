---
'wherever-dev': minor
---

Config-driven theming of the web dashboard: distinguish each server instance at a glance.

Machines that mirror the same pi sessions over cloned folders look identical in the dashboard, so you cannot tell which instance you are driving — and with clones drifting out of sync, answering "is this the one that is ahead?" currently means reading paths. A new `appearance` section in `~/.wherever/config.json` gives each server a visual identity that the web frontend applies on connect:

- **`label`** — instance name shown as a pill next to the logo in the sidebar and appended to the tab title (`Wherever · laptop-ahead`). It defaults to the **machine hostname**, so two servers are already distinguishable with zero configuration. An explicit `""`/`false` opts out for the exact pre-feature look.
- **`accent`** — one CSS color re-tints the whole accent family (links, buttons, gradients, active-session highlights) plus the mobile/PWA `theme-color` chrome. Because the brand palette is compiled as Tailwind v4 `@theme` custom properties, every `bg-brand-*` / `text-brand-*` utility resolves them at paint time: the override is applied as inline CSS variables on `<html>` with no rebuild.
- **`colors`** — advanced, per-token overrides (`brandDark`, `brandSurface`, `brandSurface2`, `brandSurface3`, `brandBorder`, `brandText`, `brandTextMuted`, `brandCyan`, `brandBlue`, `brandPurple`) for operators who want more than a hue shift; applied on top of `accent`.

The identity is served by the existing `GET /config` (behind the same token gate), applied when the dashboard fetches it, and reset before reapplication so a PWA reconnecting to a different instance never blends two palettes. Values are written through `style.setProperty` only — arbitrary config strings cannot inject markup.

Two additional visibility markers, for when a hue shift is not loud enough:

- **`frame`** — a solid accent bar across the top edge of the whole dashboard (default: enabled when `accent` is set). It survives a collapsed sidebar and a session filling the screen, which the sidebar pill does not.
- **`pattern`** — a backdrop pattern (`stripes` / `dots` / `grid`) painted on the dashboard's dark background wherever it shows, tinted with the accent at low alpha (`color-mix`), so it reads as a watermark rather than noise.

The two hardcoded gradient stops in `app.css` were switched to the brand variables, so `accent` retints the `.gradient-text`/`.gradient-border` accents too.