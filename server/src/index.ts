#!/usr/bin/env node
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, request as httpRequest } from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import { SessionPool, getWhereverConfig, getWhereverCertsDir, detectRemoteRepo, normalizePath, invalidateFolderExistence, type WhereverConfig } from './session-pool.js';
import { readDrafts, addDraft, deleteDraft, validateDraftInput } from './drafts.js';
import { searchConversations } from './conversation-search.js';
import { matchRemoteRepoRule, resolveRemoteCandidates } from './remote-candidates.js';
import { RestoreJobRegistry, type RestoreJobSnapshot, type RestoreRequest } from './restore-jobs.js';
import type { ClientMessage, ServerMessage, ToolImage } from './protocol.js';
import { INITIAL_HISTORY_LIMIT, HISTORY_PAGE_SIZE } from './protocol.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  runInstall,
  runUninstall,
  runServiceStatus,
  parseInstallOptions,
  printInstallHelp,
} from './commands/install.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const devStaticPath = path.resolve(__dirname, '../../web/build');
const prodStaticPath = path.resolve(__dirname, '../public');
const staticDir = fs.existsSync(devStaticPath) ? devStaticPath : prodStaticPath;

// When true (set via --debug), the served dashboard index.html is rewritten so
// eruda's custom-plugin loader is enabled. Plugin loading is the only eruda
// feature that takes a URL parameter into a <script src>, so it is kept off by
// default to avoid a DOM-XSS vector; the operator flips it on locally to debug.
let debugEnabled = false;
const ERUDA_PLUGINS_META_FALSE = 'wherever-eruda-plugins" content="false"';
const ERUDA_PLUGINS_META_TRUE = 'wherever-eruda-plugins" content="true"';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.csv': 'text/csv',
  '.zip': 'application/zip',
  '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json',
  // Audio media types. Without these, audio files were served as
  // application/octet-stream, which browsers refuse to play inline. Extensions
  // mirror the web media-kind helper's AUDIO_EXTS.
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  // Video media types. Same rationale; extensions mirror the web media-kind
  // helper's VIDEO_EXTS so inline <video> playback gets a playable Content-Type.
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.ogv': 'video/ogg'
};

function mimeTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

// Content-Type prefixes that should render INLINE in the browser (media the
// user previews in-chat) rather than force a save dialog. An `attachment`
// disposition can suppress inline <video>/<audio>/<img> rendering, so media
// gets `inline`; everything else keeps `attachment` (the safe save default).
//
// SECURITY: image/svg+xml is DELIBERATELY EXCLUDED from the inline set. An SVG
// can embed <script>, and serving it `Content-Disposition: inline` from the
// server origin lets a tap-to-open navigation to the download URL execute that
// script in the app's origin (stored XSS). SVG is not needed for <video>/<audio>
// seeking, and raster/vector images preview fine via <img src> regardless of
// disposition, so SVG keeps the safe `attachment` default — preserving the
// pre-media-feature security posture the inline-video task required be unchanged.
function dispositionTypeFor(contentType: string): 'inline' | 'attachment' {
  if (contentType === 'image/svg+xml') {
    return 'attachment';
  }
  if (
    contentType.startsWith('audio/') ||
    contentType.startsWith('video/') ||
    contentType.startsWith('image/')
  ) {
    return 'inline';
  }
  return 'attachment';
}

/**
 * Parse a single-range HTTP `Range: bytes=start-end` header against a known
 * resource size. Returns:
 *   - null  when there is no usable range (absent/blank/non-bytes header) -> the
 *     caller serves the full 200.
 *   - { unsatisfiable: true } when the range is syntactically a bytes range but
 *     cannot be satisfied (start beyond EOF) -> the caller replies 416.
 *   - { start, end } (inclusive, clamped to [0, size-1]) for a satisfiable
 *     range -> the caller replies 206 with that slice.
 * Only the FIRST range of a (possibly multi-range) header is honoured; we never
 * emit a multipart/byteranges body (a single contiguous slice is all a media
 * element needs to seek). A suffix range `bytes=-N` returns the last N bytes.
 */
function parseRangeHeader(
  rangeHeader: string | undefined,
  size: number,
): null | { unsatisfiable: true } | { start: number; end: number } {
  if (!rangeHeader) return null;
  const m = /^bytes=(\d*)-(\d*)/.exec(rangeHeader.trim());
  if (!m) return null;
  const startStr = m[1];
  const endStr = m[2];
  // A range with neither bound (`bytes=-`) is meaningless: treat as no range.
  if (startStr === '' && endStr === '') return null;

  let start: number;
  let end: number;
  if (startStr === '') {
    // Suffix range: last `endStr` bytes.
    const suffix = parseInt(endStr, 10);
    if (suffix <= 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = parseInt(startStr, 10);
    end = endStr === '' ? size - 1 : parseInt(endStr, 10);
    if (end > size - 1) end = size - 1;
  }
  if (start > end || start >= size || start < 0) return { unsatisfiable: true };
  return { start, end };
}

function expandTilde(p: string): string {
  if (p.startsWith('~')) return path.join(os.homedir(), p.slice(1));
  return p;
}

/** True iff `p` resolves to the home directory or somewhere beneath it. Used to
 * scope /check-path and /autocomplete-path so an authenticated caller cannot use
 * them to enumerate arbitrary directories outside the home folder. */
function isWithinHome(p: string): boolean {
  const home = os.homedir();
  const normalized = path.resolve(p);
  return normalized === home || normalized.startsWith(home + path.sep);
}

/**
 * Resolve the allowed download roots for a session. Deny-by-default: only files
 * whose REAL path lives under one of these roots are served. Always includes the
 * session cwd and the resolved upload dir; config.downloads.roots adds more.
 * Roots are themselves realpath-resolved so a symlinked root still matches its
 * realpath-resolved targets.
 */
function resolveDownloadRoots(config: WhereverConfig, cwd?: string): string[] {
  const roots = new Set<string>();
  const add = (p?: string) => {
    if (!p) return;
    try {
      roots.add(fs.realpathSync(path.resolve(expandTilde(p))));
    } catch {
      // Non-existent root: keep the lexical resolution so a not-yet-created path
      // under it can still be validated lexically as a fallback.
      roots.add(path.resolve(expandTilde(p)));
    }
  };
  if (cwd) add(cwd);
  add(resolveUploadDir(config, cwd));
  for (const r of config.downloads?.roots || []) add(r);
  return Array.from(roots);
}

/**
 * Validate a requested download path against the allowed roots and return the
 * safe absolute path to stream, or null if it escapes / does not exist / is not
 * a regular file. This is the security-critical guard: it realpath-resolves the
 * target BEFORE the containment check so neither `..` traversal nor an in-tree
 * symlink can point outside an allowed root.
 */
function resolveSafeDownloadPath(requested: string, cwd: string | undefined, roots: string[]): string | null {
  if (!requested) return null;
  let candidate = expandTilde(requested);
  if (!path.isAbsolute(candidate)) {
    if (!cwd) return null;
    candidate = path.resolve(cwd, candidate);
  } else {
    candidate = path.resolve(candidate);
  }

  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null; // does not exist / broken symlink
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null; // never serve directories/devices

  const withinRoot = roots.some((root) => {
    if (real === root) return true;
    return real.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
  });
  if (!withinRoot) return null;

  return real;
}

function serveStaticFile(reqPath: string, res: ServerResponse) {
  let filePath = path.join(staticDir, reqPath === '/' ? 'index.html' : reqPath);

  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }

  if (!fs.existsSync(filePath)) {
    filePath = path.join(staticDir, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = mimeTypeFor(filePath);

  // Cache-Control: content-hashed build assets under /_app/immutable/ never
  // change for a given URL, so they can be cached aggressively. Everything
  // else (HTML app shell, the manifest, top-level icons) must stay revalidated
  // so a freshly deployed build is picked up. This addresses Lighthouse's
  // "efficient cache lifetimes" audit without affecting the service worker's
  // own caching (which keys off the build version).
  // Only treat it as an immutable asset when the resolved file actually lives
  // under the hashed immutable folder (not when the SPA fallback served
  // index.html for an /_app/immutable/* miss).
  const servedImmutable =
    reqPath.startsWith('/_app/immutable/') &&
    filePath.includes(`${path.sep}_app${path.sep}immutable${path.sep}`);
  const cacheControl = servedImmutable
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end(`Server Error: ${err.code}`);
    } else {
      // --debug: flip the eruda custom-plugin flag in the served HTML shell so
      // the dashboard can load eruda plugins from ?eruda=<pkg>. Off otherwise,
      // which closes the DOM-XSS vector for any non-debug deployment.
      if (debugEnabled && filePath.endsWith('index.html')) {
        data = Buffer.from(data.toString().replace(ERUDA_PLUGINS_META_FALSE, ERUDA_PLUGINS_META_TRUE));
      }
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': cacheControl });
      res.end(data);
    }
  });
}

interface WSClient {
  id: string;
  ws: WebSocket;
  sessionId: string | null;
  readOnly: boolean;
  isCliBridge?: boolean;
  // True while this client is attached to its session as a FOLDER-CONFLICT
  // observer: it asked for a session in an occupied folder and was attached
  // read-only until it clicks "Continue anyway". The conflict is a property of
  // THIS client, not of the folder: session_new attaches the observer to the
  // very same session file as the occupant, so a folder-level "is there another
  // session file here" scan cannot see it. Without this flag the live
  // folder_conflict broadcast reported active:false immediately after attaching,
  // which tore the warning banner (and its "Continue anyway" button) back down
  // and left the client stuck read-only with no way out.
  conflictObserver?: boolean;
  // The cwd of the session this client is CURRENTLY loading, recorded at the
  // fast-paint step and valid before the attach completes. A cold load paints the
  // conversation (possibly read-only for a folder conflict) seconds before the
  // agent finishes building and the client is attached, so during that window
  // client.sessionId is still null. Without this, "Continue anyway" clicked while
  // the agent builds could not be honoured: it had no session to resolve, no way
  // to check the sessions.readOnly rule, and was silently dropped.
  pendingCwd?: string;
  // The user clicked "Continue anyway" for the session this client is attached to
  // or currently loading. Kept as a durable INTENT rather than acted on once,
  // because the click can land at any point of a cold load -- before the paint,
  // between paint and attach, or after -- and every one of those orderings must
  // end with the same answer. Reset whenever a new session load/create starts, so
  // a decision never leaks into a different session.
  conflictContinued?: boolean;
  // The ABSOLUTE working folder of the session this client loaded, when that
  // folder does not exist on this machine. Set at the fast-paint step of the
  // load that discovered it and cleared by the next load/create/leave, so it
  // always describes the session the client is looking at RIGHT NOW.
  //
  // It is what makes FOLDER MISSING a hard read-only reason: no live agent was
  // built for the folder (a cold load stops before the build), so every send is
  // refused by path rather than by attachment, and "Continue anyway" -- which
  // only ever answers a folder CONFLICT -- cannot lift it.
  folderMissingCwd?: string;
  // Stable identity supplied by the client on connect, carried across
  // reconnects. Used to retire this viewer's own superseded connection so a
  // dropped-and-reconnected client is never mistaken for a second viewer.
  clientKey?: string;
}

// Retire any still-registered VIEWER connection carrying the same clientKey: it
// is the SAME viewer's superseded socket (a reconnect), not a second viewer.
// Detach it from its session synchronously so the very next message on the new
// socket sees an accurate client count, then terminate the dead socket.
//
// CLI bridges are deliberately left ALONE: their re-registration is already
// handled by registerCliSession/unregisterCliSession, and tearing one down here
// would race a cli_register arriving on the new socket against the old socket's
// async close teardown, which could unregister the session that was just
// re-registered.
function evictPreviousConnection(
  clientKey: string,
  clients: Map<string, WSClient>,
  pool: SessionPool,
  onSessionsUpdated: () => void,
): void {
  for (const prev of Array.from(clients.values())) {
    if (prev.clientKey !== clientKey || prev.isCliBridge) continue;
    if (prev.sessionId) {
      pool.removeClient(prev.sessionId, prev.id);
      prev.sessionId = null;
    }
    clearConflictState(prev);
    clients.delete(prev.id);
    // Tell the superseded connection WHY it is going away, and only then kill it.
    // If it is in fact alive (two tabs that ended up sharing a key, e.g. a
    // duplicated tab cloning sessionStorage), it regenerates its key and comes
    // back as a distinct viewer instead of evicting the other one right back in
    // an endless ping-pong. Losing this frame would restore exactly that
    // ping-pong, with no backstop, so it must not be discarded by the teardown.
    // A genuinely dead socket never reads it and is reaped on the flush timeout.
    sendThenTerminate(prev.ws, { type: 'connection_superseded' });
    onSessionsUpdated();
  }
}

function generateId(): string {
  return Math.random().toString(36).substring(2) + Date.now().toString(36);
}

/**
 * Resolve the auth token WITHOUT requiring it on the command line.
 *
 * Anything in argv is world-readable: `ps -ef` (and /proc/<pid>/cmdline, which
 * is mode 0444) shows the full command line of every process on the machine to
 * every local user, so `--token <secret>` leaks the secret to any account on
 * the box. That is fine for a laptop and NOT fine for a shared/bare-metal host,
 * which is why the environment is the preferred channel for real deployments.
 *
 * Precedence, highest first:
 *   1. `--token <value>`        - explicit argv, kept for compatibility. LEAKS via ps.
 *   2. `WHEREVER_TOKEN`         - preferred for deployments.
 *   3. `WHEREVER_TOKEN_FILE`    - path to a file whose (trimmed) CONTENT is the
 *                                 token. The natural shape for a secret manager
 *                                 (sops-nix, systemd `LoadCredential`) which
 *                                 renders a root-owned 0400 file; nothing
 *                                 secret then exists in argv OR in the
 *                                 environment block.
 *   4. `PI_REMOTE_TOKEN`        - the pre-existing variable, still honoured.
 *
 * TRIMMING IS ASYMMETRIC ON PURPOSE, and the asymmetry is a compatibility rule,
 * not an oversight. The two NEW sources are trimmed, because a secret manager
 * renders a file with a trailing newline and `WHEREVER_TOKEN=$(cat ...)` is the
 * obvious thing to write. The two PRE-EXISTING sources (`--token`,
 * `PI_REMOTE_TOKEN`) are taken VERBATIM, exactly as before, because
 * `authenticate()` compares the raw query parameter with `===`: trimming them
 * would silently change WHICH string authenticates on an install that already
 * has whitespace in its token, locking out every saved client URL. Likewise
 * `--token` wins whenever the FLAG WAS GIVEN, even with an empty or missing
 * value, because that is what the old `case '--token': token = args[++i]`
 * did -- it overwrote whatever the environment had.
 *
 * An unreadable or empty `WHEREVER_TOKEN_FILE` is FATAL rather than "fall
 * through to no token": silently starting an UNAUTHENTICATED server because a
 * secret failed to mount is the one failure mode that must never happen
 * quietly. Note this only fires when the file is the source actually being
 * consulted: an explicit `--token`/`WHEREVER_TOKEN` above it still wins, and
 * the server is authenticated either way.
 */
