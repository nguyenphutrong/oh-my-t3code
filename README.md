# Oh My T3Code

Oh My T3Code is a community fork of [T3 Code](https://github.com/pingdotgg/t3code), an open-source control surface for coding agents. This first fork release supports the local CLI and Electron desktop app; hosted cloud, mobile-store, and package-registry releases are not yet provided by this fork.

It works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they are set up on your computer, Oh My T3Code can control them.

## "Wait, what are you selling me?"

Nothing. The upstream T3 Code project was built as a performant, remote-ready, and truly open
coding-agent interface. Oh My T3Code preserves that open-source foundation while developing an
independent distribution.

## Installation

> [!WARNING]
> Oh My T3Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### CLI

Install the self-contained CLI from this repository's latest GitHub Release:

```bash
curl -fsSL https://raw.githubusercontent.com/nguyenphutrong/oh-my-t3code/main/scripts/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/nguyenphutrong/oh-my-t3code/main/scripts/install.ps1 | iex
```

Run `oh-my-t3code` to launch the backend and local web app. Use
`oh-my-t3code --help` for the full CLI reference.

### Desktop app

Install the latest desktop build from this fork's
[GitHub Releases](https://github.com/nguyenphutrong/oh-my-t3code/releases). Unsigned builds may show the
operating system's normal warning until fork-owned signing credentials are configured.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request or need support? Start a
[discussion](https://github.com/nguyenphutrong/oh-my-t3code/discussions).
