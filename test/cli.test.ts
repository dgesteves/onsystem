import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { CONFIG_FILES } from '../src/config.js';
import { VERSION } from '../src/version.js';
import { DEMO_ROOT, fixture } from './helpers.js';

async function run(args: string[], cwd = DEMO_ROOT, env?: Io['env']) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    cwd,
    color: false,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
    ...(env ? { env } : {}),
  };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

describe('onsystem check', () => {
  it('exits 1 and prints grouped diagnostics when there are errors', async () => {
    const { code, stdout } = await run(['check', 'app/**/*.tsx', '--no-cache']);
    expect(code).toBe(1);
    expect(stdout).toContain('app/settings/danger-zone.tsx');
    expect(stdout).toContain('18:25  error  "danger" is not a valid variant for <Button>.');
    expect(stdout).toContain('8 errors, 3 warnings in 1 of 2 files checked');
    expect(stdout).not.toContain('members.tsx');
  });

  it('expands directories to the TSX/JSX files under them', async () => {
    const { code, stdout } = await run(['check', 'app', '--no-cache']);
    expect(code).toBe(1);
    expect(stdout).toContain('in 1 of 2 files checked');
  });

  it('takes paths with glob characters literally (Next.js route groups and segments)', async () => {
    const button = '<button className="px-3">Go</button>';
    const root = fixture({
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
      'app/(marketing)/page.tsx': `export default () => ${button}`,
      'app/blog/[slug]/page.tsx': `export default () => ${button}`,
    });
    const { stdout } = await run(
      ['check', 'app/(marketing)', 'app/blog/[slug]/page.tsx', '--no-cache'],
      root,
    );
    expect(stdout).toContain('app/(marketing)/page.tsx');
    expect(stdout).toContain('app/blog/[slug]/page.tsx');
    expect(stdout).toContain('in 2 files');
  });

  it('reports editor columns for files with a byte-order mark', async () => {
    const root = fixture({
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
      'app/page.tsx': '\uFEFF<button>Go</button>',
    });
    const { stdout } = await run(['check', 'app/page.tsx', '--no-cache'], root);
    expect(stdout).toMatch(/^\s+1:2\s+error\s+Native <button>/m);
  });

  it('exits 0 on clean files', async () => {
    const { code, stdout } = await run(['check', 'app/settings/members.tsx', '--no-cache']);
    expect(code).toBe(0);
    expect(stdout).toBe('No problems in 1 file.');
  });

  it('emits GitHub Actions annotations', async () => {
    const { stdout } = await run(
      ['check', 'app/settings/danger-zone.tsx', '--format', 'github', '--no-cache'],
      DEMO_ROOT,
      {},
    );
    // Relative to the repository root, which GitHub resolves annotations against: the demo is
    // a folder of this repository.
    expect(stdout.split('\n')[0]).toBe(
      '::error file=examples/shadcn-demo/app/settings/danger-zone.tsx,line=11,col=22,endLine=11,endColumn=38,title=no-hardcoded-color::Hardcoded color `border-[#ef4444]`. Nearest token destructive (ΔE 0.071) → `border-destructive`.',
    );
  });

  it('emits JSON and enforces --max-warnings', async () => {
    const json = await run([
      'check',
      'app/settings/danger-zone.tsx',
      '--format',
      'json',
      '--no-cache',
    ]);
    const results = JSON.parse(json.stdout) as { errorCount: number }[];
    expect(results[0]?.errorCount).toBe(8);

    const warnOnly = await run([
      'check',
      'app/settings/danger-zone.tsx',
      '--no-cache',
      '--config',
      path.join(import.meta.dirname, 'fixtures/warn-only.config.json'),
      '--root',
      DEMO_ROOT,
      '--max-warnings',
      '0',
    ]);
    expect(warnOnly.code).toBe(1);
    expect(warnOnly.stderr).toContain('Too many warnings');
  });

  it.each(['github', 'json', 'sarif'])(
    'explains a failed warning cap with --format %s',
    async (format) => {
      const { code, stdout, stderr } = await run([
        'check',
        'app/settings/danger-zone.tsx',
        '--no-cache',
        '--config',
        path.join(import.meta.dirname, 'fixtures/warn-only.config.json'),
        '--root',
        DEMO_ROOT,
        '--max-warnings',
        '0',
        '--format',
        format,
      ]);
      const message = 'Too many warnings (11, max 0).';
      expect(code).toBe(1);
      if (format === 'github') {
        expect(stdout).toContain(`::error title=onsystem::${message}`);
        expect(stderr).toBe('');
      } else {
        expect(stderr).toBe(message);
        const output = JSON.parse(stdout) as unknown;
        if (format === 'json') {
          expect(output).toEqual([expect.objectContaining({ errorCount: 0, warningCount: 11 })]);
        } else {
          expect(output).toMatchObject({ version: '2.1.0' });
        }
      }
    },
  );

  it('does not report a failed cap when the warning count equals the limit', async () => {
    for (const format of ['pretty', 'github', 'json', 'sarif']) {
      const { code, stdout, stderr } = await run([
        'check',
        'app/settings/danger-zone.tsx',
        '--no-cache',
        '--config',
        path.join(import.meta.dirname, 'fixtures/warn-only.config.json'),
        '--root',
        DEMO_ROOT,
        '--max-warnings',
        '11',
        '--format',
        format,
      ]);
      expect(code).toBe(0);
      expect(stdout + stderr).not.toContain('Too many warnings');
    }
  });

  it('reports usage errors with exit code 2', async () => {
    expect((await run(['check'])).code).toBe(2);
    expect((await run(['check', 'nope/**/*.tsx'])).stderr).toContain('no files match');
    expect((await run(['check', 'x.tsx', '--format', 'xml'])).code).toBe(2);
    expect((await run(['inspect', '--format', 'xml'])).code).toBe(2);
    expect((await run(['frobnicate'])).code).toBe(2);
    expect((await run(['--bogus'])).code).toBe(2);
  });
});

