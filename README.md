# IAGO (Issues A GOgo)

IAGO stands for Issues A GOgo. It's a tool that helps sandboxed coding agents retrieve and fix GitHub issues. To get what I mean, read [AGENT.md](./AGENT.md).

<img src="https://github.com/NicholasCaporusso/iago-issues-a-gogo/blob/main/assets/iago-logo.png?raw=true" width=200" />

This repository contains two Windows-ready Rust applications:

- `iago`, the command-line client for syncing issues, managing the local backlog, and working issue branches
- `iago-server`, the local companion server that stores repository tokens and serves relay requests on Windows

The Rust workspace lives in [`src/rust/`](/workspace/tools-github-issues-resolver/src/rust/), and the Windows build and installer helpers live in [`build/rust/`](/workspace/tools-github-issues-resolver/build/rust/) and [`build/windows/installer/`](/workspace/tools-github-issues-resolver/build/windows/installer/).

## What is in the repo

- Rust workspace guide: [`src/rust/README.md`](/workspace/tools-github-issues-resolver/src/rust/README.md)
- Rust CLI entrypoint: [`src/rust/cli/src/main.rs`](/workspace/tools-github-issues-resolver/src/rust/cli/src/main.rs)
- Rust server entrypoint: [`src/rust/server/src/main.rs`](/workspace/tools-github-issues-resolver/src/rust/server/src/main.rs)
- Rust shared helpers: [`src/rust/shared/src/repository.rs`](/workspace/tools-github-issues-resolver/src/rust/shared/src/repository.rs)
- CLI Windows build script: [`build/rust/cli/build-windows-exe.ps1`](/workspace/tools-github-issues-resolver/build/rust/cli/build-windows-exe.ps1)
- Server Windows build script: [`build/rust/server/build-windows-exe.ps1`](/workspace/tools-github-issues-resolver/build/rust/server/build-windows-exe.ps1)
- Windows installer build script: [`build/windows/installer/build-installer.ps1`](/workspace/tools-github-issues-resolver/build/windows/installer/build-installer.ps1)
- Windows installer definition: [`build/windows/installer/iago.iss`](/workspace/tools-github-issues-resolver/build/windows/installer/iago.iss)

## Requirements

- Rust toolchain with `cargo` and `rustc`
- Git installed and available on `PATH`
- Inno Setup installed if you want to build the Windows installer
- Node.js 18 or newer if you want to run `npm` scripts

## Installation

From the repository root:

```powershell
npm install
```

That installs the development dependency used by the Windows single-executable build flow.

If you want to build the installer itself, also install Inno Setup so `iscc.exe` is available on `PATH`.

## Quick Start

### 1. Build the Windows executables

```powershell
npm run build:windows-exe
npm run build:windows-server-exe
```

This produces:

- [`dist/rust/cli/iago.exe`](/workspace/tools-github-issues-resolver/dist/rust/cli/iago.exe)
- [`dist/rust/server/iago-server.exe`](/workspace/tools-github-issues-resolver/dist/rust/server/iago-server.exe)

### 2. Sync issues into the current repository

```powershell
dist\rust\cli\iago.exe sync --token <github-token>
```

If you do not provide `--token`, `iago` uses the local `iago-server` through the shared relay config.

### 3. List the local backlog

```powershell
dist\rust\cli\iago.exe list
```

### 4. Start work on an issue branch

```powershell
dist\rust\cli\iago.exe start-issue --issue 42
```

### 5. Finish an issue

```powershell
dist\rust\cli\iago.exe completed --issue 42 --files src/app.rs --title "Fix the bug" --token <github-token>
```

### 6. Create a GitHub issue

```powershell
dist\rust\cli\iago.exe create-issue --title "New bug" --description "Repro steps..." --label bug --token <github-token>
```

### 7. Run the server

```powershell
dist\rust\server\iago-server.exe serve
```

If you launch `iago-server.exe` without arguments, it opens the REPL.

Closing the console window does not stop the process. The server keeps running in the background.

### 8. Build the installer

```powershell
npm run build:windows-installer
```

The installer build uses Inno Setup and writes the installer output under [`dist/windows/installer/`](/workspace/tools-github-issues-resolver/dist/windows/installer/).

## CLI Guide

The `iago` CLI is the main working surface for repository-level issue management.

### Commands

- `sync`: Download open GitHub issues and store them locally in `.backlog/issues.json`.
- `list`: Print issues from the local backlog file.
- `show`: Print a single issue from the local backlog file.
- `start-issue`: Create or switch to the branch for an issue.
- `completed`: Stage files, commit the work, and close the issue.
- `report`: Create a new issue on the remote repository.
- `create-issue`: Same as `report`.
- `set-port`: Update the shared relay config with a new server port.
- `about`: Show project ownership and contact information.

### Common Options

