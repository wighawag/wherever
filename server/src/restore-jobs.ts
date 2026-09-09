// Restore jobs: the server-side engine that materialises a MISSING working
// folder, either by CLONING a remote or by CREATING an empty folder.
//
// A session's transcript and the folder it refers to travel separately, so a
// synced transcript routinely names a clone that does not exist on this machine.
// Curing that is a RESTORE, and a restore runs as a JOB owned by this server and
// keyed by the resolved absolute TARGET PATH, never by the requesting socket,
// client or session (`docs/adr/0009`). Path-keying is what buys the three
// properties that make the feature usable at all on a phone: the clone SURVIVES
// a dropped socket or a locked screen, a reconnecting or second device
// re-attaches to the RUNNING job, and a second request for the same folder
// COALESCES instead of racing a competing clone into the same directory.
//
// This module is deliberately standalone: it knows nothing about WebSockets,
// sessions or the session pool. It has two independent consumers coming (a
// progress/completion broadcast to matching clients, and a per-folder existence
// cache invalidation), so it OWNS the observation seam rather than letting
// either consumer reach into its internals or be wired through the other.
//
// Transport is SSH ONLY (`docs/adr/0010`). There is no HTTPS fallback, no token
// and no credential setup: the box is assumed provisioned. That is exactly why
// `mapCloneFailure` below is a DELIVERABLE and not polish, and why the clone
// runs with every interactive prompt disabled: on an unprovisioned box the only
// remedy this feature can offer is NAMING precisely which one-line fix is
// missing, and it can only do that if git fails FAST instead of hanging
// invisibly at zero percent behind a prompt nobody can see.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn, execFileSync, type ChildProcess, type SpawnOptions } from 'node:child_process';

/** Materialise by cloning a remote, or by creating an empty folder. */
export type RestoreJobKind = 'clone' | 'create';

/** `running` is the only non-terminal state. */
export type RestoreJobState = 'running' | 'done' | 'failed' | 'cancelled';

/**
 * The phase a job is in. `starting` covers "git has begun on this scope but has
 * reported nothing measurable yet"; every other value is one of git's own
 * progress lines (or, for the create kind, the mkdir/init steps).
 */
export type RestorePhase =
  | 'starting'
  | 'enumerating'
  | 'counting'
  | 'compressing'
  | 'receiving'
  | 'resolving'
  | 'checking-out'
  | 'filtering'
  | 'creating'
  | 'initialising';

/**
 * The scope of the top-level repository. Submodules report under their own path
 * (relative to the target) instead, because folding them into one number would
 * be a fake global percentage: git restarts counting per submodule and nothing
 * knows how many objects the remaining ones hold.
 */
export const REPOSITORY_SCOPE = 'repository';

export interface RestoreProgress {
  phase: RestorePhase;
  /** `REPOSITORY_SCOPE`, or a submodule path relative to the target. */
  scope: string;
  /** 0..100, or null when git reports no percentage for this phase. */
  percent: number | null;
  /** Explicitly true exactly when `percent` is null. Honesty, not a fallback. */
  indeterminate: boolean;
  /** The git line this was parsed from, for a detail line in the UI. */
  text: string;
  /** Epoch ms. */
  at: number;
}

/**
 * The named causes. Every one of them is a DIFFERENT one-line fix on the box, so
 * they are reported separately; `unknown` is surfaced verbatim rather than
 * reworded into a guess.
 */
export type RestoreFailureCause = 'no-key' | 'unknown-host' | 'not-found' | 'network' | 'unknown';

export interface RestoreFailure {
  cause: RestoreFailureCause;
  /** Actionable, human-readable. Names the missing credential, never fixes it. */
  message: string;
  /** git's raw stderr, kept underneath the mapping and never replaced by it. */
  stderr: string;
}

