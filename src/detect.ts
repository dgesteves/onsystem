import fs from 'node:fs';
import path from 'node:path';

import { escapePath, globSync } from 'tinyglobby';

import { readProjectConfig, type ProjectConfig } from './extract/program.js';
import { buildEntries, exportedFiles, moduleFile, sourceTarget } from './package-source.js';
import { importedStylesheets } from './tokens/imports.js';
import { globBase, isHomeOrAbove, isInside, relativePath, toPosix } from './util/paths.js';
import { unique } from './util/strings.js';

/**
 * How apps import a design-system module, from a package's `exports`:
 * `@midday/ui/button` → `../../packages/ui/src/components/button.tsx`, or a
 * pattern (`@workspace/ui/components/*` → `…/src/components/*.tsx`). A
 * specifier without `*` and a pattern target map every matching file to one
 * module: a package that exports its components from a barrel.
 */
export interface ImportMapping {
  specifier: string;
  /** File or pattern relative to the root, with forward slashes. */
  target: string;
}

/** What zero-config detection found, used where the config leaves a field unset. */
export interface Detection {
  components: string[];
  tokens: string[];
  docs: string[];
  imports: ImportMapping[];
  /**
   * Keep the default globs as well: an app that imports a workspace package
   * may still have its own `components/ui`.
   */
  withDefaults: boolean;
  /** Where it came from, for `inspect` and the server log. */
  source: string;
  /**
   * With more than one design system (a `components.json` and a workspace package, or
   * two packages): each one's component globs, the one the code imports most first. Its
   * components win where two share a name, and are the ones suggested for native elements.
   */
  designSystems?: DesignSystemSource[] | undefined;
}

/** A candidate zero config looked at, and what came of it, for `inspect --explain`. */
export interface DetectionStep {
  /** `components.json`, `package.json exports of @acme/web`, `workspace package @acme/ui`. */
  candidate: string;
  accepted: boolean;
  reason: string;
}

/** Why a candidate was turned down, for the trace. */
type Note = (reason: string) => void;
const ignore: Note = () => undefined;

/**
 * A dependency whose package.json declares its onsystem config
 * (`"onsystem": "./onsystem.config.json"`): a design-system package set up for the apps that
 * use it.
 */
export interface DesignSystemPackage {
  /** Its package name: `@acme/ui`. */
  name: string;
  /** Its folder, absolute: the workspace package's sources, or where it is installed. */
  dir: string;
  /** The JSON config its package.json names, absolute. */
  config: string;
  /** Installed from a registry into `node_modules`, rather than a workspace package. */
  installed: boolean;
  /**
   * The folder its config's paths must stay in: its own folder when installed, else the
   * workspace root (a sibling package's tokens, `../tokens/...`), or its own folder outside one.
   */
  boundary: string;
}

/** A dependency's declaration that cannot be read, and what was done with it. */
export interface DeclarationProblem {
  name: string;
  problem: string;
}

/** What {@link findDesignSystemPackage} found among a project's dependencies. */
export interface DesignSystemPackageLookup {
  found?: DesignSystemPackage | undefined;
  /** Other dependencies that declare a config, not read. */
  others: string[];
  /** Workspace packages whose declaration cannot be read: an error, the team owns them. */
  problems: DeclarationProblem[];
  /** Installed packages whose declaration cannot be read: skipped with a warning. */
  skipped: DeclarationProblem[];
  /** How many dependencies were looked at, for the trace. */
  dependencies: number;
}

/** One of several design systems an app uses, and how often its code imports it. */
export interface DesignSystemSource {
  source: string;
  components: string[];
  imports: number;
  /**
   * The shadcn registry (`@signoff-ui`) whose code `npx shadcn add` copied into these files, as
   * the `registries` of components.json name it: a read-only design system, after the others.
   * Code that imports it is checked against its components, which are never suggested for a
   * native element, and its own files are skipped like the others' are.
   */
  registry?: string | undefined;
}

interface Found {
  components: string[];
  tokens: string[];
  imports: ImportMapping[];
  /** Absolute directories the components live in, for docs. */
  dirs: string[];
  source: string;
  /** The workspace package the components come from, when they come from one. */
  package?: string | undefined;
  /** Specifiers the app imports them by: a package name, a `components.json` alias. */
  prefixes?: string[] | undefined;
  /** The shadcn registry the files were copied from (`@signoff-ui`). */
  registry?: string | undefined;
}

const COMPONENT_FILE = /\.[jt]sx$/;
/** A module a barrel can lead to: TypeScript or JavaScript, not a declaration file. */
const SCRIPT_FILE = /(?<!\.d)\.[cm]?[jt]sx?$/;
const STYLESHEETS = [
  'src/styles/globals.css',
  'src/globals.css',
  'styles/globals.css',
  'globals.css',
  'src/index.css',
];

/**
 * An app's own stylesheets, where zero config looks for them without components.json (the
 * stylesheets of `DEFAULT_TOKENS` in config.ts).
 */
export const APP_STYLESHEETS = [
  'app/globals.css',
  'src/app/globals.css',
  'styles/globals.css',
  'src/styles/globals.css',
  'src/index.css',
  'app/app.css',
];

/**
 * Finds the design system without a config:
 *
 * 1. `components.json` (shadcn/ui): the `ui` alias, resolved through tsconfig
 *    `paths` or a workspace package, and `tailwind.css`.
 * 2. Without one, the root may be a design-system package: its `exports` map to
 *    component files, through barrels and from `dist/` back to the sources.
 * 3. Dependencies named like a design system (`@acme/ui`) that resolve to
 *    workspace sources, read the same way or through their own `components.json`,
 *    or, for a package without `exports` that apps import by path
 *    (`@acme/ui/primitives/button`), from the files the root's code imports. They
 *    are added to what `components.json` found, not skipped for it. One installed
 *    from a registry is read through its `exports` alone, when they point at the
 *    component sources it publishes, not from `dist/` back to `src/`.
 * 4. A flat folder of components that wrap a primitives library, the way React
 *    Aria's Tailwind starter ships them (`src/Button.tsx`, `src/Checkbox.tsx`).
 *
 * With more than one design system, the one the root's code imports most comes first
 * (`designSystems`). A candidate whose globs match no file is skipped. Returns undefined
 * when nothing applies, so the shadcn defaults stay in force.
 *
 * Next to the ui folder `components.json` names, the folders `npx shadcn add` copies other
 * registries' code into (its `registries`: `@signoff-ui` → `components/signoff-ui`) are
 * read-only design systems, after all the others ({@link fromRegistries}).
 *
 * `declared` is the dependency whose config the root takes on ({@link findDesignSystemPackage}):
 * it is read first among the dependencies in step 3, whatever its name, and also when it is
 * installed from a registry rather than a workspace package.
 */
