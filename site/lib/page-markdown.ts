import { docs } from '@/lib/data';
import { docsMarkdown, docsSlug, type DocsPage } from '@/lib/docs';
import { faqMarkdown } from '@/lib/faq';
import { absolute } from '@/lib/llms';
import { withoutMarkers } from '@/lib/markers';
import { SITE_URL } from '@/lib/site';

/** Where a docs page's Markdown is served: /docs/ci.md, and /docs/quickstart.md for /docs. */
export function markdownPath(page: DocsPage): string {
  return `/docs/${docsSlug(page.href)}.md`;
}

export function markdownUrl(page: DocsPage): string {
  return `${SITE_URL}${markdownPath(page)}`;
}

/** Headings one level or more down: the skill's `##` sections sit under the page's own. */
function demote(markdown: string, levels: number): string {
  let fenced = false;
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) fenced = !fenced;
      return !fenced && /^#{1,5} /.test(line) ? `${'#'.repeat(levels)}${line}` : line;
    })
    .join('\n');
}

/**
 * A docs page as one Markdown document, for "Copy page", "View as Markdown" and assistants: its
 * title, and the text the page renders, with links made absolute so they work anywhere.
 */
export function pageMarkdown(page: DocsPage): string {
  let body: string;
  if (page.href === '/docs/faq') {
    body = faqMarkdown();
  } else if (page.href === '/docs/plugin') {
    const skill = docs.skill.replace(/^# .*\n+/, '');
    body = `${docs.plugin}\n\n## What the skill tells Claude\n\nClaude loads it by itself for UI work, or with \`/onsystem:onsystem\`. This is its text, from SKILL.md:\n\n${demote(skill, 2)}`;
  } else {
    body = docsMarkdown(page) ?? '';
  }
  const cleaned = withoutMarkers(body);
  const lead = page.lead ? `${page.lead}\n\n` : '';
  return `# ${page.title}\n\n${lead}${absolute(cleaned, page.href).trim()}\n`;
}
