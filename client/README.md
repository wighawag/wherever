# @wherever-dev/client

A framework-agnostic TypeScript client for the [Wherever](https://wherever.dev) server ([`wherever-dev`](https://www.npmjs.com/package/wherever-dev)), which runs [pi coding agent](https://pi.dev) sessions behind a WebSocket API. It is what the Wherever web dashboard and the pi bridge extension ([`@wherever-dev/pi`](https://www.npmjs.com/package/@wherever-dev/pi)) are built on, and it works in browsers and in Node.js.

It owns the protocol details: reconnection with backoff, rejoining the session you were in, message history and paging, streaming replies and tool calls, steering, resumable uploads. You get the result as one observable state object.

## Install

```bash
npm install @wherever-dev/client
```

## Usage

```ts
import { WhereverClient, type WhereverState } from '@wherever-dev/client';
import WebSocket from 'ws'; // Node.js only: browsers use their own WebSocket

const client = new WhereverClient({
  host: '127.0.0.1',
  port: 31415,
  token: process.env.WHEREVER_TOKEN, // if the server requires one
  secure: true, // wss:// (the default)
  WebSocketCtor: WebSocket,
});

// Everything the client knows lives in ONE store: connection, active session,
// messages, streaming state, errors. subscribe() returns an unsubscribe function.
function until(ready: (state: WhereverState) => boolean): Promise<WhereverState> {
  return new Promise((resolve) => {
    let unsubscribe = () => {};
    let done = false;
    unsubscribe = client.stateStore.subscribe((state) => {
      if (done || !ready(state)) return;
      done = true;
      queueMicrotask(() => unsubscribe());
      resolve(state);
    });
  });
}

client.connect();
await until((s) => s.connected); // actions sent before this are dropped

client.createSession('/path/to/project'); // or joinSession(sessionFile) for an existing one
await until((s) => s.activeSessionFile !== null);

client.sendMessage('Summarise the README');
const done = await until((s) => !s.isStreaming && s.messages.some((m) => m.role === 'assistant'));
console.log(done.messages.filter((m) => m.role === 'assistant').at(-1)?.content);

client.disconnect();
```

Other actions include `abort()`, `changeModel('provider:model')`, `forkSession()`, `reloadSession()`, `loadMoreHistory()`, `leaveSession()` and `disconnect()`; see the type declarations for the full API.

When you pass your own `WebSocketCtor` with `secure: true`, the client accepts the server's self-signed certificate (the default `wherever start` setup). Use a trusted certificate for anything exposed beyond a private network.

The client follows the server's protocol, so keep it on the same release line as the server it talks to.

## License

[AGPL-3.0-only](https://github.com/wighawag/wherever/blob/main/LICENSE)
