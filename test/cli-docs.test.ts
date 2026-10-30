import fs from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { main, type Io } from '../src/cli.js';
import { CONFIG_FILES } from '../src/config.js';
import { DEMO_ROOT } from './helpers.js';
import { section } from './markdown.js';

// docs/cli.md is the CLI reference, and the options it lists are the ones `--help` prints and the
// parser accepts, under the commands `--help` gives them to, with the same argument names. A
// flag that ships without a row there, or a row left behind by a flag that is gone, fails here.
// Before this page, `--quiet-without-design-system` was in no doc at all, and `--baseline`,
// `--ignore-baseline`, `--include-tests`, `--components`, `--docs` and `--no-watch` were each
// named in one place, in passing. The GitHub Action's inputs are held to their table in
// docs/required-check.md the same way.

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) =>
  fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n');

const COMMANDS = ['serve', 'check', 'inspect', 'export', 'init'] as const;
/** The section of docs/cli.md for options that do not name a command in `--help`. */
const SHARED = 'Options for every command';
interface Option {
  /** The flags, such as `-y` and `--yes`. */
  flags: string[];
  /** The argument it takes, such as `<dir>`, or '' for none. */
  arg: string;
  /** The commands `--help` gives it to (`check:` in its text); none for every command. */
  commands: string[];
}

/** What `onsystem --help` prints. */
async function helpText(): Promise<string> {
  const out: string[] = [];
  const io: Io = { cwd: root, color: false, stdout: (t) => out.push(t), stderr: () => {} };
  expect(await main(['--help'], io)).toBe(0);
  return out.join('\n');
}

/** The options `--help` lists under Options, each with the text that follows it. */
function helpOptions(help: string): Option[] {
  const start = help.indexOf('\nOptions\n');
  const end = help.indexOf('\nExamples\n');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const options: Option[] = [];
  let current: (Option & { text: string }) | undefined;
  const done = () => {
    if (!current) return;
    const named = [...current.text.matchAll(/\b(serve|check|inspect|export|init):/g)];
    options.push({
      flags: current.flags,
      arg: current.arg,
      commands: unique(named.map((m) => m[1] ?? '')),
    });
  };
  for (const line of help.slice(start + '\nOptions\n'.length, end).split('\n')) {
    const entry = /^ {2}((?:-\w, )?--[\w-]+)(?: (<[^>]+>))?(.*)$/.exec(line);
    if (entry) {
      done();
      current = {
        flags: (entry[1] ?? '').split(', '),
        arg: entry[2] ?? '',
        commands: [],
        text: entry[3] ?? '',
      };
    } else if (current) {
      current.text += ` ${line.trim()}`;
    }
  }
  done();
  return options;
}

/** The flags the parser in src/cli.ts accepts: `--no-<name>` for a boolean that defaults to true. */
function parserFlags(): string[] {
  const file = path.join(root, 'src/cli.ts');
  const source = ts.createSourceFile(file, read('src/cli.ts'), ts.ScriptTarget.Latest, true);
  let options: ts.ObjectLiteralExpression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'parseArgs'
    ) {
      const arg = node.arguments[0];
      const prop =
        arg && ts.isObjectLiteralExpression(arg)
          ? arg.properties.find((p) => p.name?.getText(source) === 'options')
          : undefined;
      if (prop && ts.isPropertyAssignment(prop) && ts.isObjectLiteralExpression(prop.initializer)) {
        options = prop.initializer;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!options) throw new Error('src/cli.ts: no parseArgs({ options }) found');
  const flags: string[] = [];
  for (const prop of options.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue;
    const name = prop.name.getText(source).replace(/^'|'$/g, '');
    const value = (key: string) => {
      const p = (prop.initializer as ts.ObjectLiteralExpression).properties.find(
        (q) => q.name?.getText(source) === key,
      );
      return p && ts.isPropertyAssignment(p) ? p.initializer.getText(source) : undefined;
    };
    const short = value('short');
    if (short) flags.push(`-${short.replace(/^'|'$/g, '')}`);
    flags.push(
      value('type') === "'boolean'" && value('default') === 'true' ? `--no-${name}` : `--${name}`,
    );
  }
  return flags;
}