/** An app in apps/web of `root`: one native <button> where the design system has <Button>. */
function appIn(root: string) {
  const web = path.join(root, 'apps/web');
  fs.mkdirSync(path.join(web, 'components/ui'), { recursive: true });
  fs.mkdirSync(path.join(web, 'app'), { recursive: true });
  fs.writeFileSync(path.join(web, 'package.json'), '{ "name": "web" }');
  fs.writeFileSync(
    path.join(web, 'components/ui/button.tsx'),
    'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
  );
  fs.writeFileSync(path.join(web, 'app/page.tsx'), 'export default () => <button>Go</button>;\n');
  return web;
}

function gitInit(dir: string) {
  const result = spawnSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q'], { cwd: dir });
  if (result.status !== 0) throw new Error(`git init failed in ${dir}`);
}

/** The file each finding is reported in, in the given format. */
async function reportedFiles(format: 'github' | 'sarif', cwd: string, env: Io['env']) {
  const { stdout } = await run(['check', 'app', '--format', format, '--no-cache'], cwd, env);
  if (format === 'github') {
    return [...stdout.matchAll(/^::error file=([^,]+),/gm)].map((m) => m[1]);
  }
  const log = JSON.parse(stdout) as {
    runs: {
      results: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }[];
    }[];
  };
  return (log.runs[0]?.results ?? []).map(
    (r) => r.locations[0]?.physicalLocation.artifactLocation.uri,
  );
}

describe.each(['github', 'sarif'] as const)(
  'check --format %s from a folder of the repository',
  (format) => {
    it('names files from the git top-level, wherever check runs', async () => {
      const root = fixture({});
      gitInit(root);
      const web = appIn(root);
      expect(await reportedFiles(format, web, {})).toEqual(['apps/web/app/page.tsx']);
    });

    it('names files from GITHUB_WORKSPACE without git', async () => {
      // No repository: a checkout without git, or a container where git refuses the folder.
      const root = fixture({});
      const web = appIn(root);
      expect(await reportedFiles(format, web, { GITHUB_WORKSPACE: root })).toEqual([
        'apps/web/app/page.tsx',
      ]);
      // Neither: relative to the working directory, as before.
      expect(await reportedFiles(format, web, {})).toEqual(['app/page.tsx']);
    });

    it('names files from a repository checked out in a folder of the workspace', async () => {
      // actions/checkout with `path: repo`: the repository root is GITHUB_WORKSPACE/repo.
      const workspace = fixture({});
      const repo = path.join(workspace, 'repo');
      fs.mkdirSync(repo);
      gitInit(repo);
      const web = appIn(repo);
      expect(await reportedFiles(format, web, { GITHUB_WORKSPACE: workspace })).toEqual([
        'apps/web/app/page.tsx',
      ]);
    });

    it('keeps paths relative to the working directory for files outside the repository', async () => {
      const web = appIn(fixture({}));
      expect(await reportedFiles(format, web, { GITHUB_WORKSPACE: fixture({}) })).toEqual([
        'app/page.tsx',
      ]);
    });
  },
);

describe('check --format pretty from a folder of the repository', () => {
  it('keeps paths relative to the working directory', async () => {
    const root = fixture({});
    gitInit(root);
    const web = appIn(root);
    const { stdout } = await run(['check', 'app', '--no-cache'], web, { GITHUB_WORKSPACE: root });
    expect(stdout.split('\n')[0]).toBe('app/page.tsx');
  });
});

