import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { GET as markdownRoute, generateStaticParams } from '@/app/docs/[md]/route';
import FaqPage from '@/app/docs/faq/page';
import QuickstartPage from '@/app/docs/page';
import PluginPage from '@/app/docs/plugin/page';
import RequiredCheckPage from '@/app/docs/required-check/page';
import RulesPage from '@/app/rules/page';
import { Code, wrapsLines } from '@/components/code';
import { InlineMarkdown } from '@/components/markdown';
import { MarkdownBlocks, parseBlocks, slug, type Block } from '@/components/markdown-blocks';
import { assistantLinks } from '@/components/page-actions';
import { ruleCatalog } from '@/lib/data';
import { DOCS_GROUPS, DOCS_NAV, DOCS_PAGES, docsPage } from '@/lib/docs';
import { FAQ } from '@/lib/faq';
import { lastModified } from '@/lib/git';
import { tokenize } from '@/lib/highlight';
import { llmsFullTxt } from '@/lib/llms';
import { forPackageManager } from '@/lib/package-managers';
import { markdownPath, pageMarkdown } from '@/lib/page-markdown';
import { SITE_URL } from '@/lib/site';

vi.mock('next/navigation', () => ({ usePathname: () => '/docs' }));

const render = (element: ReactElement) => renderToStaticMarkup(element);
const markdown = (text: string) => render(createElement(MarkdownBlocks, { markdown: text }));
const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

// ─── The sidebar ────────────────────────────────────────────────────────────

describe('the docs sidebar', () => {
  it('groups the pages: get started, gating pull requests, integrations, reference, help', () => {
    expect(DOCS_NAV.map((g) => [g.group, g.items.map((item) => item.label)])).toEqual([
      ['Get started', ['Quickstart', 'Set up your agent', 'Claude Code plugin']],
      ['Gate PRs', ['CI and baselines', 'GitHub Action']],
      ['Integrations', ['ESLint plugin']],
      ['Reference', ['Configuration', 'Design-system packages', 'Design tokens', 'Rules', 'Tools']],
      ['Help', ['Troubleshooting', 'FAQ', 'How it works', 'Migrating']],
    ]);
    expect(DOCS_GROUPS).toEqual(DOCS_NAV.map((g) => g.group));
  });

  it('lists every docs page once, with a short label', () => {
    const hrefs = DOCS_NAV.flatMap((g) => g.items.map((item) => item.href));
    for (const page of DOCS_PAGES) expect(hrefs.filter((h) => h === page.href)).toHaveLength(1);
    for (const label of DOCS_NAV.flatMap((g) => g.items.map((item) => item.label))) {
      expect(label.length, label).toBeLessThanOrEqual(22);
    }
  });

  it('reads in the sidebar’s order, page after page', () => {
    const order = DOCS_NAV.flatMap((g) => g.items.map((item) => item.href)).filter(
      (href) => href !== '/rules',
    );
    expect(DOCS_PAGES.map((p) => p.href)).toEqual(order);
    expect(docsPage('/docs/plugin').next?.href).toBe('/docs/ci');
    expect(docsPage('/docs/ci').previous?.href).toBe('/docs/plugin');
  });
});

// ─── The page frame ─────────────────────────────────────────────────────────

