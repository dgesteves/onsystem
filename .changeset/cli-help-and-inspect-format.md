---
'onsystem': patch
---

`onsystem --help` now says what the CLI does. `--config` names `onsystem.config.mts`, which is read along with the other four; `--tokens` names a DESIGN.md, which is a token file like a DTCG `.json` or a stylesheet; and `--format` lists `inspect: pretty | json`, which worked but was listed for `check` and `export` only. The CLI reference (`docs/cli.md`) already had all three.

`onsystem inspect --format xml`, or a typo, now exits 2 with one line, as `check` and `export` do for a format they do not take. It printed the pretty output and exited 0, so a script that asked for JSON and got text read it as the design system having nothing in it. The check runs before the project is loaded, so it covers a monorepo root too.