/** A plain-data view of a job. Safe to serialise straight onto the wire. */
export interface RestoreJobSnapshot {
  /** Monotonic within a registry, so a client can tell a retry from the job it replaced. */
  id: number;
  kind: RestoreJobKind;
  /** Resolved absolute path. This is also the registry key. */
  targetPath: string;
  /** The URL this job is ACTUALLY cloning (clone kind only). */
  url?: string;
  gitInit?: boolean;
  state: RestoreJobState;
  /** Latest parsed progress, or null before the first one. */
  progress: RestoreProgress | null;
  failure?: RestoreFailure;
  startedAt: number;
  endedAt?: number;
}

export type RestoreRejectionReason = 'outside-home' | 'invalid-target' | 'target-not-empty' | 'invalid-url';

export type RestoreRequestResult =
  | {
      ok: true;
      /**
       * `joined` means a job for this path was ALREADY running and this request
       * coalesced onto it. The caller must compare `job.url` with what it asked
       * for: a joiner whose edited URL differs has to be told a clone of the
       * OTHER url is in flight, never silently answered as though its own was
       * accepted.
       */
      outcome: 'started' | 'joined';
      job: RestoreJobSnapshot;
    }
  | { ok: false; reason: RestoreRejectionReason; message: string };

export interface RestoreJobObserver {
  onProgress?(progress: RestoreProgress, job: RestoreJobSnapshot): void;
  onSettled?(job: RestoreJobSnapshot): void;
}

export interface RestoreCloneRequest {
  kind: 'clone';
  targetPath: string;
  url: string;
}

export interface RestoreCreateRequest {
  kind: 'create';
  targetPath: string;
  gitInit?: boolean;
}

export type RestoreRequest = RestoreCloneRequest | RestoreCreateRequest;

/** The spawn seam, so a test can count processes without a test-only API. */
export type SpawnGit = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface RestoreJobRegistryOptions {
  /**
   * How long a TERMINAL job is retained before being reaped. A phone that
   * reconnects after the clone finished still has to learn the outcome, so a job
   * cannot vanish the instant it ends.
   */
  retainMs?: number;
  /** Minimum ms between emitted progress frames (a phase or scope change always emits). */
  progressIntervalMs?: number;
  spawn?: SpawnGit;
}

const DEFAULT_RETAIN_MS = 60_000;
/** ~5 frames per second: enough to look alive, far below git's frame rate. */
const DEFAULT_PROGRESS_INTERVAL_MS = 200;
/** Cap on retained stderr. Git failure output is short; a runaway remote is not. */
const MAX_STDERR_CHARS = 16_000;
/** Grace before SIGKILL when a cancelled child ignores SIGTERM. */
const KILL_GRACE_MS = 2_000;

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/**
 * True iff `p` resolves to the home directory or somewhere beneath it.
 *
 * This mirrors `isWithinHome()` in `index.ts` (the HTTP layer's guard on
 * /check-path and /autocomplete-path) rather than importing it, because
 * `index.ts` is the CLI entry point and DISPATCHES on import: importing it from
 * a library module would run the server. The later wiring task should collapse
 * the two onto this one, since this module is the importable side.
 *
 * `os.homedir()` is read on every call, not captured at module load, so the home
 * a test points `HOME` at is the home the guard enforces.
 */
export function isWithinHome(p: string): boolean {
  const home = path.resolve(os.homedir());
  const normalized = path.resolve(p);
  return normalized === home || normalized.startsWith(home + path.sep);
}

/**
 * Shape allowlist for a clone URL. SSH only (ADR 0010), plus `file://` so tests
 * and fixtures need no network, no key and no provider CLI.
 *
 * This is an ALLOWLIST rather than a metacharacter denylist on purpose: the
 * command-injection fix in the remote-repo provisioning path already forced every
 * git/provider call onto an argv array with no shell, and this is the second
 * layer. A denylist would be the thing that has to be exhaustive; an allowlist
 * only has to be right about what git URLs look like. It also excludes git's own
 * dangerous transports (`ext::`, `--upload-pack=`), which no argv array protects
 * against.
 */
