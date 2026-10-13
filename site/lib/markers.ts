// No imports, so scripts/generate.mjs can load this file as it is (Node strips the types).

/** The docs renderer's own markers (steps, package-manager tabs) mean nothing outside the site. */
export function withoutMarkers(markdown: string): string {
  return markdown.replace(/^<!-- \/?steps -->\n*/gm, '').replace(/^(```\w+) pm$/gm, '$1');
}