export function detectProject(
  root: string,
  tsconfig?: string,
  trace?: DetectionStep[],
  declared?: Pick<DesignSystemPackage, 'name' | 'dir' | 'installed'>,
  packages: PackageFinder = new PackageFinder(root),
): Detection | undefined {
  const step = (candidate: string, accepted: boolean, reason: string) =>
    trace?.push({ candidate, accepted, reason });
  const found: Found[] = [];

  const shadcn = readJson(path.join(root, 'components.json'));
  const project = shadcn ? readProjectConfig(root, tsconfig) : undefined;
  let why = 'no ui or components alias';
  const fromShadcn =
    shadcn && project
      ? fromComponentsJson(root, root, shadcn, project, packages, (r) => {
          why = r;
        })
      : undefined;
  if (!shadcn) {
    step(
      'components.json',
      false,
      fs.existsSync(path.join(root, 'components.json')) ? 'not valid JSON' : 'not found',
    );
  } else if (!fromShadcn) {
    step('components.json', false, why);
  } else if (!matchesAny(root, fromShadcn)) {
    step('components.json', false, `${fromShadcn.source}, but no .tsx or .jsx file is there`);
  } else {
    found.push({ ...fromShadcn, source: `components.json (ui: ${fromShadcn.source})` });
    step('components.json', true, `ui: ${fromShadcn.source}, ${countFiles(root, fromShadcn)}`);
  }
  // The app's own components/ui stays in unless components.json names its folder.
  const withDefaults = !found.length;

  const own = readJson(path.join(root, 'package.json'));
  const ownName = typeof own?.name === 'string' ? own.name : 'the root';
  if (!found.length) {
    let reason = 'no package.json';
    const self = own
      ? fromPackage(root, root, own, (r) => {
          reason = r;
        })
      : undefined;
    if (self && matchesAny(root, self)) {
      step(`package.json exports of ${ownName}`, true, countFiles(root, self));
      return detection(root, [self], false, `package.json exports of ${self.source}`);
    }
    step(
      `package.json exports of ${ownName}`,
      false,
      self ? 'its exports match no .tsx or .jsx file' : reason,
    );
  } else {
    step(
      `package.json exports of ${ownName}`,
      false,
      'not read: components.json found the components',
    );
  }

  const dependencies = Object.keys({
    ...asRecord(own?.dependencies),
    ...asRecord(own?.devDependencies),
  });
  const names = unique([
    ...(declared ? [declared.name] : []),
    ...dependencies.filter(isDesignSystemName),
  ]);
  if (!names.length) {
    step(
      'workspace design-system packages',
      false,
      `no dependency is named like one (@acme/ui, acme-ui, @acme/design-system) among ${plural(dependencies.length, 'dependency', 'dependencies')}`,
    );
  }
  let imported: Map<string, Set<string>> | undefined;
  // Packages published without their sources whose type declarations are read instead.
  let declarations: Set<string> | undefined;
  /** What the trace adds for an installed package whose sources are not read. */
  const declarationsNote = (name: string, dir: string, pkg: Record<string, unknown>) => {
    declarations ??= new Set(declarationsPackages(root, packages).map((p) => p.name));
    if (declarations.has(name)) {
      return '; its components are read from its type declarations instead';
    }
    if (!declaresTypes(dir, pkg)) return '';
    const scope = scopeOf(name);
    return `; its type declarations are read when it declares its onsystem config${scope ? `, when the app is in its npm scope (${scope}/…)` : ''} or when the app's config sets "importPath" to "${name}"`;
  };
  for (const name of names) {
    // The package whose config the root takes on is read where it is, installed or not.
    const own = name === declared?.name ? declared : undefined;
    // Else a workspace package, or one installed from a registry.
    const workspaceDir = own ? undefined : packages.find(name);
    const installedDir = own || workspaceDir ? undefined : packages.installed(name);
    const kind = (own?.installed ?? installedDir !== undefined) ? 'installed' : 'workspace';
    const candidate = `${kind} package ${name}`;
    // What components.json already points into.
    if (found.some((f) => f.package === name)) {
      step(candidate, false, 'not added twice: components.json points into it');
      continue;
    }
    const dir = own?.dir ?? workspaceDir ?? installedDir;
    const pkg = dir ? readJson(path.join(dir, 'package.json')) : undefined;
    if (!dir || !pkg) {
      step(candidate, false, 'not a workspace package, and not installed');
      continue;
    }
    const reasons: string[] = [];
    const note: Note = (r) => reasons.push(r);
    // An installed package that declares no config is read through its exports alone, when
    // they point at the component sources it publishes: its compiled files are not read.
    const result = installedDir
      ? fromPackage(root, dir, pkg, note, true)
      : (fromPackage(root, dir, pkg, note) ??
        fromPackageComponentsJson(root, dir, pkg, packages, note) ??
        fromImports(root, dir, name, (imported ??= importedSubpaths(root, names)).get(name), note));
    if (result && matchesAny(root, result)) {
      found.push({
        ...result,
        source: `${kind} package ${result.source}`,
        package: name,
        prefixes: [name],
      });
      step(candidate, true, `${relativePath(root, dir)}, ${countFiles(root, result)}`);
    } else {
      const reason = result
        ? 'its components match no file'
        : unique(reasons).join('; ') || 'nothing to read';
      step(
        candidate,
        false,
        kind === 'installed' ? `${reason}${declarationsNote(name, dir, pkg)}` : reason,
      );
    }
  }
  // Other registries' code next to the ui folder: read-only, after every other design system.
  const registries =
    shadcn && project && fromShadcn && !withDefaults
      ? fromRegistries(root, shadcn, fromShadcn, found, project, step)
      : [];
  if (found.length) {
    step('a flat src/ of components', false, 'not read: a design system was found');
    // Registry code is named after the rest: `…; from shadcn registries, read-only: …`.
    const named = (source: string) =>
      registries.length
        ? `${source}; from shadcn registries, read-only: ${registries.map((r) => r.source).join(', ')}`
        : source;
    // Each registry's folder is a design system of its own, never the primary one.
    const read = registries.map((f) => ({
      source: f.source,
      components: f.components,
      imports: 0,
      registry: f.registry,
    }));
    if (found.length === 1) {
      const [only] = found;
      const source = only?.source ?? '';
      if (!only || !read.length) return detection(root, found, withDefaults, source);
      return {
        ...detection(root, [...found, ...registries], withDefaults, named(source)),
        designSystems: [{ source, components: only.components, imports: 0 }, ...read],
      };
    }
    // Several design systems: the most imported first, the rest after it.
    const counts = importCounts(
      root,
      found.map((f) => f.prefixes ?? []),
    );
    const ranked = found
      .map((f, i) => ({ f, imports: counts[i] ?? 0, i }))
      .sort((a, b) => b.imports - a.imports || a.i - b.i);
    const [primary, ...rest] = ranked;
    const describe = (r: { f: Found; imports: number }) =>
      `${r.f.source} (${r.imports.toLocaleString('en-US')} ${r.imports === 1 ? 'import' : 'imports'})`;
    return {
      ...detection(
        root,
        [...ranked.map((r) => r.f), ...registries],
        withDefaults,
        named(
          `primary: ${primary ? describe(primary) : ''}; also: ${rest.map(describe).join(', ')}`,
        ),
      ),
      designSystems: [
        ...ranked.map((r) => ({
          source: r.f.source,
          components: r.f.components,
          imports: r.imports,
        })),
        ...read,
      ],
    };
  }

  let flatWhy = 'no package.json';
  const flat = own
    ? fromFlatFolder(root, own, (r) => {
        flatWhy = r;
      })
    : undefined;
  if (flat && matchesAny(root, flat)) {
    step('a flat src/ of components', true, flat.source);
    return detection(root, [flat], false, flat.source);
  }
  step('a flat src/ of components', false, flatWhy);
  return undefined;
}

/** `12 component files`, for the trace. */
function countFiles(root: string, found: Found): string {
  return plural(componentGlob(root, found.components).length, 'component file');
}

/**
 * The files `patterns` match, outside `node_modules` unless a pattern points into it: the
 * sources of a design-system package installed there.
 */
function componentGlob(root: string, patterns: string[]): string[] {
  const named = patterns.filter((p) => p.includes('node_modules'));
  const rest = patterns.filter((p) => !p.includes('node_modules'));
  const options = { cwd: root, expandDirectories: false };
  return [
    ...(rest.length ? globSync(rest, { ...options, ignore: ['**/node_modules/**'] }) : []),
    ...(named.length ? globSync(named, options) : []),
  ];
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

/** Libraries of unstyled primitives that design systems wrap. */
const PRIMITIVES =
  /^(?:react-aria-components|react-aria|radix-ui|@radix-ui\/react-[\w-]+|@base-ui-components\/react|@base-ui\/react|@headlessui\/react|@ark-ui\/react)(?:\/|$)/;

/** Files that make `src/` an app rather than a library: entries and route folders. */
const APP_ENTRIES = /^(?:main|index|App|app|root|entry-client|entry-server)\.[jt]sx?$/;
const APP_FOLDERS = new Set(['app', 'pages', 'routes']);

/** Fewer PascalCase files than this in `src/` are an app's, not a component library. */
const MIN_FLAT_COMPONENTS = 5;

/**
 * A flat `src/` of components, as React Aria's Tailwind starter has it. It needs all of:
 * a dependency on a primitives library, no app entry (`main.tsx`, `App.tsx`) or route
 * folder in `src/`, and at least five PascalCase `.tsx`/`.jsx` files at its top level, four
 * in five of which import the primitives library. An app whose `src/` holds pages or
 * features imports its own components, not primitives, so it does not qualify.
 */
function fromFlatFolder(
  root: string,
  pkg: Record<string, unknown>,
  note: Note = ignore,
): Found | undefined {
  const dependencies = Object.keys({
    ...asRecord(pkg.dependencies),
    ...asRecord(pkg.devDependencies),
    ...asRecord(pkg.peerDependencies),
  }).filter((name) => PRIMITIVES.test(name));
  if (!dependencies.length) {
    note('no dependency on a primitives library (React Aria, Radix, Base UI, Headless UI, Ark UI)');
    return undefined;
  }

  const dir = path.join(root, 'src');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    note('no src/ folder');
    return undefined;
  }
  const app = entries.find(
    (e) => (e.isFile() && APP_ENTRIES.test(e.name)) || (e.isDirectory() && APP_FOLDERS.has(e.name)),
  );
  if (app) {
    note(`src/${app.name} makes src/ an app`);
    return undefined;
  }
  const files = entries
    .filter((e) => e.isFile() && /^[A-Z][A-Za-z0-9]*\.[jt]sx$/.test(e.name))
    .map((e) => e.name);
  if (files.length < MIN_FLAT_COMPONENTS) {
    note(
      `${plural(files.length, 'PascalCase .tsx file')} in src/, fewer than ${MIN_FLAT_COMPONENTS}`,
    );
    return undefined;
  }

  const libraries = new Map<string, number>();
  let wrapping = 0;
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue;
    }
    const used = new Set<string>();
    for (const match of text.matchAll(/\bfrom\s*['"]([^'"]+)['"]/g)) {
      const library = PRIMITIVES.exec(match[1] ?? '')?.[0].replace(/\/$/, '');
      if (library) used.add(library);
    }
    if (used.size) wrapping++;
    for (const library of used) libraries.set(library, (libraries.get(library) ?? 0) + 1);
  }
  if (wrapping * 5 < files.length * 4) {
    note(
      `${wrapping} of ${files.length} files in src/ import ${dependencies[0] ?? 'a primitives library'}, fewer than four in five`,
    );
    return undefined;
  }

  const library = [...libraries].sort((a, b) => b[1] - a[1])[0]?.[0] ?? dependencies[0] ?? '';
  const stylesheet = STYLESHEETS.map((f) => path.join(root, f)).find((f) => fs.existsSync(f));
  return {
    components: ['src/*.{tsx,jsx}'],
    tokens: stylesheet ? [escapePath(relativePath(root, stylesheet))] : [],
    imports: [],
    dirs: [dir],
    source: `src/ (${String(files.length)} components wrapping ${library})`,
  };
}

function detection(root: string, found: Found[], withDefaults: boolean, source: string): Detection {
  const dirs = unique(found.flatMap((f) => f.dirs));
  return {
    components: found.flatMap((f) => f.components),
    tokens: found.flatMap((f) => f.tokens),
    // A folder inside another is covered by its `**`.
    docs: dirs
      .filter((dir) => !dirs.some((other) => other !== dir && isInside(other, dir)))
      .map((dir) => `${escapePath(relativePath(root, dir) || '.')}/**/*.{md,mdx}`),
    imports: found.flatMap((f) => f.imports),
    withDefaults,
    source,
  };
}

function matchesAny(root: string, found: Found): boolean {
  return componentGlob(root, found.components).length > 0;
}

