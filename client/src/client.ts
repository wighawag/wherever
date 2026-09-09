import { writable, get, type Writable } from "sveltore";
import { type ChatMessage, type WhereverState, skillInvocationIdentity } from "./types.js";

/**
 * Per-send options for a user message.
 *
 * `conversationMode` is the per-turn CONVERSATION-MODE SIGNAL: true means a spoken
 * conversation is active for this send (the web app stamps it when its
 * conversation-mode AND speak-replies knobs are both active), so the agent adds a
 * short spoken `say` reply alongside its written answer. Omitted/false means off,
 * which is exactly the pre-existing behaviour.
 */
export interface SendMessageOptions {
  conversationMode?: boolean;
}

export interface WhereverClientConfig {
  host: string;
  port: number | string;
  token?: string;
  secure?: boolean;
  WebSocketCtor?: any;
  hideThinking?: boolean;
  hideTools?: boolean;
  // Stable identity for THIS viewer across reconnects. The server keys its
  // per-connection client records by socket, so a silently dropped socket (phone
  // sleep, network switch, half-open TCP) leaves a PHANTOM client attached to
  // the session until the heartbeat reaper notices, up to a minute later. In
  // that window the phantom counts as "another viewer", which turns an explicit
  // "New Session Here" into a folder conflict (read-only attach to the existing
  // session). Sending a stable key lets the server evict this viewer's own
  // previous connection the moment it reconnects. Callers should scope the key
  // per TAB (e.g. sessionStorage), never per browser: two real tabs must stay
  // two distinct viewers. Omitted -> a per-instance key is generated, which
  // already covers in-process reconnects.
  clientKey?: string;
  // Called when the client had to take a NEW clientKey because the server
  // reported this one as superseded (two viewers ended up sharing it). Persist it
  // wherever `clientKey` came from, so the collision is resolved for good rather
  // than re-created on the next reconnect.
  onClientKeyChange?: (key: string) => void;
}

