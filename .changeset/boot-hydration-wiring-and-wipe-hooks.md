---
"wherever-dev": patch
---

Reopening the app after the phone killed it now shows the conversation at once. The web keeps a small on-device cache of recently viewed conversations and, when the address names a cached session, paints it before the connection is up: you can read and type straight away, and only sending waits until the session has resynced, when the server's history replaces the cached copy. A session the server no longer has is dropped from the cache and from the address bar without adding a history entry. Both "Disconnect" actions wipe the cache, connecting to another server drops the previous server's conversations, and "Reconnect" or connecting again to the same server keeps them. "Load older messages" appears only once the real history has arrived.
