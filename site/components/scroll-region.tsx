'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** Makes `element` a focusable, named region while its content is wider than it, and not after. */
export function markOverflow(element: HTMLElement, labelledBy: string): void {
  if (element.scrollWidth - element.clientWidth > 1) {
    element.tabIndex = 0;
    element.setAttribute('role', 'region');
    element.setAttribute('aria-labelledby', labelledBy);
  } else {
    element.removeAttribute('tabindex');
    element.removeAttribute('role');
    element.removeAttribute('aria-labelledby');
  }
}

/**
 * A box that scrolls sideways when what it holds is wider than it. Only while it overflows is it
 * a focusable region, named by `labelledBy`, so the keyboard can scroll it (axe:
 * scrollable-region-focusable) without a tab stop where there is nothing to scroll.
 */
export function ScrollRegion({
  labelledBy,
  className = '',
  children,
}: {
  /** The id of what names the region, such as the table's caption. */
  labelledBy: string;
  className?: string;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const update = () => {
      markOverflow(element, labelledBy);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      observer.disconnect();
    };
  }, [labelledBy]);
  return (
    <div ref={box} className={`overflow-x-auto ${className}`}>
      {children}
    </div>
  );
}
