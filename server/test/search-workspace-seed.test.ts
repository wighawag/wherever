import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maybeSeedSearchWorkspace, SEARCH_WORKSPACE_AGENTS_MD } from '../src/session-pool.ts';

// The search workspace's seeded AGENTS.md must work whichever extension supplies
// `web_search` / `web_fetch`: it names no skill and no provider, and seeding
// never clobbers an AGENTS.md the user already has.

let root: string;
let searchFolder: string;
let savedConfigDir: string | undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wherever-search-seed-'));
  searchFolder = path.join(root, 'searches');
  fs.mkdirSync(searchFolder);
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir);
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ searchFolder }));
  savedConfigDir = process.env.WHEREVER_CONFIG_DIR;
  process.env.WHEREVER_CONFIG_DIR = configDir;
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.WHEREVER_CONFIG_DIR;
  else process.env.WHEREVER_CONFIG_DIR = savedConfigDir;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('search workspace seed', () => {
  it('is provider-agnostic: no Ollama, no named skill', () => {
    const text = SEARCH_WORKSPACE_AGENTS_MD;
    expect(text).not.toMatch(/ollama/i);
    expect(text).not.toMatch(/skill/i);
    expect(text).toContain('web_search');
    expect(text).toContain('web_fetch');
  });

  it('opens by asserting the tools exist, and mentions failure only on an error', () => {
    const text = SEARCH_WORKSPACE_AGENTS_MD;
    const firstPara = text.split('\n\n')[1];
    expect(firstPara.startsWith('**')).toBe(true);
    expect(firstPara).toContain('web_search');
    expect(firstPara).toMatch(/never say that you cannot search the web/i);
    expect(text).not.toMatch(/missing or failing/i);
    expect(text).toMatch(/returns an error/i);
  });

  it('seeds AGENTS.md into the configured search folder when none exists', () => {
    maybeSeedSearchWorkspace(searchFolder);
    const seeded = fs.readFileSync(path.join(searchFolder, 'AGENTS.md'), 'utf8');
    expect(seeded).toBe(SEARCH_WORKSPACE_AGENTS_MD);
  });

  it('leaves an existing AGENTS.md untouched', () => {
    const agentsPath = path.join(searchFolder, 'AGENTS.md');
    fs.writeFileSync(agentsPath, 'MY OWN RULES\n');
    maybeSeedSearchWorkspace(searchFolder);
    expect(fs.readFileSync(agentsPath, 'utf8')).toBe('MY OWN RULES\n');
  });

  it('does nothing outside the search folder', () => {
    const other = path.join(root, 'elsewhere');
    fs.mkdirSync(other);
    maybeSeedSearchWorkspace(other);
    expect(fs.existsSync(path.join(other, 'AGENTS.md'))).toBe(false);
  });
});
