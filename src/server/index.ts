import fs from 'node:fs/promises';
import path from 'node:path';

import {
  McpServer,
  ResourceTemplate,
  type CallToolResult,
  type GetPromptResult,
  type PromptCallback,
  type ReadResourceResult,
  type ResourceMetadata,
  type StandardSchemaWithJSON,
  type ToolAnnotations,
  type ToolCallback,
  type Variables,
} from '@modelcontextprotocol/server';
import * as z from 'zod';

import type { Catalog, CatalogEntry, ProjectSet, ServedProject } from '../catalog.js';
import { excludedBy } from '../config.js';
import type { DesignSystem } from '../design-system.js';
import { uncheckedNotice } from '../lint/index.js';
import { notReadNotices } from '../not-read.js';
import { descriptionOf, type SearchHit } from '../search/index.js';
import { TOKEN_CATEGORIES, type ComponentInfo } from '../types.js';
import { isInside, relativePath, SCRIPT_FILE } from '../util/paths.js';
import { NAME, VERSION } from '../version.js';
import {
  answer,
  type Answer,
  capDiagnostics,
  importStatement,
  json,
  listComponents,
  noComponentsMessage,
  pathOf,
  type Listing,
  renderAmbiguous,
  renderCatalogList,
  renderCatalogSearch,
  renderCatalogTokens,
  renderCheck,
  renderComponent,
  renderComponentList,
  renderNotFound,
  renderPrompt,
  renderSearch,
  renderTokens,
  resourceDescription,
} from './render.js';

export const INSTRUCTIONS = `This server describes the project's design system: its React components (props, variants, parts), design tokens and usage docs, and lints UI code against it.
When writing or changing UI in this project:
1. Find components with search_components (by intent) or list_components.
2. Read get_component before using a component: use only the props and variant values it lists.
3. Style with tokens from get_tokens, never with hex/rgb colors, arbitrary px values or Tailwind's default palette. chart-* and sidebar-* tokens are for charts and the sidebar only: for a status color the theme has no token for (success, warning, info), add a token or keep the Tailwind color as check_ui says, and never use a chart-* or sidebar-* token for it.
4. Run check_ui on every snippet or file you write and fix all errors before you finish.
In a monorepo served from its root, pass \`path\` (the file you are editing) to list_components, get_component, search_components and get_tokens, and \`path\` or \`filename\` to check_ui, so each answer comes from that file's own project.`;

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

/** What a client may cache: what never changes while the server runs, and what does. */
const STATIC = { ttlMs: 3_600_000, cacheScope: 'private' } as const;
const FRESH = { ttlMs: 0, cacheScope: 'private' } as const;

/** Input limits, so one oversized request cannot stall the server. */
const MAX_NAME = 256;
const MAX_QUERY = 1000;
const MAX_PATH = 4096;
/** Larger than any hand-written source file; generated bundles are not UI to check. */
const MAX_CODE = 1_000_000;
/** Diagnostics check_ui returns by default: a 3,000-line file can have thousands, more than a context holds. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 1000;
/**
 * check_ui's answer for a path or filename that is not JS or TS. `fix`: what to do instead,
 * for a `filename` given with code (the code itself may be fine).
 */
function notScript(name: string, fix = ''): Reply {
  return failure(
    `check_ui checks .tsx, .jsx, .ts and .js files; ${name} is not one, so it was not checked.${fix}`,
  );
}

/**
 * An integer, without the ±9007199254740991 bounds zod adds to the JSON Schema,
 * which every client would otherwise read in each tool definition.
 */
const int = () => z.number().int().meta({ minimum: undefined, maximum: undefined });

/** At a workspace root, where a component comes from. */
const originShape = {
  package: z
    .string()
    .optional()
    .describe('At a workspace root: the package its source belongs to, e.g. "@acme/ui".'),
  projects: z
    .array(z.string())
    .optional()
    .describe('At a workspace root: the folders of the projects that use it.'),
};

const diagnosticSchema = z.object({
  ruleId: z.string(),
  severity: z.enum(['error', 'warning']),
  message: z.string(),
  line: int(),
  column: int(),
  endLine: int(),
  endColumn: int(),
  source: z.string(),
  suggestion: z.string().optional(),
  fix: z
    // Two integers, not a tuple: a tuple's 2020-12 `prefixItems` fails clients that validate as draft-07.
    .array(z.object({ range: z.array(int()).length(2), text: z.string() }))
    .optional()
    .describe('Edits (0-based offsets into the checked code) that apply the suggestion.'),
});

