# Assistant replies are routed per USER MESSAGE by the session pool, and proactive output reaches the user only through `assistant_notify`

**Status:** accepted

The assistant session (spec `assistant-session-and-channels`) is fed from several places at once: the web composer, Telegram (and later other channels), and the scheduler. A reply must go back only where the question came from, and anything the assistant does on its own (a scheduled turn) must stay silent unless the agent deliberately calls `assistant_notify`. We route per user message, not per agent run, and the SESSION POOL owns the routing state, because pi folds queued follow-ups and steers into the SAME run (a scheduled follow-up queued during a Telegram exchange would otherwise reply to Telegram), and because web sends reach the pool directly without passing through the assistant controller, so only the pool sees every send.

Mechanics, each forced by pi's behaviour:

- The pool records an origin (`telegram`, `schedule:<jobId>`, ...; web sends record `none`) for every send that WILL produce a user message, in one queue per delivery mode (prompt-or-steer, and followUp), since pi keeps steer and followUp in separate queues and delivers steers first. Matching is by queue POSITION, never by text, because `/skill:` and prompt-template expansion rewrite the text.
- The trigger is a user `message_end`, not `message_start`: pi emits both back to back, but the CLI extension forwards only `message_end`, and it must work for CLI-bridge sessions too.
- Sends that produce no message must not leave an entry, or the queue drifts permanently and every later reply goes to the wrong place: `!`/`!!` shell sends, sends to a non-resident session, `prompt()` reporting `preflightResult` `"handled"` (extension command or input handler), and sends that throw. To observe `preflightResult` the pool sends every message through `prompt()` (equivalent to the plain-text `sendUserMessage` path); a `prompt()` that returns without calling it was deferred and stays pending.
- At `agent_settled` each routing queue is trimmed to pi's actual queue length (abort leaves pi's queues populated, so "empty at settle" is false), and for CLI sessions, whose pi queues the server cannot see, emptied. The pool does this before fanning `agent_settled` out, so a message sent from a settled handler keeps its entry.

Considered and rejected: routing per run (breaks silence as above); text matching (breaks on expansion); a controller-owned FIFO (misses web sends). Accepted cost: in a CLI-bridge session the server cannot see `preflightResult`, so an extension-handled `/command` typed there while idle can misattribute the next channel message until the next settle.
