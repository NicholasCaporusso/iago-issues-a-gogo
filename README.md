# GitHub Issues Resolver

This repository contains two related apps:
- a CLI for syncing, listing, creating, and closing GitHub issues from a local git repository
- a local relay server that can store repository tokens and handle issue completion when the CLI should not talk to GitHub directly

The Rust workspace scaffold now lives in `src/rust/`, with Windows packaging helpers in `build/rust/`.
The existing Node implementation remains in `src/node/` while the Rust translation is finished.

## What's in the repo

- Rust workspace guide: [`src/rust/README.md`](/workspace/tools-github-issues-resolver/src/rust/README.md)
- Rust shared crate: [`src/rust/shared/src/repository.rs`](/workspace/tools-github-issues-resolver/src/rust/shared/src/repository.rs)
- Rust CLI entrypoint: [`src/rust/cli/src/main.rs`](/workspace/tools-github-issues-resolver/src/rust/cli/src/main.rs)
- Rust relay server entrypoint: [`src/rust/server/src/main.rs`](/workspace/tools-github-issues-resolver/src/rust/server/src/main.rs)
- Rust CLI build script: [`build/rust/cli/build-windows-exe.ps1`](/workspace/tools-github-issues-resolver/build/rust/cli/build-windows-exe.ps1)
- Rust relay server build script: [`build/rust/server/build-windows-exe.ps1`](/workspace/tools-github-issues-resolver/build/rust/server/build-windows-exe.ps1)

## Requirements

- Node.js 18 or newer
- Git installed and available on `PATH`
- A GitHub token when you want to talk to GitHub directly

## Install

From the repository root:

```bash
npm install
```

That installs the dev dependency used for Windows single-executable builds.

## Quick Start

The Rust binaries are scaffolded but not yet feature-complete. The current Node implementation still provides the working behavior until the Rust translation is finished.

### 1. Sync issues into the current repository

```bash
node ./src/node/cli/cli.js sync --token <github-token>
```

This writes the issue backlog to `.backlog/issues.json` in the repository you run it against.

### 2. List the local backlog

```bash
node ./src/node/cli/cli.js list
```

### 3. Start work on an issue branch

```bash
node ./src/node/cli/cli.js start-issue --issue 42
```

### 4. Finish an issue

```bash
node ./src/node/cli/cli.js completed --issue 42 --files src/app.js --title "Fix the bug" --token <github-token>
```

### 5. Use the relay server instead of a direct token

Start the relay server:

```bash
node ./src/node/server/server.js serve
```

Then run the CLI without a direct token:

```bash
node ./src/node/cli/cli.js sync
node ./src/node/cli/cli.js completed --issue 42 --relay
```

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
- `--save`: Ask the relay flow to push after `completed`.
- `--branch <name>`: Push target branch for `completed`.
- `--relay`: Send `completed` to the local relay server instead of committing directly.
- `--relay-url <url>`: Relay server base URL. Defaults to `http://127.0.0.1:4317`.
- `--json`: Print the full result as JSON.
- `--output <path>`: Save the full result as JSON to a file.
- `--all`: Include improvement and feature issues in list output.

### Authentication

The CLI no longer supports `lookup.tsv`.

Use one of these instead:
- `--token <token>`
- `GITHUB_TOKEN`
- `GH_TOKEN`

If you use `sync` or `completed --relay` without a token, the CLI can fall back to the relay server.

### Backlog files

The CLI writes generated state into the repository it is operating on:
- `.backlog/issues.json`
- `.backlog/images/<issue-number>/...`

These files are created at runtime and belong to the target repository, not this tool repository.

## Relay Server Guide

The relay server is for local coordination and token storage.

### Commands

- `serve`: Start the HTTP listener and open the REPL in the same process.
- `repl`: Open the relay vault REPL without starting the HTTP listener.
- `add-repo`: Add or update a repository entry in the relay vault.

If you run the server without a command, it defaults to `serve`.

### Default network settings

- Host: `127.0.0.1`
- Port: `4317`

### Vault storage

The current Node server uses:
- [`src/node/server/vault/repos.json`](/workspace/tools-github-issues-resolver/src/node/server/vault/repos.json)

The Rust scaffold uses:
- [`src/rust/server/vault/repos.json`](/workspace/tools-github-issues-resolver/src/rust/server/vault/repos.json)

You can override it with `--vault <path>`.

Tokens stored in the vault are encrypted before being written to disk.

### REPL commands

Inside the relay REPL:
- `add`: Add or update a repository in the vault
- `list`: Show stored repository entries
- `help`: Show REPL help
- `quit`: Exit the REPL

### HTTP endpoints

The relay server exposes:
- `GET /health`
- `POST /sync`
- `POST /completed`

## Build Windows executables

The repo includes packaging scripts for Windows single-executable builds.

```bash
npm run build:windows-exe
npm run build:windows-server-exe
```

The resulting binaries are written to:
- `dist/rust/cli/github-issues-resolver.exe`
- `dist/rust/server/issues-relay-server.exe`

## Development

Useful checks from the repo root:

```bash
npm test
node ./src/node/cli/cli.js --help
node ./src/node/server/server.js --help
```

The CLI and server share implementation details through [`src/node/shared/repository.js`](/workspace/tools-github-issues-resolver/src/node/shared/repository.js), and the Rust workspace mirrors that structure in [`src/rust/shared/src/repository.rs`](/workspace/tools-github-issues-resolver/src/rust/shared/src/repository.rs).

## Troubleshooting

- If `sync` fails with an authentication error, pass `--token` or set `GITHUB_TOKEN` / `GH_TOKEN`.
- If the relay server says a repository is not registered, add it with `node ./src/node/server/server.js add-repo ...`.
- If port `4317` is already in use, stop the old relay server or choose a different `--port`.
- If you are looking for the old file-based token lookup, it has been removed intentionally.
