import fs from 'node:fs';
import path from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import BenchmarkPage, { metadata } from '@/app/benchmark/page';
import Home from '@/app/page';
import sitemap from '@/app/sitemap';
import { markOverflow } from '@/components/scroll-region';
import { NAV } from '@/components/site-header';
import { llmsTxt } from '@/lib/llms';

// /benchmark against the files bench/v2's `report` wrote, read here directly rather than through
// generated/benchmark.json: a number on the page that differs from them fails.
const results = path.join(import.meta.dirname, '../../bench/v2/results/standard');

interface Rate {
  successes: number;
  n: number;
  value: number;
  low: number;
  high: number;
}
interface Interval {
  value: number;
  low: number;
  high: number;
}
interface Row {
  model: string;
  arm: string;
  runs: number;
  scored: number;
  created: Rate;
  tscPass: Rate;
  onsystemClean: Rate;
  accepted: Rate;
  onsystemErrors: Interval;
  cost: Interval;
  calls: number;
  hookBlocks: number;
  mcpCalls: number;
}
interface Delta {
  model: string;
  arm: string;
  pairs: number;
  tscPass: Interval;
  onsystemClean: Interval;
  accepted: Interval;
  onsystemErrors: Interval;
}

const json = JSON.parse(fs.readFileSync(path.join(results, 'results.json'), 'utf8')) as {
  info: { startedAt: string; repos: Record<string, unknown> };
  rows: Row[];
  deltas: Delta[];
};
const report = fs.readFileSync(path.join(results, 'results.md'), 'utf8');
const models = JSON.parse(
  fs.readFileSync(path.join(results, '../../config/models.json'), 'utf8'),
) as { models: { id: string; name: string; provider: string }[] };

// The formats, written out again so a wrong formatter fails too.
const minus = (s: string) => s.replace('-', '−');
const two = (x: number) => minus(x.toFixed(2));
const signedTwo = (x: number) => (x > 0 ? `+${x.toFixed(2)}` : two(x));
const pct = (x: number) => `${String(Math.round(x * 100))}%`;
const pts = (x: number) => {
  const n = Math.round(x * 100);
  return n > 0 ? `+${String(n)}` : n < 0 ? minus(String(n)) : '0';
};
const rate = (r: Rate) =>
  `${pct(r.value)} ${String(r.successes)}/${String(r.n)} [${pct(r.low)}, ${pct(r.high)}]`;
const errors = (i: Interval) => `${two(i.value)} [${two(i.low)}, ${two(i.high)}]`;
const signedErrors = (i: Interval) =>
  `${signedTwo(i.value)} [${signedTwo(i.low)}, ${signedTwo(i.high)}]`;
const delta = (i: Interval) => `${pts(i.value)} [${pts(i.low)}, ${pts(i.high)}]`;

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/\s+/g, ' ')
    .trim();

const html = renderToStaticMarkup(createElement(BenchmarkPage));

/** The text of each cell of a row of a table, by its data-col. */
function cells(table: string, row: string): Record<string, string> {
  const t = new RegExp(`<table data-table="${table}"[\\s\\S]*?</table>`).exec(html)?.[0];
  expect(t, `table ${table}`).toBeDefined();
  const escaped = row.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const tr = new RegExp(`<tr data-row="${escaped}">([\\s\\S]*?)</tr>`).exec(t ?? '')?.[1];
  expect(tr, `${table}: row ${row}`).toBeDefined();
  return Object.fromEntries(
    [...(tr ?? '').matchAll(/<td data-col="(\w+)"[^>]*>([\s\S]*?)<\/td>/g)].map(
      (m): [string, string] => [m[1] ?? '', text(m[2] ?? '')],
    ),
  );
}

function stat(id: string, page = html) {
  const block = new RegExp(`<div data-stat="${id}"[\\s\\S]*?</dd></div>`).exec(page)?.[0] ?? '';
  const value = (name: string) =>
    text(new RegExp(`data-value="${name}"[^>]*>([\\s\\S]*?)</(?:span|dd)>`).exec(block)?.[1] ?? '');
  return { before: value('before'), after: value('after'), note: value('note') };
}

const pooled = (model: string, arm: string) => {
  const row = json.rows.find((r) => r.model === model && r.arm === arm);
  if (!row) throw new Error(`no row ${model}/${arm}`);
  return row;
};
const runs = ['none', 'skill', 'mcp', 'hook', 'all'].reduce(
  (n, arm) => n + pooled('all models', arm).runs,
  0,
);
const modelIds = [...new Set(json.rows.map((r) => r.model).filter((m) => !m.endsWith(' models')))];
const providers = new Set(
  modelIds.map((id) => models.models.find((m) => m.id === id)?.provider ?? id),
);
const none = pooled('all models', 'none');
const all = pooled('all models', 'all');
const allDelta = json.deltas.find((d) => d.model === 'all models' && d.arm === 'all');