const SCP_SSH_URL = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._~/-]+$/;
const SSH_URL = /^ssh:\/\/(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9.-]+(?::\d{1,5})?\/[A-Za-z0-9._~/-]+$/;
const FILE_URL = /^file:\/\/\/[A-Za-z0-9._~/+-]+$/;

export function isAllowedCloneUrl(url: string): boolean {
  if (!url || url.length > 2048) return false;
  // Control characters and newlines never appear in a real URL, and a leading
  // dash would let the URL be read as an option however it is passed.
  if (/[\u0000-\u001f\u007f]/.test(url)) return false;
  if (url.startsWith('-')) return false;
  return SCP_SSH_URL.test(url) || SSH_URL.test(url) || FILE_URL.test(url);
}

// ---------------------------------------------------------------------------
// The git invocation
// ---------------------------------------------------------------------------

/**
 * The clone argv. An ARRAY, never a shell string, and `--` before the operands
 * so neither the URL nor the path can be read as an option.
 *
 * It carries NO `-c protocol.file.allow=...`: file-transport submodules are
 * blocked by git since 2.38 (CVE-2022-39253) and that protection must never be
 * relaxed for a real clone. The test fixtures need the relaxation, and they get
 * it from their own process ENVIRONMENT (`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_0`),
 * which is why it must not live here.
 */
export function buildCloneArgs(url: string, targetPath: string): string[] {
  return ['clone', '--progress', '--recurse-submodules', '--', url, targetPath];
}

/**
 * The clone environment: every interactive prompt disabled, so a box missing a
 * key, a known-hosts entry or a network route FAILS instead of hanging at zero
 * percent behind an invisible prompt (ADR 0010). `ConnectTimeout` bounds the one
 * case batch mode cannot: a host that accepts the TCP connection and then says
 * nothing.
 *
 * The surrounding environment is INHERITED (a user's ssh config, agent socket
 * and `GIT_SSH_COMMAND` are all legitimate and load-bearing on a real box); only
 * the interactive levers are overridden.
 */
export function buildCloneEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  env.GIT_TERMINAL_PROMPT = '0';
  delete env.GIT_ASKPASS;
  delete env.SSH_ASKPASS;
  // ssh only reaches for a GUI askpass when it has a DISPLAY to draw on.
  delete env.DISPLAY;
  env.SSH_ASKPASS_REQUIRE = 'never';
  const batch = '-o BatchMode=yes -o ConnectTimeout=10';
  env.GIT_SSH_COMMAND = base.GIT_SSH_COMMAND ? `${base.GIT_SSH_COMMAND} ${batch}` : `ssh ${batch}`;
  return env;
}

/**
 * Map git's well-known failure signatures onto a named, actionable cause while
 * keeping the raw stderr underneath.
 *
 * On an SSH-only, no-credential-setup design this IS the remedy: the product's
 * job is to say precisely which one-line fix the box needs, not to perform it.
 * An unrecognised failure is passed through verbatim rather than reworded, since
 * a wrong guess costs more than raw git output.
 */