describe("onsystem check and the design system's own files", () => {
  it('skips them unless asked, and says so', async () => {
    const all = await run(['check', '.', '--no-cache']);
    expect(all.stdout.split('\n').at(-1)).toBe(
      '8 errors, 3 warnings in 1 of 2 files checked (5 design-system files skipped)',
    );
    const included = await run(['check', '.', '--include-design-system', '--no-cache']);
    expect(included.stdout).toContain('in 1 of 7 files checked');
  });

  it('leaves out tests, stories, excluded files and what git ignores, unless named', async () => {
    const button = '<button className="px-3">Go</button>';
    const root = fixture({
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
      'onsystem.config.json': JSON.stringify({
        exclude: ['**/*.{test,spec,stories}.{ts,tsx,js,jsx}', 'app/legacy/**'],
      }),
      '.gitignore': 'dist/\n',
      'app/page.tsx': `export default () => ${button}`,
      'app/page.test.tsx': `export default () => ${button}`,
      'app/button.stories.tsx': `export default () => ${button}`,
      'app/legacy/old.tsx': `export default () => ${button}`,
      'dist/page.tsx': `export default () => ${button}`,
    });
    spawnSync('git', ['init', '-q'], { cwd: root });
    const { stdout } = await run(['check', '.', '--no-cache'], root);
    expect(stdout).toContain('app/page.tsx');
    for (const file of ['page.test.tsx', 'button.stories.tsx', 'legacy/old.tsx', 'dist/page.tsx']) {
      expect(stdout).not.toContain(file);
    }
    expect(stdout.split('\n').find((line) => /^\d+ errors?,/.test(line))).toBe(
      '1 error, 0 warnings in 1 file (1 design-system file skipped; 2 tests and stories left out; 1 excluded file left out; 1 file git ignores left out)',
    );
    const tests = await run(['check', '.', '--include-tests', '--no-cache'], root);
    expect(tests.stdout).toContain('app/page.test.tsx');
    expect(tests.stdout).toContain('app/button.stories.tsx');
    expect(tests.stdout).not.toContain('legacy/old.tsx');
    // A file named outright is checked whatever the excludes say.
    const named = await run(
      ['check', 'app/button.stories.tsx', 'dist/page.tsx', '--no-cache'],
      root,
    );
    expect(named.stdout).toContain('app/button.stories.tsx');
    expect(named.stdout).toContain('dist/page.tsx');
    // Only tests in the folder: nothing to check, and how to check them.
    fs.rmSync(path.join(root, 'app/page.tsx'));
    const none = await run(['check', 'app', '--no-cache'], root);
    expect(none).toMatchObject({ code: 0 });
    expect(none.stdout).toBe(
      'Nothing to check: 2 tests and stories left out; 1 excluded file left out. Pass --include-tests to check tests and stories.',
    );
  });

  it('leaves out folders of tests, stories and mocks by default', async () => {
    const button = '<button className="px-3">Go</button>';
    const root = fixture({
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
      'src/page.tsx': `export default () => ${button}`,
      // Twenty keeps story helpers in __stories__ under names that are not *.stories.tsx.
      'src/__stories__/ToastControls.tsx': `export default () => ${button}`,
      'src/__tests__/render.tsx': `export default () => ${button}`,
      'src/__mocks__/button.tsx': `export default () => ${button}`,
    });
    const { stdout } = await run(['check', '.', '--no-cache'], root);
    expect(stdout.split('\n').find((line) => /^\d+ errors?,/.test(line))).toBe(
      '1 error, 0 warnings in 1 file (1 design-system file skipped; 3 tests and stories left out)',
    );
    const tests = await run(['check', '.', '--include-tests', '--no-cache'], root);
    expect(tests.stdout).toContain('src/__stories__/ToastControls.tsx');
  });

  it('counts the image and email files it did not check', async () => {
    const root = fixture({
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
      'app/page.tsx': 'export default () => <button>Go</button>',
      'app/opengraph-image.tsx': 'export default () => <div style={{ background: "#000" }} />',
    });
    const { stdout } = await run(['check', 'app', '--no-cache'], root);
    expect(stdout).not.toContain('opengraph-image');
    expect(stdout.split('\n').find((line) => /^\d+ errors?,/.test(line))).toBe(
      '1 error, 0 warnings in 1 file (1 image or email file not checked)',
    );
    const json = await run(['check', 'app', '--format', 'json', '--no-cache'], root);
    expect(
      (JSON.parse(json.stdout) as { file: string; skipped?: string }[]).map((r) => [
        r.file,
        Boolean(r.skipped),
      ]),
    ).toEqual([
      ['app/opengraph-image.tsx', true],
      ['app/page.tsx', false],
    ]);
  });

  it('exits 0 when only design-system files match, with [] for the hook', async () => {
    expect(await run(['check', 'components/ui/button.tsx', '--no-cache'])).toEqual({
      code: 0,
      stdout:
        'Nothing to check: 1 design-system file skipped. Pass --include-design-system to check it.',
      stderr: '',
    });
    // The Claude Code hook's call: an edit to the design system itself is not linted.
    const hook = await run([
      'check',
      'components/ui/button.tsx',
      '--format',
      'json',
      '--quiet-without-design-system',
      '--no-cache',
    ]);
    expect(hook).toMatchObject({ code: 0, stdout: '[]' });
  });

  it('reads includeDesignSystem from the config', async () => {
    const root = fixture({
      'onsystem.config.json': '{ "includeDesignSystem": true }',
      'app/globals.css': '@import "tailwindcss";',
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button className="p-[3px]" {...props} /> }',
    });
    const { stdout } = await run(['check', '.', '--no-cache'], root);
    expect(stdout).toContain('components/ui/button.tsx');
    expect(stdout).toContain('`p-[3px]`');
  });
});