describe('/benchmark', () => {
  it('states the headline with the numbers in results.json', () => {
    expect(runs).toBe(1200);
    const sentence = `design-system rule violations per run went from ${two(none.onsystemErrors.value)} to ${two(all.onsystemErrors.value)} with onsystem's skill, MCP server and hook, with no change in tsc pass rate or cost per run (${runs.toLocaleString('en-US')} runs, ${String(modelIds.length)} models, ${String(providers.size)} providers, ${String(Object.keys(json.info.repos).length)} repositories)`;
    expect(sentence).toBe(
      "design-system rule violations per run went from 0.85 to 0.00 with onsystem's skill, MCP server and hook, with no change in tsc pass rate or cost per run (1,200 runs, 6 models, 3 providers, 5 repositories)",
    );
    const lead = /<p data-headline[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '';
    expect(text(lead)).toBe(`In the run of ${json.info.startedAt.slice(0, 10)}, ${sentence}.`);
    expect(lead).toContain('<code');
    // The description is the same result, short enough for a search result.
    expect(metadata.description).toBe(
      `Coding agents with and without onsystem, ${json.info.startedAt.slice(0, 10)}: rule violations per run went from 0.85 to 0.00 over 1,200 runs, 6 models and 5 repositories.`,
    );
    expect(metadata.description?.length).toBeLessThanOrEqual(160);
  });

  it('shows the headline figures from the pooled rows', () => {
    expect(stat('violations')).toEqual({
      before: two(none.onsystemErrors.value),
      after: two(all.onsystemErrors.value),
      note: `difference ${allDelta ? signedErrors(allDelta.onsystemErrors) : ''}; without onsystem [${two(none.onsystemErrors.low)}, ${two(none.onsystemErrors.high)}]`,
    });
    expect(stat('tsc')).toEqual({
      before: pct(none.tscPass.value),
      after: pct(all.tscPass.value),
      note: `difference ${pts(allDelta?.tscPass.value ?? NaN)} points [${pts(allDelta?.tscPass.low ?? NaN)}, ${pts(allDelta?.tscPass.high ?? NaN)}]`,
    });
    expect(stat('cost')).toEqual({
      before: `$${none.cost.value.toFixed(4)}`,
      after: `$${all.cost.value.toFixed(4)}`,
      note: `without onsystem [$${none.cost.low.toFixed(4)}, $${none.cost.high.toFixed(4)}]`,
    });
  });

  it('shows every arm, pooled over all models, as results.json has it', () => {
    for (const arm of ['none', 'skill', 'mcp', 'hook', 'all']) {
      const r = pooled('all models', arm);
      expect(cells('arms', `all models/${arm}`)).toEqual({
        runs: String(r.scored),
        onsystemErrors: errors(r.onsystemErrors),
        onsystemClean: rate(r.onsystemClean),
        tscPass: rate(r.tscPass),
        cost: `$${r.cost.value.toFixed(4)}`,
        hookBlocks: r.hookBlocks.toFixed(2),
        mcpCalls: r.mcpCalls.toFixed(1),
      });
    }
  });

  it('shows every row of results.json', () => {
    expect(json.rows).toHaveLength(45);
    for (const r of json.rows) {
      expect(cells('models', `${r.model}/${r.arm}`)).toEqual({
        arm: r.arm,
        runs: r.scored.toLocaleString('en-US'),
        onsystemErrors: errors(r.onsystemErrors),
        onsystemClean: rate(r.onsystemClean),
        tscPass: rate(r.tscPass),
        accepted: rate(r.accepted),
        created: pct(r.created.value),
        cost: `$${r.cost.value.toFixed(4)}`,
        calls: r.calls.toFixed(1),
        hookBlocks: r.hookBlocks.toFixed(2),
        mcpCalls: r.mcpCalls.toFixed(1),
      });
    }
  });

  it('shows every paired difference in results.json', () => {
    expect(json.deltas).toHaveLength(36);
    for (const d of json.deltas) {
      const expected = {
        pairs: d.pairs.toLocaleString('en-US'),
        onsystemErrors: signedErrors(d.onsystemErrors),
        onsystemClean: delta(d.onsystemClean),
        tscPass: delta(d.tscPass),
        accepted: delta(d.accepted),
      };
      expect(cells('model-deltas', `${d.model}/${d.arm}`)).toEqual({ arm: d.arm, ...expected });
      if (d.model === 'all models')
        expect(cells('deltas', `${d.model}/${d.arm}`)).toEqual(expected);
    }
  });

  it('shows the blind labels as results.md reports them', () => {
    const rows = report
      .split('\n')
      .filter((l) => /^\| (none|skill|mcp|hook|all) \| \d+ \|/.test(l))
      .map((l) => l.split('|').map((c) => c.trim()));
    expect(rows).toHaveLength(5);
    // results.md: "11/12 92% [65%, 99%]"; the page puts the percentage first.
    const swap = (s: string) => s.replace(/^(\d+\/\d+) (\d+%) /, '$2 $1 ');
    for (const [, arm = '', labelled, wouldMerge = '', clean = '', violations = ''] of rows) {
      expect(cells('labels', arm)).toEqual({
        labelled,
        clean: swap(clean),
        violations,
        wouldMerge: swap(wouldMerge),
      });
    }
    const agreement =
      /both found a problem in (\d+), only onsystem in (\d+), only the labeller in (\d+), neither in (\d+)\./.exec(
        report,
      );
    expect(text(/<p data-labels="agreement"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')).toBe(
      `Per file, onsystem and the labeller both found a problem in ${agreement?.[1] ?? ''}, only onsystem in ${agreement?.[2] ?? ''}, only the labeller in ${agreement?.[3] ?? ''} and neither in ${agreement?.[4] ?? ''}.`,
    );
    const precision = /judged correct: (\d+)\/(\d+) .*\((\d+) debatable/.exec(report);
    const tp = Number(precision?.[1]);
    const judged = Number(precision?.[2]);
    const debatable = Number(precision?.[3]);
    expect(text(/<p data-labels="precision"[^>]*>([\s\S]*?)<\/p>/.exec(html)?.[1] ?? '')).toBe(
      `Of onsystem's ${String(judged + debatable)} findings on these files, the labeller judged ${String(tp)} correct, ${String(judged - tp)} wrong and ${String(debatable)} debatable.`,
    );
  });

  it('says the labels are an AI reviewer’s, and which models share its family', () => {
    const labeller = fs.readFileSync(path.join(results, 'labels/LABELLER.md'), 'utf8');
    const who = models.models.find((m) => labeller.includes(`An AI reviewer, ${m.name}`));
    expect(who?.id).toBe('claude-opus-5-5');
    const family = modelIds
      .map((id) => models.models.find((m) => m.id === id))
      .filter((m) => m?.provider === who?.provider)
      .map((m) => m?.name);
    expect(family).toEqual(['Claude Haiku 5.5', 'Claude Sonnet 5.5']);
    const page = text(html);
    expect(page).toContain('labelled blind by an AI reviewer');
    expect(page).toContain(
      'Two of the six models (Claude Haiku 5.5 and Claude Sonnet 5.5) are from the same family as the labeller',
    );
    expect(page).not.toMatch(/human label|hand label|labelled by hand|human-labelled/i);
  });

  it('makes no claim about merging: the headline and its figures say nothing of it', () => {
    const top = html.slice(0, html.indexOf('id="results"'));
    expect(text(top)).not.toMatch(/merge/i);
    expect(text(html)).not.toMatch(/mergeable/i);
    expect(text(html)).toContain('Would merge (labeller)');
  });

  it('names each wide table by a caption, for the region it scrolls in on a phone', () => {
    // The tables with a minimum width; Markdown tables turn into cards on a phone instead.
    const tables = html.split('<table').filter((table) => /^[^>]*min-w-\[/.test(table));
    expect(tables.length).toBe(8);
    for (const table of tables) expect(table).toMatch(/^[^>]*><caption id="[\w-]+-caption"/);
    // Not a tab stop until the browser finds it wider than the screen.
    expect(html).not.toMatch(/<div[^>]*tabindex[^>]*>\s*<table/);
  });

  it('makes a table a focusable, named region only while it overflows', () => {
    const attributes = new Map<string, string>();
    const element = {
      scrollWidth: 720,
      clientWidth: 358,
      tabIndex: -1,
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => {
        attributes.delete(name);
        if (name === 'tabindex') element.tabIndex = -1;
      },
    };
    markOverflow(element as unknown as HTMLElement, 'arms-caption');
    expect(element.tabIndex).toBe(0);
    expect(Object.fromEntries(attributes)).toEqual({
      role: 'region',
      'aria-labelledby': 'arms-caption',
    });
    element.clientWidth = 1100;
    markOverflow(element as unknown as HTMLElement, 'arms-caption');
    expect(element.tabIndex).toBe(-1);
    expect(attributes.size).toBe(0);
  });

  it('links the transcripts release and how to reproduce it', () => {
    expect(html).toContain(
      'href="https://github.com/dgesteves/onsystem/releases/tag/bench-v2-2026-10-12"',
    );
    expect(text(html)).toContain('node bench/v2/run.mjs run --matrix standard');
  });
});

describe('the rest of the site', () => {
  it('points the header’s Benchmark item at /benchmark', () => {
    expect(NAV.find((item) => item.label === 'Benchmark')?.href).toBe('/benchmark');
  });

  it('lists /benchmark in the sitemap', () => {
    expect(sitemap().map((entry) => entry.url)).toContain('https://onsystem.vercel.app/benchmark');
  });

  it('keeps a summary on the home page that links to /benchmark', () => {
    const home = renderToStaticMarkup(createElement(Home));
    expect(text(home)).toContain(
      `${two(none.onsystemErrors.value)} to ${two(all.onsystemErrors.value)} with onsystem's skill`,
    );
    expect(stat('violations', home).after).toBe(two(all.onsystemErrors.value));
    expect(home).toContain('href="/benchmark"');
  });

  it('gives llms.txt the headline and the page', () => {
    const llms = llmsTxt();
    expect(llms).toContain(
      "design-system rule violations per run went from 0.85 to 0.00 with onsystem's skill, MCP server and hook",
    );
    expect(llms).toContain('https://onsystem.vercel.app/benchmark');
  });
});
