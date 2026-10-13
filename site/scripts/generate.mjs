// Generates the data the site renders, from the library itself, the demo design system in
// examples/shadcn-demo, the benchmark results in bench/agents and the README, so what the
// site shows is what the tool does at this commit. `pnpm build` and `pnpm dev` run it first.
// It needs the library built: `pnpm --dir .. build`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Two of the site's own modules, which import nothing, so Node loads them by stripping the types.
import { faqMarkdown } from '../lib/faq.ts';
import { withoutMarkers } from '../lib/markers.ts';

let lib;
try {
  lib = await import('onsystem');
} catch (error) {
  console.error(
    `Could not load onsystem (${error.message}).\nBuild the library first: pnpm --dir .. build`,
  );
  process.exit(1);
}
const { applyFixes, buildModel, DesignSystem, loadConfig, RULES, VERSION } = lib;

const site = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(site, '..');
const demoRoot = path.join(repo, 'examples/shadcn-demo');
const OUT = path.join(site, 'generated');
fs.mkdirSync(OUT, { recursive: true });

function write(name, data) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`generated/${name} ${(fs.statSync(file).size / 1024).toFixed(1)}kB`);
}

/** 1-based line and column → 0-based offset. */
function offsetOf(text, line, column) {
  let offset = 0;
  for (let i = 1; i < line; i++) offset = text.indexOf('\n', offset) + 1;
  return offset + column - 1;
}

// ─── The demo design system ────────────────────────────────────────────────

const config = await loadConfig({ root: demoRoot });
const { model } = await buildModel(config, { cache: false });
const ds = new DesignSystem(model, config);
assert.ok(ds.roots().length >= 5, 'the demo design system should have its components');

// ─── The loop: draft, check_ui, fix, clean ──────────────────────────────────

const demoFile = 'app/settings/danger-zone.tsx';
// The file starts with a comment explaining the demo; on the site the agent writes the file.
const draft = fs
  .readFileSync(path.join(demoRoot, demoFile), 'utf8')
  .replace(/^(?:\/\/[^\n]*\n)+/, '');
const result = ds.check(draft, demoFile);
assert.ok(result.errorCount > 0, 'the demo draft should have errors');

// What the agent writes after reading the findings: the mechanical fixes, plus the three
// it has to decide itself (a Badge variant, moving the inline style to classes, the import).
const fixed = applyFixes(draft, result.diagnostics)
  .replace('tone="warning"', 'variant="destructive"')
  .replace(
    ' style={{ color: "var(--muted-foreground)", marginTop: 6 }}',
    ' className="mt-1.5 text-muted-foreground"',
  )
  .replace(
    'import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"',
    'import {\n  Card,\n  CardContent,\n  CardDescription,\n  CardHeader,\n  CardTitle,\n} from "@/components/ui/card"',
  );
const after = ds.check(fixed, demoFile);
assert.equal(
  after.diagnostics.length,
  0,
  `the corrected demo should be clean, got ${JSON.stringify(after.diagnostics, null, 2)}`,
);

/** The short "found → fix" form the transcript shows for each finding. */
function shortForm(d) {
  let found = d.source;
  let fix = d.suggestion ?? '';
  if (d.ruleId === 'icon-button-accessible-name') found = '<Button size="icon">';
  else if (d.ruleId === 'prefer-design-system-component') found = `<${d.source}>`;
  else if (d.ruleId === 'no-unknown-component') found = `<${d.source}>`;
  else if (d.ruleId === 'no-unknown-prop') found = `${d.source}=`;
  else if (d.ruleId === 'no-unknown-variant') found = `variant=${d.source}`;
  else if (d.ruleId === 'no-hardcoded-spacing' && /^-?\d+$/.test(d.source))
    found = `marginTop: ${d.source}`;
  else if (d.source.startsWith('#')) found = `color: "${d.source}"`;
  if (d.ruleId === 'no-unknown-prop') fix = `${fix}=`;
  return { found, fix };
}

const findings = result.diagnostics.map((d) => ({
  ruleId: d.ruleId,
  severity: d.severity,
  message: d.message,
  line: d.line,
  column: d.column,
  start: offsetOf(draft, d.line, d.column),
  end: offsetOf(draft, d.endLine, d.endColumn),
  source: d.source,
  suggestion: d.suggestion ?? null,
  fixable: Boolean(d.fix?.length),
  ...shortForm(d),
}));

/**
 * Spans of `next` that are new relative to `prev`, from a longest-common-subsequence diff of
 * word tokens. Class names, tags and quoted values count as words, so a changed class lights
 * up on its own rather than the whole attribute.
 */