export function mapCloneFailure(stderr: string, url: string): RestoreFailure {
  const host = extractHost(url) ?? 'the host';
  const text = stderr || '';

  if (/Host key verification failed|authenticity of host|No .* host key is known|known_hosts/i.test(text)) {
    return {
      cause: 'unknown-host',
      message: `${host} is not in this machine's known_hosts, so SSH refused to connect. Connect once by hand on the server (ssh -T git@${host}) to record its host key, then retry.`,
      stderr,
    };
  }
  // Note what is NOT matched here: git's trailer "Please make sure you have the
  // correct access rights and the repository exists" is printed for a missing
  // key AND for a missing repository, so keying on it would report every
  // wrong-URL clone as a credentials problem. The signature that really means
  // "no key this host accepts" is ssh's own permission-denied line.
  if (/Permission denied \(publickey|Permission denied, please try again|no matching host key|sign_and_send_pubkey/i.test(text)) {
    return {
      cause: 'no-key',
      message: `No SSH key on this machine is accepted by ${host}. Add this machine's public key to your ${host} account, or load the right key into its ssh-agent. Wherever never sets credentials up for you.`,
      stderr,
    };
  }
  if (
    /Repository not found|remote: Not Found|does not appear to be a git repository|repository '[^']*' (?:does not exist|not found)|The requested repository does not exist/i.test(
      text,
    )
  ) {
    return {
      cause: 'not-found',
      message: `Repository not found: ${url}. Either the URL is wrong, or this machine's key has no access to it. From here the two are indistinguishable, so check both.`,
      stderr,
    };
  }
  if (/Could not resolve hostname|Connection timed out|Network is unreachable|Connection refused|Temporary failure in name resolution|Operation timed out|No route to host/i.test(text)) {
    return {
      cause: 'network',
      message: `Could not reach ${host}. This is a network problem, not a credentials one: check connectivity on the server and retry.`,
      stderr,
    };
  }
  return { cause: 'unknown', message: lastMeaningfulLine(text) || 'git clone failed', stderr };
}

/** The host part of an SSH URL, for naming it in a failure message. */
export function extractHost(url: string): string | undefined {
  if (url.startsWith('file://')) return undefined;
  if (url.startsWith('ssh://')) {
    try {
      return new URL(url).hostname || undefined;
    } catch {
      return undefined;
    }
  }
  const scp = /^(?:[^@\s]+@)?([^@:\s/]+):/.exec(url);
  return scp?.[1];
}

function lastMeaningfulLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

// ---------------------------------------------------------------------------
// Progress parsing
// ---------------------------------------------------------------------------

const PHASE_PATTERNS: Array<[RegExp, RestorePhase]> = [
  [/^Enumerating objects:/, 'enumerating'],
  [/^Counting objects:/, 'counting'],
  [/^Compressing objects:/, 'compressing'],
  [/^Receiving objects:/, 'receiving'],
  [/^Resolving deltas:/, 'resolving'],
  [/^(?:Updating files|Checking out files):/, 'checking-out'],
  [/^Filtering content:/, 'filtering'],
];

/**
 * Turns raw `git clone --progress` output into progress frames.
 *
 * The load-bearing detail: git REWRITES one line in place, emitting frames
 * separated by CARRIAGE RETURNS inside a single newline-terminated chunk. A
 * newline-only parser therefore sees almost nothing during the receiving phase,
 * which is exactly the phase a long clone spends its time in. So `\r` is a frame
 * separator here, on equal footing with `\n`.
 *
 * The parser is also what keeps submodules honestly scoped: git announces each
 * one with its own `Cloning into '<abs path>'...`, so the scope switches to that
 * submodule's path and its percentages are never mixed into the parent's.
 */
export class GitProgressParser {
  private buffer = '';
  private scope: string = REPOSITORY_SCOPE;
  private readonly target: string;

  constructor(targetPath: string) {
    this.target = path.resolve(targetPath);
  }

  /**
   * Feed a chunk; get back the frames it completed. A trailing partial frame is
   * BUFFERED rather than reported, so a half-read line can never be published as
   * a wrong percentage.
   */
  push(chunk: string): RestoreProgress[] {
    this.buffer += chunk;
    const parts = this.buffer.split(/\r\n|[\r\n]/);
    this.buffer = parts.pop() ?? '';
    const out: RestoreProgress[] = [];
    for (const part of parts) {
      const frame = this.parseLine(part);
      if (frame) out.push(frame);
    }
    return out;
  }

  private parseLine(raw: string): RestoreProgress | null {
    const line = raw.replace(/^remote:\s*/, '').trim();
    if (!line) return null;

    const cloningInto = /^Cloning into '(.+)'\.\.\.$/.exec(line);
    if (cloningInto) {
      this.scope = this.scopeFor(cloningInto[1]);
      return this.frame('starting', null, line);
    }

    for (const [pattern, phase] of PHASE_PATTERNS) {
      if (!pattern.test(line)) continue;
      const pct = /(\d{1,3})%/.exec(line);
      const percent = pct ? Math.min(100, parseInt(pct[1], 10)) : null;
      return this.frame(phase, percent, line);
    }
    return null;
  }

