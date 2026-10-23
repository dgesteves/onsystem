import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ESLint, type Linter } from 'eslint';
import { build } from 'tsdown';
import tseslint from 'typescript-eslint';
import { beforeAll, describe, expect, it } from 'vitest';

import { main, type Io } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import { createServer } from '../src/server/index.js';
import { fixture, load, TSCONFIG } from './helpers.js';

// Zero config in a shadcn/ui app with code from other registries: the folders `npx shadcn add`
// copies @signoff-ui and @ai-elements into, as components.json's `registries` names them, are
// read-only design systems next to components/ui. `check`, the hook and ESLint skip their files,
// the app's code is checked against their components, agents find them, and none of them is
// suggested for a native element. Before, the first `check .` reported that code as the app's,
// and the next `shadcn add` brought new findings in files nobody edited.

const json = (value: unknown) => JSON.stringify(value, null, 2);

const stock = fs.readFileSync(
  path.join(import.meta.dirname, 'fixtures/shadcn-neutral/globals.css'),
  'utf8',
);

const DIFF_REVIEW = 'components/signoff-ui/diff-review.tsx';
const PRIMITIVES = 'components/signoff-ui/lib/primitives.tsx';
const MESSAGE = 'components/ai-elements/message.tsx';
const DOCK = 'components/Dock.tsx';
const PAGE = 'app/page.tsx';
const INVENTED = 'app/invented/page.tsx';

const REGISTRIES = {
  '@signoff-ui': 'https://signoff-ui.vercel.app/r/{name}.json',
  '@ai-elements': { url: 'https://registry.ai-sdk.dev/{name}.json' },
  '@react-bits': 'https://reactbits.dev/r/{name}-TS-TW.json',
};

/**
 * The app as `npx shadcn add` leaves it: signoff-ui and AI Elements in folders of their own,
 * with a native <button>, <textarea> and arbitrary values in them, and React Bits loose in
 * components/. The app's own page uses them as they are, and another invents props and parts.
 */