function changedSpans(prev, next) {
  const words = (text) =>
    [...text.matchAll(/"?[\w\-.#[\]:%@][\w\-.#[\]:%/@]*"?|[^\s\w]/g)].map((m) => ({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    }));
  const a = words(prev);
  const b = words(next);
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i][j] =
        a[i].text === b[j].text
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const changed = [];
  let i = 0;
  let j = 0;
  while (j < b.length) {
    if (i < a.length && a[i].text === b[j].text) {
      i++;
      j++;
    } else if (i < a.length && table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      changed.push(b[j]);
      j++;
    }
  }
  const spans = [];
  for (const word of changed) {
    const last = spans.at(-1);
    // Join neighbours on the same line separated only by spaces or `=`.
    if (last && /^[ \t=]*$/.test(next.slice(last.end, word.start))) last.end = word.end;
    else spans.push({ start: word.start, end: word.end });
  }
  return (
    spans
      // A lone comma or bracket is noise next to the real change.
      .filter((s) => /\w/.test(next.slice(s.start, s.end)))
      // A quote that belongs to an unchanged neighbour (`"rounded-sm` in `"rounded-sm bg-muted px-3"`).
      .map((s) => {
        const text = next.slice(s.start, s.end);
        if ((text.match(/"/g) ?? []).length !== 1) return s;
        return text.startsWith('"')
          ? { ...s, start: s.start + 1 }
          : text.endsWith('"')
            ? { ...s, end: s.end - 1 }
            : s;
      })
  );
}

/** Median wall time of `run`, in milliseconds. */
function median(run, times = 200) {
  const samples = [];
  for (let i = 0; i < times; i++) {
    const started = performance.now();
    run();
    samples.push(performance.now() - started);
  }
  samples.sort((x, y) => x - y);
  return samples[Math.floor(times / 2)];
}
const checkMs = median(() => ds.check(draft, demoFile));

write('demo.json', {
  prompt: 'Add a danger-zone card to the workspace settings page',
  file: demoFile,
  draft,
  fixed,
  findings,
  errorCount: result.errorCount,
  warningCount: result.warningCount,
  changes: changedSpans(draft, fixed),
  checkMs: Math.round(checkMs * 100) / 100,
});

// ─── The playground: the model to check against, and the drafts ────────────

// The route handler builds a DesignSystem from this JSON and never touches the filesystem.
// Paths from this machine are left out: the model only needs paths relative to the root.
const PLAYGROUND_FILE = 'app/playground.tsx';
const { root: _root, configFile: _configFile, tailwindConfig: _tailwind, ...portable } = config;
const playgroundConfig = { ...portable, root: '/demo' };
const playgroundModel = {
  ...model,
  root: '/demo',
  warnings: [],
  stats: { ...model.stats, durationMs: 0 },
};
const portableDs = new DesignSystem(
  JSON.parse(JSON.stringify(playgroundModel)),
  JSON.parse(JSON.stringify(playgroundConfig)),
);
// The JSON round trip must not change a single finding.
assert.deepEqual(
  portableDs.check(draft, demoFile).diagnostics,
  result.diagnostics,
  'the serialised model should check exactly like the loaded one',
);
write('playground-model.json', {
  file: PLAYGROUND_FILE,
  model: playgroundModel,
  config: playgroundConfig,
});

const { deleteDialog, snippet } = await import('./presets.mjs');
const demoSource = (file) =>
  fs.readFileSync(path.join(demoRoot, file), 'utf8').replace(/^(?:\/\/[^\n]*\n)+/, '');
const presets = [
  {
    id: 'danger-zone',
    label: 'Agent draft',
    file: 'danger-zone.tsx',
    description: 'The settings card from the home page demo: one problem per rule.',
    code: draft,
  },
  {
    id: 'delete-dialog',
    label: 'Dialog',
    file: 'delete-dialog.tsx',
    description: 'A confirmation dialog with props, parts and values from other libraries.',
    code: deleteDialog,
  },
  {
    id: 'snippet',
    label: 'Snippet',
    file: 'snippet.tsx',
    description: 'A fragment with no imports, the way agents often check code before saving it.',
    code: snippet,
  },
  {
    id: 'members',
    label: 'Clean',
    file: 'members.tsx',
    description: 'UI written against the design system: nothing to report.',
    code: demoSource('app/settings/members.tsx'),
  },
].map((preset) => ({ ...preset, result: portableDs.check(preset.code, PLAYGROUND_FILE) }));
for (const preset of presets) {
  const { errorCount, warningCount, diagnostics } = preset.result;
  const clean = preset.id === 'members';
  assert.ok(
    clean
      ? diagnostics.length === 0
      : errorCount > 0 && !diagnostics.some((d) => d.ruleId === 'syntax'),
    `preset ${preset.id}: unexpected result ${JSON.stringify(diagnostics.map((d) => d.ruleId))}`,
  );
  console.log(`  preset ${preset.id}: ${errorCount} errors, ${warningCount} warnings`);
}
write('playground.json', { file: PLAYGROUND_FILE, presets });

// ─── What the agent sees: the real MCP server over stdio ────────────────────

const pkg = JSON.parse(
  fs.readFileSync(fileURLToPath(import.meta.resolve('onsystem/package.json')), 'utf8'),
);
const cli = path.join(
  path.dirname(fileURLToPath(import.meta.resolve('onsystem/package.json'))),
  pkg.bin.onsystem,
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [cli, '--root', demoRoot, '--no-watch', '--no-cache'],
  stderr: 'pipe',
});
const client = new Client({ name: 'onsystem-site', version: VERSION });
await client.connect(transport);
const text = (r) => r.content.find((c) => c.type === 'text')?.text ?? '';
const { tools } = await client.listTools();
const { prompts } = await client.listPrompts();
const { resourceTemplates } = await client.listResourceTemplates();
const { resources } = await client.listResources();
const samples = [];
for (const [name, args] of [
  ['search_components', { query: 'confirm a destructive action', limit: 3 }],
  ['get_component', { name: 'Badge' }],
  ['get_tokens', { category: 'color', query: 'destructive' }],
  [
    'check_ui',
    { code: '<Button variant="primary" className="bg-blue-600 px-[18px]">Save</Button>' },
  ],
]) {
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, `${name} failed: ${text(response)}`);
  samples.push({ tool: name, args, output: text(response) });
}
await client.close();

