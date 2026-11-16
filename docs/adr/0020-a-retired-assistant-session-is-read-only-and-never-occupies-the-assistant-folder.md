# A retired assistant session is read-only and never occupies the assistant folder

**Status:** accepted

Every assistant session lives in the same folder (`assistantFolder`), and the pointer (`assistant-pointer-and-reset`) names the ONE current session; a reset, or a fresh session started there, retires the previous one. As first built, a tab still viewing a retired session made the folder-conflict rule treat it as a live occupant, so the NEW current session opened read-only behind the conflict banner. We decided that a session in the assistant folder (not in `jobs/`) that is not the current pointer session is RETIRED: web viewers see it read-only with a notice that the assistant was reset and a way to open the current session, the read-only is not dismissible ("Continue anyway" does not apply), and a retired session never counts as an occupant for the folder-conflict check, so the current session always opens writable. Writing into a retired session would fork the assistant's conversation into a session nobody points at; the folder is the memory, the retired session is history.

## Considered Options

- **Keep the ordinary folder-conflict rule**: correct for code folders, wrong here, since the conflict is created by our own reset.
- **Exempt the assistant folder from conflicts entirely**: simpler, but it lets two writable sessions coexist in one folder silently, including a retired one.

## Consequences

- "Retired" is derived from the pointer (in the folder, not in `jobs/`, not current), so it needs no extra state and also covers sessions retired before this rule existed.
- The verdict is the server's read-only verdict for WEB viewers. A terminal `pi -c` on a retired session is the user's explicit choice and is not blocked; it does not move the pointer (a resumed session is not new, ADR 0016).
- With `assistantFolder` unset nothing is retired, and the folder-conflict rule is unchanged everywhere.
