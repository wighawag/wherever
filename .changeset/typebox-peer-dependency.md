---
"@wherever-dev/pi": patch
---

Declare `typebox` as a `peerDependencies` entry with a `"*"` range instead of a regular dependency (#68). pi supplies `typebox` to extensions (0.80.x already did), and pi 1.x warns about extension packages that install their own copy ("Host-provided extension packages must be declared in peerDependencies"), since a second copy can bypass the extension loader. Also bumps the development pi SDK to 1.4.