write('tools.json', {
  version: VERSION,
  tools: tools.map((t) => ({ name: t.name, title: t.title ?? t.name, description: t.description })),
  prompts: prompts.map((p) => ({ name: p.name, title: p.title, description: p.description })),
  resources: [
    ...resources.filter((r) => !r.uri.startsWith('ds://components/')).map((r) => r.uri),
    ...resourceTemplates.map((r) => r.uriTemplate),
  ],
  samples,
});

// ─── The demo design system, as the agent sees it ───────────────────────────

write('design-system.json', {
  components: ds.roots().map((c) => ({
    name: c.name,
    description: c.description ?? null,
    element: c.element ?? null,
    variants: Object.fromEntries(c.variants.map((v) => [v.name, v.values])),
    parts: c.subcomponents,
  })),
  tokens: Object.fromEntries(
    ['color', 'spacing', 'radius', 'typography', 'shadow', 'other'].map((category) => [
      category,
      ds.tokens.filter((t) => t.category === category).length,
    ]),
  ),
});

// ─── The benchmark ──────────────────────────────────────────────────────────

const bench = path.join(repo, 'bench/agents');
const tasks = JSON.parse(fs.readFileSync(path.join(bench, 'tasks.json'), 'utf8'));
const MODEL_NAMES = { 'haiku-4-5': 'Claude Haiku 4.5', 'opus-5': 'Claude Opus 5' };
const models = fs
  .readdirSync(path.join(bench, 'results'))
  .filter((dir) => fs.statSync(path.join(bench, 'results', dir)).isDirectory())
  .sort()
  .map((dir) => {
    const runs = fs
      .readdirSync(path.join(bench, 'results', dir))
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(fs.readFileSync(path.join(bench, 'results', dir, f), 'utf8')));
    const summary = (condition) => {
      const list = runs.filter((r) => r.condition === condition);
      assert.equal(list.length, tasks.length, `${dir}/${condition} should have a run per task`);
      const sum = (key) => list.reduce((total, r) => total + r[key], 0);
      return {
        runs: list.length,
        clean: list.filter((r) => r.errors === 0).length,
        errors: sum('errors'),
        warnings: sum('warnings'),
        cost: Math.round(sum('cost') * 100) / 100,
        seconds: Math.round(sum('seconds') / list.length),
        turns: Math.round((sum('turns') / list.length) * 10) / 10,
        toolCalls: Math.round((sum('mcpCalls') / list.length) * 10) / 10,
        hookBlocks: sum('hookBlocks'),
      };
    };
    const base = summary('base');
    const plugin = summary('plugin');
    return {
      id: dir,
      name: MODEL_NAMES[dir] ?? dir,
      base,
      plugin,
      costDelta: Math.round(((plugin.cost - base.cost) / base.cost) * 100),
      tasks: tasks.map((task) => {
        const of = (condition) => {
          const run = runs.find((r) => r.task === task.id && r.condition === condition);
          return { errors: run.errors, byRule: run.byRule };
        };
        return { id: task.id, base: of('base'), plugin: of('plugin') };
      }),
    };
  });
write('bench.json', {
  project: 'vercel/ai-chatbot',
  tasks: tasks.map((t) => ({ id: t.id, file: t.file, prompt: t.prompt })),
  models,
});

// ─── The benchmark, v2 ──────────────────────────────────────────────────────

// /benchmark renders bench/v2's standard run from the files `run.mjs report` writes: the tables
// from results.json, the blind labels from results.md (report renders them there and nowhere
// else), time and cost from the ledger and runs.csv, and the method from the README and config.
const v2 = path.join(repo, 'bench/v2');
const readV2 = (file) => fs.readFileSync(path.join(v2, file), 'utf8');
const v2Results = JSON.parse(readV2('results/standard/results.json'));
const v2Info = v2Results.info;
const v2Readme = readV2('README.md');
const v2Report = readV2('results/standard/results.md');
const v2Models = JSON.parse(readV2('config/models.json')).models;
const v2Repos = JSON.parse(readV2('config/repos.json')).repos;
const v2Tasks = JSON.parse(readV2('config/tasks.json')).tasks;