function resolveToken(cliToken: string | undefined, cliTokenGiven: boolean): { token?: string; source: string } {
  // `cliTokenGiven`, not `cliToken`, so that `--token ''` (and a trailing
  // `--token` with no value) still SUPPRESSES the environment, as it did before.
  if (cliTokenGiven) return { token: cliToken || undefined, source: '--token' };

  const envToken = process.env.WHEREVER_TOKEN;
  if (envToken && envToken.trim()) return { token: envToken.trim(), source: 'WHEREVER_TOKEN' };
  warnIfSetButBlank('WHEREVER_TOKEN', envToken);

  const tokenFile = process.env.WHEREVER_TOKEN_FILE;
  if (tokenFile && tokenFile.trim()) {
    const resolvedPath = expandTilde(tokenFile.trim());
    let contents: string;
    try {
      contents = fs.readFileSync(resolvedPath, 'utf8');
    } catch (err) {
      console.error(
        `FATAL: WHEREVER_TOKEN_FILE is set to ${resolvedPath} but it could not be read ` +
          `(${(err as Error).message}). Refusing to start: continuing would silently run an ` +
          `UNAUTHENTICATED server.`,
      );
      process.exit(1);
    }
    const trimmed = contents.trim();
    if (!trimmed) {
      console.error(
        `FATAL: WHEREVER_TOKEN_FILE (${resolvedPath}) is empty. Refusing to start: continuing ` +
          `would silently run an UNAUTHENTICATED server.`,
      );
      process.exit(1);
    }
    return { token: trimmed, source: `WHEREVER_TOKEN_FILE (${resolvedPath})` };
  }
  warnIfSetButBlank('WHEREVER_TOKEN_FILE', tokenFile);

  // VERBATIM, including surrounding whitespace: see the trimming note above.
  // `'   '` is truthy and therefore enforced, exactly as it was before.
  const legacy = process.env.PI_REMOTE_TOKEN;
  if (legacy) return { token: legacy, source: 'PI_REMOTE_TOKEN' };

  return { token: undefined, source: 'none' };
}

/**
 * A token variable that is SET but blank is almost always a secret that failed
 * to render (a truncated file, a `$(cat ...)` that errored, a half-landed
 * activation), and the consequence is an UNAUTHENTICATED server that looks
 * perfectly healthy. It cannot be fatal -- `VAR=` is also the ordinary way to
 * neutralise an inherited variable, which the test harness relies on -- so it
 * is made LOUD instead. Silence is the only unacceptable outcome here.
 */
function warnIfSetButBlank(name: string, value: string | undefined): void {
  if (value === undefined || value.length === 0) return; // unset, or explicitly neutralised
  if (value.trim().length > 0) return;
  console.warn(
    `[wherever] ${name} is set but contains only whitespace. Treating it as NOT SET. ` +
      `If a secret was meant to be rendered here, it did not arrive, and this server may ` +
      `be starting WITHOUT AUTHENTICATION.`,
  );
}

function parseArgs(): { port: number; host: string; token?: string; tokenSource: string; idleTimeout: number; sslKey?: string; sslCert?: string; noSsl: boolean; httpLocalhostFallbackPort?: number; debug: boolean } {
  const args = process.argv.slice(2);
  let port = parseInt(process.env.PI_REMOTE_PORT || '31415', 10);
  let host = process.env.PI_REMOTE_HOST || '127.0.0.1';
  // Kept separate from the env-derived token so `resolveToken` below can apply
  // one documented precedence chain instead of "whoever assigned last wins".
  // `cliTokenGiven` tracks the FLAG's presence separately from its VALUE, so
  // `--token ''` still suppresses the environment the way it always did.
  let cliToken: string | undefined = undefined;
  let cliTokenGiven = false;
  // Idle eviction window. Longer than the old 5 min so a dip-in/dip-out mobile
  // user returns to a still-WARM session (no agent rebuild) most of the time.
  // With fast-first load a cold return is no longer slow to READ, but a warm
  // session also avoids the async agent build entirely. Override via
  // PI_IDLE_TIMEOUT (ms). See docs/plan-speed-up-long-session-load.md.
  let idleTimeout = parseInt(process.env.PI_IDLE_TIMEOUT || '1200000', 10);
  // TLS material is addressed by PATH, and each half is resolved INDEPENDENTLY
  // (flag > WHEREVER_* > PI_REMOTE_*). On a declaratively-managed host the key
  // arrives from a secret manager at an arbitrary root-owned path (e.g.
  // /run/secrets/wherever-key.pem) while the certificate is a world-readable
  // file somewhere else entirely, so neither may be tied to a home directory.
  let sslKey = process.env.WHEREVER_SSL_KEY || process.env.PI_REMOTE_SSL_KEY || undefined;
  let sslCert = process.env.WHEREVER_SSL_CERT || process.env.PI_REMOTE_SSL_CERT || undefined;
  let noSsl = process.env.PI_REMOTE_NO_SSL === 'true' || process.env.PI_REMOTE_HTTP === 'true';
  let httpLocalhostFallbackPort: number | undefined = undefined;
  // Enables the eruda custom-plugin loader in the served dashboard (local
  // debugging only). Off by default: plugin loading takes a URL param into a
  // <script src>, which is a DOM-XSS vector unless explicitly opted into.
  let debug = process.env.PI_DEBUG === 'true' || process.env.WHEREVER_DEBUG === 'true';

  if (process.env.PI_REMOTE_HTTP_LOCALHOST_FALLBACK) {
    const envVal = process.env.PI_REMOTE_HTTP_LOCALHOST_FALLBACK;
    if (envVal === 'true') {
      httpLocalhostFallbackPort = -1; // auto
    } else {
      const parsed = parseInt(envVal, 10);
      httpLocalhostFallbackPort = isNaN(parsed) ? -1 : parsed;
    }
  }

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--port':
        port = parseInt(args[++i] || '31415', 10);
        break;
      case '--host':
        host = args[++i] || '127.0.0.1';
        break;
      case '--token':
        cliToken = args[++i];
        cliTokenGiven = true;
        break;
      case '--idle-timeout':
        idleTimeout = parseInt(args[++i] || '300000', 10);
        break;
      case '--ssl-key':
        sslKey = args[++i];
        break;
      case '--ssl-cert':
        sslCert = args[++i];
        break;
      case '--no-ssl':
      case '--http':
        noSsl = true;
        break;
      case '--debug':
        debug = true;
        break;
      case '--http-localhost-fallback': {
        const nextArg = args[i + 1];
        if (nextArg && !nextArg.startsWith('--')) {
          const parsedPort = parseInt(nextArg, 10);
          if (!isNaN(parsedPort)) {
            httpLocalhostFallbackPort = parsedPort;
            i++; // consume port
          } else {
            httpLocalhostFallbackPort = -1; // auto
          }
        } else {
          httpLocalhostFallbackPort = -1; // auto
        }
        break;
      }
    }
  }

  const { token, source: tokenSource } = resolveToken(cliToken, cliTokenGiven);

  // Scrub the token out of our own environment once it is resolved. Node builds
  // a child's environment from `process.env`, and this server spawns children
  // that are not ours to trust with it: the agent's own `bash` tool
  // (session-pool.ts) and the memonaut indexer (conversation-search.ts) both
  // inherit it, so `!env` typed in the dashboard -- or a prompt-injected agent
  // running `echo $WHEREVER_TOKEN` -- would print the server's auth token into a
  // transcript that is then indexed to disk. The value is already captured in
  // `token` above; nothing reads these variables again.
  delete process.env.WHEREVER_TOKEN;
  delete process.env.PI_REMOTE_TOKEN;

  return { port, host, token, tokenSource, idleTimeout, sslKey, sslCert, noSsl, httpLocalhostFallbackPort, debug };
}

/** Loopback-only binds are the safe default; everything else is reachable by others. */
function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host.startsWith('127.');
}

function authenticate(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
  const provided = url.searchParams.get('token') || req.headers.authorization?.replace('Bearer ', '') || '';
  return provided === token;
}

function resolveUploadDir(config: WhereverConfig, cwd?: string): string {
  const type = config.uploads?.type || 'tmp';

  if (type === 'session' && cwd) {
    const subDir = config.uploads?.subDir || '.wherever/uploads';
    const resolved = path.resolve(cwd, subDir);
    return resolved;
  }

  if (type === 'custom' && config.uploads?.dir) {
    let customDir = config.uploads.dir;
    if (customDir.startsWith('~')) {
      customDir = path.join(os.homedir(), customDir.slice(1));
    }
    return path.resolve(customDir);
  }

  // Default to tmp
  return os.tmpdir();
}

function sendJSON(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function readBody(req: IncomingMessage, maxLimitBytes = 1e6): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > maxLimitBytes) {
        req.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', (err) => reject(err));
  });
}

function sendWS(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error('Failed to send WS message:', err);
    }
  }
}

// Send a final message and THEN kill the socket, without losing the message.
// terminate() destroys the socket and discards whatever is still buffered; over
// TLS (this server's default) a small frame is frequently still buffered when
// the send call returns, so terminating in the same tick can drop it. Wait for
// the write callback, with a timer so a socket that never flushes (the usual
// case here: the peer is gone) is still reaped promptly.
function sendThenTerminate(ws: WebSocket, msg: ServerMessage, flushTimeoutMs = 1_000): void {
  let done = false;
  const kill = () => {
    if (done) return;
    done = true;
    try {
      // terminate() (not close()) because a superseded socket is typically
      // half-open: a close handshake would never complete.
      if (typeof (ws as any).terminate === 'function') (ws as any).terminate();
      else ws.close();
    } catch {}
  };
  const timer = setTimeout(kill, flushTimeoutMs);
  timer.unref?.();
  if (ws.readyState !== WebSocket.OPEN) {
    clearTimeout(timer);
    kill();
    return;
  }
  try {
    ws.send(JSON.stringify(msg), () => {
      clearTimeout(timer);
      kill();
    });
  } catch (err) {
    clearTimeout(timer);
    kill();
  }
}