const deprecatedSchema = z.union([z.string(), z.literal(true)]).optional();
const componentSchema = {
  name: z.string().describe('How the component is written in JSX: Button, CardHeader, Tabs.List.'),
  aliases: z.array(z.string()),
  description: z.string().optional(),
  deprecated: deprecatedSchema,
  importPath: z.string(),
  exportName: z.string(),
  source: z.object({ file: z.string(), line: int() }),
  parent: z.string().optional(),
  subcomponents: z.array(z.string()),
  element: z.string().optional().describe('The native element it renders or wraps.'),
  props: z.array(
    z.object({
      name: z.string(),
      type: z.string(),
      required: z.boolean(),
      default: z.string().optional(),
      description: z.string().optional(),
      values: z.array(z.string()).optional(),
      deprecated: deprecatedSchema,
      kind: z.enum(['prop', 'variant']),
    }),
  ),
  inherits: z.array(
    z.object({
      from: z.string(),
      count: int(),
      set: z.string(),
      deprecated: z.array(z.string()).optional(),
    }),
  ),
  openProps: z
    .boolean()
    .describe('Part of the props type did not resolve; extra props may be accepted.'),
  variants: z.array(
    z.object({
      name: z.string(),
      values: z.array(z.string()),
      default: z.string().optional(),
      classes: z.record(z.string(), z.string()),
    }),
  ),
  compoundVariants: z.array(
    z.object({
      when: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
      classes: z.string(),
    }),
  ),
  examples: z.array(
    z.object({
      title: z.string().optional(),
      code: z.string(),
      lang: z.string(),
      source: z.enum(['docs', 'jsdoc']),
    }),
  ),
  docs: z
    .object({
      file: z.string(),
      description: z.string().optional(),
      sections: z.array(z.object({ heading: z.string(), body: z.string() })),
      frontmatter: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
    })
    .optional(),
  classNames: z.array(z.string()),
  cssVars: z.array(z.string()),
  // What a component read from a package's type declarations (MUI's, a design-system
  // package's) has besides: without them, a client that checks the output schema rejects it.
  library: z
    .string()
    .optional()
    .describe('The published package it is read from, by its type declarations: "@mui/material".'),
  polymorphic: z
    .string()
    .optional()
    .describe(
      'A prop that renders another element or component in its place, with its props: "component".',
    ),
  defaultImport: z
    .string()
    .optional()
    .describe('Another module that exports it as its default: "@mui/material/Button".'),
  labelsChild: z
    .object({ prop: z.string(), unless: z.string().optional() })
    .optional()
    .describe(
      "A prop whose text is its child element's accessible name (MUI Tooltip's title), unless `unless` is set.",
    ),
  import: z.string().describe('The import statement to use.'),
  tokens: z.array(z.string()).describe('Names of the design tokens its classes use.'),
  ...originShape,
};

const componentSummarySchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  importPath: z.string(),
  element: z.string().optional(),
  variants: z.record(z.string(), z.array(z.string())).optional().describe('Left out when none.'),
  subcomponents: z.array(z.string()).optional().describe('Left out when none.'),
  ...originShape,
});

const tokenSchema = z.object({
  name: z.string(),
  category: z.enum(TOKEN_CATEGORIES),
  value: z.string(),
  modes: z.record(z.string(), z.string()).optional(),
  cssVar: z.string().optional(),
  tailwind: z.string().optional(),
  usage: z.array(z.string()),
  description: z.string().optional(),
  ...originShape,
});

/** The optional `path` that picks a project at a workspace root. */
const projectPath = z
  .string()
  .max(MAX_PATH)
  .optional()
  .describe(
    'In a monorepo served from its root: the file you are editing, or a project folder, relative to the root, to answer from that project. Without it, every project is listed together. Ignored in a single project. When the server was started outside your project, pass the file as an absolute path: the project is found from it.',
  );

export interface CreateServerOptions {
  /**
   * Resolves the design system to serve. Called per request, so it can be swapped on reload.
   * `target` is the `path` (or `filename`) the request names, if any, as given.
   */
  getDesignSystem: (target?: string) => Promise<DesignSystem>;
  /**
   * At a workspace root: its projects. When this resolves to a set, the tools take a `path`
   * to pick a project and serve every project together without one, and `getDesignSystem`
   * is not called. `target` is the `path` (or `filename`) the request names, if any.
   */
  getProjects?: (target?: string) => Promise<ProjectSet | undefined>;
}

/**
 * Thrown by `getDesignSystem` or `getProjects` when nothing says which project a request is
 * about: the server was started outside any project, and the request names no absolute path.
 * Tools return its message as an error result; listing resources returns none.
 */
export class ProjectNotFoundError extends Error {
  override name = 'ProjectNotFoundError';
}

/** What a request is answered from: one design system, or a workspace root's projects. */
type Scope =
  | { ds: DesignSystem; project?: ServedProject; root?: string }
  | { set: ProjectSet; catalog: Catalog };

/** A component's source path relative to `root`, the workspace root the client knows. */
function fromRoot(ds: DesignSystem, component: ComponentInfo, root: string | undefined) {
  if (!root || root === ds.root) return component;
  const file = relativePath(root, path.resolve(ds.root, component.source.file));
  return { ...component, source: { ...component.source, file } };
}

/** `a, b and c`, `a, b, c and 4 more`. */
function listOf(items: readonly string[], max: number): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length <= max) return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