// Per-instance fallback identity: stable for the lifetime of this client object,
// which is exactly the lifetime across which reconnects happen.
function generateClientKey(): string {
  return `ck-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

const defaultState: WhereverState = {
	connected: false,
	connecting: false,
	creatingSession: false,
	loadingSession: false,
	resyncing: false,
	agentPending: false,
	error: null,
	session: null,
	sessionId: null,
	isStreaming: false,
	messages: [],
	clientId: null,
	serverVersion: null,
	folderConflict: null,
	folderMissing: null,
	isInterrupted: false,
	notice: null,
	sudoPrompt: null,
	sessionError: null,
	readOnly: false,
	activeSessionFile: null,
	activeCwd: null,
	activeModel: null,
	hideThinking: false,
	hideTools: false,
	historyTotalCount: 0,
	historyOffset: 0,
	loadingMoreHistory: false,
	contextUsage: null,
	pendingSteering: [],
	skills: [],
};

export class WhereverClient {
  private ws: any = null;
  private config: WhereverClientConfig;
  // Identity sent on every connect so the server can retire this viewer's own
  // stale/phantom connection instead of counting it as a second viewer. Replaced
  // (once) if the server reports it as superseded by another live connection.
  private clientKey: string;
  public stateStore: Writable<WhereverState>;
  private reconnectTimer: any = null;
  private agentEndTimeout: any = null;
  // Watchdog for an in-flight session_load. We set loadingSession/resyncing the
  // moment a load is requested and clear them when message_history (or an
  // error/conflict/disconnect) arrives. If none of those ever comes back (a lost
  // reply, a server that answered for a different session, or any unforeseen
  // edge), the "Loading session..." / "Reconnecting..." affordance would hang
  // forever. This timer guarantees the load state always resolves: on expiry we
  // clear the flags and surface a recoverable error instead of an endless spin.
  private loadWatchdog: any = null;
  private static readonly LOAD_WATCHDOG_MS = 12_000;
  // Watchdog for an in-flight session_new. Symmetrical to loadWatchdog: creating
  // a session sets creatingSession=true and shows a BLOCKING full-screen overlay,
  // and the only things that clear it are session_created/session_error/
  // session_interrupted (or a socket close). If none of those
  // ever arrives (a slow git init / remote-repo creation, an error thrown before
  // the reply is sent, or a half-open socket the liveness watchdog has not yet
  // reaped), the overlay spins forever and the only recovery is a reload. This
  // timer guarantees creatingSession always resolves. It is longer than the load
  // watchdog because creating can legitimately take a while (git init + creating
  // a remote GitHub repo over the network).
  private createWatchdog: any = null;
  private static readonly CREATE_WATCHDOG_MS = 25_000;
  private reconnectAttempts = 0;
  private reconnectDelay = 2000;
  private maxReconnectDelay = 15000;
  // Whether the socket has EVER opened successfully since construction. Repeated
  // closes with zero successful opens almost always mean a rejected handshake
  // (bad/missing token, wrong host/port, or wrong ws-vs-wss scheme) rather than
  // a transient network drop. A browser WebSocket cannot read the HTTP 401 body
  // (it just sees close code 1006), so we infer auth/config failure from this
  // pattern and surface an actionable error instead of looping silently.
  private hasEverConnected = false;
  private static readonly HANDSHAKE_FAIL_HINT_AFTER = 2;
  // Liveness watchdog: a half-open TCP socket fires neither 'close' nor 'error',
  // so the existing reconnect machinery never triggers and the agent hangs
  // forever (see work/observations/ws-half-open-connection-hangs-agent-no-heartbeat.md).
  // We record the time of the last inbound frame and, if the socket goes silent
  // for longer than STALE_SOCKET_MS, proactively tear it down and reconnect.
  // A periodic app-level {type:'ping'} keeps a healthy connection refreshed even
  // during long, token-less model turns.
  private livenessTimer: any = null;
  private heartbeatTimer: any = null;
  private lastInboundAt = 0;
  // > the server heartbeat (when present) and any normal token-less gap, so a
  // healthy connection is never falsely reaped; short enough to self-heal fast.
  private static readonly STALE_SOCKET_MS = 60_000;
  // While a turn is streaming, the keepalive pong should keep traffic flowing, so
  // a shorter deadline surfaces a stalled transport (vs a merely slow model)
  // faster. Still > one HEARTBEAT_MS so a single healthy pong keeps it fresh.
  private static readonly TURN_STALL_MS = 45_000;
  // Send a keepalive well under STALE_SOCKET_MS so the pong refreshes liveness.
  private static readonly HEARTBEAT_MS = 25_000;
  private isInitialConnect = true;
  // When set, the next successful (re)connection should rejoin the previously
  // active session instead of starting blank. Used by resume() so a backgrounded
  // tab returns to its cached conversation and resyncs history in place.
  private resumeSessionFile: string | null = null;
  private resumeCwd?: string;
  private resumeModel?: string;
  // The sessionFile of the most recent session_load we are still waiting on.
  // A slow load (session A) followed by a switch to another session (B) must not
  // let A's late session_created reply clobber the now-active B: when the reply's
  // sessionFile does not match pendingLoadFile, it is a superseded load and is
  // ignored. Set on every session_load we issue (switch/join/reconnect), cleared
  // when the matching session_created lands (or on leave/new-session/error).
  // null means "accept any" (e.g. session_new, whose target file is not known
  // until the reply). The latest tap always wins.
  private pendingLoadFile: string | null = null;
  private listeners = new Set<(msg: any) => void>();
  private pendingUploads = new Map<string, {resolve: (val: any) => void, reject: (err: any) => void}>();
  // Per-message confirmation watchdogs. A user message committed optimistically
  // is only proven delivered when the server echoes it back; if no echo lands
  // within CONFIRM_MS the watchdog flips it to delivery:'failed' so the UI can
  // offer a retry instead of pretending it was sent (the half-open-socket loss).
  private confirmTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private static readonly CONFIRM_MS = 12_000;
  private static readonly PENDING_PREFIX = 'wherever-pending:';

  constructor(config: WhereverClientConfig) {
    this.config = {
      secure: true,
      ...config
    };
    this.clientKey = this.config.clientKey || generateClientKey();
    this.stateStore = writable<WhereverState>({
      ...defaultState,
      hideThinking: !!this.config.hideThinking,
      hideTools: !!this.config.hideTools,
    });
  }

  public connect(newConfig?: Partial<WhereverClientConfig>, preserveState = false) {
    if (newConfig) {
      this.config = {
        ...this.config,
        ...newConfig
      };
    }

    this.disconnect(false);

    // preserveState keeps the cached session/messages in the store across a
    // reconnect (resume path), so the previous conversation stays visible while
    // we reconnect and resync. The default (fresh connect) clears to a blank
    // store as before.
    this.stateStore.update(s => preserveState
      ? {...s, connecting: true, error: null}
      : {
          ...defaultState,
          connecting: true,
          hideThinking: !!this.config.hideThinking,
          hideTools: !!this.config.hideTools,
        });

    const protocol = this.config.secure ? "wss" : "ws";
    const host = this.config.host.startsWith('http')
      ? this.config.host.replace(/^https?:\/\//, '')
      : this.config.host;
    // clientKey rides on the URL (not a post-connect frame) so the server can
    // evict this viewer's previous connection BEFORE any session traffic is
    // handled, closing the phantom-viewer window entirely.
    const params: string[] = [];
    if (this.config.token) params.push(`token=${encodeURIComponent(this.config.token)}`);
    params.push(`clientKey=${encodeURIComponent(this.clientKey)}`);
    const wsUrl = `${protocol}://${host}:${this.config.port}/ws?${params.join('&')}`;

    const WebSocketImpl = this.config.WebSocketCtor || (typeof globalThis !== 'undefined' ? (globalThis as any).WebSocket : null);
    
    if (!WebSocketImpl) {
      this.stateStore.update(s => ({
        ...s,
        connecting: false,
        error: "No WebSocket implementation found. Please pass custom WebSocketCtor."
      }));
      return;
    }

    try {
      const wsOptions = this.config.secure && this.config.WebSocketCtor ? { rejectUnauthorized: false } : undefined;
      this.ws = wsOptions ? new WebSocketImpl(wsUrl, wsOptions) : new WebSocketImpl(wsUrl);
    } catch (err) {
      this.stateStore.update(s => ({
        ...s,
        connecting: false,
        error: `Failed to connect: ${err}`
      }));
      this.scheduleReconnect();
      return;
    }

    const currentWs = this.ws;

    const onOpen = () => {
      if (this.ws !== currentWs) return;
      if (!this.isInitialConnect) {
        console.info('[wherever] reconnected to relay');
      }
      this.hasEverConnected = true;
      this.reconnectAttempts = 0;
      this.reconnectDelay = 2000;
      this.isInitialConnect = false;
      this.startLivenessWatchdog();
      this.stateStore.update(s => ({
        ...s,
        connected: true,
        connecting: false,
        error: null
      }));
      // Resume path: rejoin the previously-active session so its history is
      // resynced in place. resyncing stays true until message_history (or an
      // error/conflict) arrives, keeping the "reconnecting" affordance up and
      // input blocked without dropping the cached messages.
      //
      // Re-attachment is REQUIRED on every reconnect that still holds a session,
      // not just the suspend/resume path. The server is stateless per socket:
      // each new connection starts attached to NO session (the old socket's
      // close removed this client from the pool). If we do not re-issue
      // session_load here, the relay is connected but the session stream is
      // dead, so the UI shows a frozen conversation (a stale tool call as the
      // last message, Abort disabled) while the agent keeps running headless.
      // Two sources for what to rejoin:
      //   1. resumeSessionFile  -> explicit suspend()/resume() (tab background).
      //   2. the store's activeSessionFile -> an UNSOLICITED drop (network
      //      blip, tab switch, laptop sleep, half-open reap) where suspend()
      //      never ran. This is the case that used to silently freeze.
      const cached = get(this.stateStore);
      const rejoinFile = this.resumeSessionFile ?? cached.activeSessionFile;
      const rejoinCwd =
        this.resumeSessionFile != null
          ? this.resumeCwd
          : (cached.activeCwd ?? undefined);
      const rejoinModel =
        this.resumeSessionFile != null
          ? this.resumeModel
          : (cached.activeModel ?? undefined);
      this.resumeSessionFile = null;
      this.resumeCwd = undefined;
      this.resumeModel = undefined;
      if (rejoinFile) {
        // Keep the cached conversation on screen but mark it resyncing so the
        // "Reconnecting and syncing session..." banner shows and sending is
        // blocked until fresh history lands. resyncing is cleared by
        // message_history (or an error/conflict) via the reducer.
        this.stateStore.update(s => (s.resyncing ? s : {...s, resyncing: true}));
        this.pendingLoadFile = rejoinFile;
        this.send({type: 'session_load', sessionFile: rejoinFile, cwd: rejoinCwd, model: rejoinModel});
        this.armLoadWatchdog();
      } else {
        this.stateStore.update(s => (s.resyncing ? {...s, resyncing: false} : s));
      }
    };

    const onMessage = (event: any) => {
      if (this.ws !== currentWs) return;
      // Any inbound frame (including the pong reply to our keepalive) proves the
      // socket is alive and resets the stale-socket watchdog.
      this.lastInboundAt = Date.now();
      try {
        const rawData = typeof event.data === 'string' ? event.data : event.data.toString();
        const msg = JSON.parse(rawData);
        this.handleMessage(msg);
      } catch (err) {
        console.error("Failed to parse WebSocket message:", err);
      }
    };

    const onClose = () => {
      if (this.ws !== currentWs) return;
      this.stopLivenessWatchdog();
      this.clearLoadWatchdog();
      this.ws = null;
      this.stateStore.update(s => ({
        ...s,
        connected: false,
        connecting: false,
        // Never leave a session-load spinner stuck if the socket drops mid-load.
        loadingSession: false,
        creatingSession: false,
        // If we still hold an active session, the drop is an unsolicited one on a
        // live conversation: mark it resyncing NOW (during the reconnect backoff)
        // so the user immediately sees "Reconnecting..." instead of a frozen view
        // with a stale tool call and a disabled Abort. onOpen re-attaches and the
        // reducer clears resyncing when fresh history lands.
        resyncing: s.activeSessionFile ? true : s.resyncing,
      }));
      this.scheduleReconnect();
    };

    const onError = (err: any) => {
      if (this.ws !== currentWs) return;
      this.stateStore.update(s => ({
        ...s,
        error: s.error || 'Connection error occurred'
      }));
    };

    if (typeof currentWs.addEventListener === 'function') {
      currentWs.addEventListener('open', onOpen);
      currentWs.addEventListener('message', onMessage);
      currentWs.addEventListener('close', onClose);
      currentWs.addEventListener('error', onError);
    } else if (typeof currentWs.on === 'function') {
      currentWs.on('open', onOpen);
      currentWs.on('message', (data: any) => onMessage({ data }));
      currentWs.on('close', onClose);
      currentWs.on('error', onError);
    }
  }

  public disconnect(resetState = true) {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // A pending agent_end clear timer belongs to the socket we are tearing down.
    // Leaving it armed lets it fire against a freshly (re)connected session's
    // state, so cancel it here.
    if (this.agentEndTimeout) {
      clearTimeout(this.agentEndTimeout);
      this.agentEndTimeout = null;
    }
    this.stopLivenessWatchdog();
    // The load/create affordances belong to the socket we are tearing down. If
    // left armed they would later fire against a fresh (re)connected session's
    // state, so cancel them here.
    this.clearLoadWatchdog();
    this.clearCreateWatchdog();

    if (this.ws) {
      const dyingWs = this.ws as any;
      try {
        if (typeof dyingWs.removeAllListeners === 'function') {
          dyingWs.removeAllListeners();
        }
        // Closing a socket that is still CONNECTING (e.g. the wherever server is
        // not running so the handshake never completed) makes `ws` abort the
        // handshake and emit an 'error' asynchronously on the next tick. With
        // every listener removed, that 'error' would be an unhandled
        // EventEmitter error and crash the whole process as an
        // uncaughtException. Keep a no-op error sink on the socket we are
        // tearing down so the late error is swallowed, in both the node (`ws`)
        // and browser (`WebSocket`) environments.
        const swallow = () => {};
        if (typeof dyingWs.on === 'function') {
          dyingWs.on('error', swallow);
        } else if (typeof dyingWs.addEventListener === 'function') {
          dyingWs.addEventListener('error', swallow);
        } else {
          dyingWs.onerror = swallow;
        }
        dyingWs.close();
      } catch (err) {}
      this.ws = null;
    }

    if (resetState) {
      // Full teardown wipes the store, so no unconfirmed message survives in it;
      // clear their watchdogs to avoid firing against a fresh store. The
      // persisted-pending localStorage entries intentionally REMAIN so a later
      // load can still recover them.
      for (const t of this.confirmTimers.values()) clearTimeout(t);
      this.confirmTimers.clear();
      this.stateStore.set({
        ...defaultState,
        hideThinking: !!this.config.hideThinking,
        hideTools: !!this.config.hideTools,
      });
    } else {
      // Preserve-cache teardown (suspend / resume's pre-connect close). The
      // socket is gone, so the store MUST reflect disconnected: leaving a stale
      // connected:true made resume() early-return (its `if (connected) return`
      // guard), so the real reconnect fell through to a plain connect() that did
      // NOT preserve the session, which is what flashed the search / new-session
      // empty-state on tab return. Clearing connected here (without wiping the
      // cached session/messages) lets resume() actually rejoin in place, and
      // never leaves the blocking load/create overlays up on a dead socket.
      this.stateStore.update(s => ({
        ...s,
        connected: false,
        connecting: false,
        loadingSession: false,
        creatingSession: false,
      }));
    }
  }

  // Suspend the connection without tearing down the cached session state. Used
  // when the tab is backgrounded: closing the WebSocket improves bfcache
  // eligibility, but we keep messages/sessionId so returning is a cheap resync
  // rather than a full reload. Records the active session so resume() can rejoin
  // it. Does NOT schedule a reconnect (disconnect(false) clears that timer).
  public suspend() {
    const s = get(this.stateStore);
    if (s.activeSessionFile) {
      this.resumeSessionFile = s.activeSessionFile;
      this.resumeCwd = s.activeCwd ?? undefined;
      this.resumeModel = s.activeModel ?? undefined;
    }
    // The socket producing the live stream is going away. If we carry a stale
    // isStreaming:true across the suspend/resume gap, the composer will wrongly
    // queue the next message as if the agent were still busy (and the queue
    // never drains because no agent_end ever arrives on the dead socket). The
    // authoritative value is re-established by session_created on rejoin.
    if (s.isStreaming) {
      this.stateStore.update(st => ({...st, isStreaming: false}));
    }
    this.disconnect(false);
  }

  // Resume after suspend(): reconnect while preserving the cached store, mark
  // the session as resyncing, and let onOpen rejoin the recorded session. If
  // there is no active session to rejoin, this is just a state-preserving
  // reconnect.
  public resume() {
    const s = get(this.stateStore);
    if (s.connected || s.connecting) return;
    // Rejoin whatever session we still hold: an explicit suspend() record OR the
    // cached active session from an unsolicited drop. In BOTH cases onOpen
    // re-issues session_load, so mark resyncing here to show the affordance and
    // block sending until fresh history lands.
    if (this.resumeSessionFile || s.activeSessionFile) {
      this.stateStore.update(st => ({...st, resyncing: true}));
      // Arm here too: if the socket never opens, onOpen never runs and the
      // resync affordance would otherwise hang. onClose also clears it, but the
      // watchdog covers the half-open / never-opens case.
      this.armLoadWatchdog();
    }
    this.connect(undefined, true);
  }

  // True when suspend() recorded an active session to rejoin on the next resume.
  // Callers use this to take the resume (preserve-cache, rejoin-in-place) path
  // only when there is actually a suspended session; otherwise a plain connect()
  // is correct and avoids racing/latching the hash auto-join on a fresh load.
  public hasSuspendedSession(): boolean {
    return this.resumeSessionFile !== null;
  }

  // True when the store still holds an active session to rejoin in place -- from
  // an explicit suspend() OR an unsolicited drop that left activeSessionFile set.
  // Callers use this to prefer the preserve-cache resume() path over a fresh,
  // session-wiping connect() when returning to a still-live conversation.
  public hasActiveSession(): boolean {
    return this.resumeSessionFile !== null || get(this.stateStore).activeSessionFile !== null;
  }

  // Start (or restart) the stale-socket watchdog + keepalive for the current
  // socket. A half-open connection emits no 'close'/'error', so without this the
  // existing reconnect logic would never fire and the agent would hang forever.
  private startLivenessWatchdog() {
    this.stopLivenessWatchdog();
    this.lastInboundAt = Date.now();

    const sendBeat = () => {
      // Keep a healthy connection warm so the pong refreshes lastInboundAt even
      // during long, token-less model turns.
      try {
        this.ping();
      } catch {}
    };
    if (typeof setInterval === 'function') {
      this.heartbeatTimer = setInterval(sendBeat, WhereverClient.HEARTBEAT_MS);
      if (this.heartbeatTimer && typeof this.heartbeatTimer.unref === 'function') {
        this.heartbeatTimer.unref();
      }
    }

    const checkLiveness = () => {
      if (!this.ws) return;
      const silentFor = Date.now() - this.lastInboundAt;
      const streaming = get(this.stateStore).isStreaming;
      // Per-turn stall timeout: while a turn is in flight the heartbeat pong (and,
      // normally, tokens) should keep traffic flowing, so a shorter deadline
      // distinguishes "model is slow" (heartbeat still arriving -> not stale) from
      // "transport is dead" (heartbeat stopped). When idle, fall back to the
      // generic stale-socket threshold.
      const threshold = streaming
        ? WhereverClient.TURN_STALL_MS
        : WhereverClient.STALE_SOCKET_MS;
      if (silentFor < threshold) return;
      // The socket has been silent past the threshold: treat it as dead. Tearing
      // it down forcibly is what makes a half-open connection recover, since the
      // OS never produced a FIN/RST to trigger the normal close path.
      console.warn(
        `[wherever] relay connection stale: no inbound frame for ${silentFor}ms ` +
        `(threshold ${threshold}ms, ${streaming ? 'mid-turn' : 'idle'}); ` +
        `tearing down dead socket and reconnecting`,
      );
      this.stopLivenessWatchdog();
      const deadWs = this.ws;
      this.ws = null;
      try {
        if (typeof deadWs.terminate === 'function') {
          deadWs.terminate();
        } else if (typeof deadWs.close === 'function') {
          deadWs.close();
        }
      } catch {}
      this.stateStore.update(s => ({
        ...s,
        connected: false,
        connecting: false,
        loadingSession: false,
        creatingSession: false,
        // If a turn was in flight, surface it as a recoverable error so the UI
        // shows "the transport stalled" rather than silently parking mid-stream.
        sessionError: streaming
          ? 'Connection to relay stalled mid-turn; reconnecting...'
          : s.sessionError,
        isStreaming: false,
      }));
      this.scheduleReconnect();
    };
    if (typeof setInterval === 'function') {
      this.livenessTimer = setInterval(checkLiveness, WhereverClient.HEARTBEAT_MS);
      if (this.livenessTimer && typeof this.livenessTimer.unref === 'function') {
        this.livenessTimer.unref();
      }
    }
  }

  private stopLivenessWatchdog() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.livenessTimer) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  // Arm (or re-arm) the load watchdog. Called whenever a session_load is issued
  // so an unresolved load can never strand the loading UI. Idempotent: a fresh
  // load resets the deadline.
  private armLoadWatchdog() {
    this.clearLoadWatchdog();
    this.loadWatchdog = setTimeout(() => {
      this.loadWatchdog = null;
      const s = get(this.stateStore);
      if (!s.loadingSession && !s.resyncing) return;
      console.warn('[wherever] session load timed out; clearing loading state');
      this.stateStore.update(st => ({
        ...st,
        loadingSession: false,
        resyncing: false,
        sessionError:
          st.sessionError ||
          'Loading the session timed out. Please retry from the sidebar or reload.',
      }));
    }, WhereverClient.LOAD_WATCHDOG_MS);
  }

  // Clear the load watchdog. Called at every point the load resolves
  // (message_history, session_error, disconnect, leave).
  private clearLoadWatchdog() {
    if (this.loadWatchdog) {
      clearTimeout(this.loadWatchdog);
      this.loadWatchdog = null;
    }
  }

  // Arm (or re-arm) the create watchdog. Called when session_new is issued so an
  // unanswered create can never strand the blocking "Creating session..."
  // overlay. On expiry we clear creatingSession and surface a recoverable error
  // instead of an endless spin that only a reload escapes.
  private armCreateWatchdog() {
    this.clearCreateWatchdog();
    this.createWatchdog = setTimeout(() => {
      this.createWatchdog = null;
      const s = get(this.stateStore);
      if (!s.creatingSession) return;
      console.warn('[wherever] session create timed out; clearing creating state');
      this.stateStore.update(st => ({
        ...st,
        creatingSession: false,
        sessionError:
          st.sessionError ||
          'Creating the session timed out. It may still be starting on the server; check the sidebar or reload.',
      }));
    }, WhereverClient.CREATE_WATCHDOG_MS);
  }

  // Clear the create watchdog. Called at every point a create resolves
  // (session_created, session_error, session_interrupted,
  // disconnect, leave).
  private clearCreateWatchdog() {
    if (this.createWatchdog) {
      clearTimeout(this.createWatchdog);
      this.createWatchdog = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) return;
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
      console.info(`[wherever] reconnecting to relay (attempt ${++this.reconnectAttempts})`);

      // If we have retried a few times and NEVER once opened the socket, this is
      // almost certainly a rejected handshake, not a flaky network. Surface a
      // concrete, actionable error (the server rejects a bad/missing token with
      // HTTP 401 during the WS upgrade, which the browser reports only as an
      // opaque 1006 close). Keep retrying, but stop looking like a mere network
      // hiccup.
      if (
        !this.hasEverConnected &&
        this.reconnectAttempts >= WhereverClient.HANDSHAKE_FAIL_HINT_AFTER
      ) {
        const scheme = this.config.secure ? 'wss' : 'ws';
        this.stateStore.update(s => ({
          ...s,
          error:
            'Cannot connect to the wherever server: the connection is being rejected. ' +
            'This usually means a missing or wrong token, or a wrong host/port/scheme ' +
            `(currently ${scheme}://${this.config.host}:${this.config.port}). ` +
            'Check the auth token and connection settings.',
        }));
      }

      // If we still hold an active session, PRESERVE the cached store across the
      // reconnect. A default connect() resets to a blank store, which wiped
      // activeSessionFile BEFORE onOpen could re-attach to it -- that is what
      // silently detached the frontend from a still-running session (frozen
      // conversation, no re-follow, not even a "connecting"/"loading" hint).
      // Preserving the store keeps the conversation on screen and lets onOpen
      // re-issue session_load from activeSessionFile.
      const preserve = !!get(this.stateStore).activeSessionFile;

      this.stateStore.update(s => ({
        ...s,
        connecting: true,
        error: 'Reconnecting...',
      }));

      this.connect(undefined, preserve);
    }, this.reconnectDelay);
  }

  private handleMessage(msg: any) {
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch (err) {
        console.error("Error in message listener:", err);
      }
    }

    // Any message that resolves an in-flight session_load disarms the watchdog.
    // session_created arrives just before message_history; message_history is the
    // real completion, but an error/destroy/interrupt also resolves it.
    switch (msg.type) {
      case 'message_history': {
        // Only the history for the load we are actually waiting on resolves the
        // watchdog. A stale history for a superseded session (a slow session A
        // that finished after we switched to session B) must NOT disarm the
        // watchdog still guarding B's in-flight load, or a lost B reply could
        // strand the spinner. Once B's session_created has landed, sessionId is
        // B's, so a history whose sessionId differs is stale and is skipped. The
        // initial load has no sessionId yet, so its history still resolves.
        const active = get(this.stateStore).sessionId;
        if (active && msg.sessionId && msg.sessionId !== active) break;
        this.clearLoadWatchdog();
        break;
      }
      case 'session_error':
      case 'session_destroyed':
      case 'session_interrupted':
        this.clearLoadWatchdog();
        break;
    }

    // Any message that resolves an in-flight session_new disarms the create
    // watchdog. session_created is the success path; error/interrupt end it too.
    switch (msg.type) {
      case 'session_created':
      case 'session_error':
      case 'session_interrupted':
        this.clearCreateWatchdog();
        break;
    }

    switch (msg.type) {
      case 'connected':
        this.stateStore.update((s: WhereverState) => ({
          ...s,
          connected: true,
          connecting: false,
          clientId: msg.clientId,
          serverVersion: msg.serverVersion ?? null,
          error: null,
        }));
        break;

      case 'connection_superseded':
        // A newer connection arrived carrying OUR clientKey, so the server is
        // retiring this socket as a superseded duplicate. Receiving this proves we
        // are alive, i.e. the key is being shared by accident (a duplicated tab
        // clones sessionStorage). Take a fresh identity BEFORE the reconnect the
        // imminent close will schedule, so the two connections stop evicting each
        // other; the owner of the key keeps it and we come back as our own viewer.
        this.clientKey = generateClientKey();
        try {
          this.config.onClientKeyChange?.(this.clientKey);
        } catch (err) {
          console.error('onClientKeyChange failed:', err);
        }
        break;

      case 'file_uploaded': {
        const pending = this.pendingUploads.get(msg.uploadId);
        if (pending) {
          pending.resolve({savedPath: msg.savedPath, filename: msg.filename});
          this.pendingUploads.delete(msg.uploadId);
        }
        break;
      }

      case 'file_upload_error': {
        const pending = this.pendingUploads.get(msg.uploadId);
        if (pending) {
          pending.reject(new Error(msg.error));
          this.pendingUploads.delete(msg.uploadId);
        }
        break;
      }

      case 'agent_start':
        if (this.agentEndTimeout) {
          clearTimeout(this.agentEndTimeout);
          this.agentEndTimeout = null;
        }
        this.stateStore.update((s: WhereverState) => ({...s, isStreaming: true}));
        break;

      case 'thinking_update':
        this.stateStore.update((s: WhereverState) => {
          let lastThinking = [...s.messages]
            .reverse()
            .find((m: ChatMessage) => m.role === 'thinking' && m.isStreaming);
          if (!lastThinking) {
            const newMsg: ChatMessage = {
              id: this.generateId(),
              role: 'thinking',
              content: msg.delta,
              timestamp: Date.now(),
              isStreaming: true,
            };
            return {...s, messages: [...s.messages, newMsg]};
          }
          return {
            ...s,
            messages: s.messages.map((m: ChatMessage) =>
              m.id === lastThinking.id
                ? {...m, content: m.content + msg.delta, isStreaming: true}
                : m,
            ),
          };
        });
        break;

      case 'message_update':
        this.stateStore.update((s: WhereverState) => {
          let lastAssistant = [...s.messages]
            .reverse()
            .find(
              (m: ChatMessage) => m.role === 'assistant' && m.isStreaming,
            );
          if (!lastAssistant) {
            const newMsg: ChatMessage = {
              id: this.generateId(),
              role: 'assistant',
              content: msg.delta,
              timestamp: Date.now(),
              isStreaming: true,
            };
            return {...s, messages: [...s.messages, newMsg]};
          }
          return {
            ...s,
            messages: s.messages.map((m: ChatMessage) =>
              m.id === lastAssistant.id
                ? {...m, content: m.content + msg.delta, isStreaming: true}
                : m,
            ),
          };
        });
        break;

      case 'message_ack':
        // The server accepted this outbound user message (a normal turn, or a
        // mid-stream steer queued for the next step) and handed it to the agent.
        // This is the delivery CONFIRMATION: it arrives immediately, so an
        // accepted steer is not left waiting on the message_end (role:user)
        // echo, which for a steer only comes at the next model call and can miss
        // the confirmation window (flipping the message to a false "Retry").
        // Content-matched to the oldest still-unconfirmed pending message.
        if (typeof msg.content === 'string') {
          this.confirmDeliveredByContent(msg.content);
        }
        break;

      case 'queue_update': {
        // The server relayed pi's current steer queue. Replace our pending-steer
        // set outright (it is the full queue): a message whose content is still
        // in this set is a queued steer that has NOT yet been injected, so the
        // UI can offer to cancel it. When a queued steer is delivered or
        // cancelled, a fresh queue_update arrives with it removed.
        const steering: string[] = Array.isArray(msg.steering)
          ? [...msg.steering]
          : [];
        this.stateStore.update((s: WhereverState) => ({
          ...s,
          pendingSteering: steering,
          messages: this.withRestoredQueuedMessages(s.messages, steering),
        }));
        break;
      }

      case 'message_end':
        this.stateStore.update((s: WhereverState) => {
          let newMessages = s.messages;

          const lastThinking = [...newMessages]
            .reverse()
            .find((m: ChatMessage) => m.role === 'thinking' && m.isStreaming);
          if (lastThinking) {
            newMessages = newMessages.map((m: ChatMessage) =>
              m.id === lastThinking.id ? {...m, isStreaming: false} : m,
            );
          }

          const lastAssistant = [...newMessages]
            .reverse()
            .find(
              (m: ChatMessage) => m.role === 'assistant' && m.isStreaming,
            );
          if (lastAssistant) {
            newMessages = newMessages.map((m: ChatMessage) =>
              m.id === lastAssistant.id
                ? {
                    ...m,
                    content: msg.content || m.content,
                    isStreaming: false,
                  }
                : m,
            );
          } else if (msg.content) {
            // The server echoes the user's own message back once pi has appended
            // it: that is the delivery CONFIRMATION for an optimistic (unconfirmed)
            // echo. Confirm the matching pending message (flip delivery off, clear
            // its watchdog, update the persisted-pending store) instead of adding
            // a duplicate. If there was no pending match (e.g. another client sent
            // it), fall back to the existing content-dedupe.
            if (msg.role === 'user') {
              const confirmedPending = this.confirmDeliveredByContent(msg.content);
              if (confirmedPending) {
                // Re-read: confirmDeliveredByContent already updated the store.
                return get(this.stateStore);
              }
              // A steer we restored from the queue snapshot has now been injected:
              // this echo IS that bubble, so reconcile onto it (drop the marker)
              // rather than appending a duplicate. Oldest first, since pi delivers
              // the queue in order.
              const restoredQueued = newMessages.find(
                (m) =>
                  m.role === 'user' &&
                  m.restoredFromQueue &&
                  m.content === msg.content,
              );
              if (restoredQueued) {
                return {
                  ...s,
                  messages: newMessages.map((m) =>
                    m.id === restoredQueued.id
                      ? {...m, restoredFromQueue: undefined}
                      : m,
                  ),
                };
              }
            }
            // Skill invocations arrive TWICE from the server: first the RAW
            // `/skill:<name> <args>` (as the immediate message_ack, which already
            // confirmed the optimistic bubble by exact content), then the
            // EXPANDED skill block (this message_end echo). They are the same
            // invocation, so instead of appending the expanded form as a
            // duplicate, REWRITE the already-present raw bubble to the expanded
            // content so it renders as the skill chip.
            const echoIdentity =
              msg.role === 'user' ? skillInvocationIdentity(msg.content) : null;
            if (echoIdentity) {
              const existing = [...newMessages]
                .reverse()
                .find(
                  (m) =>
                    m.role === 'user' &&
                    skillInvocationIdentity(m.content) === echoIdentity,
                );
              if (existing) {
                if (existing.content !== msg.content) {
                  newMessages = newMessages.map((m) =>
                    m.id === existing.id ? {...m, content: msg.content} : m,
                  );
                }
                return {...s, messages: newMessages};
              }
            }
            const lastUserMessage = [...newMessages]
              .reverse()
              .find((m) => m.role === 'user');
            const isDuplicateUserMsg =
              msg.role === 'user' &&
              lastUserMessage &&
              lastUserMessage.content === msg.content;

            if (!isDuplicateUserMsg) {
              newMessages = [
                ...newMessages,
                {
                  id: this.generateId(),
                  role: msg.role || 'assistant',
                  content: msg.content,
                  timestamp: Date.now(),
                  isStreaming: false,
                },
              ];
            }
          }

          return {...s, messages: newMessages};
        });
        break;

      case 'agent_end':
        if (this.agentEndTimeout) {
          clearTimeout(this.agentEndTimeout);
          this.agentEndTimeout = null;
        }
        this.agentEndTimeout = setTimeout(() => {
          const now = Date.now();
          this.stateStore.update((s: WhereverState) => ({
            ...s,
            isStreaming: false,
            // The run ended: any steer that was queued has been delivered (or
            // dropped), so nothing is cancellable anymore. The server also emits
            // a final queue_update, but clear here defensively in case it is
            // missed, so a stale "Cancel" affordance cannot linger.
            pendingSteering: [],
            messages: s.messages.map((m: ChatMessage) =>
              m.isStreaming
                ? {
                    ...m,
                    isStreaming: false,
                    // A tool still streaming when the turn ends never got a
                    // tool_end (e.g. the turn was aborted, or its result frame
                    // was lost): its outcome is unknown. Mark it interrupted
                    // (neutral), never let it fall through to a green success
                    // tick, which would falsely claim it succeeded. Assistant/
                    // thinking messages just stop streaming.
                    ...(m.role === 'tool' ? {interrupted: true} : {}),
                    // Freeze a still-running tool's duration if it never got a
                    // tool_end (turn ended between steps), so "Elapsed" stops
                    // ticking and shows the final "Took".
                    endedAt:
                      m.role === 'tool' && m.endedAt === undefined
                        ? now
                        : m.endedAt,
                  }
                : m,
            ),
          }));
          this.agentEndTimeout = null;
        }, 300);
        break;

      case 'tool_start':
        if (this.agentEndTimeout) {
          clearTimeout(this.agentEndTimeout);
          this.agentEndTimeout = null;
        }
        const toolArgs = msg.args
          ? Object.entries(msg.args)
              .filter(([k, v]) => v !== undefined && v !== '')
              .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
              .join(' ')
          : '';
        this.stateStore.update((s: WhereverState) => {
          const finalizedMessages = s.messages.map((m: ChatMessage) =>
            m.isStreaming && (m.role === 'assistant' || m.role === 'thinking')
              ? {...m, isStreaming: false}
              : m,
          );
          const startedAt = Date.now();
          const isForce = !!(msg as any).forceCommand;

          // A `!command` / `!!command` already rendered an OPTIMISTIC bash bubble
          // locally at send time (so it appeared instantly, without waiting for
          // this server round-trip). Reconcile onto the OLDEST such pending bubble
          // instead of appending a duplicate: adopt the real startedAt and drop
          // the optimistic flag, keeping any output the user's bubble may already
          // carry empty (tool_update/tool_end will fill it). Fall back to append
          // when there is no pending optimistic bubble (agent tool call, or the
          // optimistic one was already reconciled).
          if (isForce) {
            const pending = finalizedMessages.find(
              (m: ChatMessage) =>
                m.role === 'tool' && m.optimistic && m.isStreaming,
            );
            if (pending) {
              return {
                ...s,
                messages: finalizedMessages.map((m: ChatMessage) =>
                  m.id === pending.id
                    ? {
                        ...m,
                        optimistic: false,
                        toolName: msg.toolName,
                        toolArgs,
                        content: toolArgs
                          ? `$ ${msg.toolName} ${toolArgs}`
                          : `$ ${msg.toolName}`,
                        startedAt,
                        timestamp: startedAt,
                        forceCommand: true,
                      }
                    : m,
                ),
              };
            }
          }

          const newMsg: ChatMessage = {
            id: this.generateId(),
            role: 'tool',
            content: toolArgs
              ? `$ ${msg.toolName} ${toolArgs}`
              : `$ ${msg.toolName}`,
            timestamp: startedAt,
            isStreaming: true,
            toolName: msg.toolName,
            toolArgs: toolArgs,
            toolOutput: '',
            startedAt,
            ...(isForce ? { forceCommand: true } : {}),
          };
          return {
            ...s,
            messages: [...finalizedMessages, newMsg],
          };
        });
        break;

      case 'tool_update': {
        this.stateStore.update((s: WhereverState) => {
          const toolMsg = [...s.messages]
            .reverse()
            .find(
              (m: ChatMessage) =>
                m.role === 'tool' &&
                m.toolName === msg.toolName &&
                m.isStreaming,
            );
          if (toolMsg) {
            return {
              ...s,
              messages: s.messages.map((m: ChatMessage) =>
                m.id === toolMsg.id
                  ? {
                      ...m,
                      content: m.content.includes('\n')
                        ? m.content + msg.delta
                        : `${m.content}\n${msg.delta}`,
                      toolOutput: `${m.toolOutput}${msg.delta}`,
                    }
                  : m,
              ),
            };
          }
          return s;
        });
        break;
      }

      case 'tool_end': {
        const result = msg.result ? `${msg.result}` : '';
        // An abort (e.g. the web "abort" button killed the tool mid-run) surfaces
        // as isError with a trailing "...aborted" status. That is not a tool
        // FAILURE, so render it as the neutral interrupted state, not a red
        // error.
        const aborted = !!msg.isError && this.isAbortedToolResult(result);
        const effectiveIsError = !!msg.isError && !aborted;
        const toolImages =
          Array.isArray(msg.images) && msg.images.length > 0
            ? msg.images
            : undefined;
        this.stateStore.update((s: WhereverState) => {
          // Claim the OLDEST still-streaming tool of this name (FIFO). Parallel
          // tool calls share a name, so matching the LAST one (or any already
          // finalized one) would let two tool_end frames land on the SAME
          // message and leave the other tool stuck streaming: it would then be
          // finalized by the 'aborted'/agent_end sweep with no result and render
          // as a bogus green success. Preferring a streaming message means each
          // tool_end settles a distinct in-flight call. Fall back to the newest
          // non-error tool of this name only if none are still streaming.
          const toolMsg =
            s.messages.find(
              (m: ChatMessage) =>
                m.role === 'tool' &&
                m.toolName === msg.toolName &&
                m.isStreaming,
            ) ??
            [...s.messages]
              .reverse()
              .find(
                (m: ChatMessage) =>
                  m.role === 'tool' &&
                  m.toolName === msg.toolName &&
                  !m.content.startsWith('Tool error:'),
              );
          const endedAt = Date.now();
          if (toolMsg) {
            const errorPrefix = effectiveIsError ? 'Error: ' : '';
            return {
              ...s,
              messages: s.messages.map((m: ChatMessage) =>
                m.id === toolMsg.id
                  ? {
                      ...m,
                      content: `${errorPrefix}${m.content}\n${result}`,
                      isStreaming: false,
                      isError: effectiveIsError,
                      interrupted: aborted,
                      toolOutput: result,
                      ...(toolImages ? {images: toolImages} : {}),
                      endedAt,
                    }
                  : m,
              ),
            };
          } else {
            const content = effectiveIsError
              ? `Tool error: ${msg.toolName}\n${result}`
              : `${msg.toolName}\n${result}`;
            const message: ChatMessage = {
              id: this.generateId(),
              role: 'tool',
              content,
              timestamp: endedAt,
              isStreaming: false,
              toolName: msg.toolName,
              toolArgs: '',
              toolOutput: result,
              ...(toolImages ? {images: toolImages} : {}),
              isError: effectiveIsError,
              interrupted: aborted,
              endedAt,
            };
            return {
              ...s,
              messages: [...s.messages, message],
            };
          }
        });
        break;
      }

      case 'aborted': {
        const abortedAt = Date.now();
        this.stateStore.update((s: WhereverState) => ({
          ...s,
          isStreaming: false,
          messages: s.messages.map((m: ChatMessage) =>
            m.isStreaming
              ? {
                  ...m,
                  isStreaming: false,
                  // A tool still streaming when the turn is aborted was killed
                  // with no result: mark it interrupted (neutral), never leave
                  // it to fall through to a green success tick. Assistant/
                  // thinking messages just stop streaming.
                  ...(m.role === 'tool' ? {interrupted: true} : {}),
                  endedAt:
                    m.role === 'tool' && m.endedAt === undefined
                      ? abortedAt
                      : m.endedAt,
                }
              : m,
          ),
        }));
        break;
      }

      case 'session_created': {
        // Guard against a SUPERSEDED load. While a session was slow to load, the
        // user tapping a different session (or creating a new one) must win: a
        // late session_created for the abandoned load must not clobber what the
        // user is now looking at. A session_created is accepted only when it is
        // the reply we are actually waiting on:
        //   - a session_load we issued -> matches pendingLoadFile, by FILE or by
        //     ID (a load may be requested by session ID, e.g. the URL-hash deep
        //     link `/#<sessionId>`; the server resolves it and always replies
        //     with the resolved FILE, so a file-only comparison would reject the
        //     load's own reply and hang the "Loading session..." spinner), OR
        //   - a session_new we issued  -> creatingSession is true (its target
        //     file is unknown until this reply, so pendingLoadFile is null).
        // Anything else (pendingLoadFile set but a different file; or no pending
        // load/create at all yet a file different from the active one) is an
        // out-of-date or unsolicited reply and is dropped. The load watchdog was
        // already re-armed for the current target, so ignoring a stale reply
        // cannot strand the spinner.
        {
          const st = get(this.stateStore);
          const matchesPendingLoad =
            this.pendingLoadFile !== null &&
            (msg.sessionFile === this.pendingLoadFile ||
              msg.sessionId === this.pendingLoadFile);
          const isRequestedCreate =
            this.pendingLoadFile === null && st.creatingSession;
          if (!matchesPendingLoad && !isRequestedCreate) {
            break;
          }
        }
        // This reply matches the load we were waiting on (or the create we
        // requested): the load is resolved, so stop guarding against it.
        this.pendingLoadFile = null;
        this.stateStore.update((s: WhereverState) => ({
          ...s,
          session: msg.sessionFile,
          sessionId: msg.sessionId,
          activeSessionFile: msg.sessionFile,
          activeCwd: msg.cwd,
          activeModel: msg.model,
          isStreaming: msg.isStreaming ?? false,
          creatingSession: false,
          // The server forces read-only for sessions in a configured
          // sessions.readOnly folder (observe-only fleet view) AND, transiently,
          // for a folder conflict until the user clicks "Continue anyway".
          readOnly: msg.readOnly ?? false,
          // Folder-conflict warning banner. Set when attaching to a session in a
          // folder that already has another active session. `continued` starts
          // false (composer stays read-only, banner offers "Continue anyway");
          // `active` is refreshed by live folder_conflict updates.
          folderConflict: msg.folderConflict
            ? {cwd: msg.cwd, active: true, continued: false}
            : null,
          // The session's working folder is gone from this machine: the server
          // built no agent and refuses every send, so the composer is replaced
          // by a notice naming the path. Hard (no "Continue anyway"); the
          // authoritative `folder_missing` frame follows with the same cwd.
          folderMissing: msg.folderMissing ? {cwd: msg.cwd} : null,
          // pending -> the history is painted now but the live agent is still
          // building; keep the composer disabled (agentPending) until
          // session_ready. A non-pending create (new session, warm reload) is
          // immediately sendable.
          agentPending: msg.pending === true,
          // Initial context-usage snapshot for the new session (null if unknown;
          // live updates arrive via 'context_usage').
          contextUsage: msg.contextUsage ?? null,
          // Reset skill-command autocomplete for the newly attached session; the
          // authoritative list is (re-)requested just below (already-live
          // session) or on session_ready (cold, still-building agent).
          skills: [],
        }));
        // A session that is ALREADY live -- a brand-new session (session_new) or
        // a warm attach -- has its agent (and resource loader) right now, but a
        // brand-new session never emits session_ready, so waiting for that alone
        // left `/skill:` autocomplete empty on a fresh session. Request the list
        // here whenever the agent is not pending; re-requesting is safe (the
        // server always replies with the full list).
        if (msg.pending !== true && msg.sessionId) {
          this.send({type: 'skills_request', sessionId: msg.sessionId});
        }
        break;
      }

      case 'session_ready':
        // The live agent finished building for a previously-pending load. Enable
        // the composer and refresh the now-authoritative model/streaming/usage.
        this.stateStore.update((s: WhereverState) => {
          // Ignore a stale ready for a session we already switched away from.
          if (msg.sessionFile && s.activeSessionFile && msg.sessionFile !== s.activeSessionFile) {
            return s;
          }
          return {
            ...s,
            agentPending: false,
            activeModel: msg.model ?? s.activeModel,
            isStreaming: msg.isStreaming ?? s.isStreaming,
            contextUsage: msg.contextUsage ?? s.contextUsage,
          };
        });
        // The live agent (with its resource loader) now exists, so its skill
        // commands are resolvable. Ask for them to populate `/skill:` composer
        // autocomplete. Safe to re-request; the server replies with the full list.
        {
          const sid = get(this.stateStore).sessionId;
          if (sid) this.send({ type: 'skills_request', sessionId: sid });
        }
        break;

      case 'skills_list':
        // The set of `/skill:<name>` commands for the active session. Replace
        // outright; ignore a list for a session we already switched away from.
        this.stateStore.update((s: WhereverState) => {
          if (s.sessionId && msg.sessionId && s.sessionId !== msg.sessionId) return s;
          return { ...s, skills: Array.isArray(msg.skills) ? msg.skills : [] };
        });
        break;

      case 'context_usage':
        this.stateStore.update((s: WhereverState) => ({
          ...s,
          contextUsage: msg.contextUsage ?? null,
        }));
        break;

      case 'session_notice':
        // A non-fatal notice for the active session (e.g. a CLI took over while
        // this session was mid-turn here, discarding the in-flight tool call or
        // streaming reply). Keep the session attached; surface it as a
        // dismissible banner. Ignore a notice for a session we switched away from.
        this.stateStore.update((s: WhereverState) => {
          if (s.sessionId && msg.sessionId && s.sessionId !== msg.sessionId) return s;
          return { ...s, notice: { level: msg.level, message: msg.message } };
        });
        break;

      case 'bash_sudo_prompt':
        // A `!sudo ...` command on the server needs a password before it can
        // run. Surface a masked prompt for the active session only; ignore a
        // prompt for a session we already switched away from.
        this.stateStore.update((s: WhereverState) => {
          if (s.sessionId && msg.sessionId && s.sessionId !== msg.sessionId) return s;
          return {
            ...s,
            sudoPrompt: {
              promptId: msg.promptId,
              command: msg.command,
              sessionId: msg.sessionId,
            },
          };
        });
        break;

      case 'session_destroyed':
        this.stateStore.update((s: WhereverState) => {
          if (s.sessionId === msg.sessionId) {
            return {
              ...s,
              messages: [],
              session: null,
              sessionId: null,
              activeSessionFile: null,
              activeCwd: null,
              activeModel: null,
              loadingSession: false,
              agentPending: false,
              folderMissing: null,
              notice: null,
              sudoPrompt: null,
            };
          }
          return s;
        });
        break;

      case 'session_error':
        this.stateStore.update((s: WhereverState) => ({
          ...s,
          sessionError: msg.error,
          isStreaming: false,
          creatingSession: false,
          loadingSession: false,
          resyncing: false,
          // A failed (cold) agent build clears pending: the session stays
          // readable, but sending remains blocked (no live agent) and the error
          // is surfaced. This is the degrade-to-read-only path.
          agentPending: false,
        }));
        break;

      case 'folder_missing':
        // The server states, authoritatively, that this session's working folder
        // does not exist on this machine, and names the absolute path. No
        // session_ready is coming (no agent was built), so this is also the end
        // of the load: read-only, with an explanation. Ignore a frame for a
        // session we already switched away from.
        this.stateStore.update((s: WhereverState) => {
          if (s.sessionId && msg.sessionId && s.sessionId !== msg.sessionId) return s;
          return {...s, readOnly: true, folderMissing: {cwd: msg.cwd}};
        });
        break;

      case 'folder_conflict':
        // Live update of whether another active session still exists in this
        // client's folder. The banner appears when a second session shows up in
        // the folder and disappears once it is gone. Applies only to the client's
        // OWN folder; a stale update for a different cwd is ignored.
        this.stateStore.update((s: WhereverState) => {
          if (!s.sessionId) return s;
          if (s.activeCwd && msg.cwd !== s.activeCwd) return s;
          // The server re-evaluates this client's read-only state on every
          // conflict update, so mirror it when reported. This is what releases
          // the composer once the conflict resolves (the banner alone cannot: it
          // disappears, taking its "Continue anyway" button with it) and what
          // keeps a hard sessions.readOnly folder locked. Older servers omit the
          // field, leaving read-only untouched as before.
          const readOnly = msg.readOnly ?? s.readOnly;
          if (!msg.active) {
            // No other session remains: fully resolved, drop the banner.
            return s.folderConflict || readOnly !== s.readOnly
              ? {...s, folderConflict: null, readOnly}
              : s;
          }
          if (s.folderConflict) {
            // Already showing: just refresh, preserving the user's `continued`
            // choice (so we don't re-disable a composer they already enabled).
            return {
              ...s,
              readOnly,
              folderConflict: {...s.folderConflict, cwd: msg.cwd, active: true},
            };
          }
          // A conflict appeared AFTER we were already attached (another client
          // opened a second session in our folder). Raise the banner. We were
          // sending fine until now, so treat it as already-`continued` rather
          // than yanking the composer into read-only underneath the user.
          return {
            ...s,
            readOnly,
            folderConflict: {cwd: msg.cwd, active: true, continued: true},
          };
        });
        break;

      case 'session_interrupted':
        this.stateStore.update((s: WhereverState) => ({
          ...s,
          isInterrupted: true,
          readOnly: true,
          messages: [],
          session: null,
          sessionId: null,
          activeSessionFile: null,
          activeCwd: null,
          activeModel: null,
          creatingSession: false,
          loadingSession: false,
          agentPending: false,
          notice: null,
          sudoPrompt: null,
        }));
        break;

      case 'message_history': {
        // Drop history for a session we already switched away from. session_created
        // sets sessionId for the load we accepted; a message_history whose
        // sessionId does not match belongs to a superseded load (a slow session A
        // that finished after the user tapped session B) and must not repaint the
        // now-active conversation. Only guard once we actually have an active
        // sessionId (the initial load has none yet until its own created lands).
        {
          const active = get(this.stateStore).sessionId;
          if (active && msg.sessionId && msg.sessionId !== active) {
            break;
          }
        }
        // The server transcript is authoritative for what was actually persisted.
        // Reconcile it against any unconfirmed outbound messages: keep the ones
        // that ARE in history (delivered), and re-surface the ones that are NOT
        // as recoverable 'failed' items so a message a half-open socket swallowed
        // is never silently lost across a reload/resync.
        const sessionIdForPending = msg.sessionId as string;
        // Carry-over from the CURRENT store (this-tab sends still in flight) plus
        // anything a PREVIOUS tab persisted before a reload.
        const inFlight = get(this.stateStore).messages.filter(
          (m) => m.role === 'user' && m.delivery !== undefined,
        );
        const persisted = this.loadPersistedPending(sessionIdForPending);
        const candidates = [...persisted, ...inFlight];
        this.stateStore.update((s: WhereverState) => {
          const mapped = this.mapHistory(msg.messages, msg.sessionId, s.isStreaming);
          const totalCount =
            typeof msg.totalCount === 'number' ? msg.totalCount : mapped.length;
          const offset = typeof msg.offset === 'number' ? msg.offset : 0;
          const historyContents = new Set(
            mapped.filter((m) => m.role === 'user').map((m) => m.content),
          );
          // Unconfirmed candidates whose content is NOT in the loaded history are
          // undelivered. De-dupe by content so two identical undelivered sends do
          // not multiply. Everything else the server persisted is already in
          // `mapped` (confirmed).
          const seen = new Set<string>();
          const undelivered: ChatMessage[] = [];
          for (const c of candidates) {
            if (historyContents.has(c.content)) continue;
            if (seen.has(c.content)) continue;
            seen.add(c.content);
            undelivered.push({...c, sessionId: sessionIdForPending, delivery: 'failed'});
          }
          return {
            ...s,
            messages: [...mapped, ...undelivered],
            historyTotalCount: totalCount,
            historyOffset: offset,
            loadingMoreHistory: false,
            loadingSession: false,
            resyncing: false,
          };
        });
        // Clear watchdogs for anything now confirmed, and rewrite the persisted
        // store to exactly the still-undelivered set.
        for (const c of candidates) this.clearConfirm(c.id);
        this.persistPending(sessionIdForPending);
        break;
      }

      case 'message_history_prepend':
        this.stateStore.update((s: WhereverState) => {
          // Older window prepended ahead of currently-loaded messages. No
          // streaming-tail handling here (those messages are historical).
          const older = this.mapHistory(msg.messages, msg.sessionId, false);
          const offset = typeof msg.offset === 'number' ? msg.offset : 0;
          if (older.length === 0) {
            return {...s, loadingMoreHistory: false, historyOffset: offset};
          }
          return {
            ...s,
            messages: [...older, ...s.messages],
            historyOffset: offset,
            loadingMoreHistory: false,
          };
        });
        break;

      case 'model_changed':
        this.stateStore.update((s: WhereverState) => ({
          ...s,
          activeModel: msg.model,
        }));
        break;
    }
  }

  /**
   * True when an errored tool result is the product of a USER ABORT (e.g. the
   * web "abort" button killed a running tool), rather than a genuine tool
   * failure. The pi tools append a trailing status line on abort ("Command
   * aborted" for bash, "Operation aborted" for edit/write, bare "aborted" for a
   * pre-execution abort). We match that trailing status so the UI can render a
   * neutral "interrupted" state instead of a red error: you cancelling a tool is
   * not the tool failing. Only meaningful when isError is already true; matched
   * as the LAST non-empty line to avoid false positives from command output that
   * merely contains the word "aborted".
   */
  private isAbortedToolResult(result: string | undefined): boolean {
    if (!result) return false;
    const lines = result.trimEnd().split('\n');
    const last = (lines[lines.length - 1] || '').trim();
    return /^(command|operation)?\s*aborted$/i.test(last);
  }

  /**
   * Map a server `HistoryMessage[]` window into UI `ChatMessage[]`. When
   * `applyStreamingTail` is true, the last assistant/thinking message and any
   * unmatched tool-call placeholders are marked streaming (used only for the
   * live tail window, not for prepended older history).
   */
  private mapHistory(
    rawMessages: any[],
    sessionId: string,
    applyStreamingTail: boolean,
  ): ChatMessage[] {
    const mapped: ChatMessage[] = [];
    // A tool_call is rendered IN PLACE, at its position in the stream, as a tool
    // message that is initially result-less. Its matching tool_result fills it
    // in later. We track the still-open calls per tool name as indices into
    // `mapped`, so a call that never receives a result simply stays where it was
    // issued (correctly marked interrupted below) instead of being hoisted to
    // the very end of the transcript. The end-hoisting was the bug: dangling
    // tool calls from EARLIER in the conversation (e.g. an interrupted long-
    // running bash, later superseded by a new user turn) would all pile up as a
    // "series of aborted tool calls" AFTER the latest reply, even though the CLI
    // shows them inline where they happened.
    //
    // Matching is by tool-call id when present (the server forwards it on both
    // tool_call and tool_result), which pairs a result to its EXACT call even
    // when same-named calls interleave with some left dangling. When the id is
    // absent (older sessions, or the synthesized bashExecution pair) we fall
    // back to oldest-open-first per tool name.
    const openCalls: Record<string, number[]> = {};
    const openById: Record<string, number> = {};

    // Drop a resolved call's index from the name-FIFO list so an id match and a
    // later name-fallback can never both consume the same call.
    const removeFromNameQueue = (tName: string, idx: number) => {
      const q = openCalls[tName];
      if (!q) return;
      const at = q.indexOf(idx);
      if (at !== -1) q.splice(at, 1);
    };

    for (const m of rawMessages) {
      if (m.role === 'tool_call') {
        const tName = m.toolName || 'unknown';
        const args = m.content || '';
        const idx = mapped.length;
        mapped.push({
          id: this.generateId(),
          role: 'tool',
          content: args ? `$ ${tName} ${args}` : `$ ${tName}`,
          timestamp: m.timestamp,
          // No result yet. Marked as interrupted below if it stays unmatched;
          // the streaming tail promotes the last one back to streaming.
          isStreaming: false,
          toolName: tName,
          toolArgs: args,
          toolOutput: '',
          sessionId,
          // Keep the start so a matched result (or a still-running streaming
          // tail) can show a coherent duration / "Elapsed".
          ...(Number.isFinite(m.timestamp) ? {startedAt: m.timestamp} : {}),
          // Carry the force-command marker from history so a `!command` bash
          // tool call auto-expands on reload just like it does live.
          ...((m as any).forceCommand ? {forceCommand: true} : {}),
        });
        if (!openCalls[tName]) openCalls[tName] = [];
        openCalls[tName].push(idx);
        if (typeof m.toolCallId === 'string' && m.toolCallId) {
          openById[m.toolCallId] = idx;
        }
      } else if (m.role === 'tool_result') {
        const tName = m.toolName || 'unknown';
        // Prefer an exact id match; else fill the OLDEST still-open call of this
        // name (FIFO), mirroring how parallel same-named calls resolve in order.
        let callIdx: number | undefined;
        if (
          typeof m.toolCallId === 'string' &&
          m.toolCallId &&
          openById[m.toolCallId] !== undefined
        ) {
          callIdx = openById[m.toolCallId];
          delete openById[m.toolCallId];
          removeFromNameQueue(tName, callIdx);
        } else if (openCalls[tName] && openCalls[tName].length > 0) {
          callIdx = openCalls[tName].shift()!;
          // Keep openById consistent if this call had also registered an id.
          for (const [id, i] of Object.entries(openById)) {
            if (i === callIdx) delete openById[id];
          }
        }
        const isError = m.isError && !this.isAbortedToolResult(m.content);
        const interrupted = !!m.isError && this.isAbortedToolResult(m.content);
        if (callIdx !== undefined) {
          const call = mapped[callIdx];
          const tArgs = call.toolArgs || '';
          const startedAt = call.startedAt;
          mapped[callIdx] = {
            ...call,
            content: tArgs
              ? `$ ${tName} ${tArgs}\n${m.content}`
              : `$ ${tName}\n${m.content}`,
            isStreaming: false,
            toolOutput: m.content,
            ...(Array.isArray(m.images) && m.images.length > 0
              ? {images: m.images}
              : {}),
            // A user abort surfaces as an errored result with a trailing
            // "...aborted" status. Render it as interrupted (neutral), not a red
            // error: aborting a tool is not the tool failing.
            isError,
            interrupted,
            timestamp: m.timestamp,
            // Duration only when both timestamps are finite and coherent
            // (end >= start); otherwise leave unset rather than show a bogus one.
            ...(startedAt !== undefined &&
            Number.isFinite(startedAt) &&
            Number.isFinite(m.timestamp) &&
            m.timestamp >= startedAt
              ? {endedAt: m.timestamp}
              : {}),
          };
        } else {
          // A result with no preceding open call (shouldn't normally happen).
          // Render it in place as a standalone tool message so nothing is lost.
          mapped.push({
            id: this.generateId(),
            role: 'tool',
            content: `$ ${tName}\n${m.content}`,
            timestamp: m.timestamp,
            isStreaming: false,
            toolName: tName,
            toolArgs: '',
            toolOutput: m.content,
            ...(Array.isArray(m.images) && m.images.length > 0
              ? {images: m.images}
              : {}),
            isError,
            interrupted,
            sessionId,
          });
        }
      } else {
        mapped.push({
          id: this.generateId(),
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          isStreaming: false,
          toolName: m.toolName,
          sessionId,
          // Carry the source entry id (set on user messages by the server) so the
          // UI can offer "Fork from here" on each user message.
          ...(typeof m.entryId === 'string' && m.entryId ? {entryId: m.entryId} : {}),
        });
      }
    }

    // Any call still open (issued a toolCall, never got a tool_result) is FROZEN
    // in place with no result. Meaning depends on context:
    //   - streaming tail (applyStreamingTail): only the MOST RECENT open call is
    //     plausibly still running; keep it streaming so the UI ticks "Elapsed".
    //     Earlier open calls in the same window are already superseded and are
    //     interrupted.
    //   - otherwise: its outcome is unknown (e.g. a CLI takeover / interruption
    //     killed it mid-run), so mark it `interrupted` for a neutral "no result"
    //     state instead of a bogus green success tick.
    const allOpen: number[] = [];
    for (const idxs of Object.values(openCalls)) allOpen.push(...idxs);
    allOpen.sort((a, b) => a - b);
    const lastOpenIdx =
      applyStreamingTail && allOpen.length > 0
        ? allOpen[allOpen.length - 1]
        : -1;
    for (const idx of allOpen) {
      if (idx === lastOpenIdx) {
        mapped[idx] = {...mapped[idx], isStreaming: true};
      } else {
        mapped[idx] = {...mapped[idx], interrupted: true};
      }
    }

    if (applyStreamingTail && mapped.length > 0) {
      const lastIndex = mapped.length - 1;
      const lastMsg = mapped[lastIndex];
      if (lastMsg.role === 'assistant' || lastMsg.role === 'thinking') {
        mapped[lastIndex] = {
          ...lastMsg,
          isStreaming: true,
        };
      }
    }

    return mapped;
  }

  /**
   * Request the previous window of older history for the active session.
   * No-op when there is nothing older to load or a request is already in
   * flight.
   */
  public loadMoreHistory() {
    const s = get(this.stateStore);
    if (!s.sessionId) return;
    if (s.loadingMoreHistory) return;
    if (s.historyOffset <= 0) return;
    this.stateStore.update((st: WhereverState) => ({
      ...st,
      loadingMoreHistory: true,
    }));
    this.send({
      type: 'history_load_more',
      sessionId: s.sessionId,
      beforeOffset: s.historyOffset,
    });
  }

  // Returns true only when the frame was actually handed to an OPEN socket.
  // A non-OPEN (null / CONNECTING / CLOSING / half-open) socket silently
  // dropping the frame is what made messages vanish: they rendered locally but
  // never reached the server, so they were gone after a reload. Callers that
  // carry user intent (sendMessage) must check this and surface the failure.
  public send(msg: any): boolean {
    if (this.ws && this.ws.readyState === 1 /* OPEN */) {
      try {
        this.ws.send(JSON.stringify(msg));
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  // Build the outbound `message` frame. The optional conversationMode flag is the
  // per-turn spoken-conversation SIGNAL: it is a FIELD on this existing payload
  // (no new message type), and it is OMITTED when off so a normal send is
  // byte-identical to before and an older server simply ignores it.
  private messageFrame(text: string, sessionId: string, options?: SendMessageOptions) {
    return {
      type: 'message',
      message: text,
      sessionId,
      ...(options?.conversationMode ? {conversationMode: true} : {}),
    };
  }

  // Returns true only if the message actually went out over an OPEN socket.
  // Callers MUST use the return value to decide whether to clear the input:
  // clearing on a false return is what loses the user's text on a dropped send.
  //
  // `options.conversationMode` tells the agent, for this turn only, that a spoken
  // conversation is active (so it also emits a short `say` reply). The caller owns
  // that decision: the web app stamps it from its conversation-mode knobs.
  public sendMessage(text: string, options?: SendMessageOptions): boolean {
    const s = get(this.stateStore);
    if (!s.sessionId) return false;

    // The session's transcript is loaded but its live agent is still building
    // (cold, fast-first load). Reading is fine; sending is not possible yet, and
    // a message sent now would have no agent to receive it. Surface a clear,
    // recoverable hint and keep the text (the composer is disabled anyway, but a
    // programmatic caller could still reach here).
    if (s.agentPending) {
      this.stateStore.update((st: WhereverState) => ({
        ...st,
        sessionError:
          st.sessionError ?? 'Preparing the session agent; please wait a moment, then resend.',
      }));
      return false;
    }

    // Guard against sending on a dead / half-open socket. getIsConnected()
    // checks the real readyState (not the store's connected flag, which can lag
    // a half-open socket the liveness watchdog has not reaped yet). Sending here
    // would be silently dropped, the message would appear locally, then vanish
    // on reload. Surface a recoverable error and make sure we are reconnecting
    // instead of optimistically rendering a message that never left.
    if (!this.getIsConnected()) {
      this.stateStore.update((st: WhereverState) => ({
        ...st,
        sessionError:
          'Not connected to the relay; your message was not sent. Reconnecting, then please resend.',
      }));
      if (!this.ws && !this.reconnectTimer) {
        this.scheduleReconnect();
      }
      return false;
    }

    // Send first; only commit the optimistic local echo + clear the error once
    // the frame is confirmed handed to an OPEN socket. This way a send that
    // fails (a narrow race between the readyState check and send) leaves no
    // phantom local message and keeps the input intact for the caller to retry.
    const ok = this.send(this.messageFrame(text, s.sessionId, options));
    if (!ok) {
      this.stateStore.update((st: WhereverState) => ({
        ...st,
        sessionError:
          'Message failed to send (connection dropped). Please resend once reconnected.',
      }));
      return false;
    }

    // A `!command` / `!!command` is intercepted by the server and run as a bash
    // tool call, NOT delivered to the agent. The server never echoes it back as a
    // user message, and the bash tool_start/tool_end events are the real, durable
    // feedback (and are recorded in history). So do NOT add any local USER echo
    // for it: a user bubble here would be a transient duplicate that vanishes on
    // reload (bash runs are not part of the user-message transcript) and, if
    // delivery-tracked, would wrongly time out into a retry/discard banner.
    //
    // We DO, however, render an optimistic bash TOOL bubble immediately so the
    // command shows up instantly instead of only after the server round-trip
    // (client -> server -> tool_start -> client). It is tagged `optimistic` so
    // the real `tool_start` reconciles onto it (no duplicate) and is NOT
    // delivery-tracked (no watchdog/banner). Skip the optimistic bubble for
    // `!sudo ...`: the server defers those behind a password prompt and does not
    // emit `tool_start` until the password arrives, so a pending bubble would sit
    // there streaming (and never reconcile if the prompt is cancelled).
    if (text.trimStart().startsWith('!')) {
      const raw = text.trimStart();
      const isExcluded = raw.startsWith('!!');
      const command = (isExcluded ? raw.slice(2) : raw.slice(1)).trim();
      const isSudo = /^sudo(\s|$)/.test(command);
      if (command && !isSudo) {
        const toolArgs = `command=${JSON.stringify(command)}`;
        const startedAt = Date.now();
        const optimisticTool: ChatMessage = {
          id: this.generateId(),
          role: 'tool',
          content: `$ bash ${toolArgs}`,
          timestamp: startedAt,
          isStreaming: true,
          toolName: 'bash',
          toolArgs,
          toolOutput: '',
          startedAt,
          forceCommand: true,
          optimistic: true,
        };
        this.stateStore.update((st: WhereverState) => ({
          ...st,
          sessionError: null,
          messages: [...st.messages, optimisticTool],
        }));
        return true;
      }
      this.stateStore.update((st: WhereverState) => ({...st, sessionError: null}));
      return true;
    }

    // The frame was handed to an OPEN socket, but that is NOT proof of delivery:
    // a half-open TCP connection accepts send() (buffers locally, no throw) yet
    // the bytes never reach the server. So commit the echo as delivery:'sending'
    // (unconfirmed) and arm a watchdog + persist it, so it is recoverable on
    // reload and flips to 'failed' if the server never echoes it back.
    const message: ChatMessage = {
      id: this.generateId(),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      isStreaming: false,
      sessionId: s.sessionId,
      delivery: 'sending',
    };
    this.stateStore.update((st: WhereverState) => ({
      ...st,
      sessionError: null,
      messages: [...st.messages, message],
    }));
    this.armConfirm(message.id);
    this.persistPending(s.sessionId);
    return true;
  }

  // Re-materialize queued steers the message list does not have. A queued
  // message lives ONLY in the agent's memory until pi injects it at the next
  // step: it is not in the session file, so message_history cannot contain it.
  // On attach (a reload, or a second device) the server sends the queue as a
  // snapshot; without this the text would be invisible until it was delivered,
  // even though it was still going to be sent. Any queued entry with no matching
  // user message is appended so the UI can render it with the "Queued" badge and
  // the session-level cancel.
  //
  // Matching is by CONTENT, because the queue is a list of strings (pi exposes
  // no per-entry id). Occurrences are COUNTED, so a text queued twice restores
  // two bubbles, and a locally-sent (optimistic) steer already on screen is not
  // duplicated by the snapshot that follows it.
  private withRestoredQueuedMessages(
    messages: ChatMessage[],
    steering: string[],
  ): ChatMessage[] {
    if (steering.length === 0) return messages;
    const have = new Map<string, number>();
    for (const m of messages) {
      if (m.role !== 'user') continue;
      have.set(m.content, (have.get(m.content) ?? 0) + 1);
    }
    const restored: ChatMessage[] = [];
    for (const text of steering) {
      const remaining = have.get(text) ?? 0;
      if (remaining > 0) {
        have.set(text, remaining - 1);
        continue;
      }
      restored.push({
        id: this.generateId(),
        role: 'user',
        content: text,
        timestamp: Date.now(),
        isStreaming: false,
        restoredFromQueue: true,
        // NOT delivery-tracked: the server already holds this message, so it is
        // delivered as far as we are concerned. Tagging it pending would arm a
        // confirmation watchdog and wrongly offer "Retry" for a message that is
        // queued and will be sent.
      });
    }
    return restored.length > 0 ? [...messages, ...restored] : messages;
  }

  // ==========================================================================
  // Outbound-message delivery confirmation + recovery.
  //
  // An optimistic user echo is unconfirmed until the server echoes it back. This
  // machinery makes an unconfirmed message survive a reload and surface a retry
  // affordance instead of being silently lost when a half-open socket swallowed
  // the frame.
  // ==========================================================================

  private pendingKey(sessionId: string): string {
    return WhereverClient.PENDING_PREFIX + sessionId;
  }

  // Persist the current session's still-unconfirmed (delivery-tagged) user
  // messages so a reload can recover them. Cleared to empty when none remain.
  private persistPending(sessionId: string | null): void {
    if (!sessionId || typeof localStorage === 'undefined') return;
    const pending = get(this.stateStore).messages.filter(
      (m) => m.role === 'user' && m.delivery !== undefined,
    );
    try {
      if (pending.length === 0) {
        localStorage.removeItem(this.pendingKey(sessionId));
      } else {
        localStorage.setItem(
          this.pendingKey(sessionId),
          JSON.stringify(
            pending.map((m) => ({
              id: m.id,
              content: m.content,
              timestamp: m.timestamp,
              // Persist as 'failed': a reload cannot know if it ever landed, so
              // it must be presented as needs-attention, never as delivered.
              delivery: 'failed' as const,
            })),
          ),
        );
      }
    } catch {}
  }

  // Load persisted unconfirmed messages for a session (used on load/resync to
  // re-surface anything a previous tab left in limbo).
  private loadPersistedPending(sessionId: string): ChatMessage[] {
    if (typeof localStorage === 'undefined') return [];
    try {
      const raw = localStorage.getItem(this.pendingKey(sessionId));
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((m) => m && typeof m.content === 'string')
        .map((m) => ({
          id: typeof m.id === 'string' ? m.id : this.generateId(),
          role: 'user' as const,
          content: m.content,
          timestamp: typeof m.timestamp === 'number' ? m.timestamp : Date.now(),
          isStreaming: false,
          sessionId,
          delivery: 'failed' as const,
        }));
    } catch {
      return [];
    }
  }

  private armConfirm(messageId: string): void {
    this.clearConfirm(messageId);
    if (typeof setTimeout !== 'function') return;
    const timer = setTimeout(() => {
      this.confirmTimers.delete(messageId);
      // Still unconfirmed after the window: mark it failed so the UI offers a
      // retry. Delivery is genuinely uncertain (a half-open socket may have
      // eaten it), so we do NOT auto-resend: that risks a duplicate. The user
      // decides.
      let sessionId: string | null = null;
      this.stateStore.update((st: WhereverState) => {
        const m = st.messages.find((x) => x.id === messageId);
        if (!m || m.delivery !== 'sending') return st;
        sessionId = st.sessionId;
        return {
          ...st,
          messages: st.messages.map((x) =>
            x.id === messageId ? {...x, delivery: 'failed'} : x,
          ),
        };
      });
      if (sessionId) this.persistPending(sessionId);
    }, WhereverClient.CONFIRM_MS);
    if (timer && typeof (timer as any).unref === 'function') {
      (timer as any).unref();
    }
    this.confirmTimers.set(messageId, timer);
  }

  private clearConfirm(messageId: string): void {
    const t = this.confirmTimers.get(messageId);
    if (t) {
      clearTimeout(t);
      this.confirmTimers.delete(messageId);
    }
  }

  // Mark the oldest still-unconfirmed user message with this content as
  // delivered (the server echoed it back). Content-matched because the server
  // echo carries no client message id. Returns true if one was confirmed.
  //
  // Skill invocations need a looser match: the client optimistically echoes the
  // RAW `/skill:<name> <args>`, but the server echoes the EXPANDED skill block
  // (pi inlines the skill body before storing/echoing). Exact-content matching
  // would miss, leaving the raw bubble orphaned as "failed" AND appending the
  // expanded echo as a duplicate. So fall back to matching a pending message
  // whose skill-invocation IDENTITY (name + args) equals the echo's, and REWRITE
  // its content to the confirmed (expanded) form so it renders as the skill chip
  // and the server's own echo is then deduped against it.
  private confirmDeliveredByContent(content: string): boolean {
    let confirmedId: string | null = null;
    let sessionId: string | null = null;
    const echoIdentity = skillInvocationIdentity(content);
    this.stateStore.update((st: WhereverState) => {
      let target = st.messages.find(
        (m) => m.role === 'user' && m.delivery !== undefined && m.content === content,
      );
      // Skill-identity fallback: match the RAW optimistic echo to this EXPANDED
      // server echo when they are the same invocation.
      if (!target && echoIdentity) {
        target = st.messages.find(
          (m) =>
            m.role === 'user' &&
            m.delivery !== undefined &&
            skillInvocationIdentity(m.content) === echoIdentity,
        );
      }
      if (!target) return st;
      confirmedId = target.id;
      sessionId = st.sessionId;
      return {
        ...st,
        messages: st.messages.map((m) =>
          m.id === target!.id
            ? {
                ...m,
                delivery: undefined,
                // Adopt the expanded content so the skill chip renders (and the
                // server's message_end echo dedupes against it instead of
                // appending a second bubble).
                ...(echoIdentity ? {content} : {}),
              }
            : m,
        ),
      };
    });
    if (confirmedId) {
      this.clearConfirm(confirmedId);
      this.persistPending(sessionId);
      return true;
    }
    return false;
  }

  // Retry a failed (or sending) outbound message: re-send its frame and re-arm
  // confirmation. Returns false if it could not be handed to an OPEN socket (the
  // message stays failed/recoverable).
  //
  // A resend starts a FRESH turn, so the caller re-stamps the per-turn
  // conversation-mode signal from the knobs as they are NOW (the mode may have
  // been flipped since the original send).
  public resendMessage(messageId: string, options?: SendMessageOptions): boolean {
    const s = get(this.stateStore);
    const m = s.messages.find((x) => x.id === messageId && x.role === 'user');
    if (!m || !s.sessionId) return false;
    if (!this.getIsConnected()) {
      if (!this.ws && !this.reconnectTimer) this.scheduleReconnect();
      return false;
    }
    const ok = this.send(this.messageFrame(m.content, s.sessionId, options));
    if (!ok) return false;
    this.stateStore.update((st: WhereverState) => ({
      ...st,
      sessionError: null,
      messages: st.messages.map((x) =>
        x.id === messageId ? {...x, delivery: 'sending', timestamp: Date.now()} : x,
      ),
    }));
    this.armConfirm(messageId);
    this.persistPending(s.sessionId);
    return true;
  }

  // Drop a failed outbound message the user chooses not to resend. Removes it
  // from the transcript and from the persisted-pending store.
  public discardMessage(messageId: string): void {
    let sessionId: string | null = null;
    this.clearConfirm(messageId);
    this.stateStore.update((st: WhereverState) => {
      sessionId = st.sessionId;
      return {
        ...st,
        messages: st.messages.filter((m) => m.id !== messageId),
      };
    });
    if (sessionId) this.persistPending(sessionId);
  }

  public abort() {
    const s = get(this.stateStore);
    if (!s.sessionId) return;
    this.send({type: 'abort', sessionId: s.sessionId});
  }

  // Cancel the queued mid-stream steer messages for the active session without
  // aborting the in-flight turn. Optimistically clears our local pending-steer
  // set so the "Cancel" affordance disappears immediately; the server's fresh
  // queue_update (after clearQueue) reconciles the authoritative state.
  public cancelSteer(): void {
    const s = get(this.stateStore);
    if (!s.sessionId) return;
    this.send({type: 'cancel_steer', sessionId: s.sessionId});
    this.stateStore.update((st: WhereverState) => ({...st, pendingSteering: []}));
  }

  public joinSession(sessionFile: string, cwd?: string, model?: string) {
    this.stateStore.update((s: WhereverState) => ({
      ...s,
      folderConflict: null,
      // Both folder verdicts belong to the session being left; the load we are
      // starting re-states its own (the server re-checks on every load).
      folderMissing: null,
      sessionError: null,
      loadingSession: true,
      agentPending: false,
    }));
    this.pendingLoadFile = sessionFile;
    this.send({type: 'session_load', sessionFile, cwd, model});
    this.armLoadWatchdog();
  }

  // Switch from the currently-active session (if any) straight to another one in
  // a single, atomic step. Leaving + loading used to be done by the UI as two
  // calls separated by a 100ms setTimeout; that gap could strand the loading
  // state (a tap landing mid-switch, a leave whose load never fired) and leave
  // the "Loading session..." spinner hanging with an open sidebar. Doing both
  // here, synchronously, means there is never an in-between state and the
  // watchdog is always (re)armed for the new load, so a superseded or lost load
  // can never strand the UI: the latest tap always wins.
  public switchSession(sessionFile: string, cwd?: string, model?: string) {
    const s = get(this.stateStore);
    // Tapping the already-active session is a no-op (don't tear it down just to
    // reload the same history).
    if (s.activeSessionFile === sessionFile && !s.loadingSession && !s.resyncing) {
      return;
    }
    if (s.sessionId) {
      this.send({type: 'session_leave', sessionId: s.sessionId});
    }
    // Reset to a clean loading state for the target session in one update so the
    // old conversation clears immediately and the spinner reflects the new load.
    this.stateStore.update((st: WhereverState) => ({
      ...st,
      messages: [],
      session: null,
      sessionId: null,
      activeSessionFile: null,
      activeCwd: null,
      activeModel: null,
      readOnly: false,
      folderConflict: null,
      folderMissing: null,
      sessionError: null,
      notice: null,
      sudoPrompt: null,
      creatingSession: false,
      resyncing: false,
      agentPending: false,
      contextUsage: null,
      pendingSteering: [],
      loadingSession: true,
    }));
    this.resumeSessionFile = null;
    this.resumeCwd = undefined;
    this.resumeModel = undefined;
    // Switching supersedes any in-flight create; disarm its watchdog so it can't
    // later fire against the newly loaded session.
    this.clearCreateWatchdog();
    this.pendingLoadFile = sessionFile;
    this.send({type: 'session_load', sessionFile, cwd, model});
    this.armLoadWatchdog();
  }

  // Fork the given session at a specific user-message entry, mirroring pi's
  // `/fork` (position 'before'). The server creates a new branched session file
  // and replies with `session_forked` (carrying the new file path + the chosen
  // message's text). The app layer listens for that reply, switches to the new
  // session, and pre-fills the composer. This method only issues the request;
  // it does not itself change the active session.
  public forkSession(sessionId: string, entryId: string): boolean {
    if (!sessionId || !entryId) return false;
    return this.send({type: 'session_fork', sessionId, entryId});
  }

  public createSession(
    cwd: string,
    model?: string,
    gitInit?: boolean,
    createRemote?: boolean,
    repoVisibility?: 'private' | 'public',
    cloneRemote?: boolean,
  ) {
    this.stateStore.update((s: WhereverState) => ({
      ...s,
      folderConflict: null,
      // Creating a session creates its folder, so no missing-folder lock can
      // survive into it.
      folderMissing: null,
      sessionError: null,
      creatingSession: true,
      loadingSession: false,
    }));
    // A new session supersedes any in-flight load: its session_created must not
    // be rejected by a stale pendingLoadFile, and a late load reply for the old
    // target must not clobber the new session.
    this.pendingLoadFile = null;
    this.send({
      type: 'session_new',
      cwd,
      model,
      gitInit,
      createRemote,
      repoVisibility,
      cloneRemote,
    });
    // Never let the blocking "Creating session..." overlay hang if the reply is
    // lost. Symmetrical with armLoadWatchdog for session_load.
    this.armCreateWatchdog();
  }

  public leaveSession() {
    const s = get(this.stateStore);
    // Leaving abandons any in-flight create too, so disarm its watchdog even when
    // there is no sessionId yet (a create that has not resolved).
    this.clearCreateWatchdog();
    if (!s.sessionId) {
      if (s.creatingSession) {
        this.stateStore.update((st: WhereverState) => ({
          ...st,
          creatingSession: false,
        }));
      }
      return;
    }
    this.send({type: 'session_leave', sessionId: s.sessionId});
    this.stateStore.update((s: WhereverState) => ({
      ...s,
      messages: [],
      session: null,
      sessionId: null,
      activeSessionFile: null,
      activeCwd: null,
      activeModel: null,
      readOnly: false,
      folderMissing: null,
      notice: null,
      sudoPrompt: null,
      creatingSession: false,
      loadingSession: false,
      resyncing: false,
      agentPending: false,
      contextUsage: null,
      pendingSteering: [],
    }));
    this.clearLoadWatchdog();
    this.pendingLoadFile = null;
    this.resumeSessionFile = null;
    this.resumeCwd = undefined;
    this.resumeModel = undefined;
  }

  // "Continue anyway" on the folder-conflict warning banner: ask the server to
  // lift read-only for this client's current session (both sessions in the
  // folder then run concurrently; the other is NOT aborted). Optimistically
  // enable the composer and mark the banner `continued` so it drops its button
  // but stays as a passive warning until the other session leaves the folder.
  public continueFolderConflict() {
    const s = get(this.stateStore);
    if (!s.folderConflict || !s.sessionId) return;
    // "Continue anyway" answers a folder CONFLICT only. A missing folder is a
    // hard lock (there is nothing to drive, and no agent was built), and the
    // server refuses to lift it, so do not flash an enabled composer here.
    if (s.folderMissing) return;

    this.send({
      type: 'folder_conflict_continue',
      sessionId: s.sessionId,
    });

    this.stateStore.update((s: WhereverState) => ({
      ...s,
      readOnly: false,
      folderConflict: s.folderConflict
        ? {...s.folderConflict, continued: true}
        : null,
    }));
  }

  public ping() {
    this.send({type: 'ping'});
  }

  public clearMessages() {
    this.stateStore.update((s: WhereverState) => ({...s, messages: []}));
  }

  public dismissSessionError() {
    this.stateStore.update((s: WhereverState) => ({...s, sessionError: null}));
  }

  public dismissNotice() {
    this.stateStore.update((s: WhereverState) => ({...s, notice: null}));
  }

  // Answer a pending `!sudo ...` prompt with the password the user typed. The
  // password is sent straight to the server (never stored in client state) and
  // the prompt is cleared. No-op if there is no matching pending prompt.
  public sendSudoPassword(password: string) {
    const s = get(this.stateStore);
    const prompt = s.sudoPrompt;
    if (!prompt) return;
    this.send({
      type: 'bash_sudo_password',
      sessionId: prompt.sessionId,
      promptId: prompt.promptId,
      password,
    });
    this.stateStore.update((st: WhereverState) => ({...st, sudoPrompt: null}));
  }

  // Dismiss a pending `!sudo ...` prompt without running the command. Tells the
  // server to drop the deferred command and clears the local prompt.
  public cancelSudoPrompt() {
    const s = get(this.stateStore);
    const prompt = s.sudoPrompt;
    this.stateStore.update((st: WhereverState) => ({...st, sudoPrompt: null}));
    if (!prompt) return;
    this.send({
      type: 'bash_sudo_cancel',
      sessionId: prompt.sessionId,
      promptId: prompt.promptId,
    });
  }

  public changeModel(model: string) {
    this.send({type: 'model_change', model});
  }

  public setConfig(updates: Partial<WhereverClientConfig>) {
    this.config = {
      ...this.config,
      ...updates,
    };
    this.stateStore.update((s: WhereverState) => {
      const next = {...s};
      if (updates.hideThinking !== undefined)
        next.hideThinking = !!updates.hideThinking;
      if (updates.hideTools !== undefined)
        next.hideTools = !!updates.hideTools;
      return next;
    });
  }

  public onMessage(cb: (msg: any) => void) {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  public uploadFileViaWebSocket(sessionId: string, filename: string, base64Data: string): Promise<{savedPath: string; filename: string}> {
    return new Promise((resolve, reject) => {
      const uploadId = this.generateId();
      this.pendingUploads.set(uploadId, {resolve, reject});
      this.send({
        type: 'file_upload',
        uploadId,
        sessionId,
        filename,
        data: base64Data
      });
    });
  }

  private generateId() {
    return Math.random().toString(36).substring(2) + Date.now().toString(36);
  }

  public getIsConnected() {
    return this.ws && this.ws.readyState === 1;
  }
}
