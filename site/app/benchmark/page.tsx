import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { Benchmark as EarlierBenchmark } from '@/components/benchmark';
import { Headline, HeadlineStats } from '@/components/benchmark-summary';
import { MarkdownBlocks } from '@/components/markdown-blocks';
import { Eyebrow, InlineCode, TextLink } from '@/components/section';
import { TableScroll } from '@/components/table-scroll';
import {
  ARM_LABELS,
  count,
  delta,
  headline,
  labellerFamily,
  modelName,
  perRun,
  perRunInterval,
  percent,
  points,
  pointsInterval,
  rateInterval,
  row,
  signedPerRun,
  signedPerRunInterval,
  usd,
  words,
} from '@/lib/benchmark';
import {
  bench,
  benchmark,
  type BenchDelta,
  type BenchRate,
  type BenchRow,
  type LabelRate,
} from '@/lib/data';
import { pageMetadata } from '@/lib/metadata';
import { docsHref, repoLink } from '@/lib/site';

const RESULTS = 'bench/v2/results/standard';
const top = headline(benchmark);

export const metadata: Metadata = pageMetadata({
  title: 'Benchmark',
  socialTitle: 'onsystem benchmark',
  description: `Coding agents with and without onsystem, ${benchmark.date}: rule violations per run went from ${top.from} to ${top.to} over ${top.runs} runs, ${top.models} models and ${top.repos} repositories.`,
  path: '/benchmark',
});

// ─── Cells ──────────────────────────────────────────────────────────────────

const th = 'px-3 py-2.5 align-bottom font-medium text-fg-soft first:pl-4 last:pr-4';
const td = 'px-3 py-2.5 align-top font-mono text-[12.5px] tabular-nums first:pl-4 last:pr-4';
const small = 'block text-[11px] whitespace-nowrap text-subtle';

/** A rate: the percentage, then the count and its interval. */
function RateCell({ col, rate }: { col: string; rate: BenchRate }) {
  return (
    <td data-col={col} className={`${td} text-fg-soft`}>
      {percent(rate.value)}{' '}
      <span className={small}>
        {rate.successes}/{rate.n} {rateInterval(rate)}
      </span>
    </td>
  );
}

function ErrorsCell({ col, value }: { col: string; value: BenchRow['onsystemErrors'] }) {
  return (
    <td data-col={col} className={`${td} text-fg`}>
      {perRun(value.value)} <span className={small}>{perRunInterval(value)}</span>
    </td>
  );
}

function PlainCell({ col, children }: { col: string; children: ReactNode }) {
  return (
    <td data-col={col} className={`${td} text-muted`}>
      {children}
    </td>
  );
}

function ArmName({ arm }: { arm: string }) {
  return (
    <>
      <span className="font-mono text-[12.5px] text-fg">{arm}</span>
      <span className="block text-[12px] text-subtle">{ARM_LABELS[arm] ?? arm}</span>
    </>
  );
}

/** A table that scrolls sideways on narrow screens, and takes focus while it does. */
function Scroll({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TableScroll label={label} className="rounded-xl border border-line">
      {children}
    </TableScroll>
  );
}

function Fold({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group mt-4 rounded-2xl border border-line bg-raised/60">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-fg-soft hover:text-fg [&::-webkit-details-marker]:hidden">
        {summary}
        <span className="font-mono text-xs text-subtle group-open:hidden">Show</span>
        <span className="hidden font-mono text-xs text-subtle group-open:inline">Hide</span>
      </summary>
      <div className="border-t border-line p-3 sm:p-4">{children}</div>
    </details>
  );
}

// ─── Tables ─────────────────────────────────────────────────────────────────