/** `components.json` read from `dir` (the root, or a workspace package's directory). */
function fromComponentsJson(
  root: string,
  dir: string,
  json: Record<string, unknown>,
  project: ProjectConfig,
  packages: PackageFinder,
  note: Note = ignore,
): Found | undefined {
  const aliases = asRecord(json.aliases);
  const ui =
    typeof aliases.ui === 'string'
      ? aliases.ui
      : typeof aliases.components === 'string'
        ? `${aliases.components}/ui`
        : undefined;
  if (!ui) {
    note('no ui or components alias');
    return undefined;
  }

  let uiDir = resolveThroughPaths(ui, project);
  let imports: ImportMapping[] = [];
  if (!uiDir) {
    const name = packageName(ui);
    const pkgDir = name ? packages.find(name) : undefined;
    const pkg = pkgDir ? readJson(path.join(pkgDir, 'package.json')) : undefined;
    if (!name || !pkgDir || !pkg) {
      // Name the config whose paths were read: jsconfig.json in a JavaScript app.
      const from = project.configFile ? path.basename(project.configFile) : 'tsconfig';
      note(`the ui alias ${ui} resolves through neither ${from} paths nor a workspace package`);
      return undefined;
    }
    imports = exportMappings(root, pkgDir, pkg);
    uiDir = resolveThroughExports(ui, imports, root) ?? subpathDir(pkgDir, ui.slice(name.length));
    if (!uiDir) {
      note(`the ui alias ${ui} names no folder in ${name}`);
      return undefined;
    }
  }

  const tailwind = asRecord(json.tailwind);
  const css =
    typeof tailwind.css === 'string' && tailwind.css ? path.resolve(dir, tailwind.css) : undefined;
  const named = css && fs.existsSync(css) ? [css] : [];
  return {
    components: [`${escapePath(relativePath(root, uiDir) || '.')}/**/*.{tsx,jsx}`],
    tokens: (dir === root ? withAppStylesheets(root, named) : named).map((f) =>
      escapePath(relativePath(root, f)),
    ),
    imports,
    dirs: [uiDir],
    source: `${ui} → ${relativePath(root, uiDir) || '.'}`,
    ...ownerPackage(root, uiDir, ui),
  };
}

/**
 * The stylesheets an app's tokens come from when its components.json names a stylesheet in
 * another package, as cal.com's names coss/ui's: the app's own stylesheets first, which hold
 * its own tokens, then the named one, unless they import it, so that the cascade places it.
 */
function withAppStylesheets(root: string, named: string[]): string[] {
  if (named.every((file) => isInside(root, file))) return named;
  const own = APP_STYLESHEETS.map((f) => path.join(root, f)).filter(isFile);
  if (!own.length) return named;
  const imported = new Set(importedStylesheets(own, stylesheetResolver(root)));
  return [...own, ...named.filter((file) => !imported.has(file))];
}

/** How a shadcn registry is named in components.json: `@` and a name, so none leads out of the folder. */
const REGISTRY_NAMESPACE = /^@[a-z0-9][\w-]*$/i;

/** A folder `npx shadcn add` copies a registry's code into: `components/signoff-ui` for `@signoff-ui`. */
export interface RegistryFolder {
  namespace: string;
  /** Relative to the root, with forward slashes. */
  dir: string;
  /** The glob, from the root, for its .tsx and .jsx files. */
  glob: string;
}

/**
 * The registries `components.json` names (`"registries": { "@signoff-ui": … }`), sorted, and
 * where `npx shadcn add` copies their code: the components alias, through tsconfig `paths`, when
 * it names a folder in the project. `why` says why there is none.
 */
function registryBase(
  root: string,
  json: Record<string, unknown>,
  project: ProjectConfig,
): { namespaces: string[]; base?: string; alias?: string; why?: string } {
  const namespaces = Object.keys(asRecord(json.registries))
    .filter((n) => REGISTRY_NAMESPACE.test(n))
    .sort();
  const alias = asRecord(json.aliases).components;
  if (typeof alias !== 'string') return { namespaces, why: 'no components alias' };
  const base = namespaces.length ? resolveThroughPaths(alias, project) : undefined;
  if (!base || !isInside(root, base)) {
    return {
      namespaces,
      why: `the components alias ${alias} names no folder in the project through tsconfig paths`,
    };
  }
  return { namespaces, base, alias };
}

/** The folder of a registry's code: the namespace without its `@`, under the components folder. */
function registryFolder(root: string, base: string, namespace: string): RegistryFolder {
  const dir = relativePath(root, path.join(base, namespace.slice(1)));
  return { namespace, dir, glob: `${escapePath(dir)}/**/*.{tsx,jsx}` };
}

/**
 * The folders `npx shadcn add` copies the code of the registries `components.json` names into,
 * whether they hold files yet or not, outside the ui folder ({@link fromRegistries}). A config
 * that lists them in `components` reads them as zero config does: read-only, after the rest.
 */
export function registryFolders(root: string, tsconfig?: string): RegistryFolder[] {
  const json = readJson(path.join(root, 'components.json'));
  if (!json || !Object.keys(asRecord(json.registries)).length) return [];
  const project = readProjectConfig(root, tsconfig);
  const { namespaces, base } = registryBase(root, json, project);
  if (!base) return [];
  const ui = asRecord(json.aliases).ui;
  const uiDir = typeof ui === 'string' ? resolveThroughPaths(ui, project) : undefined;
  return namespaces
    .filter((namespace) => !uiDir || !isInside(uiDir, path.join(base, namespace.slice(1))))
    .map((namespace) => registryFolder(root, base, namespace));
}

/**
 * The folders `npx shadcn add` copies the code of the registries `components.json` names into
 * (`@/components` and `@signoff-ui` → `components/signoff-ui`). Each one that holds a .tsx or
 * .jsx file is a read-only design system: the app's code is checked against its components, and
 * its own files are skipped as the ui folder's are. Not when a design system found is imported
 * through a package's `exports` (`@workspace/ui`): a config that names that package would give
 * registry code its name too. A folder inside the ui folder is already part of it. Code a
 * registry copies loose into the components folder (React Bits) is not set apart.
 */
function fromRegistries(
  root: string,
  json: Record<string, unknown>,
  ui: Found,
  others: readonly Found[],
  project: ProjectConfig,
  step: (candidate: string, accepted: boolean, reason: string) => void,
): Found[] {
  const { namespaces, base, alias, why } = registryBase(root, json, project);
  if (!namespaces.length) return [];
  const no = (reason: string) => {
    for (const namespace of namespaces) step(`registry ${namespace}`, false, reason);
    return [];
  };
  // A config that names one package for the design system would give their files its name.
  const exported = others.find((f) => f.imports.length);
  if (exported) {
    return no(
      `not read: ${exported.package ?? 'a package'} is imported through its exports, and the registry's code is not`,
    );
  }
  if (!base || alias === undefined) return no(why ?? 'no components alias');
  const found: Found[] = [];
  for (const namespace of namespaces) {
    const candidate = `registry ${namespace}`;
    const { dir, glob } = registryFolder(root, base, namespace);
    const absolute = path.join(root, dir);
    if (ui.dirs.some((d) => isInside(d, absolute))) {
      step(candidate, false, `${dir} is in the ui folder`);
      continue;
    }
    const files = isDirectory(absolute) ? componentGlob(root, [glob]).length : 0;
    if (!files) {
      step(
        candidate,
        false,
        `${dir} ${isDirectory(absolute) ? 'holds no .tsx or .jsx file yet' : 'does not exist yet'}`,
      );
      continue;
    }
    step(candidate, true, `${dir}, ${plural(files, 'component file')}, read-only`);
    found.push({
      components: [glob],
      tokens: [],
      imports: [],
      // Markdown in it is the registry's, not docs for the app's components.
      dirs: [],
      source: `${dir} (${namespace}, ${plural(files, 'file')})`,
      prefixes: [`${alias}/${namespace.slice(1)}`],
      registry: namespace,
    });
  }
  return found;
}

/**
 * The workspace package a `components.json` folder belongs to, when it is not the root
 * itself (`@coss/ui/components`, through tsconfig `paths` or the package), and the
 * specifiers the root's code imports it by: the alias, and that package's name.
 */
function ownerPackage(
  root: string,
  dir: string,
  alias: string,
): { package?: string | undefined; prefixes: string[] } {
  for (let current = dir; ; current = path.dirname(current)) {
    const name = readJson(path.join(current, 'package.json'))?.name;
    if (typeof name === 'string') {
      return path.resolve(current) === path.resolve(root)
        ? { prefixes: [alias] }
        : { package: name, prefixes: [alias, name] };
    }
    if (current === path.dirname(current) || path.resolve(current) === path.resolve(root)) {
      return { prefixes: [alias] };
    }
  }
}

/**
 * A workspace package set up with its own `components.json` and a barrel
 * (`"exports": { ".": "./src/index.ts" }`): its components are imported from
 * the package name, not through the package's internal `@/` alias.
 */
function fromPackageComponentsJson(
  root: string,
  dir: string,
  pkg: Record<string, unknown>,
  packages: PackageFinder,
  note: Note = ignore,
): Found | undefined {
  const json = readJson(path.join(dir, 'components.json'));
  if (!json) return undefined;
  const found = fromComponentsJson(root, dir, json, readProjectConfig(dir), packages, (r) => {
    note(`its components.json: ${r}`);
  });
  if (!found) return undefined;
  const name = typeof pkg.name === 'string' ? pkg.name : relativePath(root, dir);
  const barrel = pkg.exports !== undefined || typeof pkg.main === 'string';
  return {
    ...found,
    imports: barrel
      ? found.dirs.map((d) => ({ specifier: name, target: `${relativePath(root, d)}/*` }))
      : found.imports,
    source: `${name} (components.json ui: ${found.source})`,
  };
}

