---
'wherever-dev': minor
---

Mark folders that do not exist on this machine in the session browser, so a freshly migrated machine shows the scale of what still needs restoring without opening every conversation.

- `GET /sessions` stamps each folder with `missing: true` when its cwd is not a directory on this machine. It is a SECOND, orthogonal per-folder fact beside `readOnly`: read-only is a configured policy, missing is a fact about the disk and is curable by a restore, and the dashboard renders them differently (a **Missing** chip on the folder, never the read-only treatment).
- The check costs one `stat` per DISTINCT folder path, cached for 10s, never one per session: the listing can cover thousands of sessions and the dashboard refetches it on every `sessions_updated`, so a naive per-session check would put a syscall storm back into the pass the listing cache exists to keep free of IO.
- Completing a restore invalidates that folder's cached answer (by subscribing to the restore job registry directly, not through the WebSocket layer) and asks connected dashboards to refetch, so the chip disappears without a manual refresh. A folder that reappears by other means (cloned by hand in a terminal, a mount coming back) loses its chip within the cache window on its own.

The listing's ordering, its ignore and read-only filters, and everything else about the response are unchanged.
