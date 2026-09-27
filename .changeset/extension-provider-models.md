---
"wherever-dev": patch
---

Server sessions now run on models whose provider an extension registers (`pi.registerProvider`), as the pi CLI does. pi queues those registrations while extensions load and, on the path wherever takes, flushed them only when wherever bound the extensions, after `createAgentSession` had already picked the model. A default model served through an extension (a local model, for instance) therefore resolved to nothing: the session showed `unknown:unknown` and every prompt failed with "No API key found", while the same settings worked in the pi CLI. The registrations are now applied right after loading, before the model is chosen, and a model handed to a rebuild (a `/reload`) is re-read from the registry, so a provider whose config changed takes effect. The global extensions' providers are also discovered once at startup (bounded to 10 s), so `/models`, the default-model lookup and a model picked in the new-session form see them before any session exists.
