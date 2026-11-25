---
"@wherever-dev/pi": patch
---

Handle the server's `cli_rename {id, name}`: the extension writes the name with pi's `setSessionName` (this terminal owns the transcript) and answers `cli_rename_result {id, ok, error?}`. It advertises the new `cli_rename` capability on `cli_register`, so a wherever web rename of a bridged terminal session works; a server refuses to rename through an older extension instead of writing the file behind it.