  private scopeFor(clonePath: string): string {
    const resolved = path.resolve(clonePath);
    if (resolved === this.target) return REPOSITORY_SCOPE;
    const relative = path.relative(this.target, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return path.basename(resolved);
    }
    return relative;
  }

  private frame(phase: RestorePhase, percent: number | null, text: string): RestoreProgress {
    return { phase, scope: this.scope, percent, indeterminate: percent === null, text, at: Date.now() };
  }
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

interface InternalJob {
  id: number;
  kind: RestoreJobKind;
  targetPath: string;
  url?: string;
  gitInit?: boolean;
  state: RestoreJobState;
  progress: RestoreProgress | null;
  failure?: RestoreFailure;
  startedAt: number;
  endedAt?: number;
  /** Only a directory this job created may be removed on cancel. */
  createdTarget: boolean;
  child?: ChildProcess;
  cancelRequested: boolean;
  stderr: string;
  lastEmitAt: number;
  killTimer?: ReturnType<typeof setTimeout>;
  reapTimer?: ReturnType<typeof setTimeout>;
  settled: Promise<RestoreJobSnapshot>;
  resolveSettled: (snapshot: RestoreJobSnapshot) => void;
}

/**
 * The path-keyed registry. One job per target path at a time; a second request
 * for a running path coalesces onto it.
 */
export class RestoreJobRegistry {
  private readonly jobs = new Map<string, InternalJob>();
  private readonly observers = new Map<string, Set<RestoreJobObserver>>();
  private readonly retainMs: number;
  private readonly progressIntervalMs: number;
  private readonly spawnFn: SpawnGit;
  private nextId = 1;

  constructor(options: RestoreJobRegistryOptions = {}) {
    this.retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
    this.progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    this.spawnFn = options.spawn ?? ((cmd, args, opts) => nodeSpawn(cmd, args, opts));
  }

  /**
   * Start a restore job for a path, or JOIN the one already running there.
   *
   * Every refusal happens here, before anything is spawned or created, so an
   * unsafe request never has a partial effect.
   */
  request(request: RestoreRequest): RestoreRequestResult {
    const raw = request.targetPath;
    if (typeof raw !== 'string' || !raw.trim()) {
      return { ok: false, reason: 'invalid-target', message: 'A target path is required.' };
    }
    const targetPath = path.resolve(expandTilde(raw.trim()));
    if (!isWithinHome(targetPath)) {
      return {
        ok: false,
        reason: 'outside-home',
        message: `Refusing to restore ${targetPath}: a restore target must be inside the home directory.`,
      };
    }

    const existing = this.jobs.get(targetPath);
    if (existing && existing.state === 'running') {
      return { ok: true, outcome: 'joined', job: snapshot(existing) };
    }

    if (request.kind === 'clone' && !isAllowedCloneUrl(request.url)) {
      return {
        ok: false,
        reason: 'invalid-url',
        message: `Refusing to clone ${JSON.stringify(request.url)}: not a recognised SSH repository URL (git@host:owner/repo.git or ssh://host/path).`,
      };
    }

    let targetExists = false;
    try {
      const stat = fs.statSync(targetPath);
      if (!stat.isDirectory()) {
        return { ok: false, reason: 'target-not-empty', message: `${targetPath} exists and is not a directory.` };
      }
      if (fs.readdirSync(targetPath).length > 0) {
        return { ok: false, reason: 'target-not-empty', message: `${targetPath} already exists and is not empty.` };
      }
      targetExists = true;
    } catch (err: any) {
      if (err?.code !== 'ENOENT') {
        return { ok: false, reason: 'invalid-target', message: `Cannot inspect ${targetPath}: ${err?.message || err}` };
      }
    }

    const job = this.createJob(request, targetPath, !targetExists);
    this.jobs.set(targetPath, job);
    if (request.kind === 'clone') this.runClone(job);
    else this.runCreate(job);
    return { ok: true, outcome: 'started', job: snapshot(job) };
  }

