import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { InlineMarkdown } from '@/components/markdown';
import { MarkdownBlocks, parseBlocks } from '@/components/markdown-blocks';

const inline = (text: string) => renderToStaticMarkup(createElement(InlineMarkdown, { text }));
const text = (html: string) => html.replace(/<[^>]+>/g, '');

// The subset of Markdown the docs use, rendered the way the docs pages render it.
describe('InlineMarkdown', () => {
  it('renders code inside bold text as code', () => {
    const html = inline('**Read the `detected` line,** or run `inspect --explain`.');
    expect(html).toMatch(
      /^<strong[^>]*>Read the <code[^>]*><span[^>]*>detected<\/span><\/code> line,<\/strong>/,
    );
    expect(text(html)).not.toContain('`');
  });

  it('renders a bold item that starts and ends with code', () => {
    const html = inline('**`Tokens (0)`, or `No color tokens found`,** means no stylesheet');
    expect(html.match(/<code[^>]*>/g)).toHaveLength(2);
    expect(text(html)).toBe('Tokens (0), or No color tokens found, means no stylesheet');
  });

  it('renders a double-backtick span with the backticks it holds', () => {
    const html = inline('Class names built at runtime (`` `bg-${color}-500` ``) are not checked');
    expect(html.match(/<code[^>]*>/g)).toHaveLength(1);
    expect(html).toContain('>`bg-${color}-500`</span></code>');
    expect(text(html)).toBe('Class names built at runtime (`bg-${color}-500`) are not checked');
  });

  it('keeps short code on one line and lets long code wrap between its words', () => {
    const html = inline(
      'Run `--require-design-system` or `the ui alias ~/ui resolves through neither tsconfig paths`',
    );
    const [short, long] = html.split('</code>');
    expect(short).toMatch(/<span class="whitespace-nowrap">--require-design-system<\/span>$/);
    expect(long?.match(/<span class="whitespace-nowrap">/g)).toHaveLength(9);
  });
});

describe('MarkdownBlocks', () => {
  const steps = [
    '1. **Run it from the app folder.**',
    '2. **Read the `detected` line.**',
    '3. **Point at them with a config file:**',
    '',
    '   ```json',
    '   { "components": ["src/ui/**/*.tsx"] }',
    '   ```',
    '',
    '4. **`Tokens (0)`** means no stylesheet defined any.',
    '',
    'A paragraph after the list.',
  ].join('\n');

  it('keeps an ordered list going after an item that ends in a code block', () => {
    const blocks = parseBlocks(steps);
    expect(blocks.map((b) => b.type)).toEqual(['list', 'paragraph']);
    const [list] = blocks;
    expect(list?.type === 'list' && list.items).toHaveLength(4);
  });

  it('numbers the item after the code block 4', () => {
    const html = renderToStaticMarkup(createElement(MarkdownBlocks, { markdown: steps }));
    expect(html.match(/<ol/g)).toHaveLength(1);
    expect(html.match(/<li/g)).toHaveLength(4);
    expect(html).toContain('<pre');
  });

  it('still ends a list at a blank line before something else', () => {
    const blocks = parseBlocks('- one\n- two\n\nText.\n\n1. first\n\n- other kind');
    expect(blocks.map((b) => b.type)).toEqual(['list', 'paragraph', 'list', 'list']);
  });
});
