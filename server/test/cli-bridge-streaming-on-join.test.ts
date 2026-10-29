import { describe, it, expect, afterEach } from 'vitest';
import { startHarness, type Harness } from './harness.js';

// Bug: joining an existing session that a pi CLI is CURRENTLY running a long
// tool call on shows Abort disabled + an enabled composer, while the CLI is
// still waiting for the tool. Root cause: registerCliSession hardcodes
// isStreaming=false, and the CLI only forwards agent_start/agent_end as they
// happen. If the turn was already in progress when the bridge registered (server
// restart, bridge reconnect mid-turn), the server never learns it is streaming,
// so a viewer that joins sees isStreaming=false.
//
// The fix: the CLI reports its CURRENT streaming state at register time
// (cli_register carries isStreaming), and the server honors it. This test drives
// the register handshake directly (no real pi CLI needed) by sending a
// cli_register frame with isStreaming: true, then joins as a viewer and asserts
// the viewer sees the session as streaming (Abort enabled).

let h: Harness | undefined;
afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

describe('CLI-bridge streaming state on join', () => {
  it('a viewer joining a mid-tool-call CLI session sees isStreaming=true', async () => {
    h = await startHarness();

    // Act as the pi CLI bridge: register a session that is ALREADY streaming
    // (a long tool call is in flight), the moment we connect.
    const cli = await h.connect();
    await cli.waitForType('connected');
    const sessionFile = `${cli.workspace}/cli-session.jsonl`;
    cli.send({
      type: 'cli_register',
      sessionFile,
      cwd: cli.workspace,
      model: 'fake:fake-model',
      isStreaming: true,
    });
    await h.waitForActive(sessionFile);

    // A viewer (the web client) joins the same session from the sidebar.
    const viewer = await h.connect();
    await viewer.waitForType('connected');
    viewer.send({ type: 'session_load', sessionFile });

    const created = await viewer.waitForType('session_created', 15_000);
    // If the session is served resident (the CLI session is in the pool), the
    // very first session_created must already reflect streaming. If it comes back
    // pending, session_ready must reflect it. Either way, the viewer must end up
    // seeing isStreaming=true.
    let streaming = created.isStreaming === true;
    if (!streaming) {
      const ready = await viewer.waitForType('session_ready', 15_000).catch(() => null);
      streaming = !!ready && ready.isStreaming === true;
    }
    expect(streaming).toBe(true);
  }, 60_000);
});
