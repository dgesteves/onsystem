import fs from 'node:fs';
import path from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as askStatusRoute, POST as askRoute } from '@/app/api/ask/route';
import { DELETE as mcpDelete, GET as mcpGet, POST as mcpRoute } from '@/app/api/mcp/route';
import { AskButton, askStatus, resetAskStatus } from '@/components/ask';
import { DocsForAgents } from '@/components/docs-for-agents';
import { slug } from '@/components/markdown-blocks';
import { SiteFooter } from '@/components/site-footer';
import { SiteHeader } from '@/components/site-header';
import index from '@/generated/ask-index.json';
import { askEnabled } from '@/lib/ask';
import { ruleCatalog } from '@/lib/data';
import { DOCS_MCP } from '@/lib/docs-mcp';
import { FAQ } from '@/lib/faq';
import { llmsTxt } from '@/lib/llms';
import { DOCS_FILES, SITE_URL } from '@/lib/site';

vi.mock('next/navigation', () => ({ usePathname: () => '/docs', useRouter: () => ({}) }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetAskStatus();
});

// ─── The index ──────────────────────────────────────────────────────────────

describe('the docs index', () => {
  it('holds every docs page, the FAQ and every rule, as the site serves them', () => {
    const urls = index.documents.map((doc) => doc.url).sort();
    expect(urls).toEqual(
      [
        ...Object.values(DOCS_FILES),
        '/docs/faq',
        ...ruleCatalog.rules.map((rule) => `/rules/${rule.id}`),
      ].sort(),
    );
  });

  it('cites each FAQ answer by the anchor its question has on the page', () => {
    const faq = index.documents.findIndex((doc) => doc.url === '/docs/faq');
    const anchors = index.chunks.filter((c) => c.doc === faq).map((c) => c.anchor);
    expect(anchors).toEqual(FAQ.map(([question]) => slug(question)));
  });

  it("leaves out the renderer's own markers, as the .md pages do", () => {
    const text = index.chunks.map((chunk) => chunk.text).join('\n');
    expect(text).toContain('npm install --save-dev onsystem');
    expect(text).not.toMatch(/^```\w+ pm$/m);
    expect(text).not.toContain('<!-- steps -->');
  });

  it('is keyword-only, so building and searching it calls no model', () => {
    expect(index.embedding).toBeNull();
  });

  it('cites sections by the anchors the pages give their headings', () => {
    const ci = index.documents.findIndex((doc) => doc.url === '/docs/ci');
    const anchors = index.chunks.filter((c) => c.doc === ci).map((c) => c.anchor);
    expect(anchors).toContain('adopting-it-in-an-existing-codebase');
    expect(anchors).toContain('code-scanning-and-other-sarif-tools');
  });
});

// ─── /api/mcp ───────────────────────────────────────────────────────────────

let id = 0;

interface RpcResult {
  protocolVersion?: string;
  capabilities?: { tools?: unknown };
  tools?: { name: string }[];
  isError?: boolean;
}

/** One JSON-RPC call to the MCP route; the answer is JSON, or one server-sent event. */
async function rpc(method: string, params: Record<string, unknown> = {}) {
  const response = await mcpRoute(
    new Request(`${SITE_URL}/api/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
        'x-forwarded-for': '203.0.113.7',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    }),
  );
  const text = await response.text();
  const json = text.trimStart().startsWith('{') ? text : (/^data: (.*)$/m.exec(text)?.[1] ?? '');
  return { status: response.status, body: JSON.parse(json) as { result: RpcResult } };
}

describe('/api/mcp', () => {
  it('answers initialize as the onsystem docs', async () => {
    const { status, body } = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    expect(status).toBe(200);
    expect(body.result.protocolVersion).toBe('2025-06-18');
    expect(body.result.capabilities?.tools).toBeDefined();
  });

  it('lists search, fetch and list_pages', async () => {
    const { body } = await rpc('tools/list');
    const names = (body.result.tools ?? []).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['search', 'fetch', 'list_pages']));
  });

  it('finds the baseline section when searched for it', async () => {
    const { body } = await rpc('tools/call', {
      name: 'search',
      arguments: { query: 'adopt in an existing codebase with a baseline' },
    });
    expect(body.result.isError).toBeFalsy();
    const text = JSON.stringify(body.result);
    expect(text).toContain(`${SITE_URL}/docs/ci#adopting-it-in-an-existing-codebase`);
  });

  it('answers GET and DELETE as a stateless server does', async () => {
    const request = () => new Request(`${SITE_URL}/api/mcp`);
    expect((await mcpGet(request())).status).toBe(405);
    expect((await mcpDelete(new Request(`${SITE_URL}/api/mcp`, { method: 'DELETE' }))).status).toBe(
      405,
    );
  });
});

// ─── /api/ask ───────────────────────────────────────────────────────────────

