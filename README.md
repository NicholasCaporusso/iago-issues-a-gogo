# IAGO

This repository now centers on the IAGO implementation:
- the `iago` CLI for syncing, listing, showing, branching, committing, and creating GitHub issues
- the `iago-server` local server binary that keeps the process alive and provides the shell entrypoint

The Rust workspace lives in `src/rust/` and the Windows packaging helpers live in `build/rust/`.
The older Node sources remain in `src/node/` for reference.

## What’s in the repo

- Rust workspace guide: [`src/rust/README.md`](/workspace/tools-github-issues-resolver/src/rust/README.md)
- Rust shared crate: [`src/rust/shared/src/repository.rs`](/workspace/tools-github-issues-resolver/src/rust/shared/src/repository.rs)
- Rust CLI entrypoint: [`src/rust/cli/src/main.rs`](/workspace/tools-github-issues-resolver/src/rust/cli/src/main.rs)
- Rust server entrypoint: [`src/rust/server/src/main.rs`](/workspace/tools-github-issues-resolver/src/rust/server/src/main.rs)
- Rust CLI build script: [`build/rust/cli/build-windows-exe.ps1`](/workspace/tools-github-issues-resolver/build/rust/cli/build-windows-exe.ps1)
- Rust server build script: [`build/rust/server/build-windows-exe.ps1`](/workspace/tools-github-issues-resolver/build/rust/server/build-windows-exe.ps1)

## Requirements

- Rust toolchain with `cargo` and `rustc`
- Git installed and available on `PATH`
- A GitHub token when you want to talk to GitHub directly
- Node.js 18 or newer if you want to run `npm` scripts

## Install

From the repository root:

```bash
npm install
```

That installs the dev dependency used for Windows single-executable builds.

## Quick Start

### 1. Sync issues into the current repository

```bash
dist/rust/cli/iago.exe sync --token <github-token>
```

This writes the issue backlog to `.backlog/issues.json` in the repository you run it against.

### 2. List the local backlog

```bash
dist/rust/cli/iago.exe list
```

### 3. Start work on an issue branch

```bash
dist/rust/cli/iago.exe start-issue --issue 42
```

### 4. Finish an issue

```bash
dist/rust/cli/iago.exe completed --issue 42 --files src/app.rs --title "Fix the bug" --token <github-token>
```

### 5. Create a GitHub issue

```bash
dist/rust/cli/iago.exe create-issue --title "New bug" --description "Repro steps..." --label bug --token <github-token>
```

### 6. Run the server

```bash
dist/rust/server/iago-server.exe repl
```

The current Rust server keeps the process alive in `serve` and `repl` mode. The shell is available, but the full HTTP relay workflow is still being translated.

## CLI Guide

The CLI is the main working surface for repository-level issue management.

### Commands

- `sync`: Download open GitHub issues and store them locally in `.backlog/issues.json`.
- `list`: Print issues from the local backlog file.
- `show`: Print a single issue from the local backlog file.
- `start-issue`: Create or switch to the branch for an issue.
- `completed`: Stage files, commit the work, and close the issue.
- `report`: Create a new issue on the remote repository.
- `create-issue`: Same as `report`.
- `set-port`: Update the shared relay config with a new server port.

### Common options

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
- `--relay`: Reserved for relay-based completion flows; the Rust CLI currently keeps direct GitHub mode as the primary path.
- `--relay-url <url>`: iago-server base URL. Defaults to the shared relay config.
- `--port <number>`: Update the shared relay config when using `set-port`.

### Authentication

The CLI no longer supports `lookup.tsv`.

Use one of these instead:
- `--token <token>`
- `GITHUB_TOKEN`
- `GH_TOKEN`

### Backlog files

The CLI writes generated state into the repository it is operating on:
- `.backlog/issues.json`

These files are created at runtime and belong to the target repository, not this tool repository.

## iago-server Guide

The server is the local companion process.

### Commands

- `serve`: Start the listener and keep the process alive.
- `repl`: Open the relay REPL without the listener.
- `add`: Register a repository in the relay vault.
- `set-port`: Update the shared relay config with a new server port.

If you run the server without a command, it defaults to `serve`.

### Shared relay config

The client and server both read:
- [`relay-config.json`](/workspace/tools-github-issues-resolver/relay-config.json)

That file stores the current relay port. If you run `set-port`, both apps will use the new port the next time they read the config.

### Default network settings

- Host: `127.0.0.1`
- Port: read from `relay-config.json`

### Vault storage

The Rust server stores its vault data in:
- [`src/rust/server/vault/repos.json`](/workspace/tools-github-issues-resolver/src/rust/server/vault/repos.json)

Repository tokens in that vault are encrypted at rest with the compiled master key from
[`src/rust/server/src/config.rs`](/workspace/tools-github-issues-resolver/src/rust/server/src/config.rs).
Older plaintext entries are still readable and are re-written encrypted the next time the vault is saved.

You can override it with `--vault <path>`.

### REPL commands

Inside the relay REPL:
- `add`: Add or update a repository in the vault
- `list`: Show stored repository entries
- `help`: Show REPL help
- `quit`: Exit the REPL

## Build Windows executables

The repo includes packaging scripts for Windows single-executable builds.

```bash
npm run build:windows-exe
npm run build:windows-server-exe
```

The resulting binaries are written to:
- `dist/rust/cli/iago.exe`
- `dist/rust/server/iago-server.exe`

## Development

Useful checks from the repo root:

```bash
npm test
dist/rust/cli/iago.exe --help
dist/rust/server/iago-server.exe --help
```

The CLI and server share implementation details through [`src/rust/shared/src/repository.rs`](/workspace/tools-github-issues-resolver/src/rust/shared/src/repository.rs).

## Troubleshooting

- If `sync` or `create-issue` fails with an authentication error, pass `--token` or set `GITHUB_TOKEN` / `GH_TOKEN`.
- If the relay port is already in use, stop the old server or choose a different `--port` and update `relay-config.json` with `set-port`.
- If you are looking for the old file-based token lookup, it has been removed intentionally.