/**
 * A package whose `exports` point at component source files is a design system. An export
 * that leads to a barrel (`./components/button` → `components/button/index.ts`, or `.` →
 * `src/index.tsx` behind `dist/`) stands for the files the barrel re-exports, each
 * suggested with the export's specifier. An `installed` package's exports are read as an app
 * resolves them ({@link APP_CONDITIONS}), not from `dist/` back to `src/`: a widget kit
 * publishes `src/` beside `dist/` for its source maps, or points a `source` condition at it for
 * its own repository, and it is not the app's design system. Its compiled files ({@link isBuildOutput})
 * are not read at all: no barrel, component or stylesheet in them. Nor is an export that points
 * at JavaScript outside a build folder ({@link isCompiledExport}): its re-exports are not followed.
 */
function fromPackage(
  root: string,
  dir: string,
  pkg: Record<string, unknown>,
  note: Note = ignore,
  installed = false,
): Found | undefined {
  const imports: ImportMapping[] = [];
  const components: ImportMapping[] = [];
  const add = (mapping: ImportMapping, component: boolean) => {
    imports.push(mapping);
    if (component && !components.some((m) => m.target === mapping.target)) components.push(mapping);
  };
  const mappings = exportMappings(root, dir, pkg, installed);
  for (const mapping of mappings) {
    const file = path.resolve(root, mapping.target);
    if (installed && isCompiledExport(dir, file)) continue;
    if (mapping.target.includes('*') || !SCRIPT_FILE.test(file) || !isFile(file)) {
      add(mapping, COMPONENT_FILE.test(mapping.target));
      continue;
    }
    // The .tsx/.jsx files it leads to, through barrels.
    for (const reached of exportedFiles(file, dir)) {
      if (COMPONENT_FILE.test(reached) && !(installed && isBuildOutput(dir, reached))) {
        add({ specifier: mapping.specifier, target: relativePath(root, reached) }, true);
      }
    }
  }
  const files = components.filter((m) => !m.target.includes('*'));
  const patterns = components.filter((m) => m.target.includes('*'));
  // One or two .tsx exports are an app or a widget, not a component library.
  if (files.length < 3 && !patterns.length) {
    const built = mappings.filter(
      (m) =>
        /(?:^|\/)(?:dist|build|lib|out|esm|cjs)\//.test(m.target) ||
        (installed && isCompiledExport(dir, path.resolve(root, m.target))),
    );
    const output = built
      .slice(0, 2)
      .map((m) => m.target)
      .join(', ');
    note(
      pkg.exports === undefined && typeof pkg.main !== 'string'
        ? 'no exports'
        : built.length
          ? installed
            ? `its exports point at build output (${output}), not at component sources, and only sources are read`
            : `its exports point at build output with no source found (${output})`
          : `its exports lead to ${plural(files.length, 'component file')}; a design system exports at least 3`,
    );
    return undefined;
  }

  const stylesheets = imports
    .filter((m) => m.target.endsWith('.css') && !m.target.includes('*'))
    .map((m) => path.resolve(root, m.target))
    .filter((f) => fs.existsSync(f));
  const fallback = STYLESHEETS.map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
  return {
    components: [
      ...files.map((m) => escapePath(m.target)),
      ...patterns.map((m) => {
        const star = m.target.indexOf('*');
        const before = m.target.slice(0, star);
        const after = m.target.slice(star + 1);
        // `*` in an export spans folders when it is a whole segment
        // (`components/*` covers `components/form/input`); inside a file
        // name (`ui-*.tsx`) it stays in that folder.
        return before.endsWith('/')
          ? `${escapePath(before)}**/*${escapePath(after)}`
          : `${escapePath(before)}*${escapePath(after)}`;
      }),
    ],
    tokens: (stylesheets.length ? stylesheets : fallback ? [fallback] : []).map((f) =>
      escapePath(relativePath(root, f)),
    ),
    imports: components,
    dirs: unique(
      components.map((m) =>
        path.resolve(
          root,
          m.target.includes('*')
            ? m.target.slice(0, m.target.indexOf('*'))
            : path.posix.dirname(m.target),
        ),
      ),
    ),
    source: typeof pkg.name === 'string' ? pkg.name : relativePath(root, dir),
  };
}

/**
 * A package without `exports` that apps import by path, the way Documenso
 * imports `@documenso/ui/primitives/button`: its components are the files the
 * root's code imports, each suggested with the specifier it uses, and a
 * stylesheet imported from it (`@documenso/ui/styles/theme.css`) is the theme.
 * A folder imported through its index is a barrel for the files in it.
 */
function fromImports(
  root: string,
  dir: string,
  name: string,
  subpaths: ReadonlySet<string> | undefined,
  note: Note = ignore,
): Found | undefined {
  const files: ImportMapping[] = [];
  const barrels: ImportMapping[] = [];
  const stylesheets: string[] = [];
  const seen = new Set<string>();
  for (const subpath of [...(subpaths ?? [])].sort()) {
    const file = moduleFile(path.join(dir, subpath), undefined, dir);
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const specifier = `${name}/${subpath}`;
    if (/[\\/]index\.[cm]?[jt]sx?$/.test(file)) {
      barrels.push({ specifier, target: `${relativePath(root, path.dirname(file))}/*` });
    } else if (COMPONENT_FILE.test(file)) {
      files.push({ specifier, target: relativePath(root, file) });
    } else if (file.endsWith('.css')) {
      stylesheets.push(relativePath(root, file));
    }
  }
  if (!files.length && !barrels.length) {
    note(`the app imports no component file from ${name} by path`);
    return undefined;
  }
  return {
    components: [
      ...files.map((m) => escapePath(m.target)),
      ...barrels.map((m) => `${escapePath(m.target.slice(0, -1))}**/*.{tsx,jsx}`),
    ],
    tokens: stylesheets.map((f) => escapePath(f)),
    // A file imported directly is suggested with its own path, not its folder's barrel.
    imports: [...files, ...barrels],
    dirs: unique(
      [...files, ...barrels].map((m) => path.resolve(root, path.posix.dirname(m.target))),
    ),
    source: `${name}, imported by path`,
  };
}

/** Enough source to see which modules an app imports, without reading a whole monorepo. */
const MAX_SCANNED_FILES = 5000;

/** The root's source files, as far as `MAX_SCANNED_FILES`. */
function sourceFiles(root: string): string[] {
  return globSync('**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs,css}', {
    cwd: root,
    absolute: true,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.next/**', '**/*.d.ts'],
  }).slice(0, MAX_SCANNED_FILES);
}

/**
 * How many imports in the root's code name each group of specifiers: `@calcom/ui`
 * counts `@calcom/ui/components/button`, `@/components/ui` counts `@/components/ui/card`.
 */
function importCounts(root: string, groups: readonly string[][]): number[] {
  const counts = groups.map(() => 0);
  const pattern = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"'\s]+)["']/g;
  for (const file of sourceFiles(root)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? '';
      groups.forEach((prefixes, i) => {
        if (prefixes.some((p) => specifier === p || specifier.startsWith(`${p}/`))) {
          counts[i] = (counts[i] ?? 0) + 1;
        }
      });
    }
  }
  return counts;
}

/**
 * The subpaths of each package that the root's code and stylesheets import:
 * `@acme/ui/primitives/button` → `primitives/button` under `@acme/ui`.
 */
function importedSubpaths(root: string, names: string[]): Map<string, Set<string>> {
  const found = new Map(names.map((name) => [name, new Set<string>()]));
  const alternatives = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const specifier = new RegExp(
    `(?:\\bfrom|\\bimport|\\brequire)\\s*\\(?\\s*["'](${alternatives})/([^"'\\s]+)["']`,
    'g',
  );
  for (const file of sourceFiles(root)) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    if (!names.some((name) => text.includes(`${name}/`))) continue;
    for (const match of text.matchAll(specifier)) {
      if (match[1] && match[2]) found.get(match[1])?.add(match[2]);
    }
  }
  return found;
}

/**
 * `exports` subpaths with a source target, as specifiers relative to `root`. A target
 * built to `dist/` maps back to its source (`src/`, through the build config's entries),
 * unless `asWritten`: then each target is the one an app that installs the package resolves
 * ({@link APP_CONDITIONS}), as it is. Without an `exports` map, `main` stands for `.`.
 */
function exportMappings(
  root: string,
  dir: string,
  pkg: Record<string, unknown>,
  asWritten = false,
): ImportMapping[] {
  const name = typeof pkg.name === 'string' ? pkg.name : undefined;
  if (!name) return [];
  const exports =
    pkg.exports ??
    (typeof pkg.main === 'string' && /^\.?\/?(?:dist|build|lib)\//.test(pkg.main)
      ? pkg.main
      : undefined);
  const entries: [string, unknown][] =
    typeof exports === 'string'
      ? [['.', exports]]
      : exports && typeof exports === 'object' && !Array.isArray(exports)
        ? Object.keys(exports).every((k) => k.startsWith('.'))
          ? Object.entries(exports)
          : [['.', exports]]
        : [];
  let build: ReturnType<typeof buildEntries> | undefined;
  const mappings: ImportMapping[] = [];
  for (const [key, value] of entries) {
    const target = exportTarget(value, asWritten ? APP_CONDITIONS : undefined);
    if (!target) continue;
    const source = asWritten
      ? undefined
      : target.includes('*')
        ? sourcePattern(dir, target)
        : sourceTarget(dir, key, target, (build ??= buildEntries(dir)));
    mappings.push({
      specifier: key === '.' ? name : `${name}/${key.replace(/^\.\//, '')}`,
      target: relativePath(root, path.resolve(dir, source ?? target)),
    });
  }
  return mappings;
}

