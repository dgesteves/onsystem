import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import NotFound, { metadata as notFoundMetadata } from '@/app/not-found';
import { GET as docsCard, generateStaticParams as cardParams } from '@/app/og/docs/[slug]/route';
import Home, { metadata as homeMetadata } from '@/app/page';
import sitemap from '@/app/sitemap';
import { docsMetadata } from '@/components/doc-page';
import { NAV } from '@/components/site-header';
import { DOCS_PAGES, docsHeadings, docsMarkdown, docsSlug } from '@/lib/docs';
import { lastModified } from '@/lib/git';
import { compactNumber, MORE, REGISTRY, shownCount, SITE_URL } from '@/lib/site';
import { THEME_KEY, THEME_SCRIPT } from '@/lib/theme';

vi.mock('next/navigation', () => ({ usePathname: () => '/docs/ci' }));

const site = path.join(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(site, 'app/globals.css'), 'utf8');

// ─── Theme ──────────────────────────────────────────────────────────────────

/** `--site-name: light-dark(#light, #dark)` pairs from app/globals.css. */
const tokens = Object.fromEntries(
  [...css.matchAll(/--site-([\w-]+): light-dark\((#[0-9a-f]{6}), (#[0-9a-f]{6})\)/g)].map(
    ([, name = '', light = '', dark = '']) => [name, { light, dark }],
  ),
);

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const TEXT = ['fg', 'fg-soft', 'muted', 'subtle', 'cyan', 'cyan-bright', 'magenta', 'magenta-soft'];
const SURFACES = ['ink', 'raised', 'raised-2', 'code', 'chrome'];

describe('the theme', () => {
  it('maps every colour utility to a token with a light and a dark value', () => {
    const theme = /@theme inline \{([\s\S]*?)\}/.exec(css)?.[1] ?? '';
    const mapped = [...theme.matchAll(/--color-([\w-]+): var\(--site-([\w-]+)\)/g)];
    expect(mapped.length).toBeGreaterThan(10);
    for (const [, color, token = ''] of mapped) expect(tokens[token], color).toBeDefined();
  });

  it('keeps the dark values the site had, and takes the light ones from signoff-ui', () => {
    expect(tokens.ink).toEqual({ light: '#ffffff', dark: '#0d0f12' });
    expect(tokens.cyan).toEqual({ light: '#0e7490', dark: '#22d3ee' });
    expect(tokens.fg?.dark).toBe('#f5f7fa');
    expect(tokens.muted?.dark).toBe('#9aa6b4');
  });

  it.each(['light', 'dark'] as const)('keeps text at 4.5:1 or more on every surface, %s', (t) => {
    for (const text of TEXT) {
      for (const surface of SURFACES) {
        const ratio = contrast(tokens[text]?.[t] ?? '', tokens[surface]?.[t] ?? '');
        expect(ratio, `${text} on ${surface}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each([0, 1])('keeps highlighted code at 4.5:1 or more on the code background', (t) => {
    const code = t === 0 ? tokens.code?.light : tokens.code?.dark;
    const colours = [...css.matchAll(/\.tok-(\w+) \{\n {2}color: light-dark\((#\w+), (#\w+)\)/g)];
    expect(colours.length).toBe(11);
    for (const [, kind, light = '', dark = ''] of colours) {
      expect(contrast(t === 0 ? light : dark, code ?? ''), kind).toBeGreaterThanOrEqual(4.5);
    }
  });

  it.each(['light', 'dark'] as const)(
    'keeps highlighted code at 4.5:1 or more inside every finding highlight, %s',
    (t) => {
      // A highlight is its colour at a few per cent over the block: the code background, or the
      // raised panel of the home page's demo.
      const over = (hex: string, percent: number, base: string) =>
        `#${[1, 3, 5]
          .map((i) => {
            const [a, b] = [hex, base].map((c) => parseInt(c.slice(i, i + 2), 16));
            const mixed = Math.round(((a ?? 0) * percent + (b ?? 0) * (100 - percent)) / 100);
            return mixed.toString(16).padStart(2, '0');
          })
          .join('')}`;
      const marks = [
        ...css.matchAll(
          /\.mark-(\w+) \{[^}]*?background: color-mix\(in oklab, var\(--color-([\w-]+)\) (\d+)%, transparent\);/g,
        ),
      ];
      expect(marks.map(([, kind]) => kind).sort()).toEqual([
        'active',
        'changed',
        'error',
        'warning',
      ]);
      const colours = [...css.matchAll(/\.tok-(\w+) \{\n {2}color: light-dark\((#\w+), (#\w+)\)/g)];
      for (const [, mark, colour = '', percent = ''] of marks) {
        for (const surface of ['code', 'raised']) {
          const background = over(
            tokens[colour]?.[t] ?? '',
            Number(percent),
            tokens[surface]?.[t] ?? '',
          );
          for (const [, kind, light = '', dark = ''] of colours) {
            const ratio = contrast(t === 'light' ? light : dark, background);
            expect(ratio, `${kind} in .mark-${mark ?? ''} on ${surface}`).toBeGreaterThanOrEqual(
              4.5,
            );
          }
        }
      }
    },
  );

  it('follows the OS until a theme is picked, and .light or .dark on <html> force one', () => {
    expect(css).toMatch(/:root \{\n {2}color-scheme: light dark;/);
    expect(css).toMatch(/\.light \{\n {2}color-scheme: light;/);
    expect(css).toMatch(/\.dark \{\n {2}color-scheme: dark;/);
    // No colour outside the tokens: every hex value in the stylesheet is inside a light-dark(),
    // apart from the opaque stop of a mask.
    const loose = css
      .split('\n')
      .filter((line) => /#[0-9a-f]{3,8}\b/i.test(line) && !/light-dark\(|mask-image/.test(line));
    expect(loose).toEqual([]);
  });
});

/** Runs the script that sets the theme before paint, with a stored choice and an OS setting. */
function runThemeScript({ stored, osDark }: { stored: string | null | Error; osDark: boolean }) {
  const classes = new Set<string>();
  const root = { classList: { add: (c: string) => classes.add(c) }, style: { colorScheme: '' } };
  const localStorage = {
    getItem: (key: string) => {
      if (stored instanceof Error) throw stored;
      return key === THEME_KEY ? stored : null;
    },
  };
  const window = { matchMedia: (query: string) => ({ matches: osDark && query.includes('dark') }) };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- the inline script under test
  const script = new Function('localStorage', 'window', 'document', THEME_SCRIPT) as (
    ...globals: unknown[]
  ) => void;
  script(localStorage, window, { documentElement: root });
  return { classes: [...classes], colorScheme: root.style.colorScheme };
}

describe('the theme script', () => {
  it('applies the stored choice, or the OS setting for System', () => {
    expect(runThemeScript({ stored: 'light', osDark: true })).toEqual({
      classes: ['light'],
      colorScheme: 'light',
    });
    expect(runThemeScript({ stored: 'dark', osDark: false }).classes).toEqual(['dark']);
    expect(runThemeScript({ stored: null, osDark: true }).classes).toEqual(['dark']);
    expect(runThemeScript({ stored: null, osDark: false }).classes).toEqual(['light']);
  });

  it('follows the OS when storage is unavailable', () => {
    expect(runThemeScript({ stored: new Error('blocked'), osDark: true }).classes).toEqual([
      'dark',
    ]);
  });

  it('uses this site’s own storage key', () => {
    expect(THEME_KEY).toBe('onsystem-theme');
  });
});

// ─── Header and footer ──────────────────────────────────────────────────────

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function renderShell(social: { stars: number | null; weeklyDownloads: number | null }) {
  vi.resetModules();
  vi.doMock('@/generated/social.json', () => ({ default: social }));
  const { SiteHeader } = await import('@/components/site-header');
  const { SiteFooter } = await import('@/components/site-footer');
  return {
    header: renderToStaticMarkup(createElement(SiteHeader)),
    footer: renderToStaticMarkup(createElement(SiteFooter)),
  };
}

afterEach(() => {
  vi.doUnmock('@/generated/social.json');
});

describe('the header', () => {
  it('lists Docs, then Playground, Rules and Benchmark', () => {
    expect(NAV.map((item) => item.label)).toEqual(['Docs', 'Playground', 'Rules', 'Benchmark']);
  });

  it('shows the name, the version, the nav, the theme switch and GitHub', async () => {
    const { header } = await renderShell({ stars: null, weeklyDownloads: null });
    expect(header).toMatch(/^<header class="[^"]*sticky[^"]*bg-ink\/95[^"]*backdrop-blur/);
    expect(text(header)).toMatch(/onsystem v\d+\.\d+\.\d+/);
    const nav = /<nav aria-label="Site"[^>]*>([\s\S]*?)<\/nav>/.exec(header)?.[1] ?? '';
    expect([...nav.matchAll(/href="([^"]+)"/g)].map((m) => m[1])).toEqual([
      '/docs',
      '/playground',
      '/rules',
      '/benchmark',
    ]);
    expect(header).toContain('role="radiogroup" aria-label="Theme"');
    expect(header).toContain('aria-label="onsystem on GitHub"');
  });

  it('opens every nav item and the theme switch from a menu button on phones', async () => {
    const { header } = await renderShell({ stars: null, weeklyDownloads: null });
    const button = /<button[^>]*aria-label="Menu"[^>]*>/.exec(header)?.[0] ?? '';
    expect(button).toContain('md:hidden');
    const id = /popovertarget="([^"]+)"/i.exec(button)?.[1];
    expect(id).toBeTruthy();
    const menu = new RegExp(`<div[^>]*id="${id ?? '-'}"[^>]*popover="auto"[^>]*>([\\s\\S]*)`).exec(
      header,
    )?.[1];
    for (const item of NAV) expect(menu).toContain(`href="${item.href}"`);
    expect(menu).toContain('role="radiogroup"');
    // The nav and the switch beside it are hidden on phones, where the menu has them.
    expect(/<nav aria-label="Site" class="[^"]*hidden[^"]*md:flex/.test(header)).toBe(true);
  });

  it('shows the star count from 10 stars on, and only the icon below that', async () => {
    expect(text((await renderShell({ stars: 9, weeklyDownloads: null })).header)).not.toMatch(
      /onsystem v[\d.]+ Docs Playground Rules Benchmark .*\b9\b/,
    );
    const { header } = await renderShell({ stars: 1234, weeklyDownloads: null });
    expect(header).toContain('aria-label="onsystem on GitHub, 1234 stars"');
    expect(text(header)).toContain('1.2k');
    expect(shownCount(9, 10)).toBeNull();
    expect(shownCount(10, 10)).toBe(10);
    expect(shownCount(null, 10)).toBeNull();
  });

  it('shortens counts', () => {
    expect([950, 1000, 1234, 9999, 12_345].map(compactNumber)).toEqual([
      '950',
      '1k',
      '1.2k',
      '10k',
      '12k',
    ]);
  });
});

describe('the footer', () => {
  it('has the project, what agents read, and the sibling projects', async () => {
    const { footer } = await renderShell({ stars: null, weeklyDownloads: null });
    const columns = [...footer.matchAll(/<nav aria-label="([^"]+)">([\s\S]*?)<\/nav>/g)];
    expect(columns.map((c) => c[1])).toEqual(['Project', 'For agents', 'More by Diogo Esteves']);
    const [project, agents, more] = columns.map((c) => text(c[2] ?? ''));
    expect(project).toMatch(/^Project Docs Changelog Issues npm v\d+\.\d+\.\d+$/);
    expect(agents).toBe('For agents llms.txt llms-full.txt MCP server Docs over MCP');
    for (const sibling of MORE) expect(more).toContain(sibling.name);
    const links = columns[1]?.[2] ?? '';
    expect(links).toContain('href="/llms.txt"');
    expect(links).toContain('href="/llms-full.txt"');
    expect(links).toContain(`href="${REGISTRY.replace(/&/g, '&amp;')}"`);
  });

  it('shows npm’s weekly downloads when they were fetched', async () => {
    const { footer } = await renderShell({ stars: null, weeklyDownloads: 4321 });
    expect(text(footer)).toContain('npm · 4.3k a week');
    expect(text((await renderShell({ stars: null, weeklyDownloads: null })).footer)).not.toContain(
      'a week',
    );
  });
});

// ─── Metadata ───────────────────────────────────────────────────────────────

describe('Vercel Web Analytics', () => {
  it('renders once, with no options, as the last thing in <body>', () => {
    const layout = fs.readFileSync(path.join(site, 'app/layout.tsx'), 'utf8');
    expect(layout).toContain("import { Analytics } from '@vercel/analytics/next';");
    expect(layout.match(/<Analytics\b/g)).toHaveLength(1);
    expect(layout).toMatch(/<Analytics \/>\s*<\/body>/);
  });

  it('is a dependency of the site at 2.0.1, pinned as the site pins the rest', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(site, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies['@vercel/analytics']).toBe('^2.0.1');
  });
});

describe('page metadata', () => {
  it('sets no canonical URL, description or social card in the root layout', () => {
    const layout = fs.readFileSync(path.join(site, 'app/layout.tsx'), 'utf8');
    const metadata = /export const metadata: Metadata = \{([\s\S]*?)\n\};/.exec(layout)?.[1];
    expect(metadata).toBeDefined();
    expect(metadata).not.toMatch(/alternates|canonical|openGraph|twitter|description/);
    expect(layout).toContain("colorScheme: 'dark light'");
    expect(layout).toContain('suppressHydrationWarning');
    expect(layout).toContain('THEME_SCRIPT');
    expect(fs.existsSync(path.join(site, 'app/opengraph-image.tsx'))).toBe(false);
  });

  it('gives the home page its own canonical URL, card and short description', () => {
    expect(homeMetadata.alternates?.canonical).toBe('/');
    expect(homeMetadata.title).toEqual({
      absolute: 'onsystem: keeps coding agents on your design system',
    });
    expect(homeMetadata.description?.length).toBeLessThanOrEqual(160);
    expect(JSON.stringify(homeMetadata.openGraph)).toContain('"/og/home"');
  });

  it('describes the project to search engines as SoftwareSourceCode', () => {
    const html = renderToStaticMarkup(createElement(Home));
    const json = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
    const data = JSON.parse(json ?? '{}') as Record<string, unknown>;
    expect(data['@type']).toBe('SoftwareSourceCode');
    expect(data.codeRepository).toBe('https://github.com/dgesteves/onsystem');
    expect(String(data.description).length).toBeLessThanOrEqual(160);
  });

  it('keeps the 404 page out of search results, with its own description and no card', () => {
    expect(notFoundMetadata.robots).toEqual({ index: false });
    expect(notFoundMetadata.description).toMatch(/does not exist/);
    expect(notFoundMetadata.alternates).toBeUndefined();
    expect(notFoundMetadata.openGraph).toBeNull();
    expect(notFoundMetadata.twitter).toBeNull();
    expect(text(renderToStaticMarkup(createElement(NotFound)))).toContain('does not exist');
  });

  it.each(DOCS_PAGES.map((page) => page.href))(
    '%s: a description of 160 characters at most, and a card of its own',
    (href) => {
      const metadata = docsMetadata(href);
      expect(metadata.description?.length).toBeLessThanOrEqual(160);
      expect(metadata.alternates?.canonical).toBe(href);
      expect(JSON.stringify(metadata.openGraph)).toContain(`"/og/docs/${docsSlug(href)}"`);
    },
  );
});

describe('the docs cards', () => {
  it('are drawn for every docs page', () => {
    expect(cardParams().map((p) => p.slug)).toEqual(DOCS_PAGES.map((p) => docsSlug(p.href)));
    expect(new Set(cardParams().map((p) => p.slug)).size).toBe(DOCS_PAGES.length);
  });

  it('draw a PNG for a page, and nothing for an unknown one', async () => {
    const card = await docsCard(new Request(`${SITE_URL}/og/docs/eslint`), {
      params: Promise.resolve({ slug: 'eslint' }),
    });
    expect(card.headers.get('content-type')).toBe('image/png');
    expect(new Uint8Array(await card.arrayBuffer()).subarray(1, 4)).toEqual(
      new Uint8Array([0x50, 0x4e, 0x47]),
    );
    const missing = await docsCard(new Request(`${SITE_URL}/og/docs/nope`), {
      params: Promise.resolve({ slug: 'nope' }),
    });
    expect(missing.status).toBe(404);
  });

  it('list a page’s sections, leaving out headings inside code blocks', () => {
    expect(
      docsHeadings('## One\n\n```sh\n## not a heading\n```\n\n## `two` [three](x.md)'),
    ).toEqual(['One', 'two three']);
    const eslint = DOCS_PAGES.find((p) => p.href === '/docs/eslint');
    expect(eslint && docsMarkdown(eslint)).toBeTruthy();
    const faq = DOCS_PAGES.find((p) => p.href === '/docs/faq');
    expect(faq && docsMarkdown(faq)).toBeUndefined();
  });
});

// ─── Sitemap ────────────────────────────────────────────────────────────────

/** git in `cwd`, with fixed commit dates and an author, so the tests need no git config. */
function git(cwd: string, args: string[], date = '2026-01-01T00:00:00Z'): string {
  return execFileSync(
    'git',
    [
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    },
  ).trim();
}

/** A repository whose a.md, b.md and c.md were each added in a commit of their own. */
function threeCommits(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'site-git-'));
  git(repo, ['init', '-q']);
  for (const [file, date] of [
    ['a.md', '2026-01-01T00:00:00Z'],
    ['b.md', '2026-02-01T00:00:00Z'],
    ['c.md', '2026-03-01T00:00:00Z'],
  ] as const) {
    fs.writeFileSync(path.join(repo, file), file);
    git(repo, ['add', file], date);
    git(repo, ['commit', '-q', '-m', file], date);
  }
  return repo;
}

describe('dates from git', () => {
  it('are the date of the last commit that changed the files', () => {
    const repo = threeCommits();
    expect(lastModified(['a.md'], repo)).toEqual(new Date('2026-01-01T00:00:00Z'));
    expect(lastModified(['a.md', 'b.md'], repo)).toEqual(new Date('2026-02-01T00:00:00Z'));
    expect(lastModified(['no/such/file.md'], repo)).toBeNull();
    expect(lastModified(['a.md'], path.join(repo, 'not-a-repository'))).toBeNull();
  });

  it('are unknown in a shallow clone for files the fetched commits did not change', () => {
    const repo = threeCommits();
    const clone = fs.mkdtempSync(path.join(os.tmpdir(), 'site-git-shallow-'));
    git(clone, ['clone', '-q', '--depth', '2', `file://${repo}`, '.']);
    // The tip (c.md) has its parent; the clone's oldest commit (b.md) seems to add every file.
    expect(lastModified(['c.md'], clone)).toEqual(new Date('2026-03-01T00:00:00Z'));
    expect(lastModified(['b.md'], clone)).toBeNull();
    expect(lastModified(['a.md'], clone)).toBeNull();
  });
});

describe('the sitemap', () => {
  it('dates each page by its files’ last commit, and leaves the date out when git has none', () => {
    const entries = new Map(sitemap().map((entry) => [entry.url, entry]));
    for (const page of DOCS_PAGES) {
      const entry = entries.get(`${SITE_URL}${page.href}`);
      expect(entry, page.href).toBeDefined();
      expect(entry?.lastModified, page.href).toEqual(lastModified([page.source]) ?? undefined);
      expect(entry && 'lastModified' in entry, page.href).toBe(
        lastModified([page.source]) !== null,
      );
    }
  });
});
