---
"wherever-dev": patch
---

The AGENTS.md seeded into the search folder is reworded for small local models. On a machine running Gemma 4 E4B with `web_search` and `web_fetch` provided by an extension, a search session replied that it could not search the web, because the old text framed the tools as something that might be missing or failing. It now opens, in bold, by stating that `web_search` and `web_fetch` exist and work, that every question gets a `web_search` first, and that the agent must never say it cannot search. The method is a three-step numbered list (search, fetch one to three results, answer briefly with the links used), a question about the machine itself is answered with bash, and the failure case comes last and only applies when a `web_search` call actually returns an error. The bundled `skills/web-search` skill gets the same tools-first opening and error-triggered failure rule. An existing AGENTS.md is still never overwritten.
