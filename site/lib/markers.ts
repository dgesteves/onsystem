/**
 * The docs renderer's own markers (steps, package-manager tabs) mean nothing outside the site.
 * Imports nothing, so scripts/generate.mjs runs it as it is for the Ask index.
 */
export function withoutMarkers(markdown: string): string {
  return markdown.replace(/^<!-- \/?steps -->\n*/gm, '').replace(/^(```\w+) pm$/gm, '$1');
}