describe('onsystem without a design system', () => {
  const plain = () =>
    fixture({
      'package.json': '{ "name": "plain" }',
      'src/App.tsx': 'export const App = () => <button><svg /></button>',
    });
  const NOTICE =
    'No design system found (no components or color tokens): only the accessibility rule ran. See https://onsystem.vercel.app/docs/configuration';

  it('says that only the accessibility rule ran, in every format', async () => {
    const root = plain();
    const pretty = await run(['check', '.', '--no-cache'], root);
    expect(pretty.code).toBe(1);
    expect(pretty.stdout.split('\n').at(-1)).toBe(NOTICE);
    const json = await run(['check', '.', '--format', 'json', '--no-cache'], root);
    expect(JSON.parse(json.stdout)).toHaveLength(1);
    expect(json.stderr).toBe(NOTICE);
    const github = await run(['check', '.', '--format', 'github', '--no-cache'], root);
    expect(github.stdout.split('\n').at(-1)).toBe(`::warning title=onsystem::${NOTICE}`);
  });

  it('says once, for all files, which components it could not check', async () => {
    const root = fixture({
      'onsystem.config.json': '{ "exclude": ["**/icons/**"] }',
      'tsconfig.json': JSON.stringify({
        compilerOptions: { jsx: 'react-jsx', paths: { '@/*': ['./*'] } },
      }),
      'components/ui/button.tsx':
        'export function Button(props: { children?: string }) { return <button>{props.children}</button> }',
      'components/ui/icons/index.tsx': 'export function Spinner() { return <svg /> }',
      'app/a.tsx':
        'import { Spinner } from "@/components/ui/icons"\nexport default () => <Spinner />',
      'app/b.tsx':
        'import { Spinner } from "@/components/ui/icons"\nexport default () => <Spinner />',
    });
    const notice =
      '<Spinner> comes from "@/components/ui/icons", which the design-system model does not include, so it was not checked (in 2 files).';
    const pretty = await run(['check', 'app', '--no-cache'], root);
    expect(pretty.code).toBe(0);
    expect(pretty.stdout.split(notice)).toHaveLength(2);
    const github = await run(['check', 'app', '--no-cache', '--format', 'github'], root);
    expect(github.stdout).toContain(`::warning title=onsystem::${notice}`);
    const json = await run(['check', 'app', '--no-cache', '--format', 'json'], root);
    expect((JSON.parse(json.stdout) as { unchecked?: unknown }[])[0]?.unchecked).toEqual({
      names: ['Spinner'],
      modules: ['@/components/ui/icons'],
    });
    expect(json.stderr).toContain(notice);
  });

  it('applies config overrides by path, and keeps baseline entries of rules they turn off', async () => {
    const page = 'export default () => <div className="bg-[#ef4444]"><button>Go</button></div>';
    const root = fixture({
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
      'app/globals.css': ':root { --destructive: #ef4444; }',
      'app/page.tsx': page,
      'app/legacy/card.tsx': page,
    });
    const before = await run(['check', 'app', '--update-baseline', '--no-cache'], root);
    expect(before.stdout).toMatch(/^Baseline: 4 findings in 2 files/);
    fs.writeFileSync(
      path.join(root, 'onsystem.config.json'),
      JSON.stringify({
        tokens: ['app/globals.css'],
        overrides: [{ files: ['app/legacy/**'], rules: { 'no-hardcoded-color': 'off' } }],
      }),
    );
    const all = await run(
      ['check', 'app', '--ignore-baseline', '--no-cache', '--format', 'json'],
      root,
    );
    const findings = (
      JSON.parse(all.stdout) as { file: string; diagnostics: { ruleId: string }[] }[]
    ).map((r) => [r.file, r.diagnostics.map((d) => d.ruleId)]);
    expect(findings).toEqual([
      ['app/legacy/card.tsx', ['prefer-design-system-component']],
      ['app/page.tsx', ['no-hardcoded-color', 'prefer-design-system-component']],
    ]);
    // The legacy file's color entry is not reported as fixed: the rule is off there, not passing.
    const withBaseline = await run(['check', 'app', '--no-cache'], root);
    expect(withBaseline.stdout).not.toContain('no longer');
  });

  it('fails with --require-design-system, and names what is missing', async () => {
    expect(await run(['check', '.', '--require-design-system', '--no-cache'], plain())).toEqual({
      code: 2,
      stdout: '',
      stderr: `check --require-design-system: ${NOTICE}`,
    });
    const noColors = fixture({
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
      'app/page.tsx': 'export default () => <p>Hi</p>',
    });
    const partial = await run(['check', 'app', '--require-design-system', '--no-cache'], noColors);
    expect(partial.code).toBe(2);
    expect(partial.stderr).toContain('No color tokens found: no-hardcoded-color did not run.');
    expect(
      (await run(['check', 'app', '--require-design-system', '--quiet-without-design-system']))
        .code,
    ).toBe(2);
  });
});

