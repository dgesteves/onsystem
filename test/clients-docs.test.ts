import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { blocks, section } from './markdown.js';

// docs/clients.md (/docs/clients on the website) is the setup page for every agent but Claude
// Code with the plugin. It opens with the setup, offers one committed file that several clients
// read, and keeps each client's commands to what that client runs today.

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) =>
  fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');
const clients = read('docs/clients.md');
const readme = read('README.md');

/** What the page says before its first `##` heading. */
const intro = clients.slice(0, clients.indexOf('\n## '));

/** The body of the `<details>` block whose summary is `title`. */
function details(title: string): string {
  const start = clients.indexOf(`<summary><strong>${title}</strong></summary>`);
  if (start === -1) throw new Error(`no <details> block for ${title}`);
  return clients.slice(start, clients.indexOf('</details>', start));
}

/** The first JSON code block in `markdown`, parsed. */
function json(markdown: string): unknown {
  const [block] = blocks(markdown, 'json');
  if (block === undefined) throw new Error('no JSON code block');
  return JSON.parse(block);
}

describe('docs/clients.md', () => {
  it('opens with the setup, and leaves how the server finds the project for the end', () => {
    const lead = intro.split('\n\n')[1] ?? '';
    expect(lead.split(/\s+/).length).toBeLessThanOrEqual(50);
    expect(lead).toContain('Run it from the project, or pass `--root`');
    expect([...clients.matchAll(/^## (.+)$/gm)].map((m) => m[1]).at(-1)).toBe(
      'How the server finds your project',
    );
    // The protocol eras and the roots fallback come after every client's setup.
    const finding = section(clients, 'How the server finds your project');
    for (const detail of ['2026-07-28', '`initialize`', '`file://`', 'MCP roots']) {
      expect(intro, detail).not.toContain(detail);
      expect(finding, detail).toContain(detail);
    }
  });

  it('offers one .mcp.json to commit, at the top, naming the clients that read it', () => {
    const box = /^> \[!TIP\]\n((?:>.*\n)+)/m.exec(intro)?.[1]?.replace(/^> ?/gm, '') ?? '';
    expect(box).toContain('`.mcp.json`');
    for (const client of ['Claude Code', 'VS Code', 'GitHub Copilot CLI', 'Grok Build']) {
      expect(box, client).toContain(client);
    }
    expect(json(box)).toEqual({
      mcpServers: { onsystem: { command: 'npx', args: ['-y', 'onsystem'] } },
    });
    // The Claude Code plugin registers the same tools: one or the other, not both.
    expect(box).toMatch(/instead of the plugin/);
  });

  it('installs the Copilot CLI plugin from the marketplace, not by the deprecated direct install', () => {
    const plugins = section(clients, 'Plugins for other agents');
    expect(plugins).toContain(
      '```sh\n  copilot plugin marketplace add dgesteves/onsystem\n  copilot plugin install onsystem@dgesteves\n  ```',
    );
    expect(clients).not.toMatch(/copilot plugin install dgesteves\//);
  });

  it('says the hook runs in Codex too, on the files apply_patch changes', () => {
    expect(clients).not.toMatch(/only (?:the )?Claude Code(?: plugin)? has the hook/i);
    expect(intro).toContain('Claude Code and Codex CLI');
    expect(section(clients, 'Plugins for other agents')).toContain('`apply_patch`');
  });

  it('adds Gemini CLI from the terminal, and says it starts servers only in trusted folders', () => {
    const gemini = details('Gemini CLI');
    expect(gemini).toContain(
      'gemini mcp add -s user onsystem npx -y onsystem --root /absolute/path/to/app',
    );
    expect(gemini).toContain('only in trusted folders');
    expect(gemini).toContain('`/permissions`');
    expect(gemini).toContain('`--skip-trust`');
  });

  it('has a block for Antigravity, which reads its own file, with the same server entry', () => {
    const antigravity = details('Antigravity (CLI and IDE)');
    expect(antigravity).toContain('`~/.gemini/config/mcp_config.json`');
    expect(antigravity).toContain('`.agents/mcp_config.json`');
    expect(json(antigravity)).toEqual(json(details('Gemini CLI')));
  });
});

describe('the README', () => {
  it('lists Antigravity with the other clients', () => {
    const top = readme.slice(0, readme.indexOf('<!-- npm-readme:video -->'));
    expect(top).toContain('](https://onsystem.vercel.app/docs/clients#antigravity-cli-and-ide)');
    expect(readme).toMatch(/\[configs for [^\]]*Antigravity[^\]]*\]/);
  });
});
