import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * `wherever install` and friends.
 *
 * Installs (or removes) a background service that runs the wherever server, and
 * optionally wires the `@wherever-dev/pi` extension into the user's pi config so
 * a running pi CLI bridges into the same server automatically.
 *
 * Supported platforms:
 *   - Linux  : systemd user unit (default) or system unit (`--system`, needs root)
 *   - macOS  : launchd LaunchAgent (per-user)
 * Windows is not supported yet; the command prints the manual steps instead.
 */

const SERVICE_NAME = 'wherever';
// Reverse-DNS label used by launchd (the plist Label + filename stem).
const LAUNCHD_LABEL = 'dev.wherever.server';

export interface InstallOptions {
  system: boolean;
  configurePi: boolean;
  // systemd memory backstop (Linux only). Defaults below; '' (via
  // --no-memory-limits) omits the directives entirely.
  memoryHigh: string;
  memoryMax: string;
  // Every argument that is not an install-owned flag is forwarded verbatim to
  // `wherever start` and baked into the service, e.g. `--host`, `--port`,
  // `--token`, `--http-localhost-fallback`, `--no-ssl`, `--ssl-key`, ...
  serverArgs: string[];
  // When true, only print what would happen; write nothing.
  dryRun: boolean;
}

interface ServiceContext {
  /** Absolute path to the node binary that should run the server. */
  nodePath: string;
  /** Absolute path to the wherever server entrypoint (dist/index.js). */
  serverEntry: string;
  /** Extra CLI args passed to the server (e.g. --port 31415). */
  serverArgs: string[];
  homeDir: string;
}

function resolveServiceContext(opts: InstallOptions): ServiceContext {
  const __filename = fileURLToPath(import.meta.url);
  // dist/commands/install.js -> dist/index.js
  const serverEntry = path.resolve(path.dirname(__filename), '..', 'index.js');
  // The server is started via the explicit `start` verb; bare invocation prints
  // help, so the service must pass `start` before any flags. Everything the
  // user passed to `install` (minus install-owned flags) follows verbatim.
  const serverArgs: string[] = ['start', ...opts.serverArgs];
  return {
    nodePath: process.execPath,
    serverEntry,
    serverArgs,
    homeDir: os.homedir(),
  };
}

/** Quote a single argument for an ExecStart / plist string array member. */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_./:=-]+$/.test(arg)) return arg;
  return `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;
}

// ---------------------------------------------------------------------------
// systemd (Linux)
// ---------------------------------------------------------------------------

function systemdUnitPath(system: boolean, homeDir: string): string {
  if (system) return path.join('/etc/systemd/system', `${SERVICE_NAME}.service`);
  return path.join(homeDir, '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
}

/**
 * Memory backstop baked into the unit.
 *
 * The server reads session transcripts, and a real sessions directory grows
 * without bound (measured: 2.0 GB after a few months). The readers are now
 * streaming and bounded, but a cgroup limit is the difference between ONE
 * misbehaving process and a machine in swap-thrash: without it, a runaway
 * wherever took the whole box down and systemd-oomd killed the unit only after
 * 12 GB of swap and a load average of 32.
 *
 * `MemoryHigh` is the soft limit: the kernel throttles the cgroup and reclaims
 * hard past it, which turns a leak into visible slowness instead of a machine-
 * wide stall. `MemoryMax` is the hard wall: past it this unit (not some innocent
 * bystander) is OOM-killed, and `Restart=on-failure` brings it straight back.
 * Steady state on a 2 GB corpus is ~200 MB, so 1 GB / 1.5 GB leaves a wide
 * margin for concurrent agent sessions while still bounding the blast radius.
 */
export const DEFAULT_MEMORY_HIGH = '1G';
export const DEFAULT_MEMORY_MAX = '1500M';

function renderSystemdUnit(ctx: ServiceContext, system: boolean, opts: InstallOptions): string {
  const execStart = [ctx.nodePath, ctx.serverEntry, ...ctx.serverArgs]
    .map(shellQuote)
    .join(' ');
  const lines = [
    '[Unit]',
    'Description=Wherever server (remote control for the pi coding agent)',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${execStart}`,
    'Restart=on-failure',
    'RestartSec=5',
    '',
    ...(opts.memoryHigh || opts.memoryMax
      ? [
          '# Memory backstop: throttle+reclaim at MemoryHigh, OOM-kill THIS unit at',
          '# MemoryMax (Restart=on-failure brings it back) so a memory problem here can',
          '# never take the whole machine into swap thrash. Steady state is ~200 MB on a',
          '# 2 GB sessions directory. Tune with --memory-high/--memory-max at install',
          '# time, or drop them entirely with --no-memory-limits.',
          ...(opts.memoryHigh ? [`MemoryHigh=${opts.memoryHigh}`] : []),
          ...(opts.memoryMax ? [`MemoryMax=${opts.memoryMax}`] : []),
          '',
        ]
      : []),
    '[Install]',
    system ? 'WantedBy=multi-user.target' : 'WantedBy=default.target',
    '',
  ];
  return lines.join('\n');
}