/**
 * A compiled file in package `dir`'s build folder: JavaScript, JSX or CSS (`dist/index.mjs`,
 * `lib/button.jsx`, `dist/index.css`), or a pattern of them (`dist/*.jsx`). TypeScript there
 * (`lib/utils.ts`) is source.
 */
function isBuildOutput(dir: string, file: string): boolean {
  return /^(?:dist|build|lib|out|esm|cjs)\/.*\.(?:[cm]?jsx?|css)$/.test(
    toPosix(path.relative(dir, file)),
  );
}

/**
 * An `exports` target of installed package `dir` that is compiled: its build output, or
 * JavaScript in any folder (`./index.js`, `./es/index.mjs`, `./build-module/index.js`), which a
 * package published from TypeScript or JSX sources ships compiled. Its re-exports are not
 * followed, so a package that ships a `.js` barrel in front of `.jsx` sources is not read.
 */
function isCompiledExport(dir: string, file: string): boolean {
  return isBuildOutput(dir, file) || /\.[cm]?js$/.test(file);
}

/** `./dist/*.mjs` → `src/*.tsx` (or `.ts`) when files match it there; anything else as it is. */
function sourcePattern(dir: string, target: string): string {
  const relative = target.replace(/^\.\//, '');
  const built = /^(?:dist|build|lib|out|esm|cjs)\//.exec(relative);
  if (!built) return relative;
  const rest = relative.slice(built[0].length).replace(/(?:\.d)?\.[cm]?[jt]sx?$/, '');
  for (const ext of ['.tsx', '.ts']) {
    const candidate = `src/${rest}${ext}`;
    if (globSync(candidate, { cwd: dir, ignore: ['**/node_modules/**'] }).length) return candidate;
  }
  return relative;
}

/**
 * The `exports` conditions an app resolves an installed package through: Node.js's own
 * (`import`, `require`, `module-sync`, `node`, `default`), and the `module`, `browser` and
 * `style` that bundlers and Tailwind CSS add. Others, such as `source`, `expo-source` and
 * `development`, lead the package's own repository to its sources, and an app that installs it
 * builds the target after them: `@expo/ui`'s `"default": "./build/universal/index.js"`, not its
 * `"expo-source": "./src/universal/index.ts"` before it.
 */
const APP_CONDITIONS: ReadonlySet<string> = new Set([
  'import',
  'require',
  'module-sync',
  'node',
  'module',
  'browser',
  'style',
  'default',
]);

/**
 * The source file an export condition map points at: the first string target that is not a
 * declaration file, through any condition but `types`, or through `conditions` alone.
 */
function exportTarget(value: unknown, conditions?: ReadonlySet<string>): string | undefined {
  if (typeof value === 'string') return value.endsWith('.d.ts') ? undefined : value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const target = exportTarget(item, conditions);
      if (target) return target;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const [condition, nested] of Object.entries(value)) {
      if (condition === 'types' || (conditions && !conditions.has(condition))) continue;
      const target = exportTarget(nested, conditions);
      if (target) return target;
    }
  }
  return undefined;
}

/** `@/components/ui` through `"@/*": ["./*"]`, when the directory exists. */
function resolveThroughPaths(specifier: string, project: ProjectConfig): string | undefined {
  for (const [pattern, targets] of Object.entries(project.paths)) {
    const star = pattern.indexOf('*');
    const prefix = star === -1 ? pattern : pattern.slice(0, star);
    const suffix = star === -1 ? '' : pattern.slice(star + 1);
    const matches =
      star === -1
        ? specifier === pattern
        : specifier.startsWith(prefix) &&
          specifier.endsWith(suffix) &&
          specifier.length >= prefix.length + suffix.length;
    if (!matches) continue;
    const middle =
      star === -1 ? '' : specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const target of targets) {
      const dir = path.resolve(project.pathsBase, target.replace('*', middle));
      if (isDirectory(dir)) return dir;
    }
  }
  return undefined;
}

/** `@workspace/ui/components` through `"./components/*": "./src/components/*.tsx"`. */
function resolveThroughExports(
  specifier: string,
  imports: ImportMapping[],
  root: string,
): string | undefined {
  for (const mapping of imports) {
    const star = mapping.specifier.indexOf('*');
    if (star === -1) continue;
    const prefix = mapping.specifier.slice(0, star).replace(/\/$/, '');
    if (specifier !== prefix) continue;
    const dir = path.resolve(root, mapping.target.slice(0, mapping.target.indexOf('*')));
    if (isDirectory(dir)) return dir;
  }
  return undefined;
}

/** `/components` under a package: the folder itself, or under `src`. */
function subpathDir(pkgDir: string, subpath: string): string | undefined {
  const rel = subpath.replace(/^\//, '');
  return [path.join(pkgDir, rel), path.join(pkgDir, 'src', rel)].find(isDirectory);
}

/** `@scope/name/sub` → `@scope/name`; `name/sub` → `name`; aliases such as `@/x` and `~/x` → undefined. */
function packageName(specifier: string): string | undefined {
  const [first = '', second] = specifier.split('/');
  if (first.startsWith('@')) return first.length > 1 && second ? `${first}/${second}` : undefined;
  return /^[a-z0-9]/i.test(first) ? first : undefined;
}

/**
 * Resolves specifiers to project files for the modules we read ourselves (a
 * Tailwind config's presets): relative paths and workspace packages, with or
 * without a subpath. Installed packages resolve to nothing: they are not the
 * project's to describe.
 */
export function moduleResolver(
  root: string,
): (specifier: string, fromFile: string) => string | undefined {
  const packages = new PackageFinder(root);
  return (specifier, fromFile) => {
    if (specifier.startsWith('.'))
      return moduleFile(path.resolve(path.dirname(fromFile), specifier));
    const name = packageName(specifier);
    const dir = name ? packages.find(name) : undefined;
    if (!name || !dir) return undefined;
    const subpath = specifier.slice(name.length + 1);
    if (subpath) return moduleFile(path.join(dir, subpath));
    const main = readJson(path.join(dir, 'package.json'))?.main;
    return moduleFile(path.resolve(dir, typeof main === 'string' ? main : 'index'));
  };
}

/**
 * {@link moduleResolver} for a Tailwind config's presets, then a workspace package's
 * `exports` for what it leaves unresolved: `@repo/tailwind-config` through
 * `"exports": { ".": "./tailwind.config.ts" }`, as Turborepo's template has it.
 */
export function presetResolver(
  root: string,
): (specifier: string, fromFile: string) => string | undefined {
  const resolve = moduleResolver(root);
  const packages = new PackageFinder(root);
  return (specifier, fromFile) => {
    const file = resolve(specifier, fromFile);
    if (file || specifier.startsWith('.')) return file;
    const name = packageName(specifier);
    const dir = name ? packages.find(name) : undefined;
    return name && dir
      ? exportedFile(dir, `.${specifier.slice(name.length)}`, (f) => SCRIPT_FILE.test(f))
      : undefined;
  };
}

/**
 * Resolves a stylesheet's `@import` to a project file: a path next to the stylesheet
 * (`./theme.css`, or `theme.css` as plain CSS reads it), or a stylesheet of a workspace
 * package (`@acme/theme/colors.css`, or `@acme/theme` through its `exports` or its `style`
 * field). An installed package resolves only when zero config reads it as a design system
 * ({@link installedDesignSystem}) or reads its type declarations ({@link declarationsPackages}:
 * by its config, its scope or the config's `importPath`), and a stylesheet in it imports others
 * of that package alone. In an installed package, a stylesheet in a build folder
 * (`dist/index.css`) is compiled, and resolves to nothing. Other installed packages
 * (`tailwindcss`) and URLs resolve to nothing.
 */
export function stylesheetResolver(
  root: string,
  { importPath }: Pick<DeclarationsOptions, 'importPath'> = {},
): (specifier: string, fromFile: string) => string | undefined {
  const packages = new PackageFinder(root);
  const designSystems = new Map<string, string | undefined>();
  // Packages read from their type declarations are the app's design system too.
  let declarations: Set<string> | undefined;
  const designSystem = (name: string) => {
    if (!designSystems.has(name)) {
      declarations ??= new Set(
        declarationsPackages(root, packages, { importPath }).map((p) => p.name),
      );
      designSystems.set(
        name,
        installedDesignSystem(root, name, packages) ??
          (declarations.has(name) ? packages.installed(name) : undefined),
      );
    }
    return designSystems.get(name);
  };
  // On disk, and not in node_modules, unless in the installed package `within` (none below it),
  // and then outside its build folders.
  const stylesheet = (file: string, within?: string) =>
    [file, `${file}.css`].find(
      (f) =>
        f.endsWith('.css') &&
        (within === undefined || (isInside(within, f) && !isBuildOutput(within, f))) &&
        !/(?:^|[\\/])node_modules[\\/]/.test(within === undefined ? f : path.relative(within, f)) &&
        isFile(f),
    );
  return (specifier, fromFile) => {
    if (/^(?:[a-z][\w+.-]*:|\/)/i.test(specifier)) return undefined;
    const relative = stylesheet(
      path.resolve(path.dirname(fromFile), specifier),
      installedPackageOf(fromFile),
    );
    if (relative || specifier.startsWith('.')) return relative;
    const name = packageName(specifier);
    const workspace = name ? packages.find(name) : undefined;
    const installed = name && !workspace ? designSystem(name) : undefined;
    const dir = workspace ?? installed;
    if (!name || !dir) return undefined;
    const subpath = specifier.slice(name.length + 1);
    const key = subpath ? `./${subpath}` : '.';
    // In an installed package, an export that maps the subpath decides, even to nothing.
    const exported = installed
      ? installedStylesheet(installed, key)
      : exportedFile(dir, key, (f) => f.endsWith('.css'));
    if (exported !== undefined) return exported ?? undefined;
    const style = readJson(path.join(dir, 'package.json'))?.style;
    return subpath
      ? stylesheet(path.join(dir, subpath), installed)
      : stylesheet(path.resolve(dir, typeof style === 'string' ? style : 'index.css'), installed);
  };
}

/**
 * The stylesheet an app resolves `subpath` (`./globals.css`) of installed package `dir` to,
 * as the package's exported stylesheets are found ({@link exportTarget}): the most specific
 * `exports` entry that maps it decides, through its first stylesheet target under
 * {@link APP_CONDITIONS}, and a later condition is not tried. `null` when that entry leads to no
 * stylesheet, or to one in a build folder (`{ "style": "./dist/x.css", "default": "./src/x.css" }`
 * gives apps the compiled `dist/x.css`); undefined when no entry maps the subpath.
 */
function installedStylesheet(dir: string, subpath: string): string | null | undefined {
  const [match] = exportMatches(dir, subpath);
  if (!match) return undefined;
  const target = exportTargets(match.value, APP_CONDITIONS)
    .map((t) => t.replaceAll('*', match.middle))
    .find((t) => t.endsWith('.css'));
  const file = target === undefined ? undefined : path.resolve(dir, target);
  return file && isInside(dir, file) && !isBuildOutput(dir, file) && isFile(file) ? file : null;
}

/**
 * The folder of `name` installed from a registry, when zero config reads it as a design system:
 * named like one, with `exports` that point at the component sources it publishes.
 */
function installedDesignSystem(
  root: string,
  name: string,
  packages: PackageFinder,
): string | undefined {
  if (!isDesignSystemName(name)) return undefined;
  const dir = packages.installed(name);
  const pkg = dir ? readJson(path.join(dir, 'package.json')) : undefined;
  const found = dir && pkg ? fromPackage(root, dir, pkg, ignore, true) : undefined;
  return found && matchesAny(root, found) ? dir : undefined;
}

/** The installed package a file is in: `…/node_modules/@acme/ui` for `…/node_modules/@acme/ui/src/a.css`. */
function installedPackageOf(file: string): string | undefined {
  const parts = path.resolve(file).split(path.sep);
  const at = parts.lastIndexOf('node_modules');
  const first = parts[at + 1] ?? '.';
  // Not `.cache` or `.bin`, which hold no package.
  if (at === -1 || first.startsWith('.')) return undefined;
  const end = at + (first.startsWith('@') ? 3 : 2);
  return end < parts.length ? parts.slice(0, end).join(path.sep) : undefined;
}

/**
 * The file a package's `exports` map `subpath` (`.`, `./theme`) to, through any condition
 * (`style`, `import`, `default`) and `*` patterns: the first target on disk, inside the
 * package, that `accept` takes.
 */
function exportedFile(
  dir: string,
  subpath: string,
  accept: (file: string) => boolean,
): string | undefined {
  for (const { middle, value } of exportMatches(dir, subpath)) {
    for (const target of exportTargets(value)) {
      const file = path.resolve(dir, target.replaceAll('*', middle));
      if (isInside(dir, file) && accept(file) && isFile(file)) return file;
    }
  }
  return undefined;
}

/**
 * The entries of package `dir`'s `exports` that map `subpath`, with what their `*` stands for:
 * an exact subpath first, then the most specific pattern, as Node.js picks them.
 */
function exportMatches(dir: string, subpath: string): { middle: string; value: unknown }[] {
  const exports = readJson(path.join(dir, 'package.json'))?.exports;
  const entries: [string, unknown][] =
    exports && typeof exports === 'object' && !Array.isArray(exports)
      ? Object.keys(exports).every((k) => k.startsWith('.'))
        ? Object.entries(exports)
        : [['.', exports]]
      : exports === undefined
        ? []
        : [['.', exports]];
  const matches: { middle: string; value: unknown; rank: number }[] = [];
  for (const [key, value] of entries) {
    const star = key.indexOf('*');
    if (star === -1) {
      if (key === subpath) matches.push({ middle: '', value, rank: Infinity });
      continue;
    }
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      subpath.length >= prefix.length + suffix.length
    ) {
      const middle = subpath.slice(prefix.length, subpath.length - suffix.length);
      matches.push({ middle, value, rank: prefix.length });
    }
  }
  return matches.sort((a, b) => b.rank - a.rank);
}

