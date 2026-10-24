// A minimal MCP server over stdio (newline-delimited JSON-RPC), just enough for
// pi's built-in MCP client to connect and list one tool. Used by
// test/native-mcp.test.ts. Writes its pid to the file named by argv[2] so the
// test can check that session teardown stops it.
import fs from 'node:fs';
import readline from 'node:readline';

const pidFile = process.argv[2];
if (pidFile) fs.writeFileSync(pidFile, String(process.pid));

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

const tools = [
  {
    name: 'echo',
    description: 'Echo the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // notifications (initialized, cancelled...)
  switch (req.method) {
    case 'initialize':
      send({
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'wherever-fixture', version: '0.0.0' },
        },
      });
      return;
    case 'ping':
      send({ id: req.id, result: {} });
      return;
    case 'tools/list':
      send({ id: req.id, result: { tools } });
      return;
    case 'tools/call':
      send({ id: req.id, result: { content: [{ type: 'text', text: String(req.params?.arguments?.text ?? '') }] } });
      return;
    default:
      send({ id: req.id, error: { code: -32601, message: `Method not found: ${req.method}` } });
  }
});
