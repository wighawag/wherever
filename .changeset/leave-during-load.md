---
"wherever-dev": patch
"@wherever-dev/client": patch
---

Leaving a session that is still loading now really stops the load. The client tells the server it is leaving even before the session has opened, and the server cancels such a load. Before, the load finished anyway and kept the tab attached in the background to the session it had left, so that session's activity could show up after leaving.