function runSystemctl(system: boolean, args: string[]): void {
  const base = system ? ['systemctl'] : ['systemctl', '--user'];
  const cmd = base[0];
  const cmdArgs = [...base.slice(1), ...args];
  execFileSync(cmd, cmdArgs, { stdio: 'inherit' });
}

function installSystemd(ctx: ServiceContext, opts: InstallOptions): void {
  const unitPath = systemdUnitPath(opts.system, ctx.homeDir);
  const unit = renderSystemdUnit(ctx, opts.system, opts);

  if (opts.dryRun) {
    console.log(`[dry-run] would write systemd unit to: ${unitPath}`);
    console.log('---');
    console.log(unit);
    console.log('---');
    console.log(`[dry-run] would run: systemctl ${opts.system ? '' : '--user '}daemon-reload`);
    console.log(`[dry-run] would run: systemctl ${opts.system ? '' : '--user '}enable --now ${SERVICE_NAME}`);
    console.log(`[dry-run] would run: systemctl ${opts.system ? '' : '--user '}restart ${SERVICE_NAME}`);
    return;
  }

  fs.mkdirSync(path.dirname(unitPath), { recursive: true });
  fs.writeFileSync(unitPath, unit, 'utf-8');
  console.log(`Wrote systemd unit: ${unitPath}`);

  runSystemctl(opts.system, ['daemon-reload']);
  runSystemctl(opts.system, ['enable', '--now', SERVICE_NAME]);
  // `enable --now` starts a stopped unit but is a no-op for an already-running
  // one, so on a re-install the live process would keep the OLD ExecStart until
  // the next restart. Explicitly restart so re-running install always applies
  // the freshly written options (mirrors launchd's unload+load on macOS).
  runSystemctl(opts.system, ['restart', SERVICE_NAME]);
  console.log(`Service '${SERVICE_NAME}' enabled and (re)started.`);
  if (opts.memoryHigh || opts.memoryMax) {
    // systemd silently IGNORES these unless the memory controller is delegated
    // to the slice this unit runs in (cgroup v2 with delegation; not the case on
    // cgroup v1 or some older user slices). Silently-ignored is the worst
    // outcome for a backstop, so say how to check.
    console.log(
      `Memory backstop: ${[opts.memoryHigh && `MemoryHigh=${opts.memoryHigh}`, opts.memoryMax && `MemoryMax=${opts.memoryMax}`]
        .filter(Boolean)
        .join(' ')}. ` +
        `Verify it took effect with \`systemctl ${opts.system ? '' : '--user '}show ${SERVICE_NAME} -p MemoryMax\`; ` +
        `if it reports infinity, the memory controller is not delegated to this slice.`,
    );
  }
  if (!opts.system) {
    console.log(
      'Tip: run `loginctl enable-linger $USER` so the service keeps running after you log out.',
    );
  }
}

