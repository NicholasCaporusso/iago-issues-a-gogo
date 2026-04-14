# Relay Server

This folder contains a separate local process that can accept `completed --relay` requests from the CLI and perform the real commit outside the sandboxed agent environment. It also handles `sync` requests when the CLI does not have a local token.

## Start The Server

```bash
node ./server.js serve
```

The server listens on `127.0.0.1:4317` by default and opens the REPL in the same process.

If you install the root package globally, the relay server is also exposed as `issues-relay-server`.

## Open The REPL

```bash
node ./server.js repl
```

The REPL accepts `add` to register or update repositories, `list` to inspect the vault, and `quit` to leave.

Examples:

```bash
add --url https://github.com/owner/repo.git --folder C:\path\to\repo --token ghp_example
add --url https://github.com/owner/repo.git
```

If you omit any of the `add` fields, the REPL prompts for the missing values.

## Register A Repository

```bash
node ./server.js add-repo --url https://github.com/owner/repo.git --folder C:\path\to\repo --token ghp_example
```

The relay vault stores:

- repository URL
- repository folder
- GitHub token, encrypted on disk with the relay server key

## Relay Completion

Once a repository is registered, the CLI can send completion requests to the server:

```bash
node ./server.js completed --issue 12 --title "Fix issue 12" --description "Explain the change here." --relay
```

The CLI sends the repository URL and folder together with the completion payload. The server validates both against its vault before committing.

For tokenless syncs, the CLI sends the same repository URL and folder to `/sync`, and the server uses the registered token from its vault.
