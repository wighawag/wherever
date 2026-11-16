---
"wherever-dev": patch
---

Switching session while disconnected no longer falls back to the old session when the new one fails to load. The URL hash still named the session being left (the page only rewrites it while connected), so once the switched to session errored, the hash auto-join reopened the old one. Switching now drops that stale hash like leaving already did, and the decision is a unit-tested helper (`shouldDropStaleHash`).