/** Every target of an export condition map, in order, but its types, or those of `conditions` alone. */
function exportTargets(value: unknown, conditions?: ReadonlySet<string>): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((item) => exportTargets(item, conditions));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([condition, nested]) =>
      condition === 'types' || (conditions && !conditions.has(condition))
        ? []
        : exportTargets(nested, conditions),
    );
  }
  return [];
}

/**
 * Where an import from a workspace package points: its file, or `{}` for a
 * subpath the package's `exports` declare but whose target is not on disk
 * (built to `dist/`). Undefined when no such module exists. The linter tells
 * a module the design-system model left out from an invented one with it.
 */
export function workspaceModule(
  root: string,
): (specifier: string, fromFile: string) => { file?: string } | undefined {
  const resolve = moduleResolver(root);
  const packages = new PackageFinder(root);
  return (specifier, fromFile) => {
    const file = resolve(specifier, fromFile);
    if (file) return { file };
    const name = packageName(specifier);
    const dir = name ? packages.find(name) : undefined;
    if (!name || !dir) return undefined;
    // A package built to `dist/` keeps its sources in `src/`, under the same subpath.
    const source = moduleFile(path.join(dir, 'src', specifier.slice(name.length + 1) || 'index'));
    if (source) return { file: source };
    const exports = readJson(path.join(dir, 'package.json'))?.exports;
    if (!exports || typeof exports !== 'object' || Array.isArray(exports)) return undefined;
    const subpath = `.${specifier.slice(name.length)}`;
    const declared = Object.keys(exports).some((key) => {
      const star = key.indexOf('*');
      if (star === -1) return key === subpath;
      return subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1));
    });
    return declared ? {} : undefined;
  };
}

/** The package.json field a design-system package names its onsystem config with. */
export const PACKAGE_FIELD = 'onsystem';

/**
 * The config the package.json in `dir` declares: its `onsystem` field, a JSON file in the
 * package (`"./onsystem.config.json"`). Undefined without the field; a problem when the field
 * names something that cannot be read. Only JSON: a config in code would run a dependency's code.
 */
export function declaredConfig(
  dir: string,
  pkg: Record<string, unknown> | undefined = readJson(path.join(dir, 'package.json')),
): { file: string } | { problem: string } | undefined {
  const value = pkg?.[PACKAGE_FIELD];
  if (value === undefined) return undefined;
  const field = `"${PACKAGE_FIELD}" in ${path.join(dir, 'package.json')}`;
  if (typeof value !== 'string' || !value.endsWith('.json')) {
    return {
      problem: `${field} is ${JSON.stringify(value)}: it names a JSON config file in the package, such as "./onsystem.config.json".`,
    };
  }
  const file = path.resolve(dir, value);
  if (!isInside(dir, file) || file === path.resolve(dir)) {
    return { problem: `${field} names ${JSON.stringify(value)}, which is outside the package.` };
  }
  if (!isFile(file)) {
    return { problem: `${field} names ${JSON.stringify(value)}, which does not exist.` };
  }
  return { file };
}

/**
 * The dependency of `root` (in `dependencies` or `devDependencies`) whose package.json declares
 * its onsystem config, as a workspace package or installed from a registry: the design system
 * the root uses, set up in its own package. With several, the one the root's code imports
 * most, then the first listed; `others` names the rest. A declaration that cannot be read is a
 * problem in a workspace package, which its team owns, and is skipped in an installed one, so a
 * published package cannot stop the apps that use it. Undefined at a workspace root, whose
 * projects each find their own, and without a package.json.
 *
 * Only the root's own dependencies are looked at, each where Node.js resolves it
 * ({@link PackageFinder.locate}). `packages` is the load's finder, shared with detection.
 */
export function findDesignSystemPackage(
  root: string,
  packages: PackageFinder = new PackageFinder(root),
): DesignSystemPackageLookup | undefined {
  const own = readJson(path.join(root, 'package.json'));
  if (!own || isWorkspaceRoot(root)) return undefined;
  const names = Object.keys({
    ...asRecord(own.dependencies),
    ...asRecord(own.devDependencies),
  });
  const declaring: DesignSystemPackage[] = [];
  const problems: DeclarationProblem[] = [];
  const skipped: DeclarationProblem[] = [];
  for (const name of names) {
    const located = packages.locate(name);
    // Most dependencies declare nothing: only those that do are followed to their real folder.
    if (located?.json[PACKAGE_FIELD] === undefined) continue;
    const resolved = packages.place(located.dir);
    const declared = declaredConfig(resolved.dir, located.json);
    if (!declared) continue;
    if ('problem' in declared) {
      (resolved.installed ? skipped : problems).push({ name, problem: declared.problem });
    } else {
      declaring.push({
        name,
        dir: resolved.dir,
        config: declared.file,
        installed: resolved.installed,
        boundary: resolved.boundary,
      });
    }
  }
  let ranked = declaring;
  if (declaring.length > 1) {
    const counts = importCounts(
      root,
      declaring.map((p) => [p.name]),
    );
    ranked = declaring
      .map((p, i) => ({ p, imports: counts[i] ?? 0, i }))
      .sort((a, b) => b.imports - a.imports || a.i - b.i)
      .map((r) => r.p);
  }
  const [found, ...others] = ranked;
  return {
    found,
    others: others.map((p) => p.name),
    problems,
    skipped,
    dependencies: names.length,
  };
}

/**
 * Import specifiers for the component files a package's `exports` lead to, through barrels and
 * from `dist/` back to the sources: what apps import its components by.
 */
export function packageImports(root: string, dir: string): ImportMapping[] {
  const pkg = readJson(path.join(dir, 'package.json'));
  return pkg ? (fromPackage(root, dir, pkg)?.imports ?? []) : [];
}

