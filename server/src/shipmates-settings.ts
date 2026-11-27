/**
 * shipmates' per-session settings (its D40): `wake` and `declaredWaiting`, kept
 * by transcript file across an unload or a resume, unlike presence (which
 * shipmates deletes on unregister). wherever reads them for sessions it does not
 * have loaded: the sidebar still shows one that waits for the human
 * (shipmates-service.ts `snapshot`), and the host wakes an unloaded session only
 * as its own delivery would (shipmates-host.ts).
 *
 * Read through feature detection, so wherever still runs against a shipmates
 * without them: every reader answers null (or nothing) then, and its caller
 * falls back to what it did before.
 */
import type { Shipmates } from 'shipmates';

/** shipmates' `SessionSetting`, declared here so an older shipmates still type-checks. */
export interface SessionSetting {
  sessionFile: string;
  wake: boolean;
  declaredWaiting: boolean;
  /** Null when the file set nothing (the defaults). */
  updatedAt: number | null;
}

interface WithSettings {
  settings(): SessionSetting[];
  setting(sessionFile: string): SessionSetting;
}

function withSettings(k: Shipmates): WithSettings | null {
  const s = k as unknown as Partial<WithSettings>;
  return typeof s.settings === 'function' && typeof s.setting === 'function' ? (s as WithSettings) : null;
}

/** Every session with a non-default setting, or null when this shipmates has none. */
export function sessionSettings(k: Shipmates): SessionSetting[] | null {
  return withSettings(k)?.settings() ?? null;
}

/** One file's settings (the defaults when it set nothing), or null when this shipmates has none. */
export function sessionSetting(k: Shipmates, sessionFile: string): SessionSetting | null {
  return withSettings(k)?.setting(sessionFile) ?? null;
}
