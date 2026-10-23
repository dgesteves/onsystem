import fs from 'node:fs';
import path from 'node:path';

import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The README's Compatibility section says what package.json declares and what CI runs, and
// these tests read both: a new Node floor, Node version in CI, ESLint or TypeScript major or MCP
// protocol means an update to the README in the same pull request.

interface Step {
  uses?: string;
  with?: Record<string, string | number>;
}

interface Job {
  'runs-on'?: string;
  strategy?: { matrix?: Record<string, unknown[]> };
  steps: Step[];
}

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const readme = read('README.md');
const pkg = JSON.parse(read('package.json')) as {
  engines: { node: string };
  dependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const jobs = (
  parse(read('.github/workflows/ci.yml')) as {
    jobs: Record<string, Job | undefined>;
  }
).jobs;

/** The README's `## Compatibility` section, up to the next one, on one line. */
function section(): string {
  const start = readme.indexOf('\n## Compatibility\n');
  expect(start, 'a "## Compatibility" section in README.md').toBeGreaterThan(-1);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end).replace(/\s+/g, ' ');
}

/** `22, 24 and 26`. */
const andList = (items: string[]) =>
  items.length < 2
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${String(items.at(-1))}`;

/** The version a `>=x.y` or `>=x.y.z` range starts at, as the docs write it: `20.19`. */
function minimum(range: string): string {
  const match = /^>=(\d+\.\d+)(?:\.(\d+))?$/.exec(range);
  if (!match?.[1]) throw new Error(`expected a ">=x.y" range, got "${range}"`);
  return match[2] && match[2] !== '0' ? `${match[1]}.${match[2]}` : match[1];
}

/** The major of a dependency spec: `10` for `^10.12.0`, `9` for `npm:eslint@9.39.5`. */
const major = (spec: string | undefined) => /(\d+)\.\d+/.exec(spec ?? '')?.[1];

/** The Node version a job's setup-node step (the first, or the one at `index`) installs. */
function nodeVersion(job: Job | undefined, index = 0): string | undefined {
  const setup = job?.steps.filter((step) => step.uses?.startsWith('actions/setup-node@'))[index];
  const version = setup?.with?.['node-version'];
  return version === undefined ? undefined : String(version);
}

describe('the compatibility statement', () => {
  it('names the Node.js floor package.json declares, wherever the README names one', () => {
    const floor = minimum(pkg.engines.node);
    expect(section()).toContain(`Node.js ${floor} or later`);
    // The Quickstart names it too: every "Node.js x or later" in the README is the same floor.
    const named = [...readme.replace(/\s+/g, ' ').matchAll(/Node\.js ([\d.]+) or later/g)].map(
      (m) => m[1],
    );
    expect(named.length).toBeGreaterThan(1);
    for (const version of named) expect(version).toBe(floor);
  });

  it('names the Node.js versions CI runs: the test matrix, and the floor the package runs on', () => {
    const floor = minimum(pkg.engines.node);
    const matrix = (jobs.test?.strategy?.matrix?.node ?? []).map(String);
    expect(matrix.length).toBeGreaterThan(0);
    // The node20 job builds on a current Node, then runs what the package ships on the floor.
    expect(nodeVersion(jobs.node20, 1)).toBe(floor);
    expect(section()).toContain(
      `CI runs the tests on Node.js ${andList(matrix)}, and the built package on ${floor}`,
    );
  });

  it('names the systems CI runs the tests and the pack test on', () => {
    const matrix = (job: string) => (jobs[job]?.strategy?.matrix?.os ?? []).map(String);
    // The test job on Linux, the os job on the others, and the pack job on all three.
    expect(jobs.test?.['runs-on']).toBe('ubuntu-latest');
    expect(matrix('os')).toEqual(expect.arrayContaining(['macos-latest', 'windows-latest']));
    expect(matrix('pack')).toEqual(
      expect.arrayContaining(['ubuntu-latest', 'macos-latest', 'windows-latest']),
    );
    expect(section()).toContain(
      'Linux, macOS and Windows: CI runs the tests and the pack test on each',
    );
  });

  it('names the ESLint versions the optional peer admits and the plugin is tested on', () => {
    // test/eslint-peer.test.ts checks that the peer range admits each of these.
    const tested = [
      minimum(pkg.peerDependencies.eslint ?? ''),
      major(pkg.devDependencies['eslint-v9']),
      major(pkg.devDependencies.eslint),
    ].map(String);
    expect(section()).toContain(`ESLint ${andList(tested)}`);
  });

  it('names the TypeScript onsystem reads code with: its own dependency, not a peer', () => {
    const spec = pkg.dependencies.typescript;
    expect(pkg.peerDependencies.typescript).toBeUndefined();
    const version = /(\d+\.\d+)\.\d+/.exec(spec ?? '')?.[1];
    expect(version, spec).toBeDefined();
    expect(section()).toContain(`its own TypeScript ${String(version)}`);
  });

  it('names the MCP protocols pnpm smoke connects with, and links the clients page', () => {
    // scripts/smoke.mjs connects with the v1 SDK's client, which asks for its latest protocol,
    // then with the v2 client on the protocol it asserts.
    const modern = /getNegotiatedProtocolVersion\(\), '(\d{4}-\d{2}-\d{2})'/.exec(
      read('scripts/smoke.mjs'),
    )?.[1];
    expect(modern).toBeDefined();
    expect(section()).toContain(`${LATEST_PROTOCOL_VERSION} and ${String(modern)} protocols`);
    // The page, not one of its anchors: the client setup and support tiers live there.
    expect(fs.existsSync(path.join(root, 'docs/clients.md'))).toBe(true);
    expect(section()).toContain('](https://onsystem.vercel.app/docs/clients)');
  });
});