// The response boundary. Every text this server sends about the project is an `Answer`, which
// only `answer()` in render.ts makes: a tool's text through `reply` or `refuse`, a resource's
// through `contents`, the prompt's through `prompted`, a resource's description through
// `resourceDescription`, and what a handler throws, whatever its message holds (a config key, a
// path), through `guard` and `rethrown`. Every tool, resource and prompt is registered through
// `Registrar`, which wraps each handler in one of those two, and each handler's return type takes
// only what those make. So no line of it starts with text the repository wrote, unmarked, and
// nothing is appended to an answer after it is built.

declare const SENT: unique symbol;
/** A tool result that `reply` or `refuse` made, so its text is an `Answer`. */
type Reply = CallToolResult & { readonly [SENT]: true };
/** A resource read that `contents` made. */
type Contents = ReadResourceResult & { readonly [SENT]: true };
/** A prompt that `prompted` made. */
type Prompted = GetPromptResult & { readonly [SENT]: true };

function reply(text: Answer, structuredContent: Record<string, unknown>): Reply {
  const result: CallToolResult = { content: [{ type: 'text', text }], structuredContent };
  return result as Reply;
}

function refuse(text: Answer): Reply {
  const result: CallToolResult = { isError: true, content: [{ type: 'text', text }] };
  return result as Reply;
}

/** An error result for `message` on one line: any line break in it is escaped. */
function failure(message: string): Reply {
  return refuse(answer([message]));
}

/** Thrown with an answer to send as it is (an ambiguous name's list), not as one line. */
class AnswerError extends Error {
  constructor(readonly answer: Answer) {
    super(answer);
  }
}

/** What an error says, as an answer: an `AnswerError`'s answer, or its message on one line. */
function errorText(error: unknown): Answer {
  if (error instanceof AnswerError) return error.answer;
  return answer([error instanceof Error ? error.message : String(error)]);
}

/** Runs a tool's handler; what it throws is an error result whose text is an answer too. */
async function guard(handler: () => Promise<Reply>): Promise<CallToolResult> {
  try {
    return await handler();
  } catch (error) {
    return refuse(errorText(error));
  }
}

/** Runs a resource or completion handler; what it throws, it throws with an answer. */
async function rethrown<T>(handler: () => Promise<T>): Promise<T> {
  try {
    return await handler();
  } catch (error) {
    throw new Error(errorText(error), { cause: error });
  }
}

/** A component in the resource list: its description is an answer, its name an identifier. */
interface ListedResource {
  uri: string;
  name: string;
  title: string;
  description?: Answer;
  mimeType: string;
}

/** What a handler is given: the arguments its schema parses. */
type Parsed<S extends StandardSchemaWithJSON> = StandardSchemaWithJSON.InferOutput<S>;

/**
 * Registers the server's tools, resources and prompts, each handler wrapped at the response
 * boundary: a tool's in `guard`, so what it throws is an error result whose text is an answer;
 * a resource's, its listing's, a completion's and the prompt's in `rethrown`, so what they throw
 * carries an answer. Each handler's type takes only what `reply`, `refuse`, `contents` and
 * `prompted` make. `createServer` registers through it alone.
 */
class Registrar {
  constructor(private readonly server: McpServer) {}

  tool<Input extends StandardSchemaWithJSON>(
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: Input;
      outputSchema: StandardSchemaWithJSON;
      annotations: ToolAnnotations;
    },
    handler: (args: Parsed<Input>) => Promise<Reply>,
  ): void {
    const run = (args: Parsed<Input>) => guard(() => handler(args));
    // The SDK's callback type is conditional on the schema, which TypeScript cannot resolve for
    // a generic one: `run` is that callback for a schema, which `Input` always is.
    this.server.registerTool(name, config, run as ToolCallback<Input>);
  }

  resource(
    name: string,
    uri: string,
    config: ResourceMetadata,
    read: (uri: URL) => Promise<Contents>,
  ): void {
    this.server.registerResource(name, uri, config, (url) => rethrown(() => read(url)));
  }

  /** A resource template: its `uri` with `{variables}`, how to list it and to complete each one. */
  template(
    name: string,
    template: {
      uri: string;
      list: () => Promise<{ resources: ListedResource[] }>;
      complete: Record<string, (value: string) => Promise<string[]>>;
    },
    config: ResourceMetadata,
    read: (uri: URL, variables: Variables) => Promise<Contents>,
  ): void {
    const complete = Object.fromEntries(
      Object.entries(template.complete).map(([variable, values]) => [
        variable,
        (value: string) => rethrown(() => values(value)),
      ]),
    );
    const list = () => rethrown(template.list);
    this.server.registerResource(
      name,
      new ResourceTemplate(template.uri, { list, complete }),
      config,
      (url, variables) => rethrown(() => read(url, variables)),
    );
  }

  prompt<Args extends StandardSchemaWithJSON>(
    name: string,
    config: { title: string; description: string; argsSchema: Args },
    handler: (args: Parsed<Args>) => Promise<Prompted>,
  ): void {
    const run = (args: Parsed<Args>): Promise<GetPromptResult> => rethrown(() => handler(args));
    // As for a tool's callback.
    this.server.registerPrompt(name, config, run as PromptCallback<Args>);
  }
}