/** Every arm, pooled over all models. */
function ArmsTable() {
  return (
    <Scroll label="Results by arm">
      <table data-table="arms" className="w-full min-w-[720px] text-left text-[13px]">
        <caption className="sr-only">
          Results by arm, pooled over all {benchmark.models.length} models, with 95% intervals
        </caption>
        <thead className="bg-raised">
          <tr>
            <th scope="col" className={th}>
              Arm
            </th>
            <th scope="col" className={th}>
              Runs
            </th>
            <th scope="col" className={th}>
              Rule violations / run
            </th>
            <th scope="col" className={th}>
              onsystem clean
            </th>
            <th scope="col" className={th}>
              <InlineCode>tsc</InlineCode> passes
            </th>
            <th scope="col" className={th}>
              Cost / run
            </th>
            <th scope="col" className={th}>
              Hook blocks / run
            </th>
            <th scope="col" className={th}>
              MCP calls / run
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {benchmark.arms.map((arm) => {
            const r = row(benchmark, 'all models', arm);
            return (
              <tr key={arm} data-row={`${r.model}/${arm}`}>
                <th scope="row" className="py-2.5 pr-3 pl-4 text-left align-top font-normal">
                  <ArmName arm={arm} />
                </th>
                <PlainCell col="runs">{count(r.scored)}</PlainCell>
                <ErrorsCell col="onsystemErrors" value={r.onsystemErrors} />
                <RateCell col="onsystemClean" rate={r.onsystemClean} />
                <RateCell col="tscPass" rate={r.tscPass} />
                <PlainCell col="cost">{usd(r.cost.value)}</PlainCell>
                <PlainCell col="hookBlocks">{r.hookBlocks.toFixed(2)}</PlainCell>
                <PlainCell col="mcpCalls">{r.mcpCalls.toFixed(1)}</PlainCell>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Scroll>
  );
}

function DeltaRow({ d, name }: { d: BenchDelta; name: ReactNode }) {
  return (
    <tr data-row={`${d.model}/${d.arm}`}>
      {name}
      <PlainCell col="pairs">{count(d.pairs)}</PlainCell>
      <td data-col="onsystemErrors" className={`${td} text-fg`}>
        {signedPerRun(d.onsystemErrors.value)}{' '}
        <span className={small}>{signedPerRunInterval(d.onsystemErrors)}</span>
      </td>
      <td data-col="onsystemClean" className={`${td} text-fg-soft`}>
        {points(d.onsystemClean.value)}{' '}
        <span className={small}>{pointsInterval(d.onsystemClean)}</span>
      </td>
      <td data-col="tscPass" className={`${td} text-fg-soft`}>
        {points(d.tscPass.value)} <span className={small}>{pointsInterval(d.tscPass)}</span>
      </td>
      <td data-col="accepted" className={`${td} text-fg-soft`}>
        {points(d.accepted.value)} <span className={small}>{pointsInterval(d.accepted)}</span>
      </td>
    </tr>
  );
}

function DeltaHead({ first }: { first: ReactNode }) {
  return (
    <thead className="bg-raised">
      <tr>
        {first}
        <th scope="col" className={th}>
          Pairs
        </th>
        <th scope="col" className={th}>
          Δ rule violations / run
        </th>
        <th scope="col" className={th}>
          Δ onsystem clean (points)
        </th>
        <th scope="col" className={th}>
          Δ <InlineCode>tsc</InlineCode> passes (points)
        </th>
        <th scope="col" className={th}>
          Δ accepted (points)
        </th>
      </tr>
    </thead>
  );
}

/** Each arm against `none`, pooled over all models. */
function DeltasTable() {
  return (
    <Scroll label="Each arm against no onsystem">
      <table data-table="deltas" className="w-full min-w-[680px] text-left text-[13px]">
        <caption className="sr-only">
          Each arm against no onsystem, paired on model, task and repeat, all models, with 95%
          intervals
        </caption>
        <DeltaHead
          first={
            <th scope="col" className={th}>
              Arm
            </th>
          }
        />
        <tbody className="divide-y divide-line/70">
          {benchmark.arms
            .filter((arm) => arm !== 'none')
            .map((arm) => (
              <DeltaRow
                key={arm}
                d={delta(benchmark, 'all models', arm)}
                name={
                  <th scope="row" className="py-2.5 pr-3 pl-4 text-left align-top font-normal">
                    <ArmName arm={arm} />
                  </th>
                }
              />
            ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function ModelCell({ model }: { model: string }) {
  return (
    <th scope="row" className="py-2.5 pr-3 pl-4 text-left align-top font-normal">
      <span className={model.endsWith(' models') ? 'font-medium text-fg' : 'text-fg-soft'}>
        {modelName(benchmark, model)}
      </span>
    </th>
  );
}

/** Every row of results.json: each model, each tier's models, all models. */
function ModelsTable() {
  return (
    <Scroll label="Results by model">
      <table data-table="models" className="w-full min-w-[1080px] text-left text-[13px]">
        <caption className="sr-only">
          Results for every model and arm, then each tier and all models pooled, with 95% intervals
        </caption>
        <thead className="bg-raised">
          <tr>
            {[
              'Model',
              'Arm',
              'Runs',
              'Rule violations / run',
              'onsystem clean',
              'tsc passes',
              'Accepted',
              'Created',
              'Cost / run',
              'Calls / run',
              'Hook blocks / run',
              'MCP calls / run',
            ].map((label) => (
              <th key={label} scope="col" className={th}>
                {label === 'tsc passes' ? (
                  <>
                    <InlineCode>tsc</InlineCode> passes
                  </>
                ) : (
                  label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {benchmark.rows.map((r) => (
            <tr key={`${r.model}/${r.arm}`} data-row={`${r.model}/${r.arm}`}>
              <ModelCell model={r.model} />
              <PlainCell col="arm">{r.arm}</PlainCell>
              <PlainCell col="runs">{count(r.scored)}</PlainCell>
              <ErrorsCell col="onsystemErrors" value={r.onsystemErrors} />
              <RateCell col="onsystemClean" rate={r.onsystemClean} />
              <RateCell col="tscPass" rate={r.tscPass} />
              <RateCell col="accepted" rate={r.accepted} />
              <PlainCell col="created">{percent(r.created.value)}</PlainCell>
              <PlainCell col="cost">{usd(r.cost.value)}</PlainCell>
              <PlainCell col="calls">{r.calls.toFixed(1)}</PlainCell>
              <PlainCell col="hookBlocks">{r.hookBlocks.toFixed(2)}</PlainCell>
              <PlainCell col="mcpCalls">{r.mcpCalls.toFixed(1)}</PlainCell>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

/** Every paired difference in results.json. */
function ModelDeltasTable() {
  return (
    <Scroll label="Each arm against no onsystem, by model">
      <table data-table="model-deltas" className="w-full min-w-[820px] text-left text-[13px]">
        <caption className="sr-only">
          Each arm against no onsystem for every model, each tier and all models, with 95% intervals
        </caption>
        <DeltaHead
          first={
            <>
              <th scope="col" className={th}>
                Model
              </th>
              <th scope="col" className={th}>
                Arm
              </th>
            </>
          }
        />
        <tbody className="divide-y divide-line/70">
          {benchmark.deltas.map((d) => (
            <DeltaRow
              key={`${d.model}/${d.arm}`}
              d={d}
              name={
                <>
                  <ModelCell model={d.model} />
                  <PlainCell col="arm">{d.arm}</PlainCell>
                </>
              }
            />
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

function LabelsTable() {
  const { arms } = benchmark.labels;
  const rate = (r: LabelRate) => (
    <>
      {r.percent}%{' '}
      <span className={small}>
        {r.successes}/{r.n} [{r.low}%, {r.high}%]
      </span>
    </>
  );
  return (
    <Scroll label="Blind labels by arm">
      <table data-table="labels" className="w-full min-w-[640px] text-left text-[13px]">
        <caption className="sr-only">
          The blind-labelled sample by arm, as the labeller counted it, with 95% intervals
        </caption>
        <thead className="bg-raised">
          <tr>
            {[
              'Arm',
              'Files labelled',
              'No violations (labeller)',
              'Violations / file (labeller)',
              'Would merge (labeller)',
            ].map((label) => (
              <th key={label} scope="col" className={th}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-line/70">
          {arms.map((a) => (
            <tr key={a.arm} data-row={a.arm}>
              <th scope="row" className="py-2.5 pr-3 pl-4 text-left align-top font-normal">
                <ArmName arm={a.arm} />
              </th>
              <PlainCell col="labelled">{a.labelled}</PlainCell>
              <PlainCell col="clean">{rate(a.clean)}</PlainCell>
              <PlainCell col="violations">
                {perRun(a.violations.value)}{' '}
                <span className={small}>{perRunInterval(a.violations)}</span>
              </PlainCell>
              <PlainCell col="wouldMerge">{rate(a.wouldMerge)}</PlainCell>
            </tr>
          ))}
        </tbody>
      </table>
    </Scroll>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

function Block({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-title`}
      className="scroll-mt-20 border-t border-line pt-10 pb-12"
    >
      <h2
        id={`${id}-title`}
        className="text-[1.5rem] leading-tight font-semibold tracking-[-0.015em] text-fg sm:text-[1.75rem]"
      >
        {title}
      </h2>
      <div className="mt-5">{children}</div>
    </section>
  );
}

function Sub({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-9 first:mt-0">
      <h3 className="text-lg font-semibold tracking-tight text-fg">{title}</h3>
      <div className="mt-3">{children}</div>
    </div>
  );
}

function Prose({ children }: { children: ReactNode }) {
  return <div className="max-w-3xl text-[15.5px] leading-relaxed text-muted">{children}</div>;
}

const SECTIONS = [
  ['results', 'Results'],
  ['labels', 'Blind labels'],
  ['method', 'Method'],
  ['threats', 'Threats to validity'],
  ['reproduce', 'Reproduce it'],
  ['v1', 'The earlier benchmark'],
] as const;

export default function BenchmarkPage() {
  const { labels, time, cost } = benchmark;
  const family = labellerFamily(benchmark);
  const small = row(benchmark, 'small models', 'none');
  const smallAll = row(benchmark, 'small models', 'all');
  const mid = row(benchmark, 'mid models', 'none');
  const midAll = row(benchmark, 'mid models', 'all');
  const perArm = labels.arms[0]?.labelled ?? 0;
  const wrong = labels.precision.n - labels.precision.successes;
  const tiers = [...new Set(benchmark.models.map((m) => m.tier))];
  const atLimit = Object.entries(benchmark.statuses).filter(([status]) => status !== 'done');
  const v1Calls = bench.models.map((m) => m.plugin.toolCalls).sort((a, b) => a - b);
  const [v1Small] = bench.models;
  const v1Runs = bench.models.reduce((n, m) => n + m.base.runs + m.plugin.runs, 0);

  return (
    <main id="main" className="relative">
      <div className="glow pointer-events-none absolute inset-x-0 top-0 h-140" aria-hidden="true" />
      <div className="relative mx-auto w-full max-w-6xl px-4 pt-12 pb-16 sm:px-6 sm:pt-16 sm:pb-24">
        <div className="max-w-3xl">
          <Eyebrow>Benchmark · {benchmark.date}</Eyebrow>
          <h1 className="mt-3 text-[2rem] leading-[1.1] font-semibold tracking-[-0.025em] text-balance text-fg sm:text-[2.6rem]">
            Coding agents with and without onsystem
          </h1>
          <p data-headline className="mt-4 text-base leading-relaxed text-fg-soft sm:text-[17px]">
            In the run of {benchmark.date}, <Headline benchmark={benchmark} />.
          </p>
          <p className="mt-4 text-[15px] leading-relaxed text-muted">
            Each model wrote the same {benchmark.tasks.length} UI components in{' '}
            {words(benchmark.repos.length)} open-source repositories, once with no onsystem and once
            with each of its parts: the{' '}
            <TextLink href={docsHref('claude-code-plugin')}>skill</TextLink>, the{' '}
            <TextLink href={docsHref('tools')}>MCP server</TextLink>, the hook, and all three. A
            rule violation is an error from <InlineCode>onsystem check</InlineCode> that the run
            added to the repository. <InlineCode>tsc</InlineCode> type-checks each file in its
            project&apos;s own setup, and a sample was labelled blind by an AI reviewer.
          </p>
        </div>

        <nav aria-label="On this page" className="mt-8">
          <ul className="flex flex-wrap gap-1.5">
            {SECTIONS.map(([id, label]) => (
              <li key={id}>
                <a
                  href={`#${id}`}
                  className="flex rounded-md border border-line px-2.5 py-1.5 text-[13px] text-muted transition-colors hover:text-fg"
                >
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-10">
          <p className="mb-3 text-[13px] text-muted">
            No onsystem → skill, MCP server and hook, all {benchmark.models.length} models pooled,
            with 95% intervals.
          </p>
          <HeadlineStats benchmark={benchmark} />
        </div>

        <div className="mt-14">
          <Block id="results" title="Results">
            <Prose>
              <p>
                Every arm, pooled over the {words(benchmark.models.length)} models. Rates have 95%
                Wilson intervals; means and differences have 95% intervals from a bootstrap that
                resamples tasks. Pooled by tier, rule violations per run went from{' '}
                {perRun(small.onsystemErrors.value)} to {perRun(smallAll.onsystemErrors.value)} for
                the small models and from {perRun(mid.onsystemErrors.value)} to{' '}
                {perRun(midAll.onsystemErrors.value)} for the mid models.
              </p>
            </Prose>
            <div className="mt-6">
              <ArmsTable />
            </div>
            <h3 className="mt-9 text-lg font-semibold tracking-tight text-fg">
              Each arm against no onsystem
            </h3>
            <p className="mt-2 max-w-3xl text-[15px] leading-relaxed text-muted">
              Paired on model, task and repeat. Accepted means the file was created, passes{' '}
              <InlineCode>tsc</InlineCode> and has no onsystem error.
            </p>
            <div className="mt-4">
              <DeltasTable />
            </div>
            <Fold summary={`Every model and arm (${String(benchmark.rows.length)} rows)`}>
              <ModelsTable />
            </Fold>
            <Fold
              summary={`Each arm against no onsystem, by model (${String(benchmark.deltas.length)} rows)`}
            >
              <ModelDeltasTable />
            </Fold>
            <p className="mt-4 text-[13px] text-subtle">
              From <TextLink href={repoLink(`${RESULTS}/results.json`)}>results.json</TextLink> and{' '}
              <TextLink href={repoLink(`${RESULTS}/results.md`)}>results.md</TextLink>; one row per
              run in <TextLink href={repoLink(`${RESULTS}/runs.csv`)}>runs.csv</TextLink>.
            </p>
          </Block>

          <Block id="labels" title="Blind labels">
            <Prose>
              <p>
                A stratified random sample of {labels.files} files ({perArm} per arm) was labelled
                blind by an AI reviewer ({labels.labeller.model}). It saw the task, the design
                system and the file, not the model, the arm or onsystem&apos;s verdict, and counted
                invented APIs, hardcoded values, native elements and unnamed controls.{' '}
                <span className="text-fg-soft">
                  {words(family.length).replace(/^./, (c) => c.toUpperCase())} of the{' '}
                  {words(benchmark.models.length)} models ({family.join(' and ')}) are from the same
                  family as the labeller
                </span>
                , so they may share its blind spots. With {perArm} files per arm, the intervals are
                wide. Who labelled, what it could see and the rules it applied are in{' '}
                <TextLink href={repoLink(`${RESULTS}/labels/LABELLER.md`)}>LABELLER.md</TextLink>.
              </p>
            </Prose>
            <div className="mt-6">
              <LabelsTable />
            </div>
            <Prose>
              <p data-labels="agreement" className="mt-5">
                Per file, onsystem and the labeller both found a problem in {labels.agreement.both},
                only onsystem in {labels.agreement.onsystemOnly}, only the labeller in{' '}
                {labels.agreement.labellerOnly} and neither in {labels.agreement.neither}.
              </p>
              <p data-labels="precision" className="mt-3">
                Of onsystem&apos;s {labels.findings} findings on these files, the labeller judged{' '}
                {labels.precision.successes} correct, {wrong} wrong and {labels.precision.debatable}{' '}
                debatable.
              </p>
            </Prose>
          </Block>

          <Block id="method" title="Method">
            <Sub title="The tasks">
              <Prose>
                <p>
                  {benchmark.tasks.length} tasks, {benchmark.tasks.length / benchmark.repos.length}{' '}
                  per repository, each a new component file a product team would write. Each names
                  something the design system has to answer: a status color, a destructive action,
                  an icon-only button, a dialog, a form control. Every prompt asks the agent to use
                  the project&apos;s components and tokens, to create only that file and to run
                  nothing.
                </p>
              </Prose>
              <Fold summary={`The ${String(benchmark.tasks.length)} prompts`}>
                {/* The prompts name long file paths, which break anywhere on a phone. */}
                <ul className="grid gap-4 text-[14px] leading-relaxed [overflow-wrap:anywhere]">
                  {benchmark.repos.map((repo) => (
                    <li key={repo.name}>
                      <p className="font-mono text-[12.5px] text-fg-soft">{repo.name}</p>
                      <ul className="mt-1.5 grid gap-1.5 text-muted">
                        {benchmark.tasks
                          .filter((task) => task.repo === repo.name)
                          .map((task) => (
                            <li key={task.id}>{task.prompt}</li>
                          ))}
                      </ul>
                    </li>
                  ))}
                </ul>
              </Fold>
            </Sub>

            <Sub title="The repositories">
              <Scroll label="The repositories">
                <table className="w-full min-w-[720px] text-left text-[13px]">
                  <thead className="bg-raised">
                    <tr>
                      {['Repository', 'Commit', 'App', 'Design system', 'TypeScript'].map((l) => (
                        <th key={l} scope="col" className={th}>
                          {l}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line/70">
                    {benchmark.repos.map((repo) => (
                      <tr key={repo.name}>
                        <th
                          scope="row"
                          className="py-2.5 pr-3 pl-4 text-left align-top font-normal"
                        >
                          <TextLink href={repo.url}>
                            {repo.url.replace('https://github.com/', '')}
                          </TextLink>
                        </th>
                        <PlainCell col="sha">
                          <a
                            href={`${repo.url}/tree/${repo.sha}`}
                            className="underline decoration-line-strong underline-offset-4 hover:text-fg"
                          >
                            {repo.sha.slice(0, 7)}
                          </a>
                        </PlainCell>
                        <PlainCell col="project">{repo.project}</PlainCell>
                        <td className="px-3 py-2.5 align-top text-[13px] leading-relaxed text-muted">
                          {repo.designSystem}
                        </td>
                        <PlainCell col="typescript">{repo.typescript}</PlainCell>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Scroll>
            </Sub>

            <Sub title="The arms">
              <div className="max-w-4xl">
                <MarkdownBlocks markdown={benchmark.method.arms} />
              </div>
            </Sub>

            <Sub title="The models">
              <Prose>
                <p>
                  {words(benchmark.models.length).replace(/^./, (c) => c.toUpperCase())} models from{' '}
                  {words(benchmark.providers.length)} providers (
                  {benchmark.providers.map((p) => p.name).join(', ')}), in {words(tiers.length)}{' '}
                  tiers. Every model runs in the same agent loop, with the same file tools and no
                  shell, at the same nominal reasoning level. Prices as read on{' '}
                  {cost.pricesVerified}.
                </p>
              </Prose>
              <div className="mt-4">
                <Scroll label="The models">
                  <table className="w-full min-w-[560px] text-left text-[13px]">
                    <thead className="bg-raised">
                      <tr>
                        {['Model', 'ID', 'Provider', 'Tier', 'Runs'].map((l) => (
                          <th key={l} scope="col" className={th}>
                            {l}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line/70">
                      {tiers.flatMap((tier) =>
                        benchmark.models
                          .filter((m) => m.tier === tier)
                          .map((m) => (
                            <tr key={m.id}>
                              <th
                                scope="row"
                                className="py-2.5 pr-3 pl-4 text-left align-top font-normal text-fg-soft"
                              >
                                {m.name}
                              </th>
                              <PlainCell col="id">{m.id}</PlainCell>
                              <PlainCell col="provider">
                                {benchmark.providers.find((p) => p.id === m.provider)?.name}
                              </PlainCell>
                              <PlainCell col="tier">{m.tier}</PlainCell>
                              <PlainCell col="runs">{count(m.runs)}</PlainCell>
                            </tr>
                          )),
                      )}
                    </tbody>
                  </table>
                </Scroll>
              </div>
            </Sub>

            <Sub title="Scoring">
              <div className="max-w-3xl">
                <MarkdownBlocks markdown={benchmark.method.scoring} />
              </div>
            </Sub>

            <Sub title="Statistics">
              <div className="max-w-3xl">
                <MarkdownBlocks markdown={benchmark.method.statistics} />
              </div>
            </Sub>

            <Sub title="Cost and time">
              <dl
                data-labels="cost"
                className="grid max-w-3xl gap-4 text-[15px] leading-relaxed sm:grid-cols-2"
              >
                <div>
                  <dt className="text-[13px] text-subtle">API cost</dt>
                  <dd className="mt-0.5 text-fg-soft">
                    {usd(cost.total, 2)} for {count(benchmark.runs)} runs, under a cap of{' '}
                    {usd(cost.cap, 0)}
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] text-subtle">Wall-clock time</dt>
                  <dd className="mt-0.5 text-fg-soft">
                    {time.wallMinutes} minutes, runs in parallel
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] text-subtle">Time per run</dt>
                  <dd className="mt-0.5 text-fg-soft">
                    median {time.medianSeconds} s, from {time.minSeconds} s to {time.maxSeconds} s
                  </dd>
                </div>
                <div>
                  <dt className="text-[13px] text-subtle">How runs ended</dt>
                  <dd className="mt-0.5 text-fg-soft">
                    {count(benchmark.statuses.done ?? 0)} finished
                    {atLimit.map(([status, n]) => `, ${count(n)} stopped at a limit (${status})`)};
                    a run that stops at a limit counts, with what it wrote
                  </dd>
                </div>
              </dl>
            </Sub>
          </Block>

          <Block id="threats" title="Threats to validity">
            <div className="max-w-3xl text-[15.5px]">
              <ul className="grid list-disc gap-2.5 pl-5 leading-relaxed text-muted marker:text-subtle">
                <li className="pl-1">
                  <strong className="font-semibold text-fg">
                    The labels are an AI reviewer&apos;s.
                  </strong>{' '}
                  The sample was labelled blind by an AI reviewer ({labels.labeller.model}), not by
                  people.{' '}
                  <TextLink href={repoLink(`${RESULTS}/labels/LABELLER.md`)}>LABELLER.md</TextLink>{' '}
                  records what it could see and how it decided.
                </li>
                <li className="pl-1">
                  <strong className="font-semibold text-fg">
                    The labeller&apos;s family is under test.
                  </strong>{' '}
                  {words(family.length).replace(/^./, (c) => c.toUpperCase())} of the{' '}
                  {words(benchmark.models.length)} models ({family.join(' and ')}) are from the same
                  family as the labeller, so they may share blind spots.
                </li>
                <li className="pl-1">
                  <strong className="font-semibold text-fg">onsystem is one of the scorers.</strong>{' '}
                  The headline counts onsystem&apos;s own errors. <InlineCode>tsc</InlineCode> and
                  the blind labels are the independent checks: <InlineCode>tsc</InlineCode> does not
                  see hardcoded values, and the labels cover {labels.files} files.
                </li>
              </ul>
              <div className="mt-2.5">
                <MarkdownBlocks markdown={benchmark.method.threats} />
              </div>
            </div>
          </Block>

          <Block id="reproduce" title="Reproduce it">
            <div className="max-w-3xl">
              <MarkdownBlocks markdown={benchmark.method.running} />
              <p className="mt-5 text-[15.5px] leading-relaxed text-muted">
                Every request&apos;s usage and every tool call are on the{' '}
                <TextLink href={benchmark.release.url}>{benchmark.release.tag} release</TextLink>;
                the files each run wrote, its scores and the labels are in{' '}
                <TextLink href={repoLink(RESULTS, 'tree')}>{RESULTS}</TextLink>. The full method is
                in <TextLink href={repoLink('bench/v2/README.md')}>bench/v2/README.md</TextLink>.
              </p>
            </div>
          </Block>

          <Block id="v1" title="The earlier benchmark">
            <div className="max-w-3xl">
              <MarkdownBlocks markdown={benchmark.method.v1} />
            </div>
            <div className="mt-8">
              <EarlierBenchmark bench={bench} />
            </div>
            <div className="mt-8 grid gap-6 text-[15px] leading-relaxed text-muted md:grid-cols-2 md:gap-10">
              <p>
                Claude Code built {words(bench.tasks.length)} components for{' '}
                <TextLink href="https://github.com/vercel/ai-chatbot">vercel/ai-chatbot</TextLink>,
                once as it ships and once with the plugin, and{' '}
                <InlineCode>onsystem check</InlineCode> scored every file. Without the plugin, the
                misses were raw colors for things the prompt described, a native{' '}
                <InlineCode>&lt;label&gt;</InlineCode> where the project has{' '}
                <InlineCode>Label</InlineCode>, and an icon button nobody could name with a screen
                reader. With it, the agent looked components and tokens up before writing (
                {v1Calls.join(' to ')} design-system tool calls per task).
              </p>
              <p>
                It is one project and {count(v1Runs)} runs, one per task, model and condition, so
                read it as a direction rather than a rate
                {v1Small && v1Small.costDelta < 0
                  ? `; ${v1Small.name} cost less with the plugin than without`
                  : ''}
                .{' '}
                <TextLink href={repoLink('bench/agents', 'tree')}>
                  The method, per-run results and every generated file
                </TextLink>{' '}
                are in the repository.
              </p>
            </div>
          </Block>
        </div>
      </div>
    </main>
  );
}