  /** The job at `targetPath`, running or briefly-retained terminal, if any. */
  get(targetPath: string): RestoreJobSnapshot | undefined {
    const job = this.jobs.get(path.resolve(expandTilde(targetPath)));
    return job ? snapshot(job) : undefined;
  }

  list(): RestoreJobSnapshot[] {
    return [...this.jobs.values()].map(snapshot);
  }

  /**
   * Observe a path: progress frames plus the terminal outcome.
   *
   * Subscription is keyed by PATH and independent of any particular job, so a
   * consumer may attach before a job starts and stays attached across a retry.
   * Returns the unsubscribe function.
   */
  subscribe(targetPath: string, observer: RestoreJobObserver): () => void {
    const key = path.resolve(expandTilde(targetPath));
    let set = this.observers.get(key);
    if (!set) {
      set = new Set();
      this.observers.set(key, set);
    }
    set.add(observer);
    return () => {
      const current = this.observers.get(key);
      if (!current) return;
      current.delete(observer);
      if (current.size === 0) this.observers.delete(key);
    };
  }

  /** Resolves with the terminal snapshot of the job at `targetPath`. */
  settled(targetPath: string): Promise<RestoreJobSnapshot> {
    const key = path.resolve(expandTilde(targetPath));
    const job = this.jobs.get(key);
    if (!job) return Promise.reject(new Error(`No restore job for ${key}`));
    return job.settled;
  }

