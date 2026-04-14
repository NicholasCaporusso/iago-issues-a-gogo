# Relay Server

This is the local relay server used by the CLI when a direct GitHub token is not available or when you want to route completion through a separate process.

It provides:
- an HTTP server for relay requests
- a small REPL for managing the relay vault
- encrypted storage for repository tokens

The server no longer uses any `lookup.tsv` file.

## Location

- Source: [`src/node/server/server.js`](/workspace/tools-github-issues-resolver/src/node/server/server.js)
- Default vault file: [`src/node/server/vault/repos.json`](/workspace/tools-github-issues-resolver/src/node/server/vault/repos.json)
- Package binary: `issues-relay-server`

## Installation

From the repository root:

```bash
npm install
```

## Usage

```bash
node ./server.js serve [--host 127.0.0.1] [--port <port>]
node ./server.js repl
 node ./server.js add --url <repository-url> --folder <repository-folder> --token <github-token>
node ./server.js set-port --port <port>
```

If no command is provided, the server defaults to `serve`.

## Commands

### `serve`

Start the HTTP listener and open the vault REPL in the same process.

The server listens on:
- host: `127.0.0.1`
- port: the value stored in `relay-config.json` at the workspace root

### `repl`

Open the relay vault REPL without starting the HTTP listener.

### `add`

Add or update a repository entry in the relay vault.

This stores:
- the repository URL
- the repository folder
- the GitHub token

## REPL commands

Inside the relay REPL:

- `add`: Add or update a repository in the relay vault.
- `list`: Show the repositories currently stored in the vault.
- `set-port`: Update the shared relay config with a new server port.

## Shared config

The client and the server both read `relay-config.json` at the workspace root. Use `set-port --port <number>` to update it.
- `help`: Show REPL help.
- `quit`: Leave the REPL.

`add` accepts the same `--url`, `--folder`, and `--token` flags as the command-line form.

## HTTP endpoints

The relay server exposes:
- `GET /health`: Returns a simple health check response.
- `POST /sync`: Sync issues for a registered repository.
- `POST /completed`: Close an issue after relay-driven completion.

## Vault storage

The relay vault lives at `src/node/server/vault/repos.json` by default.

You can override it with:

```bash
node ./server.js serve --vault <path>
```

Tokens in the vault are encrypted before being written to disk.

## Examples

Start the relay server:

```bash
node ./server.js serve
```

Open the vault REPL:

```bash
node ./server.js repl
```

Register a repository:

```bash
node ./server.js add --url https://github.com/owner/repo --folder C:\path\to\repo --token ghp_example
```

## Development

From the repository root:

```bash
npm test
npm run build:windows-server-exe
```

The server reuses the shared Git and GitHub helpers from [`src/node/shared/repository.js`](/workspace/tools-github-issues-resolver/src/node/shared/repository.js).
