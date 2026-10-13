'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** What names the region: the id of an element such as the table's caption, or a label. */
export type RegionName = { labelledBy: string } | { label: string };

/** Makes `element` a focusable, named region while its content is wider than it, and not after. */
export function markOverflow(element: HTMLElement, name: RegionName): void {
  if (element.scrollWidth - element.clientWidth > 1) {
    element.tabIndex = 0;
    element.setAttribute('role', 'region');
    if ('labelledBy' in name) element.setAttribute('aria-labelledby', name.labelledBy);
    else element.setAttribute('aria-label', name.label);
  } else {
    for (const attribute of ['tabindex', 'role', 'aria-labelledby', 'aria-label']) {
      element.removeAttribute(attribute);
    }
  }
}

/**
 * A box that scrolls sideways when what it holds is wider than it. Only while it overflows is it
 * a focusable region, named by `labelledBy` or `label`, so the keyboard can scroll it (axe:
 * scrollable-region-focusable) without a tab stop where there is nothing to scroll.
 */
export function ScrollRegion({
  labelledBy,
  label = '',
  className = '',
  children,
}: {
  /** The id of what names the region, such as the table's caption. */
  labelledBy?: string;
  /** The region's name, when nothing on the page holds it. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const update = () => {
      markOverflow(element, labelledBy ? { labelledBy } : { label });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [labelledBy, label]);
  return (
    <div ref={box} className={`overflow-x-auto ${className}`}>
      {children}
    </div>
  );
}
