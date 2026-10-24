---
"wherever-dev": patch
"@wherever-dev/pi": patch
"@wherever-dev/client": patch
---

Publish a README with each npm package (they had none, so npmjs.com showed "No README data found"), and tidy the package metadata: clearer descriptions, keywords, `wherever.dev` as homepage, author, and the changelog in the tarball. `wherever-dev` now declares `engines.node >=22.19.0` (what the bundled pi SDK requires). `@wherever-dev/client` no longer ships its test suite and tsconfig (its `src/` stays, for the sourcemaps).