describe('a docs page', () => {
  const html = render(createElement(QuickstartPage));

  it('names its group above the title, not "Docs" again', () => {
    expect(html).toMatch(/<p class="[^"]*uppercase[^"]*">Get started<\/p>/);
    expect(text(html)).not.toMatch(/\bDocs Quickstart\b/);
  });

  it('has the page actions, an edit link and the date of its last change', () => {
    expect(html).toContain('>Copy page</button>');
    expect(html).toContain('aria-label="More page actions"');
    expect(html).toContain(
      'href="https://github.com/dgesteves/onsystem/edit/main/docs/quickstart.md"',
    );
    const date = lastModified(['docs/quickstart.md']);
    if (date) expect(html).toContain(`Last updated <time dateTime="${date.toISOString()}">`);
    else expect(html).not.toContain('Last updated');
  });

  it('says when the page last changed, and nothing when git cannot tell', async () => {
    for (const date of [new Date('2026-10-12T22:28:15Z'), null]) {
      // A fresh module graph, React included, with git answering `date`.
      vi.resetModules();
      vi.doMock('@/lib/git', () => ({ lastModified: () => date }));
      const { createElement: create } = await import('react');
      const { renderToStaticMarkup: toHtml } = await import('react-dom/server');
      const { default: Page } = await import('@/app/docs/page');
      const page = toHtml(create(Page));
      if (date) {
        expect(page).toContain(
          'Last updated <time dateTime="2026-10-12T22:28:15.000Z">Oct 12, 2026</time>',
        );
      } else {
        expect(page).not.toContain('Last updated');
      }
      vi.doUnmock('@/lib/git');
    }
  });

  it('shows the quickstart as four numbered steps, with no install panel repeating them', () => {
    const steps = /<ol class="mt-8[^"]*">([\s\S]*?)<\/ol>/.exec(html)?.[1] ?? '';
    expect([...steps.matchAll(/<h2 id="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'see-what-it-found',
      'hold-your-agent-to-it',
      'try-it',
      'gate-your-pull-requests',
    ]);
    expect(html.match(/marketplace add dgesteves\/onsystem/g)).toHaveLength(1);
  });

  it('puts the long title of the required-check page under its short one', () => {
    const page = render(createElement(RequiredCheckPage));
    expect(page).toMatch(/<h1[^>]*>GitHub Action<\/h1>/);
    expect(text(page)).toContain('Make it a required check on agent pull requests.');
  });

  it('sets SKILL.md’s headings small on the plugin page, out of its outline', () => {
    const page = render(createElement(PluginPage));
    expect(page).toMatch(/<h4 id="before-writing-ui"/);
    expect(page).not.toMatch(/<h[23] id="before-writing-ui"/);
    expect(page).not.toMatch(/<h4[^>]*data-toc/);
    expect(page).toMatch(/<h2 id="the-skill" data-toc="What the skill tells Claude"/);
  });

  it('gives each FAQ question an anchor, and names its section by the question alone', () => {
    const page = render(createElement(FaqPage));
    for (const [question] of FAQ) {
      const id = slug(question);
      expect(text(page)).toContain(`Link to the section ${question}`);
      expect(page).toContain(`<section aria-labelledby="${id}-text">`);
      const label = new RegExp(`<span id="${id}-text">([^<]*)</span>`).exec(page)?.[1];
      expect(text(label ?? '')).toBe(question);
    }
  });

  it('opens ChatGPT and Claude with a prompt that points at the page’s Markdown', () => {
    const [chatgpt, claude] = assistantLinks(`${SITE_URL}/docs/ci.md`);
    const prompt = 'Read https://onsystem.vercel.app/docs/ci.md so I can ask questions about it.';
    expect(chatgpt?.href).toBe(`https://chatgpt.com/?hints=search&q=${encodeURIComponent(prompt)}`);
    expect(claude?.href).toBe(`https://claude.ai/new?q=${encodeURIComponent(prompt)}`);
  });
});