/** A design-system package an app reads from its type declarations ({@link declarationsPackages}). */
export interface DeclarationsPackage {
  name: string;
  /** Where the app finds it, in the nearest `node_modules` that has it (a link, with pnpm). */
  dir: string;
  version?: string | undefined;
  /**
   * Why it is the app's design system: it declares its onsystem config (`config`), it is named
   * like one in the root's own npm scope (`scope`), or the root's config names it as its
   * `importPath` (`importPath`).
   */
  by: 'config' | 'scope' | 'importPath';
}

/** What {@link declarationsPackages} knows of the root's config. */
export interface DeclarationsOptions {
  /** The config's `importPath`: a dependency it names exactly (`@dub/ui`) is the app's design system. */
  importPath?: string | undefined;
  /**
   * The component globs the root reads, relative to it: a package with component files they
   * match (`node_modules/@acme/ui/src/**\/*.tsx`) is read from those sources, not from its
   * declarations. Without them, none is read from its sources.
   */
  components?: readonly string[] | undefined;
}

/**
 * The dependencies of `root` (in `dependencies` or `devDependencies`) whose components are read
 * from their type declarations: design-system packages installed from a registry that name
 * `.d.ts` files, and whose component sources the root does not read (`options.components`
 * matches no file in them), as when they publish only compiled code. A design-system package
 * is one that declares its onsystem config (set up with `init`); one named like a design system
 * in the root's own npm scope (`@acme/ui` for `@acme/web`); or the dependency the root's config
 * names as its `importPath`, whatever its name or scope (`@dub/ui` in an unscoped app). A kit
 * from another scope named like one (`@sanity/ui`, `@react-email/components`) is not the app's
 * design system unless the config says so, and is not read. Workspace packages are read from
 * their sources. None at a workspace root, whose projects each find their own.
 */
export function declarationsPackages(
  root: string,
  packages: PackageFinder = new PackageFinder(root),
  options: DeclarationsOptions = {},
): DeclarationsPackage[] {
  const own = readJson(path.join(root, 'package.json'));
  if (!own || isWorkspaceRoot(root)) return [];
  const scope = scopeOf(own.name);
  const found: DeclarationsPackage[] = [];
  let sources: string[] | undefined;
  for (const name of Object.keys({
    ...asRecord(own.dependencies),
    ...asRecord(own.devDependencies),
  })) {
    const located = packages.locate(name);
    if (!located) continue;
    const declaration =
      located.json[PACKAGE_FIELD] === undefined
        ? undefined
        : declaredConfig(packages.place(located.dir).dir, located.json);
    const by =
      declaration !== undefined && 'file' in declaration
        ? 'config'
        : scope !== undefined && scopeOf(name) === scope && isDesignSystemName(name)
          ? 'scope'
          : name === options.importPath
            ? 'importPath'
            : undefined;
    if (!by) continue;
    const installed = packages.installed(name);
    const pkg = installed ? cachedManifest(path.join(installed, 'package.json')) : undefined;
    if (!installed || !pkg || !declaresTypes(installed, pkg)) continue;
    sources ??= componentSources(root, options.components ?? []);
    if (sources.some((file) => isInside(realPath(installed), file))) continue;
    const version = typeof pkg.version === 'string' ? pkg.version : undefined;
    found.push({ name, dir: path.resolve(located.dir), version, by });
  }
  return found;
}

/** `@acme` for `@acme/web`; undefined for an unscoped name. */
function scopeOf(name: unknown): string | undefined {
  return typeof name === 'string' && /^@[^/]+\/./.test(name) ? name.split('/')[0] : undefined;
}

/** Whether a package names type declarations: `types`, a `types` export condition, or `index.d.ts`. */
function declaresTypes(dir: string, pkg: Record<string, unknown>): boolean {
  if (typeof pkg.types === 'string' || typeof pkg.typings === 'string') return true;
  const hasTypes = (value: unknown): boolean =>
    Array.isArray(value)
      ? value.some(hasTypes)
      : value !== null &&
        typeof value === 'object' &&
        Object.entries(value).some(([key, nested]) => key === 'types' || hasTypes(nested));
  return hasTypes(pkg.exports) || isFile(path.join(dir, 'index.d.ts'));
}

/** Files that hold no component to read: declarations, tests and stories, as `exclude` has them. */
const NOT_COMPONENT_SOURCES = [
  '**/*.d.ts',
  '**/*.{test,spec,stories}.{ts,tsx,js,jsx}',
  '**/__{tests,stories,mocks}__/**',
];

/**
 * The real paths of the component files in `node_modules` that `patterns` (relative to `root`)
 * match: the sources of an installed package that the root reads, through a design-system
 * package's config or zero config. Tests and stories are not components.
 */
function componentSources(root: string, patterns: readonly string[]): string[] {
  const named = patterns.filter((p) => p.includes('node_modules'));
  if (!named.length) return [];
  return globSync(named, {
    cwd: root,
    absolute: true,
    expandDirectories: false,
    ignore: NOT_COMPONENT_SOURCES,
  }).map(realPath);
}

/** A path with its links resolved, or as it is when it cannot be. */
function realPath(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

/**
 * Dependencies' package.json files, parsed, by path: read again only when one's size or mtime
 * changes, so a config loaded again (the ESLint plugin's and the MCP server's reloads) does not
 * read every dependency again.
 */
const manifests = new Map<string, { stamp: string; json: Record<string, unknown> | undefined }>();

function cachedManifest(file: string): Record<string, unknown> | undefined {
  const stamp = fileStamp(file);
  const cached = manifests.get(file);
  if (cached?.stamp === stamp) return cached.json;
  const json = readJson(file);
  manifests.set(file, { stamp, json });
  return json;
}

/** A file's or folder's size and mtime, or `-` when it is missing. */
function fileStamp(file: string): string {
  const stats = fs.statSync(file, { throwIfNoEntry: false });
  return stats ? `${String(stats.mtimeMs)}:${String(stats.size)}` : '-';
}

/** `@acme/ui`, `@acme/ui-kit`, `@acme/design-system`, `acme-ui`; not `@acme/email-components`. */
export function isDesignSystemName(name: string): boolean {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return (
    /^(?:ui|ui-kit|uikit|ui-react|react-ui|design-system|ds|components|primitives)$/.test(base) ||
    /-(?:ui|ui-kit|design-system)$/.test(base)
  );
}

/**
 * Locates packages by name for one load: a project's config, its design-system package and
 * its detection share one. Workspace packages are found through `node_modules` links up to the
 * workspace root, then by the workspace's package globs ({@link find}); any dependency as
 * Node.js resolves it ({@link locate}).
 */
export class PackageFinder {
  private byName?: Map<string, string>;
  /** The packages the package manager links: those its workspace globs list, without Nx's. */
  private linkable?: Map<string, string>;
  private nodeModules?: string[];
  private realRoot?: string;
  private workspace?: string | null;

  constructor(readonly root: string) {}

  find(name: string): string | undefined {
    for (let dir = this.root; ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, 'node_modules', name);
      if (fs.existsSync(path.join(candidate, 'package.json'))) {
        const real = fs.realpathSync(candidate);
        // Only linked workspace sources count: an installed package is found by `installed`.
        if (!/[\\/]node_modules[\\/]/.test(real)) {
          // Express it from the root as given, so paths stay relative when the
          // root itself sits behind a link (`/var` → `/private/var` on macOS).
          return path.resolve(this.root, path.relative(fs.realpathSync(this.root), real));
        }
      }
      if (dir === path.dirname(dir) || isWorkspaceRoot(dir)) break;
    }
    this.byName ??= scanWorkspace(this.root);
    return this.byName.get(name);
  }

  /**
   * Where `name` resolves for code in the root, as Node.js finds it: in the nearest
   * `node_modules` at or above it that has it; else the workspace package of that name, in a
   * checkout that is not installed (only then is the workspace scanned). With its package.json.
   */
  locate(name: string): { dir: string; json: Record<string, unknown> } | undefined {
    const found = this.inNodeModules(name);
    if (found) return found;
    // A dependency resolves only to a package the package manager links, never to a folder
    // only Nx knows of, so Nx's projects (a glob of the whole repository) are not looked for.
    this.linkable ??= scanWorkspace(this.root, false);
    const dir = this.linkable.get(name);
    const json = dir ? cachedManifest(path.join(dir, 'package.json')) : undefined;
    return dir && json ? { dir, json } : undefined;
  }

  /**
   * A located package at its real folder, expressed from the root as given: `installed` when
   * that is in a `node_modules`, rather than a workspace package linked there, and the
   * `boundary` its config's paths must stay in.
   */
  place(located: string): { dir: string; installed: boolean; boundary: string } {
    this.realRoot ??= fs.realpathSync(this.root);
    const real = path.relative(this.realRoot, fs.realpathSync(located));
    const dir = path.resolve(this.root, real);
    const installed = /(?:^|[\\/])node_modules[\\/]/.test(real);
    return { dir, installed, boundary: installed ? dir : this.boundaryOf(dir) };
  }

  /**
   * Where `name` is installed from a registry, rather than linked to a workspace package: its
   * real folder, where pnpm puts its own dependencies beside it, expressed from the root. When
   * that is outside the root and its workspace (pnpm's store elsewhere on the machine), the
   * folder in `node_modules` it was found by, the only way the loader reads it.
   */
  installed(name: string): string | undefined {
    const located = this.inNodeModules(name);
    if (!located) return undefined;
    const placed = this.place(located.dir);
    if (!placed.installed) return undefined;
    const near = isInside(this.root, placed.dir) || this.boundaryOf(placed.dir) !== placed.dir;
    return near ? placed.dir : path.resolve(located.dir);
  }

  /** `name` in the nearest `node_modules` at or above the root that has it, with its package.json. */
  private inNodeModules(name: string): { dir: string; json: Record<string, unknown> } | undefined {
    for (const nodeModules of this.nodeModulesDirs()) {
      const dir = path.join(nodeModules, ...name.split('/'));
      const json = cachedManifest(path.join(dir, 'package.json'));
      if (json) return { dir, json };
    }
    return undefined;
  }

  /** The `node_modules` folders at and above the root, nearest first, looked up once. */
  private nodeModulesDirs(): string[] {
    if (!this.nodeModules) {
      this.nodeModules = [];
      for (let dir = path.resolve(this.root); ; dir = path.dirname(dir)) {
        const candidate = path.join(dir, 'node_modules');
        if (isDirectory(candidate)) this.nodeModules.push(candidate);
        if (dir === path.dirname(dir)) break;
      }
    }
    return this.nodeModules;
  }

  /**
   * The workspace root when `dir` is in it, else `dir` itself. Never the home folder or above:
   * a stray `~/package.json` with `workspaces` would let a package's config name
   * `../../../.aws/credentials`.
   */
  private boundaryOf(dir: string): string {
    if (this.workspace === undefined) {
      const workspace = workspaceRootOf(this.root);
      this.workspace = workspace !== undefined && !isHomeOrAbove(workspace) ? workspace : null;
    }
    return this.workspace !== null && isInside(this.workspace, dir) ? this.workspace : dir;
  }
}

