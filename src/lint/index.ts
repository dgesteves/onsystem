import ts from 'typescript';

import type { RuleId, ResolvedRule } from '../config.js';
import type { CheckResult, Diagnostic } from '../types.js';
import { analyze } from './analyze.js';
import { resolveElement, type Resolution, type RuleContext } from './context.js';
import { RULES } from './rules/index.js';
import { isSuppressed, readDirectives } from './suppress.js';
import type { LintTarget } from './target.js';

export { LintTarget } from './target.js';
export { escapeData, formatDiagnostics, type OutputFormat } from './format.js';

export { RULES };

export interface CheckOptions {
  /** File name used in results and to pick TSX vs JSX parsing. Default `snippet.tsx`. */
  filename?: string | undefined;
  rules: Record<RuleId, ResolvedRule>;
}

/**
 * Lints a TSX/JSX snippet or file against the design system. Purely
 * syntactic: no type-checking of the snippet, so it works on fragments an
 * agent has not saved yet.
 */
export function checkSource(code: string, target: LintTarget, options: CheckOptions): CheckResult {
  const file = options.filename ?? 'snippet.tsx';
  try {
    return checkParsed(code, target, options, file);
  } catch (error) {
    if (!isStackOverflow(error)) throw error;
    // TypeScript's parser is recursive: thousands of nested brackets or tags exhaust the
    // stack. Say so as a finding rather than failing the check, the CLI run or the tool call.
    return {
      file,
      diagnostics: [
        {
          ruleId: 'syntax',
          severity: 'error',
          message:
            'The code is nested too deeply to parse (thousands of levels), so it was not checked.',
          line: 1,
          column: 1,
          endLine: 1,
          endColumn: 1,
          source: '',
        },
      ],
      errorCount: 1,
      warningCount: 0,
    };
  }
}

function isStackOverflow(error: unknown): boolean {
  return error instanceof RangeError && /call stack/i.test(error.message);
}

function checkParsed(
  code: string,
  target: LintTarget,
  options: CheckOptions,
  file: string,
): CheckResult {
  // `.ts` files must not be parsed as TSX: `<T>(x: T) => x` would read as a JSX tag.
  const kind = /\.[cm]?jsx?$/.test(file)
    ? ts.ScriptKind.JSX
    : /\.[cm]?ts$/.test(file)
      ? ts.ScriptKind.TS
      : ts.ScriptKind.TSX;
  const sourceFile = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, kind);
  const analysis = analyze(sourceFile);
  const skipped = renderedElsewhere(file, analysis.imports);
  if (skipped) return { file, diagnostics: [], errorCount: 0, warningCount: 0, skipped };
  const diagnostics: Diagnostic[] = [];
  const cache = new Map<unknown, Resolution>();
  const unchecked = { names: new Set<string>(), modules: new Set<string>() };
  // A byte-order mark is a character to TypeScript but not a column to editors.
  // Offsets (fix ranges) stay on the text as given.
  const bom = code.charCodeAt(0) === 0xfeff ? 1 : 0;
  const position = (offset: number) => {
    const { line, character } = sourceFile.getLineAndCharacterOfPosition(offset);
    return { line: line + 1, column: Math.max(1, character + 1 - (line === 0 ? bom : 0)) };
  };

  for (const rule of RULES) {
    const setting = options.rules[rule.id];
    if (setting.severity === 'off') continue;
    const severity = setting.severity === 'error' ? 'error' : 'warning';
    const context: RuleContext = {
      file,
      text: code,
      sourceFile,
      target,
      analysis,
      options: setting.options,
      isDesignSystemSource: target.componentFiles.has(file),
      resolve(element) {
        let resolution = cache.get(element.node);
        if (!resolution) {
          resolution = resolveElement(element, analysis, target, file);
          cache.set(element.node, resolution);
        }
        return resolution;
      },
      report(report) {
        const start = position(report.start);
        const end = position(report.end);
        const diagnostic: Diagnostic = {
          ruleId: rule.id,
          severity: report.severity === 'warning' ? 'warning' : severity,
          message: report.message,
          line: start.line,
          column: start.column,
          endLine: end.line,
          endColumn: end.column,
          source: code.slice(report.start, report.end),
        };
        if (report.suggestion) diagnostic.suggestion = report.suggestion;
        if (report.fix?.length) diagnostic.fix = report.fix;
        diagnostics.push(diagnostic);
      },
      unchecked(name, module) {
        unchecked.names.add(name);
        unchecked.modules.add(module);
      },
    };
    rule.run(context);
  }

  // `// onsystem-disable-next-line <rule>` and friends; an unknown rule name is reported.
  const { directives, problems } = readDirectives(sourceFile);
  if (directives.length) {
    const kept = diagnostics.filter((d) => !isSuppressed(d, directives));
    diagnostics.length = 0;
    diagnostics.push(...kept);
  }
  diagnostics.push(...problems);

  // Syntax errors make every other finding suspect; surface them first.
  for (const error of syntaxErrors(sourceFile)) {
    const start = position(error.start);
    diagnostics.push({
      ruleId: 'syntax',
      severity: 'error',
      message: `Syntax error: ${ts.flattenDiagnosticMessageText(error.messageText, ' ')}`,
      line: start.line,
      column: start.column,
      endLine: start.line,
      endColumn: start.column + error.length,
      source: code.slice(error.start, error.start + error.length),
    });
  }

  diagnostics.sort(
    (a, b) => a.line - b.line || a.column - b.column || a.ruleId.localeCompare(b.ruleId),
  );
  const result: CheckResult = {
    file,
    diagnostics,
    errorCount: diagnostics.filter((d) => d.severity === 'error').length,
    warningCount: diagnostics.filter((d) => d.severity === 'warning').length,
  };
  if (unchecked.names.size) {
    result.unchecked = { names: [...unchecked.names], modules: [...unchecked.modules] };
  }
  return result;
}