/** A resource's contents, whose text is an answer. */
function contents(uri: URL, mimeType: string, text: Answer): Contents {
  const result: ReadResourceResult = { contents: [{ uri: uri.href, mimeType, text }] };
  return result as Contents;
}

/** A prompt's one message, whose text is an answer. */
function prompted(description: string, text: Answer): Prompted {
  const result: GetPromptResult = {
    description,
    messages: [{ role: 'user', content: { type: 'text', text } }],
  };
  return result as Prompted;
}

function origin(entry: CatalogEntry): { package: string; projects: string[] } {
  return { package: entry.package, projects: entry.projects };
}

/** A component in list_components, without the fields it has nothing in. */
function summary(c: ComponentInfo) {
  const description = descriptionOf(c);
  return {
    name: c.name,
    ...(description ? { description } : {}),
    importPath: c.importPath,
    ...(c.element ? { element: c.element } : {}),
    ...(c.variants.length
      ? { variants: Object.fromEntries(c.variants.map((v) => [v.name, v.values])) }
      : {}),
    ...(c.subcomponents.length ? { subcomponents: c.subcomponents } : {}),
  };
}

/** list_components' structured content: what its text lists, as it lists it. */
function listContent<T>(
  listed: Listing<T>,
  component: (item: T) => ComponentInfo,
  originOf?: (item: T) => { package: string; projects: string[] },
) {
  return {
    components: listed.shown.map((item) => ({
      ...summary(component(item)),
      ...originOf?.(item),
    })),
    ...(listed.icons.length
      ? {
          icons: listed.icons.map(({ from, items, folder }) => ({
            from,
            names: items.map((item) => component(item).name),
            ...(folder ? { modules: items.map((item) => component(item).importPath) } : {}),
            ...(originOf && items[0] ? { package: originOf(items[0]).package } : {}),
          })),
        }
      : {}),
    ...(listed.omitted ? { omitted: listed.omitted } : {}),
  };
}

/** A resource's description: the first sentence of the component's, quoted when it is the repository's. */
function describedAs(component: ComponentInfo): { description?: Answer } {
  const description = resourceDescription(component);
  return description ? { description } : {};
}

/** A search_components result. */
function result(hit: SearchHit) {
  const description = descriptionOf(hit.component);
  return {
    name: hit.component.name,
    ...(hit.component.parent ? { parent: hit.component.parent } : {}),
    ...(description ? { description } : {}),
    importPath: hit.component.importPath,
    score: hit.score,
    matched: hit.matched,
    ...(hit.weak ? { weak: true } : {}),
  };
}

/** Builds the MCP server: five tools, two resources and one prompt. Transport-agnostic. */
export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: NAME, title: 'onsystem', version: VERSION },
    {
      instructions: INSTRUCTIONS,
      capabilities: { resources: { listChanged: true } },
      // 2026-07-28 caching hints. The tools, prompts and templates are fixed for the life of
      // the process; the component resources follow the code, so they are not to be reused.
      // Private: they describe one person's project.
      cacheHints: {
        'server/discover': STATIC,
        'tools/list': STATIC,
        'prompts/list': STATIC,
        'resources/templates/list': STATIC,
        'resources/list': FRESH,
        'resources/read': FRESH,
      },
    },
  );
  register(new Registrar(server), options);
  return server;
}

/**
 * Registers the tools, resources and prompt through `serve`, the only way here to the server (no
 * `McpServer` is in scope), so each handler is wrapped at the response boundary.
 */
