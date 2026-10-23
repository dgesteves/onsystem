import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { labelKey, type Label, type Snapshot } from '../scripts/corpus-lib.js';
import { loadConfig, RULE_IDS } from '../src/config.js';

// Every number the README and the docs quote comes from a file in the repository; these tests
// fail when the text and the file disagree, so a new snapshot or benchmark run means an update.
const root = path.resolve(import.meta.dirname, '..');

interface Repos {
  repos: {
    name: string;
    sha: string;
    runs: { name: string; config?: string }[];
    install?: { folders: Record<string, Record<string, string>> };
  }[];
}
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const readme = read('README.md');
/** A `## heading` section of the README, up to the next one. */
const section = (heading: string) => {
  const start = readme.indexOf(`\n${heading}\n`);
  expect(start, heading).toBeGreaterThan(-1);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
};

describe('the README', () => {
  // test/install.test.ts checks what each install link installs.
  it('opens with one-click installs for Cursor, VS Code and Claude Code', () => {
    const top = readme.slice(0, readme.indexOf('<!-- npm-readme:video -->'));
    expect(top).toContain('](https://cursor.com/en/install-mcp?name=onsystem&config=');
    expect(top).toContain(
      '](https://insiders.vscode.dev/redirect/mcp/install?name=onsystem&config=',
    );
    expect(top).toContain('](https://onsystem.vercel.app/docs/plugin)');
  });

  it('links the MCP Registry badge to the server.json name, and reads the version from there', () => {
    const top = readme.slice(0, readme.indexOf('<!-- npm-readme:video -->'));
    const { name } = JSON.parse(read('server.json')) as { name: string };
    // The lookup by name, not the search: the search (/v0/servers?search=) takes seconds, so
    // shields.io gives up and the badge reads "inaccessible", and the registry's page with ?q=
    // did not show the server.
    const lookup = `https://registry.modelcontextprotocol.io/v0.1/servers/${encodeURIComponent(name)}/versions/latest`;
    expect(top).toContain(
      `url=${encodeURIComponent(lookup)}&query=${encodeURIComponent('$.server.version')}&`,
    );
    expect(top).toContain(`](${lookup})`);
    expect(top).not.toContain('search%3D');
  });

  it('shows no download count', () => {
    // npm's weekly count is mostly mirrors and bots: the deprecated placeholders 0.0.1 and
    // 0.0.0-stage get as many downloads as the latest version (api.npmjs.org/versions/onsystem/last-week).
    expect(readme).not.toMatch(/shields\.io\/npm\/d[wmyt]\//);
  });

  it('points GitHub Action users at the Action before the badges', () => {
    // The Marketplace listing shows this README, which opens on the MCP server.
    const pitch = readme.slice(0, readme.indexOf('[!['));
    expect(pitch).toContain('`uses: dgesteves/onsystem@v0`');
    expect(pitch).toContain('](https://onsystem.vercel.app/docs/ci)');
  });

  it('links the Quickstart to the guide for code from shadcn registries', () => {
    expect(section('## Quickstart')).toContain(
      '](https://onsystem.vercel.app/docs/configuration#code-from-shadcn-registries)',
    );
  });

  it('says what apps that install a design-system package get from compiled code, with and without type declarations', () => {
    const quickstart = section('## Quickstart').replace(/\s+/g, ' ');
    // Every rule runs from the `.d.ts` of a package set up with init
    // (test/installed-declarations.test.ts).
    expect(quickstart).toContain(
      'or from its type declarations (`.d.ts`) when it publishes only compiled `dist/`, and get every rule either way',
    );
    // Without them, the token rules, in the words init uses to tell the package's team
    // (src/init.ts).
    const missed = 'no component, prop, variant or native-element checks';
    expect(read('src/init.ts')).toContain(missed);
    expect(quickstart).toContain(
      `From a package that publishes compiled code and no type declarations, they get the token rules but ${missed}.`,
    );
  });

  it('links each client badge to a section of docs/clients.md', () => {
    const top = readme.slice(0, readme.indexOf('<!-- npm-readme:video -->'));
    // The site's ids: a heading's or a <details> summary's text, as site/components/markdown-blocks.tsx slugs it.
    const slug = (text: string) =>
      text
        .toLowerCase()
        .replace(/<[^>]+>|`/g, '')
        .replace(/[^\w\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-');
    const clients = read('docs/clients.md');
    const ids = new Set([
      ...[...clients.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1] ?? '')),
      ...[...clients.matchAll(/<summary>(?:<strong>)?(.*?)(?:<\/strong>)?<\/summary>/g)].map((m) =>
        slug(m[1] ?? ''),
      ),
    ]);
    const anchors = [
      ...top.matchAll(/\]\(https:\/\/onsystem\.vercel\.app\/docs\/clients#([\w-]+)\)/g),
    ].map((m) => m[1]);
    expect(anchors.length).toBeGreaterThan(5);
    for (const anchor of anchors) expect(ids, anchor).toContain(anchor);
  });

  it('lists every rule with its default severity', async () => {
    const { rules } = await loadConfig({ cwd: fs.mkdtempSync(path.join(os.tmpdir(), 'readme-')) });
    const rows = readme.split('\n').filter((line) => /^\| `[\w-]+` +\|/.test(line));
    expect(rows.map((row) => /^\| `([\w-]+)`/.exec(row)?.[1]).sort()).toEqual([...RULE_IDS].sort());
    for (const id of RULE_IDS) {
      const row = rows.find((r) => r.startsWith(`| \`${id}\``));
      expect(row?.split('|')[2]?.trim(), id).toBe(rules[id].severity);
    }
  });

  // The corpus paragraph: what was checked, and the false-positive rate of the blind sample, while
  // that sample can give one for all findings.
  const corpus = () => {
    const labels = JSON.parse(read('corpus/labels.json')) as Label[];
    const snapshot = JSON.parse(read('corpus/snapshot.json')) as Snapshot;
    const repos = JSON.parse(read('corpus/repos.json')) as Repos;
    // A run with a config of its own checks the same files as another run: not counted twice.
    const rechecks = new Set(
      repos.repos.flatMap((r) => r.runs.filter((run) => run.config).map((run) => run.name)),
    );
    let distinct = 0;
    // Distinct findings per rule: the strata the blind sample is drawn from.
    const byRule = new Map<string, number>();
    let unknown = 0;
    let unknownInFlowise = 0;
    // A run from a monorepo root counts only the findings it adds to the runs from its projects.
    for (const [run, { rules, added }] of Object.entries(snapshot.runs)) {
      for (const [rule, counts] of Object.entries(added ?? rules)) {
        const n = counts.errors + counts.warnings;
        if (!rechecks.has(run)) {
          distinct += n;
          byRule.set(rule, (byRule.get(rule) ?? 0) + n);
        }
        if (/^no-unknown-(component|prop|variant)$/.test(rule)) {
          unknown += n;
          if (run === 'flowise-ui') unknownInFlowise += n;
        }
      }
    }
    return { labels, snapshot, repos, distinct, byRule, unknown, unknownInFlowise };
  };

  /**
   * A blind sample goes stale once the findings it was drawn from change: a fix takes some out,
   * or a rule reports findings the draw never saw. The change that does so adds
   * corpus/sample-stale.json, naming the draw and what the README quoted of the corpus then. Until
   * a fresh draw replaces the sample and removes the file, the README quotes the sample with the
   * corpus as it was drawn from, and the launch waits for that draw.
   */
  interface Stale {
    draw: string;
    why: string;
    asDrawn: { repos: number; runs: number; unknown: number; unknownInFlowise: number };
  }
  const STALE = 'corpus/sample-stale.json';
  const stale = (): Stale | undefined =>
    fs.existsSync(path.join(root, STALE)) ? (JSON.parse(read(STALE)) as Stale) : undefined;
  /** The population a draw was taken from, per rule, as its allocation.json has it. */
  const drawnFrom = (draw: string) => {
    const { populationTotal, allocation } = JSON.parse(read(`corpus/${draw}/allocation.json`)) as {
      populationTotal: number;
      allocation: { rule: string; population: number }[];
    };
    return {
      distinct: populationTotal,
      byRule: new Map(allocation.map((a) => [a.rule, a.population])),
    };
  };

  /** The corpus the README quotes: as it is, or as the sample was drawn from while it is stale. */
  const quoted = () => {
    const live = corpus();
    const marker = stale();
    if (!marker) {
      return {
        ...live,
        repoCount: live.repos.repos.length,
        runs: Object.keys(live.snapshot.runs).length,
        stale: marker,
      };
    }
    return {
      ...live,
      ...drawnFrom(marker.draw),
      repoCount: marker.asDrawn.repos,
      runs: marker.asDrawn.runs,
      unknown: marker.asDrawn.unknown,
      unknownInFlowise: marker.asDrawn.unknownInFlowise,
      stale: marker,
    };
  };

  /**
   * The blind sample: a seeded random draw from every distinct finding, stratified by rule, with
   * labels from a reviewer who saw no other label. Its folder in corpus/ is named by `draw`.
   */
  const blindSample = () => {
    const { labels, snapshot, distinct, byRule, stale } = quoted();
    const blind = labels.filter((l) => l.sample === 'blind');
    const draws = [...new Set(blind.map((l) => l.draw))];
    expect(draws, 'one blind draw at a time').toHaveLength(1);
    const draw = draws[0] ?? '';
    // Labels whose findings the snapshot says are no longer reported: a fix took them out.
    const lost = blind.filter((l) => !snapshot.labels[labelKey(l)]);
    const count = (list: Label[], verdict: Label['verdict']) =>
      list.filter((l) => l.verdict === verdict).length;
    const strata = [...byRule].map(([rule, size]) => {
      const stratum = blind.filter((l) => l.rule === rule);
      return { rule, size, n: stratum.length, fp: count(stratum, 'FP') };
    });
    // The share of distinct findings in a rule the sample has labels for.
    const covered = strata.filter((s) => s.n > 0).reduce((n, s) => n + s.size, 0);
    // Each rule's false-positive share, weighted by its share of the findings.
    const weighted = strata
      .filter((s) => s.n > 0)
      .reduce((rate, s) => rate + (s.size / covered) * (s.fp / s.n), 0);
    const [top] = [...strata].sort((a, b) => b.fp - a.fp);
    // The strict reading needs `own_ds_value`, which the draw's own file keeps per finding.
    const { findings } = JSON.parse(read(`corpus/${draw}/sample-labelled.json`)) as {
      findings: { fingerprint: string; label: string; own_ds_value: boolean | null }[];
    };
    const strict = findings.filter((f) => f.label === 'FP' && f.own_ds_value !== true).length;
    return {
      draw,
      blind,
      findings,
      lost,
      coverage: covered / distinct,
      n: blind.length,
      tp: count(blind, 'TP'),
      d: count(blind, 'D'),
      fp: count(blind, 'FP'),
      weighted,
      top,
      strict,
      stale,
    };
  };
  /** A 95% Wilson score interval, as corpus/<draw>/scripts/stats.py computes it. */
  const wilson = (k: number, n: number) => {
    const z = 1.959964;
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [Math.max(0, c - h), Math.min(1, c + h)] as const;
  };
  // One decimal, a tie to the even digit, as stats.py prints it (Python's format): 9/80 is 11.2%.
  const tenths = (x: number) => {
    const t = x * 1000;
    const floor = Math.floor(t);
    return ((t - floor === 0.5 ? floor + (floor % 2) : Math.round(t)) / 10).toFixed(1);
  };
  const pct = (x: number) => `${tenths(x)}%`;
  const paragraph = /\*\*How often it is wrong\.\*\*.*/.exec(readme)?.[0] ?? '';

  it('quotes the corpus size, and what the sample says about the rules for invented API', () => {
    const { repos, repoCount, runs, distinct, unknown, unknownInFlowise } = quoted();
    const { blind } = blindSample();
    const text = paragraph.replace(/\s+/g, ' ');
    expect(text).toContain(`on ${String(repoCount)} public repositories pinned by commit`);
    expect(text).toContain(
      `${String(runs)} runs, ${distinct.toLocaleString('en-US')} distinct findings), without their dependencies installed (the two MUI apps get MUI).`,
    );
    // Only the repositories with an `install` get dependencies: the two MUI apps, and MUI.
    const installs = repos.repos.filter((r) => r.install);
    expect(installs.map((r) => r.name).sort()).toEqual(['flowise', 'material-kit-react']);
    for (const r of installs) {
      expect(Object.values(r.install?.folders ?? {}).some((deps) => '@mui/material' in deps)).toBe(
        true,
      );
    }
    // Invented components, props and variants: MUI's Flowise has most of them, and the sample a
    // few, too few for a rate of their own.
    const unknownSample = blind.filter((l) => /^no-unknown-/.test(l.rule));
    expect(text).toContain(
      `those three rules have ${String(unknown)} findings in the corpus, ${String(unknownInFlowise)} of them in Flowise, an MUI app, and ${String(unknownSample.length)} in the sample, all right but too few for a rate of their own`,
    );
    expect(unknownSample.length).toBeLessThan(10);
    expect(unknownSample.every((l) => l.verdict === 'TP')).toBe(true);
  });

  it("keeps the blind sample's labels as its draw has them", () => {
    const { draw, blind, findings } = blindSample();
    expect(draw).toMatch(/^fp-sample-\d{8}$/);
    const verdict: Record<string, Label['verdict']> = { TP: 'TP', FP: 'FP', debatable: 'D' };
    expect(blind.map((l) => [l.fingerprint, l.verdict]).sort()).toEqual(
      findings.map((f) => [f.fingerprint, verdict[f.label]]).sort(),
    );
    // The labeller's notes name it by model id, in its own words; the README by that model's name.
    const labeller = read(`corpus/${draw}/LABELLER.md`);
    expect(labeller).toContain('an AI reviewer, model id `claude-opus-5-5`');
    const { models } = JSON.parse(read('bench/v2/config/models.json')) as {
      models: { id: string; name: string }[];
    };
    expect(models.find((m) => m.id === 'claude-opus-5-5')?.name).toBe('Claude Opus 5.5');
    expect(read(`corpus/${draw}/stats.txt`)).toContain(
      `n = ${String(blind.length)}: TP ${String(blind.filter((l) => l.verdict === 'TP').length)}, debatable ${String(blind.filter((l) => l.verdict === 'D').length)}, FP ${String(blind.filter((l) => l.verdict === 'FP').length)}`,
    );
  });

  it("quotes the blind sample's false-positive rate with its interval, while the sample is intact", () => {
    const { draw, lost, coverage, n, tp, d, fp, weighted, top, strict, stale } = blindSample();
    // As CONTRIBUTING.md says: a rate needs labels where at least 80% of the distinct findings
    // are, and every label the sample was drawn with still reported. Once a fix takes some out,
    // what is left under-counts them: draw a fresh sample, or take the rate out of the README.
    // A sample marked stale is quoted as it was measured, with the corpus it was drawn from.
    const state = `the blind sample ${draw} has labels in rules holding ${pct(coverage)} of the distinct findings, and ${String(lost.length)} of its ${String(n)} labels are no longer reported`;
    console.info(
      stale
        ? `corpus labels: ${state}; it is stale (${STALE}): draw a fresh sample before launch`
        : `corpus labels: ${state}`,
    );
    expect(
      coverage >= 0.8 && (lost.length === 0 || stale?.draw === draw),
      `no rate to quote: ${state}`,
    ).toBe(true);

    const text = paragraph.replace(/\s+/g, ' ');
    const [low, high] = wilson(fp, n);
    const [strictLow, strictHigh] = wilson(strict, n);
    expect(text).toContain(
      `A seeded random sample of ${String(n)} of those findings, stratified by rule, was labelled from the code alone: blind labels by an AI reviewer (Claude Opus 5.5), not by a person.`,
    );
    expect(text).toContain(
      `${String(tp)} are right, ${String(d)} debatable and ${String(fp)} false positives: ${pct(fp / n)} (95% Wilson interval ${tenths(low)}-${pct(high)}), about the same when weighted by each rule's share of all findings (${pct(weighted)}).`,
    );
    expect(Math.abs(weighted - fp / n)).toBeLessThan(0.01);
    expect(text).toContain(
      `Most come from \`${top?.rule ?? ''}\` (${String(top?.fp)} of ${String(top?.n)} sampled).`,
    );
    expect((top?.fp ?? 0) * 2).toBeGreaterThan(fp);
    expect(text).toContain(
      `Counting values a project's own design system already uses as debatable, ${String(strict)} of ${String(n)} are false positives (${pct(strict / n)}, ${tenths(strictLow)}-${pct(strictHigh)}).`,
    );
    expect(text).toContain(`[sample](corpus/${draw})`);
    // No other rate (95% is the interval's level): none from the older labels, which are not
    // a sample of all findings.
    expect(paragraph.match(/\d+(?:\.\d+)?%(?! Wilson)/g)).toEqual(
      [fp / n, high, weighted, strict / n, strictHigh].map(pct),
    );
  });

  it('marks the blind sample stale only while the corpus differs from what it was drawn from', () => {
    const marker = stale();
    if (!marker) return;
    const live = corpus();
    const { draw, lost } = blindSample();
    expect(marker.draw).toBe(draw);
    expect(marker.why).toMatch(/\S/);
    // What the marker keeps is what the draw's own files say: its population and its corpus.
    const drawn = drawnFrom(draw);
    const unknownDrawn = [...drawn.byRule]
      .filter(([rule]) => /^no-unknown-(component|prop|variant)$/.test(rule))
      .reduce((sum, [, population]) => sum + population, 0);
    expect(marker.asDrawn.unknown).toBe(unknownDrawn);
    expect(read(`corpus/${draw}/README.md`)).toContain(
      `${drawn.distinct.toLocaleString('en-US')} distinct findings that the corpus job reported on onsystem`,
    );
    expect(read(`corpus/${draw}/README.md`)).toContain(
      `(${String(marker.asDrawn.repos)} repositories pinned by commit, ${String(marker.asDrawn.runs)} runs)`,
    );
    // Stale: the findings changed since the draw. Once they are as drawn again, the file goes.
    const changed =
      lost.length > 0 ||
      live.distinct !== drawn.distinct ||
      [...new Set([...live.byRule.keys(), ...drawn.byRule.keys()])].some(
        (rule) => (live.byRule.get(rule) ?? 0) !== (drawn.byRule.get(rule) ?? 0),
      );
    expect(changed, `the corpus is as ${draw} was drawn from: remove ${STALE}`).toBe(true);
  });

  it('says who made the corpus labels, and never that they were made by hand', () => {
    // PR #98: the labels in corpus/labels.json were not all made by hand.
    const files = [
      'README.md',
      'CONTRIBUTING.md',
      'site/lib/faq.ts',
      ...fs
        .readdirSync(path.join(root, 'docs'))
        .filter((file) => file.endsWith('.md'))
        .map((file) => `docs/${file}`),
    ];
    const hits = files.flatMap((file) =>
      read(file)
        .split('\n')
        .flatMap((line, i) =>
          /hand[- ]label|label(?:l?ed)? by hand|human[- ]label/i.test(line)
            ? [`${file}:${String(i + 1)}`]
            : [],
        ),
    );
    expect(hits).toEqual([]);
    // The blind sample's labeller saw no other label; the older labels' reviewer saw the finding.
    const { labels } = corpus();
    const older = labels.filter((l) => l.sample !== 'blind');
    expect(older.every((l) => ['random', 'audit'].includes(l.sample) && !l.draw)).toBe(true);
    const text = paragraph.replace(/\s+/g, ' ');
    expect(text).toContain('blind labels by an AI reviewer (Claude Opus 5.5), not by a person');
    expect(text).toContain(
      "The corpus's older labels, made by an AI reviewer who could see the finding and so not blind,",
    );
  });

  it('says the labels leave out code installed from shadcn registries', () => {
    // vercel/chatbot keeps Vercel's AI Elements, installed from a shadcn registry, in
    // components/ai-elements, inside the chatbot run's folders.
    const labels = JSON.parse(read('corpus/labels.json')) as Label[];
    expect(labels.filter((l) => /(^|\/)components\/ai-elements\//.test(l.file))).toEqual([]);
    expect(paragraph).toContain("such as the chatbot's `components/ai-elements`, has no labels");
    expect(paragraph).toContain(
      '](https://onsystem.vercel.app/docs/configuration#code-from-shadcn-registries)',
    );
  });

  it('quotes benchmark v2 with its size, the version it ran, and what its count cannot show', () => {
    interface Rate {
      value: number;
    }
    interface Row {
      model: string;
      arm: string;
      runs: number;
      tscPass: Rate;
      onsystemErrors: Rate;
    }
    const v2 = (file: string) => JSON.parse(read(`bench/v2/${file}`)) as unknown;
    const { info, rows, deltas } = v2('results/standard/results.json') as {
      info: { onsystem: string; repos: Record<string, unknown> };
      rows: Row[];
      deltas: { model: string; arm: string; tscPass: { low: number; high: number } }[];
    };
    const { models } = v2('config/models.json') as { models: { id: string; provider: string }[] };
    const { tasks } = v2('config/tasks.json') as { tasks: { repo: string }[] };
    const key = v2('results/standard/labels/key.json') as Record<string, { arm: string }>;
    const arms = ['none', 'skill', 'mcp', 'hook', 'all'];
    const pooled = (arm: string) => {
      const row = rows.find((r) => r.model === 'all models' && r.arm === arm);
      expect(row, arm).toBeDefined();
      return row as Row;
    };
    const [none, all] = [pooled('none'), pooled('all')];
    const ids = new Set(rows.filter((r) => !r.model.endsWith(' models')).map((r) => r.model));
    const providers = new Set([...ids].map((id) => models.find((m) => m.id === id)?.provider));
    const perArm = new Set(arms.map((arm) => pooled(arm).runs));
    const labelled = new Set(
      arms.map((arm) => Object.values(key).filter((k) => k.arm === arm).length),
    );
    expect(perArm.size).toBe(1);
    expect(labelled.size).toBe(1);
    // "No measurable change": the paired difference's interval holds 0.
    const tsc = deltas.find((d) => d.model === 'all models' && d.arm === 'all')?.tscPass;
    expect(tsc && tsc.low <= 0 && tsc.high >= 0).toBe(true);

    const pct = (rate: Rate) => `${String(Math.round(rate.value * 100))}%`;
    const total = arms.reduce((n, arm) => n + pooled(arm).runs, 0);
    const help = section('## Does it help?').replace(/\s+/g, ' ');
    expect(help).toContain('[Benchmark v2](bench/v2)');
    expect(help).toContain(
      `${String(ids.size)} models from ${String(providers.size)} providers (Anthropic, OpenAI and Google) ${String(tasks.filter((t) => t.repo in info.repos).length)} single-file UI tasks in ${String(Object.keys(info.repos).length)} open-source repositories`,
    );
    expect(help).toContain(
      `${total.toLocaleString('en-US')} runs, ${String([...perArm][0])} per arm`,
    );
    expect(help).toContain(
      `Counted by onsystem ${info.onsystem}'s own check, design-system errors per run went from ${none.onsystemErrors.value.toFixed(2)} without onsystem to ${all.onsystemErrors.value.toFixed(2)} with all three, with no measurable change in the \`tsc\` pass rate (${pct(none.tscPass)} → ${pct(all.tscPass)})`,
    );
    // The count is onsystem's own, it rewards chart tokens used as status colors, and the
    // independent labels are a small sample.
    expect(help).toContain('the MCP server and the hook show the agent the same errors');
    expect(help).toContain('`chart-*` tokens');
    // Three tasks, not two: bench/v2's Threats to validity names them and counts their runs.
    expect(help).toContain(
      'In tasks that ask for a green status label in a design system with no success token',
    );
    expect(help).toContain(
      `The blind labels by an AI reviewer, ${String([...labelled][0])} files per arm, are too few to confirm the count either way`,
    );
    expect(help).not.toContain('bench/agents');
  });

  // GitHub's id for a heading: lower case, punctuation dropped, spaces as hyphens.
  const githubSlug = (heading: string) =>
    heading
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s/g, '-');

  it('says what the MCP server and the hook do next to @shadcn/lint, and links its table', () => {
    const text = section('## Works with @shadcn/lint').replace(/\s+/g, ' ');
    // Benchmark v2 saw no invented component, prop or variant for the hook to catch (the pitch
    // test below counts them), so this says what each part does instead.
    expect(text).toContain(
      'Its MCP server shows the agent your components and tokens before it writes, and in Claude Code its hook checks every edit.',
    );
    expect(text).not.toMatch(/invent/i);
    const heading = 'Independent scorer: @shadcn/lint';
    expect(text).toContain(`](bench/v2/results/standard/results.md#${githubSlug(heading)})`);
    expect(read('bench/v2/results/standard/results.md').split('\n')).toContain(`## ${heading}`);
  });

  it("quotes bench/v2's independent scorer as results.json has it", () => {
    interface Interval {
      value: number;
      low: number;
      high: number;
    }
    interface Row {
      model: string;
      arm: string;
      findings: Interval;
      byRule: Record<string, number>;
    }
    interface Delta {
      model: string;
      arm: string;
      findings: Interval;
      byRule: Record<string, Interval>;
    }
    const { info, shadcnLint } = JSON.parse(read('bench/v2/results/standard/results.json')) as {
      info: { onsystem: string };
      shadcnLint: {
        scorer: { packages: Record<string, string>; rules: string[] };
        rows: Row[];
        deltas: Delta[];
      };
    };
    const pooled = <T extends { model: string; arm: string }>(rows: T[], arm: string): T => {
      const row = rows.find((r) => r.model === 'all models' && r.arm === arm);
      expect(row, arm).toBeDefined();
      return row as T;
    };
    const [none, skill, mcp, hook, all] = ['none', 'skill', 'mcp', 'hook', 'all'].map((arm) =>
      pooled(shadcnLint.rows, arm),
    ) as [Row, Row, Row, Row, Row];
    const [dMcp, dHook, dAll] = ['mcp', 'hook', 'all'].map((arm) =>
      pooled(shadcnLint.deltas, arm),
    ) as [Delta, Delta, Delta];
    const rule = (d: Delta, id: string) => {
      const i = d.byRule[id];
      expect(i, id).toBeDefined();
      return i as Interval;
    };
    // As the README prints them: two decimals and a real minus sign; differences signed.
    const num = (x: number) => x.toFixed(2).replace('-', '−');
    const signed = (x: number) => `${x > 0 ? '+' : ''}${num(x)}`;
    const interval = (i: Interval, f = num) => `${f(i.value)} [${f(i.low)}, ${f(i.high)}]`;

    const v2 = read('bench/v2/README.md');
    const start = v2.indexOf('\n## Independent scorer: @shadcn/lint\n');
    expect(start).toBeGreaterThan(-1);
    const text = v2.slice(start, v2.indexOf('\n## ', start + 1)).replace(/\s+/g, ' ');
    const { packages, rules } = shadcnLint.scorer;
    expect(text).toContain(
      `[@shadcn/lint](https://github.com/shadcn-ui/lint) ${packages['@shadcn/lint'] ?? ''}, with ESLint ${packages.eslint ?? ''} and @typescript-eslint/parser ${packages['@typescript-eslint/parser'] ?? ''},`,
    );
    expect(rules).toHaveLength(6);
    expect(text).toContain('All six rules are on, each an error at its defaults.');
    expect(text).toContain(
      `**On the standard run (onsystem ${info.onsystem}):** @shadcn/lint findings per run, all models, went from ${interval(none.findings)} without onsystem to ${interval(all.findings)} with all three parts, a paired difference of ${interval(dAll.findings, signed)}. With the skill alone ${num(skill.findings.value)}, the MCP server ${num(mcp.findings.value)}, the hook ${num(hook.findings.value)}.`,
    );
    const perRun = (id: string) =>
      `(${num(none.byRule[id] ?? NaN)} → ${num(all.byRule[id] ?? NaN)} per run)`;
    expect(text).toContain(`\`no-raw-colors\` ${perRun('no-raw-colors')}`);
    expect(text).toContain(`\`no-restyle\`** ${perRun('no-restyle')}`);
    expect(text).toContain(
      `**The hook alone lowers colors, not restyles:** ${interval(dHook.findings, signed)} in all, ${interval(rule(dHook, 'no-raw-colors'), signed)} in \`no-raw-colors\`, ${interval(rule(dHook, 'no-restyle'), signed)} in \`no-restyle\`. The MCP server alone: ${interval(dMcp.findings, signed)}, with ${interval(rule(dMcp, 'no-restyle'), signed)} in \`no-restyle\`.`,
    );
    // "Colors, not restyles": the hook's no-raw-colors interval is below 0, its no-restyle one holds 0.
    expect(rule(dHook, 'no-raw-colors').high).toBeLessThan(0);
    expect(rule(dHook, 'no-restyle').low).toBeLessThanOrEqual(0);
    expect(rule(dHook, 'no-restyle').high).toBeGreaterThanOrEqual(0);

    // Where it reads less: what each repository's files got, from the per-run findings.
    const { runs } = JSON.parse(read('bench/v2/results/standard/shadcn-lint.json')) as {
      runs: Record<string, { byRule: Record<string, number> }>;
    };
    const fired = (repo: string) => {
      const counts = new Map<string, number>();
      for (const [id, run] of Object.entries(runs)) {
        if (id.split('--')[2] !== repo) continue;
        for (const [r, n] of Object.entries(run.byRule)) counts.set(r, (counts.get(r) ?? 0) + n);
      }
      return [...counts.keys()].sort();
    };
    expect(text).toContain(
      "openstatus's points at the app's own folder, not `@openstatus/ui`, so `no-restyle` reports nothing there.",
    );
    expect(fired('openstatus')).not.toContain('no-restyle');
    expect(text).toContain('so only `no-raw-colors` and `no-arbitrary-values` report there');
    expect(fired('dub')).toEqual(['no-arbitrary-values', 'no-raw-colors']);

    // Classes looked up at runtime: shadcn-website's files that contain palette classes, and how
    // many of them got one require-static-classes finding and no color finding from either tool.
    const palette =
      /(?<![\w-])(?:[a-z0-9-]+:)*-?(?:bg|text|border(?:-[trblxyse])?|ring|ring-offset|outline|divide|from|via|to|fill|stroke|shadow|accent|caret|decoration|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(?:50|[1-9]00|950)(?:\/\d+)?(?![\w-])/;
    let withPalette = 0;
    let lookedUp = 0;
    for (const [id, run] of Object.entries(runs)) {
      if (id.split('--')[2] !== 'shadcn-website') continue;
      const dir = `bench/v2/results/standard/runs/${id}`;
      const result = JSON.parse(read(`${dir}/result.json`)) as {
        file: string;
        onsystemByRule: Record<string, number>;
      };
      if (!palette.test(read(`${dir}/files/${result.file}`))) continue;
      withPalette += 1;
      if (
        run.byRule['require-static-classes'] === 1 &&
        !run.byRule['no-raw-colors'] &&
        !result.onsystemByRule['no-hardcoded-color']
      )
        lookedUp += 1;
    }
    expect(text).toContain(
      `In shadcn-website, ${lookedUp} of the ${withPalette} output files with palette classes went this way: each got one \`require-static-classes\` finding, no \`no-raw-colors\` and no onsystem color error.`,
    );
    expect(lookedUp).toBeGreaterThan(0);
  });

  it("counts bench/v2's measures, and the independent ones, as its Scoring list has them, and names each where it lists them", () => {
    const v2 = read('bench/v2/README.md');
    const start = v2.indexOf('\n### Scoring\n');
    expect(start).toBeGreaterThan(-1);
    const scoring = v2.slice(start, v2.indexOf('\n### ', start + 1));
    // Each measure: `1. **name (kind).**`, the kind `independent…` or `the tool's own`.
    const measures = [...scoring.matchAll(/^\d+\. \*\*(.+?) \(([^)]+)\)\.\*\*/gm)].map((m) => ({
      name: m[1] ?? '',
      independent: (m[2] ?? '').startsWith('independent'),
    }));
    // results.json has @shadcn/lint's score (#159): it is a measure, and an independent one.
    const { shadcnLint } = JSON.parse(read('bench/v2/results/standard/results.json')) as {
      shadcnLint?: unknown;
    };
    expect(shadcnLint).toBeDefined();
    expect(measures.find((m) => m.name === '@shadcn/lint')?.independent).toBe(true);
    const words = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six'];
    const count = (n: number) => words[n] ?? String(n);
    expect(scoring).toContain(
      `${count(measures.length)} measures, ${count(measures.filter((m) => m.independent).length).toLowerCase()} of them independent of onsystem.`,
    );

    // Anywhere else it counts them, it says the same number; and where it lists the scorers,
    // their blind spots under Threats to validity, it names every measure (`onsystem check` as
    // onsystem).
    for (const m of v2.matchAll(/\b(one|two|three|four|five|six) (?:scorers|measures)\b/gi))
      expect(m[1]?.toLowerCase(), m[0]).toBe(count(measures.length).toLowerCase());
    const lines = v2.split('\n');
    const blindSpots = "- **The scorers' blind spots.** ";
    const lists = {
      'Threats to validity': lines.find((l) => l.startsWith(blindSpots))?.slice(blindSpots.length),
    };
    const named = (name: string) =>
      name
        .replace(/`/g, '')
        .replace(/ check$/, '')
        .toLowerCase();
    for (const [where, text] of Object.entries(lists)) {
      expect(text, where).toBeDefined();
      for (const { name } of measures)
        expect(text?.toLowerCase(), `${where}: ${name}`).toContain(named(name));
    }
  });
});

// The one-line pitch on GitHub, npm, the agent plugins, the MCP Registry and the Marketplace leads
// with what benchmark v2 measured, in the words of the site's first screen (site/app/page.tsx).
describe('the pitch', () => {
  const description = (file: string) =>
    (JSON.parse(read(file)) as { description: string }).description;
  const listed = (file: string) =>
    (JSON.parse(read(file)) as { plugins: { name: string; description: string }[] }).plugins.find(
      (plugin) => plugin.name === 'onsystem',
    )?.description;
  // The README's first paragraph, as text.
  const pitch = (readme.split('\n\n')[1] ?? '')
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  const manifests = {
    'plugins/onsystem/.claude-plugin/plugin.json': description(
      'plugins/onsystem/.claude-plugin/plugin.json',
    ),
    'plugins/onsystem-agent/plugin.json': description('plugins/onsystem-agent/plugin.json'),
    'plugins/onsystem-cursor/.cursor-plugin/plugin.json': description(
      'plugins/onsystem-cursor/.cursor-plugin/plugin.json',
    ),
    '.claude-plugin/marketplace.json': listed('.claude-plugin/marketplace.json'),
    '.cursor-plugin/marketplace.json': listed('.cursor-plugin/marketplace.json'),
  };
  const server = description('server.json');
  const surfaces = {
    'README.md': pitch,
    'package.json': description('package.json'),
    ...manifests,
    'server.json': server,
    'action.yml': /^description: (.+)$/m.exec(read('action.yml'))?.[1],
  };

  it('names what benchmark v2 found, in its order, and no invention, which it never saw', () => {
    const runs = 'bench/v2/results/standard/runs';
    const fired = new Map<string, number>();
    for (const run of fs.readdirSync(path.join(root, runs))) {
      const { onsystemByRule } = JSON.parse(read(`${runs}/${run}/result.json`)) as {
        onsystemByRule?: Record<string, number>;
      };
      for (const [rule, n] of Object.entries(onsystemByRule ?? {})) {
        fired.set(rule, (fired.get(rule) ?? 0) + n);
      }
    }
    const ranked = [...fired].sort((a, b) => b[1] - a[1]).map(([rule]) => rule);
    expect(ranked.slice(0, 2)).toEqual(['no-hardcoded-color', 'prefer-design-system-component']);
    // When a benchmark sees agents invent components, props or variants, the pitch can say so.
    expect(ranked.filter((rule) => rule.startsWith('no-unknown-'))).toEqual([]);

    for (const [file, text] of Object.entries(surfaces)) {
      expect(text, file).toMatch(
        /palette colors, native elements and APIs your (design )?system lacks/,
      );
      expect(text, file).not.toMatch(/invent/i);
    }
  });

  it('says the same in every plugin as on npm, and the README starts with it', () => {
    const npm = description('package.json');
    for (const [file, text] of Object.entries(manifests)) expect(text, file).toBe(npm);
    // The README may add a sentence after it; npm has no room for one.
    expect(pitch.startsWith(npm), pitch).toBe(true);
  });

  it('fits npm', () => {
    // npm keeps the first 255 characters of a description and drops the rest: ondocs 0.10.0 ships
    // 260 in its tarball, and the registry shows it ending '...Next.js, or one script'.
    expect(description('package.json').length).toBeLessThanOrEqual(255);
  });

  it('fits the MCP Registry', () => {
    // The registry's server.schema.json gives description a maxLength of 100.
    expect(server.length).toBeLessThanOrEqual(100);
  });
});

describe('the docs', () => {
  const snapshot = JSON.parse(read('corpus/snapshot.json')) as Snapshot;
  const repos = JSON.parse(read('corpus/repos.json')) as Repos;
  const run = (name: string) => {
    const found = snapshot.runs[name];
    if (!found) throw new Error(`no run ${name} in the snapshot`);
    const count = (rule: string) =>
      (found.rules[rule]?.errors ?? 0) + (found.rules[rule]?.warnings ?? 0);
    const total = Object.keys(found.rules).reduce((n, rule) => n + count(rule), 0);
    const inspect = found.inspect as { components: number; tokens: Record<string, number> };
    return {
      ...found,
      count,
      total,
      components: inspect.components,
      tokens: Object.values(inspect.tokens).reduce((n, t) => n + t, 0),
    };
  };
  const n = (value: number) => value.toLocaleString('en-US');

  it('quote the corpus snapshot in the table of real codebases', () => {
    const doc = read('docs/how-it-works.md');
    const row = (repo: string) => {
      const sha = repos.repos.find((r) => r.name === repo)?.sha.slice(0, 7) ?? '';
      const line = doc.split('\n').find((l) => l.startsWith('| [') && l.includes(`\`${sha}\``));
      expect(line, `a row for ${repo} at ${sha}`).toBeDefined();
      // Cells are padded to line the table up.
      return (line ?? '').replace(/\s+/g, ' ');
    };

    const chatbot = run('chatbot');
    expect(row('chatbot')).toContain(
      `${n(chatbot.components)} components, ${n(chatbot.tokens)} tokens | ${n(chatbot.total)} in \`app/\` and \`components/\`: ${n(chatbot.count('no-hardcoded-color'))} raw colors, ${n(chatbot.count('prefer-design-system-component'))} native elements the design system wraps, ${n(chatbot.count('icon-button-accessible-name'))} icon-only buttons without an accessible name, ${n(chatbot.count('no-hardcoded-radius'))} arbitrary radius`,
    );

    const midday = run('midday-dashboard');
    expect(row('midday')).toContain(
      `${n(midday.components)} components | ${n(midday.total)} in \`src/\`, including ${n(midday.count('icon-button-accessible-name'))} icon-only buttons`,
    );

    const shadcn = run('shadcn-website');
    const colors = shadcn.count('no-hardcoded-color');
    expect(colors * 2).toBeGreaterThan(shadcn.total);
    expect(row('shadcn-ui')).toContain(
      `${n(shadcn.components)} components | ${n(shadcn.total)} in \`app/\` and \`components/\`, mostly raw colors (${n(colors)})`,
    );
  });

  it("quote midday's baseline in the CI guide", () => {
    const midday = run('midday-dashboard');
    const ci = read('docs/ci.md').replace(/\s+/g, ' ');
    expect(ci).toContain(`midday's dashboard has ${n(midday.total)})`);
    expect(ci).toContain(
      `Baseline: ${n(midday.total)} findings in ${n(midday.flagged ?? 0)} files → onsystem.baseline.json`,
    );
    expect(ci).toContain(
      `No new problems in ${n(midday.files)} files (${n(midday.total)} in the baseline).`,
    );
  });
});
