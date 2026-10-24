---
"wherever-dev": minor
---

Choose which pi SDK web sessions run on with `piSdk` in `~/.wherever/config.json`: the bundled SDK (default), `"auto"` for the `pi` on the server's PATH (npm global bins and Nix-style wrappers are followed), or a path to an install. Versions in the tested range (currently `>=1.4.0 <1.5.0`) are used directly; untested versions from 1.0.0 up can be allowed with `allowUntested: true` or a narrower `accept` semver range, and older ones are always refused. A refused, missing or broken install never stops the server: it falls back to the bundled SDK and logs why. The startup log and the web UI's version tooltip show the pi version in use. Using an install's own built-in extension list also brings pi's `llama.cpp` provider to web sessions.