function register(serve: Registrar, { getDesignSystem, getProjects }: CreateServerOptions): void {
  /** The design system for `target` at a workspace root, or the merged catalog without one. */
  const scope = async (target?: string): Promise<Scope> => {
    const set = await getProjects?.(target);
    if (!set) return { ds: await getDesignSystem(target) };
    if (target !== undefined && target !== '') {
      const project = await set.forPath(target);
      return { ds: project.ds, project, root: set.root };
    }
    return { set, catalog: await set.catalog() };
  };
  /** `scope`, with a path outside the workspace as an error result instead of a throw. */
  const scoped = async (target?: string): Promise<Scope | Reply> => {
    try {
      return await scope(target);
    } catch (error) {
      return refuse(errorText(error));
    }
  };
  const isResult = (value: Scope | Reply): value is Reply => 'content' in value;
  /** `scope` without a target, for listings: none yet, when no project is known. */
  const listed = async (): Promise<Scope | undefined> => {
    try {
      return await scope();
    } catch (error) {
      if (error instanceof ProjectNotFoundError) return undefined;
      throw error;
    }
  };

  serve.tool(
    'list_components',
    {
      title: 'List design-system components',
      description:
        'List every component in the project design system with a one-line description, the native element it renders, its variant values, its parts and its import. Icons (components that render an <svg>) are named on one line per import, or per folder for icons with a module each, five or more to a line. Call this before writing UI in this project. `query`, `kind` and `limit` narrow a long list. At a monorepo root, pass `path` for the project of the file you are editing; without it, every project is listed, each component with its package.',
      inputSchema: z.object({
        query: z
          .string()
          .max(MAX_QUERY)
          .optional()
          .describe(
            "Only components with this text in their name, their parts' names or their description.",
          ),
        kind: z
          .enum(['component', 'icon'])
          .optional()
          .describe(
            '"icon": only the components that render an <svg>, one by one. "component": all the others.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .optional()
          .describe('Most components to list one by one.'),
        path: projectPath,
      }),
      outputSchema: z.object({
        components: z
          .array(componentSummarySchema)
          .describe('The components listed one by one, after `query`, `kind` and `limit`.'),
        icons: z
          .array(
            z.object({
              from: z
                .string()
                .describe(
                  'The module they are imported from, or, with `modules`, the folder of their modules.',
                ),
              names: z.array(z.string()),
              modules: z
                .array(z.string())
                .optional()
                .describe(
                  "For icons with a module each: each one's module, in the order of `names`.",
                ),
              package: originShape.package,
            }),
          )
          .optional()
          .describe(
            'Without `kind`: icons, the components that render an <svg>, by name, five or more per module, or per folder for icons with a module each.',
          ),
        omitted: int().optional().describe('Matching components left out by `limit`.'),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, kind, limit, path: target }) => {
      const found = await scoped(target);
      if (isResult(found)) return found;
      const filter = { query, kind, limit };
      if ('catalog' in found) {
        const { catalog } = found;
        const listed = listComponents(
          catalog.roots(),
          (entry) => entry.component,
          filter,
          (entry) => entry.package,
        );
        return reply(
          renderCatalogList(catalog, filter),
          listContent(listed, (entry) => entry.component, origin),
        );
      }
      const { ds } = found;
      const listed = listComponents(ds.roots(), (c) => c, filter);
      return reply(
        renderComponentList(ds, found.project?.dir, filter),
        listContent(listed, (c) => c),
      );
    },
  );

  serve.tool(
    'get_component',
    {
      title: 'Get a component contract',
      description:
        'Get the full contract of one component: import, props with types and defaults, cva variants and the classes each applies, parts (sub-components), design tokens it uses, usage guidelines and examples from its docs. Call it before using a component. Accepts "Button", "CardHeader" or "Card.Header". At a monorepo root, pass `path` (the file you are editing) to get the component its project uses.',
      inputSchema: z.object({
        name: z
          .string()
          .min(1)
          .max(MAX_NAME)
          .describe('Component name, e.g. "Button" or "CardHeader".'),
        path: projectPath,
      }),
      outputSchema: z.object(componentSchema),
      annotations: READ_ONLY,
    },
    async ({ name, path: target }) => {
      const found = await scoped(target);
      if (isResult(found)) return found;
      if ('catalog' in found) {
        const { catalog } = found;
        const matches = catalog.find(name);
        const [entry] = matches;
        if (!entry) {
          if (!catalog.roots().length) {
            return refuse(noComponentsMessage(catalog.root, undefined, true));
          }
          const names = [...new Set(catalog.roots().map((e) => e.component.name))];
          return refuse(renderNotFound(name, catalog.suggest(name), names, ' in any project'));
        }
        if (matches.length > 1) return refuse(renderAmbiguous(name, matches));
        const description = descriptionOf(entry.component);
        return reply(renderComponent(entry.ds, entry.component, entry, name), {
          ...entry.component,
          ...(description ? { description } : {}),
          import: importStatement(entry.component),
          tokens: entry.ds.relatedTokens(entry.component).map((t) => t.name),
          ...origin(entry),
        });
      }
      const { ds } = found;
      const component = ds.getComponent(name);
      if (!component) {
        if (!ds.roots().length) return refuse(noComponentsMessage(ds.root, found.project?.dir));
        const names = ds.roots().map((c) => c.name);
        return refuse(renderNotFound(name, ds.suggestComponent(name), names));
      }
      const shown = fromRoot(ds, component, found.root);
      const description = descriptionOf(component);
      return reply(renderComponent(ds, shown, undefined, name), {
        ...shown,
        ...(description ? { description } : {}),
        import: importStatement(component),
        tokens: ds.relatedTokens(component).map((t) => t.name),
      });
    },
  );

  serve.tool(
    'search_components',
    {
      title: 'Search components by intent',
      description:
        'Find components by what you want to build, e.g. "confirm a destructive action", "status label", "text field with validation". Ranks names, descriptions, docs, props and variant values with BM25 (local, no API key). When no component clearly matches, it says so and lists the nearest, marked `weak`. Use it when you do not know which component fits.',
      inputSchema: z.object({
        query: z.string().min(1).max(MAX_QUERY).describe('What the UI should do, in plain words.'),
        limit: z.number().int().min(1).max(20).default(5).describe('Maximum results.'),
        path: projectPath,
      }),
      outputSchema: z.object({
        results: z.array(
          z.object({
            name: z.string(),
            parent: z.string().optional(),
            description: z.string().optional(),
            importPath: z.string(),
            score: z.number(),
            matched: z.array(z.string()),
            weak: z
              .boolean()
              .optional()
              .describe(
                'Set when no component clearly matches the query: each result has only a word or two in common with it.',
              ),
            ...originShape,
          }),
        ),
      }),
      annotations: READ_ONLY,
    },
    async ({ query, limit, path: target }) => {
      const found = await scoped(target);
      if (isResult(found)) return found;
      if ('catalog' in found) {
        const hits = found.catalog.search(query, limit);
        return reply(renderCatalogSearch(query, hits), {
          results: hits.map((h) => ({ ...result(h), ...origin(h.entry) })),
        });
      }
      const hits = found.ds.search(query, limit);
      return reply(renderSearch(query, hits), { results: hits.map(result) });
    },
  );

  serve.tool(
    'get_tokens',
    {
      title: 'Get design tokens',
      description:
        'List design tokens with resolved values, dark-mode values and how to use each (Tailwind class or CSS variable). Filter by category (color, spacing, radius, typography, shadow, other) or a substring. Use these instead of hex codes, px values or Tailwind default palette classes. Chart and sidebar colors are listed under their own headings: they are for charts and the sidebar, not for status colors.',
      inputSchema: z.object({
        category: z.enum(TOKEN_CATEGORIES).optional().describe('Only tokens of this category.'),
        query: z
          .string()
          .max(MAX_QUERY)
          .optional()
          .describe('Substring to match in names, usages or descriptions.'),
        path: projectPath,
      }),
      outputSchema: z.object({ tokens: z.array(tokenSchema) }),
      annotations: READ_ONLY,
    },
    async ({ category, query, path: target }) => {
      const found = await scoped(target);
      if (isResult(found)) return found;
      if ('catalog' in found) {
        const tokens = found.catalog.getTokens({ category, query });
        return reply(renderCatalogTokens(found.catalog, tokens, { category, query }), {
          tokens: tokens.map(({ token: t, package: pkg, projects }) => ({
            name: t.name,
            category: t.category,
            value: t.value,
            ...(t.modes ? { modes: t.modes } : {}),
            ...(t.cssVar ? { cssVar: t.cssVar } : {}),
            ...(t.tailwind !== undefined ? { tailwind: t.tailwind } : {}),
            usage: t.usage,
            ...(t.description ? { description: t.description } : {}),
            package: pkg,
            projects,
          })),
        });
      }
      const { ds } = found;
      const tokens = ds.getTokens({ category, query });
      return reply(renderTokens(ds, tokens, { category, query }), {
        tokens: tokens.map((t) => ({
          name: t.name,
          category: t.category,
          value: t.value,
          ...(t.modes ? { modes: t.modes } : {}),
          ...(t.cssVar ? { cssVar: t.cssVar } : {}),
          ...(t.tailwind !== undefined ? { tailwind: t.tailwind } : {}),
          usage: t.usage,
          ...(t.description ? { description: t.description } : {}),
        })),
      });
    },
  );

  serve.tool(
    'check_ui',
    {
      title: 'Check UI code against the design system',
      description:
        'Lint TSX/JSX against the design system. Reports hardcoded colors, spacing and radius (with the nearest token), native elements that have a design-system component, unknown components, props and variant values, and icon-only buttons without an accessible name. Each diagnostic has line/column, a rule id, a message and a suggested fix. Run it on every snippet or file you write and fix all errors. Pass `path` for a file in the project, or `code` for unsaved code, with `path` (or `filename`) naming the file it is for or its project folder.',
      inputSchema: z.object({
        code: z
          .string()
          .max(MAX_CODE)
          .optional()
          .describe(`TSX/JSX source to check (up to ${MAX_CODE.toLocaleString('en')} characters).`),
        path: z
          .string()
          .max(MAX_PATH)
          .optional()
          .describe(
            'Path of a .tsx, .jsx, .ts or .js file, relative to the project root (the monorepo root, when served from there) or absolute: the file to check, or, with `code`, the file the code is for, as `filename`. With `code`, a project folder only picks the project.',
          ),
        filename: z
          .string()
          .max(MAX_PATH)
          .optional()
          .describe(
            'Name to report `code` under; a .jsx extension parses it as JSX. At a monorepo root, the path the code will be saved under, which picks the project whose design system checks it. When the server was started outside your project, pass it as an absolute path: the project is found from it.',
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIMIT)
          .default(DEFAULT_LIMIT)
          .describe(
            `Most diagnostics to return, errors first (default ${DEFAULT_LIMIT}). The counts and byRule cover all of them.`,
          ),
      }),
      outputSchema: z.object({
        file: z.string(),
        ok: z.boolean().describe('True when there are no errors.'),
        errorCount: int(),
        warningCount: int(),
        diagnostics: z
          .array(diagnosticSchema)
          .describe(
            'Up to `limit` diagnostics, errors first; `omitted` says how many more there are.',
          ),
        omitted: int().describe('Diagnostics left out by `limit`.'),
        byRule: z
          .record(z.string(), z.object({ errors: int(), warnings: int() }))
          .describe('Every finding per rule, shown or not.'),
        skipped: z
          .string()
          .optional()
          .describe(
            "Why the file was not checked: it renders an image (next/og) or an email, or the config's `exclude` leaves it out.",
          ),
        unchecked: z
          .object({ names: z.array(z.string()), modules: z.array(z.string()) })
          .optional()
          .describe('Components imported from modules the model does not include, not checked.'),
        notice: z
          .string()
          .optional()
          .describe(
            'Set when no components or no color tokens were found, so rules did not run, when components came from modules the model does not include, when the project depends on a component library onsystem does not read yet, or when its dependencies are not installed.',
          ),
      }),
      annotations: READ_ONLY,
    },
    async ({ code, path: filePath, filename: given, limit }) => {
      if (code === undefined && !filePath) return failure('Pass either `code` or `path`.');
      if (code !== undefined && given !== undefined && !SCRIPT_FILE.test(given)) {
        return notScript(
          given,
          ' Pass as `filename` the .tsx path the code is for, or leave `filename` out.',
        );
      }
      // With `code`, a `path` to a .tsx (or other script) file names the file the code is for,
      // as `filename` does: the other tools take `path` for the file being edited, and agents
      // pass it here the same way. Any other `path` (a project folder, `.`) only picks the
      // project, as it does for the other tools, and the code is checked as snippet.tsx.
      const folder =
        code !== undefined && filePath && !SCRIPT_FILE.test(filePath) ? filePath : undefined;
      const filename =
        code === undefined || folder !== undefined ? given : (given ?? (filePath || undefined));
      // At a workspace root, the file's own project checks it.
      let routeBy = code === undefined ? filePath : (filename ?? folder);
      const set = await getProjects?.(routeBy);
      // The workspace root itself, as a folder, picks no project unless it is one.
      if (
        set &&
        folder !== undefined &&
        routeBy === folder &&
        path.resolve(set.root, folder) === set.root &&
        !set.dirs.includes('.')
      ) {
        routeBy = undefined;
      }
      let ds: DesignSystem;
      if (!set) {
        ds = await getDesignSystem(routeBy);
      } else if (routeBy) {
        const found = await scoped(routeBy);
        if (isResult(found)) return found;
        if (!('ds' in found)) return failure(`Cannot find the project of ${routeBy}.`);
        ds = found.ds;
      } else if (set.dirs.length <= 1) {
        ds = (await set.forPath(set.dirs[0] ?? '.')).ds;
      } else {
        const dirs = set.dirs.map(pathOf);
        return failure(
          `This is a monorepo root with ${set.dirs.length} projects (${listOf(dirs, 6)}). Pass \`filename\`, the path the code will be saved under relative to the root, so the right project's design system checks it.`,
        );
      }
      // Paths are relative to the root the client knows: the workspace root, when served from there.
      const base = set?.root ?? ds.root;
      let source = code;
      let file = filename ?? 'snippet.tsx';
      let shown = file;
      if (filename) {
        // Checked under its path in the project, so `overrides` apply to an absolute `filename` too.
        const absolute = path.resolve(base, filename);
        if (set || isInside(ds.root, absolute)) file = relativePath(ds.root, absolute);
      }
      if (source === undefined) {
        if (!filePath) return failure('Pass either `code` or `path`.');
        const absolute = path.resolve(base, filePath);
        const outside = failure(`${filePath} is outside the project root (${base}).`);
        if (!isInside(base, absolute)) return outside;
        if (!SCRIPT_FILE.test(absolute)) return notScript(filePath);
        try {
          // A symlink inside the root can point anywhere: compare where both really are.
          const [root, real] = await Promise.all([fs.realpath(base), fs.realpath(absolute)]);
          if (!isInside(root, real)) return outside;
          if ((await fs.stat(real)).size > MAX_CODE) {
            return failure(`${filePath} is too large to check.`);
          }
          source = await fs.readFile(real, 'utf8');
        } catch {
          return failure(`Cannot read ${filePath}.`);
        }
        file = relativePath(ds.root, absolute);
        shown = relativePath(base, absolute);
      }
      // A file the config's `exclude` covers is left out, as `check .`, the ESLint plugin and
      // the hook leave it out. Code without a filename is checked.
      const excluded =
        (filename !== undefined || code === undefined) && !path.isAbsolute(file)
          ? excludedBy(ds.config, file)
          : undefined;
      const checked = excluded
        ? {
            file,
            diagnostics: [],
            errorCount: 0,
            warningCount: 0,
            skipped: `It is left out by ${json(excluded)} in the config's exclude, as in check, the ESLint plugin and the Claude Code hook.`,
          }
        : ds.check(source, file);
      const result = file === shown ? checked : { ...checked, file: shown };
      const capped = capDiagnostics(result, limit);
      // A clean result without components or color tokens, with components the model leaves
      // out, or with what was not read (a library, the dependencies), says little.
      const notices = result.skipped
        ? []
        : [ds.notice(), ...notReadNotices([{ ds }]), uncheckedNotice([result])].filter(
            (notice): notice is string => Boolean(notice),
          );
      const notice = notices.join('\n\n') || undefined;
      return reply(renderCheck(result, capped, notices), {
        ...result,
        diagnostics: capped.shown,
        omitted: capped.omitted,
        byRule: capped.byRule,
        ok: result.errorCount === 0,
        ...(notice ? { notice } : {}),
      });
    },
  );

  serve.template(
    'component',
    {
      uri: 'ds://components/{name}',
      list: async () => {
        const found = await listed();
        if (!found) return { resources: [] };
        if ('catalog' in found) {
          return {
            resources: found.catalog.entries.map(({ component: c, ambiguous, projects }) => ({
              // Two components under one name: the query names the project that has each.
              uri: `ds://components/${c.name}${ambiguous ? `?path=${encodeURIComponent(projects[0] ?? '.')}` : ''}`,
              name: c.name,
              title: c.name,
              ...describedAs(c),
              mimeType: 'text/markdown',
            })),
          };
        }
        return {
          resources: found.ds.components.map((c) => ({
            uri: `ds://components/${c.name}`,
            name: c.name,
            title: c.name,
            ...describedAs(c),
            mimeType: 'text/markdown',
          })),
        };
      },
      complete: {
        name: async (value) => {
          const found = await listed();
          if (!found) return [];
          const lower = value.toLowerCase();
          const names =
            'catalog' in found
              ? found.catalog.entries.map((e) => e.component.name)
              : found.ds.components.map((c) => c.name);
          return [...new Set(names)].filter((n) => n.toLowerCase().startsWith(lower));
        },
      },
    },
    {
      title: 'Design-system component',
      description: 'Props, variants, parts, tokens, guidelines and examples for one component.',
      mimeType: 'text/markdown',
    },
    async (uri, { name }) => {
      // `{name}` takes the query along: `Button?path=apps%2Fweb`.
      const wanted = decodeURIComponent(String(name).split('?')[0] ?? '');
      const found = await scope(uri.searchParams.get('path') ?? undefined);
      if ('catalog' in found) {
        const matches = found.catalog.find(wanted);
        const [entry] = matches;
        if (!entry) throw new AnswerError(answer([`No component named ${json(wanted)}.`]));
        if (matches.length > 1) throw new AnswerError(renderAmbiguous(wanted, matches));
        const text = renderComponent(entry.ds, entry.component, entry);
        return contents(uri, 'text/markdown', text);
      }
      const { ds } = found;
      const component = ds.getComponent(wanted);
      if (!component) throw new AnswerError(answer([`No component named ${json(wanted)}.`]));
      const text = renderComponent(ds, fromRoot(ds, component, found.root));
      return contents(uri, 'text/markdown', text);
    },
  );

  serve.resource(
    'tokens',
    'ds://tokens',
    {
      title: 'Design tokens',
      description: 'Every design token with resolved values, modes and usages, as JSON.',
      mimeType: 'application/json',
    },
    async (uri) => {
      const found = await scope();
      const tokens =
        'catalog' in found
          ? found.catalog
              .getTokens()
              .map(({ token, package: pkg, projects }) => ({ ...token, package: pkg, projects }))
          : found.ds.getTokens();
      // JSON escapes every line break in a string but U+0085, U+2028 and U+2029, which
      // `answer` escapes as JSON does (`\u2028`), so the JSON stays valid.
      const text = answer(JSON.stringify(tokens, null, 2).split('\n'));
      return contents(uri, 'application/json', text);
    },
  );

  serve.prompt(
    'build-with-design-system',
    {
      title: 'Build UI with the design system',
      description:
        'Build a piece of UI using only design-system components and tokens, then verify it with check_ui.',
      argsSchema: z.object({
        task: z
          .string()
          .max(MAX_QUERY * 4)
          .describe('What to build, e.g. "a settings card that lets owners delete the workspace".'),
      }),
    },
    async ({ task }) => {
      const found = await scope();
      const roots =
        'catalog' in found
          ? [...new Map(found.catalog.roots().map((e) => [e.component.name, e.component])).values()]
          : found.ds.roots();
      const allTokens =
        'catalog' in found ? found.catalog.getTokens().map((t) => t.token) : found.ds.tokens;
      const text = renderPrompt(
        task,
        roots,
        allTokens,
        'catalog' in found ? found.set.dirs : undefined,
      );
      return prompted('Build UI with the design system', text);
    },
  );
}
