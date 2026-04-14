# GitHub Issues Resolver CLI

This is the main command-line entrypoint for working with GitHub issues from a local git repository.

The CLI can:
- sync open issues into a local backlog file
- list and inspect backlog issues
- start an issue branch
- create a commit for an issue and close it on GitHub
- create issues on the remote repository
- hand completed work off to the local relay server when needed

The CLI no longer uses any `lookup.tsv` file. Authentication comes only from:
- `--token <token>`
- `GITHUB_TOKEN`
- `GH_TOKEN`

## Location

- Source: [`src/node/cli/cli.js`](/workspace/tools-github-issues-resolver/src/node/cli/cli.js)
- Package binary: `github-issues-resolver`

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
github-issues-resolver [command] [options]
```

If no command is provided, the CLI defaults to `sync`.

## Commands

### `sync`

Download open issues and save them to `.backlog/issues.json`.

If no token is provided, the CLI falls back to the local relay server.

### `list`

Read and print issues from `.backlog/issues.json`.

### `show`

Print one issue from `.backlog/issues.json`.

### `start-issue`

Create or switch to the branch for an issue.

### `completed`

Stage files, create the issue-fix commit, and close the issue on GitHub.

### `report` / `create-issue`

Create a new issue on the remote repository.

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
- `--relay`: Send `completed` to the local relay server instead of committing directly.
- `--relay-url <url>`: Relay server base URL. Defaults to `http://127.0.0.1:4317`.
- `--json`: Print the full result as JSON.
- `--output <path>`: Save the full result as JSON to a file.
- `--help`, `-h`: Show help.

## Examples

Sync issues using the current repo and your environment token:

```bash
github-issues-resolver sync
```

List backlog issues, including improvement and feature items:

```bash
github-issues-resolver list --all
```

Start a branch for issue 42:

```bash
github-issues-resolver start-issue --issue 42
```

Create a commit and close issue 42:

```bash
github-issues-resolver completed --issue 42 --files src/node/cli/cli.js --title "Fix CLI help"
```

Create a new issue:

```bash
github-issues-resolver create-issue --title "Bug report" --description "Short summary"
```

Use the local relay server for the completion flow:

```bash
github-issues-resolver completed --issue 42 --relay
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
