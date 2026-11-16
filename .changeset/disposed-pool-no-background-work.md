---
"wherever-dev": patch
---

A disposed session pool no longer finishes its startup session-index warm-up: the late warm-up read the wherever config after shutdown, and in the test suite (where the env had been restored by then) it seeded the runner's real `~/.wherever/config.json`.