  /**
   * Cancel the job at `targetPath`. Returns false when there is nothing running.
   *
   * Cancellation is AUTHORITATIVE: the job settles as `cancelled` even if the
   * child happened to finish in the same breath, because the user asked for the
   * folder not to be there. A directory this job CREATED is removed; one that
   * already existed is never touched.
   */
  cancel(targetPath: string): boolean {
    const key = path.resolve(expandTilde(targetPath));
    const job = this.jobs.get(key);
    if (!job || job.state !== 'running') return false;
    job.cancelRequested = true;
    const child = job.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {}
      job.killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {}
      }, KILL_GRACE_MS);
      job.killTimer.unref?.();
    } else if (!child) {
      // Nothing spawned yet (the create kind, or a clone still in its first
      // tick): settle here, the runner checks `cancelRequested` before acting.
      this.finish(job, 'cancelled');
    }
    return true;
  }

  /** Drop every timer and kill anything running. For shutdown and for tests. */
  dispose(): void {
    for (const job of this.jobs.values()) {
      if (job.reapTimer) clearTimeout(job.reapTimer);
      if (job.killTimer) clearTimeout(job.killTimer);
      if (job.state === 'running' && job.child) {
        try {
          job.child.kill('SIGKILL');
        } catch {}
      }
    }
    this.jobs.clear();
    this.observers.clear();
  }

  // -- internals ----------------------------------------------------------

  private createJob(request: RestoreRequest, targetPath: string, createdTarget: boolean): InternalJob {
    let resolveSettled!: (snapshot: RestoreJobSnapshot) => void;
    const settled = new Promise<RestoreJobSnapshot>((resolve) => {
      resolveSettled = resolve;
    });
    return {
      id: this.nextId++,
      kind: request.kind,
      targetPath,
      url: request.kind === 'clone' ? request.url : undefined,
      gitInit: request.kind === 'create' ? request.gitInit === true : undefined,
      state: 'running',
      progress: null,
      startedAt: Date.now(),
      createdTarget,
      cancelRequested: false,
      stderr: '',
      lastEmitAt: 0,
      settled,
      resolveSettled,
    };
  }

  private runClone(job: InternalJob): void {
    const parser = new GitProgressParser(job.targetPath);
    let child: ChildProcess;
    try {
      fs.mkdirSync(path.dirname(job.targetPath), { recursive: true });
      child = this.spawnFn('git', buildCloneArgs(job.url!, job.targetPath), {
        cwd: path.dirname(job.targetPath),
        stdio: ['ignore', 'ignore', 'pipe'],
        env: buildCloneEnv(process.env),
      });
    } catch (err: any) {
      job.failure = mapCloneFailure(String(err?.message || err), job.url!);
      this.finish(job, 'failed');
      return;
    }
    job.child = child;
    if (job.cancelRequested) {
      try {
        child.kill('SIGTERM');
      } catch {}
    }

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (job.stderr.length < MAX_STDERR_CHARS) job.stderr += chunk;
      for (const frame of parser.push(chunk)) this.record(job, frame);
    });

    child.on('error', (err: Error) => {
      job.failure = mapCloneFailure(job.stderr || err.message, job.url!);
      this.finish(job, 'failed');
    });

    child.on('close', (code) => {
      if (job.state !== 'running') return;
      if (job.cancelRequested) {
        this.cleanupCancelled(job);
        this.finish(job, 'cancelled');
        return;
      }
      if (code === 0) {
        setupUpstreamTracking(job.targetPath);
        this.finish(job, 'done');
        return;
      }
      job.failure = mapCloneFailure(job.stderr, job.url!);
      this.finish(job, 'failed');
    });
  }

  private runCreate(job: InternalJob): void {
    // Deliberately asynchronous even though mkdir is cheap: callers drive ONE
    // state machine for both kinds, so `create` must never settle before the
    // requester has had a chance to subscribe.
    setImmediate(() => {
      if (job.state !== 'running') return;
      if (job.cancelRequested) {
        this.cleanupCancelled(job);
        this.finish(job, 'cancelled');
        return;
      }
      try {
        this.record(job, {
          phase: 'creating',
          scope: REPOSITORY_SCOPE,
          percent: null,
          indeterminate: true,
          text: `Creating ${job.targetPath}`,
          at: Date.now(),
        });
        fs.mkdirSync(job.targetPath, { recursive: true });
      } catch (err: any) {
        job.failure = { cause: 'unknown', message: `Could not create ${job.targetPath}: ${err?.message || err}`, stderr: '' };
        this.finish(job, 'failed');
        return;
      }
      if (!job.gitInit) {
        this.finish(job, 'done');
        return;
      }
      this.record(job, {
        phase: 'initialising',
        scope: REPOSITORY_SCOPE,
        percent: null,
        indeterminate: true,
        text: `Initialising a git repository in ${job.targetPath}`,
        at: Date.now(),
      });
      // The path travels as `cwd`, never as an argument, so nothing about it can
      // be read as an option.
      const child = this.spawnFn('git', ['init'], {
        cwd: job.targetPath,
        stdio: ['ignore', 'ignore', 'pipe'],
        env: process.env,
      });
      job.child = child;
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (job.stderr.length < MAX_STDERR_CHARS) job.stderr += chunk;
      });
      child.on('error', (err: Error) => {
        job.failure = { cause: 'unknown', message: `git init failed: ${err.message}`, stderr: job.stderr };
        this.finish(job, 'failed');
      });
      child.on('close', (code) => {
        if (job.state !== 'running') return;
        if (job.cancelRequested) {
          this.cleanupCancelled(job);
          this.finish(job, 'cancelled');
          return;
        }
        if (code === 0) {
          this.finish(job, 'done');
          return;
        }
        job.failure = {
          cause: 'unknown',
          message: lastMeaningfulLine(job.stderr) || `git init exited with code ${code}`,
          stderr: job.stderr,
        };
        this.finish(job, 'failed');
      });
    });
  }

  /** Store the latest frame always; publish it at a few frames per second. */
  private record(job: InternalJob, frame: RestoreProgress): void {
    const previous = job.progress;
    job.progress = frame;
    const changedScope = !previous || previous.scope !== frame.scope || previous.phase !== frame.phase;
    const now = Date.now();
    if (!changedScope && frame.percent !== 100 && now - job.lastEmitAt < this.progressIntervalMs) return;
    job.lastEmitAt = now;
    const view = snapshot(job);
    for (const observer of this.observersFor(job.targetPath)) {
      try {
        observer.onProgress?.(frame, view);
      } catch (err) {
        console.error('Restore progress observer threw:', err);
      }
    }
  }

  private cleanupCancelled(job: InternalJob): void {
    if (!job.createdTarget) return;
    try {
      fs.rmSync(job.targetPath, { recursive: true, force: true });
    } catch (err) {
      console.error(`Failed to remove cancelled restore target ${job.targetPath}:`, err);
    }
  }

  private finish(job: InternalJob, state: Exclude<RestoreJobState, 'running'>): void {
    if (job.state !== 'running') return;
    job.state = state;
    job.endedAt = Date.now();
    if (job.killTimer) {
      clearTimeout(job.killTimer);
      job.killTimer = undefined;
    }
    const view = snapshot(job);
    for (const observer of this.observersFor(job.targetPath)) {
      try {
        observer.onSettled?.(view);
      } catch (err) {
        console.error('Restore settle observer threw:', err);
      }
    }
    job.resolveSettled(view);
    job.reapTimer = setTimeout(() => {
      if (this.jobs.get(job.targetPath) === job) this.jobs.delete(job.targetPath);
    }, this.retainMs);
    job.reapTimer.unref?.();
  }

  private observersFor(targetPath: string): RestoreJobObserver[] {
    const set = this.observers.get(targetPath);
    return set ? [...set] : [];
  }
}