function app(files: Record<string, string | undefined> = {}): string {
  const all: Record<string, string | undefined> = {
    'package.json': json({ name: 'app', private: true }),
    'tsconfig.json': TSCONFIG,
    'components.json': json({
      style: 'new-york',
      tsx: true,
      tailwind: { css: 'app/globals.css' },
      aliases: { components: '@/components', ui: '@/components/ui', utils: '@/lib/utils' },
      registries: REGISTRIES,
    }),
    'app/globals.css': stock,
    'components/ui/button.tsx':
      'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }\n',
    [DIFF_REVIEW]: `import { Img } from "./lib/primitives"

export interface DiffReviewProps {
  files: string[]
  onAccept?: () => void
}

/** Review an agent's file changes, hunk by hunk, and accept or reject them. */
export function DiffReview({ files, onAccept }: DiffReviewProps) {
  return (
    <div className="rounded-[7px] bg-[#f6f8fa]">
      <Img src="/avatar.png" alt="" />
      <textarea aria-label="Comment" className="p-[3px]" />
      <button className="bg-[#123456] px-3" onClick={onAccept}>Accept {files.length}</button>
    </div>
  )
}
`,
    [PRIMITIVES]: `export function Img(props: React.ComponentProps<"img">) {
  return <img className="rounded-[7px]" {...props} />
}

export function IconCheck(props: React.ComponentProps<"svg">) {
  return <svg viewBox="0 0 16 16" fill="white" {...props} />
}
`,
    [MESSAGE]: `/** A chat message, from the user or the assistant. */
export function Message({ from, children }: { from: "user" | "assistant"; children?: React.ReactNode }) {
  return <div data-from={from} className="bg-[#f4f4f5] p-[3px]">{children}<button>Copy</button></div>
}

/** The body of a message. */
export function MessageContent({ children }: { children?: React.ReactNode }) {
  return <div className="rounded-[10px]">{children}</div>
}
`,
    [DOCK]:
      'export default function Dock() { return <nav className="bg-[#060010]"><button>Home</button></nav> }\n',
    [PAGE]: `import { Button } from "@/components/ui/button"
import { DiffReview } from "@/components/signoff-ui/diff-review"
import { Message, MessageContent } from "@/components/ai-elements/message"

export default function Page() {
  return (
    <main>
      <Message from="assistant">
        <MessageContent>Done.</MessageContent>
      </Message>
      <DiffReview files={[]} />
      <Button>Go</Button>
    </main>
  )
}
`,
    [INVENTED]: `import { DiffReview, DiffReviewPanel } from "@/components/signoff-ui/diff-review"
import { Message } from "@/components/ai-elements/message"

export default function Page() {
  return (
    <main>
      <DiffReview files={[]} tone="danger" />
      <DiffReviewPanel />
      <Message from="user" size="lg">
        <Message.Header />
      </Message>
      <img src="/logo.png" alt="Logo" />
      <button>Go</button>
    </main>
  )
}
`,
    ...files,
  };
  return fixture(
    Object.fromEntries(
      Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
  );
}

async function run(args: string[], cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { cwd, color: false, stdout: (t) => out.push(t), stderr: (t) => err.push(t) };
  const code = await main(args, io);
  return { code, stdout: out.join('\n'), stderr: err.join('\n') };
}

type Results = { file: string; diagnostics: { ruleId: string; message: string }[] }[];

async function check(cwd: string, ...args: string[]) {
  const text = await run(['check', ...args, '--no-cache'], cwd);
  const { stdout } = await run(['check', ...args, '--no-cache', '--format', 'json'], cwd);
  const results = JSON.parse(stdout) as Results;
  return {
    code: text.code,
    text: text.stdout,
    reported: results
      .filter((r) => r.diagnostics.length)
      .map((r) => r.file)
      .sort(),
    messages: (file: string) =>
      results.filter((r) => r.file === file).flatMap((r) => r.diagnostics.map((d) => d.message)),
  };
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

describe('zero config reads shadcn registry folders as read-only design systems', () => {
  it("skips the registry folders' code in check, as it skips components/ui", async () => {
    const root = app({ [INVENTED]: undefined });
    const all = await check(root, '.');
    // React Bits puts its files loose in components/: they are checked as the app's.
    expect(all.reported).toEqual([DOCK]);
    expect(all.text).toContain('4 design-system files skipped');
    // The hook and `check $(git diff --name-only)` name the files: skipped too.
    const named = await check(root, DIFF_REVIEW, MESSAGE, PRIMITIVES);
    expect([named.code, named.reported]).toEqual([0, []]);
    expect(named.text).toContain('3 design-system files skipped');
  });

  it('keeps passing when the next shadcn add brings a primitive the registry code lacks', async () => {
    // `npx shadcn add @ai-elements/prompt-input` adds components/ui/textarea.tsx, so the native
    // <textarea> in untouched signoff-ui code now has a design-system component, and
    // `@signoff-ui/run-meter` brings an arbitrary radius.
    const root = app({
      [INVENTED]: undefined,
      [DOCK]: undefined,
      'components/ui/textarea.tsx':
        'export function Textarea(props: React.ComponentProps<"textarea">) { return <textarea {...props} /> }\n',
      'components/ai-elements/prompt-input.tsx':
        'export function PromptInput() { return <form className="rounded-[10px]"><textarea /></form> }\n',
      'components/signoff-ui/run-meter.tsx':
        'export function RunMeter() { return <div className="rounded-[3px] bg-[#e5e7eb]" /> }\n',
    });
    expect(await check(root, '.')).toMatchObject({ code: 0, reported: [] });
  });

  it('checks the app against their components, and suggests only the primary for native elements', async () => {
    const root = app();
    const { reported, messages } = await check(root, INVENTED);
    expect(reported).toEqual([INVENTED]);
    expect(messages(INVENTED)).toEqual([
      '<DiffReview> has no prop "tone".',
      '"DiffReviewPanel" is not a design-system component (imported from "@/components/signoff-ui/diff-review"). Did you mean <DiffReview>?',
      '<Message> has no prop "size".',
      'Message has no member "Header". Its parts are MessageContent.',
      'Native <button> where the design system has <Button>. Use <Button> (import { Button } from "@/components/ui/button").',
    ]);
    // signoff-ui's internal Img is no replacement for the app's <img>.
    expect(messages(INVENTED).some((m) => m.includes('<Img>'))).toBe(false);
  });

  it('keeps the primary component where a registry exports one of the same name', async () => {
    const root = app({
      [INVENTED]: undefined,
      'components/ai-elements/actions.tsx':
        'export function Button(props: React.ComponentProps<"button"> & { tooltip?: string }) { return <button {...props} /> }\n',
      [PAGE]: 'export default function Page() { return <button>Go</button> }\n',
    });
    const { messages } = await check(root, PAGE);
    expect(messages(PAGE)).toEqual([
      'Native <button> where the design system has <Button>. Use <Button> (import { Button } from "@/components/ui/button").',
    ]);
  });

  it("names the folders on inspect's detected line, and why each registry was read or not", async () => {
    const root = app();
    const inspect = await run(['inspect', '--no-cache'], root);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toContain(
      'detected components.json (ui: @/components/ui → components/ui); from shadcn registries, read-only: components/ai-elements (@ai-elements, 1 file), components/signoff-ui (@signoff-ui, 2 files)',
    );
    const explain = await run(['inspect', '--explain', '--no-cache'], root);
    expect(explain.stdout).toContain(
      'found  registry @ai-elements: components/ai-elements, 1 component file, read-only',
    );
    expect(explain.stdout).toContain(
      'found  registry @signoff-ui: components/signoff-ui, 2 component files, read-only',
    );
    expect(explain.stdout).toContain(
      'no     registry @react-bits: components/react-bits does not exist yet',
    );
    expect(explain.stdout).toContain(
      'primary      components.json (ui: @/components/ui → components/ui); then components/ai-elements (@ai-elements, 1 file), read-only; then components/signoff-ui (@signoff-ui, 2 files), read-only',
    );
  });

  it('lets agents find them, labelled as installed from the registry, without its lib/ helpers', async () => {
    const root = app();
    const component = await tool(root, 'get_component', { name: 'DiffReview' });
    expect(component).toMatch(/^# DiffReview\n/);
    expect(component).toContain(
      "Installed from the shadcn registry @signoff-ui into components/signoff-ui: use it as it is. Its code is the registry's, so change it upstream, not here; `npx shadcn add --overwrite` replaces the file.",
    );
    expect(await tool(root, 'get_component', { name: 'Button' })).not.toContain('Installed from');
    expect(
      await tool(root, 'search_components', { query: 'review a diff of agent file changes' }),
    ).toMatch(/best first:\nText after >, .+\n\n1\. DiffReview/);
    const list = await tool(root, 'list_components', {});
    // Their descriptions are the registry's JSDoc: quoted.
    expect(list).toContain('DiffReview <div> (from @signoff-ui, read-only) — "Review an agent');
    expect(list).toContain('Message <div> (from @ai-elements, read-only) — "A chat message');
    expect(list).toContain("Button <button> — shadcn/ui's Button: Triggers an action");
    expect(list).not.toMatch(/^(Img|IconCheck)\b/m);
    expect(await tool(root, 'search_components', { query: 'img image check icon' })).not.toMatch(
      /\d\. (Img|IconCheck) /,
    );
  });

  it('leaves the ESLint plugin off the registry folders, as check does', async () => {
    const root = app({ [INVENTED]: undefined });
    const results = await eslint(root, ['components', 'app']);
    expect(
      results
        .filter((r) => r.messages.length)
        .map((r) => path.relative(root, r.filePath).split(path.sep).join('/')),
    ).toEqual([DOCK]);
  });

  it('reads no registry folder when components.json names none, or a package holds the ui folder', async () => {
    const plain = app({
      'components.json': json({
        tailwind: { css: 'app/globals.css' },
        aliases: { components: '@/components', ui: '@/components/ui' },
      }),
      [INVENTED]: undefined,
    });
    const config = await loadConfig({ root: plain });
    expect(config.components).toEqual(['components/ui/**/*.{tsx,jsx}']);
    expect(config.designSystems).toBeUndefined();
    expect((await check(plain, '.')).reported).toEqual([DOCK, MESSAGE, DIFF_REVIEW, PRIMITIVES]);

    // shadcn/ui's monorepo layout, with the ui folder in a package imported by its name.
    const monorepo = fixture({
      'pnpm-workspace.yaml': 'packages:\n  - apps/*\n  - packages/*\n',
      'package.json': json({ name: 'monorepo', private: true }),
      'packages/ui/package.json': json({
        name: '@workspace/ui',
        private: true,
        exports: { './components/*': './src/components/*.tsx' },
      }),
      'packages/ui/src/components/button.tsx':
        'export function Button(props: React.ComponentProps<"button">) { return <button {...props} /> }\n',
      'apps/web/package.json': json({
        name: 'web',
        dependencies: { '@workspace/ui': 'workspace:*' },
      }),
      'apps/web/tsconfig.json': TSCONFIG,
      'apps/web/components.json': json({
        tailwind: { css: '../../packages/ui/src/styles/globals.css' },
        aliases: { components: '@/components', ui: '@workspace/ui/components' },
        registries: REGISTRIES,
      }),
      'apps/web/components/signoff-ui/diff-review.tsx':
        'export function DiffReview() { return <button className="bg-[#123456]">Accept</button> }\n',
    });
    const web = path.join(monorepo, 'apps/web');
    expect((await loadConfig({ root: web })).components).toEqual([
      '../../packages/ui/src/components/**/*.{tsx,jsx}',
    ]);
    const explain = await run(['inspect', '--explain', '--no-cache'], web);
    expect(explain.stdout).toContain(
      "no     registry @signoff-ui: not read: @workspace/ui is imported through its exports, and the registry's code is not",
    );
  });

  it('keeps the folders read-only in a config that lists them, as init writes it', async () => {
    const listed = {
      components: [
        'components/ui/**/*.{tsx,jsx}',
        'components/ai-elements/**/*.{tsx,jsx}',
        'components/signoff-ui/**/*.{tsx,jsx}',
      ],
      tokens: ['app/globals.css'],
    };
    const root = app({ 'onsystem.config.json': json(listed) });
    const { reported, messages, text } = await check(root, '.');
    expect(reported).toEqual([INVENTED, DOCK]);
    expect(text).toContain('4 design-system files skipped');
    expect(messages(INVENTED)).toEqual([
      '<DiffReview> has no prop "tone".',
      '"DiffReviewPanel" is not a design-system component (imported from "@/components/signoff-ui/diff-review"). Did you mean <DiffReview>?',
      '<Message> has no prop "size".',
      'Message has no member "Header". Its parts are MessageContent.',
      'Native <button> where the design system has <Button>. Use <Button> (import { Button } from "@/components/ui/button").',
    ]);
    expect(await tool(root, 'get_component', { name: 'DiffReview' })).toContain(
      'Installed from the shadcn registry @signoff-ui into components/signoff-ui',
    );
    // `elements` still names one for a native element.
    const mapped = app({ 'onsystem.config.json': json({ ...listed, elements: { img: 'Img' } }) });
    expect((await check(mapped, INVENTED)).messages(INVENTED)).toContain(
      'Native <img> where the design system has <Img>. Use <Img> (import { Img } from "@/components/signoff-ui/lib/primitives").',
    );
  });

  it('leaves a config that sets "components" as it is', async () => {
    const root = app({
      [INVENTED]: undefined,
      'onsystem.config.json': json({ components: ['components/ui/**/*.{tsx,jsx}'] }),
    });
    const config = await loadConfig({ root });
    expect(config.designSystems).toBeUndefined();
    expect((await check(root, '.')).reported).toEqual([DOCK, MESSAGE, DIFF_REVIEW, PRIMITIVES]);
  });
});

// The ESLint plugin as it ships, built into its own folder, so its worker is a real file.
const REPO = path.resolve(import.meta.dirname, '..');
const OUT = path.join(REPO, 'node_modules/.cache/onsystem-eslint-registry-test');

interface Plugin {
  configs: { recommended: Linter.Config };
}
let plugin: Plugin;

beforeAll(async () => {
  await build({
    cwd: REPO,
    config: false,
    entry: { eslint: 'src/eslint/index.ts', 'eslint-worker': 'src/eslint/worker.ts' },
    outDir: OUT,
    format: 'esm',
    platform: 'node',
    target: 'node22.18',
    fixedExtension: false,
    dts: false,
    publint: false,
    clean: true,
    logLevel: 'silent',
  });
  ({ default: plugin } = (await import(pathToFileURL(path.join(OUT, 'eslint.js')).href)) as {
    default: Plugin;
  });
});

function eslint(cwd: string, files: string[]): Promise<ESLint.LintResult[]> {
  const linter = new ESLint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [
      { files: ['**/*.{ts,tsx,js,jsx}'], languageOptions: { parser: tseslint.parser } },
      plugin.configs.recommended,
    ],
  });
  return linter.lintFiles(files);
}
