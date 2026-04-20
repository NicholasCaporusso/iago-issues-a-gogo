# IAGO CLI

This is the main command-line entrypoint for working with GitHub issues from a local git repository.

The CLI can:
- sync open issues into a local backlog file
- sync open issues before listing backlog issues
- start an issue branch
- create a commit for an issue and close it on GitHub
- create issues on the remote repository
- hand completed work off to the local `iago-server` when needed
- update the shared relay config port with `set-port`

The CLI no longer uses any `lookup.tsv` file. Authentication comes only from:
- `--token <token>`
- `GITHUB_TOKEN`
- `GH_TOKEN`

## Location

- Source: [`src/node/cli/cli.js`](/workspace/tools-github-issues-resolver/src/node/cli/cli.js)
- Package binary: `iago`

## Installation

From the repository root:

```bash
npm install
```

If you want the local package binary available in the project:

```bash
npm start -- --help
```

## Usage

```bash
iago [command] [options]
```

If no command is provided, the CLI defaults to `sync`.

## Commands

### `sync`

Download open issues and save them to `.backlog/issues.json`.

If no token is provided, the CLI falls back to the local `iago-server`.

### `list`

Sync open issues, then read and print issues from `.backlog/issues.json`.

### `show`

Print one issue from `.backlog/issues.json`.

### `start-issue`

Create or switch to the branch for an issue.

### `add repo`

Register the current repository in the relay vault.

This command requires:
- `--token <token>`

### `completed`

Stage files, create the issue-fix commit, and close the issue on GitHub.

### `report` / `create-issue`

Create a new issue on the remote repository. If no token is available, the CLI uses the relay automatically.

## Options

- `--cwd <path>`: Start searching for the git repository from this directory.
- `--remote <name>`: Git remote to inspect. Defaults to `origin`.
- `--token <token>`: GitHub token.
- `--all`: Include improvement and feature issues in list output.
- `--issue <number>`: Issue number for `show`, `start-issue`, or `completed`.
- `--title <text>`: Issue title for `report` / `create-issue` or commit title for `completed`.
- `--description <text>`: Issue description for `report` / `create-issue` or commit text for `completed`.
- `--label <name>`: Issue label for `report` / `create-issue`. One of `bug`, `improvement`, or `feature`.
- `--files <paths>`: Files to stage for `completed`.
- `--push`: Push after `completed`.
- `--save`: Ask the relay flow to push after `completed`.
- `--branch <name>`: Push target branch for `completed`.
- `add repo --token <token>`: Register the current repository in the relay vault.
- `--relay`: Send `report` or `completed` to the local `iago-server` instead of using a direct GitHub token.
- `--relay-url <url>`: `iago-server` base URL. Defaults to the shared relay config.
- `--port <number>`: Update the shared relay config when using `set-port`.
- `--json`: Print the full result as JSON.
- `--output <path>`: Save the full result as JSON to a file.
- `--help`, `-h`: Show help.

## Shared relay config

The CLI and `iago-server` both read `relay-config.json` at the workspace root. Use `set-port --port <number>` to update it.

## Examples

Sync issues using the current repo and your environment token:

```bash
iago sync
```

List backlog issues, including improvement and feature items:

```bash
iago list --all
```

Start a branch for issue 42:

```bash
iago start-issue --issue 42
```

Create a commit and close issue 42:

```bash
iago completed --issue 42 --files src/node/cli/cli.js --title "Fix CLI help"
```

Create a new issue:

```bash
iago create-issue --title "Bug report" --description "Short summary"
```

Register the current repository in the relay vault:

```bash
iago add repo --token <github-token>
```

Use the local `iago-server` for the completion flow:

```bash
iago completed --issue 42 --relay
```

## Runtime files

The CLI writes backlog data into the repository it runs against:

- `.backlog/issues.json`
- `.backlog/images/<issue-number>/...`

These files are generated at runtime and are not part of the CLI source tree itself.

## Development

From the repository root:

```bash
npm test
npm run build:windows-exe
```

The CLI implementation shares repository and GitHub helpers from [`src/node/shared/repository.js`](/workspace/tools-github-issues-resolver/src/node/shared/repository.js).
