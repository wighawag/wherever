---
"wherever-dev": patch
---

Server test suite: every test file now runs with its own temp HOME and without the ambient WHEREVER_CONFIG_DIR / WHEREVER_STATE_DIR / PI_CODING_AGENT_DIR, and the run fails if the real `~/.wherever` changed, so a leaking test can no longer write into a real home (on CI or locally).