/** Links in bench/v2/README.md, relative to bench/v2, made relative to the repository root. */
function benchLinks(markdown) {
  return markdown.replace(/\]\(([^)]+)\)/g, (match, href) =>
    /^(?:https?:|#|\/)/.test(href) ? match : `](${path.posix.join('bench/v2', href)})`,
  );
}

const ARM_NAMES = ['none', 'skill', 'mcp', 'hook', 'all'];
const PROVIDER_NAMES = { anthropic: 'Anthropic', openai: 'OpenAI', google: 'Google' };
const modelRows = v2Results.rows.filter((r) => !r.model.endsWith(' models'));
const runModels = [...new Set(modelRows.map((r) => r.model))].map((id) => {
  const model = v2Models.find((m) => m.id === id);
  assert.ok(model, `bench/v2/config/models.json has no model ${id}`);
  const runs = modelRows.filter((r) => r.model === id).reduce((n, r) => n + r.runs, 0);
  return { id, name: model.name, provider: model.provider, tier: model.tier, runs };
});
const pooled = (model, arm) => {
  const row = v2Results.rows.find((r) => r.model === model && r.arm === arm);
  assert.ok(row, `results.json has no row for ${model}, ${arm}`);
  return row;
};
for (const arm of ARM_NAMES) pooled('all models', arm);
const v2RunCount = ARM_NAMES.reduce((n, arm) => n + pooled('all models', arm).runs, 0);

// The headline, checked here so the page cannot state it once the results stop saying it:
// fewer errors with all three parts, no change in tsc passes (the paired difference's interval
// holds 0), and the same cost per run (inside the interval of the run without onsystem).
const none = pooled('all models', 'none');
const all = pooled('all models', 'all');
const allDelta = v2Results.deltas.find((d) => d.model === 'all models' && d.arm === 'all');
assert.ok(allDelta, 'results.json has no paired difference for all models, all');
assert.ok(all.onsystemErrors.value < none.onsystemErrors.value, 'all should have fewer errors');
assert.ok(
  allDelta.tscPass.low <= 0 && allDelta.tscPass.high >= 0,
  'the tsc pass rate should not change with all three parts',
);
assert.ok(
  all.cost.value >= none.cost.low && all.cost.value <= none.cost.high,
  'the cost per run should not change with all three parts',
);

// Wall-clock time from the first start to the last finished attempt; seconds per run.
const ledger = readV2('results/standard/ledger.jsonl')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const [csvHeader, ...csvLines] = readV2('results/standard/runs.csv').trim().split('\n');
const csvColumns = csvHeader.split(',');
const runsCsv = csvLines.map((line) => {
  const cells = line.split(',');
  assert.equal(cells.length, csvColumns.length, `runs.csv: unexpected row ${line}`);
  return Object.fromEntries(csvColumns.map((c, i) => [c, cells[i]]));
});
assert.equal(runsCsv.length, v2RunCount, 'runs.csv and results.json should count the same runs');
const seconds = runsCsv.map((r) => Number(r.seconds)).sort((a, b) => a - b);
const statuses = {};
for (const r of runsCsv) statuses[r.status] = (statuses[r.status] ?? 0) + 1;
const lastAt = Math.max(...ledger.map((entry) => Date.parse(entry.at)));

// The blind labels: report writes them to results.md only, so they are read from there.
const labelSection = section(v2Report, '## Blind labels', 'results.md');
const labelTable = table(labelSection);
assert.deepEqual(
  labelTable.header,
  [
    'Arm',
    'Files labelled',
    'Would merge',
    'No violations (labeller)',
    'Violations / file (labeller)',
  ],
  'results.md: unexpected blind-labels table',
);
function parseRate(text) {
  const m = /^(\d+)\/(\d+) (\d+)% \[(\d+)%, (\d+)%\]$/.exec(text);
  assert.ok(m, `results.md: "${text}" is not a rate`);
  const [successes, n, percent, low, high] = m.slice(1).map(Number);
  return { successes, n, percent, low, high };
}
function parseMean(text) {
  const m = /^(\d+\.\d+) \[(\d+\.\d+), (\d+\.\d+)\]$/.exec(text);
  assert.ok(m, `results.md: "${text}" is not a mean with an interval`);
  const [value, low, high] = m.slice(1).map(Number);
  return { value, low, high };
}
const agreement =
  /per file: both found a problem in (\d+), only onsystem in (\d+), only the labeller in (\d+), neither in (\d+)\./.exec(
    labelSection,
  );
assert.ok(agreement, 'results.md: the agreement line is missing');
const precision = /findings judged correct: (.+?)(?: \((\d+) debatable, left out\))?\.$/m.exec(
  labelSection,
);
assert.ok(precision, 'results.md: the precision line is missing');
const labelRows = readV2('results/standard/labels/labels.csv')
  .trim()
  .split('\n')
  .slice(1)
  .filter((line) => /^S\d+,/.test(line));