function uninstallSystemd(opts: InstallOptions): void {
  const unitPath = systemdUnitPath(opts.system, os.homedir());
  if (opts.dryRun) {
    console.log(`[dry-run] would run: systemctl ${opts.system ? '' : '--user '}disable --now ${SERVICE_NAME}`);
    console.log(`[dry-run] would remove: ${unitPath}`);
    return;
  }
  try {
    runSystemctl(opts.system, ['disable', '--now', SERVICE_NAME]);
  } catch {
    // Service may not be running/enabled; keep going and remove the unit file.
  }
  if (fs.existsSync(unitPath)) {
    fs.rmSync(unitPath);
    console.log(`Removed systemd unit: ${unitPath}`);
  }
  try {
    runSystemctl(opts.system, ['daemon-reload']);
  } catch {
    /* best effort */
  }
  console.log(`Service '${SERVICE_NAME}' removed.`);
}

function statusSystemd(opts: InstallOptions): void {
  try {
    runSystemctl(opts.system, ['status', SERVICE_NAME, '--no-pager']);
  } catch {
    // systemctl status exits non-zero for inactive/failed units; that's fine,
    // its output was already streamed to the console.
  }
}

// ---------------------------------------------------------------------------
// launchd (macOS)
// ---------------------------------------------------------------------------

