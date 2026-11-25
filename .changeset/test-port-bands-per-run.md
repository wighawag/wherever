---
"wherever-dev": patch
---

Server tests: two test runs on the same machine (for example two acceptance gates) no longer steal each other's ports. Each test process now claims its port band by holding the band's first port open, instead of computing the band from its vitest worker slot, which gave every run the same bands. Test-only change.