const findingRows = readV2('results/standard/labels/findings.csv')
  .trim()
  .split('\n')
  .filter((line) => /^S\d+,/.test(line));

const labelArms = labelTable.rows.map(([arm, labelled, wouldMerge, clean, violations]) => ({
  arm,
  labelled: Number(labelled),
  wouldMerge: parseRate(wouldMerge),
  clean: parseRate(clean),
  violations: parseMean(violations),
}));
const labelPrecision = { ...parseRate(precision[1]), debatable: Number(precision[2] ?? 0) };
assert.equal(
  labelArms.reduce((n, a) => n + a.labelled, 0),
  labelRows.length,
  'results.md should count every row of labels.csv',
);
assert.equal(
  labelPrecision.n + labelPrecision.debatable,
  findingRows.length,
  'results.md should count every row of findings.csv',
);

// Who labelled: LABELLER.md says it, and the page must too.
const labeller = readV2('results/standard/labels/LABELLER.md');
const who = section(labeller, '## Who', 'LABELLER.md');
assert.ok(/AI reviewer/.test(who), 'LABELLER.md: the page says the labeller is an AI reviewer');
const labellerModel = v2Models.find((m) => who.includes(m.name));
assert.ok(labellerModel, 'LABELLER.md should name the labeller model as config/models.json does');
const sameFamily = runModels.filter((m) => m.provider === labellerModel.provider);

const release = /\((https:\/\/github\.com\/[^)]+\/releases\/tag\/(bench-v2-[\w-]+))\)/.exec(
  v2Readme,
);
assert.ok(release, 'bench/v2/README.md should link the transcripts release');
const running = section(v2Readme, '## Running it', 'bench/v2/README.md').split('\n### ')[0];

write('benchmark.json', {
  matrix: v2Info.matrix,
  date: v2Info.startedAt.slice(0, 10),
  onsystem: v2Info.onsystem,
  runs: v2RunCount,
  statuses,
  models: runModels,
  providers: [...new Set(runModels.map((m) => m.provider))].map((id) => ({
    id,
    name: PROVIDER_NAMES[id] ?? id,
  })),
  arms: ARM_NAMES,
  repos: Object.values(v2Info.repos).map((r) => {
    const config = v2Repos.find((c) => c.name === r.name);
    assert.ok(config, `bench/v2/config/repos.json has no repository ${r.name}`);
    return {
      name: r.name,
      url: r.url,
      sha: r.sha,
      project: config.project,
      typescript: r.typescript,
      designSystem: config.designSystem,
    };
  }),
  tasks: v2Tasks
    .filter((t) => t.repo in v2Info.repos)
    .map((t) => ({ id: t.id, repo: t.repo, prompt: t.prompt })),
  rows: v2Results.rows,
  deltas: v2Results.deltas,
  cost: {
    total: ledger.reduce((sum, entry) => sum + entry.cost, 0),
    cap: v2Info.cap,
    pricesVerified: v2Info.pricesVerified,
  },
  time: {
    wallMinutes: Math.round((lastAt - Date.parse(v2Info.startedAt)) / 60_000),
    medianSeconds: seconds[Math.floor(seconds.length / 2)],
    minSeconds: seconds[0],
    maxSeconds: seconds.at(-1),
  },
  labels: {
    files: labelRows.length,
    findings: findingRows.length,
    labeller: {
      kind: 'AI reviewer',
      model: labellerModel.name,
      provider: PROVIDER_NAMES[labellerModel.provider] ?? labellerModel.provider,
      sameFamily: sameFamily.map((m) => m.id),
    },
    arms: labelArms,
    agreement: {
      both: Number(agreement[1]),
      onsystemOnly: Number(agreement[2]),
      labellerOnly: Number(agreement[3]),
      neither: Number(agreement[4]),
    },
    precision: labelPrecision,
  },
  method: {
    v1: benchLinks(section(v2Readme, '## What changes from v1', 'bench/v2/README.md')),
    arms: benchLinks(section(v2Readme, '### Arms', 'bench/v2/README.md')),
    scoring: benchLinks(section(v2Readme, '### Scoring', 'bench/v2/README.md')),
    statistics: benchLinks(section(v2Readme, '### Statistics', 'bench/v2/README.md')),
    threats: benchLinks(section(v2Readme, '### Threats to validity', 'bench/v2/README.md')),
    running: benchLinks(running),
  },
  release: { url: release[1], tag: release[2] },
});

// ─── The corpus: how often the rules are wrong ──────────────────────────────

// The numbers `pnpm corpus` prints, from the files it writes: the labels in the random
// sample that the snapshot says are still reported, and the findings per run and rule.
const corpusDir = path.join(repo, 'corpus');
const readCorpus = (file) => JSON.parse(fs.readFileSync(path.join(corpusDir, file), 'utf8'));
const corpusSnapshot = readCorpus('snapshot.json');
// As labelKey in scripts/corpus-lib.ts: a label tied to a suggestion is keyed with it.
const labelKey = (label) =>
  label.suggestion === undefined
    ? label.fingerprint
    : `${label.fingerprint}@${label.suggestion ?? 'none'}`;
