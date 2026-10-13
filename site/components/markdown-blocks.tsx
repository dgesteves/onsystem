import type { ReactNode } from 'react';

import { Code } from '@/components/code';
import { AnchorHeading, plainLabel } from '@/components/heading';
import { InlineMarkdown } from '@/components/markdown';
import { ScrollRegion } from '@/components/scroll-region';
import { Tabs } from '@/components/tabs';
import type { Lang } from '@/lib/highlight';
import { forPackageManager, PACKAGE_MANAGERS } from '@/lib/package-managers';

/**
 * Renders the Markdown the docs use: headings, paragraphs, fenced code, lists (with code inside
 * items), tables, the `<details>` blocks that hold per-client configs, and the docs components:
 * callouts (GitHub's `> [!NOTE]`, `[!TIP]` and `[!WARNING]`), steps (each heading between
 * `<!-- steps -->` and `<!-- /steps -->`, numbered on the page), tabs (code blocks with `tab="…"`, or a ```sh pm block written with npm
 * for npm, pnpm, yarn and bun) and code titles (```json title="onsystem.config.json"). All of it
 * reads as plain Markdown on GitHub. It is not a general Markdown parser; anything outside that
 * subset shows up as plain text rather than breaking.
 */

export interface CodeBlock {
  type: 'code';
  lang: string;
  code: string;
  title?: string | undefined;
  /** This block's tab label, in a run of code blocks shown as tabs. */
  tab?: string | undefined;
  /** Written with npm, shown for each package manager. */
  pm?: boolean;
}

export type CalloutKind = 'note' | 'tip' | 'warning';

export type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | CodeBlock
  | { type: 'list'; ordered: boolean; items: Block[][] }
  | { type: 'table'; header: string[]; rows: string[][] }
  | { type: 'callout'; kind: CalloutKind; blocks: Block[] }
  | { type: 'quote'; blocks: Block[] }
  | { type: 'steps'; steps: { level: number; text: string; blocks: Block[] }[] }
  | { type: 'tabs'; label: string; group?: string | undefined; tabs: CodeBlock[] };

const LANGS: Record<string, Lang> = {
  tsx: 'tsx',
  jsx: 'tsx',
  ts: 'tsx',
  js: 'tsx',
  json: 'json',
  sh: 'sh',
  bash: 'sh',
  toml: 'toml',
  yaml: 'yaml',
  yml: 'yaml',
};

/** GitHub's alert types, as the three callouts the docs use. */
const CALLOUTS: Record<string, CalloutKind> = {
  NOTE: 'note',
  IMPORTANT: 'note',
  TIP: 'tip',
  WARNING: 'warning',
  CAUTION: 'warning',
};

/** A Markdown table's name, from its column headings, for the region it scrolls in. */
export function tableLabel(header: string[]): string {
  return `Table: ${header.map(plainLabel).filter(Boolean).join(', ')}`;
}

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/<[^>]+>|`/g, '')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

/** Lines that start a block of their own, and so end a paragraph. */
const BLOCK_START = /^(#{2,6} |```|\||>|<!--|(?:[-*]|\d+\.) )/;

