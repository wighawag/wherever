---
"wherever-dev": patch
---

Composer attachment chips now show the upload's real state: a progress bar with a percentage while sending (a spinner until the first bytes are acknowledged), "Paused, waiting for connection" while offline, a finishing state, and a Cancel control while in flight. A failed upload shows the reason and a Retry button that reuses the picked file (no re-pick), except when the file is no longer readable, where the chip asks to pick it again. Send stays disabled while any attachment is still uploading.