/**
 * One notice for the components a check could not see, across files: the
 * model left their modules out, so "no problems" says nothing about them.
 */
export function uncheckedNotice(results: readonly CheckResult[]): string | undefined {
  const names = new Set<string>();
  const modules = new Set<string>();
  let files = 0;
  for (const result of results) {
    if (!result.unchecked) continue;
    files++;
    for (const name of result.unchecked.names) names.add(name);
    for (const module of result.unchecked.modules) modules.add(module);
  }
  if (!names.size) return undefined;
  const list = [...names];
  const shown = list.slice(0, 4).map((n) => `<${n}>`);
  const more = list.length > shown.length ? ` and ${list.length - shown.length} more` : '';
  // JSON-quoted: a module specifier is the checked file's, and can hold a quote or a line break.
  const from = [...modules].slice(0, 3).map((m) => JSON.stringify(m));
  const moreModules = modules.size > from.length ? ` and ${modules.size - from.length} more` : '';
  const where = results.length > 1 ? ` (in ${files} ${files === 1 ? 'file' : 'files'})` : '';
  return (
    `${shown.join(', ')}${more} ${list.length === 1 ? 'comes' : 'come'} from ${from.join(', ')}${moreModules}, which the design-system model does not include, so ${list.length === 1 ? 'it was' : 'they were'} not checked${where}. ` +
    'Extraction looks incomplete: `inspect` lists what was found; add the missing files to "components" in the config.'
  );
}

/** Modules that render JSX to an image or an email, where CSS variables and Tailwind classes do not work. */
const ELSEWHERE_MODULES: [RegExp, string][] = [
  [/^(?:next\/og|@vercel\/og)$/, 'an image (next/og)'],
  [/^satori(?:\/.*)?$/, 'an image (Satori)'],
  [/^(?:@react-email\/.+|react-email)$/, 'an email (React Email)'],
];

/** Next.js routes that generate an image: `app/opengraph-image.tsx`, `app/(site)/icon.tsx`. */
const IMAGE_ROUTE =
  /(?:^|\/)app\/(?:.+\/)?(?:opengraph-image|twitter-image|icon|apple-icon)\d*\.[cm]?[jt]sx?$/;
/** The pieces of such images, kept together in an `og` folder (`app/api/og/_components/background.tsx`). */
const IMAGE_FOLDER = /(?:^|\/)og\//;

/**
 * Why a file is not checked, when it renders outside the browser's CSS: an
 * Open Graph image drawn by next/og or Satori, or an email, where design
 * tokens and classes do not apply and hex colors and px values are right.
 */
export function renderedElsewhere(
  file: string,
  imports: ReadonlyMap<string, { source: string }>,
): string | undefined {
  const sources = new Set([...imports.values()].map((binding) => binding.source));
  for (const [pattern, what] of ELSEWHERE_MODULES) {
    if ([...sources].some((source) => pattern.test(source))) {
      return `It renders ${what}, where design tokens and classes do not apply.`;
    }
  }
  const posix = file.replaceAll('\\', '/');
  if (IMAGE_ROUTE.test(posix) || IMAGE_FOLDER.test(posix)) {
    return 'It is part of a Next.js image route, rendered by next/og, where design tokens and classes do not apply.';
  }
  return undefined;
}

/** Syntax errors through the public API: a one-file program with no libs or resolution. */
function syntaxErrors(sourceFile: ts.SourceFile): readonly ts.DiagnosticWithLocation[] {
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === sourceFile.fileName ? sourceFile : undefined),
    getDefaultLibFileName: () => 'lib.d.ts',
    writeFile: () => undefined,
    getCurrentDirectory: () => '/',
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (name) => name === sourceFile.fileName,
    readFile: () => undefined,
  };
  const program = ts.createProgram({
    rootNames: [sourceFile.fileName],
    options: { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve },
    host,
  });
  return program.getSyntacticDiagnostics(sourceFile);
}

/** Applies non-overlapping fixes from the end of the file backwards. */
export function applyFixes(code: string, diagnostics: Diagnostic[]): string {
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
