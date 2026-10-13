import { Code } from '@/components/code';
import { AnchorHeading, headingTextId } from '@/components/heading';
import { ArrowUpRightIcon } from '@/components/icons';
import { InlineCode } from '@/components/section';
import { DOCS_MCP } from '@/lib/docs-mcp';

const ID = 'use-these-docs-from-your-agent';
const TITLE = 'Use these docs from your agent';

const button =
  'group inline-flex items-center gap-2 rounded-lg border border-line-strong bg-raised-2 px-3 py-1.5 text-sm font-medium text-fg transition-colors hover:border-cyan/60';
const link = 'text-fg underline decoration-line-strong underline-offset-4 hover:decoration-cyan';

/** "Use these docs from your agent": the docs' MCP server, the ways to add it, and llms.txt. */
export function DocsForAgents() {
  return (
    <section
      aria-labelledby={headingTextId(ID)}
      className="mt-14 rounded-2xl border border-line bg-raised p-5 sm:p-6"
    >
      <AnchorHeading level={2} id={ID} label={TITLE}>
        {TITLE}
      </AnchorHeading>
      <p className="mt-3 text-[15px] leading-relaxed text-muted">
        These docs are an MCP server at <InlineCode>{DOCS_MCP.url}</InlineCode>, so your agent can
        search and read them. Its searches call no model. It is separate from onsystem&apos;s own
        server, which checks your code.
      </p>
      <div className="mt-4 flex flex-wrap gap-2.5">
        {(
          [
            ['Add to Cursor', DOCS_MCP.cursor],
            ['Add to VS Code', DOCS_MCP.vscode],
            ['Add to Claude', DOCS_MCP.claude],
          ] as const
        ).map(([label, href]) => (
          <a key={label} href={href} className={button}>
            {label}
            <ArrowUpRightIcon className="size-4 text-subtle group-hover:text-cyan" />
          </a>
        ))}
      </div>
      <Code
        code={DOCS_MCP.claudeCode}
        lang="sh"
        title="Claude Code"
        copy="Copy the command"
        className="mt-4"
      />
      <p className="mt-4 text-[15px] leading-relaxed text-muted">
        Agents that read files can take{' '}
        <a href="/llms.txt" className={link}>
          llms.txt
        </a>
        , an index of every page, or{' '}
        <a href="/llms-full.txt" className={link}>
          llms-full.txt
        </a>
        , all the docs in one file.
      </p>
    </section>
  );
}