const question = () =>
  new Request(`${SITE_URL}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.8' },
    body: JSON.stringify({ question: 'How do I install it?' }),
  });

describe('/api/ask', () => {
  it('is off without OPENAI_API_KEY: GET says so, and a question gets a 404', async () => {
    vi.stubEnv('OPENAI_API_KEY', '');
    expect(askEnabled()).toBe(false);
    expect(await askStatusRoute().json()).toEqual({ ask: false });
    const response = await askRoute(question());
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'not_configured' } });
  });

  it('is on with a key, read at the time of the request', () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test');
    expect(askEnabled()).toBe(true);
    const response = askStatusRoute();
    expect(response.headers.get('cache-control')).toContain('s-maxage=300');
    vi.stubEnv('OPENAI_API_KEY', '   ');
    expect(askEnabled()).toBe(false);
  });

  it('never puts the key in what it returns', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'sk-test-secret');
    expect(JSON.stringify(await askStatusRoute().json())).not.toContain('sk-test-secret');
  });

  it('protects the endpoint as ondocs.vercel.app does', () => {
    const source = fs.readFileSync(path.join(import.meta.dirname, '../lib/ask.ts'), 'utf8');
    expect(source).toContain('memoryRateLimit({ limit: 5, windowMs: 60_000 })');
    expect(source).toContain('budget: { requestsPerDay: 300, tokensPerDay: 1_000_000 }');
    expect(source).toContain('memoryRateLimit({ limit: 30, windowMs: 60_000 })');
    expect(source).toContain('budget: { requestsPerDay: 20_000 }');
  });
});

// ─── The Ask button ─────────────────────────────────────────────────────────

describe('the Ask button', () => {
  it('is not in the header the server renders', () => {
    const html = renderToStaticMarkup(createElement(SiteHeader));
    expect(html).not.toContain('Ask the docs');
    expect(renderToStaticMarkup(createElement(AskButton))).toBe('');
  });

  it('stays hidden when /api/ask says Ask is off, or cannot be reached', async () => {
    vi.stubGlobal('sessionStorage', undefined);
    const off = vi.fn(() => Promise.resolve(Response.json({ ask: false })));
    expect(await askStatus(off)).toBe(false);
    expect(off).toHaveBeenCalledWith('/api/ask', expect.anything());
    resetAskStatus();
    expect(await askStatus(() => Promise.reject(new Error('offline')))).toBe(false);
    resetAskStatus();
    expect(await askStatus(() => Promise.resolve(new Response('nope', { status: 500 })))).toBe(
      false,
    );
  });

  it('shows when /api/ask says Ask is on', async () => {
    vi.stubGlobal('sessionStorage', undefined);
    expect(await askStatus(() => Promise.resolve(Response.json({ ask: true })))).toBe(true);
  });
});

// ─── Telling agents ─────────────────────────────────────────────────────────

describe('the docs for agents', () => {
  it('gives the MCP URL, the install links and the Claude Code command', () => {
    const html = renderToStaticMarkup(createElement(DocsForAgents));
    expect(html).toContain(`${SITE_URL}/api/mcp`);
    expect(DOCS_MCP.cursor).toMatch(
      /^https:\/\/cursor\.com\/en\/install-mcp\?name=onsystem-docs&config=/,
    );
    const config = decodeURIComponent(new URL(DOCS_MCP.cursor).searchParams.get('config') ?? '');
    expect(JSON.parse(Buffer.from(config, 'base64').toString('utf8'))).toEqual({
      url: `${SITE_URL}/api/mcp`,
    });
    expect(DOCS_MCP.vscode).toMatch(/^https:\/\/insiders\.vscode\.dev\/redirect\/mcp\/install\?/);
    expect(html).toContain(DOCS_MCP.claude.replace(/&/g, '&amp;'));
    expect(DOCS_MCP.claudeCode).toBe(
      `claude mcp add --transport http onsystem-docs ${SITE_URL}/api/mcp`,
    );
    expect(html).toContain('href="/llms.txt"');
    expect(html).toContain('href="/llms-full.txt"');
  });

  it('is a section of the docs home, in "On this page", where the footer links', () => {
    const html = renderToStaticMarkup(createElement(DocsForAgents));
    expect(html).toMatch(
      /<h2 id="use-these-docs-from-your-agent" data-toc="Use these docs from your agent" data-level="2" class="[^"]*scroll-mt-28[^"]*lg:scroll-mt-20/,
    );
    const footer = renderToStaticMarkup(createElement(SiteFooter));
    expect(footer).toContain('href="/docs#use-these-docs-from-your-agent"');
  });

  it('lists the MCP endpoint in llms.txt', () => {
    expect(llmsTxt()).toContain(`(${SITE_URL}/api/mcp)`);
  });
});