export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (!trimmed) {
      i++;
      continue;
    }
    // Steps: every heading between the markers starts one.
    if (trimmed === '<!-- steps -->') {
      const body: string[] = [];
      i++;
      while (i < lines.length && (lines[i] ?? '').trim() !== '<!-- /steps -->') {
        body.push(lines[i++] ?? '');
      }
      i++;
      const steps: { level: number; text: string; blocks: Block[] }[] = [];
      for (const block of parseBlocks(body.join('\n'))) {
        if (block.type === 'heading') {
          steps.push({ level: block.level, text: block.text, blocks: [] });
        } else {
          steps.at(-1)?.blocks.push(block);
        }
      }
      blocks.push({ type: 'steps', steps });
      continue;
    }
    if (/^<!--.*-->$/.test(trimmed)) {
      i++;
      continue;
    }
    // `<details>`: its summary becomes a heading; the closing tags carry nothing.
    const summary = /<summary>(?:<strong>)?(.*?)(?:<\/strong>)?<\/summary>/.exec(trimmed);
    if (summary?.[1]) {
      blocks.push({ type: 'heading', level: 3, text: summary[1] });
      i++;
      continue;
    }
    if (/^<\/?(details|p|div)\b[^>]*>$/.test(trimmed)) {
      i++;
      continue;
    }
    const heading = /^(#{2,6}) (.*)$/.exec(line);
    if (heading?.[1] && heading[2]) {
      blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    const fence = /^```(\w*)(.*)$/.exec(trimmed);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) body.push(lines[i++] ?? '');
      i++;
      const meta = fence[2] ?? '';
      const block: CodeBlock = {
        type: 'code',
        lang: fence[1] ?? '',
        code: body.join('\n'),
        title: /\btitle="([^"]+)"/.exec(meta)?.[1],
        tab: /\btab="([^"]+)"/.exec(meta)?.[1],
        pm: /(?:^|\s)pm(?:\s|$)/.test(meta),
      };
      const previous = blocks.at(-1);
      if (block.pm) {
        blocks.push({
          type: 'tabs',
          label: 'Package manager',
          group: 'package-manager',
          tabs: PACKAGE_MANAGERS.map((pm) => ({
            ...block,
            code: forPackageManager(block.code, pm),
            tab: pm,
            pm: false,
          })),
        });
      } else if (block.tab && previous?.type === 'tabs' && !previous.group) {
        previous.tabs.push(block);
      } else if (block.tab) {
        blocks.push({ type: 'tabs', label: 'Variants', tabs: [block] });
      } else {
        blocks.push(block);
      }
      continue;
    }
    if (trimmed.startsWith('>')) {
      const quoted: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quoted.push((lines[i] ?? '').trim().replace(/^> ?/, ''));
        i++;
      }
      const alert = /^\[!(\w+)\]\s*$/.exec(quoted[0] ?? '');
      const kind = alert?.[1] ? CALLOUTS[alert[1].toUpperCase()] : undefined;
      blocks.push(
        kind
          ? { type: 'callout', kind, blocks: parseBlocks(quoted.slice(1).join('\n')) }
          : { type: 'quote', blocks: parseBlocks(quoted.join('\n')) },
      );
      continue;
    }
    if (trimmed.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('|')) {
        rows.push(cells(lines[i] ?? ''));
        i++;
      }
      const [header = [], , ...body] = rows;
      blocks.push({ type: 'table', header, rows: body });
      continue;
    }
    const item = /^(\s*)(?:[-*]|(\d+)\.) /.exec(line);
    if (item) {
      const ordered = item[2] !== undefined;
      const items: string[][] = [];
      while (i < lines.length) {
        const current = lines[i] ?? '';
        const start = /^(?:[-*]|\d+\.) (.*)$/.exec(current);
        if (start) {
          items.push([start[1] ?? '']);
          i++;
          continue;
        }
        // Continuation: indented lines, or a blank line followed by an indented one.
        if (/^\s{2,}\S/.test(current)) {
          items.at(-1)?.push(current.replace(/^\s{2,3}/, ''));
          i++;
          continue;
        }
        if (!current.trim() && /^\s{2,}\S/.test(lines[i + 1] ?? '')) {
          items.at(-1)?.push('');
          i++;
          continue;
        }
        // A blank line before the next item of the same list, such as after a code block.
        const next = /^(?:[-*]|(\d+)\.) /.exec(lines[i + 1] ?? '');
        if (!current.trim() && next && (next[1] !== undefined) === ordered) {
          i++;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'list',
        ordered,
        items: items.map((body) => parseBlocks(body.join('\n'))),
      });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length) {
      const current = lines[i] ?? '';
      if (
        !current.trim() ||
        BLOCK_START.test(current.trim()) ||
        /^<\/?(details|summary|p)\b/.test(current.trim())
      ) {
        break;
      }
      paragraph.push(current.trim());
      i++;
    }
    blocks.push({ type: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
}

function Heading({ level, text, className }: { level: number; text: string; className?: string }) {
  return (
    <AnchorHeading
      level={level <= 2 ? 2 : level === 3 ? 3 : 4}
      id={slug(text)}
      label={plainLabel(text)}
      className={className}
    >
      <InlineMarkdown text={text} />
    </AnchorHeading>
  );
}

const LANG_TITLES: Record<string, string> = { js: 'JavaScript', ts: 'TypeScript', jsx: 'JSX' };

function CodeFromMarkdown({ block, className }: { block: CodeBlock; className?: string }) {
  const lang = LANGS[block.lang] ?? 'text';
  return (
    <Code
      code={block.code}
      lang={lang}
      title={block.title ?? LANG_TITLES[block.lang]}
      className={className}
      copy={block.lang === 'tsx' ? undefined : 'Copy the code'}
    />
  );
}

const CALLOUT_STYLES: Record<CalloutKind, { title: string; frame: string; label: string }> = {
  note: { title: 'Note', frame: 'border-line-strong bg-raised/70', label: 'text-fg-soft' },
  tip: { title: 'Tip', frame: 'border-cyan/40 bg-cyan/[0.06]', label: 'text-cyan-bright' },
  warning: {
    title: 'Warning',
    frame: 'border-magenta/45 bg-magenta/[0.06]',
    label: 'text-magenta-soft',
  },
};

function Blocks({ blocks, shift }: { blocks: Block[]; shift: number }): ReactNode {
  return blocks.map((block, i) => {
    switch (block.type) {
      case 'heading':
        return <Heading key={i} level={Math.max(2, block.level - shift)} text={block.text} />;
      case 'paragraph':
        return (
          <p key={i} className="mt-4 leading-relaxed text-muted first:mt-0">
            <InlineMarkdown text={block.text} />
          </p>
        );
      case 'code':
        return <CodeFromMarkdown key={i} block={block} className="mt-4 first:mt-0" />;
      case 'tabs':
        return (
          <div key={i} className="mt-4 first:mt-0">
            <Tabs
              label={block.label}
              group={block.group}
              labels={block.tabs.map((tab) => tab.tab ?? '')}
            >
              {block.tabs.map((tab) => (
                <CodeFromMarkdown key={tab.tab} block={tab} />
              ))}
            </Tabs>
          </div>
        );
      case 'callout': {
        const style = CALLOUT_STYLES[block.kind];
        return (
          <div
            key={i}
            role="note"
            className={`mt-5 rounded-xl border px-4 py-3 text-[15px] first:mt-0 ${style.frame}`}
          >
            <p className={`font-mono text-[11px] tracking-[0.14em] uppercase ${style.label}`}>
              {style.title}
            </p>
            <div className="mt-1.5 [&>p]:mt-2 [&>p:first-child]:mt-0">
              <Blocks blocks={block.blocks} shift={shift} />
            </div>
          </div>
        );
      }
      case 'quote':
        return (
          <blockquote key={i} className="mt-4 border-l-2 border-line-strong pl-4 first:mt-0">
            <Blocks blocks={block.blocks} shift={shift} />
          </blockquote>
        );
      case 'steps':
        return (
          <ol key={i} className="mt-8 first:mt-0">
            {block.steps.map((step, n) => (
              <li key={n} className="relative pb-10 pl-11 last:pb-0">
                {/* The rail between the numbers. */}
                {n < block.steps.length - 1 && (
                  <span
                    className="absolute top-9 bottom-1 left-[0.9375rem] w-px bg-line"
                    aria-hidden="true"
                  />
                )}
                <span
                  className="absolute top-0 left-0 flex size-8 items-center justify-center rounded-full border border-line-strong bg-raised font-mono text-[13px] text-fg"
                  aria-hidden="true"
                >
                  {n + 1}
                </span>
                <Heading
                  level={Math.max(2, step.level - shift)}
                  text={step.text}
                  className="mt-0! pt-0.5"
                />
                <div className="mt-3">
                  <Blocks blocks={step.blocks} shift={shift} />
                </div>
              </li>
            ))}
          </ol>
        );
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return (
          <Tag
            key={i}
            className={`mt-4 grid gap-2.5 pl-5 leading-relaxed text-muted marker:text-subtle first:mt-0 ${block.ordered ? 'list-decimal' : 'list-disc'}`}
          >
            {block.items.map((item, j) => (
              <li key={j} className="min-w-0 pl-1 [&>p]:mt-2 [&>p:first-child]:mt-0">
                <Blocks blocks={item} shift={shift} />
              </li>
            ))}
          </Tag>
        );
      }
      case 'table':
        return (
          <div key={i} className="mt-5 first:mt-0">
            {/* Narrow screens get one card per row; tables of prose do not fit. */}
            <ul className="grid gap-3 sm:hidden">
              {block.rows.map((row, j) => (
                <li key={j} className="rounded-xl border border-line bg-raised/60 px-4 py-3">
                  <p className="text-[14.5px] text-fg-soft">
                    <InlineMarkdown text={row[0] ?? ''} />
                  </p>
                  <dl className="mt-2 grid gap-2 text-[14px] leading-relaxed">
                    {row.slice(1).map((cell, k) => (
                      <div key={k}>
                        <dt className="font-mono text-[11px] tracking-[0.12em] text-subtle uppercase">
                          <InlineMarkdown text={block.header[k + 1] ?? ''} />
                        </dt>
                        <dd className="mt-0.5 break-words text-muted">
                          <InlineMarkdown text={cell} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
            {/* A table wider than the column scrolls rather than being cut off. */}
            <div className="hidden overflow-hidden rounded-xl border border-line sm:block">
              <ScrollRegion label={tableLabel(block.header)}>
                <table className="w-full text-left text-[14px]">
                  <thead className="bg-raised">
                    <tr>
                      {block.header.map((cell, j) => (
                        <th
                          key={j}
                          scope="col"
                          className="px-4 py-2.5 align-bottom font-medium text-fg-soft"
                        >
                          <InlineMarkdown text={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/70">
                    {block.rows.map((row, j) => (
                      <tr key={j}>
                        {row.map((cell, k) => (
                          <td
                            key={k}
                            className={`px-4 py-3 align-top leading-relaxed break-words ${k === 0 ? 'text-fg-soft' : 'text-muted'}`}
                          >
                            <InlineMarkdown text={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ScrollRegion>
            </div>
          </div>
        );
    }
  });
}

/** Docs Markdown as page content. `shift` lowers heading levels: `###` → `h2` with 1. */
export function MarkdownBlocks({ markdown, shift = 0 }: { markdown: string; shift?: number }) {
  return (
    <div className="text-[15.5px]">
      <Blocks blocks={parseBlocks(markdown)} shift={shift} />
    </div>
  );
}
