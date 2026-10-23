import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { section } from './markdown.js';

// docs/clients.md gives every client a setup block of the same kind. Its "Support tiers" table
// says which setups have been run (Tier 1) and which follow the client's docs only (Tier 2), so an
// untested client does not read like a tested one. CONTRIBUTING.md holds new integrations back
// for four weeks after the public launch, and links the table.

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) =>
  fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const clients = read('docs/clients.md');
const contributing = read('CONTRIBUTING.md');

interface Row {
  setup: string;
  tier: string;
  checked: string;
  how: string;
}

/** The rows of the Support tiers table. */
function tiers(): Row[] {
  const lines = section(clients, 'Support tiers')
    .split('\n')
    .filter((line) => line.startsWith('|'));
  const [header, , ...body] = lines.map((line) =>
    line
      .slice(1, -1)
      .split('|')
      .map((cell) => cell.trim()),
  );
  expect(header).toEqual(['Setup', 'Tier', 'Last checked', 'What was checked']);
  return body.map(([setup = '', tier = '', checked = '', how = '']) => ({
    setup,
    tier,
    checked,
    how,
  }));
}

/** The body of the `<details>` block whose summary is `title`. */
function details(title: string): string {
  const start = clients.indexOf(`<summary><strong>${title}</strong></summary>`);
  if (start === -1) throw new Error(`no <details> block for ${title}`);
  return clients.slice(start, clients.indexOf('</details>', start));
}

const PULL = /\[#\d+\]\(https:\/\/github\.com\/dgesteves\/onsystem\/pull\/\d+\)/;

describe('the support tiers in docs/clients.md', () => {
  it('has a row for every client the page sets up', () => {
    const setups = tiers().map((row) => row.setup);
    // Each <details> block's client, without what its summary adds in brackets.
    const summaries = [...clients.matchAll(/<summary><strong>(.+?)<\/strong><\/summary>/g)].map(
      (m) => (m[1] ?? '').replace(/\s*\(.*\)$/, ''),
    );
    expect(summaries.length).toBeGreaterThanOrEqual(12);
    // The plugin and the skill, which "Plugins for other agents" and plugin.md set up.
    for (const name of [...summaries, 'Claude Code plugin', 'Agent Skills']) {
      expect(
        setups.some((setup) => setup.startsWith(name)),
        name,
      ).toBe(true);
    }
    expect(new Set(setups).size).toBe(setups.length);
  });

  it('puts every row in Tier 1 or 2, and says when and how each was checked', () => {
    for (const { setup, tier, checked, how } of tiers()) {
      expect(['1', '2'], setup).toContain(tier);
      expect(how, setup).not.toBe('');
      if (checked === 'Every pull request') {
        // CI runs it: the row names the command.
        expect(tier, setup).toBe('1');
        expect(how, setup).toMatch(/`pnpm [\w-]+`/);
      } else if (checked === 'Not yet') {
        expect(tier, setup).toBe('2');
      } else {
        // A check made once: its date, the client's version, and the pull request that shows it.
        expect(checked, setup).toMatch(/^\d{4}-\d{2}-\d{2}, \S.* \d+\.\d+\.\d+/);
        expect(how, setup).toMatch(PULL);
      }
    }
  });

  it('calls a setup tested only where CI or a pull request shows it', () => {
    // A setup moves to Tier 1 with a pull request that ran it in the client and updates its row;
    // add it here in the same change.
    expect(
      tiers()
        .filter((row) => row.tier === '1')
        .map((row) => row.setup),
    ).toEqual([
      'The MCP server over stdio',
      'Claude Code plugin',
      'Claude Code without the plugin',
      'Gemini CLI',
      'Agent Skills (`npx skills add`)',
    ]);
    // Nobody has run these: the launch audit could not check them, and no pull request has.
    for (const setup of [
      'VS Code',
      'Cursor',
      'Claude Desktop',
      'Windsurf (Devin Desktop)',
      'JetBrains IDEs',
      'Zed',
      'Antigravity',
    ]) {
      expect(tiers().find((row) => row.setup === setup)?.checked, setup).toBe('Not yet');
    }
  });

  it('is linked from the top of the page, before any setup', () => {
    const intro = clients.slice(0, clients.indexOf('\n## '));
    expect(intro).toContain('](#support-tiers)');
  });
});

describe('the team file for VS Code', () => {
  it('is the one .mcp.json, not that and .vscode/mcp.json as well', () => {
    // VS Code reads the workspace .mcp.json and its older .vscode/mcp.json: a team that commits
    // both, as the page used to offer them, can get the server started twice.
    const lead = section(clients, 'Cursor and VS Code').split('<details')[0] ?? '';
    expect(lead).not.toMatch(/commit the config instead:\s*$/);
    expect(lead).toContain('for VS Code the `.mcp.json` at the top of this page');
    const vscode = details('VS Code (Copilot agent mode)');
    expect(vscode).toContain('Commit the `.mcp.json` at the top of this page');
    expect(vscode).toContain('not both');
  });
});

describe('the integration freeze in CONTRIBUTING.md', () => {
  const freeze = () => section(contributing, 'New integrations');

  it('holds new integrations for four weeks after the launch, unless an issue asks for one', () => {
    expect(freeze()).toContain('For the first four weeks after the public launch');
    expect(freeze()).toContain('unless a user asks for it in an issue');
    expect(freeze()).toContain('(https://github.com/dgesteves/onsystem/issues)');
    // There is no launch date yet: the text reads the same before and after it.
    expect(freeze()).not.toMatch(/\b20\d\d\b/);
  });

  it('links the support tiers', () => {
    expect(freeze()).toContain('](docs/clients.md#support-tiers)');
    expect(clients).toContain('\n## Support tiers\n');
  });
});
