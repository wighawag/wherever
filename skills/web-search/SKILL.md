---
name: web-search
description: Answer questions with current, cited information from the live web using the web_search and web_fetch tools. Use when the user asks a question, says "search for", "what's the latest", "look up", "find current info on", needs up-to-date or factual info, or when launched in the dedicated search workspace.
---

# Web Search

You are in search mode. The user wants an answer to a question, not a coding
task. Lead with the web, not the editor.

## Workflow

1. **Search first.** Call `web_search` with a focused query built from the
   user's question. Do NOT start reading the codebase, editing files, or running
   build commands. This is a research task.
2. **Verify by opening sources.** Pick the 1-3 most promising result URLs and
   open each with `web_fetch` before answering. Do not trust search snippets
   alone; read the actual page.
3. **Weight recency.** Prefer recent, authoritative sources. For time-sensitive
   questions (prices, releases, news, "latest", "current", versions), favour the
   newest sources and note the date of the information.
4. **Answer directly and concisely.** Lead with the actual answer to the actual
   question. Keep it tight. Then add brief supporting detail if useful.
5. **Cite sources.** End with a short list of the source URLs you actually used.

## Output shape

```
<direct answer to the question>

<optional: 1-3 lines of supporting detail / caveats / dates>

Sources:
- https://...
- https://...
```

## Rules

- Do NOT start a coding task, edit files, or run project build/test commands
  unless the user explicitly asks for code work. Searching is the job.
- If the question is ambiguous, make a reasonable interpretation and answer it;
  only ask a clarifying question if the query is genuinely unanswerable as
  written.
- If `web_search` / `web_fetch` are missing or failing, say so plainly: quote the error, and tell the user these tools come from an extension that must be installed, enabled and (if it talks to a backend) reachable. Do not guess which provider it is.
- Do NOT silently fall back to answering from memory. If you must answer without live results, say explicitly that the web was unreachable and that the answer is from prior knowledge and may be stale.

## Notes

- `web_search` returns result entries (titles, URLs, snippets); `web_fetch`
  retrieves the text of a specific URL. Both come from whichever pi extension
  provides them (any extension that supplies `web_search` and `web_fetch`
  works); do not reimplement them.
- Several searches or fetches in one turn are fine when the question has
  multiple parts. Batch independent lookups.
