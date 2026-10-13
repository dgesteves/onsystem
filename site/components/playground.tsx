'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

import { Line } from '@/components/code';
import { ArrowUpRightIcon, CheckIcon, ReplayIcon } from '@/components/icons';
import { InlineMarkdown } from '@/components/markdown';
import type { CheckError, CheckResponse } from '@/lib/check-service';
import { highlightLines, type Mark } from '@/lib/highlight';
import type { Preset, PresetResult } from '@/lib/playground';
import { ruleHref } from '@/lib/site';

type Diagnostic = PresetResult['diagnostics'][number];

interface Checked {
  /** The code the result belongs to: marks only line up with exactly this text. */
  code: string;
  result: PresetResult;
  ms?: number;
}

type Problem =
  { code: CheckError['error']['code']; message: string } | { code: 'network'; message: string };

const DEBOUNCE_MS = 650;

/** Applies the edits of `diagnostics`, from the end backwards, skipping overlaps (as the CLI does). */
function applyFixes(code: string, diagnostics: Diagnostic[]): string {
  const edits = diagnostics.flatMap((d) => d.fix ?? []).sort((a, b) => b.range[0] - a.range[0]);
  let out = code;
  let floor = Infinity;
  for (const edit of edits) {
    if (edit.range[1] > floor) continue;
    out = out.slice(0, edit.range[0]) + edit.text + out.slice(edit.range[1]);
    floor = edit.range[0];
  }
  return out;
}

/** 1-based line and column → offset. */
function offsetOf(lineStarts: number[], line: number, column: number): number {
  return (lineStarts[line - 1] ?? 0) + column - 1;
}

function lineStartsOf(code: string): number[] {
  const starts = [0];
  for (let i = 0; i < code.length; i++) if (code[i] === '\n') starts.push(i + 1);
  return starts;
}