const sample = readCorpus('labels.json').filter(
  (label) => label.sample === 'random' && corpusSnapshot.labels[labelKey(label)] === true,
);
const corpusRepos = readCorpus('repos.json').repos;
// A run with a config of its own checks the same files as another run: not counted twice.
const rechecks = new Set(
  corpusRepos.flatMap((repo) => repo.runs.filter((run) => run.config).map((run) => run.name)),
);
let corpusFindings = 0;
let corpusCovered = 0;
let corpusWeighted = 0;
// A run from a monorepo root counts only the findings it adds to the runs from its projects.
for (const [run, { rules, added }] of Object.entries(corpusSnapshot.runs)) {
  for (const [rule, counts] of Object.entries(added ?? rules)) {
    const n = counts.errors + counts.warnings;
    if (!rechecks.has(run)) corpusFindings += n;
    const stratum = sample.filter((label) => label.run === run && label.rule === rule);
    if (!stratum.length) continue;
    corpusCovered += n;
    corpusWeighted +=
      (n * stratum.filter((label) => label.verdict === 'FP').length) / stratum.length;
  }
}
assert.ok(sample.length > 0 && corpusCovered > 0, 'the corpus should have a labelled sample');
// The baseline example: midday's dashboard, as the corpus checks it (`check src`).
const midday = corpusSnapshot.runs['midday-dashboard'];
assert.ok(midday?.flagged !== undefined, 'the corpus snapshot should have midday-dashboard');
write('corpus.json', {
  repos: corpusRepos.length,
  runs: Object.keys(corpusSnapshot.runs).length,
  /** Distinct findings: a root run counts what it adds, a run with a config not at all. */
  findings: corpusFindings,
  sample: sample.length,
  truePositives: sample.filter((label) => label.verdict === 'TP').length,
  falsePositives: sample.filter((label) => label.verdict === 'FP').length,
  debatable: sample.filter((label) => label.verdict === 'D').length,
  /** False positives as a share of all findings, weighted by each run's and rule's share. */
  weightedRate: corpusWeighted / corpusCovered,
  baseline: {
    findings: Object.values(midday.rules).reduce((n, c) => n + c.errors + c.warnings, 0),
    flagged: midday.flagged,
    files: midday.files,
  },
});

// ─── From the docs and the README ───────────────────────────────────────────