/** The option rows of a docs/cli.md section's tables: `| \`-y\`, \`--yes\` | …`. */
function docRows(markdown: string): { flags: string[]; arg: string }[] {
  return [...markdown.matchAll(/^\| ((?:`-[^`]+`(?:, )?)+) +\|/gm)].map((m) => {
    const cells = [...(m[1] ?? '').matchAll(/`([^`]+)`/g)].map((c) => c[1] ?? '');
    const args = unique(cells.map((cell) => /^-\S+ (<[^>]+>)$/.exec(cell)?.[1] ?? ''));
    return {
      flags: cells.map((cell) => cell.split(' ')[0] ?? ''),
      arg: args.find(Boolean) ?? '',
    };
  });
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

const key = (flags: string[]) => [...flags].sort().join(', ');

describe('the CLI reference (docs/cli.md)', () => {
  const cli = read('docs/cli.md');
  let options: Option[] = [];
  let help = '';

  beforeAll(async () => {
    help = await helpText();
    options = helpOptions(help);
  });

  it('reads the options from --help', () => {
    // The parse above found every entry: the first and last, one with a short flag, and one whose
    // text names two commands.
    expect(options[0]?.flags).toEqual(['--root']);
    expect(options.at(-1)?.flags).toEqual(['-v', '--version']);
    expect(options.find((o) => o.flags.includes('--yes'))).toEqual({
      flags: ['-y', '--yes'],
      arg: '',
      commands: ['init'],
    });
    expect(options.find((o) => o.flags.includes('--format'))?.commands).toEqual([
      'check',
      'inspect',
      'export',
    ]);
  });

  it('--help lists every option the parser accepts, and no other', () => {
    expect(options.flatMap((o) => o.flags).sort()).toEqual(parserFlags().sort());
  });

  it('has a section for every command --help lists, and for the options they share', () => {
    const usage = help.slice(help.indexOf('\nUsage\n'), help.indexOf('\nOptions\n'));
    const listed = [...usage.matchAll(/^ {2}onsystem (?:\[(\w+)\]|(\w+))/gm)].map(
      (m) => m[1] ?? m[2] ?? '',
    );
    expect(listed).toEqual([...COMMANDS, 'help']);
    for (const command of COMMANDS) expect(() => section(cli, `\`${command}\``)).not.toThrow();
    expect(() => section(cli, SHARED)).not.toThrow();
    // `help` is in the commands table at the top.
    expect(cli).toMatch(/^\| `onsystem help` +\|/m);
  });

  it('lists each option under every command --help gives it to, with its argument', () => {
    for (const option of options) {
      const sections = option.commands.length
        ? option.commands.map((command) => `\`${command}\``)
        : [SHARED];
      for (const heading of sections) {
        const rows = docRows(section(cli, heading));
        const row = rows.find((r) => key(r.flags) === key(option.flags));
        expect(row, `${option.flags.join(', ')} under "${heading}"`).toBeDefined();
        expect(row?.arg, `${option.flags.join(', ')} under "${heading}"`).toBe(option.arg);
      }
    }
  });

  it('lists no option that --help does not give to that command', () => {
    for (const heading of [...COMMANDS.map((c) => `\`${c}\``), SHARED]) {
      for (const row of docRows(section(cli, heading))) {
        const option = options.find((o) => key(o.flags) === key(row.flags));
        expect(option, `${row.flags.join(', ')} under "${heading}"`).toBeDefined();
        const expected = option?.commands.length
          ? option.commands.map((c) => `\`${c}\``)
          : [SHARED];
        expect(expected, `${row.flags.join(', ')} under "${heading}"`).toContain(heading);
      }
    }
  });

  it('runs inspect --format json, the value its row names', async () => {
    const out: string[] = [];
    const io: Io = { cwd: DEMO_ROOT, color: false, stdout: (t) => out.push(t), stderr: () => {} };
    expect(await main(['inspect', '--format', 'json', '--no-cache'], io)).toBe(0);
    const model = JSON.parse(out.join('\n')) as { components: { name: string }[] };
    expect(model.components.map((c) => c.name)).toContain('Button');
    expect(section(cli, '`inspect`')).toMatch(
      /^\| `--format <format>` +\| `pretty` \(the default\) or `json`/m,
    );
  });

  it('names every config file name the CLI looks for, as docs/configuration.md does', () => {
    for (const name of CONFIG_FILES) expect(cli).toContain(`\`${name}\``);
    // `onsystem.config.json` (or `.mjs`, `.js`, or `.ts` and `.mts` …) opens its Config file section.
    const configFile = section(read('docs/configuration.md'), 'Config file').split('\n\n')[1];
    for (const name of CONFIG_FILES) {
      const ext = name.replace(/^onsystem\.config/, '');
      expect(configFile, name).toMatch(new RegExp(`\`(?:onsystem\\.config)?\\${ext}\``));
    }
  });

  it('is linked from the quickstart', () => {
    expect(read('docs/quickstart.md')).toContain('](cli.md)');
  });
});

describe('the GitHub Action inputs (docs/required-check.md)', () => {
  it('lists every input of action.yml with its default, and no other', () => {
    // Read with a YAML parser, so an input with a multi-line description, or with `required`
    // before `default`, is not skipped.
    const action = parse(read('action.yml')) as {
      inputs: Record<string, { default?: string | number | boolean }>;
    };
    const inputs = Object.entries(action.inputs).map(([name, input]) => ({
      name,
      default: input.default === undefined ? '' : String(input.default),
    }));
    expect(inputs.map((i) => i.name)).toContain('only-changed-lines');
    const doc = read('docs/required-check.md');
    for (const input of inputs) {
      const row = new RegExp(`^\\| \`${input.name}\` +\\| ([^|]*?) +\\|`, 'm').exec(doc);
      expect(row, input.name).not.toBeNull();
      expect(row?.[1], input.name).toBe(input.default ? `\`${input.default}\`` : '');
    }
    // One row per input: none left behind by an input that is gone.
    const rows = [...section(doc, 'The workflow').matchAll(/^\| `([a-z-]+)` +\|/gm)].map(
      (m) => m[1] ?? '',
    );
    expect(rows.sort()).toEqual(inputs.map((i) => i.name).sort());
  });
});
