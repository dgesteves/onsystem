import fs from 'node:fs';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { DEFAULT_EXCLUDE, RULE_IDS } from '../src/config.js';
import { createServer } from '../src/server/index.js';
import { fixture, load, TSCONFIG } from './helpers.js';
import { blocks, section } from './markdown.js';

// docs/configuration.md#code-from-shadcn-registries: what to do with the folders `npx shadcn add`
// fills from other registries. A shadcn/ui app with signoff-ui's and AI Elements' folders is
// checked with the configs the section gives, as they are written there, and with the `exclude`
// it advises against, for each thing the section says about them.

const docsDir = path.join(import.meta.dirname, '../docs');
const configuration = fs.readFileSync(path.join(docsDir, 'configuration.md'), 'utf8');

/** The section's JSON configs, in order. */
function configs(): Record<string, unknown>[] {
  return blocks(section(configuration, 'Code from shadcn registries'), 'json').map(
    (json) => JSON.parse(json) as Record<string, unknown>,
  );
}

const stock = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures/shadcn-neutral/globals.css'),
  'utf8',
);

const DIFF_REVIEW = 'components/signoff-ui/diff-review.tsx';
const PRIMITIVES = 'components/signoff-ui/lib/primitives.tsx';
const MESSAGE = 'components/ai-elements/message.tsx';
const STORY = 'app/page.stories.tsx';

/** A shadcn/ui app with two registries' folders, as `npx shadcn add` leaves them. */
function app(config?: Record<string, unknown>): string {
  return fixture({
    'components.json': JSON.stringify({
      style: 'new-york',
      tsx: true,
      tailwind: { css: 'app/globals.css' },
      aliases: { components: '@/components', ui: '@/components/ui', utils: '@/lib/utils' },
    }),
    'tsconfig.json': TSCONFIG,
    'app/globals.css': stock,
    'components/ui/button.tsx':
      'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }',
    [DIFF_REVIEW]: `import { Img } from "./lib/primitives"

export interface DiffReviewProps { files: string[]; onAccept?: () => void }

/** Review an agent's file changes, hunk by hunk. */
export function DiffReview({ files, onAccept }: DiffReviewProps) {
  return (
    <div className="rounded-[7px]">
      <Img src="/avatar.png" alt="" />
      <button className="bg-[#123456] px-3" onClick={onAccept}>Accept {files.length}</button>
    </div>
  )
}
`,
    [PRIMITIVES]:
      'export function Img(props: React.ComponentProps<"img">) { return <img className="rounded-[7px]" {...props} /> }',
    [MESSAGE]: `/** A chat message. */
export function Message({ children }: { children: React.ReactNode }) {
  return <div className="bg-[#f4f4f5] p-[3px]">{children}<button>Copy</button></div>
}
`,
    'app/page.tsx': `import { DiffReview } from "@/components/signoff-ui/diff-review"

export default function Page() {
  return (
    <main>
      <DiffReview files={[]} tone="danger" />
      <img src="/logo.png" alt="Logo" />
    </main>
  )
}
`,
    [STORY]: 'export default () => <button className="bg-[#123456]">Go</button>',
    ...(config ? { 'onsystem.config.json': JSON.stringify(config) } : {}),
  });
}

interface Result {
  file: string;
  diagnostics: { ruleId: string; message: string }[];
}

async function check(root: string, ...args: string[]) {
  const out: string[] = [];
  const io: Io = { cwd: root, color: false, stdout: (t) => out.push(t), stderr: () => {} };
  const code = await main(['check', ...args, '--no-cache'], io);
  const text = out.join('\n');
  const json = await main(['check', ...args, '--no-cache', '--format', 'json'], {
    ...io,
    stdout: (t) => out.push(t),
  });
  expect(json).toBe(code);
  const results = JSON.parse(out.slice(-1)[0] ?? '[]') as Result[];
  const reported = results
    .filter((r) => r.diagnostics.length)
    .map((r) => r.file)
    .sort();
  const messages = results.flatMap((r) => r.diagnostics.map((d) => d.message));
  return { code, text, reported, messages };
}

/** Calls one MCP tool on the app's design system. */
async function tool(root: string, name: string, args: Record<string, unknown>): Promise<string> {
  const ds = await load(root);
  const server = createServer({ getDesignSystem: () => Promise.resolve(ds) });
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const first = result.content[0];
    return first?.type === 'text' ? first.text : '';
  } finally {
    await client.close();
  }
}