describe('/rules', () => {
  it('lists each rule and section in "On this page"', () => {
    const html = render(createElement(RulesPage));
    const rail = /<nav aria-label="On this page"[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';
    const ids = [...rail.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([
      ...ruleCatalog.rules.map((rule) => rule.id),
      'configure',
      'suppressing-findings',
      'fixes',
    ]);
    for (const id of ids) expect(html).toContain(`id="${id ?? '-'}"`);
  });
});

// ─── Markdown for each page ─────────────────────────────────────────────────

describe('/docs/<page>.md', () => {
  it('is served for every docs page', () => {
    expect(generateStaticParams().map((p) => `/docs/${p.md}`)).toEqual(
      DOCS_PAGES.map(markdownPath),
    );
    expect(markdownPath(docsPage('/docs').page)).toBe('/docs/quickstart.md');
  });

  it('returns the page as Markdown, with absolute links and without the renderer’s markers', async () => {
    const response = await markdownRoute(new Request(`${SITE_URL}/docs/quickstart.md`), {
      params: Promise.resolve({ md: 'quickstart.md' }),
    });
    expect(response.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    const body = await response.text();
    expect(body).toMatch(/^# Quickstart\n\n/);
    expect(body).toContain('](https://onsystem.vercel.app/docs/configuration#zero-config)');
    expect(body).not.toContain('<!--');
    expect(body).not.toMatch(/```sh pm/);
    expect(body).toContain('## Gate your pull requests');
  });

  it('includes what the page adds to its file: the FAQ, and the skill on the plugin page', () => {
    const faq = pageMarkdown(docsPage('/docs/faq').page);
    for (const [question] of FAQ) expect(faq).toContain(`## ${question}`);
    const plugin = pageMarkdown(docsPage('/docs/plugin').page);
    expect(plugin).toContain('## What the skill tells Claude');
    expect(plugin).toContain('#### Before writing UI');
    expect(pageMarkdown(docsPage('/docs/required-check').page)).toMatch(
      /^# GitHub Action\n\nMake it a required check on agent pull requests\.\n\n/,
    );
  });

  it('leaves the renderer’s markers out of llms-full.txt too', () => {
    const full = llmsFullTxt();
    expect(full).toContain('### Gate your pull requests');
    expect(full).not.toContain('<!--');
    expect(full).not.toMatch(/```sh pm/);
  });

  it('is a 404 for anything else', async () => {
    const response = await markdownRoute(new Request(`${SITE_URL}/docs/nope.md`), {
      params: Promise.resolve({ md: 'nope.md' }),
    });
    expect(response.status).toBe(404);
  });
});

// ─── Docs components ────────────────────────────────────────────────────────

describe('callouts', () => {
  it('reads GitHub’s alerts as note, tip and warning', () => {
    const blocks = parseBlocks(
      '> [!NOTE]\n> One.\n\n> [!TIP]\n> Two.\n\n> [!WARNING]\n> Three.\n\n> [!CAUTION]\n> Four.\n\n> Said.',
    );
    expect(blocks.map((b) => (b.type === 'callout' ? b.kind : b.type))).toEqual([
      'note',
      'tip',
      'warning',
      'warning',
      'quote',
    ]);
  });

  it('render with their kind as a title, as a note to assistive tech', () => {
    const html = markdown('> [!TIP]\n> Run `inspect` first.');
    expect(html).toMatch(/^<div class="text-\[15\.5px\]"><div role="note"/);
    expect(text(html)).toBe('Tip Run inspect first.');
  });
});

describe('steps', () => {
  it('turn each heading between the markers into a numbered step', () => {
    const [steps] = parseBlocks(
      '<!-- steps -->\n\n## One\n\nFirst.\n\n## Two\n\n```sh\nls\n```\n\n<!-- /steps -->',
    );
    expect(steps?.type).toBe('steps');
    if (steps?.type !== 'steps') return;
    expect(steps.steps.map((s) => [s.text, s.blocks.map((b) => b.type)])).toEqual([
      ['One', ['paragraph']],
      ['Two', ['code']],
    ]);
    const html = markdown(
      '<!-- steps -->\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n\n<!-- /steps -->',
    );
    expect([...html.matchAll(/aria-hidden="true">(\d)<\/span>/g)].map((m) => m[1])).toEqual([
      '1',
      '2',
    ]);
  });

  it('leave other comments out', () => {
    expect(parseBlocks('<!-- a note for editors -->\n\nText.').map((b) => b.type)).toEqual([
      'paragraph',
    ]);
  });
});

describe('tabs', () => {
  it('group a run of code blocks labelled with tab=', () => {
    const blocks = parseBlocks(
      '```json tab="JSON"\n{}\n```\n\n```yaml tab="YAML"\na: 1\n```\n\nAfter.',
    );
    expect(blocks.map((b) => b.type)).toEqual(['tabs', 'paragraph']);
    const [tabs] = blocks;
    expect(tabs?.type === 'tabs' && tabs.tabs.map((t) => t.tab)).toEqual(['JSON', 'YAML']);
  });

  it('show an npm block for npm, pnpm, yarn and bun', () => {
    const [tabs] = parseBlocks(
      '```sh pm\nnpm install --save-dev onsystem\nnpx onsystem check .   # check\n```',
    );
    if (tabs?.type !== 'tabs') throw new Error('expected tabs');
    expect(tabs.group).toBe('package-manager');
    expect(Object.fromEntries(tabs.tabs.map((t) => [t.tab, t.code]))).toEqual({
      npm: 'npm install --save-dev onsystem\nnpx onsystem check .   # check',
      pnpm: 'pnpm add -D onsystem\npnpm exec onsystem check .   # check',
      yarn: 'yarn add -D onsystem\nyarn onsystem check .   # check',
      bun: 'bun add -d onsystem\nbunx onsystem check .   # check',
    });
    const html = markdown('```sh pm\nnpm install onsystem\n```');
    expect(html.match(/role="tab"/g)).toHaveLength(4);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(4);
  });

  it('convert one-off runs and leave other lines alone', () => {
    expect(forPackageManager('npx -y onsystem inspect\ncd app', 'pnpm')).toBe(
      'pnpm dlx onsystem inspect\ncd app',
    );
    expect(forPackageManager('npm install onsystem', 'bun')).toBe('bun add onsystem');
  });
});

describe('code blocks', () => {
  it('take a title from the fence', () => {
    const [block] = parseBlocks('```json title="onsystem.config.json"\n{}\n```');
    expect(block).toMatchObject({ type: 'code', lang: 'json', title: 'onsystem.config.json' });
  });

  it('name themselves in a bar that holds the copy button, clear of the code', () => {
    const html = render(createElement(Code, { code: 'npx -y onsystem', lang: 'sh', copy: 'Copy' }));
    const bar = /<div class="flex min-h-9[^"]*">([\s\S]*?)<\/div><div class="relative">/.exec(html);
    expect(bar?.[1]).toContain('Shell');
    expect(bar?.[1]).toContain('aria-label="Copy"');
    expect(html).not.toMatch(/absolute top-2\.5 right-2\.5/);
    const titled = markdown('```json title="onsystem.config.json"\n{}\n```');
    expect(text(titled)).toMatch(/^onsystem\.config\.json/);
  });

  it('wrap transcripts and output, and scroll source code', () => {
    expect(wrapsLines('⏺ Write(app/page.tsx)', 'text')).toBe(true);
    expect(wrapsLines('$ npx onsystem check .\nNo new problems', 'sh')).toBe(true);
    expect(wrapsLines('npx onsystem check .', 'sh')).toBe(false);
    expect(wrapsLines('<Button />', 'tsx')).toBe(false);
    expect(wrapsLines('{}', 'json')).toBe(false);
    const html = render(createElement(Code, { code: 'a long transcript', lang: 'text' }));
    expect(html).toContain('whitespace-pre-wrap');
  });

  it('highlight a slash command the way the install panel does', () => {
    expect(tokenize('/plugin install onsystem@dgesteves\nplain', 'text')).toEqual([
      { text: '/plugin', kind: 'command' },
      { text: ' install onsystem@dgesteves\n', kind: 'plain' },
      { text: 'plain', kind: 'plain' },
    ]);
  });
});

describe('headings', () => {
  it('link to themselves, and h2 and h3 go in "On this page"', () => {
    const html = markdown('## Config file\n\n### `exclude`\n\n#### Deep');
    expect(html).toMatch(/<h2 id="config-file" data-toc="Config file" data-level="2"/);
    expect(html).toContain('href="#config-file"');
    expect(html).toContain('<span class="sr-only">Link to the section Config file</span>');
    expect(html).toMatch(/<h3 id="exclude" data-toc="exclude"/);
    expect(html).toMatch(/<h4 id="deep" data-level="4"/);
  });

  it('are named by their visible text alone, while the link keeps its own name', () => {
    const html = markdown('## Config file');
    expect(html).toMatch(
      /<h2 id="config-file"[^>]* aria-labelledby="config-file-text"><span id="config-file-text">Config file<\/span><a href="#config-file"/,
    );
    expect(html).toContain('<span class="sr-only">Link to the section Config file</span>');
  });

  it('turn a details summary into an h3', () => {
    const blocks: Block[] = parseBlocks('<details>\n<summary><strong>Zed</strong></summary>');
    expect(blocks).toEqual([{ type: 'heading', level: 3, text: 'Zed' }]);
  });
});

describe('inline code', () => {
  const inline = (value: string) => render(createElement(InlineMarkdown, { text: value }));

  it('never breaks a short flag or class name', () => {
    expect(inline('Use `--root` or `border-destructive`.')).toMatch(
      /<code[^>]*><span class="whitespace-nowrap">--root<\/span><\/code>/,
    );
  });

  it('wraps long code between its words, each word whole', () => {
    const html = inline('`npx onsystem check . --format github --require-design-system`');
    expect(
      [...html.matchAll(/<span class="whitespace-nowrap">([^<]+)<\/span>/g)].map((m) => m[1]),
    ).toEqual(['npx', 'onsystem', 'check', '.', '--format', 'github', '--require-design-system']);
  });

  it('breaks a single word over 28 characters anywhere, only below 40rem', () => {
    const html = inline('`https://unpkg.com/onsystem/schema.json`');
    expect(html).toContain('max-sm:[overflow-wrap:anywhere] sm:whitespace-nowrap');
  });
});