function plural(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

function kb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

export function Playground({ presets, maxBytes }: { presets: Preset[]; maxBytes: number }) {
  const first = presets[0];
  const [presetId, setPresetId] = useState(first?.id ?? '');
  const [code, setCode] = useState(first?.code ?? '');
  const [checked, setChecked] = useState<Checked | undefined>(
    first && { code: first.code, result: first.result },
  );
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<Problem | undefined>(undefined);
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const request = useRef<AbortController | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ids = useId();

  const preset = presets.find((p) => p.id === presetId);
  const bytes = useMemo(() => new TextEncoder().encode(code).length, [code]);
  const current = checked?.code === code ? checked : undefined;
  const empty = !code.trim();

  const run = useCallback(
    async (text: string) => {
      clearTimeout(timer.current);
      request.current?.abort();
      if (!text.trim()) {
        setPending(false);
        setProblem(undefined);
        return;
      }
      if (new TextEncoder().encode(text).length > maxBytes) {
        setPending(false);
        setProblem({
          code: 'too_large',
          message: `The playground checks up to ${kb(maxBytes)} of code. The CLI and the MCP server have no such limit.`,
        });
        return;
      }
      const controller = new AbortController();
      request.current = controller;
      setPending(true);
      try {
        const response = await fetch('/api/check', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: text }),
          signal: controller.signal,
        });
        const body = (await response.json()) as CheckResponse | CheckError;
        if (controller.signal.aborted) return;
        if ('error' in body) {
          setProblem(body.error);
        } else {
          setProblem(undefined);
          setChecked({ code: text, result: body, ms: body.ms });
          setSelected(undefined);
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setProblem({
          code: 'network',
          message: `Could not reach the checker (${error instanceof Error ? error.message : 'network error'}).`,
        });
      } finally {
        if (request.current === controller) setPending(false);
      }
    },
    [maxBytes],
  );

  useEffect(
    () => () => {
      clearTimeout(timer.current);
      request.current?.abort();
    },
    [],
  );

  const edit = (next: string, { now = false } = {}) => {
    setCode(next);
    clearTimeout(timer.current);
    if (now) {
      void run(next);
    } else {
      timer.current = setTimeout(() => {
        void run(next);
      }, DEBOUNCE_MS);
    }
  };

  const choose = (next: Preset) => {
    clearTimeout(timer.current);
    request.current?.abort();
    setPending(false);
    setPresetId(next.id);
    setCode(next.code);
    setChecked({ code: next.code, result: next.result });
    setProblem(undefined);
    setSelected(undefined);
  };

  // The list keeps the last result while the edited code is checked again; its offsets only
  // line up with the code it was checked on, so marks and fixes wait for the new result.
  const stale = !current;
  // After a failed check, or with nothing to check, the previous findings describe code that is
  // gone: leave them out.
  const shown = empty || (problem && stale) ? undefined : checked;
  const diagnostics = shown?.result.diagnostics ?? [];
  const fixable = stale ? [] : diagnostics.filter((d) => d.fix?.length);
  const syntax = diagnostics.some((d) => d.ruleId === 'syntax');

  // Underlines and gutter markers for the checked code.
  const { lines, gutter } = useMemo(() => {
    const starts = lineStartsOf(code);
    const marks: Mark[] = current
      ? current.result.diagnostics.map((d, id) => ({
          start: offsetOf(starts, d.line, d.column),
          end: Math.max(
            offsetOf(starts, d.endLine, d.endColumn),
            offsetOf(starts, d.line, d.column) + 1,
          ),
          kind: id === selected ? 'active' : d.severity,
          id,
        }))
      : [];
    const severity = new Map<number, 'error' | 'warning'>();
    for (const d of current?.result.diagnostics ?? []) {
      if (severity.get(d.line) !== 'error') severity.set(d.line, d.severity);
    }
    return { lines: highlightLines(code, 'tsx', marks), gutter: severity };
  }, [code, current, selected]);

  const focusFinding = (index: number) => {
    const d = diagnostics[index];
    const area = textarea.current;
    if (!d || !area) return;
    setSelected(index);
    const starts = lineStartsOf(code);
    area.focus({ preventScroll: true });
    area.setSelectionRange(
      offsetOf(starts, d.line, d.column),
      offsetOf(starts, d.endLine, d.endColumn),
    );
    editor.current
      ?.querySelector(`[data-line="${String(d.line)}"]`)
      ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  };

  const status = empty
    ? 'Nothing to check'
    : problem
      ? 'Not checked'
      : pending || !current
        ? 'Checking…'
        : current.result.errorCount + current.result.warningCount === 0
          ? 'No design-system problems'
          : `${plural(current.result.errorCount, 'error')} · ${plural(current.result.warningCount, 'warning')}`;

  return (
    <div>
      {/* Drafts */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Drafts" className="flex flex-wrap gap-1.5">
          {presets.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={p.id === presetId}
              onClick={() => {
                choose(p);
              }}
              className="cursor-pointer rounded-lg border border-line bg-raised px-3 py-1.5 text-sm text-muted transition-colors hover:border-line-strong hover:text-fg aria-pressed:border-cyan/50 aria-pressed:bg-cyan/10 aria-pressed:text-fg"
            >
              {p.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          disabled={!preset || code === preset.code}
          onClick={() => {
            if (preset) choose(preset);
          }}
          className="ml-auto inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm text-muted transition-colors hover:text-fg disabled:cursor-default disabled:opacity-50 disabled:hover:text-muted"
        >
          <ReplayIcon className="size-4" />
          Reset
        </button>
      </div>
      {preset && <p className="mt-3 text-[14px] text-muted">{preset.description}</p>}

      <div className="mt-5 grid grid-cols-[minmax(0,1fr)] items-start gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
        {/* Editor */}
        <div className="min-w-0 overflow-hidden rounded-2xl border border-line bg-code transition-colors focus-within:border-cyan/60 focus-within:ring-1 focus-within:ring-cyan/35">
          <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
            <label htmlFor={`${ids}-code`} className="truncate font-mono text-xs text-fg-soft">
              {preset && code === preset.code ? preset.file : 'Your code'}
            </label>
            <span
              className={`shrink-0 font-mono text-[11px] ${empty || pending || !current || problem ? 'text-subtle' : current.result.errorCount > 0 ? 'text-magenta-soft' : 'text-cyan'}`}
            >
              {status}
            </span>
          </div>
          <div
            ref={editor}
            className="relative grid text-base leading-[1.6] sm:text-[13px] sm:leading-[1.7]"
          >
            <pre
              aria-hidden="true"
              className="code pointer-events-none m-0 py-3 pr-4 whitespace-pre-wrap [overflow-wrap:anywhere] [grid-area:1/1]"
            >
              {lines.map((segments, i) => {
                const severity = gutter.get(i + 1);
                return (
                  <span key={i} data-line={i + 1} className="flex min-h-[1lh]">
                    <span className="relative w-9 shrink-0 pr-2.5 text-right text-[11px] text-subtle select-none sm:w-11 sm:pr-3">
                      {severity && (
                        <span
                          className={`absolute top-[0.7em] left-1 size-1.5 rounded-full sm:left-1.5 ${severity === 'error' ? 'bg-magenta' : 'bg-cyan'}`}
                        />
                      )}
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1">
                      <Line segments={segments} />
                    </span>
                  </span>
                );
              })}
            </pre>
            <textarea
              ref={textarea}
              id={`${ids}-code`}
              value={code}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              aria-describedby={`${ids}-hint`}
              onChange={(event) => {
                edit(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  edit(event.currentTarget.value, { now: true });
                }
              }}
              className="code m-0 block h-full w-full resize-none overflow-hidden bg-transparent py-3 pr-4 pl-9 whitespace-pre-wrap text-transparent caret-cyan-bright outline-none [overflow-wrap:anywhere] [grid-area:1/1] selection:bg-cyan/25 selection:text-transparent focus-visible:outline-none sm:pl-11"
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line px-4 py-2 text-[12px] text-subtle">
            <span id={`${ids}-hint`}>
              Checks as you type, or now with <kbd className="font-mono">⌘</kbd>/
              <kbd className="font-mono">Ctrl</kbd> + <kbd className="font-mono">Enter</kbd>.
              Parsed, never run.
            </span>
            <span className={`font-mono ${bytes > maxBytes ? 'text-magenta-soft' : ''}`}>
              {kb(bytes)} / {kb(maxBytes)}
            </span>
          </div>
        </div>

        {/* Findings */}
        <section
          aria-labelledby={`${ids}-findings`}
          className="min-w-0 rounded-2xl border border-line bg-raised lg:sticky lg:top-20 lg:max-h-[calc(100dvh-6rem)] lg:overflow-y-auto"
        >
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
            <h2 id={`${ids}-findings`} className="text-sm font-semibold text-fg">
              {shown && diagnostics.length === 0 ? (
                <span className="inline-flex items-center gap-2">
                  <CheckIcon className="size-4 text-cyan" />
                  No design-system problems
                </span>
              ) : (
                <>
                  Findings
                  {shown && (
                    <span className="font-mono text-xs font-normal">
                      {' '}
                      <span className="text-magenta-soft">
                        {plural(shown.result.errorCount, 'error')}
                      </span>
                      <span className="text-subtle"> · </span>
                      <span className="text-cyan">
                        {plural(shown.result.warningCount, 'warning')}
                      </span>
                    </span>
                  )}
                </>
              )}
            </h2>
            {fixable.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  edit(applyFixes(code, fixable), { now: true });
                }}
                className="cursor-pointer rounded-md border border-cyan/40 bg-cyan/10 px-2.5 py-1 text-[13px] font-medium text-cyan-bright transition-colors hover:bg-cyan/20"
              >
                Apply {fixable.length === 1 ? 'the fix' : `all ${String(fixable.length)} fixes`}
              </button>
            )}
          </div>

          <p className="sr-only" role="status">
            {pending ? '' : status}
          </p>

          {problem && (
            <div
              role="alert"
              className="mx-4 mt-4 rounded-lg border border-magenta/40 bg-magenta/10 px-3 py-2.5 text-[13px] leading-relaxed text-fg-soft"
            >
              <p className="font-medium text-fg">
                {problem.code === 'too_large'
                  ? 'Too large to check here'
                  : problem.code === 'rate_limited'
                    ? 'Slow down a little'
                    : problem.code === 'timeout'
                      ? 'The check timed out'
                      : 'Could not check'}
              </p>
              <p className="mt-0.5 text-muted">{problem.message}</p>
              {problem.code !== 'too_large' && (
                <button
                  type="button"
                  onClick={() => {
                    void run(code);
                  }}
                  className="mt-2 cursor-pointer text-[13px] font-medium text-cyan-bright underline underline-offset-4"
                >
                  Try again
                </button>
              )}
            </div>
          )}

          {syntax && current && (
            <p className="mx-4 mt-4 rounded-lg border border-line bg-raised-2 px-3 py-2.5 text-[13px] leading-relaxed text-muted">
              <span className="font-medium text-fg">The code does not parse yet.</span> The rules
              still ran on what TypeScript could read, so some findings may be missing until the
              syntax error is fixed.
            </p>
          )}

          {empty && (
            <p className="px-4 py-4 text-[14px] leading-relaxed text-muted">
              Nothing to check yet. Paste a component or a fragment of TSX, or pick a draft above.
            </p>
          )}

          {shown && diagnostics.length === 0 && (
            <p
              className={`px-4 py-4 text-[14px] leading-relaxed text-muted ${stale ? 'opacity-60' : ''}`}
            >
              Every component, prop and variant exists, and colors, spacing and radius come from the
              tokens.
              {shown.ms !== undefined && (
                <span className="text-subtle"> Checked in {shown.ms.toFixed(1)} ms.</span>
              )}
            </p>
          )}

          {diagnostics.length > 0 && (
            <ol
              className={`grid grid-cols-[minmax(0,1fr)] divide-y divide-line/70 ${pending || stale ? 'opacity-60' : ''}`}
            >
              {diagnostics.map((d, i) => (
                <li
                  key={`${String(i)}-${d.ruleId}-${String(d.line)}-${String(d.column)}`}
                  className={`px-4 py-3 ${selected === i ? 'bg-fg/[0.03]' : ''}`}
                >
                  <div className="flex items-baseline gap-2 font-mono text-[11.5px]">
                    <span
                      className={`size-1.5 shrink-0 translate-y-[-1px] rounded-full ${d.severity === 'error' ? 'bg-magenta' : 'bg-cyan'}`}
                      aria-hidden="true"
                    />
                    <span className={d.severity === 'error' ? 'text-magenta-soft' : 'text-cyan'}>
                      {d.severity}
                    </span>
                    <button
                      type="button"
                      disabled={stale}
                      onClick={() => {
                        focusFinding(i);
                      }}
                      className="cursor-pointer text-subtle underline disabled:cursor-default disabled:no-underline decoration-line-strong underline-offset-2 hover:text-fg"
                    >
                      {d.line}:{d.column}
                      <span className="sr-only"> (show in the editor)</span>
                    </button>
                    {d.ruleId === 'syntax' ? (
                      <span className="truncate text-muted">syntax</span>
                    ) : (
                      <a
                        href={ruleHref(d.ruleId)}
                        className="inline-flex min-w-0 items-center gap-0.5 text-muted hover:text-fg"
                      >
                        <span className="truncate">{d.ruleId}</span>
                        <ArrowUpRightIcon className="size-3 shrink-0" />
                      </a>
                    )}
                  </div>
                  <p className="mt-1.5 text-[13.5px] leading-relaxed text-fg-soft">
                    <InlineMarkdown text={d.message} />
                  </p>
                  {d.fix?.length ? (
                    <button
                      type="button"
                      disabled={stale}
                      onClick={() => {
                        edit(applyFixes(code, [d]), { now: true });
                      }}
                      className="mt-2 inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line bg-raised-2 px-2 py-1 font-mono text-[12px] text-fg-soft transition-colors hover:border-cyan/50 hover:text-fg disabled:cursor-default disabled:hover:border-line"
                    >
                      Apply fix
                      {d.suggestion && <span className="text-cyan-bright">{d.suggestion}</span>}
                    </button>
                  ) : d.suggestion ? (
                    <p className="mt-2 font-mono text-[12px] text-subtle">
                      Suggests <span className="text-cyan-bright">{d.suggestion}</span>; the change
                      needs a decision, so there is no automatic fix.
                    </p>
                  ) : null}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </div>
  );
}
