# Idea: a remembered LIST of servers in Connection Settings, editable and removable

**Captured:** 2026-09-22, while scoping the Capacitor shell spike (`work/tasks/backlog/capacitor-webview-socket-spike.md`). Raised by the user as the desired first-run behaviour for the native shell: "leave it blank and it remember a list, that you can edit and remove".

## The idea

Connection Settings currently holds ONE server: `host`, `port`, `token`, persisted as a single `wherever-config` entry in localStorage (`saveConfig()` in `web/src/lib/wherever.ts`). Replace that with a remembered LIST of servers the user can pick from, edit and delete, with the currently-selected one behaving exactly as the single config does today.

## Why it is worth doing (and why the native shell makes it urgent rather than nice)

In a browser the address bar carries the server identity: you are AT `https://wherever.telemaque.ska.sh`, and `getConfig()` derives host and port from `window.location`, so the single stored config is mostly a detail the user never sees. An installed app has no address bar and no meaningful origin (`https://localhost`), so the server becomes something the user must state and re-state by hand, with no affordance to correct a typo other than retyping the whole thing. That is also the exact place a wrong entry produces a silent "Connecting..." hang, because a WebView reports nothing the page can catch.

A list also matches how the thing is actually used: a laptop at home, a box on a VPS, a tunnel that moves. Today switching between them is destructive (overwrite the one entry, lose the other).

## Deliberately NOT part of the spike

The spike's whole value is that it measures the STOCK app in a different container, so its acceptance criteria forbid a diff to `web/`. Adding a server list would edit `web/src/lib/components/ConnectionSettings.svelte` and the config persistence, and the arm would no longer be measuring what ships. The spike leaves the field blank and the user types the host once.

## Where it probably belongs

Most naturally a slice of the native-shell work once the spike justifies it, because it shares a decision with the spec's blocking finding B1: the transport scheme (`secure`) is currently derived from `window.location.protocol` and is not a stored field, so a shell needs scheme to become part of the stored server identity anyway. A server entry therefore wants to be `{ scheme, host, port, token, label }`, and once it is a record with four fields rather than three loose keys, "keep several of them" is a small step rather than a new concept.

Worth deciding at that point, not now:

- Does a stored entry supersede the origin-derived defaults, or only seed them? The healing rules in `getConfig()` / `session-store.ts` actively REWRITE stored host and port from the page origin, which is right in a browser and wrong in a shell. A list makes that conflict unavoidable and forces the rule to be stated properly.
- Is the token part of the entry? It is a secret in localStorage either way today, but a list multiplies it. Probably yes, with the same exposure as now, but it should be a decision rather than a drift.
- Does the list sync (it is per-device state about how to REACH a machine, so probably not: a server cannot usefully tell you how to reach itself from elsewhere).
- Browser behaviour must not regress: served from the server itself, the origin-derived default is still the right answer and the list should stay invisible unless the user opens it.
