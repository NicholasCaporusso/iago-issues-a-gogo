# Relay Server

This folder contains a separate local process that can accept `completed --relay` requests from the CLI and perform the real commit outside the sandboxed agent environment.

## Start The Server

```bash
node ./relay-server/server.js serve
```

The server listens on `127.0.0.1:4317` by default.

## Register A Repository

```bash
node ./relay-server/server.js add-repo --url https://github.com/owner/repo.git --folder C:\path\to\repo --token ghp_example
```

The relay vault stores:

- repository URL
- repository folder
- GitHub token

## Relay Completion

Once a repository is registered, the CLI can send completion requests to the server:

```bash
node ./index.js completed --issue 12 --title "Fix issue 12" --description "Explain the change here." --relay
```

The CLI sends the repository URL and folder together with the completion payload. The server validates both against its vault before committing.
