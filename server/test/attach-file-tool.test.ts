import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAttachFileTool, type DownloadsPolicy } from '../src/attach-file-tool.js';

// attach_file must FAIL LOUDLY when GET /session/download would refuse the file
// anyway (downloads disabled, file over downloads.maxBytes), rather than report
// success and show the user a button that can only error.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function attach(policy: DownloadsPolicy | undefined, bytes: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-attach-'));
  dirs.push(dir);
  fs.writeFileSync(path.join(dir, 'out.bin'), Buffer.alloc(bytes));
  const tool = createAttachFileTool(dir, () => policy) as unknown as {
    execute: (id: string, params: unknown) => Promise<{ isError?: boolean; content: { text: string }[]; details?: { path: string } }>;
  };
  return tool.execute('t1', { path: 'out.bin' });
}

describe('attach_file download policy check', () => {
  it('succeeds with the resolved path when the server will serve it', async () => {
    const r = await attach(undefined, 10);
    expect(r.isError).toBeFalsy();
    expect(path.basename(r.details!.path)).toBe('out.bin');
  });

  it('errors when downloads are disabled', async () => {
    const r = await attach({ enabled: false }, 10);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/downloads are disabled/);
  });

  it('errors when the file is over downloads.maxBytes', async () => {
    const r = await attach({ maxBytes: 5 }, 10);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/over the server's download limit of 5 bytes/);
  });
});