function snapshot(job: InternalJob): RestoreJobSnapshot {
  return {
    id: job.id,
    kind: job.kind,
    targetPath: job.targetPath,
    ...(job.url !== undefined ? { url: job.url } : {}),
    ...(job.gitInit !== undefined ? { gitInit: job.gitInit } : {}),
    state: job.state,
    progress: job.progress,
    ...(job.failure ? { failure: job.failure } : {}),
    startedAt: job.startedAt,
    ...(job.endedAt !== undefined ? { endedAt: job.endedAt } : {}),
  };
}

function expandTilde(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Pre-configure upstream tracking for the cloned default branch.
 *
 * This preserves the behaviour of `cloneRemoteRepo()`/`setupUpstreamTracking()`
 * in `session-pool.ts`, which this module is to replace. It is re-implemented
 * here rather than imported because `session-pool.ts` pulls in the whole
 * pi-coding-agent runtime, and this module (and its tests) must stay standalone.
 * The later re-point task deletes the session-pool copies.
 *
 * Best effort by design: a clone that succeeded is a restored folder, and a
 * tracking config that did not take is not worth failing it over.
 */
function setupUpstreamTracking(resolvedCwd: string): void {
  // Synchronous is fine here: these are local config reads and writes on a repo
  // that was just written to disk, and the job is already at its end.
  try {
    let defaultBranch = '';
    try {
      defaultBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { cwd: resolvedCwd })
        .toString()
        .trim();
    } catch {
      try {
        defaultBranch = execFileSync('git', ['config', '--get', 'init.defaultBranch'], { cwd: resolvedCwd })
          .toString()
          .trim();
      } catch {}
    }
    if (!defaultBranch) defaultBranch = 'main';
    execFileSync('git', ['config', `branch.${defaultBranch}.remote`, 'origin'], { cwd: resolvedCwd, stdio: 'ignore' });
    execFileSync('git', ['config', `branch.${defaultBranch}.merge`, `refs/heads/${defaultBranch}`], {
      cwd: resolvedCwd,
      stdio: 'ignore',
    });
  } catch (err) {
    console.error('Failed to pre-configure upstream tracking branch:', err);
  }
}