/**
 * A monorepo root: a pnpm-workspace.yaml whose `packages` name more than the root,
 * `workspaces` in package.json (npm, Yarn, Bun), a lerna.json with `packages`, or an nx.json.
 * Turborepo runs on the package manager's workspaces, so its roots are among these. pnpm 11
 * keeps its settings in a pnpm-workspace.yaml in a single app too (`allowBuilds`, as
 * create-next-app --use-pnpm leaves it), and reads one without `packages`, or with only
 * `- '.'`, as the root alone: that is not a monorepo.
 */
export function isWorkspaceRoot(dir: string): boolean {
  if (pnpmWorkspacePackages(dir).length) return true;
  if (fs.existsSync(path.join(dir, 'nx.json'))) return true;
  const pkg = readJson(path.join(dir, 'package.json'));
  if (pkg !== undefined && pkg.workspaces !== undefined) return true;
  return Array.isArray(readJson(path.join(dir, 'lerna.json'))?.packages);
}

/**
 * The `packages` of the pnpm-workspace.yaml in `dir` when they name a package other than the
 * root (`.`); none otherwise, and none without the file: then it holds only settings.
 */
function pnpmWorkspacePackages(dir: string): string[] {
  let list: string[];
  try {
    list = pnpmPackages(fs.readFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'utf8'));
  } catch {
    return [];
  }
  const beyondRoot = list.some(
    (p) => !p.startsWith('!') && path.posix.normalize(toPosix(p).replace(/\/+$/, '')) !== '.',
  );
  return beyondRoot ? list : [];
}

/** The nearest workspace root at or above `start`. */
export function workspaceRootOf(start: string): string | undefined {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (isWorkspaceRoot(dir)) return dir;
    if (dir === path.dirname(dir)) return undefined;
  }
}

/** What a workspace root declares its packages in, and Nx's marker. */
const WORKSPACE_MANIFESTS = ['pnpm-workspace.yaml', 'package.json', 'lerna.json', 'nx.json'];

/**
 * Workspace maps by workspace root (with Nx's projects or not), kept for the next load in the
 * same process (a monorepo root's projects, the ESLint plugin's and the MCP server's reloads)
 * while the files they were read from keep their size and mtime: the root's manifests, each
 * package's package.json, the folders the packages are in and the folders the package globs
 * start from. A package added to one of those folders, or a manifest edited, makes the next
 * load read the workspace again.
 */
const workspaceMaps = new Map<
  string,
  { stamp: string; watched: string[]; packages: Map<string, string> }
>();

/**
 * Package name → directory for every package the workspace declares, with Nx's projects
 * unless `nx` is false.
 */
function scanWorkspace(start: string, nx = true): Map<string, string> {
  const workspaceRoot = workspaceRootOf(start);
  if (!workspaceRoot) return new Map();
  const key = `${workspaceRoot}\0${String(nx)}`;
  const cached = workspaceMaps.get(key);
  if (cached && stampOf(cached.watched) === cached.stamp) return cached.packages;

  // Stamped before reading, so a change made meanwhile is read next time.
  const before = [
    ...WORKSPACE_MANIFESTS.map((name) => path.join(workspaceRoot, name)),
    ...workspacePatterns(workspaceRoot).include.map((p) =>
      path.resolve(workspaceRoot, globBase(`${p}/package.json`)),
    ),
  ];
  const stamps = new Map(before.map((file) => [file, fileStamp(file)]));
  const packages = new Map<string, string>();
  const dirs = workspacePackageDirs(workspaceRoot, nx);
  for (const dir of dirs) {
    const manifest = path.join(dir, 'package.json');
    stamps.set(manifest, fileStamp(manifest));
    if (!stamps.has(path.dirname(dir))) stamps.set(path.dirname(dir), fileStamp(path.dirname(dir)));
    const name = readJson(manifest)?.name;
    if (typeof name === 'string' && !packages.has(name)) packages.set(name, dir);
  }
  const watched = [...stamps.keys()];
  workspaceMaps.set(key, {
    stamp: watched.map((file) => stamps.get(file)).join('|'),
    watched,
    packages,
  });
  return packages;
}

function stampOf(files: readonly string[]): string {
  return files.map(fileStamp).join('|');
}

/** Folders a workspace root's package globs list, without its `!` exclusions. */
export interface WorkspacePatterns {
  include: string[];
  exclude: string[];
  /** What declares them, for `inspect`: `pnpm-workspace.yaml`, `package.json workspaces`. */
  source: string;
}

/**
 * `packages` from pnpm-workspace.yaml, `workspaces` from package.json (npm, Yarn, Bun), or
 * `packages` from lerna.json, in that order of precedence. A pnpm-workspace.yaml that names
 * no package beyond the root holds only settings, so the next source decides.
 */
export function workspacePatterns(dir: string): WorkspacePatterns {
  const split = (list: string[], source: string): WorkspacePatterns => ({
    include: list.filter((p) => !p.startsWith('!')).map((p) => toPosix(p).replace(/\/$/, '')),
    exclude: list.filter((p) => p.startsWith('!')).map((p) => toPosix(p.slice(1))),
    source,
  });
  const pnpm = pnpmWorkspacePackages(dir);
  if (pnpm.length) return split(pnpm, 'pnpm-workspace.yaml');
  const workspaces = readJson(path.join(dir, 'package.json'))?.workspaces;
  const list = Array.isArray(workspaces) ? workspaces : asRecord(workspaces).packages;
  if (Array.isArray(list)) {
    return split(
      list.filter((p): p is string => typeof p === 'string'),
      'package.json workspaces',
    );
  }
  const lerna = readJson(path.join(dir, 'lerna.json'))?.packages;
  if (Array.isArray(lerna)) {
    return split(
      lerna.filter((p): p is string => typeof p === 'string'),
      'lerna.json',
    );
  }
  return { include: [], exclude: [], source: '' };
}

/** Folders never holding a workspace package of the project's own. */
const NOT_PACKAGES = ['**/node_modules/**', '**/.git/**'];

/**
 * Every package folder of the workspace at `root`, absolute and sorted: the folders its
 * package globs match that hold a package.json, and with an nx.json, every folder with an
 * Nx project.json.
 */
export function workspacePackageDirs(root: string, nx = true): string[] {
  const { include, exclude } = workspacePatterns(root);
  const ignore = [...NOT_PACKAGES, ...exclude];
  const dirs = include.length
    ? globSync(
        include.map((p) => `${p}/package.json`),
        { cwd: root, absolute: true, ignore },
      ).map((manifest) => path.dirname(manifest))
    : [];
  if (nx && fs.existsSync(path.join(root, 'nx.json'))) {
    const projects = globSync('**/project.json', {
      cwd: root,
      absolute: true,
      // Build output can hold copies of a project's files.
      ignore: [...ignore, '**/dist/**'],
    });
    for (const project of projects) {
      dirs.push(path.dirname(project));
    }
  }
  return unique(dirs.map((d) => path.resolve(d)))
    .filter((d) => d !== path.resolve(root))
    .sort();
}

/**
 * The `packages` list of a pnpm-workspace.yaml, block (`- apps/*`, indented or
 * not) or flow (`[apps/*, packages/*]`) style, with comments, a quoted key or a
 * leading byte order mark. Only that key is read, so this stays a few lines
 * rather than a YAML parser.
 */
export function pnpmPackages(text: string): string[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const start = lines.findIndex((line) => /^(['"]?)packages\1\s*:/.test(line));
  if (start === -1) return [];
  const uncomment = (s: string) => s.replace(/(?:^|\s)#.*$/, '').trim();
  const unquote = (s: string) => s.trim().replace(/^(['"])(.*)\1$/, '$2');

  const inline = uncomment((lines[start] ?? '').slice((lines[start] ?? '').indexOf(':') + 1));
  if (inline.startsWith('[')) {
    let flow = inline;
    for (let i = start + 1; !flow.includes(']') && i < lines.length; i++) {
      flow += ` ${uncomment(lines[i] ?? '')}`;
    }
    const end = flow.indexOf(']');
    return flow
      .slice(1, end === -1 ? undefined : end)
      .split(',')
      .map(unquote)
      .filter(Boolean);
  }
  const items: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (item) items.push(unquote(uncomment(item[1] ?? '')));
    // The next top-level key ends the list.
    else if (/^\S/.test(line)) break;
  }
  return items.filter(Boolean);
}

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDirectory(dir: string): boolean {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}
