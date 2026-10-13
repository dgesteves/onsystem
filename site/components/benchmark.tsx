import { CheckIcon } from '@/components/icons';
import { TableScroll } from '@/components/table-scroll';
import type { Bench, BenchModel } from '@/lib/data';

const WITHOUT = '#5d6875';
const WITH = 'var(--color-cyan)';

function taskLabel(id: string): string {
  const words = id.replace(/-/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function signed(value: number): string {
  return value > 0 ? `+${value}%` : value < 0 ? `−${Math.abs(value)}%` : '0%';
}

/** A labelled horizontal bar on a shared scale. */
function Bar({
  label,
  value,
  max,
  color,
  text,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
  text: string;
}) {
  const width = max === 0 ? 0 : (value / max) * 100;
  return (
    <div className="grid grid-cols-[4.75rem_minmax(0,1fr)_4.5rem] items-center gap-3 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="relative h-2.5 rounded-full bg-fg/[0.05]">
        <span
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${width}%`, background: color, minWidth: value > 0 ? 6 : 0 }}
        />
      </span>
      <span className="text-right font-mono text-fg tabular-nums">{text}</span>
    </div>
  );
}

function ModelCard({ model, maxErrors }: { model: BenchModel; maxErrors: number }) {
  const { base, plugin } = model;
  return (
    <figure className="rounded-2xl border border-line bg-raised p-5 sm:p-6">
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="text-base font-semibold text-fg">{model.name}</span>
        <span className="font-mono text-xs text-subtle">{base.runs + plugin.runs} runs</span>
      </figcaption>

      <div className="mt-5">
        <p className="text-[13px] font-medium text-fg-soft">
          Components with no design-system errors
        </p>
        <div className="mt-2.5 grid gap-2">
          <Bar
            label="Without"
            value={base.clean}
            max={base.runs}
            color={WITHOUT}
            text={`${base.clean} / ${base.runs}`}
          />
          <Bar
            label="With plugin"
            value={plugin.clean}
            max={plugin.runs}
            color={WITH}
            text={`${plugin.clean} / ${plugin.runs}`}
          />
        </div>
      </div>

      <div className="mt-5">
        <p className="text-[13px] font-medium text-fg-soft">Design-system errors, all ten tasks</p>
        <div className="mt-2.5 grid gap-2">
          <Bar
            label="Without"
            value={base.errors}
            max={maxErrors}
            color={WITHOUT}
            text={String(base.errors)}
          />
          <Bar
            label="With plugin"
            value={plugin.errors}
            max={maxErrors}
            color={WITH}
            text={String(plugin.errors)}
          />
        </div>
      </div>

      <dl className="mt-6 grid grid-cols-3 gap-3 border-t border-line pt-4 text-[13px]">
        <div>
          <dt className="text-muted">Cost</dt>
          <dd className="mt-1 font-mono text-fg tabular-nums">{signed(model.costDelta)}</dd>
          <dd className="font-mono text-[11px] text-subtle tabular-nums">
            {money(base.cost)} → {money(plugin.cost)}
          </dd>
        </div>
        <div>
          <dt className="text-muted">Avg. time</dt>
          <dd className="mt-1 font-mono text-fg tabular-nums">
            {base.seconds} → {plugin.seconds} s
          </dd>
        </div>
        <div>
          <dt className="text-muted">Tool calls</dt>
          <dd className="mt-1 font-mono whitespace-nowrap text-fg tabular-nums">
            {plugin.toolCalls} per task
          </dd>
        </div>
      </dl>
    </figure>
  );
}

function Cell({ errors, byRule }: { errors: number; byRule: Record<string, number> }) {
  if (errors === 0) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted">
        <CheckIcon className="size-3.5 text-cyan" />
        clean
      </span>
    );
  }
  return (
    <span className="block">
      <span className="font-medium text-magenta-soft">
        {errors} {errors === 1 ? 'error' : 'errors'}
      </span>
      {Object.entries(byRule).map(([rule, count]) => (
        <span key={rule} className="block font-mono text-[11px] text-subtle">
          {count} × {rule}
        </span>
      ))}
    </span>
  );
}

export function Benchmark({ bench }: { bench: Bench }) {
  const maxErrors = Math.max(...bench.models.map((m) => m.base.errors), 1);
  return (
    <div>
      <div
        className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px] text-muted"
        aria-hidden="true"
      >
        <span className="inline-flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: WITHOUT }} />
          Claude Code as it ships
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="size-2.5 rounded-full" style={{ background: WITH }} />
          With the onsystem plugin
        </span>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        {bench.models.map((model) => (
          <ModelCard key={model.id} model={model} maxErrors={maxErrors} />
        ))}
      </div>

      <details className="group mt-4 rounded-2xl border border-line bg-raised/60">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-4 text-sm font-medium text-fg-soft hover:text-fg [&::-webkit-details-marker]:hidden">
          Every task, every run
          <span className="font-mono text-xs text-subtle group-open:hidden">Show</span>
          <span className="hidden font-mono text-xs text-subtle group-open:inline">Hide</span>
        </summary>
        <TableScroll label="Every task, every run" className="border-t border-line">
          <table className="w-full min-w-[640px] text-left text-[13px]">
            <caption className="sr-only">
              Design-system errors per task, for each model, without and with the plugin
            </caption>
            <thead>
              <tr className="border-b border-line text-muted">
                <th scope="col" className="px-5 py-3 font-medium">
                  Task
                </th>
                {bench.models.flatMap((m) =>
                  (['without', 'with plugin'] as const).map((condition) => (
                    <th key={`${m.id}-${condition}`} scope="col" className="px-3 py-3 font-medium">
                      {m.name.replace('Claude ', '')}
                      <span className="block font-normal text-subtle">{condition}</span>
                    </th>
                  )),
                )}
              </tr>
            </thead>
            <tbody>
              {bench.tasks.map((task, row) => (
                <tr key={task.id} className="border-b border-line/60 align-top last:border-0">
                  <th scope="row" className="px-5 py-3 font-normal">
                    <span className="text-fg-soft">{taskLabel(task.id)}</span>
                    <span className="mt-0.5 block max-w-[22rem] text-[12px] leading-snug text-subtle">
                      {task.prompt.replace(/^Create \S+ exporting \w+: /, '')}
                    </span>
                  </th>
                  {bench.models.flatMap((m) => {
                    const result = m.tasks[row];
                    if (!result) return [];
                    return [
                      <td key={`${m.id}-base`} className="px-3 py-3">
                        <Cell {...result.base} />
                      </td>,
                      <td key={`${m.id}-plugin`} className="px-3 py-3">
                        <Cell {...result.plugin} />
                      </td>,
                    ];
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      </details>
    </div>
  );
}
