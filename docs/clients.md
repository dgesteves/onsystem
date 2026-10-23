# Set up your agent

Pick your client below and add the server. Run it from the project, or pass `--root` with the app's absolute path: [how the server finds your project](#how-the-server-finds-your-project) has the rest.

Every client gets the same five tools, including `check_ui`, which the agent runs on its own output. Claude Code and Codex CLI also run the [plugin](plugin.md)'s hook, which checks each edit as it happens, so there use the plugin instead; with other agents, add the [CI check](ci.md) so what the agent skips still gets caught. Not every setup below has been run in its client yet: [Support tiers](#support-tiers) says which have.

> [!TIP]
> **One `.mcp.json` for the team.** Commit this file at the repository root, and VS Code, GitHub Copilot CLI and Grok Build start the server from it once each person trusts the folder or approves the server:
>
> ```json
> {
>   "mcpServers": {
>     "onsystem": {
>       "command": "npx",
>       "args": ["-y", "onsystem"]
>     }
>   }
> }
> ```
>
> It needs no `--root`: the server finds the project from the folder it starts in, the roots the client reports, or the files the tools are given. Cursor and the other clients read their own files, below.
>
> Claude Code reads this file too, but there the plugin gives the same tools plus the hook. A team on Claude Code commits the plugin ([Roll out to a team](rollout.md#give-every-agent-the-design-system)) and adds `"disabledMcpjsonServers": ["onsystem"]` to the same `.claude/settings.json`, so Claude Code does not register the tools twice.

## Plugins for other agents

The skill and the MCP server also come packaged for other agents, pinned to the same release as the Claude Code plugin. The hook that checks each edit runs in Claude Code and Codex CLI; elsewhere, the [CI check](ci.md) catches what the agent skips.

- **Any agent with Agent Skills** (Claude Code, Codex, Cursor, GitHub Copilot, Gemini CLI, OpenCode and others): the skill, from the repository. It goes to `.agents/skills/onsystem`, which most agents read, and is linked into `.claude/skills` for Claude Code. Add the MCP server with your client's config below.

  ```sh
  npx skills add dgesteves/onsystem
  ```

- **Codex CLI:** Codex reads the same marketplace as Claude Code and installs that plugin: the server, the skill and the hook, which checks each `.tsx` or `.jsx` file an `apply_patch` adds or updates. Codex runs a plugin's hooks only after you review and trust them: open `/hooks` once after installing.

  ```sh
  codex plugin marketplace add dgesteves/onsystem
  codex plugin add onsystem@dgesteves
  ```

- **GitHub Copilot CLI:** Copilot CLI reads the same marketplace as Claude Code and installs that plugin's server and skill. Install it from the marketplace: Copilot CLI has deprecated installing a plugin straight from a repository.

  ```sh
  copilot plugin marketplace add dgesteves/onsystem
  copilot plugin install onsystem@dgesteves
  ```

- **VS Code** (GitHub Copilot agent plugins): run **Chat: Install Plugin From Source** from the Command Palette and enter `dgesteves/onsystem`. VS Code reads the same marketplace as Claude Code and installs that plugin's server and skill. To use the [Agent Plugins 1.0](https://github.com/agentplugins/agent-plugins-spec) package instead, add a clone's `plugins/onsystem-agent` folder to the `chat.pluginLocations` setting.
- **Cursor:** the Cursor plugin, in `plugins/onsystem-cursor`. Until it is listed in the Cursor Marketplace, copy that folder to `~/.cursor/plugins/local/onsystem` and run **Developer: Reload Window**.

A client that loads the Agent Plugins format starts the server in the plugin's folder rather than in your project, so the server finds the project through the workspace roots the client reports, as VS Code and Cursor do. If a client reports none, the server finds the project from the absolute path of the file the agent passes to the tools, and asks for one when a call has none. To have it found from the start, add the server with the client's MCP config below instead.

## Cursor and VS Code

One click installs it: [Install in Cursor](https://cursor.com/en/install-mcp?name=onsystem&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsIm9uc3lzdGVtIiwiLS1yb290IiwiJHt3b3Jrc3BhY2VGb2xkZXJ9Il19) or [Install in VS Code](https://insiders.vscode.dev/redirect/mcp/install?name=onsystem&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22onsystem%22%2C%22--root%22%2C%22%24%7BworkspaceFolder%7D%22%5D%7D). To share it with the team, commit a file instead: `.cursor/mcp.json` for Cursor, and for VS Code the `.mcp.json` at the top of this page.

<details open>
<summary><strong>Cursor</strong></summary>

`.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "onsystem": {
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "${workspaceFolder}"]
    }
  }
}
```

</details>

<details open>
<summary><strong>VS Code (Copilot agent mode)</strong></summary>

Commit the `.mcp.json` at the top of this page: VS Code reads it, and its docs now call the older `.vscode/mcp.json` deprecated. Commit one or the other, not both: VS Code reads both, so it can start the server twice. A repository that already keeps its servers in the older file adds this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "onsystem": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "${workspaceFolder}"]
    }
  }
}
```

</details>

A client that passes `${workspaceFolder}` through unexpanded gets a warning on stderr, and the server falls back to its working directory, or the roots the client reports when that holds no project, or else the paths the tools are given.

## Other clients

Every client runs the same stdio command. Replace `/absolute/path/to/app` with the app's folder; the server also finds the project without `--root` when the client starts it in the project folder, or reports the folder as a root.

<details>
<summary><strong>Claude Desktop</strong></summary>

Settings → Developer → Edit Config opens `claude_desktop_config.json` (`~/Library/Application Support/Claude/` on macOS, `%APPDATA%\Claude\` on Windows):

```json
{
  "mcpServers": {
    "onsystem": {
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "/absolute/path/to/app"]
    }
  }
}
```

Restart Claude Desktop after saving.

</details>

<details>
<summary><strong>Codex CLI</strong></summary>

```sh
codex mcp add onsystem -- npx -y onsystem --root /absolute/path/to/app
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.onsystem]
command = "npx"
args = ["-y", "onsystem", "--root", "/absolute/path/to/app"]
```

</details>

<details>
<summary><strong>GitHub Copilot CLI</strong></summary>

```sh
copilot mcp add onsystem -- npx -y onsystem --root /absolute/path/to/app
```

That writes `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "onsystem": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "/absolute/path/to/app"],
      "tools": ["*"]
    }
  }
}
```

In a session, `/mcp show onsystem` lists its tools. Copilot CLI also reads the team's `.mcp.json` (or `.github/mcp.json`) in a folder you trust.

</details>

<details>
<summary><strong>Windsurf (Devin Desktop)</strong></summary>

Windsurf is now Devin Desktop. Its default agent, Devin Local, reads the Devin CLI's MCP config: `~/.config/devin/mcp_config.json` (`%APPDATA%\devin\mcp_config.json` on Windows) for every project, or `.devin/mcp_config.json` in the repository to share it with the team:

```json
{
  "mcpServers": {
    "onsystem": {
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "/absolute/path/to/app"]
    }
  }
}
```

From the terminal, `devin mcp add -s user onsystem -- npx -y onsystem --root /absolute/path/to/app` adds the same entry to the user file, and `-s project` to `.devin/mcp_config.json`; without `-s`, it goes to `.devin/mcp_config.local.json`, for this repository only and ignored by git.

The legacy Cascade agent reads the same user file. Devin CLI versions before 3000.3 keep the servers under `mcpServers` in `config.json` at the same places, and move them on upgrade.

</details>

<details>
<summary><strong>JetBrains IDEs (AI Assistant and Junie)</strong></summary>

For AI Assistant, open Settings → Tools → AI Assistant → Model Context Protocol (MCP), click Add, choose STDIO and paste:

```json
{
  "mcpServers": {
    "onsystem": {
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "/absolute/path/to/app"]
    }
  }
}
```

Set the server level to the project to run it only there. Junie reads the same format from `.junie/mcp/mcp.json` in the project, or `~/.junie/mcp/mcp.json` for every project.

</details>

<details>
<summary><strong>Zed</strong></summary>

In Zed's `settings.json`:

```json
{
  "context_servers": {
    "onsystem": {
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "/absolute/path/to/app"],
      "env": {}
    }
  }
}
```

</details>

<details>
<summary><strong>Gemini CLI</strong></summary>

```sh
gemini mcp add -s user onsystem npx -y onsystem --root /absolute/path/to/app
```

That writes `~/.gemini/settings.json`, for every project; without `-s user`, it writes `.gemini/settings.json` in the project:

```json
{
  "mcpServers": {
    "onsystem": {
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "/absolute/path/to/app"]
    }
  }
}
```

Gemini CLI starts MCP servers only in trusted folders: trust the project when Gemini CLI asks, or later with `/permissions`. Until then, `gemini mcp list` shows onsystem as Disabled, even from the user file. A headless run (`gemini -p`) cannot ask: pass `--skip-trust`, or set `GEMINI_CLI_TRUST_WORKSPACE=true`.

</details>

<details>
<summary><strong>Antigravity (CLI and IDE)</strong></summary>

Antigravity CLI replaced Gemini CLI for unpaid-tier and Google One users in June 2026, and it keeps MCP servers in a different file: the CLI and the IDE both read `~/.gemini/config/mcp_config.json` for every project, or `.agents/mcp_config.json` in the project. In the IDE, open the file from the **…** menu of the agent panel: **MCP Servers**, then **Manage MCP Servers**, then **View raw config**. In the CLI, `/mcp` opens the MCP manager.

```json
{
  "mcpServers": {
    "onsystem": {
      "command": "npx",
      "args": ["-y", "onsystem", "--root", "/absolute/path/to/app"]
    }
  }
}
```

</details>

<details>
<summary><strong>Grok Build</strong></summary>

```sh
grok mcp add onsystem -- npx -y onsystem --root /absolute/path/to/app
```

or in `~/.grok/config.toml` (`--scope project` writes `.grok/config.toml` in the repository instead):

```toml
[mcp_servers.onsystem]
command = "npx"
args = ["-y", "onsystem", "--root", "/absolute/path/to/app"]
```

`grok mcp doctor onsystem` starts it and lists its tools. Grok Build also reads a project's `.mcp.json` once you trust the folder.

</details>

<details>
<summary><strong>Claude Code without the plugin</strong></summary>

Use this instead of the plugin, not next to it: both register the same tools.

```sh
claude mcp add onsystem -- npx -y onsystem
```

To share it with your team, add `--scope project`, which writes the same entry to `.mcp.json` at the repository root: the file at the top of this page.

</details>

Any other MCP client: run `npx -y onsystem --root /absolute/path/to/app` as a stdio server. On native Windows, wrap it as `cmd /c npx ...`.

The server sends usage instructions in its `initialize` result and in `server/discover`. Clients that ignore them benefit from one line in `CLAUDE.md`, `AGENTS.md` or `.cursor/rules`: _"Before writing UI, use the onsystem tools. Run check_ui on every file you change and fix all errors."_ Run in a terminal, `onsystem init` offers to add a short section that says so to the project's `AGENTS.md` or `CLAUDE.md`, with `npx -y onsystem check <file>` for agents without the tools. It sits between `BEGIN:onsystem-agent-rules` and `END:onsystem-agent-rules` comment markers, which a later run updates in place.

## Support tiers

Every setup on this page follows the client's own docs, but not every one has been run in that client:

- **Tier 1, tested:** CI runs it on every pull request, or the setup as these docs give it was run in the client and worked.
- **Tier 2, documented:** written from the client's docs, and not run in the client yet, or only installed. It should work; if it does not, [open an issue](https://github.com/dgesteves/onsystem/issues) with the client's version.

| Setup                           | Tier | Last checked                                 | What was checked                                                                                                                                                                                                                                                       |
| ------------------------------- | ---- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The MCP server over stdio       | 1    | Every pull request                           | `pnpm smoke` starts the built server as a client does and calls every tool with the MCP SDK's clients, in both protocol eras. `pnpm pack-test` runs the handshake with the packed package on Linux, Windows and macOS.                                                 |
| Claude Code plugin              | 1    | 2026-10-21, Claude Code 2.1.299              | `claude mcp list` showed the plugin's server connected ([#185](https://github.com/dgesteves/onsystem/pull/185)). CI runs the plugin's hook on every pull request, with input shaped like Claude Code's.                                                                |
| Claude Code without the plugin  | 1    | 2026-10-21, Claude Code 2.1.299              | `claude mcp add --scope project` wrote the `.mcp.json` at the top of this page, and `claude mcp list` showed the server connected ([#185](https://github.com/dgesteves/onsystem/pull/185)).                                                                            |
| Gemini CLI                      | 1    | 2026-10-16, Gemini CLI 0.64.0                | `gemini mcp add` wrote the config shown, and `gemini mcp list` showed the server connected in a trusted folder ([#185](https://github.com/dgesteves/onsystem/pull/185)).                                                                                               |
| Agent Skills (`npx skills add`) | 1    | 2026-10-10, skills 1.7.2                     | It installed the skill in `.agents/skills/onsystem` and linked it into `.claude/skills` ([#73](https://github.com/dgesteves/onsystem/pull/73)).                                                                                                                        |
| Codex CLI                       | 2    | 2026-10-16, Codex CLI 0.163.0, install only  | The plugin installed from the marketplace, and `codex mcp add` wrote the config shown ([#185](https://github.com/dgesteves/onsystem/pull/185)). Neither the server nor the hook has been run in Codex; CI tests the hook with input shaped like Codex's `apply_patch`. |
| GitHub Copilot CLI              | 2    | 2026-10-16, Copilot CLI 1.0.98, install only | The plugin installed from the marketplace, and `copilot mcp list` listed its server and the one in a trusted folder's `.mcp.json` ([#185](https://github.com/dgesteves/onsystem/pull/185)). Neither was started.                                                       |
| Grok Build                      | 2    | 2026-10-09, Grok Build 1.0.50                | `grok mcp doctor` started the server and found its five tools, before the package was renamed onsystem ([#34](https://github.com/dgesteves/onsystem/pull/34)).                                                                                                         |
| Cursor                          | 2    | Not yet                                      | The plugin passes the checks of Cursor's plugin template ([#73](https://github.com/dgesteves/onsystem/pull/73)). Neither it nor `.cursor/mcp.json` has been run in Cursor.                                                                                             |
| VS Code                         | 2    | Not yet                                      | From VS Code's docs.                                                                                                                                                                                                                                                   |
| Claude Desktop                  | 2    | Not yet                                      | From Claude Desktop's docs.                                                                                                                                                                                                                                            |
| Windsurf (Devin Desktop)        | 2    | Not yet                                      | From the Devin Desktop and Devin CLI docs.                                                                                                                                                                                                                             |
| JetBrains IDEs                  | 2    | Not yet                                      | From the AI Assistant and Junie docs.                                                                                                                                                                                                                                  |
| Zed                             | 2    | Not yet                                      | From Zed's docs.                                                                                                                                                                                                                                                       |
| Antigravity                     | 2    | Not yet                                      | From Antigravity's docs.                                                                                                                                                                                                                                               |

The CLI, the [GitHub Action](ci.md) and the [ESLint plugin](eslint.md) are not agent setups: CI runs all three on every pull request. To move a setup to Tier 1, run it in the client and open a pull request that updates its row with the client's version, the date and what you saw.

## How the server finds your project

The server finds the project from `--root`, a config file in the working directory, or the working directory itself when it holds a project (a `package.json` or `components.json`). Started at a [monorepo root](configuration.md#monorepo-roots), it serves every app and design-system package in it: the tools take the `path` of the file the agent is editing and answer for that file's project.

MCP roots, which the 2026-07-28 protocol revision deprecates, are the fallback: when the working directory holds no project (Claude Desktop starts servers in `/`), a 2025-era client that reports roots has its first `file://` root used. When none of these gives a project (a client that starts servers in your home or the plugin's folder and reports no roots), each tool call's project is found from the absolute path it names, `path` (or `filename`, for `check_ui` with `code`): the nearest folder at or above it with a `package.json`, `components.json` or config, or the monorepo root above that, but never your home folder or the filesystem root. A project found this way loads a JSON config (`onsystem.config.json`) only: the server runs a JavaScript or TypeScript config only in a project it was started in. Until a call names one, the tools return an error that asks for it; after that, a call without one answers from the project found, as long as only one has been.

The server speaks MCP over stdio, in both protocol eras: the 2026-07-28 revision (stateless, with `server/discover`) and the 2025 one (the `initialize` handshake), the era chosen by the client's first message.
