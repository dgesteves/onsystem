import type { ReactNode } from 'react';

const STYLES = {
  2: 'mt-12 text-2xl',
  3: 'mt-9 text-lg',
  4: 'mt-7 text-[15.5px]',
} as const;

/** The id of a heading's visible text, for a section labelled by the heading. */
export function headingTextId(id: string): string {
  return `${id}-text`;
}

/**
 * A section heading with a link to itself: a `#` that shows on hover or focus, so a section's
 * URL can be copied. `toc` puts it in "On this page" (h2 and h3 by default). The heading is named
 * by its visible text alone, not by the link's.
 */
export function AnchorHeading({
  level,
  look = level,
  id,
  label,
  toc = level <= 3,
  className = '',
  children,
}: {
  level: 2 | 3 | 4;
  /** The size it is set in, when that differs from its level. */
  look?: 2 | 3 | 4;
  id: string;
  /** The heading as plain text, for the link's name and "On this page". */
  label: string;
  toc?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const Tag = `h${String(level)}` as 'h2' | 'h3' | 'h4';
  return (
    <Tag
      id={id}
      data-toc={toc ? label : undefined}
      data-level={level}
      className={`group scroll-mt-28 font-semibold tracking-tight text-fg first:mt-0 lg:scroll-mt-20 ${STYLES[look]} ${className}`}
      aria-labelledby={headingTextId(id)}
    >
      <span id={headingTextId(id)}>{children}</span>
      <a
        href={`#${id}`}
        className="ml-2 inline-block text-subtle no-underline opacity-0 transition-opacity group-hover:opacity-100 hover:text-cyan focus-visible:opacity-100"
      >
        <span aria-hidden="true">#</span>
        <span className="sr-only">Link to the section {label}</span>
      </a>
    </Tag>
  );
}

/** Inline Markdown as plain text, for labels: no backticks, links reduced to their text. */
export function plainLabel(markdown: string): string {
  return markdown
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\*\*|`/g, '')
    .replace(/(?<!\w)_(\S.*?)_(?!\w)/g, '$1')
    .trim();
}
