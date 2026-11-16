---
"wherever-dev": patch
---

The static-compression test no longer depends on a web build being present: it serves a fixture through a test-only `WHEREVER_TEST_STATIC_DIR` (a no-op when unset), so the server suite passes on CI, which builds no web app.
