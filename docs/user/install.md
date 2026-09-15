# Install Oh My T3Code

Oh My T3Code runs coding agents on your computer and lets you control them from its
desktop or local web app. Set up the machine where the agents will work first.

## Requirements

The released CLI is a self-contained executable and does not require Node.js.
SSH hosts and WSL backends need Node.js 22.16+
(22.x), 23.11+ (23.x), or 24.10 and later. The native desktop app includes its
server runtime.

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## CLI

Install the latest self-contained CLI on macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/nguyenphutrong/t3code/main/scripts/install.sh | sh
```

On Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/nguyenphutrong/t3code/main/scripts/install.ps1 | iex
```

Run `oh-my-t3code` to start the server and open the local web app. Run
`oh-my-t3code --help` for command-line options.

The executable is built for Apple Silicon Macs, Linux, and Windows. There is
no Intel Mac build of it, because Node cannot produce a single executable for
that platform; the Intel desktop app is unaffected. To run a standalone server
on an Intel Mac, build it from source. You need Node.js 24 and `vp` (see
[Install vp](https://github.com/nguyenphutrong/t3code#install-vp)):

```bash
git clone https://github.com/nguyenphutrong/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

A server run this way is a plain Node program: `oh-my-t3code update` and the background
service do not apply, so update it with `git pull` and a rebuild, and start it
however you run other Node processes.

## Desktop app

Download an installer from this fork's
[GitHub Releases](https://github.com/nguyenphutrong/t3code/releases). Package-manager releases are
not available yet. Unsigned builds may show the operating system's normal warning.

### Windows Subsystem for Linux

Choose a WSL distro in **Settings → Connections** to run agents and projects
there. Install Node.js and provider CLIs inside that distro. T3 Code installs its
matching server runtime there automatically; the first launch after an app
update can take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
oh-my-t3code app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `oh-my-t3code app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

## Mobile app

This fork does not currently publish an iOS or Android app. Mobile store links for upstream T3
Code install a separate product and are not a supported Oh My T3Code release surface.

## Providers

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider     | Install and authenticate                                                                     |
| ------------ | -------------------------------------------------------------------------------------------- |
| Codex        | Install [Codex CLI](https://developers.openai.com/codex/cli), then run `codex login`.        |
| Claude       | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`. |
| Cursor       | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                        |
| Grok Build   | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                           |
| OpenCode     | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                     |
| Antigravity  | Install and sign in with Google from T3 Code's provider settings.                            |
| ACP Registry | Choose a compatible agent in **Add provider → ACP Registry**.                                |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Antigravity can use its managed runtime without a `PATH` entry.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** appears only when T3 Code can tell which
installer owns the CLI (its own update command, Homebrew, or a global npm, pnpm,
bun, or Vite+ install) and runs that installer. Otherwise update the CLI the same
way you installed it. Homebrew installs compare against the version Homebrew
offers, which can trail the npm release by a few hours.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

### ACP Registry agents

Choose **Add provider → ACP Registry** to search the official ACP Registry. T3
Code selects a distribution for the environment and can prepare pinned `npx` or
`uvx` packages or download a platform binary. Registry binaries are accepted only
after their published SHA-256 checksum matches. You can instead configure an
installed executable, launch arguments, and environment variables. Use **Refresh
provider status** after saving to run the bounded ACP initialization health check.

Registry agents are third-party programs with the same local access as their T3
Code process; they are not sandboxed. Review the source and publisher before
installing one. T3 Code validates registry metadata and package locations, but a
valid checksum proves integrity, not trustworthiness.

The registry currently lists `amp-acp`, which is a community wrapper around Amp
Code. It is not maintained or endorsed by Amp. It uses the Amp authentication
already available to its process; T3 Code does not copy or display Amp
credentials. Its ACP implementation supports text streaming, tools, sessions,
cancellation, and modes, but granular permission handling is partial and its
advertised image input is not currently reliable. T3 Code labels it accordingly
rather than presenting it as a native Amp integration.

Provider setup is managed by the web or desktop client on the selected
environment. Mobile uses configured ACP providers for threads, but does not
install or edit provider instances.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md), and
[Antigravity](./providers-antigravity.md).

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a Linux or macOS host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
