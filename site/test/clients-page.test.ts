import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import ClientsPage from '@/app/docs/clients/page';

vi.mock('next/navigation', () => ({ usePathname: () => '/docs/clients' }));

// /docs/clients is the setup page for every agent but Claude Code with the plugin: after the
// install buttons comes the setup, and how the server finds the project waits for the end.

const html = renderToStaticMarkup(createElement(ClientsPage));
const text = (fragment: string) =>
  fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const at = (id: string) => {
  const index = html.indexOf(`id="${id}"`);
  if (index === -1) throw new Error(`no element with id ${id}`);
  return index;
};

describe('/docs/clients', () => {
  it('opens with the setup, right after the install buttons', () => {
    // From the install buttons, the page's first links, to its first section.
    const body = html.slice(html.indexOf('Install in VS Code'), at('plugins-for-other-agents'));
    const lead = text(/<p class="measure[^"]*">([\s\S]*?)<\/p>/.exec(body)?.[1] ?? '');
    expect(lead).toContain('Run it from the project, or pass --root');
    expect(lead.split(' ').length).toBeLessThanOrEqual(50);
    expect(text(body)).not.toContain('2026-07-28');
    // The one .mcp.json, as a box above the first section.
    expect(body).toMatch(/role="note"[\s\S]*\.mcp\.json/);
  });

  it('explains how the server finds the project after every client, before the docs search', () => {
    const ids = [...html.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1]);
    expect(ids.slice(-2)).toEqual([
      'how-the-server-finds-your-project',
      'search-these-docs-from-your-agent',
    ]);
    const protocol = html.indexOf('2026-07-28');
    expect(protocol).toBeGreaterThan(at('how-the-server-finds-your-project'));
    expect(at('other-clients')).toBeLessThan(at('how-the-server-finds-your-project'));
  });

  it('has the Antigravity and Gemini CLI setups under other clients', () => {
    expect(at('antigravity-cli-and-ide')).toBeGreaterThan(at('other-clients'));
    const gemini = text(html.slice(at('gemini-cli'), at('antigravity-cli-and-ide')));
    expect(gemini).toContain('gemini mcp add -s user onsystem npx -y onsystem');
    expect(gemini).toContain('only in trusted folders');
  });
});