async function main(): Promise<void> {
  const { port, host, token, tokenSource, idleTimeout, sslKey, sslCert, noSsl, httpLocalhostFallbackPort, debug } = parseArgs();
  debugEnabled = debug;
  const sessionPool = new SessionPool(idleTimeout);
  await sessionPool.initialize();

  const clients = new Map<string, WSClient>();

  // expandTilde so `~/certs/...` works from a systemd `Environment=` line or an
  // EnvironmentFile, neither of which is shell-expanded. Without it the read
  // below fails and (before the explicit-TLS check further down) the server
  // quietly served plaintext instead.
  let actualSslKey = sslKey ? expandTilde(sslKey) : sslKey;
  let actualSslCert = sslCert ? expandTilde(sslCert) : sslCert;
  let isSecure = !noSsl;
  let tlsExplicitlyConfigured = false;

  if (isSecure) {
    // A key and a certificate only work as a PAIR, so "exactly one supplied" is a
    // misconfiguration. It used to be silent: the `!key || !cert` test threw away
    // the half that WAS supplied and used the self-signed pair, so an operator who
    // pointed --ssl-key at a real key and forgot the cert got a working server
    // presenting a completely different certificate, with nothing in the log. Say
    // so, loudly; the behaviour (fall back to the self-signed pair) is unchanged.
    if (!!actualSslKey !== !!actualSslCert) {
      const supplied = actualSslKey ? '--ssl-key / WHEREVER_SSL_KEY' : '--ssl-cert / WHEREVER_SSL_CERT';
      const missing = actualSslKey ? '--ssl-cert / WHEREVER_SSL_CERT' : '--ssl-key / WHEREVER_SSL_KEY';
      console.warn(
        `[wherever] ${supplied} was supplied but ${missing} was not. A key and a certificate ` +
          `must be given together; IGNORING the one supplied and using the self-signed pair instead.`,
      );
      actualSslKey = undefined;
      actualSslCert = undefined;
    }
    // Whether the operator POINTED AT specific TLS material, as opposed to
    // letting the server mint its own. It decides what happens if that material
    // cannot be loaded further down: see the `tlsExplicitlyConfigured` branch.
    tlsExplicitlyConfigured = !!(actualSslKey && actualSslCert);

    if (!actualSslKey || !actualSslCert) {
      // Automatic self-signed certificate generation. These files are WRITTEN, so
      // they belong to the state dir (WHEREVER_STATE_DIR, defaulting to the config
      // dir, itself defaulting to ~/.wherever) -- with both unset this is exactly
      // the ~/.wherever/certs it has always been.
      const certsDir = getWhereverCertsDir();
      // 0700 on creation: the state dir can now be pointed at a shared location
      // (/var/lib/...), and a world-writable certs dir would let a local user
      // swap in their own key/cert pair. An existing directory keeps its mode.
      const defaultKeyPath = path.join(certsDir, 'localhost.key');
      const defaultCertPath = path.join(certsDir, 'localhost.crt');

      if (!fs.existsSync(defaultKeyPath) || !fs.existsSync(defaultCertPath)) {
        console.log('Generating self-signed SSL certificates for secure HTTPS/WSS...');
        try {
          fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
          execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', defaultKeyPath, '-out', defaultCertPath, '-sha256', '-days', '3650', '-nodes', '-subj', '/CN=localhost'], { stdio: 'ignore' });
          // Assert 0600 ourselves rather than trusting openssl's default: it is
          // a private key, and the mode it lands with has varied by version.
          try { fs.chmodSync(defaultKeyPath, 0o600); } catch {}
          console.log(`Self-signed certificates generated successfully in ${certsDir}`);
        } catch (err) {
          console.warn(`Failed to generate self-signed certificates in ${certsDir} using OpenSSL. Falling back to HTTP.`, (err as Error).message);
          isSecure = false;
        }
      }

      if (isSecure) {
        actualSslKey = defaultKeyPath;
        actualSslCert = defaultCertPath;
      }
    }
  }

  function broadcastToSession(sessionFile: string, msg: ServerMessage, excludeClientId?: string): void {
    const tracked = sessionPool.getSession(sessionFile);
    if (!tracked) return;
    for (const cid of tracked.clients) {
      if (cid === excludeClientId) continue;
      const c = clients.get(cid);
      if (c) sendWS(c.ws, msg);
    }
  }

  // Leading + trailing throttle for `sessions_updated`. Structural changes
  // (attach/leave/create/delete) stay instant because the first call in a quiet
  // window fires immediately; a burst (several agents finishing turns at once,
  // a folder-wide delete) collapses into one trailing broadcast at the window
  // edge instead of N full-list refetches per connected client.
  const SESSIONS_UPDATED_THROTTLE_MS = 2000;
  let lastSessionsUpdatedAt = 0;
  let sessionsUpdatedTimer: ReturnType<typeof setTimeout> | null = null;

  function emitSessionsUpdated(): void {
    lastSessionsUpdatedAt = Date.now();
    const updateMsg: ServerMessage = { type: 'sessions_updated' };
    for (const c of clients.values()) {
      sendWS(c.ws, updateMsg);
    }
    broadcastFolderConflicts();
  }

  function broadcastSessionsUpdated(): void {
    if (sessionsUpdatedTimer) return; // a trailing broadcast is already queued
    const elapsed = Date.now() - lastSessionsUpdatedAt;
    if (elapsed >= SESSIONS_UPDATED_THROTTLE_MS) {
      emitSessionsUpdated();
      return;
    }
    sessionsUpdatedTimer = setTimeout(() => {
      sessionsUpdatedTimer = null;
      emitSessionsUpdated();
    }, SESSIONS_UPDATED_THROTTLE_MS - elapsed);
    // Never hold the process open just for a list refresh.
    sessionsUpdatedTimer.unref?.();
  }

  // Tell each attached client whether ANOTHER active session currently exists in
  // the same folder as its session. Drives the warning banner: it appears when a
  // second session shows up in the folder and disappears once the other one is
  // gone. Sent on every session-set change (open/leave/create/destroy). CLI
  // bridge connections are skipped (they have no banner UI).
  function broadcastFolderConflicts(): void {
    // readOnly rides along every time so the client's composer mirrors the
    // server's authority rather than inferring it from `active`.
    for (const c of clients.values()) {
      sendFolderConflict(c, sessionPool);
    }
  }

  function broadcastAgentEvent(sessionFile: string, event: AgentSessionEvent): void {
    let msg: ServerMessage | null = null;
    const sessionId = sessionPool.getSession(sessionFile)?.sessionId || '';

    switch (event.type) {
      case 'agent_start':
        msg = { type: 'agent_start', sessionId };
        break;
      case 'message_update': {
        if (event.message.role !== 'assistant') break;
        const evt = (event as any).assistantMessageEvent;
        if (evt?.type === 'text_delta') {
          msg = { type: 'message_update', sessionId, delta: evt.delta };
        } else if (evt?.type === 'thinking_delta') {
          msg = { type: 'thinking_update', sessionId, delta: evt.delta };
        }
        break;
      }
      case 'message_end': {
        const role = (event.message as any)?.role;
        if (role !== 'assistant' && role !== 'user') break;
        const content = extractText(event.message as any);
        msg = { type: 'message_end', sessionId, content, role };
        break;
      }
      case 'queue_update' as any: {
        // pi's queue changed (a steer was queued, delivered, or cleared). Relay
        // the current steering queue so the web can show which messages are
        // still pending and offer a (session-level) cancel. Only steering matters
        // for cancel; follow-ups are a separate concept the web does not surface.
        const steering = ((event as any).steering as readonly string[] | undefined) ?? [];
        msg = { type: 'queue_update', sessionId, steering: [...steering] };
        break;
      }
      case 'agent_end': {
        msg = { type: 'agent_end', sessionId };
        const messages = (event as any).messages;
        if (Array.isArray(messages) && messages.length > 0) {
          const lastMsg = messages[messages.length - 1];
          if (lastMsg && lastMsg.stopReason === 'error' && lastMsg.errorMessage) {
            // Send a session_error message to all clients of this session
            const errMsg: ServerMessage = {
              type: 'session_error',
              sessionId,
              error: lastMsg.errorMessage
            };
            for (const c of clients.values()) {
              if (c.sessionId === sessionFile) {
                sendWS(c.ws, errMsg);
              }
            }
          }
        }
        break;
      }
      case 'auto_retry_start': {
        const evt = event as any;
        const errMsg: ServerMessage = {
          type: 'session_error',
          sessionId,
          error: `Error: ${evt.errorMessage}. Retrying (attempt ${evt.attempt}/${evt.maxAttempts}) in ${Math.round(evt.delayMs / 1000)}s...`
        };
        for (const c of clients.values()) {
          if (c.sessionId === sessionFile) {
            sendWS(c.ws, errMsg);
          }
        }
        break;
      }
      case 'auto_retry_end': {
        const evt = event as any;
        if (!evt.success && evt.finalError) {
          const errMsg: ServerMessage = {
            type: 'session_error',
            sessionId,
            error: `Retry failed: ${evt.finalError}`
          };
          for (const c of clients.values()) {
            if (c.sessionId === sessionFile) {
              sendWS(c.ws, errMsg);
            }
          }
        } else if (evt.success) {
          for (const c of clients.values()) {
            if (c.sessionId === sessionFile) {
              sendWS(c.ws, { type: 'session_error', sessionId, error: '' });
            }
          }
        }
        break;
      }
      case 'session_error' as any: {
        msg = {
          type: 'session_error',
          sessionId,
          error: (event as any).error
        };
        break;
      }
      case 'bash_sudo_prompt' as any: {
        const evt = event as any;
        msg = { type: 'bash_sudo_prompt', sessionId, promptId: evt.promptId, command: evt.command };
        break;
      }
      case 'tool_execution_start':
        msg = { type: 'tool_start', sessionId, toolName: event.toolName, args: event.args, ...((event as any).forceCommand ? { forceCommand: true } : {}) };
        break;
      case 'tool_execution_update': {
        const evt = event as any;
        msg = { type: 'tool_update', sessionId, toolName: event.toolName, delta: evt.delta || '' };
        break;
      }
      case 'tool_execution_end': {
        const toolResult = extractToolResult(event as any);
        const toolImages = extractToolImages(event as any);
        msg = {
          type: 'tool_end',
          sessionId,
          toolName: event.toolName,
          isError: event.isError,
          result: toolResult,
          ...(toolImages.length > 0 ? { images: toolImages } : {}),
          ...((event as any).forceCommand ? { forceCommand: true } : {}),
        };
        break;
      }
      case 'model_select' as any: {
        const evt = event as any;
        const modelStr = typeof evt.model === 'string'
          ? evt.model
          : (evt.model ? `${evt.model.provider}:${evt.model.id}` : '');
        if (modelStr) {
          msg = { type: 'model_changed', sessionId, model: modelStr };
        }
        break;
      }
      case 'context_usage' as any: {
        // Emitted by the CLI bridge for CLI sessions (server sessions use the
        // broadcastContextUsage path below). The snapshot is already cached.
        msg = {
          type: 'context_usage',
          sessionId,
          contextUsage: (event as any).contextUsage ?? null,
        };
        break;
      }
    }

    if (msg) {
      for (const c of clients.values()) {
        if (c.sessionId === sessionFile) {
          sendWS(c.ws, msg);
        }
      }
    }

    // Push an updated context-usage snapshot at points where it can change:
    // a finished turn, a settled message, or a model switch (context window
    // changes). Cheap and keeps the "11.3% / 1.0M" indicator live.
    if (
      event.type === 'agent_end' ||
      event.type === 'message_end' ||
      (event.type as any) === 'model_select'
    ) {
      broadcastContextUsage(sessionFile);
    }

    // Only a FINISHED turn changes what the session list shows (message count,
    // modified time, first message). `message_end` fires per message, many times
    // per turn, and every broadcast makes every connected client refetch the
    // whole /sessions list, so listening to it turned one turn into a burst of
    // full-list refetches.
    if (event.type === 'agent_end') {
      broadcastSessionsUpdated();
    }
  }

  function broadcastContextUsage(sessionFile: string): void {
    const tracked = sessionPool.getSession(sessionFile);
    if (!tracked) return;
    const usage = sessionPool.getContextUsage(sessionFile);
    if (usage === undefined) return;
    const msg: ServerMessage = {
      type: 'context_usage',
      sessionId: tracked.sessionId,
      contextUsage: usage,
    };
    for (const c of clients.values()) {
      if (c.sessionId === sessionFile) {
        sendWS(c.ws, msg);
      }
    }
  }

  sessionPool.onEvent = broadcastAgentEvent;

  const requestHandler = async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/health') {
      sendJSON(res, 200, { status: 'ok', timestamp: Date.now() });
      return;
    }

    const isApiRequest = pathname.startsWith('/sessions') || 
                          pathname.startsWith('/search') || 
                          pathname.startsWith('/drafts') || 
                          pathname.startsWith('/models') || 
                          pathname.startsWith('/config') || 
                          pathname.startsWith('/check-path') || 
                          pathname.startsWith('/check-remote-repo') || 
                          pathname.startsWith('/remote-candidates') || 
                          pathname.startsWith('/autocomplete-path') || 
                          pathname.startsWith('/session/');

    if (isApiRequest && !authenticate(req, token)) {
      sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    if (pathname === '/sessions' && req.method === 'GET') {
      // ?view=readonly returns only the sessions.readOnly folders (the separate
      // read-only page); default returns the main list (ignore + readOnly hidden).
      const view = url.searchParams.get('view') === 'readonly' ? 'readonly' : 'default';
      const folders = await sessionPool.listSessions(view);
      const active = sessionPool.getActiveSessions();
      sendJSON(res, 200, { folders, activeSessions: active });
      return;
    }

    // Full-text search over every past session, backed by the memonaut index.
    // Same token gate as /sessions (via isApiRequest above). A missing index is
    // answered with status:'not-indexed', never built inline: memonaut's indexer
    // is synchronous and a full build would freeze every WebSocket client.
    // See server/src/conversation-search.ts for the privacy composition rule.
    if (pathname === '/search' && req.method === 'GET') {
      const view = url.searchParams.get('view') === 'readonly' ? 'readonly' : 'default';
      const limitParam = Number(url.searchParams.get('limit'));
      const result = await searchConversations({
        query: url.searchParams.get('q') || '',
        view,
        limit: Number.isFinite(limitParam) && limitParam > 0 ? limitParam : undefined,
      });
      sendJSON(res, 200, result);
      return;
    }

    if (pathname === '/models' && req.method === 'GET') {
      const models = sessionPool.getAvailableModels();
      sendJSON(res, 200, { models });
      return;
    }

    // --- Saved drafts (messages kept instead of sent) ----------------------
    // Server-side on purpose: a draft saved on a phone must be there on the
    // laptop, so the store is <config dir>/drafts.json, not browser storage.
    // Behind the same token gate as the other API routes (via isApiRequest).
    // Every mutation answers with the WHOLE new list, so the client never has to
    // merge/cap/dedupe a list of its own: drafts.ts is the only writer.
    if (pathname === '/drafts' && req.method === 'GET') {
      try {
        sendJSON(res, 200, { drafts: readDrafts() });
      } catch (err) {
        // An unreadable/corrupt store is reported, never flattened to an empty
        // list: the client would mirror that empty list over its offline copy.
        sendJSON(res, 500, { error: (err as Error).message || 'Failed to read drafts' });
      }
      return;
    }

    if (pathname === '/drafts' && req.method === 'POST') {
      let parsed: any;
      try {
        parsed = JSON.parse((await readBody(req)) || '{}');
      } catch {
        sendJSON(res, 400, { error: 'Invalid request' });
        return;
      }
      const invalid = validateDraftInput(parsed);
      if (invalid) {
        // Rejected, not truncated: the composer clears itself once the server
        // has the draft, so a silently stored prefix would lose the tail.
        sendJSON(res, 400, { error: invalid });
        return;
      }
      try {
        const drafts = addDraft({
          text: parsed.text,
          sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : undefined,
          cwd: typeof parsed.cwd === 'string' ? parsed.cwd : undefined,
        });
        sendJSON(res, 200, { drafts });
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message || 'Failed to save draft' });
      }
      return;
    }

    // POST rather than DELETE, mirroring /session/delete: the same shape as the
    // rest of this API, and it survives proxies that drop the DELETE method.
    if (pathname === '/drafts/delete' && req.method === 'POST') {
      let parsed: any;
      try {
        parsed = JSON.parse((await readBody(req)) || '{}');
      } catch {
        sendJSON(res, 400, { error: 'Invalid request' });
        return;
      }
      const id = typeof parsed.id === 'string' ? parsed.id : '';
      if (!id) {
        sendJSON(res, 400, { error: 'Missing draft id' });
        return;
      }
      try {
        sendJSON(res, 200, { drafts: deleteDraft(id) });
      } catch (err) {
        sendJSON(res, 500, { error: (err as Error).message || 'Failed to delete draft' });
      }
      return;
    }

    if (pathname === '/config' && req.method === 'GET') {
      const config = getWhereverConfig();
      let searchFolder: string | undefined = config.searchFolder;
      if (searchFolder && searchFolder.startsWith('~')) {
        searchFolder = path.join(os.homedir(), searchFolder.slice(1));
      }
      // Resolve the search folder's default model against that folder's settings
      // (folder-local harness/pi config wins), so the search composer can seed its
      // model picker with the folder default rather than the server global.
      const searchDefaultModel = searchFolder
        ? sessionPool.getDefaultModelFor(searchFolder)
        : null;
      sendJSON(res, 200, {
        gitInitDefault: !!config.gitInitDefault,
        uploadMethod: config.uploads?.method || 'websocket',
        downloadsEnabled: config.downloads?.enabled !== false,
        searchFolder: searchFolder || null,
        searchCreateRemote: !!config.searchCreateRemote,
        searchDefaultModel
      });
      return;
    }

    if (pathname === '/check-path' && req.method === 'GET') {
      const qPath = url.searchParams.get('path');
      if (!qPath) {
        sendJSON(res, 400, { error: 'Missing path' });
        return;
      }
      let resolved = qPath;
      if (qPath.startsWith('~')) {
        resolved = path.join(os.homedir(), qPath.slice(1));
      } else if (!path.isAbsolute(qPath)) {
        resolved = path.join(os.homedir(), qPath);
      } else {
        resolved = path.resolve(qPath);
      }

      // Scope to the home folder so this endpoint cannot be used to probe
      // arbitrary paths elsewhere on the server.
      if (!isWithinHome(resolved)) {
        sendJSON(res, 403, { error: 'Path is outside the home directory' });
        return;
      }

      const exists = fs.existsSync(resolved);
      let isGit = false;
      if (exists) {
        isGit = fs.existsSync(path.join(resolved, '.git'));
      }

      // Check matching remote rules
      let matchingRule = null;
      const config = getWhereverConfig();
      const rule = matchRemoteRepoRule(config.remoteRepoRules, resolved);
      if (rule) {
        matchingRule = {
          provider: rule.provider,
          visibility: rule.visibility || 'private'
        };
      }

      sendJSON(res, 200, { exists, isGit, resolvedPath: resolved, matchingRule });
      return;
    }

    // Submit-time probe: does the remote repo that WOULD be created for this
    // folder already exist? Only meaningful when the folder does not exist and
    // matches a remoteRepoRule. Runs a provider CLI (gh/tea/cb) so it is called
    // on demand at create time, NOT on every keystroke.
    if (pathname === '/check-remote-repo' && req.method === 'GET') {
      const qPath = url.searchParams.get('path');
      if (!qPath) {
        sendJSON(res, 400, { error: 'Missing path' });
        return;
      }
      let resolved = qPath;
      if (qPath.startsWith('~')) {
        resolved = path.join(os.homedir(), qPath.slice(1));
      } else if (!path.isAbsolute(qPath)) {
        resolved = path.join(os.homedir(), qPath);
      } else {
        resolved = path.resolve(qPath);
      }

      const config = getWhereverConfig();
      const rule = matchRemoteRepoRule(config.remoteRepoRules, resolved);

      if (!rule) {
        sendJSON(res, 200, { exists: false, matched: false });
        return;
      }

      const probe = detectRemoteRepo(rule, path.basename(resolved));
      sendJSON(res, 200, {
        matched: true,
        provider: rule.provider,
        exists: probe.exists,
        sshUrl: probe.exists ? probe.sshUrl : undefined,
      });
      return;
    }

    // Restore pre-fill: which repository does this (probably missing) folder
    // correspond to? Answers an ORDERED, ADVISORY list of SSH candidates --
    // the provider probe first, then the `<host-token>/<owner>/<repo>` path
    // convention (see server/src/remote-candidates.ts). Never HTTPS.
    //
    // Beside /check-remote-repo and for the same reason: the probe shells out to
    // a provider CLI, so this is called ON DEMAND (the restore panel opening),
    // never per keystroke and never on the session-load path.
    if (pathname === '/remote-candidates' && req.method === 'GET') {
      const qPath = url.searchParams.get('path');
      if (!qPath) {
        sendJSON(res, 400, { error: 'Missing path' });
        return;
      }
      let resolved = qPath;
      if (qPath.startsWith('~')) {
        resolved = path.join(os.homedir(), qPath.slice(1));
      } else if (!path.isAbsolute(qPath)) {
        resolved = path.join(os.homedir(), qPath);
      } else {
        resolved = path.resolve(qPath);
      }

      // Same scoping as /check-path: an authenticated caller cannot use this to
      // ask questions about paths outside the home folder.
      if (!isWithinHome(resolved)) {
        sendJSON(res, 403, { error: 'Path is outside the home directory' });
        return;
      }

      const config = getWhereverConfig();
      const candidates = resolveRemoteCandidates(resolved, config.remoteRepoRules, detectRemoteRepo);
      sendJSON(res, 200, { resolvedPath: resolved, candidates });
      return;
    }

    if (pathname === '/autocomplete-path' && req.method === 'GET') {
      const qPath = url.searchParams.get('path') || '';
      let parentPath = '';
      let prefix = '';

      const lastSlashIndex = qPath.lastIndexOf('/');
      if (lastSlashIndex === -1) {
        parentPath = '~';
        prefix = qPath;
      } else {
        parentPath = qPath.slice(0, lastSlashIndex + 1);
        prefix = qPath.slice(lastSlashIndex + 1);
      }

      let resolvedParent = parentPath;
      if (parentPath.startsWith('~')) {
        resolvedParent = path.join(os.homedir(), parentPath.slice(1));
      } else if (!path.isAbsolute(parentPath)) {
        resolvedParent = path.join(os.homedir(), parentPath);
      } else {
        resolvedParent = path.resolve(parentPath);
      }

      // Scope to the home folder so this endpoint cannot be used to enumerate
      // directories elsewhere on the server.
      if (!isWithinHome(resolvedParent)) {
        sendJSON(res, 403, { error: 'Path is outside the home directory' });
        return;
      }

      const config = getWhereverConfig();
      
      // Resolve the query path
      let resolvedQuery = qPath;
      if (qPath.startsWith('~')) {
        resolvedQuery = path.join(os.homedir(), qPath.slice(1));
      } else if (!path.isAbsolute(qPath)) {
        resolvedQuery = path.join(os.homedir(), qPath);
      } else {
        resolvedQuery = path.resolve(qPath);
      }
      const resolvedQueryLower = resolvedQuery.toLowerCase();

      // Format matched common folder to match the user's input prefix style
      const formatCommonFolder = (folderPath: string) => {
        let resolved = folderPath;
        if (folderPath.startsWith('~')) {
          resolved = path.join(os.homedir(), folderPath.slice(1));
        } else if (!path.isAbsolute(folderPath)) {
          resolved = path.join(os.homedir(), folderPath);
        } else {
          resolved = path.resolve(folderPath);
        }

        // Apply trailing slash if missing
        if (!resolved.endsWith('/')) {
          resolved = resolved + '/';
        }

        if (qPath.startsWith('~')) {
          const home = os.homedir() + '/';
          if (resolved.startsWith(home)) {
            return '~/' + resolved.slice(home.length);
          }
          return resolved;
        } else if (qPath.startsWith('/')) {
          return resolved;
        } else {
          const home = os.homedir() + '/';
          if (resolved.startsWith(home)) {
            return resolved.slice(home.length);
          }
          return resolved;
        }
      };

      // Filter and format matching common folders
      const matchingCommons = (config.commonFolders || [])
        .filter(folder => {
          let resolved = folder;
          if (folder.startsWith('~')) {
            resolved = path.join(os.homedir(), folder.slice(1));
          } else if (!path.isAbsolute(folder)) {
            resolved = path.join(os.homedir(), folder);
          } else {
            resolved = path.resolve(folder);
          }
          return resolved.toLowerCase().startsWith(resolvedQueryLower);
        })
        .map(folder => formatCommonFolder(folder));

      try {
        if (!fs.existsSync(resolvedParent)) {
          sendJSON(res, 200, { completions: matchingCommons });
          return;
        }

        const stat = fs.statSync(resolvedParent);
        if (!stat.isDirectory()) {
          sendJSON(res, 200, { completions: matchingCommons });
          return;
        }

        const entries = fs.readdirSync(resolvedParent, { withFileTypes: true });
        const actualCompletionsWithStats = entries
          .filter(entry => {
            if (!entry.isDirectory()) return false;
            if (entry.name.startsWith('.') && !prefix.startsWith('.')) return false;
            return entry.name.toLowerCase().startsWith(prefix.toLowerCase());
          })
          .map(entry => {
            const entryPath = path.join(resolvedParent, entry.name);
            let mtimeMs = 0;
            try {
              mtimeMs = fs.statSync(entryPath).mtimeMs;
            } catch (e) {
              // Ignore stats errors
            }
            return {
              name: entry.name,
              mtimeMs
            };
          });

        // Sort by mtimeMs descending (most recent first)
        actualCompletionsWithStats.sort((a, b) => b.mtimeMs - a.mtimeMs);

        const actualCompletions = actualCompletionsWithStats.map(item => {
          let formattedParent = parentPath;
          if (parentPath === '~') {
            formattedParent = '~/';
          }
          return formattedParent + item.name + '/';
        });

        const combined = [...matchingCommons, ...actualCompletions];
        const uniqueCompletions = Array.from(new Set(combined));

        sendJSON(res, 200, { completions: uniqueCompletions });
      } catch (e) {
        sendJSON(res, 200, { completions: matchingCommons });
      }
      return;
    }

    if (pathname === '/session/model' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { sessionId, model } = JSON.parse(body) as { sessionId: string; model: string };
        if (!sessionId || !model) {
          sendJSON(res, 400, { error: 'Missing sessionId or model' });
          return;
        }
        const result = await sessionPool.changeModel(sessionId, model);
        if (result.error) {
          sendJSON(res, 400, { error: result.error });
        } else {
          const tracked = sessionPool.getSession(sessionId);
          if (tracked) {
            const wsMsg: ServerMessage = {
              type: 'model_changed',
              sessionId: tracked.sessionId,
              model,
            };
            for (const cid of tracked.clients) {
              const c = clients.get(cid);
              if (c) sendWS(c.ws, wsMsg);
            }
          }
          sendJSON(res, 200, { status: 'changed', model });
        }
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message || 'Invalid request' });
      }
      return;
    }

    if (pathname === '/session/destroy' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { sessionId } = JSON.parse(body) as { sessionId: string };
        if (!sessionId) {
          sendJSON(res, 400, { error: 'Missing sessionId' });
          return;
        }

        const tracked = sessionPool.getSession(sessionId);
        if (tracked) {
          const wsMsg: ServerMessage = {
            type: 'session_destroyed',
            sessionId: tracked.sessionId,
            reason: 'Session destroyed manually'
          };
          for (const cid of tracked.clients) {
            const c = clients.get(cid);
            if (c) {
              sendWS(c.ws, wsMsg);
              c.sessionId = null;
              c.readOnly = false;
              // The conflict decision belonged to the session that just went away.
              clearConflictState(c);
            }
          }
        }

        sessionPool.destroySession(sessionId, 'manual');
        sendJSON(res, 200, { status: 'destroyed' });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message || 'Invalid request' });
      }
      return;
    }

    if (pathname === '/session/delete' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { sessionFile } = JSON.parse(body) as { sessionFile: string };
        if (!sessionFile) {
          sendJSON(res, 400, { error: 'Missing sessionFile' });
          return;
        }

        let resolved = sessionFile;
        if (sessionFile.startsWith('~')) {
          resolved = path.join(os.homedir(), sessionFile.slice(1));
        } else if (!path.isAbsolute(sessionFile)) {
          resolved = path.join(os.homedir(), sessionFile);
        } else {
          resolved = path.resolve(sessionFile);
        }

        // Security check: only allow deleting session .jsonl files that live
        // inside the server's sessions directory, so an authenticated caller
        // cannot unlink arbitrary .jsonl files elsewhere on disk.
        if (!sessionPool.isSessionFile(resolved)) {
          sendJSON(res, 400, { error: 'Invalid session file: not a session in the sessions directory' });
          return;
        }

        // Get the active session if any, using either the sessionFile path or resolved path
        const tracked = sessionPool.getSession(sessionFile) || sessionPool.getSession(resolved);
        if (tracked) {
          const wsMsg: ServerMessage = {
            type: 'session_destroyed',
            sessionId: tracked.sessionId,
            reason: 'Session deleted'
          };
          for (const cid of tracked.clients) {
            const c = clients.get(cid);
            if (c) {
              sendWS(c.ws, wsMsg);
              c.sessionId = null;
              c.readOnly = false;
              // The conflict decision belonged to the session that just went away.
              clearConflictState(c);
            }
          }
          sessionPool.destroySession(tracked.sessionFile, 'deleted');
        }

        if (fs.existsSync(resolved)) {
          fs.unlinkSync(resolved);
        }

        // Tell all connected clients the list changed. Throttled: deleting a
        // whole folder fires one DELETE per session in parallel, and each one
        // would otherwise make every client refetch the entire list.
        broadcastSessionsUpdated();

        sendJSON(res, 200, { status: 'deleted' });
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message || 'Invalid request' });
      }
      return;
    }

    if (pathname === '/session/new' && req.method === 'POST') {
      try {
        const body = await readBody(req);
        const { cwd, model, gitInit, createRemote, repoVisibility, cloneRemote } = JSON.parse(body) as { cwd: string; model?: string; gitInit?: boolean; createRemote?: boolean; repoVisibility?: 'private' | 'public'; cloneRemote?: boolean };
        if (!cwd) {
          sendJSON(res, 400, { error: 'Missing cwd' });
          return;
        }
        // Same CLONE branch as the WebSocket `session_new`, through the same
        // restore job registry, so this endpoint gains recursive submodules and
        // loses nothing. There is no progress channel on a plain HTTP request,
        // so it simply waits for the job it started (or joined); any WebSocket
        // client looking at that folder still gets the live frames.
        if (cloneRemote) {
          const outcome = await cloneForNewSession(resolveCreateCwd(cwd), clients, sessionPool);
          if (outcome.status === 'failed') {
            sendJSON(res, 500, { error: outcome.error });
            return;
          }
        }
        const result = await sessionPool.createNewSession(cwd, model, gitInit, createRemote, repoVisibility);
        if (result.error) {
          sendJSON(res, 500, { error: result.error });
        } else {
          broadcastSessionsUpdated();
          sendJSON(res, 201, {
            sessionId: result.tracked.sessionId,
            sessionFile: result.tracked.sessionFile,
            cwd: result.tracked.cwd,
            model: result.tracked.model,
          });
        }
      } catch (err) {
        sendJSON(res, 400, { error: (err as Error).message || 'Invalid request' });
      }
      return;
    }

    if (pathname === '/session/upload' && req.method === 'POST') {
      try {
        const qSessionId = url.searchParams.get('sessionId') || '';
        const qFilename = url.searchParams.get('filename') || '';

        if (!qSessionId || !qFilename) {
          sendJSON(res, 400, { error: 'Missing sessionId or filename' });
          return;
        }

        const tracked = sessionPool.getSession(qSessionId);
        const cwd = tracked?.cwd;

        const config = getWhereverConfig();
        const targetDir = resolveUploadDir(config, cwd);

        fs.mkdirSync(targetDir, { recursive: true });

        const timestamp = Date.now();
        const safeFilename = `${timestamp}_${path.basename(qFilename)}`;
        const destPath = path.join(targetDir, safeFilename);

        const writeStream = fs.createWriteStream(destPath);
        req.pipe(writeStream);

        writeStream.on('finish', () => {
          sendJSON(res, 200, {
            status: 'uploaded',
            filename: qFilename,
            savedPath: destPath
          });
        });

        writeStream.on('error', (err) => {
          sendJSON(res, 500, { error: `Failed to write file: ${err.message}` });
        });
      } catch (err) {
        sendJSON(res, 500, { error: `Upload error: ${(err as Error).message}` });
      }
      return;
    }

    if (pathname === '/session/download' && req.method === 'GET') {
      const config = getWhereverConfig();
      if (config.downloads?.enabled === false) {
        sendJSON(res, 403, { error: 'Downloads are disabled on this server' });
        return;
      }

      const qSessionId = url.searchParams.get('sessionId') || '';
      const qPath = url.searchParams.get('path') || '';
      if (!qSessionId || !qPath) {
        sendJSON(res, 400, { error: 'Missing sessionId or path' });
        return;
      }

      const tracked = sessionPool.getSession(qSessionId);
      const cwd = tracked?.cwd;

      const roots = resolveDownloadRoots(config, cwd);
      const safePath = resolveSafeDownloadPath(qPath, cwd, roots);
      if (!safePath) {
        // 404 (not 403) so we do not leak whether a path outside the allowed
        // roots exists: escape and not-found are indistinguishable to the client.
        sendJSON(res, 404, { error: 'File not found or not allowed' });
        return;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(safePath);
      } catch {
        sendJSON(res, 404, { error: 'File not found' });
        return;
      }

      const maxBytes = config.downloads?.maxBytes ?? 100 * 1024 * 1024;
      if (stat.size > maxBytes) {
        sendJSON(res, 413, { error: `File too large (${stat.size} > ${maxBytes} bytes)` });
        return;
      }

      const filename = path.basename(safePath);
      // RFC 5987 encoded filename for non-ASCII names, plus a plain ASCII
      // fallback with quotes escaped.
      const asciiName = filename.replace(/["\\]/g, '_').replace(/[^\x20-\x7e]/g, '_');
      const encodedName = encodeURIComponent(filename);
      const contentType = mimeTypeFor(safePath);
      // Media (audio/video/image) renders inline; everything else stays a
      // download (`attachment`). Both keep the ASCII + RFC 5987 filename.
      const disposition = dispositionTypeFor(contentType);
      const contentDisposition = `${disposition}; filename="${asciiName}"; filename*=UTF-8''${encodedName}`;

      // Honour a single-range HTTP Range request so <video>/<audio> can seek.
      // No Range header -> full 200. A satisfiable range -> 206 with a sliced
      // stream + Content-Range. An unsatisfiable range -> 416.
      const rangeHeader = req.headers['range'];
      const range = parseRangeHeader(
        Array.isArray(rangeHeader) ? rangeHeader[0] : rangeHeader,
        stat.size,
      );

      if (range && 'unsatisfiable' in range) {
        res.writeHead(416, {
          'Content-Range': `bytes */${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-store',
        });
        res.end();
        return;
      }

      if (range) {
        const { start, end } = range;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Length': chunkSize,
          'Content-Range': `bytes ${start}-${end}/${stat.size}`,
          'Accept-Ranges': 'bytes',
          'Content-Disposition': contentDisposition,
          'Cache-Control': 'no-store',
        });
        const stream = fs.createReadStream(safePath, { start, end });
        stream.on('error', (err) => {
          if (!res.headersSent) {
            sendJSON(res, 500, { error: `Read error: ${err.message}` });
          } else {
            res.destroy();
          }
        });
        stream.pipe(res);
        return;
      }

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': stat.size,
        // Advertise range support so clients (and <video>) know they can seek.
        'Accept-Ranges': 'bytes',
        'Content-Disposition': contentDisposition,
        'Cache-Control': 'no-store',
      });
      const stream = fs.createReadStream(safePath);
      stream.on('error', (err) => {
        if (!res.headersSent) {
          sendJSON(res, 500, { error: `Read error: ${err.message}` });
        } else {
          res.destroy();
        }
      });
      stream.pipe(res);
      return;
    }

    if (pathname === '/session/transcribe' && req.method === 'POST') {
      const config = getWhereverConfig();
      const apiKey = config.speech?.apiKey || process.env.SPEECH_API_KEY;
      const apiUrl = config.speech?.apiUrl || process.env.SPEECH_API_URL || 'https://api.z.ai/api/paas/v4/audio/transcriptions';
      const apiModel = config.speech?.model || process.env.SPEECH_MODEL || 'glm-asr-2512';

      if (!apiKey) {
        sendJSON(res, 400, { error: 'Server speech transcription API key not configured' });
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length === 0) {
          sendJSON(res, 400, { error: 'Empty audio payload' });
          return;
        }

        const boundary = '----SpeechBoundary' + Math.random().toString(16);
        const header = `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="model"\r\n\r\n` +
          `${apiModel}\r\n` +
          `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="file"; filename="audio.wav"\r\n` +
          `Content-Type: audio/wav\r\n\r\n`;

        const footer = `\r\n--${boundary}--\r\n`;

        const headerBuffer = Buffer.from(header, 'utf-8');
        const footerBuffer = Buffer.from(footer, 'utf-8');
        const totalPayload = Buffer.concat([headerBuffer, audioBuffer, footerBuffer]);

        const parsedUrl = new URL(apiUrl);
        const apiReq = httpRequest({
          hostname: parsedUrl.hostname,
          path: parsedUrl.pathname + parsedUrl.search,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': totalPayload.length
          }
        }, (apiRes) => {
          let responseBody = '';
          apiRes.on('data', (chunk) => responseBody += chunk);
          apiRes.on('end', () => {
            try {
              const parsed = JSON.parse(responseBody);
              if (apiRes.statusCode && apiRes.statusCode >= 400) {
                sendJSON(res, apiRes.statusCode, { error: parsed.error?.message || parsed.message || 'API request failed' });
              } else {
                sendJSON(res, 200, { text: parsed.text || '' });
              }
            } catch (e) {
              sendJSON(res, 500, { error: 'Failed to parse cloud response' });
            }
          });
        });

        apiReq.on('error', (err) => {
          sendJSON(res, 500, { error: err.message });
        });

        apiReq.write(totalPayload);
        apiReq.end();
      });
      return;
    }

    serveStaticFile(pathname, res);
  };

  let server;
  let httpServer: any = null;
  let isSecureServer = false;
  if (isSecure && actualSslKey && actualSslCert) {
    try {
      const options = {
        key: fs.readFileSync(actualSslKey),
        cert: fs.readFileSync(actualSslCert),
      };
      server = createHttpsServer(options, requestHandler);
      isSecureServer = true;
      // Instantiate plain HTTP server on localhost if fallback option is enabled
      if (httpLocalhostFallbackPort !== undefined) {
        httpServer = createHttpServer(requestHandler);
      }
    } catch (err) {
      // Falling back to plaintext is only acceptable for material the server
      // chose for itself. When the operator EXPLICITLY pointed at a key and a
      // certificate, silently serving HTTP on the same (possibly 0.0.0.0)
      // address is the same fail-open ADR 0007 rules out for the token file:
      // it is the exact shape of a secret that has not been decrypted yet, and
      // clients would then send their token in cleartext to a server that looks
      // healthy. Refuse to start instead.
      if (tlsExplicitlyConfigured) {
        console.error(
          `FATAL: TLS was explicitly configured (key ${actualSslKey}, cert ${actualSslCert}) but ` +
            `could not be loaded: ${(err as Error).message}. Refusing to start: falling back to ` +
            `plaintext HTTP would silently expose traffic (and the auth token) on ${host}:${port}. ` +
            `Pass --no-ssl if plaintext is genuinely what you want.`,
        );
        process.exit(1);
      }
      console.error(`Failed to load SSL certificates from ${actualSslKey} and ${actualSslCert}. Falling back to HTTP.`, (err as Error).message);
      server = createHttpServer(requestHandler);
    }
  } else {
    server = createHttpServer(requestHandler);
  }

  const wss = new WebSocketServer({ noServer: true });

  // Connection-liveness heartbeat. A half-open TCP socket (peer vanished without
  // a clean FIN/RST: process restart, network blip, dropped upstream) stays in
  // ESTAB and fires neither 'close' nor 'error', so the connected agent/session
  // is never reaped and hangs forever. We send a protocol-level ping frame on a
  // fixed interval and terminate any socket that did not answer the previous
  // ping. terminate() fires 'close', routing through the existing cleanup
  // (unregisterCliSession / removeClient + broadcastSessionsUpdated).
  // See work/observations/ws-half-open-connection-hangs-agent-no-heartbeat.md.
  const HEARTBEAT_MS = 30_000;
  const liveSockets = new WeakSet<WebSocket>();

  const upgradeHandler = (req: any, socket: any, head: any) => {
    if (req.url?.startsWith('/ws')) {
      if (!authenticate(req, token)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    } else {
      socket.destroy();
    }
  };

  server.on('upgrade', upgradeHandler);
  if (httpServer) {
    httpServer.on('upgrade', upgradeHandler);
  }

  wss.on('connection', (ws, req?: IncomingMessage) => {
    const clientId = generateId();
    // Stable per-viewer identity (see WhereverClientConfig.clientKey). A client
    // that lost its socket silently (half-open TCP: phone sleep, network switch)
    // reconnects on a NEW socket while the old record still sits in the pool
    // until the heartbeat reaper notices, up to 2x HEARTBEAT_MS later. That
    // phantom counted as "another viewer", which silently turned an explicit
    // "New Session Here" into a folder conflict (read-only attach to the folder's
    // existing session). Retiring the same key's previous connection HERE, before
    // any session traffic on the new socket, closes that window. Keys are scoped
    // per tab by the web client, so two real tabs remain two distinct viewers.
    let clientKey: string | undefined;
    try {
      const url = new URL(req?.url || '', `http://${req?.headers?.host || 'localhost'}`);
      const raw = url.searchParams.get('clientKey');
      // Bounded: this is client-supplied text retained for the life of the
      // connection. Anything longer than a generated key is not one. Refuse it
      // rather than truncating (two distinct long keys must not collapse into one
      // identity and start evicting each other), and say so: the connection
      // silently loses supersede protection otherwise.
      if (raw && raw.length > 128) {
        console.warn(`[wherever] ignoring oversized clientKey (${raw.length} chars) from ${req?.socket?.remoteAddress ?? 'unknown'}`);
      } else if (raw) {
        clientKey = raw;
      }
    } catch {}
    if (clientKey) {
      evictPreviousConnection(clientKey, clients, sessionPool, broadcastSessionsUpdated);
    }
    const client: WSClient = {
      id: clientId,
      ws,
      sessionId: null,
      readOnly: false,
      clientKey,
    };
    clients.set(clientId, client);

    // Liveness: assume alive on connect; any pong (reply to the heartbeat ping
    // frame below) re-marks the socket alive for the next interval.
    liveSockets.add(ws);
    ws.on('pong', () => {
      liveSockets.add(ws);
    });

    sendWS(ws, { type: 'connected', clientId, serverVersion: getVersion() });

    ws.on('message', async (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch (err) {
        console.error('WS parse error:', err);
        sendWS(ws, {
          type: 'session_error',
          error: 'Invalid message format (JSON parse failed)'
        });
        return;
      }

      try {
        await handleWSMessage(msg, client, sessionPool, clients, broadcastToSession, broadcastSessionsUpdated);
      } catch (err) {
        console.error('WS message processing error:', err);
        const errorText = (err as Error).message || 'An error occurred';
        if (client.sessionId) {
          const tracked = sessionPool.getSession(client.sessionId);
          const sId = tracked?.sessionId;
          const errMsg: ServerMessage = {
            type: 'session_error',
            sessionId: sId,
            error: errorText
          };
          if (tracked) {
            for (const cid of tracked.clients) {
              const c = clients.get(cid);
              if (c) {
                sendWS(c.ws, errMsg);
              }
            }
          }
        } else {
          sendWS(ws, {
            type: 'session_error',
            error: errorText
          });
        }
      }
    });

    ws.on('close', async () => {
      if (client.sessionId) {
        if (client.isCliBridge) {
          await sessionPool.unregisterCliSession(client.sessionId);
        } else {
          sessionPool.removeClient(client.sessionId, clientId);
        }
        broadcastSessionsUpdated();
      }
      clients.delete(clientId);
    });

    ws.on('error', (err) => {
      console.error(`WS error for ${clientId}:`, err.message);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!liveSockets.has(ws)) {
        // Missed the previous ping: treat as dead and reap. 'close' fires the
        // existing teardown so the agent's session is released, not left dangling.
        // Log with whatever client/session context we can recover so a reaped
        // (hung) agent shows up as an event rather than as silence.
        let reaped: WSClient | undefined;
        for (const c of clients.values()) {
          if (c.ws === ws) { reaped = c; break; }
        }
        console.warn(
          `[wherever] reaping dead WebSocket (missed heartbeat pong): ` +
          `client=${reaped?.id ?? 'unknown'} ` +
          `session=${reaped?.sessionId ?? 'none'} ` +
          `${reaped?.isCliBridge ? 'cli-bridge' : 'viewer'}`,
        );
        try { ws.terminate(); } catch {}
        continue;
      }
      liveSockets.delete(ws);
      try { ws.ping(); } catch {}
    }
  }, HEARTBEAT_MS);
  if (typeof heartbeat.unref === 'function') heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  server.listen(port, host, () => {
    const protocol = isSecureServer ? 'https' : 'http';
    // The SOURCE, never the token itself: this line goes to the journal, which
    // is readable by more people than the secret is.
    const authInfo = token ? ` (token-protected via ${tokenSource})` : ' (no authentication)';
    console.log(`\n🔐 Wherever Server: ${protocol}://${host}:${port}${authInfo}`);
    if (token && tokenSource === '--token') {
      console.warn(
        '[wherever] the token came from the command line, which is visible to every user on this ' +
          'machine via `ps`. For a real deployment set WHEREVER_TOKEN (or WHEREVER_TOKEN_FILE) instead.',
      );
    }
    // Binding off-loopback with no token is a valid, long-supported choice (it
    // is how a trusted mesh/VPN setup runs), so it stays permitted. But it is
    // also exactly what a failed secret render looks like, and the two are
    // indistinguishable from the outside, so it must not slip by as one
    // parenthetical word in an otherwise cheerful startup line.
    if (!token && !isLoopbackHost(host)) {
      console.warn(
        `[wherever] WARNING: listening on ${host} with NO AUTHENTICATION. Anyone who can reach ` +
          `this address has full agent and filesystem access. If you meant to configure a token, ` +
          `it did not arrive: check WHEREVER_TOKEN / WHEREVER_TOKEN_FILE.`,
      );
    }

    if (isSecureServer) {
      console.log(`
👉 FIRST TIME CONNECTING?
Since the server uses an automatically generated self-signed SSL certificate:
1. Open https://${host}:${port} in your browser/phone.
2. You will see a "Your connection is not private" warning.
3. Click "Advanced" (or "More Info") and choose "Proceed to ${host} (unsafe)".
This encrypts all network traffic securely and enables safe, private remote access!
`);
    }
  });

  if (httpServer && httpLocalhostFallbackPort !== undefined) {
    const insecurePort = httpLocalhostFallbackPort === -1 ? port + 1 : httpLocalhostFallbackPort;
    const authInfo = token ? ' (token-protected)' : ' (no authentication)';
    // Strictly bind to 127.0.0.1 (localhost) for absolute security
    httpServer.listen(insecurePort, '127.0.0.1', () => {
      console.log(`\n🔓 Wherever Server (Insecure HTTP/WS Fallback): http://127.0.0.1:${insecurePort}${authInfo}`);
    });
    httpServer.on('error', (err: any) => {
      console.warn('Insecure HTTP Server fallback failed to start:', err.message);
    });
  }

  server.on('error', (err) => {
    console.error('Server error:', err.message);
  });

  const shutdown = async () => {
    console.log('Shutting down...');
    clearInterval(heartbeat);
    for (const c of clients.values()) {
      c.ws.close();
    }
    await sessionPool.disposeAll();
    server.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

// The conflict decision belongs to the PAIRING of this client with one session.
// Clear every part of it together whenever that pairing ends, so no half-state
// (an observer flag without its continue, a cwd from a session we left) can be
// read by the next attach.
function clearConflictState(client: WSClient): void {
  client.conflictObserver = false;
  client.conflictContinued = false;
  client.pendingCwd = undefined;
}

// Is a DIFFERENT session in the same working folder currently being viewed? That
// is the whole definition of a folder conflict: two agents pointed at one working
// tree. Two viewers of the SAME conversation are not a conflict (they share one
// agent), and a session nobody is attached to is not one either (idle, no turns).
function folderHasOtherViewedSession(
  pool: SessionPool,
  mySessionFile: string,
  cwd: string,
): boolean {
  return pool
    .getAllSessions()
    .some((s) => s.sessionFile !== mySessionFile && s.cwd === cwd && s.clients.size > 0);
}

// Recompute ONE client's folder-conflict state and settle the read-only it
// imposed: releasing it once the conflict no longer holds is part of resolving,
// not a side effect the callers could skip. Shared by the live broadcast, the
// cold attach and the "Continue anyway" reply so all three speak with one
// authority. Returns null for connections the banner does not apply to (CLI
// bridges, clients not attached to a session).
function resolveFolderConflictState(
  c: WSClient,
  pool: SessionPool,
): { cwd: string; active: boolean } | null {
  if (c.isCliBridge || !c.sessionId) return null;
  const mine = pool.getSession(c.sessionId);
  if (!mine) return null;

  const active = folderHasOtherViewedSession(pool, mine.sessionFile, mine.cwd);
  // NOTE: every conflict is now between DIFFERENT session files in one folder --
  // an observer gets its own new session (session_new) or loads its own
  // (session_load), never the occupant's file -- so the scan above sees them all.
  // Do NOT fall back to "someone else is on my file": a second viewer of the SAME
  // conversation is not a folder conflict, and counting it would pin the banner
  // (and the read-only it imposes) on forever.

  // The conflict resolved (the other party left the folder/session): release the
  // read-only state it imposed, otherwise the client keeps an observe-only
  // composer forever with no banner left to lift it. A configured
  // sessions.readOnly folder is a hard rule and is never lifted here.
  if (c.conflictObserver && !active) {
    c.conflictObserver = false;
    if (!hasHardReadOnly(c, pool, mine.cwd)) c.readOnly = false;
  }
  return { cwd: mine.cwd, active };
}

// Read-only PRECEDENCE in one place. Of the three reasons a client can be
// read-only, two are HARD and one is dismissible:
//   - a configured `sessions.readOnly` folder: a policy rule, never lifted;
//   - FOLDER MISSING: the working folder does not exist on this machine, so
//     there is nothing to drive; lifted only by restoring it and RELOADING;
//   - a folder conflict: two live sessions in one folder, lifted by the user's
//     "Continue anyway".
// Every site that LIFTS read-only asks this first, so the dismissible reason can
// never dismiss a hard one.
function hasHardReadOnly(client: WSClient, pool: SessionPool, cwd: string): boolean {
  return pool.isReadOnlyCwd(cwd) || client.folderMissingCwd !== undefined;
}

// ---------------------------------------------------------------------------
// Restore jobs over the WebSocket
// ---------------------------------------------------------------------------

// The ONE registry of restore jobs for this server process. Jobs are keyed by
// the resolved absolute TARGET PATH and owned by the server (`docs/adr/0009`),
// so the registry is deliberately process-wide rather than per-connection: that
// is exactly what makes a clone survive the socket that started it, be shared by
// a second device, and never be started twice for one folder. Constructing it is
// inert (nothing runs until `request()`), so it can live at module scope beside
// the handlers that drive it.
const restoreJobs = new RestoreJobRegistry();

// The live broadcast subscription for each observed path, so it can be dropped
// the moment its job settles. This is the SERVER's single subscription per path,
// NOT a per-client one: which clients a frame reaches is derived per frame (see
// clientWatchesRestorePath), so no client bookkeeping exists to leak.
const restoreObservers = new Map<string, () => void>();

/**
 * Does this client currently have the restore target on screen?
 *
 * The three places a client's folder can be recorded, and why each is needed:
 *  - its ATTACHED session's cwd: the ordinary case, a live session in the folder;
 *  - `pendingCwd`: a load painted but not yet attached (a cold load spends
 *    seconds there);
 *  - `folderMissingCwd`: a folder-missing load, which deliberately attaches to
 *    NOTHING and clears `pendingCwd` with it -- so this is the only record of
 *    the folder such a client is looking at, and it is precisely the client the
 *    restore panel is rendered for.
 *
 * Matching is what SUBSCRIPTION means here: it is evaluated per frame rather
 * than registered per socket, so a dropped phone leaves nothing behind and a
 * reconnecting one is matched again for free.
 */
function clientWatchesRestorePath(c: WSClient, pool: SessionPool, targetPath: string): boolean {
  if (c.isCliBridge) return false;
  const attached = c.sessionId ? pool.getSession(c.sessionId)?.cwd : undefined;
  for (const candidate of [attached, c.pendingCwd, c.folderMissingCwd]) {
    if (candidate && path.resolve(candidate) === targetPath) return true;
  }
  return false;
}

function broadcastRestore(
  clients: Map<string, WSClient>,
  pool: SessionPool,
  targetPath: string,
  msg: ServerMessage,
): void {
  for (const c of clients.values()) {
    if (clientWatchesRestorePath(c, pool, targetPath)) sendWS(c.ws, msg);
  }
}

/**
 * Start relaying one path's restore job to whoever is watching that path.
 *
 * Idempotent (a second requester joining a running job must not double-relay),
 * and self-releasing: the subscription is dropped inside `onSettled`, which the
 * registry guarantees for every terminal state, so an observer cannot outlive
 * its job. Subscribe BEFORE requesting the job, because a request can settle
 * synchronously (a spawn that throws) and a frame emitted before the subscription
 * exists would simply be lost.
 */
function observeRestorePath(
  targetPath: string,
  clients: Map<string, WSClient>,
  pool: SessionPool,
): void {
  if (restoreObservers.has(targetPath)) return;
  const unsubscribe = restoreJobs.subscribe(targetPath, {
    onProgress: (_progress, job) => {
      broadcastRestore(clients, pool, targetPath, { type: 'restore_progress', targetPath, job });
    },
    onSettled: (job) => {
      broadcastRestore(clients, pool, targetPath, { type: 'restore_complete', targetPath, job });
      releaseRestoreObserver(targetPath);
    },
  });
  restoreObservers.set(targetPath, unsubscribe);
}

function releaseRestoreObserver(targetPath: string): void {
  const unsubscribe = restoreObservers.get(targetPath);
  if (!unsubscribe) return;
  restoreObservers.delete(targetPath);
  unsubscribe();
}

// The listing's per-folder existence answers, awaiting invalidation, keyed the
// same way. A SECOND, INDEPENDENT subscription to the registry: the session
// browser's "missing" mark is not a client of the restore panel, and routing its
// invalidation through the broadcast relay above would make one the other's
// plumbing. Neither reaches into the registry's internals and neither is wired
// through the other (see CONTEXT.md, "the module owns the observation seam").
const folderExistenceObservers = new Map<string, () => void>();

/**
 * Drop the listing's cached existence answer for a path when the restore job
 * there SETTLES.
 *
 * A restore is the one moment wherever itself changes whether a folder is on
 * this machine, so without this the browser would keep marking a just-restored
 * folder "missing" for the rest of the cache's TTL. Every terminal state
 * invalidates (a cancelled clone REMOVES a directory it created, so the cached
 * answer is equally suspect), but only a `done` job asks the connected clients
 * to refetch: that is what makes the mark disappear with no manual refresh.
 *
 * Idempotent per path and self-releasing inside `onSettled`, exactly like the
 * broadcast observer.
 */
function observeRestoreForFolderExistence(targetPath: string, onSessionsUpdated?: () => void): void {
  if (folderExistenceObservers.has(targetPath)) return;
  const unsubscribe = restoreJobs.subscribe(targetPath, {
    onSettled: (job) => {
      invalidateFolderExistence(targetPath);
      releaseFolderExistenceObserver(targetPath);
      if (job.state === 'done') onSessionsUpdated?.();
    },
  });
  folderExistenceObservers.set(targetPath, unsubscribe);
}

function releaseFolderExistenceObserver(targetPath: string): void {
  const unsubscribe = folderExistenceObservers.get(targetPath);
  if (!unsubscribe) return;
  folderExistenceObservers.delete(targetPath);
  unsubscribe();
}

/**
 * Resolve a caller-supplied `cwd` the way session creation does: `~` and a bare
 * relative path both mean "under the home directory", everything else is
 * resolved as given. Kept identical to `SessionPool.createNewSession`'s own
 * resolution so the restore job's key, the frames it is broadcast under and the
 * folder the session is finally created in are ONE path.
 */
function resolveCreateCwd(cwd: string): string {
  if (cwd.startsWith('~')) return normalizePath(path.join(os.homedir(), cwd.slice(1)));
  if (!path.isAbsolute(cwd)) return normalizePath(path.join(os.homedir(), cwd));
  return normalizePath(path.resolve(cwd));
}

/**
 * `skipped` means no remote was found to clone, so the caller carries on with an
 * ordinary create (the pre-existing fall-back: the user asked to clone, the
 * probe no longer finds the repository, and a folder is made instead).
 */
type NewSessionCloneOutcome = { status: 'cloned' | 'skipped' } | { status: 'failed'; error: string };

/**
 * The CLONE branch of session creation, run through the restore job registry.
 *
 * This is the OTHER entry point of `docs/adr/0009`, and it exists so there is
 * exactly ONE clone implementation in the codebase: the same path-keyed jobs,
 * the same recursive `--recurse-submodules` engine, the same URL allowlist and
 * home-directory guard, and the same honest progress frames the restore panel
 * renders. What it does NOT share is the ending: a loaded session offers a
 * RELOAD (a live agent is a load-time decision), but here there is no session to
 * reload until the clone lands, so the caller CONTINUES into creation itself.
 *
 * The job is awaited rather than reported-and-forgotten precisely because the
 * create depends on it. It stays cancellable while it runs: the job is
 * server-owned and path-keyed, so the ordinary `restore_cancel` frame reaches
 * it and settles it `cancelled`, which fails the create here.
 *
 * `onStarted` is how the WebSocket caller tells ITS client which job to paint;
 * the HTTP caller has no progress channel and simply waits. Broadcasts reach
 * every client whose folder matches the path either way.
 */
async function cloneForNewSession(
  targetPath: string,
  clients: Map<string, WSClient>,
  pool: SessionPool,
  onStarted?: (outcome: 'started' | 'joined', job: RestoreJobSnapshot) => void,
): Promise<NewSessionCloneOutcome> {
  const config = getWhereverConfig();
  const rule = matchRemoteRepoRule(config.remoteRepoRules, targetPath);
  if (!rule) return { status: 'skipped' };
  // The SAME probe the dashboard's clone-or-create dialog asked (via
  // /check-remote-repo) before offering to clone. The URL is resolved HERE, on
  // the server, rather than taken from the client: the create path has no
  // editable URL field, so a client-supplied one would be a new, unasked-for
  // authority. (The restore panel's editable field is the deliberate exception,
  // and it is validated by the registry all the same.)
  //
  // Note what is NOT used: `resolveRemoteCandidates`, whose path-convention
  // candidate is a GUESS offered to a human who can edit it. There is no field
  // to edit here, so an unprobed guess would be cloned blind. A probe that finds
  // nothing SKIPS the clone and lets the ordinary create proceed, exactly as the
  // deleted synchronous path did.
  const probe = detectRemoteRepo(rule, path.basename(targetPath));
  if (!probe.exists || !probe.sshUrl) return { status: 'skipped' };

  // Subscribe BEFORE requesting: a request can settle inside the call (a spawn
  // that throws) and a frame emitted before the subscription exists is lost.
  observeRestorePath(targetPath, clients, pool);
  // No refetch callback here: this clone is followed by the session creation it
  // exists for, which broadcasts `sessions_updated` on its own.
  observeRestoreForFolderExistence(targetPath);
  const result = restoreJobs.request({ kind: 'clone', targetPath, url: probe.sshUrl });
  if (!result.ok) {
    // A refusal is not a job: nothing will ever settle here, so neither
    // subscription may be left waiting for a completion that is not coming.
    if (restoreJobs.get(targetPath)?.state !== 'running') {
      releaseRestoreObserver(targetPath);
      releaseFolderExistenceObserver(targetPath);
    }
    return { status: 'failed', error: result.message };
  }
  onStarted?.(result.outcome, result.job);

  const settled = await restoreJobs.settled(targetPath).catch(() => undefined);
  if (settled?.state === 'done') return { status: 'cloned' };
  if (settled?.state === 'cancelled') {
    return {
      status: 'failed',
      error: `The clone into ${targetPath} was cancelled, so no session was created.`,
    };
  }
  return {
    status: 'failed',
    error:
      settled?.failure?.message ??
      `Failed to clone ${probe.sshUrl} into ${targetPath}, so no session was created.`,
  };
}

// Resolve and report in one step. Every folder_conflict frame goes out through
// here, so the `readOnly` it carries can never drift from the authority that
// produced `active`.
function sendFolderConflict(client: WSClient, pool: SessionPool): void {
  const verdict = resolveFolderConflictState(client, pool);
  if (!verdict) return;
  sendWS(client.ws, {
    type: 'folder_conflict',
    cwd: verdict.cwd,
    active: verdict.active,
    readOnly: client.readOnly,
  });
}

function switchClientSession(client: WSClient, newSessionFile: string | null, pool: SessionPool, onSessionsUpdated?: () => void) {
  if (client.sessionId && client.sessionId !== newSessionFile) {
    pool.removeClient(client.sessionId, client.id);
  }
  client.sessionId = newSessionFile;
  // Detaching ends the pairing the conflict decision belonged to. (An ATTACH must
  // not clear it: a "Continue anyway" clicked during a cold load is recorded
  // before this call and has to survive it.)
  if (newSessionFile === null) {
    clearConflictState(client);
  }
  if (onSessionsUpdated) {
    onSessionsUpdated();
  }
}

// Send an attaching client the session's CURRENT steer queue, so a reload (or a
// second device) renders the messages pi has queued but not yet injected. The
// live `queue_update` event only fires when the queue CHANGES, and a queued
// message is not written to the session file until it is delivered, so without
// this snapshot a fresh client sees nothing queued while pi still holds (and
// will inject) the text. Sessions with no readable queue (CLI bridges) send
// nothing, leaving the client's state untouched.
function sendQueueSnapshot(
  client: WSClient,
  sessionFile: string,
  sessionId: string,
  pool: SessionPool,
): void {
  const steering = pool.getSteeringQueue(sessionFile);
  if (!steering) return;
  sendWS(client.ws, { type: 'queue_update', sessionId, steering });
}

async function handleWSMessage(
  msg: ClientMessage,
  client: WSClient,
  pool: SessionPool,
  clients: Map<string, WSClient>,
  broadcast: (sessionFile: string, message: ServerMessage, excludeId?: string) => void,
  onSessionsUpdated: () => void,
): Promise<void> {
  switch (msg.type) {
    case 'cli_register': {
      client.isCliBridge = true;
      client.sessionId = msg.sessionFile;
      const result = await pool.registerCliSession(msg.sessionFile, msg.cwd, msg.model || '', client.ws, msg.isStreaming === true);
      if (result.error) {
        sendWS(client.ws, { type: 'session_error', error: result.error });
      } else {
        console.log(`Registered CLI Bridge for session ${msg.sessionFile} at ${msg.cwd}`);
        onSessionsUpdated();
        const sId = result.tracked.sessionId;

        // The CLI just took over a session the server was running MID-TURN, so
        // registering disposed that server-side agent and discarded the in-flight
        // turn. Tell the CLI explicitly so it can surface the takeover: its own
        // dangling-tool-call heuristic reads the persisted transcript, which
        // never captured a still-streaming (unpersisted) turn, so it cannot
        // detect the streaming-text case on its own. Symmetric with the web
        // client's session_notice below.
        if (result.interruptedTurn) {
          sendWS(client.ws, {
            type: 'cli_takeover_interrupted',
            sessionId: sId,
            toolCall: result.interruptedToolCall === true,
          });
        }
        const msgToWeb: ServerMessage = {
          type: 'session_created',
          sessionId: sId,
          sessionFile: msg.sessionFile,
          cwd: msg.cwd,
          model: msg.model || '',
          isStreaming: pool.isStreaming(msg.sessionFile),
          // Include any context-usage the CLI bridge already reported (cached
          // from a prior turn) so a web viewer joining an idle CLI session gets
          // the "11.3% / 1.0M" indicator in the initial payload instead of a
          // blank until the next turn. undefined -> omitted -> client keeps null.
          contextUsage: pool.getContextUsage(msg.sessionFile) ?? null,
        };
        for (const c of clients.values()) {
          if (c.sessionId === msg.sessionFile && !c.isCliBridge) {
            sendWS(c.ws, msgToWeb);
            const history = await pool.getSessionHistoryWindow(msg.sessionFile, INITIAL_HISTORY_LIMIT);
            sendWS(c.ws, {
              type: 'message_history',
              sessionId: sId,
              messages: history.messages,
              totalCount: history.totalCount,
              offset: history.offset,
            });
            // The CLI took control of this session. If the server agent was
            // MID-TURN, disposing it above discarded that in-flight turn without
            // persisting it, so the web viewer who was watching it lost it
            // silently. Warn, tailoring the wording to what was lost: a running
            // tool call (its result never arrives) vs a streaming assistant
            // reply (the partial text is discarded).
            if (result.interruptedTurn) {
              const lost = result.interruptedToolCall
                ? 'a tool call was running. That tool call was interrupted and its result will not appear here.'
                : 'a reply was streaming. That in-progress reply was interrupted here and will not be saved.';
              const message =
                `A terminal (CLI) took over this session while ${lost} ` +
                'The CLI now controls this session: anything you send from here is relayed to it. ' +
                'The web frontend regains control only once that CLI disconnects.';
              sendWS(c.ws, {
                type: 'session_notice',
                sessionId: sId,
                level: 'warning',
                message,
              });
            }
          }
        }
      }
      break;
    }

    case 'cli_event': {
      if (!client.isCliBridge || !client.sessionId) return;
      pool.handleCliEvent(client.sessionId, msg.event);
      break;
    }

    case 'connect':
      break;

    case 'ping':
      sendWS(client.ws, { type: 'pong', timestamp: Date.now() });
      break;

    case 'session_load': {
      // FAST-FIRST session load (docs/plan-speed-up-long-session-load.md):
      // 1. Cheap read of header + history (no agent build). Paint the
      //    conversation immediately so opening a session to READ is instant even
      //    for a cold, idle-evicted session with huge files.
      // 2. Build the live agent (createAgentSession -> extension/MCP load, the
      //    seconds-long part) ASYNC, then signal session_ready so the composer
      //    enables. Sending needs the live agent; reading does not.
      // A new load is a new decision: any earlier "Continue anyway" belongs to the
      // session we are leaving. Reset BEFORE the first await, so a continue that
      // races this load is recorded against the load, never wiped by it.
      client.conflictContinued = false;
      // Same reasoning for the missing-folder lock: it belongs to the session we
      // are leaving, and must not leak into the one we are opening.
      client.folderMissingCwd = undefined;
      const meta = await pool.readSessionMeta(msg.sessionFile, INITIAL_HISTORY_LIMIT, msg.model);
      if ('error' in meta) {
        sendWS(client.ws, { type: 'session_error', error: meta.error });
        return;
      }

      // Folder conflict detection is cheap (in-memory pool scan). We no longer
      // block with a protection dialog: opening a session in a folder that
      // already has ANOTHER active session just surfaces a warning banner. The
      // client starts read-only (observing) until the user clicks "Continue
      // anyway" (folder_conflict_continue), which lifts read-only WITHOUT
      // aborting the other session -- both then run concurrently.
      const conflict = pool.detectConflict(meta.sessionFile, meta.cwd);
      const folderConflict = conflict.conflict && !!conflict.otherSessionId;

      // This session's working folder is not usable as a working folder. TWO
      // things produce that, and they are one state because they have one
      // remedy and one rendering:
      //  - it does NOT EXIST (the transcript synced, the clone did not), the
      //    cheap meta read's `stat`;
      //  - a RESTORE JOB is materialising it RIGHT NOW. `git clone` creates the
      //    target directory in its first breath, so the existence check alone
      //    says "present" for the whole of a multi-minute clone, and a client
      //    loading in that window (a reconnect, a second device) would be handed
      //    a live agent pointed at a HALF-CLONED tree. That is the same silent
      //    breakage this state exists to replace.
      // The conversation is still READABLE either way -- reading never needed the
      // folder -- but the client is locked and, on the cold path below, no live
      // agent is built at all.
      const restoreInFlight = restoreJobs.get(meta.cwd)?.state === 'running';
      const folderMissing = meta.folderMissing || restoreInFlight;
      client.folderMissingCwd = folderMissing ? meta.cwd : undefined;

      // A session whose cwd matches a sessions.readOnly glob is forced read-only.
      // A missing folder forces it too (hard, see hasHardReadOnly). A folder
      // conflict also starts the client read-only until they continue.
      const forcedReadOnly = meta.readOnly || folderMissing || folderConflict;
      client.readOnly = forcedReadOnly;
      client.conflictObserver = folderConflict;
      client.pendingCwd = meta.cwd;

      // Paint immediately. `pending` is true when the live agent is not resident
      // yet, so the client keeps the composer disabled (with a "preparing
      // agent..." hint) until session_ready, while reading/scrolling work now.
      sendWS(client.ws, {
        type: 'session_created',
        sessionId: meta.sessionId,
        sessionFile: meta.sessionFile,
        cwd: meta.cwd,
        model: meta.model,
        isStreaming: meta.resident ? pool.isStreaming(meta.sessionFile) : false,
        readOnly: forcedReadOnly,
        folderConflict,
        folderMissing,
        contextUsage: meta.resident ? (pool.getContextUsage(meta.sessionFile) ?? null) : null,
        pending: !meta.resident,
      });
      sendWS(client.ws, {
        type: 'message_history',
        sessionId: meta.sessionId,
        messages: meta.history.messages,
        totalCount: meta.history.totalCount,
        offset: meta.history.offset,
      });

      // State the missing folder explicitly, naming the absolute path, so the
      // client can replace its composer with a notice that says WHICH folder to
      // restore instead of an unexplained lock. A client that predates the frame
      // simply ignores it; the server's refusal to accept its sends is what
      // protects it either way.
      //
      // Any restore job already running for this folder rides along, so a client
      // arriving MID-CLONE (a reconnect, a second device, a phone waking up)
      // repaints the running job from this one frame instead of being offered a
      // second clone. Live frames follow on their own, because this client now
      // matches the job path (see clientWatchesRestorePath).
      if (folderMissing) {
        const job = restoreJobs.get(meta.cwd);
        sendWS(client.ws, {
          type: 'folder_missing',
          sessionId: meta.sessionId,
          cwd: meta.cwd,
          ...(job ? { job } : {}),
        });
      }

      // Already resident (warm): attach immediately, no async build needed.
      if (meta.resident) {
        pool.addClient(meta.sessionFile, client.id);
        switchClientSession(client, meta.sessionFile, pool, onSessionsUpdated);
        client.readOnly = forcedReadOnly;
        sendWS(client.ws, {
          type: 'session_ready',
          sessionId: meta.sessionId,
          sessionFile: meta.sessionFile,
          model: meta.model,
          isStreaming: pool.isStreaming(meta.sessionFile),
          contextUsage: pool.getContextUsage(meta.sessionFile) ?? null,
        });
        // Snapshot pi's pending steer queue for the attaching client. Attaching
        // mid-stream (a reload, a second device) otherwise shows nothing queued:
        // queue_update is a live-only event, and a queued message is not in the
        // session file until pi injects it at the next step. Without this the
        // user's queued text is invisible right up to the moment it is delivered.
        sendQueueSnapshot(client, meta.sessionFile, meta.sessionId, pool);
        break;
      }

      // Cold + folder missing: do NOT build the live agent. Building one would
      // SUCCEED (pi's settings/resource loading tolerate a nonexistent cwd) and
      // hand back an agent whose every tool call is broken -- the silent failure
      // this state exists to replace. So the load ends here: painted, locked,
      // explained. Curing it takes a restore plus a RELOAD, because whether a
      // session has a live agent is a load-time decision.
      //
      // Detach from whatever we were attached to before as well: this load never
      // attaches anywhere, and staying on the previous session would leave a
      // phantom viewer holding a folder the user has left.
      // (A RESIDENT session is handled by the branch above and keeps its running
      // agent: a folder that vanished under a live session is out of scope here,
      // we only refuse to hand out a fresh write capability.)
      if (folderMissing) {
        switchClientSession(client, null, pool, onSessionsUpdated);
        client.readOnly = true;
        break;
      }

      // Cold: build the live agent in the background, then attach + signal ready.
      // Errors degrade to a session_error (the conversation stays readable).
      void (async () => {
        const result = await pool.loadSession(msg.sessionFile, msg.cwd, msg.model);
        if (result.error) {
          sendWS(client.ws, { type: 'session_error', sessionId: meta.sessionId, error: result.error });
          return;
        }
        // The socket may have gone away while the agent was building.
        if (client.ws.readyState !== client.ws.OPEN) {
          // Nobody to attach; let idle eviction reclaim the freshly built session.
          pool.scheduleIdleCheck(result.tracked.sessionFile);
          return;
        }
        pool.addClient(result.tracked.sessionFile, client.id);
        switchClientSession(client, result.tracked.sessionFile, pool, onSessionsUpdated);
        // Re-derive read-only from the CURRENT decision rather than from
        // `forcedReadOnly` captured before the build: while the agent was building
        // the user may have clicked "Continue anyway" (conflictContinued), and
        // re-imposing the stale value re-locked them with no banner left to lift
        // it, while `message` dropped their sends in silence. The conflict having
        // RESOLVED during the build is handled just below by the verdict, which
        // re-scans and releases read-only.
        client.readOnly =
          meta.readOnly ||
          pool.isReadOnlyCwd(result.tracked.cwd) ||
          (client.conflictObserver === true && !client.conflictContinued);
        sendWS(client.ws, {
          type: 'session_ready',
          sessionId: result.tracked.sessionId,
          sessionFile: result.tracked.sessionFile,
          model: result.tracked.model,
          isStreaming: pool.isStreaming(result.tracked.sessionFile),
          contextUsage: pool.getContextUsage(result.tracked.sessionFile) ?? null,
        });
        // A cold build starts with an empty queue, but the session may have been
        // taken over by another client mid-build; send the authoritative snapshot
        // for the same reason as the warm path above.
        sendQueueSnapshot(client, result.tracked.sessionFile, result.tracked.sessionId, pool);
        // State may have moved during the build (the conflict resolved, or the
        // user continued through it). session_ready carries no readOnly, and the
        // periodic conflict broadcast is throttled, so state the verdict here
        // explicitly rather than leaving the composer to guess for up to 2s.
        sendFolderConflict(client, pool);
      })();
      break;
    }

    case 'history_load_more': {
      // Lazily fetch an older window of history for the client's active session.
      const targetFile = client.sessionId;
      if (!targetFile) return;
      const tracked = pool.getSession(targetFile);
      if (!tracked) return;
      const window = await pool.getSessionHistoryWindow(
        targetFile,
        HISTORY_PAGE_SIZE,
        msg.beforeOffset,
      );
      sendWS(client.ws, {
        type: 'message_history_prepend',
        sessionId: tracked.sessionId,
        messages: window.messages,
        offset: window.offset,
      });
      break;
    }

    case 'skills_request': {
      // Serve the skill commands for the requested session so the composer can
      // offer `/skill:<name>` autocomplete. Resolve against the client's own
      // attached session (authority) rather than trusting an arbitrary id.
      const targetFile = client.sessionId;
      if (!targetFile) return;
      const tracked = pool.getSession(targetFile);
      if (!tracked) return;
      sendWS(client.ws, {
        type: 'skills_list',
        sessionId: tracked.sessionId,
        skills: pool.getSkills(targetFile),
      });
      break;
    }

    case 'session_new': {
      // "New conversation here" ALWAYS produces a new conversation. We used to
      // hand an occupied folder's existing session back to the asker (read-only,
      // with the folder-conflict banner), because createNewSession refused to
      // create beside a live session. That answered a different question than the
      // one asked: the user landed in a conversation they did not ask for -- often
      // the very one they were already reading, since "another client" also covers
      // their own second tab or a not-yet-reaped dropped socket -- and the banner's
      // "Continue anyway" could only unlock THAT conversation, never give them the
      // fresh one. So: create the session (forceNew), then report the folder
      // conflict, if any, AGAINST the new session.
      //
      // CLONE-AN-EXISTING-REMOTE first, when that is what the user chose in the
      // clone-or-create dialog. It runs as a RESTORE JOB (one clone
      // implementation, `docs/adr/0009`): the client is told which job to paint
      // and then watches the ordinary `restore_progress` frames, instead of
      // staring at a blocking overlay its 25s create watchdog would give up on
      // while git was still running. Creating a REMOTE (the other branch of that
      // dialog) is untouched and still happens inside createNewSession.
      if (msg.cloneRemote) {
        const targetPath = resolveCreateCwd(msg.cwd);
        // The restore broadcast is DERIVED from a path match against each
        // client's folder, and this client has no session yet: recording the
        // target as its pending cwd is what puts it in scope for its own clone.
        client.pendingCwd = targetPath;
        const outcome = await cloneForNewSession(targetPath, clients, pool, (result, job) => {
          sendWS(client.ws, { type: 'restore_started', targetPath, outcome: result, job });
        });
        if (outcome.status === 'failed') {
          // The clone is the create's first step, so its failure IS the create's
          // failure: report it on the create's own channel (the mapped cause,
          // from the registry) and make no session. The restore_complete frame
          // carrying git's raw output was broadcast beside it.
          client.pendingCwd = undefined;
          sendWS(client.ws, { type: 'session_error', error: outcome.error });
          return;
        }
      }

      const result = await pool.createNewSession(msg.cwd, msg.model, msg.gitInit, msg.createRemote, msg.repoVisibility, true);
      if (result.error) {
        sendWS(client.ws, { type: 'session_error', error: result.error });
        return;
      }

      // Attaching also detaches us from whatever we were on (switchClientSession
      // -> removeClient), so the conversation we came from stops counting us.
      pool.addClient(result.tracked.sessionFile, client.id);
      switchClientSession(client, result.tracked.sessionFile, pool, onSessionsUpdated);
      clearConflictState(client);
      // Creating a session CREATES its folder (mkdir/clone), so this one exists
      // by construction: clear any missing-folder lock the previous session left.
      client.folderMissingCwd = undefined;
      client.pendingCwd = result.tracked.cwd;

      // Is somebody else still live in this folder? Then two agents would be
      // editing the same working tree, which is exactly what the folder-conflict
      // banner is for: the new session starts read-only (observing) until the user
      // clicks "Continue anyway", which lifts read-only WITHOUT touching the other
      // session. The difference from before is that the banner now sits on the
      // conversation they asked for, so continuing does what it says.
      const folderOccupied = folderHasOtherViewedSession(pool, result.tracked.sessionFile, result.tracked.cwd);
      client.readOnly = folderOccupied || pool.isReadOnlyCwd(result.tracked.cwd);
      client.conflictObserver = folderOccupied;

      sendWS(client.ws, {
        type: 'session_created',
        sessionId: result.tracked.sessionId,
        sessionFile: result.tracked.sessionFile,
        cwd: result.tracked.cwd,
        model: result.tracked.model,
        isStreaming: pool.isStreaming(result.tracked.sessionFile),
        readOnly: client.readOnly,
        folderConflict: folderOccupied,
      });

      sendWS(client.ws, {
        type: 'message_history',
        sessionId: result.tracked.sessionId,
        messages: [],
      });
      break;
    }

    case 'session_fork': {
      // Fork the given session at a specific user-message entry (pi's default
      // position:'before'). The server only CREATES the branched file here; the
      // client then loads it through the normal session_load path, reusing the
      // existing fast-first-load/attach machinery. This keeps forking a thin
      // "make a new file + tell me its path + pre-fill text" operation.
      const forked = await pool.forkSession(msg.sessionId, msg.entryId);
      if ('error' in forked) {
        sendWS(client.ws, { type: 'session_error', sessionId: msg.sessionId, error: forked.error });
        return;
      }
      sendWS(client.ws, {
        type: 'session_forked',
        sourceSessionId: msg.sessionId,
        sessionFile: forked.sessionFile,
        cwd: forked.cwd,
        prefillText: forked.prefillText,
      });
      // The fork produced a new session file on disk; refresh session lists so
      // the new node appears in the hierarchy for all clients.
      onSessionsUpdated();
      break;
    }

    case 'session_leave': {
      // The lock belongs to the session being left, so it goes with it. (A
      // folder-missing load never attaches, so `sessionId` can already be null
      // here and the flag must be cleared regardless.)
      client.folderMissingCwd = undefined;
      if (client.sessionId) {
        switchClientSession(client, null, pool, onSessionsUpdated);
        client.readOnly = false;
      }
      break;
    }

    case 'folder_conflict_continue': {
      // The user acknowledged the folder-conflict warning banner and chose to
      // "Continue anyway". Lift this client's read-only flag so it can send into
      // its (already-attached) session even though another session in the same
      // folder is active. We do NOT abort or take over the other session -- both
      // run concurrently from here on. Guard: never lift read-only for a session
      // whose cwd is a configured sessions.readOnly folder (that is a hard
      // observe-only rule, not a dismissible warning).
      // The cwd may come from an attached session or, during a cold load's agent
      // build, from the load in progress: the user can click Continue on the
      // painted-but-not-yet-attached conversation, and dropping that click left
      // them read-only with the button already gone.
      const tracked = client.sessionId ? pool.getSession(client.sessionId) : null;
      const cwd = tracked?.cwd ?? client.pendingCwd;
      // The client stamps the session it was looking at. If that resolves to a
      // DIFFERENT folder, the session changed under the click (a switch racing the
      // tap): honouring it would continue through a conflict the user never saw.
      // An unresolvable id means the target is not resident (the cold-load case
      // this continue exists for), which the cwd check covers.
      if (cwd && msg.sessionId) {
        const target = pool.getSession(msg.sessionId);
        if (target && target.cwd !== cwd) return;
      }
      // Durable intent: honoured at attach even if the click landed before this
      // client had a session to lift read-only on -- INCLUDING before the load it
      // belongs to has reported its cwd. A cold load reads the transcript from
      // disk, so it yields to the event loop before setting `pendingCwd`, and a
      // continue sent immediately after `session_load` is processed inside that
      // window. Dropping it there left the user read-only with the banner's
      // button already gone -- exactly the bug this intent exists to prevent.
      // The intent is scoped to this client and reset at the start of every
      // load/create, so it can only ever apply to the load in flight, and the
      // sessions.readOnly guard is re-applied at attach with the real cwd.
      client.conflictContinued = true;
      if (cwd && !hasHardReadOnly(client, pool, cwd)) client.readOnly = false;
      // Reply with this client's authoritative conflict state, ALWAYS (including
      // when the lift was refused for a sessions.readOnly folder). Same-socket
      // ordering guarantees this lands after any folder_conflict broadcast that
      // was already in flight when the continue was sent, so an in-flight update
      // carrying the pre-continue readOnly:true cannot leave the composer
      // disabled with the banner's button already gone.
      sendFolderConflict(client, pool);
      break;
    }

    case 'restore_start': {
      // RESTORE the working folder at `targetPath`: clone the repository back, or
      // create the folder. The job is server-owned and path-keyed, so this is a
      // request to the REGISTRY, not an operation on this socket.
      const raw = typeof msg.targetPath === 'string' ? msg.targetPath.trim() : '';
      if (!raw) {
        sendWS(client.ws, {
          type: 'restore_rejected',
          targetPath: '',
          reason: 'invalid-target',
          message: 'A target path is required.',
        });
        break;
      }
      // Resolve the same way the registry does, so the broadcast key, the frames
      // and the job all name ONE path.
      const targetPath = path.resolve(expandTilde(raw));
      // Subscribe first: a request can settle inside the call (a spawn that
      // throws), and a frame emitted before the subscription exists is lost.
      observeRestorePath(targetPath, clients, pool);
      observeRestoreForFolderExistence(targetPath, onSessionsUpdated);
      const request: RestoreRequest =
        msg.action === 'create'
          ? { kind: 'create', targetPath, gitInit: msg.gitInit === true }
          : { kind: 'clone', targetPath, url: typeof msg.url === 'string' ? msg.url.trim() : '' };
      const result = restoreJobs.request(request);
      if (!result.ok) {
        // Nothing was spawned or created, so there is no job to observe and no
        // completion coming. Say why, to the requester only, and let go of the
        // subscriptions we optimistically took.
        if (restoreJobs.get(targetPath)?.state !== 'running') {
          releaseRestoreObserver(targetPath);
          releaseFolderExistenceObserver(targetPath);
        }
        sendWS(client.ws, {
          type: 'restore_rejected',
          targetPath,
          reason: result.reason,
          message: result.message,
        });
        break;
      }
      // `outcome` and `job.url` together are what stop a second device from being
      // silently answered as though ITS edited url had been accepted.
      sendWS(client.ws, {
        type: 'restore_started',
        targetPath,
        outcome: result.outcome,
        job: result.job,
      });
      if (result.job.state !== 'running') {
        // Settled inside request() (a spawn failure), so no observer will ever
        // report it: state the outcome here instead of leaving the panel spinning.
        releaseRestoreObserver(targetPath);
        broadcastRestore(clients, pool, targetPath, {
          type: 'restore_complete',
          targetPath,
          job: result.job,
        });
      }
      break;
    }

    case 'restore_cancel': {
      const raw = typeof msg.targetPath === 'string' ? msg.targetPath.trim() : '';
      if (!raw) break;
      const targetPath = path.resolve(expandTilde(raw));
      // The job is path-keyed and server-owned, so any client watching the folder
      // may cancel it -- including one that did not start it, which is the whole
      // point when the device that did is the one that went away. The registry
      // settles the job (authoritatively) and the observer broadcasts the
      // `cancelled` completion to everyone watching, so nothing is answered here.
      if (restoreJobs.cancel(targetPath)) break;
      // Nothing was running: re-state the current (retained) job to the asker so a
      // stale panel converges instead of waiting for a completion that already
      // happened.
      const job = restoreJobs.get(targetPath);
      if (job) sendWS(client.ws, { type: 'restore_complete', targetPath, job });
      break;
    }

    case 'message': {
      // The session's working folder does not exist on this machine, so no live
      // agent was built for it and there is nothing to attach to (which would
      // otherwise make this a SILENT drop on the sessionId check below). Refuse
      // by path, naming it, so the client can say what to restore.
      if (client.folderMissingCwd) {
        // Word it for the state the folder is actually in: a restore already
        // running is a wait, not a "go and restore it".
        const restoring = restoreJobs.get(client.folderMissingCwd)?.state === 'running';
        sendWS(client.ws, {
          type: 'session_error',
          sessionId: msg.sessionId,
          error: restoring
            ? `This session's working folder (${client.folderMissingCwd}) is still being restored, ` +
              'so the message was not delivered. Wait for the restore to finish, then reload the session.'
            : `This session's working folder does not exist on this machine (${client.folderMissingCwd}), ` +
              'so the message was not delivered. Restore the folder, then reload the session.',
        });
        return;
      }
      if (!client.sessionId) return;
      if (client.readOnly) {
        // Never swallow a send. This is a legitimate refusal for an observe-only
        // session (a sessions.readOnly folder, or a folder conflict not continued
        // through), but the client only hides its composer when it AGREES it is
        // read-only -- so any future desync of that agreement used to show up as
        // text vanishing into the void. Answering makes it a visible, retryable
        // failure instead (the client surfaces session_error with a Retry).
        sendWS(client.ws, {
          type: 'session_error',
          sessionId: msg.sessionId,
          error: 'This session is read-only from here, so the message was not delivered. Use "Continue anyway" on the folder-conflict banner, or open the session that owns this folder.',
        });
        return;
      }
      // The client stamps every send with the sessionId of the session it is
      // actually viewing. Treat that as AUTHORITATIVE: if it does not resolve to
      // the same tracked session this connection is attached to, REFUSE rather
      // than delivering to the wrong agent. This closes a switch/reconnect/resync
      // race where client.sessionId (per-connection, set only when a load
      // attaches) is stale relative to the session the client painted and
      // targeted, which silently misrouted a message into another session's
      // agent. The client surfaces session_error as a recoverable, retryable
      // failure (delivery watchdog + Retry), so no text is lost.
      const attached = pool.getSession(client.sessionId);
      const target = msg.sessionId ? pool.getSession(msg.sessionId) : attached;
      if (!attached || !target || target !== attached) {
        sendWS(client.ws, {
          type: 'session_error',
          sessionId: msg.sessionId,
          error: 'This message was not delivered because the session changed. Re-open the session and resend.',
        });
        break;
      }
      const streaming = pool.isStreaming(client.sessionId);
      // The optional conversationMode field is the per-turn spoken-conversation
      // signal (absent = off). It only decides whether a hint is appended to this
      // turn's system prompt; the message text itself is delivered verbatim.
      await pool.sendUserMessage(
        client.sessionId,
        msg.message,
        streaming ? 'steer' : undefined,
        msg.conversationMode === true,
      );
      // Acknowledge delivery the moment the message is accepted by the agent.
      // For a mid-stream steer, pi only echoes the user message back
      // (message_end role:user) at the NEXT model call, which can be far beyond
      // the client's confirmation window; without this ack the client would
      // wrongly flip an accepted steer to "failed / Retry". `!command` bash is
      // not a delivery-tracked user message on the client, so skip the ack for
      // it (its tool_start/tool_end frames are the real feedback).
      if (!msg.message.trimStart().startsWith('!')) {
        // Identify the session to the client by its UUID (sessionId), matching
        // every other server->client frame; client.sessionId is the sessionFile
        // path, which the client does not key on.
        sendWS(client.ws, {
          type: 'message_ack',
          sessionId: attached.sessionId,
          content: msg.message,
        });
      }
      break;
    }

    case 'abort': {
      if (!client.sessionId) return;
      // Same authority guard as 'message': never abort a session other than the
      // one the client is actually looking at. A stale client.sessionId must not
      // silently interrupt a different session's running turn.
      const attached = pool.getSession(client.sessionId);
      const target = msg.sessionId ? pool.getSession(msg.sessionId) : attached;
      if (!attached || !target || target !== attached) break;
      await pool.abortSession(client.sessionId);
      break;
    }

    case 'cancel_steer': {
      if (!client.sessionId) return;
      if (client.readOnly) return;
      // Same authority guard as 'message'/'abort': only touch the queue of the
      // session this connection is actually attached to and looking at.
      const attached = pool.getSession(client.sessionId);
      const target = msg.sessionId ? pool.getSession(msg.sessionId) : attached;
      if (!attached || !target || target !== attached) break;
      await pool.cancelSteerQueue(client.sessionId);
      break;
    }

    case 'bash_sudo_password': {
      if (!client.sessionId) return;
      if (client.readOnly) return;
      // Same authority guard as 'message': the password (and the command it
      // unlocks) must only ever run against the session this connection is
      // actually attached to and looking at.
      const attached = pool.getSession(client.sessionId);
      const target = msg.sessionId ? pool.getSession(msg.sessionId) : attached;
      if (!attached || !target || target !== attached) break;
      await pool.submitSudoPassword(msg.promptId, msg.password);
      break;
    }

    case 'bash_sudo_cancel': {
      if (!client.sessionId) return;
      pool.cancelSudoPrompt(msg.promptId);
      break;
    }

    case 'model_change': {
      if (!client.sessionId) return;
      const result = await pool.changeModel(client.sessionId, msg.model);
      if (result.error) {
        sendWS(client.ws, { type: 'session_error', error: result.error });
      } else {
        const tracked = pool.getSession(client.sessionId);
        const sId = tracked?.sessionId || '';
        const modelChangedMsg: ServerMessage = { type: 'model_changed', sessionId: sId, model: msg.model };
        for (const c of clients.values()) {
          if (c.sessionId === client.sessionId) {
            sendWS(c.ws, modelChangedMsg);
          }
        }
      }
      break;
    }

    case 'file_upload': {
      const { uploadId, sessionId, filename, data } = msg as any;
      if (!uploadId || !sessionId || !filename || !data) {
        sendWS(client.ws, {
          type: 'file_upload_error',
          uploadId: uploadId || '',
          sessionId: sessionId || '',
          error: 'Missing parameters for file upload'
        });
        break;
      }

      try {
        const tracked = pool.getSession(sessionId);
        const cwd = tracked?.cwd;

        const config = getWhereverConfig();
        const targetDir = resolveUploadDir(config, cwd);

        fs.mkdirSync(targetDir, { recursive: true });

        const timestamp = Date.now();
        const safeFilename = `${timestamp}_${path.basename(filename)}`;
        const destPath = path.join(targetDir, safeFilename);

        const fileBuffer = Buffer.from(data, 'base64');
        fs.writeFileSync(destPath, fileBuffer);

        sendWS(client.ws, {
          type: 'file_uploaded',
          uploadId,
          sessionId,
          filename,
          savedPath: destPath
        });
      } catch (err) {
        sendWS(client.ws, {
          type: 'file_upload_error',
          uploadId,
          sessionId,
          error: (err as Error).message || 'Failed to save file'
        });
      }
      break;
    }
  }
}

/**
 * Extract image blocks from a tool result so the web frontend can render them
 * inline (mirroring the CLI's inline image display). The `read` tool returns
 * `{ content: [{type:'text',...},{type:'image', data, mimeType}] }` for image
 * files; `extractToolResult` keeps only text, so image blocks are pulled out
 * here and shipped separately as base64.
 */
function extractToolImages(event: any): ToolImage[] {
  const result = event?.result;
  if (!result || typeof result !== 'object') return [];
  const content = (result as any).content;
  if (!Array.isArray(content)) return [];
  const images: ToolImage[] = [];
  for (const c of content) {
    if (c && c.type === 'image' && typeof c.data === 'string' && c.data) {
      images.push({ mimeType: typeof c.mimeType === 'string' ? c.mimeType : 'image/png', data: c.data });
    }
  }
  return images;
}

function extractToolResult(event: any): string {
  const result = event.result;
  if (!result) return '';
  if (typeof result === 'string') return result;
  if (typeof result === 'object') {
    if (result.content) {
      if (typeof result.content === 'string') return result.content;
      if (Array.isArray(result.content)) {
        return result.content
          .filter((c: any) => c.type === 'text')
          .map((c: any) => c.text || '')
          .join('\n');
      }
    }
    return JSON.stringify(result, null, 2);
  }
  return String(result);
}

function extractText(msg: any): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content
      .filter((c: any) => c.type === 'text')
      .map((c: any) => c.text || '')
      .join('\n');
  }
  return '';
}

/**
 * Resolve this package's version from its package.json, which sits next to the
 * compiled entrypoint (`dist/index.js` -> `../package.json`). Read at runtime so
 * it stays correct for the installed package regardless of how it was launched
 * (npm, Volta shim, absolute service path). Falls back to 'unknown' if the file
 * cannot be read.
 */
function getVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Subcommand dispatch. Every action is an explicit verb:
 *   - `wherever start [server flags]` runs the server
 *   - `wherever install|uninstall|service-status` manage the background service
 *   - `wherever --version` (or `-v` / `version`) prints the version
 *   - bare `wherever` (or `help`) prints usage
 * Server flags after `start` are consumed by parseArgs() (which reads
 * process.argv), so `start` is stripped from argv before main() runs.
 */
function dispatch(): void {
  const argv = process.argv.slice(2);
  const verb = argv[0];
  const rest = argv.slice(1);

  switch (verb) {
    case 'start':
      // Drop the `start` verb so the existing flag parser sees only server
      // flags (it reads process.argv directly).
      process.argv.splice(2, 1);
      main().catch((err) => {
        console.error('Fatal server startup error:', err);
        process.exit(1);
      });
      return;
    case 'install':
      runInstall(parseInstallOptions(rest));
      return;
    case 'uninstall':
      runUninstall(parseInstallOptions(rest));
      return;
    case 'service-status':
    case 'status':
      runServiceStatus(parseInstallOptions(rest));
      return;
    case 'version':
    case '--version':
    case '-v':
      console.log(getVersion());
      return;
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printInstallHelp();
      return;
    default:
      console.error(`Unknown command: ${verb}\n`);
      printInstallHelp();
      process.exit(1);
  }
}

dispatch();