- `--cwd <path>`: Start searching for the git repository from this directory.
- `--remote <name>`: Git remote to inspect. Defaults to `origin`.
- `--token <token>`: GitHub token.
- `--issue <number>`: Issue number for `show`, `start-issue`, or `completed`.
- `--title <text>`: Issue title or commit title.
- `--description <text>`: Issue description or commit body.
- `--label <name>`: Issue label for `report` and `create-issue`. Allowed values: `bug`, `improvement`, `feature`.
- `--files <paths>`: Files to stage for `completed`.
- `--push`: Push after `completed`.
- `--branch <name>`: Push target branch for `completed`.
- `--json`: Print the full result as JSON.
- `--output <path>`: Save the full result as JSON to a file.
- `--all`: Include improvement and feature issues in list output.
- `--relay`: Send `completed` through the local `iago-server`.
- `--relay-url <url>`: `iago-server` base URL. Defaults to the shared relay config.
- `--port <number>`: Update the shared relay config when using `set-port`.

### Authentication

The CLI does not use `lookup.tsv`.

Use one of these instead:

- `--token <token>`
- `GITHUB_TOKEN`
- `GH_TOKEN`

### Backlog Files

The CLI writes generated state into the repository it is operating on:

- `.backlog/issues.json`

These files are created at runtime and belong to the target repository, not this tool repository.

## iago-server Guide

The `iago-server` binary is the local companion process.

### Commands

- `serve`: Start the listener and keep the process alive.
- `repl`: Open the relay REPL.
- `add`: Register a repository in the relay vault.
- `issues`: Print issue counts for each repository in the relay vault without downloading the full issue list.
- `set-port`: Update the shared relay config with a new server port.
- `about`: Show project ownership and contact information.
- `client help`: Show the `iago` client command reference.

If you run the server without a command, it defaults to `repl`.

### Shared Relay Config

The client and server both read:

- `relay-config.json` in the shared app data folder for IAGO

That file stores the current relay port. If you run `set-port`, both apps use the new port the next time they read the config.
On Windows, the installed app uses `%LOCALAPPDATA%\IAGO\relay-config.json` so the client and server can both write it without admin rights.

### Default Network Settings

- Host: `127.0.0.1`
- Port: read from `relay-config.json`

### Vault Storage

The Rust server stores its vault data in:

- `vault.json` in the shared app data folder for IAGO

On Windows, the installed app uses `%LOCALAPPDATA%\IAGO\vault.json`.

Repository tokens in that vault are encrypted at rest with the compiled master key from
[`src/rust/server/src/config.rs`](/workspace/tools-github-issues-resolver/src/rust/server/src/config.rs).
Older plaintext entries are still readable and are rewritten encrypted the next time the vault is saved.

You can override the vault location with `--vault <path>`.

### REPL Commands

Inside the relay REPL:

- `add`: Add or update a repository in the vault
- `list`: Show stored repository entries
- `issues`: Print issue counts for each repository in the vault without downloading the full issue list
- `set-port`: Update the shared relay config with a new server port
- `about`: Show project ownership and contact information
- `client help`: Show the `iago` client command reference
- `help`: Show REPL help
- `quit`: Exit the REPL
- `exit`: Same as `quit`

### Windows Console Behavior

On Windows, `iago-server`:

- embeds [`assets/iago-icon.ico`](/workspace/tools-github-issues-resolver/assets/iago-icon.ico) into the executable
- keeps running if you close the console window
- hides the console when you click `X`

## Windows Installer

The installer script is in [`build/windows/installer/iago.iss`](/workspace/tools-github-issues-resolver/build/windows/installer/iago.iss).

The installer:

- installs both `iago.exe` and `iago-server.exe`
- adds the client directory to system `PATH`
- can register `iago-server` to start when the computer starts
- includes Start Menu entries for the client, the relay REPL, and the relay `issues` command
- uses [`assets/iago-icon.ico`](/workspace/tools-github-issues-resolver/assets/iago-icon.ico) for the installer and app icons

Build it with:

```powershell
npm run build:windows-installer
```

## Development

Useful checks from the repository root:

```powershell
npm test
dist\rust\cli\iago.exe --help
dist\rust\server\iago-server.exe --help
```

The CLI and server share implementation details through [`src/rust/shared/src/repository.rs`](/workspace/tools-github-issues-resolver/src/rust/shared/src/repository.rs).

## Troubleshooting

- If `sync` or `create-issue` fails with an authentication error, pass `--token` or set `GITHUB_TOKEN` / `GH_TOKEN`.
- If the relay port is already in use, stop the old server or choose a different `--port` and update `relay-config.json` with `set-port`.
- If `iago-server` says it cannot find the shared config directory, make sure `%LOCALAPPDATA%` is available and writable for your user.
- If the installer build fails, check that Inno Setup is installed and `iscc.exe` is available on `PATH`.
- If you are looking for the old file-based token lookup, it has been removed intentionally.