describe('onsystem errors and help', () => {
  it('reports a missing root in one line with exit code 2, for check and inspect', async () => {
    for (const args of [['check', '.'], ['inspect']]) {
      const { code, stdout, stderr } = await run([...args, '--root', '/nope/not-here']);
      expect({ code, stdout, stderr }).toEqual({
        code: 2,
        stdout: '',
        stderr: `Project root not found: ${path.resolve('/nope/not-here')}`,
      });
    }
  });

  it('falls back from an unexpanded ${workspaceFolder} root to the working directory', async () => {
    const { code, stderr } = await run([
      'check',
      'app/settings/members.tsx',
      '--root',
      '${workspaceFolder}',
      '--no-cache',
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe(
      '--root "${workspaceFolder}" holds a variable the client did not expand; using the working directory instead.',
    );
  });

  it('names a missing token file', async () => {
    const { code, stderr } = await run(['check', 'app', '--tokens', 'app/theme.css', '--no-cache']);
    expect(code).toBe(2);
    expect(stderr).toBe(
      `Token file not found: ${path.join(DEMO_ROOT, 'app/theme.css')} (from --tokens)`,
    );
  });

  it('prints help for `help` as for --help, with the detected component default', async () => {
    const help = await run(['help']);
    expect(help).toEqual({ ...(await run(['--help'])), code: 0 });
    expect(help.stdout).toContain('found through\n                          components.json');
  });
});

describe('onsystem check with a baseline', () => {
  const BUTTON =
    'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }';
  const project = () =>
    fixture({
      'components/ui/button.tsx': BUTTON,
      'components/ui/input.tsx':
        'export function Input(props: React.ComponentProps<"input">) { return <input {...props} /> }',
      'app/a.tsx': 'export const A = () => <><button>One</button><button>Two</button></>',
      'app/b.tsx': 'export const B = () => <input />',
      'app/c.tsx': 'export const C = () => <p>Fine</p>',
      'app/globals.css': ':root { --primary: oklch(0.205 0 0); }',
    });
  const baselineOf = (root: string) =>
    JSON.parse(fs.readFileSync(path.join(root, 'onsystem.baseline.json'), 'utf8')) as {
      files: Record<string, Record<string, Record<string, number>>>;
    };

  it('records the current findings, keyed from the root, and then reports only new ones', async () => {
    const root = project();
    // Run from a subdirectory: keys stay relative to the root.
    const recorded = await run(
      ['check', '.', '--update-baseline', '--root', '..', '--no-cache'],
      path.join(root, 'app'),
    );
    expect(recorded.code).toBe(0);
    expect(recorded.stdout).toBe(
      `Baseline: 3 findings in 2 files → ${path.join(root, 'onsystem.baseline.json')}`,
    );
    expect(baselineOf(root).files).toEqual({
      'app/a.tsx': { 'prefer-design-system-component': { button: 2 } },
      'app/b.tsx': { 'prefer-design-system-component': { input: 1 } },
    });

    const clean = await run(['check', 'app', '--no-cache'], root);
    expect(clean).toMatchObject({
      code: 0,
      stdout: 'No new problems in 3 files (3 in the baseline).',
    });

    // A third <button> exceeds the count for that source; the rest still match after moving lines.
    fs.writeFileSync(
      path.join(root, 'app/a.tsx'),
      'export const A = () => (\n  <>\n    <button>One</button><button>Two</button><button>Three</button>\n  </>\n)',
    );
    const added = await run(['check', 'app', '--no-cache'], root);
    expect(added.code).toBe(1);
    expect(added.stdout).toMatch(/app\/a\.tsx\n\s+3:46\s+error\s+Native <button>/);
    expect(added.stdout).toContain(
      '1 error, 0 warnings in 1 of 3 files checked (3 in the baseline)',
    );

    const all = await run(['check', 'app', '--no-cache', '--ignore-baseline'], root);
    expect(all.stdout).toContain('4 errors, 0 warnings in 2 of 3 files checked');
    expect(all.stdout).not.toContain('baseline');
  });

  it('points out fixed findings and drops them, and deleted files, on update', async () => {
    const root = project();
    await run(['check', 'app', '--update-baseline', '--no-cache'], root);
    fs.writeFileSync(path.join(root, 'app/a.tsx'), 'export const A = () => <button>One</button>');
    fs.rmSync(path.join(root, 'app/b.tsx'));

    const { code, stdout } = await run(['check', 'app/a.tsx', '--no-cache'], root);
    expect(code).toBe(0);
    expect(stdout.split('\n')).toEqual([
      'No new problems in 1 file (1 in the baseline).',
      '1 baseline finding no longer occurs: run `check app/a.tsx --prune-baseline` to drop it.',
    ]);
    const github = await run(['check', 'app/a.tsx', '--no-cache', '--format', 'github'], root);
    expect(github.stdout).toBe(
      '::notice title=onsystem baseline::1 baseline finding no longer occurs: run `check app/a.tsx --prune-baseline` to drop it.',
    );

    // Only a.tsx is checked: its entry shrinks, b.tsx is gone from disk and is dropped.
    await run(['check', 'app/a.tsx', '--update-baseline', '--no-cache'], root);
    expect(baselineOf(root).files).toEqual({
      'app/a.tsx': { 'prefer-design-system-component': { button: 1 } },
    });
  });

  it('keeps entries of files a partial update does not check, and filters JSON output', async () => {
    const root = project();
    await run(['check', 'app', '--update-baseline', '--no-cache'], root);
    await run(['check', 'app/c.tsx', '--update-baseline', '--no-cache'], root);
    expect(Object.keys(baselineOf(root).files)).toEqual(['app/a.tsx', 'app/b.tsx']);

    const { stdout } = await run(['check', 'app', '--no-cache', '--format', 'json'], root);
    const results = JSON.parse(stdout) as {
      file: string;
      diagnostics: unknown[];
      baselined: number;
    }[];
    expect(results.map((r) => [r.file, r.diagnostics.length, r.baselined])).toEqual([
      ['app/a.tsx', 0, 2],
      ['app/b.tsx', 0, 1],
      ['app/c.tsx', 0, 0],
    ]);
  });

  it('rejects a missing or malformed baseline file', async () => {
    const root = project();
    const missing = await run(['check', 'app', '--baseline', 'nope.json', '--no-cache'], root);
    expect(missing).toMatchObject({ code: 2, stderr: 'check: baseline not found: nope.json' });
    fs.writeFileSync(path.join(root, 'onsystem.baseline.json'), '{"files": []}');
    const malformed = await run(['check', 'app', '--no-cache'], root);
    expect(malformed.code).toBe(2);
    expect(malformed.stderr).toContain('is not a valid onsystem baseline');

    // Every level is checked, and an update refuses to overwrite what it cannot read.
    for (const files of [
      { 'app/a.tsx': { 'prefer-design-system-component': null } },
      { 'app/a.tsx': { 'prefer-design-system-component': { button: '1' } } },
      { 'app/a.tsx': { 'prefer-design-system-component': { button: 0.5 } } },
    ]) {
      fs.writeFileSync(
        path.join(root, 'onsystem.baseline.json'),
        JSON.stringify({ version: 1, files }),
      );
      for (const extra of [[], ['--update-baseline']]) {
        const run_ = await run(['check', 'app', '--no-cache', ...extra], root);
        expect(run_.code).toBe(2);
        expect(run_.stderr).toContain('is not a valid onsystem baseline');
      }
    }

    // A missing folder is created; one that is a file cannot be.
    const unwritable = await run(
      ['check', 'app', '--no-cache', '--update-baseline', '--baseline', 'app/a.tsx/b.json'],
      root,
    );
    expect(unwritable.code).toBe(2);
    expect(unwritable.stderr).toContain('Could not write baseline');
  });

  it('keeps keys that look like Object.prototype members as plain entries', async () => {
    const root = fixture({
      'components/ui/badge.tsx':
        'export function Badge(props: { variant?: "default" | "outline" }) { return <span /> }',
      'app/p.tsx':
        'export const P = () => <><Badge toString constructor valueOf="x" hasOwnProperty __proto__ /></>\nimport { Badge } from "../components/ui/badge"',
      'app/globals.css': ':root { --primary: oklch(0.205 0 0); }',
    });
    const recorded = await run(['check', 'app', '--update-baseline', '--no-cache'], root);
    expect(recorded.stdout).toMatch(/^Baseline: 5 findings in 1 file → /);
    expect(baselineOf(root).files['app/p.tsx']?.['no-unknown-prop']).toEqual(
      JSON.parse('{"__proto__":1,"constructor":1,"hasOwnProperty":1,"toString":1,"valueOf":1}'),
    );
    expect(await run(['check', 'app', '--no-cache'], root)).toMatchObject({
      code: 0,
      stdout: 'No new problems in 1 file (5 in the baseline).',
    });
  });

  it('matches through a linked root, keeps entries of disabled rules, and ignores quote style', async () => {
    const root = fixture({
      'components/ui/button.tsx':
        'export function Button(props: { variant?: "default" | "destructive" } & React.ComponentProps<"button">) { return <button {...props} /> }',
      'app/a.tsx':
        'import { Button } from "../components/ui/button"\nexport const A = () => <><button>x</button><Button variant="danger" /></>',
      'app/globals.css': ':root { --primary: oklch(0.205 0 0); }',
    });
    const link = `${root}-link`;
    fs.symlinkSync(root, link);
    try {
      await run(['check', 'app', '--update-baseline', '--no-cache'], root);
      // Through the link, from a cwd elsewhere: the same keys.
      const linked = await run(
        ['check', path.join(link, 'app'), '--root', link, '--no-cache'],
        '/',
      );
      expect(linked).toMatchObject({
        code: 0,
        stdout: 'No new problems in 1 file (2 in the baseline).',
      });

      fs.writeFileSync(
        path.join(root, 'app/a.tsx'),
        fs.readFileSync(path.join(root, 'app/a.tsx'), 'utf8').replace('"danger"', "'danger'"),
      );
      expect((await run(['check', 'app', '--no-cache'], root)).code).toBe(0);

      fs.writeFileSync(
        path.join(root, 'onsystem.config.json'),
        JSON.stringify({ rules: { 'prefer-design-system-component': 'off' } }),
      );
      // Off is not fixed: no hint, and an update keeps the entry for when the rule returns.
      expect((await run(['check', 'app', '--no-cache'], root)).stdout).toBe(
        'No new problems in 1 file (1 in the baseline).',
      );
      await run(['check', 'app', '--update-baseline', '--no-cache'], root);
      expect(baselineOf(root).files['app/a.tsx']).toEqual({
        'no-unknown-variant': { danger: 1 },
        'prefer-design-system-component': { button: 1 },
      });
    } finally {
      fs.rmSync(link);
    }
  });
});

describe('onsystem and the names from before the rename', () => {
  const files = {
    'components/ui/button.tsx':
      'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
    'app/a.tsx': 'export const A = () => <button>One</button>',
    'app/globals.css': ':root { --primary: oklch(0.205 0 0); }',
  };

  it('reads design-system-mcp.config.json and says once how to rename it', async () => {
    const root = fixture({
      ...files,
      'design-system-mcp.config.json': '{ "rules": { "prefer-design-system-component": "warn" } }',
    });
    const notice =
      "design-system-mcp.config.json is the config's name from before design-system-mcp became onsystem. Rename it to onsystem.config.json (git mv design-system-mcp.config.json onsystem.config.json); the old name still works for now.";
    const pretty = await run(['check', 'app', '--no-cache'], root);
    expect(pretty.code).toBe(0);
    expect(pretty.stdout).toContain('1 warning');
    expect(pretty.stderr).toBe(notice);
    // JSON stays parseable; GitHub gets a warning annotation.
    const json = await run(['check', 'app', '--format', 'json', '--no-cache'], root);
    expect(JSON.parse(json.stdout)).toHaveLength(1);
    expect(json.stderr).toBe(notice);
    const github = await run(['check', 'app', '--format', 'github', '--no-cache'], root);
    expect(github.stdout.split('\n')[0]).toBe(`::warning title=onsystem::${notice}`);
    expect((await run(['inspect', '--no-cache'], root)).stderr).toBe(notice);
  });

  it('reads and updates design-system-mcp.baseline.json where it is, until it is renamed', async () => {
    const root = fixture(files);
    const legacy = path.join(root, 'design-system-mcp.baseline.json');
    const notice =
      "design-system-mcp.baseline.json is the baseline's name from before design-system-mcp became onsystem. Rename it to onsystem.baseline.json (git mv design-system-mcp.baseline.json onsystem.baseline.json); the old name still works for now.";
    expect((await run(['check', 'app', '--update-baseline', '--no-cache'], root)).code).toBe(0);
    fs.renameSync(path.join(root, 'onsystem.baseline.json'), legacy);

    const read = await run(['check', 'app', '--no-cache'], root);
    expect(read).toMatchObject({
      code: 0,
      stdout: 'No new problems in 1 file (1 in the baseline).',
      stderr: notice,
    });
    const updated = await run(['check', 'app', '--update-baseline', '--no-cache'], root);
    expect(updated.stdout).toBe('Baseline: 1 finding in 1 file → design-system-mcp.baseline.json');
    expect(fs.existsSync(path.join(root, 'onsystem.baseline.json'))).toBe(false);
    expect((await run(['check', 'app', '--ignore-baseline', '--no-cache'], root)).stderr).toBe('');

    // Once renamed, a leftover copy under the old name is called out and not read.
    fs.copyFileSync(legacy, path.join(root, 'onsystem.baseline.json'));
    fs.writeFileSync(legacy, '{"files": []}');
    expect(await run(['check', 'app', '--no-cache'], root)).toMatchObject({
      code: 0,
      stderr:
        'design-system-mcp.baseline.json is ignored: onsystem.baseline.json is read instead. Delete design-system-mcp.baseline.json.',
    });
  });
});
describe('onsystem check --quiet-without-design-system', () => {
  const page =
    'export default () => <div className="p-[13px] rounded-[7px] bg-[#ef4444]"><button>Go</button></div>';

  it('stays quiet in a React app with no design system, even with Tailwind', async () => {
    const root = fixture({ 'app/globals.css': '@import "tailwindcss";\n', 'app/page.tsx': page });
    // Without the flag, Tailwind's default scale alone still produces findings.
    expect((await run(['check', 'app', '--no-cache'], root)).stdout).toContain(
      'no-hardcoded-spacing',
    );
    expect(
      await run(['check', 'app', '--no-cache', '--quiet-without-design-system'], root),
    ).toEqual({
      code: 0,
      stdout: '',
      stderr: '',
    });
    expect(
      (
        await run(
          ['check', 'app', '--no-cache', '--quiet-without-design-system', '--format', 'json'],
          root,
        )
      ).stdout,
    ).toBe('[]');
  });

  it('stays quiet with tokens but no components, as in an app styled with CSS-in-JS', async () => {
    // twenty: three stray custom properties and no components made the hook block Claude.
    const root = fixture({
      'src/index.css': ':root { --accent: #1961ed; --line: #ebebeb; --bg: #fcfcfc; }\n',
      'app/page.tsx': page,
    });
    expect(
      await run(['check', 'app', '--no-cache', '--quiet-without-design-system'], root),
    ).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('still checks projects with components or a config', async () => {
    const withComponents = fixture({
      'components/ui/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
      'app/page.tsx': page,
    });
    const withConfig = fixture({
      'onsystem.config.json': JSON.stringify({ tokens: ['app/globals.css'] }),
      'app/globals.css': '@import "tailwindcss";\n',
      'app/page.tsx': page,
    });
    for (const root of [withComponents, withConfig]) {
      const { stdout } = await run(
        ['check', 'app', '--no-cache', '--quiet-without-design-system'],
        root,
      );
      // The config only names Tailwind's defaults: warnings, but still reported.
      expect(stdout).toMatch(/\d+ errors?, \d+ warnings? in 1 file/);
    }
  });
});

describe('onsystem inspect, --help, --version', () => {
  it('summarises what was extracted', async () => {
    const { code, stdout } = await run(['inspect', '--no-cache']);
    expect(code).toBe(0);
    expect(stdout).toMatch(/Components \(5 \+ 15 parts\)/);
    expect(stdout).toMatch(
      /Button\s+<button> · 3 props · variant\[6\] size\[4\] · docs · 4 examples/,
    );
    expect(stdout).toMatch(/color\s+20/);
  });

  it('prints help and version', async () => {
    expect((await run(['--help'])).stdout).toContain('onsystem check <paths...>');
    expect((await run(['-v'])).stdout).toBe(VERSION);
  });

  it('names every config file extension in --help', async () => {
    const { stdout } = await run(['--help']);
    const listed = /onsystem\.config\.\{([^}]+)\}/.exec(stdout)?.[1]?.split(',');
    const extensions = CONFIG_FILES.map((name) => name.slice('onsystem.config.'.length));
    expect([...(listed ?? [])].sort()).toEqual([...extensions].sort());
  });

  it('rejects an unknown --format, in a project and at a monorepo root', async () => {
    const monorepo = fixture({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n',
      'package.json': '{ "name": "acme", "private": true }',
    });
    appIn(monorepo);
    for (const cwd of [DEMO_ROOT, monorepo]) {
      const { code, stdout, stderr } = await run(['inspect', '--format', 'xml', '--no-cache'], cwd);
      expect(code).toBe(2);
      expect(stderr).toBe('inspect: unknown --format "xml" (pretty, json)');
      expect(stdout).toBe('');
    }
  });
});

describe('onsystem with no command', () => {
  /** Serves over an in-memory transport, as stdio would, with stdin a terminal or not. */
  async function serve(stdinIsTTY: boolean) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const err: string[] = [];
    const io: Io = {
      cwd: DEMO_ROOT,
      color: false,
      stdout: () => undefined,
      stderr: (t) => err.push(t),
      stdinIsTTY,
      transport: serverSide,
    };
    const code = await main(['--no-watch', '--no-cache'], io);
    const client = new Client({ name: 'terminal', version: '1.0.0' });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    await client.close();
    return { code, stderr: err.join('\n'), tools: tools.length };
  }

  it('says what it is on stderr when started in a terminal, then serves as usual', async () => {
    const terminal = await serve(true);
    expect(terminal.code).toBe(0);
    expect(terminal.tools).toBe(5);
    expect(terminal.stderr.split('\n')).toEqual([
      expect.stringMatching(
        /^onsystem is an MCP server: it is waiting for an agent on stdin\. Add it to your agent \(https:\/\/\S+\/docs\/clients\), or run `npx -y onsystem inspect` or `npx -y onsystem check \.` here\. Ctrl\+C quits\.$/,
      ),
    ]);
  });

  it('prints nothing when an MCP client starts it, its stdin a pipe', async () => {
    const piped = await serve(false);
    expect(piped.code).toBe(0);
    expect(piped.tools).toBe(5);
    expect(piped.stderr).toBe('');
  });
});