describe('code from shadcn registries (docs/configuration.md)', () => {
  it('without a config, checks folders that components.json names no registry for as app code', async () => {
    const { reported } = await check(app(), '.');
    expect(reported).toEqual([MESSAGE, DIFF_REVIEW, PRIMITIVES]);
  });

  it("gives two configs: init's, with the registry folders in `components`, and rules off in `overrides`", async () => {
    const [components, overrides, ...rest] = configs();
    expect(rest).toEqual([]);
    // What `init` writes for this app, plus the two folders.
    const root = app();
    const io: Io = { cwd: root, color: false, stdout: () => {}, stderr: () => {} };
    expect(await main(['init', '--yes', '--no-cache'], io)).toBe(0);
    const init = JSON.parse(
      fs.readFileSync(path.join(root, 'onsystem.config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(components).toEqual({
      ...init,
      components: [
        ...(init.components as string[]),
        'components/ai-elements/**/*.{tsx,jsx}',
        'components/signoff-ui/**/*.{tsx,jsx}',
      ],
    });
    expect(components?.components).toEqual([
      'components/ui/**/*.{tsx,jsx}',
      'components/ai-elements/**/*.{tsx,jsx}',
      'components/signoff-ui/**/*.{tsx,jsx}',
    ]);
    // Every rule, so a rule added later is off there too once the docs list it.
    const [entry] = (overrides?.overrides ?? []) as { files: string[]; rules: object }[];
    expect(Object.keys(entry?.rules ?? {}).sort()).toEqual([...RULE_IDS].sort());
    expect(new Set(Object.values(entry?.rules ?? {}))).toEqual(new Set(['off']));
  });

  it('with the folders in `components`, skips them and checks code against their components', async () => {
    const [config] = configs();
    const root = app(config);
    const all = await check(root, '.');
    expect(all.reported).toEqual(['app/page.tsx']);
    expect(all.text).toContain('4 design-system files skipped');
    expect(all.messages).toContain('<DiffReview> has no prop "tone".');
    expect(configuration).toContain('`<DiffReview> has no prop "tone"`');
    // The hook runs `check` on the file it edited: a registry file is skipped like components/ui.
    const named = await check(root, DIFF_REVIEW);
    expect([named.code, named.reported]).toEqual([0, []]);
    expect(named.text).toContain('1 design-system file skipped');
    // Agents find the registry's components.
    expect(await tool(root, 'get_component', { name: 'DiffReview' })).toMatch(/^# DiffReview\n/);
    expect(await tool(root, 'search_components', { query: 'review file changes' })).toMatch(
      /best first:\nText after >, .+\n\n1\. DiffReview/,
    );
    // Helpers count too: the folder's Img stands in for a native <img>.
    expect(all.messages).toContain(
      'Native <img> where the design system has <Img>. Use <Img> (import { Img } from "@/components/signoff-ui/lib/primitives").',
    );
  });

  it("with a folder's top level only and its helpers in `overrides`, leaves the helpers out", async () => {
    expect(configuration).toContain('(`components/signoff-ui/*.{tsx,jsx}`)');
    expect(configuration).toContain('`"files": ["components/signoff-ui/lib/**"]`');
    const [config, offConfig] = configs();
    const globs = (config?.components as string[]).map((g) =>
      g === 'components/signoff-ui/**/*.{tsx,jsx}' ? 'components/signoff-ui/*.{tsx,jsx}' : g,
    );
    const [off] = (offConfig?.overrides ?? []) as { files: string[]; rules: object }[];
    const overrides = [{ ...off, files: ['components/signoff-ui/lib/**'] }];
    const both = await check(app({ ...config, components: globs, overrides }), '.');
    expect(both.reported).toEqual(['app/page.tsx']);
    expect(both.messages).toEqual(['<DiffReview> has no prop "tone".']);
    expect(both.text).toContain('3 design-system files skipped');
    // Without the `overrides` entry, `lib/` is checked as app code and its files are reported.
    const alone = await check(app({ ...config, components: globs }), '.');
    expect(alone.reported).toEqual(['app/page.tsx', PRIMITIVES]);
    expect(alone.messages.some((m) => m.includes('<Img>'))).toBe(false);
  });

  it('with the rules off in `overrides`, reports nothing there, in check or check_ui', async () => {
    const [, config] = configs();
    const root = app(config);
    const all = await check(root, '.');
    expect(all.reported).toEqual([]);
    const named = await check(root, DIFF_REVIEW, MESSAGE);
    expect([named.code, named.reported]).toEqual([0, []]);
    expect(await tool(root, 'check_ui', { path: DIFF_REVIEW })).toBe(
      `${DIFF_REVIEW}: no design-system problems found.`,
    );
    // Zero config still finds components/ui; agents do not learn DiffReview.
    expect(all.text).toContain('1 design-system file skipped');
    expect(await tool(root, 'get_component', { name: 'DiffReview' })).toMatch(
      /^No component named "DiffReview"/,
    );
  });

  it('with `exclude`, still checks a file named outright, and keeps stories out', async () => {
    expect(configuration).toContain('`"exclude": ["components/signoff-ui/**"]`');
    const root = app({ exclude: ['components/signoff-ui/**'] });
    const all = await check(root, '.');
    // `exclude` adds to the defaults, which leave tests and stories out.
    expect(all.reported).toEqual([MESSAGE]);
    expect(all.text).toContain('1 test or story left out');
    const named = await check(root, DIFF_REVIEW);
    expect([named.code, named.reported]).toEqual([1, [DIFF_REVIEW]]);
    // check_ui leaves it out, as `check .` and the hook do.
    expect(await tool(root, 'check_ui', { path: DIFF_REVIEW })).toMatch(
      new RegExp(`^${DIFF_REVIEW}: not checked\\.`),
    );
  });

  it('lists the default `exclude` in the field table, which a list adds to', async () => {
    const row = configuration.split('\n').find((line) => line.startsWith('| `exclude`'));
    const defaults = [
      ...(row?.split('|')[2]?.split('. A list')[0] ?? '').matchAll(/`([^`]+)`/g),
    ].map((m) => m[1]);
    expect([...defaults].sort()).toEqual(
      DEFAULT_EXCLUDE.filter((e) => e !== '**/node_modules/**').sort(),
    );
    expect(row).toContain('A list adds to these');
    const root = app({ exclude: ['components/signoff-ui/**', ...defaults] });
    const all = await check(root, '.');
    expect(all.reported).toEqual([MESSAGE]);
    expect(all.text).toContain('1 test or story left out');
  });

  it('is linked where `exclude` and findings in registry code come up', () => {
    const link = '(configuration.md#code-from-shadcn-registries)';
    for (const file of ['ci.md', 'troubleshooting.md']) {
      expect(fs.readFileSync(path.join(docsDir, file), 'utf8'), file).toContain(link);
    }
  });
});