function launchdPlistPath(homeDir: string): string {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`);
}

function renderLaunchdPlist(ctx: ServiceContext): string {
  const programArgs = [ctx.nodePath, ctx.serverEntry, ...ctx.serverArgs];
  const argsXml = programArgs
    .map((a) => `    <string>${escapeXml(a)}</string>`)
    .join('\n');
  const logPath = path.join(ctx.homeDir, 'Library', 'Logs', `${LAUNCHD_LABEL}.log`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${LAUNCHD_LABEL}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    argsXml,
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(logPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(logPath)}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function installLaunchd(ctx: ServiceContext, opts: InstallOptions): void {
  if (opts.system) {
    throw new Error(
      'System-level (LaunchDaemon) install is not supported on macOS yet; omit --system to install a per-user LaunchAgent.',
    );
  }
  const plistPath = launchdPlistPath(ctx.homeDir);
  const plist = renderLaunchdPlist(ctx);

  if (opts.dryRun) {
    console.log(`[dry-run] would write launchd plist to: ${plistPath}`);
    console.log('---');
    console.log(plist);
    console.log('---');
    console.log(`[dry-run] would run: launchctl unload ${plistPath} (if loaded)`);
    console.log(`[dry-run] would run: launchctl load ${plistPath}`);
    return;
  }

  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  fs.mkdirSync(path.join(ctx.homeDir, 'Library', 'Logs'), { recursive: true });
  fs.writeFileSync(plistPath, plist, 'utf-8');
  console.log(`Wrote launchd plist: ${plistPath}`);
  if (opts.memoryHigh || opts.memoryMax) {
    console.log(
      'Note: launchd has no per-service memory cap, so the memory backstop is Linux/systemd only.',
    );
  }

  // Reload: unload first (ignore errors) so a re-install picks up changes.
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch {
    /* not previously loaded */
  }
  execFileSync('launchctl', ['load', plistPath], { stdio: 'inherit' });
  console.log(`Service '${LAUNCHD_LABEL}' loaded and started.`);
}

function uninstallLaunchd(opts: InstallOptions): void {
  const plistPath = launchdPlistPath(os.homedir());
  if (opts.dryRun) {
    console.log(`[dry-run] would run: launchctl unload ${plistPath}`);
    console.log(`[dry-run] would remove: ${plistPath}`);
    return;
  }
  try {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
  } catch {
    /* not loaded */
  }
  if (fs.existsSync(plistPath)) {
    fs.rmSync(plistPath);
    console.log(`Removed launchd plist: ${plistPath}`);
  }
  console.log(`Service '${LAUNCHD_LABEL}' removed.`);
}

function statusLaunchd(): void {
  try {
    execFileSync('launchctl', ['list', LAUNCHD_LABEL], { stdio: 'inherit' });
  } catch {
    console.log(`Service '${LAUNCHD_LABEL}' is not loaded.`);
  }
}

// ---------------------------------------------------------------------------
// pi extension config injection
// ---------------------------------------------------------------------------

const PI_PACKAGE = 'npm:@wherever-dev/pi';

function piSettingsPath(homeDir: string): string {
  return path.join(homeDir, '.pi', 'agent', 'settings.json');
}

/**
 * Substrings that identify this extension in a settings entry. `@wherever-dev/pi`
 * is the npm package name; `wherever` catches a local dev path/symlink. Matching
 * either avoids double-registering when it is already wired in.
 */
const PI_EXTENSION_MARKERS = ['@wherever-dev/pi', 'wherever'];

function entryReferencesExtension(value: string): boolean {
  return PI_EXTENSION_MARKERS.some((m) => value.includes(m));
}

/** True if the extension is already referenced anywhere in the settings. */
function piExtensionConfigured(settings: any): boolean {
  const inPackages = Array.isArray(settings.packages) &&
    settings.packages.some((p: any) => {
      if (typeof p === 'string') return entryReferencesExtension(p);
      if (p && typeof p === 'object' && typeof p.source === 'string') {
        return entryReferencesExtension(p.source);
      }
      return false;
    });
  const inExtensions = Array.isArray(settings.extensions) &&
    settings.extensions.some((e: any) => typeof e === 'string' && entryReferencesExtension(e));
  return inPackages || inExtensions;
}

export function configurePiExtension(homeDir: string, dryRun: boolean): void {
  const settingsPath = piSettingsPath(homeDir);

  if (!fs.existsSync(settingsPath)) {
    if (dryRun) {
      console.log(`[dry-run] pi settings not found at ${settingsPath}; would create it with the wherever extension.`);
      return;
    }
    const fresh = { packages: [PI_PACKAGE] };
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(fresh, null, 2) + '\n', 'utf-8');
    console.log(`Created pi settings and added the wherever extension: ${settingsPath}`);
    return;
  }

  let settings: any;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
  } catch (err) {
    console.warn(
      `Could not parse ${settingsPath} (${(err as Error).message}); skipping pi extension config. ` +
      `Add "${PI_PACKAGE}" to its "packages" array manually.`,
    );
    return;
  }

  if (piExtensionConfigured(settings)) {
    console.log('pi extension already configured; leaving settings.json untouched.');
    return;
  }

  if (dryRun) {
    console.log(`[dry-run] would add "${PI_PACKAGE}" to "packages" in ${settingsPath}`);
    return;
  }

  if (!Array.isArray(settings.packages)) settings.packages = [];
  settings.packages.push(PI_PACKAGE);

  // Back up before mutating, so a bad edit is always recoverable.
  fs.copyFileSync(settingsPath, `${settingsPath}.bak`);
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  console.log(`Added "${PI_PACKAGE}" to pi settings (backup at ${settingsPath}.bak).`);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

export function runInstall(opts: InstallOptions): void {
  const ctx = resolveServiceContext(opts);
  switch (process.platform) {
    case 'linux':
      installSystemd(ctx, opts);
      break;
    case 'darwin':
      installLaunchd(ctx, opts);
      break;
    default:
      printUnsupported('install');
      return;
  }
  if (opts.configurePi) {
    configurePiExtension(ctx.homeDir, opts.dryRun);
  }
}

export function runUninstall(opts: InstallOptions): void {
  switch (process.platform) {
    case 'linux':
      uninstallSystemd(opts);
      break;
    case 'darwin':
      uninstallLaunchd(opts);
      break;
    default:
      printUnsupported('uninstall');
  }
}

export function runServiceStatus(opts: InstallOptions): void {
  switch (process.platform) {
    case 'linux':
      statusSystemd(opts);
      break;
    case 'darwin':
      statusLaunchd();
      break;
    default:
      printUnsupported('status');
  }
}

function printUnsupported(verb: string): void {
  console.error(
    `\`wherever ${verb}\` is not supported on ${process.platform} yet (Linux and macOS only).\n` +
    'You can still run the server directly with `wherever` (no subcommand),\n' +
    `and add "${PI_PACKAGE}" to the "packages" array in ~/.pi/agent/settings.json manually.`,
  );
}

