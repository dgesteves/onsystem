/**
 * The FAQ: questions and answers in inline Markdown, rendered on /docs/faq, served as Markdown and
 * indexed for Ask. scripts/generate.mjs loads this file as it is, so it imports nothing.
 */
export const FAQ: [question: string, answer: string][] = [
  [
    'Does my code leave my machine?',
    'No. The hook, the CLI and the server run where you run them: they read your files with the TypeScript compiler and apply the rules, with no model calls, no API key and no network requests. Your agent sends its context to its own model, as it does with any tool. The [playground](/playground) is the one exception: it sends what you type to this site, which checks it and does not store it.',
  ],
  [
    'Is there a model behind it?',
    'No. The agent is already the model; what it lacks is ground truth. Everything here is deterministic static analysis that takes milliseconds and can be tested rule by rule. The trade-off: it cannot judge intent, such as whether a `Dialog` was the right call. That stays with the agent and the reviewer.',
  ],
  [
    'Does it work with agents other than Claude Code?',
    'Yes. Any MCP client gets the tools, including `check_ui`, which the agent runs on its own output, and `onsystem check` in CI gates the pull request whichever agent wrote it. The hook that checks each edit as it happens ships for Claude Code only so far. [Set up your agent](/docs/clients) has a config for each client.',
  ],
  [
    'How often is it wrong?',
    'It is measured: every pull request that touches the rules runs them on 10 public repositories pinned by commit and compares the findings with a labelled sample, and the [corpus](https://github.com/dgesteves/onsystem/tree/main/corpus) has the labels. The README quotes the current false-positive rate. When it flags something that is fine, [suppress it](/rules#suppressing-findings) with a comment, turn the rule down in the [config](/rules#configure), and please open an issue with the snippet and the output of `inspect`: those are the reports I most want.',
  ],
  [
    'How is it different from @shadcn/lint?',
    '@shadcn/lint checks the Tailwind classes written against a component and the theme (restyling a component, raw colors, arbitrary and unknown classes), in React, Svelte and Vue, on Tailwind v4. onsystem checks that the components, props and variant values exist, that native elements the design system wraps are not used, and that icon buttons have a name, on Tailwind v3 or v4, and gives the agent the design system before it writes. They overlap on raw colors and arbitrary values; run both.',
  ],
  [
    'Why not Storybook MCP?',
    'It is a good fit if you run Storybook: it serves stories and a component manifest from a running instance, and can run component tests. onsystem reads the source, so it works in projects without Storybook, in a hook, and in CI.',
  ],
  [
    'Why not describe the design system in CLAUDE.md or AGENTS.md?',
    'A static list goes stale, and agents still guess prop values and colors. Here the agent is checked on what it actually wrote. One line in `CLAUDE.md`, `AGENTS.md` or `.cursor/rules` still helps clients that ignore the server\'s instructions: _"Before writing UI, use the onsystem tools. Run check_ui on every file you change and fix all errors."_',
  ],
  [
    'My components are not in components/ui. Do I need a config?',
    'Not if the app has a shadcn/ui `components.json`, imports a workspace package named like a design system (`@acme/ui`), is the design-system package itself, or keeps its components in a flat `src/` that wraps React Aria, Radix or another primitives library: [zero config](/docs/configuration#zero-config) finds those. Otherwise a config file with a `components` glob is enough. `npx -y onsystem inspect` prints what was found, and [troubleshooting](/docs/troubleshooting) covers what to do when it finds nothing.',
  ],
  [
    "Will check fail on my design system's own components?",
    'No. `check` skips the files `components` matches: they implement the scale and the primitives the rules enforce. `--include-design-system` lints them too.',
  ],
  [
    'Is the Claude Code plugin safe to install everywhere?',
    'Yes. The hook stays quiet in projects without a design system, only reports on what Claude just changed, honours a baseline, and never blocks an edit because it could not run.',
  ],
  [
    'Does it work with Vue, Svelte or Angular?',
    'Not yet: React only (`.tsx` and `.jsx`). The other [limits](/docs/how-it-works#limits) are listed with how it works.',
  ],
  [
    'What does it need to run?',
    'Node.js 20.19 or later (22.18 or later for a TypeScript config file). On native Windows, wrap the command as `cmd /c npx ...`.',
  ],
];

/** The FAQ as one Markdown document, a `##` heading per question. */
export function faqMarkdown(): string {
  return FAQ.map(([question, answer]) => `## ${question}\n\n${answer}`).join('\n\n');
}
