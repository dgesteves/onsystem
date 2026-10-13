import type { ReactNode } from 'react';

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p
      className={`font-mono text-[11.5px] font-medium tracking-[0.16em] text-cyan uppercase ${className}`}
    >
      {children}
    </p>
  );
}

/** A page section with an eyebrow, a heading and an optional lead paragraph. */
export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
  className = '',
}: {
  id?: string;
  eyebrow?: string;
  title: ReactNode;
  lead?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = id ? `${id}-title` : undefined;
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={`mx-auto w-full max-w-6xl px-4 py-14 sm:px-6 sm:py-20 ${className}`}
    >
      <div className="max-w-3xl">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h2
          id={headingId}
          className="mt-3 text-[1.75rem] leading-[1.15] font-semibold tracking-[-0.02em] text-balance text-fg sm:text-4xl"
        >
          {title}
        </h2>
        {lead && (
          <div className="mt-4 text-base leading-relaxed text-muted sm:text-[17px]">{lead}</div>
        )}
      </div>
      {children && <div className="mt-10 sm:mt-12">{children}</div>}
    </section>
  );
}

/** Code spans longer than this may wrap; shorter ones stay on one line, as a phone's column fits them. */
const SHORT_CODE = 28;

/**
 * Inline code that never breaks inside a flag or a class name (`--root`, `border-destructive`):
 * short code stays on one line, longer code wraps only between its words, and a single word
 * longer than {@link SHORT_CODE} characters breaks anywhere below 40rem, where it would not fit.
 */
export function CodeText({ text }: { text: string }) {
  if (text.length <= SHORT_CODE) return <span className="whitespace-nowrap">{text}</span>;
  return text.split(/( +)/).map((part, i) =>
    /^ +$/.test(part) ? (
      part
    ) : (
      <span
        key={i}
        className={
          part.length > SHORT_CODE
            ? 'max-sm:[overflow-wrap:anywhere] sm:whitespace-nowrap'
            : 'whitespace-nowrap'
        }
      >
        {part}
      </span>
    ),
  );
}

/**
 * The inline code style, shared with the Markdown renderer. A pill that wraps keeps its padding
 * at its two ends only: padding repeated at a line break would reach past the text column.
 */
export const INLINE_CODE = 'rounded bg-fg/[0.06] px-1 py-px font-mono text-fg-soft';

export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className={`${INLINE_CODE} text-[0.88em]`}>
      {typeof children === 'string' ? (
        <CodeText text={children} />
      ) : (
        <span className="whitespace-nowrap">{children}</span>
      )}
    </code>
  );
}

export function TextLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="text-fg underline decoration-line-strong underline-offset-4 transition-colors hover:decoration-cyan"
    >
      {children}
    </a>
  );
}
