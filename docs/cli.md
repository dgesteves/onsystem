# CLI reference

`onsystem` is one command. With no command it is the MCP server an agent starts; `check`, `inspect`, `export` and `init` are for the terminal and CI. With nothing installed, run it through npx; installed as a dev dependency, which pins the version for the team and CI, `npx onsystem` runs that install:

```sh pm
npx -y onsystem check .
npx onsystem check .
```

It needs Node.js 20.19 or later. The options are the ones `onsystem --help` prints, listed under the commands that take them, and a test keeps this page and the help in step.

| Command                             | What it does                                                                                                                           |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `onsystem`, `onsystem serve`        | Starts the MCP server on stdio, for an agent ([set up your agent](clients.md))                                                         |
| `onsystem check <paths...>`         | Lints files, folders or globs with the rules `check_ui` runs, and exits 1 on errors ([CI and baselines](ci.md))                        |
| `onsystem inspect`                  | Prints what it read: where it found the design system, the components with their props, variants and parts, and the tokens by category |
| `onsystem export --format <format>` | Prints the tokens it found as a DTCG 2025.10 file (`dtcg`) or a DESIGN.md (`design-md`) ([export](tokens.md#export))                   |
| `onsystem init`                     | Writes `onsystem.config.json` from what it found, checks the project once and offers to record the findings as a baseline              |
| `onsystem help`                     | Prints the help, as `--help` does                                                                                                      |

At a monorepo root with no design system of its own, every command works per project: each file is checked against the design system of the nearest folder with a config, a `components.json` or a `package.json`, and `inspect` lists every project ([monorepo roots](configuration.md#monorepo-roots)).

## Options for every command

| Option                | What it does                                                                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--root <dir>`        | The project root. By default, the folder of the file `--config` names, or the working directory                                                                                                                                                                          |
| `--config <file>`     | The config file. By default, the first of `onsystem.config.json`, `onsystem.config.ts`, `onsystem.config.mts`, `onsystem.config.js` and `onsystem.config.mjs` in the root; the TypeScript ones need Node.js 22.18 or later ([config file](configuration.md#config-file)) |
| `--components <glob>` | Component sources, repeatable. By default, what [zero config](configuration.md#zero-config) finds                                                                                                                                                                        |
| `--tokens <file>`     | A token file, repeatable: a DTCG `.json`, a stylesheet or a `DESIGN.md` ([where tokens come from](tokens.md#where-tokens-come-from))                                                                                                                                     |
| `--docs <glob>`       | Component docs in Markdown or MDX, repeatable                                                                                                                                                                                                                            |
| `--no-cache`          | Ignores the cache of what it read from the design system (in `node_modules/.cache/onsystem`, or the system temp folder without a `node_modules`), and reads it all again                                                                                                 |
| `-h`, `--help`        | Prints the help                                                                                                                                                                                                                                                          |
| `-v`, `--version`     | Prints the version                                                                                                                                                                                                                                                       |

## `serve`

`onsystem` or `onsystem serve` starts the MCP server on stdio. An agent starts it from its MCP config; typed in a terminal, it says that it is waiting for an agent, and Ctrl+C quits. It answers the handshake right away and reads the design system in the background, then reads it again when the component, token or docs files, the config or the tsconfig change ([how it works](how-it-works.md)). Started at a monorepo root, it serves every project ([how the server finds your project](clients.md#how-the-server-finds-your-project)).

| Option       | What it does                                            |
| ------------ | ------------------------------------------------------- |
| `--no-watch` | Does not read the design system again when files change |

## `check`

`onsystem check <paths...>` lints the files, folders and globs it is given with the rules `check_ui` runs ([rules](rules.md)). A folder stands for its `.tsx` and `.jsx` files; folders and globs leave out the design system's own component files, tests and stories, what the config's `exclude` adds and what git ignores. A file named outright is checked too, unless it is one of the design system's own component files (`--include-design-system` checks those) or `--skip-excluded` leaves it out ([CI and baselines](ci.md)).

It exits with:

- `0` when there are no errors, and no more warnings than `--max-warnings`.
- `1` when there are errors, or more warnings than `--max-warnings`.
- `2` when it could not check: an unknown option, no paths given, an unknown `--format`, a `--max-warnings` that is not an integer, a broken config, paths that match no file, a file it could not read, a `--baseline` file that does not exist (unless `--update-baseline` writes it), `--prune-baseline` with no baseline to prune, or, with `--require-design-system`, no design system or nothing to check.

| Option                          | What it does                                                                                                                                                                |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--format <format>`             | `pretty` (the default), `json`, `github` (annotations on the pull request) or `sarif` ([code scanning](ci.md#code-scanning-and-other-sarif-tools))                          |
| `--max-warnings <n>`            | Exits 1 when there are more than `n` warnings                                                                                                                               |
| `--update-baseline`             | Records the current findings as accepted in the baseline, and exits 0 ([adopting it in an existing codebase](ci.md#adopting-it-in-an-existing-codebase))                    |
| `--prune-baseline`              | Drops the baseline entries that no longer occur, and accepts nothing new                                                                                                    |
| `--baseline <file>`             | The baseline file. By default `onsystem.baseline.json` in the root, used whenever it exists                                                                                 |
| `--ignore-baseline`             | Reports every finding, in the baseline or not                                                                                                                               |
| `--include-design-system`       | Also lints the design system's own component files, which are skipped by default (`"includeDesignSystem": true` in the config does the same)                                |
| `--include-tests`               | Also lints tests and stories (`*.test.tsx`, `*.spec.tsx`, `*.stories.tsx`) in folders and globs                                                                             |
| `--skip-excluded`               | Leaves out the files named outright that the config's `exclude` covers, as folders and globs leave them out. The Claude Code hook passes it                                 |
| `--quiet-without-design-system` | Prints nothing and exits 0 when the project has no design-system components and no config (tokens alone are not a design system), for a hook installed across many projects |
| `--require-design-system`       | Exits 2 when no components or no color tokens are found, or when the folders and globs it is given leave no file to check, so CI cannot pass by checking nothing            |

`check` exits 2 when it is given `--quiet-without-design-system` with `--require-design-system`, or `--prune-baseline` with `--update-baseline` or `--ignore-baseline`. Output is in color in a terminal, unless `NO_COLOR` is set. The [GitHub Action](required-check.md) sets `ONSYSTEM_CHANGED_LINES` to a file of the lines a pull request changed; unset it if it is left over in a shell where you run `check` yourself.

## `inspect`

`onsystem inspect` prints what it read from the design system: the root and config, where it found the design system (the `detected` line), the components with their props, variants and parts, the tokens by category, and what it could not read. At a monorepo root it lists every project. When it found nothing, see [troubleshooting](troubleshooting.md#inspect-found-nothing).

| Option              | What it does                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--explain`         | Adds every candidate zero config looked at and why it was taken or not, the config it resolved to, the tokens that did not resolve and the components whose props did not |
| `--format <format>` | `pretty` (the default) or `json`, which prints what it read as JSON, for scripts; another value exits 2                                                                   |

## `export`

`onsystem export --format dtcg` or `--format design-md` prints the tokens it found as a DTCG 2025.10 file or a DESIGN.md, which other tools read ([export](tokens.md#export)). At a monorepo root, pass `--root` with one project.

| Option              | What it does                                |
| ------------------- | ------------------------------------------- |
| `--format <format>` | `dtcg` or `design-md`, which `export` needs |
| `--out <file>`      | Writes to this file instead of stdout       |

## `init`

`onsystem init` writes `onsystem.config.json` from what zero config found, or asks where the components, tokens and import path are when it found nothing. Then it checks the project once and offers to record the findings as a baseline, and in a terminal it offers to add a short section on onsystem to `AGENTS.md` or `CLAUDE.md`. It never replaces an existing config without `--force`. At a monorepo root it writes a config with only `$schema`, and in a design-system package it also declares the config in `package.json` and writes `ONSYSTEM.md` for the apps' teams ([config file](configuration.md#config-file), [design-system packages](design-system-packages.md)).

| Option        | What it does                                    |
| ------------- | ----------------------------------------------- |
| `-y`, `--yes` | Writes without asking, and records the baseline |
| `--force`     | Replaces an existing config file                |