// The docs pages live in docs/*.md, readable on GitHub and rendered here; the README keeps the
// install links. Links between docs files (`ci.md#…`) are mapped to site pages when rendered.
const readme = fs.readFileSync(path.join(repo, 'README.md'), 'utf8');
/** A docs/ file without its `# title`: the site's page has its own. */
function doc(name) {
  const text = fs.readFileSync(path.join(repo, 'docs', name), 'utf8');
  assert.ok(/^# .+\n/.test(text), `docs/${name} should start with a # title`);
  return text.replace(/^# .*\n+/, '').trim();
}

/**
 * The body of a `## heading` section of `markdown`, up to the next heading of the same or a
 * higher level. Lines inside code fences are not headings (`# Baseline: …` in a shell block).
 */
function section(markdown, heading, where) {
  const lines = markdown.split('\n');
  const level = heading.match(/^#+/)[0].length;
  const start = lines.indexOf(heading);
  assert.ok(start !== -1, `section "${heading}" not found in ${where}`);
  let fenced = false;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*```/.test(lines[i])) fenced = !fenced;
    const depth = fenced ? 0 : (/^(#+) /.exec(lines[i])?.[1].length ?? 0);
    if (depth && depth <= level) {
      end = i;
      break;
    }
  }
  return lines
    .slice(start + 1, end)
    .join('\n')
    .trim();
}

/** Rows of the first Markdown table in `markdown`, as arrays of cell Markdown. */
function table(markdown) {
  const lines = markdown.split('\n').filter((l) => l.startsWith('|'));
  const cells = (line) =>
    line
      .slice(1, -1)
      .split(/(?<!\\)\|/)
      .map((c) => c.trim());
  const [header, , ...rows] = lines;
  assert.ok(header && rows.length, 'expected a Markdown table');
  return { header: cells(header), rows: rows.map(cells) };
}

/** The target of the link with this text: a README badge (`[![alt](…)](…)`) or a plain link. */
function linkTo(markdown, text, where) {
  const match =
    new RegExp(`\\[!\\[${text}\\]\\([^)]*\\)\\]\\(([^)]+)\\)`).exec(markdown) ??
    new RegExp(`\\[${text}\\]\\(([^)]+)\\)`).exec(markdown);
  assert.ok(match, `link "${text}" not found in ${where}`);
  return match[1];
}

/** The first fenced code block in `markdown`. */
function codeBlock(markdown) {
  const match = /```\w*\n([\s\S]*?)\n```/.exec(markdown);
  assert.ok(match, 'expected a code block');
  return match[1];
}

const docs = {
  quickstart: doc('quickstart.md'),
  plugin: doc('plugin.md'),
  ci: doc('ci.md'),
  requiredCheck: doc('required-check.md'),
  clients: doc('clients.md'),
  configuration: doc('configuration.md'),
  designSystemPackages: doc('design-system-packages.md'),
  tokens: doc('tokens.md'),
  eslint: doc('eslint.md'),
  rules: doc('rules.md'),
  tools: doc('tools.md'),
  troubleshooting: doc('troubleshooting.md'),
  howItWorks: doc('how-it-works.md'),
  migrating: doc('migrating.md'),
};

// The one-click installs: the README's badges, and the same links in the setup guide.
const install = {
  cursor: linkTo(readme, 'Install in Cursor', 'README.md'),
  vscode: linkTo(readme, 'Install in VS Code', 'README.md'),
  plugin: codeBlock(docs.plugin),
};
for (const [text, href] of [
  ['Install in Cursor', install.cursor],
  ['Install in VS Code', install.vscode],
]) {
  assert.equal(
    linkTo(docs.clients, text, 'docs/clients.md'),
    href,
    `${text}: README and docs differ`,
  );
}
assert.ok(readme.includes(install.plugin), 'the README should show the plugin install commands');

const realCodebases = section(docs.howItWorks, '## On real codebases', 'docs/how-it-works.md');
write('readme.json', {
  install,
  realCodebases: {
    intro: realCodebases.split('\n\n')[0],
    ...table(realCodebases),
  },
  engines: JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).engines,
});

// ─── The rules catalog ──────────────────────────────────────────────────────

const { ruleDocs } = await import('./rule-docs.mjs');
const ruleTable = table(docs.rules);
const EXAMPLE_FILE = 'app/example.tsx';

/**
 * The example with its first finding suppressed by a comment on the line before: `//` at the
 * top level, `{/* … *\/}` inside JSX. Checked: that line's findings go, the others stay.
 */
function suppressedExample(id, bad, own) {
  const line = own[0].line;
  const lines = bad.split('\n');
  const indent = /^\s*/.exec(lines[line - 1])[0];
  const text = `onsystem-disable-next-line ${id} -- why this one is intended`;
  lines.splice(line - 1, 0, line === 1 ? `// ${text}` : `${indent}{/* ${text} */}`);
  const code = lines.join('\n');
  const after = ds.check(code, EXAMPLE_FILE).diagnostics;
  assert.deepEqual(
    after.map((d) => [d.ruleId, d.line - 1]),
    own.filter((d) => d.line !== line).map((d) => [d.ruleId, d.line]),
    `the suppressed ${id} example should keep only the findings on other lines`,
  );
  return { code, line };
}
const rules = RULES.map((rule) => {
  const docs = ruleDocs[rule.id];
  assert.ok(docs, `scripts/rule-docs.mjs has no entry for ${rule.id}`);
  const row = ruleTable.rows.find((r) => r[0] === `\`${rule.id}\``);
  assert.ok(row, `the docs/rules.md table has no row for ${rule.id}`);
  const before = ds.check(docs.bad, EXAMPLE_FILE);
  const own = before.diagnostics.filter((d) => d.ruleId === rule.id);
  assert.ok(own.length > 0, `the ${rule.id} example should trip it`);
  assert.equal(
    own.length,
    before.diagnostics.length,
    `the ${rule.id} example should trip only that rule: ${JSON.stringify(before.diagnostics.map((d) => d.ruleId))}`,
  );
  for (const related of docs.related) {
    assert.ok(
      related !== rule.id && RULES.some((r) => r.id === related),
      `scripts/rule-docs.mjs: ${rule.id} lists an unknown related rule ${related}`,
    );
  }
  const good = docs.good ?? applyFixes(docs.bad, own);
  const after = ds.check(good, EXAMPLE_FILE);
  assert.equal(
    after.diagnostics.length,
    0,
    `the fixed ${rule.id} example should be clean: ${JSON.stringify(after.diagnostics)}`,
  );
  return {
    id: rule.id,
    description: rule.description,
    severity: config.rules[rule.id].severity,
    catches: row[2],
    suggests: row[3],
    why: docs.why,
    allow: docs.allow ?? null,
    bad: docs.bad,
    good,
    fixedBy: docs.good ? 'hand' : 'rule',
    related: docs.related,
    suppressed: suppressedExample(rule.id, docs.bad, own),
    changes: changedSpans(docs.bad, good),
    findings: own.map((d) => ({
      severity: d.severity,
      message: d.message,
      line: d.line,
      column: d.column,
      start: offsetOf(docs.bad, d.line, d.column),
      end: offsetOf(docs.bad, d.endLine, d.endColumn),
      suggestion: d.suggestion ?? null,
      fixable: Boolean(d.fix?.length),
    })),
  };
});
const suppression = section(docs.rules, '## Suppressing findings', 'docs/rules.md');
// The paragraph after the examples: what each comment covers, and overrides for whole folders.
const suppressionScope = suppression.split('\n\n').at(-1);
assert.ok(
  suppressionScope.startsWith('`onsystem-disable-next-line` covers'),
  'docs/rules.md: the suppression section should end with what each comment covers',
);
write('rules.json', {
  version: VERSION,
  rules,
  // How colors, spacing and radius fixes are chosen, and how to suppress a finding.
  details: section(docs.rules, '## How fixes are chosen', 'docs/rules.md'),
  suppression,
  suppressionScope,
});

// ─── Docs ───────────────────────────────────────────────────────────────────

const skill = fs
  .readFileSync(path.join(repo, 'plugins/onsystem/skills/onsystem/SKILL.md'), 'utf8')
  .replace(/^---\n[\s\S]*?\n---\n/, '')
  .trim();
write('docs.json', {
  ...docs,
  // The FAQ and the landing page link to it; the rules page shows the rules.
  limits: section(docs.howItWorks, '## Limits', 'docs/how-it-works.md'),
  skill,
});

// ─── Social proof ───────────────────────────────────────────────────────────

// The repository's stars and the package's downloads last week, fetched once per build without
// a token. Either is null when the request fails (no network, a rate limit), and the site then
// leaves it out rather than showing a stale or made-up number.
async function fetchJson(url) {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': 'onsystem-site-build' },
      signal: AbortSignal.timeout(5000),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}
const [repoInfo, downloads] = await Promise.all([
  fetchJson('https://api.github.com/repos/dgesteves/onsystem'),
  fetchJson('https://api.npmjs.org/downloads/point/last-week/onsystem'),
]);
const count = (value) => (Number.isInteger(value) && value >= 0 ? value : null);
write('social.json', {
  stars: count(repoInfo?.stargazers_count),
  weeklyDownloads: count(downloads?.downloads),
});

// ─── The docs index for Ask and MCP ─────────────────────────────────────────

// ondocs's search index over the docs and the rules, for /api/ask and /api/mcp. Keyword-only
// (BM25, no embedding model), so building it needs no API key and an agent's searches over MCP
// call no model at all. The pages are those of DOCS_FILES in lib/site.ts, plus the FAQ;
// test/ask.test.ts keeps the lists in step. The Markdown loses the renderer's own markers, as on
// the site's .md pages and in llms-full.txt.
const { buildIndex, fromMarkdown, serializeIndexFile } = await import('ondocs');
const ASK_PAGES = {
  'quickstart.md': '/docs',
  'plugin.md': '/docs/plugin',
  'ci.md': '/docs/ci',
  'required-check.md': '/docs/required-check',
  'clients.md': '/docs/clients',
  'configuration.md': '/docs/configuration',
  'design-system-packages.md': '/docs/design-system-packages',
  'tokens.md': '/docs/tokens',
  'eslint.md': '/docs/eslint',
  'tools.md': '/docs/tools',
  'troubleshooting.md': '/docs/troubleshooting',
  'how-it-works.md': '/docs/how-it-works',
  'migrating.md': '/docs/migrating',
  'rules.md': '/rules',
};
const fence = (code, lang) => `\`\`\`${lang}\n${code.trimEnd()}\n\`\`\``;
const askDocuments = [
  ...Object.entries(ASK_PAGES).map(([name, url]) =>
    fromMarkdown(withoutMarkers(fs.readFileSync(path.join(repo, 'docs', name), 'utf8')), {
      id: `docs/${name}`,
      url,
    }),
  ),
  fromMarkdown(`# FAQ\n\n${faqMarkdown()}`, { id: 'site/lib/faq.ts', url: '/docs/faq' }),
  // Each rule's page, from the same data the page renders.
  ...rules.map((rule) =>
    fromMarkdown(
      [
        `# ${rule.id}`,
        `${rule.description} ${rule.severity === 'error' ? 'An error' : 'A warning'} by default.`,
        `## What it catches\n\n${rule.catches}`,
        `## What it suggests\n\n${rule.suggests}`,
        `## Why it matters\n\n${rule.why}`,
        `## Example\n\n${fence(rule.bad, 'tsx')}\n\n${rule.findings.map((f) => `- ${f.line}:${f.column} ${f.message}`).join('\n')}`,
        `## Fixed\n\n${fence(rule.good, 'tsx')}`,
      ].join('\n\n'),
      { id: `rules/${rule.id}`, url: `/rules/${rule.id}` },
    ),
  ),
].filter(Boolean);
const { index: askIndex, stats: askStats } = await buildIndex({
  documents: askDocuments,
  embeddingModel: null,
});
fs.writeFileSync(path.join(OUT, 'ask-index.json'), `${serializeIndexFile(askIndex)}\n`);
console.log(
  `generated/ask-index.json ${(fs.statSync(path.join(OUT, 'ask-index.json')).size / 1024).toFixed(1)}kB, ${askStats.documents} pages, ${askStats.chunks} chunks`,
);
