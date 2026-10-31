---
"wherever-dev": patch
---

Telegram: stop sending an empty `sendMessageDraft` to "clear" a reply draft. The Bot API shows an empty draft as a "Thinking..." placeholder, so after every assistant message (right before each tool call) the chat showed a lingering animated indicator and clients could notify an unsupported message. A draft is now always ended by a real message: the final text at the message end, the text so far when a tool call starts or the turn ends first, and on abort the partial text that was shown (marked `⏹ (stopped)`, sent silently). New option `assistantTelegram.toolCalls`: `"off"` (default, a tool call shows nothing) or `"compact"` (one silent plain-text line per call, such as `🔧 bash: git status` or `🔧 read: <path>`, with secret-looking values redacted).