export function parseInstallOptions(args: string[]): InstallOptions {
  const opts: InstallOptions = {
    system: false,
    configurePi: true,
    serverArgs: [],
    dryRun: false,
    memoryHigh: DEFAULT_MEMORY_HIGH,
    memoryMax: DEFAULT_MEMORY_MAX,
  };
  // Install owns only these three flags; everything else is forwarded verbatim
  // to `wherever start` and baked into the service. A bare `--` separator is
  // still tolerated (and dropped) so old muscle memory keeps working, but it is
  // no longer required.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--':
        // Legacy separator: no-op now that everything forwards by default.
        break;
      case '--system':
        opts.system = true;
        break;
      case '--no-pi-config':
        opts.configurePi = false;
        break;
      case '--dry-run':
        opts.dryRun = true;
        break;
      // Install-owned, so they are NOT forwarded to `wherever start` (which
      // would reject/ignore them): they shape the generated systemd unit.
      case '--memory-high':
        opts.memoryHigh = args[++i] ?? '';
        break;
      case '--memory-max':
        opts.memoryMax = args[++i] ?? '';
        break;
      case '--no-memory-limits':
        opts.memoryHigh = '';
        opts.memoryMax = '';
        break;
      default:
        opts.serverArgs.push(arg);
    }
  }
  return opts;
}

export function printInstallHelp(): void {
  console.log(`wherever - remote control server for the pi coding agent

Usage:
  wherever start [server options]  Run the server
  wherever install [options]       Install & start a background service
  wherever uninstall [options]     Stop & remove the background service
  wherever service-status          Show the service status
  wherever --version               Show the installed version
  wherever help                    Show this help

Install options:
  --system            Install a system-wide service (Linux only, needs root).
                      Default is a per-user service (no sudo).
  --no-pi-config      Do not touch ~/.pi/agent/settings.json.
  --dry-run           Print what would happen without writing anything.
  --memory-high VAL   systemd MemoryHigh for the unit (default ${DEFAULT_MEMORY_HIGH}).
                      Soft limit: past it the kernel throttles and reclaims.
  --memory-max VAL    systemd MemoryMax for the unit (default ${DEFAULT_MEMORY_MAX}).
                      Hard limit: past it THIS unit is OOM-killed and restarted,
                      instead of the machine going into swap thrash.
  --no-memory-limits  Omit both directives. (Linux only; launchd has no
                      equivalent, so these are ignored on macOS.)

Server options (also valid after 'wherever start'):
  --host HOST         Address to bind (default 127.0.0.1).
  --port PORT         Port to bind (default 31415).
  --socket PATH       Listen on a unix socket at PATH instead of a TCP port,
                      for running behind nginx/Caddy. A stale socket file is
                      removed first; a LIVE one is refused. Serves plain HTTP
                      unless --ssl-key/--ssl-cert are given, since whatever
                      fronts the socket terminates TLS.
  --socket fd://N     Serve on an already-bound socket inherited as descriptor
                      N (systemd socket activation passes the first as fd://3).
                      Preferred for a supervised service: systemd applies
                      SocketUser=/SocketGroup=/SocketMode= as root, so the
                      socket can be owned by one account and connectable by a
                      proxy running as another, with no shared group needed.
  --socket-mode MODE  Octal mode for a socket created by --socket PATH
                      (default 0660). Ignored for the fd:// form, where the
                      supervisor owns the mode.
  --token SECRET      Require this token. Prefer WHEREVER_TOKEN /
                      WHEREVER_TOKEN_FILE: argv is world-readable via 'ps'.

Any other flag is forwarded verbatim to the baked 'wherever start' command,
so all server flags work here directly, e.g.
  wherever install --host 0.0.0.0 --port 31415 --http-localhost-fallback
  wherever install --host 0.0.0.0 --token secret --no-ssl

Platforms: Linux (systemd) and macOS (launchd). On install, the
'${PI_PACKAGE}' extension is added to your pi config unless --no-pi-config.
`);
}
