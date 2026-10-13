'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A table that scrolls sideways when it is wider than its column. While it overflows it is a
 * named region in the tab order, so the arrow keys can scroll it (axe: scrollable-region-focusable);
 * a table that fits gets no tab stop.
 */
export function TableScroll({
  label,
  className = '',
  children,
}: {
  /** The region's name while it scrolls. */
  label: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => {
      setOverflows(element.scrollWidth > element.clientWidth + 1);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    for (const child of element.children) observer.observe(child);
    return () => {
      observer.disconnect();
    };
  }, []);
  return (
    <div
      ref={ref}
      role={overflows ? 'region' : undefined}
      aria-label={overflows ? label : undefined}
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a region, while it scrolls
      tabIndex={overflows ? 0 : undefined}
      className={`overflow-x-auto ${className}`}
    >
      {children}
    </div>
  );
}
