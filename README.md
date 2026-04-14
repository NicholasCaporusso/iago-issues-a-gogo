# GitHub Issues Resolver

`tools-github-issues-resolver` is a Node.js CLI for syncing GitHub issues into a local backlog, reviewing them from the terminal, and recording issue completion back to the remote repository.

The tool is designed to run inside a Git repository. It discovers the repository root, reads the configured Git remote, talks to the GitHub Issues API, and stores a local cache in `.backlog/issues.json`.

## Features

- Sync open GitHub issues into a local backlog file, using the relay server when no local token is provided
- List cached issues from the backlog
- Show the full details for a single issue
- Create or switch to an issue branch
- Commit work for an issue and close the matching remote issue
- Create new GitHub issues from the CLI
- Download remote issue images into `.backlog/images/<issue-number>/` and rewrite issue bodies to point to the local files

## Requirements

- Node.js 18 or newer
- A Git repository with a configured GitHub remote
- A GitHub token supplied with `--token`, `GITHUB_TOKEN`, `GH_TOKEN`, or `lookup.tsv`

## Installation

Install dependencies if you add any later, then run the CLI directly with Node:

```bash
node ./cli/cli.js --help
```

The package metadata also defines a global executable name, so installing the package exposes `github-issues-resolver` from any folder:

```bash
github-issues-resolver --help
```

The same global install also exposes the relay server as `issues-relay-server`:

```bash
issues-relay-server --help
```

## Authentication

Commands that talk to GitHub require a token. The CLI checks for credentials in this order:

1. `--token <token>`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `lookup.tsv`

`lookup.tsv` should contain one repository per line in tab-separated format:

```tsv
https://github.com/owner/repo.git    ghp_exampleToken
```

## Backlog Layout

After a successful sync, the CLI writes:

- `.backlog/issues.json`: cached issue metadata and descriptions
- `.backlog/images/<issue-number>/`: downloaded images referenced by issue descriptions

If an issue body contains Markdown or HTML image tags that point to remote URLs, those files are downloaded locally and the issue description stored in the backlog is rewritten to use the local relative paths.

## Usage

```bash
node ./cli/cli.js [command] [options]
```

## Commands

### `sync`

Downloads open issues from the configured GitHub remote and saves them to `.backlog/issues.json`. If the CLI does not have a token, it sends the sync request to the relay server instead.

```bash
node ./cli/cli.js sync
node ./cli/cli.js sync --remote upstream
node ./cli/cli.js sync --output tmp/issues.json --json
```

### `list`

Reads the backlog and prints the active issue list. By default, only open issues with no labels or the `bug` label are shown. Use `--all` to include `improvement` and `feature` issues too.

```bash
node ./cli/cli.js list
node ./cli/cli.js list --all
```

### `show`

Prints the full details for a single issue from `.backlog/issues.json`.

```bash
node ./cli/cli.js show --issue 12
node ./cli/cli.js show --issue 12 --json
```

### `start-issue`

Creates or switches to the Git branch for an issue. Branches use the format `issue/<number>`.

```bash
node ./cli/cli.js start-issue --issue 12
```

### `mark-done`

Stages changes, creates a Git commit, and closes the remote issue.

If `--files` is omitted, the command stages all changes with `git add .`.

```bash
node ./cli/cli.js mark-done --issue 12 --title "Add README" --description "Document setup and command usage"
node ./cli/cli.js mark-done --issue 12 --description "Fix parser edge case" --files cli/cli.js README.md
node ./cli/cli.js mark-done --issue 12 --title "Fix issue 12" --description "Patch and tests" --push --branch issue/12
```

When both `--title` and `--description` are present, the commit message uses the title as the subject and the description as the body:

```text
fix(issue): close #12 - Add README

Document setup and command usage
```

### `create-issue`

Creates a new GitHub issue on the configured remote repository.

```bash
node ./cli/cli.js create-issue --title "Add tests" --description "Cover sync and list flows"
node ./cli/cli.js create-issue --title "Improve docs" --description "Document token lookup" --label improvement
```

Supported labels are:

- `bug`
- `improvement`
- `feature`

## Options

- `--cwd <path>`: Start searching for the Git repository from this directory
- `--remote <name>`: Use a different Git remote instead of `origin`
- `--token <token>`: Provide a GitHub token directly
- `--all`: Include `improvement` and `feature` issues in `list` output
- `--issue <number>`: Issue number for `show`, `start-issue`, or `mark-done`
- `--title <text>`: Title for `create-issue`, or the commit subject for `mark-done`
- `--description <text>`: Description for `create-issue`, or commit text for `mark-done`
- `--label <name>`: Issue label for `create-issue`; supported values are `bug`, `improvement`, and `feature`
- `--files <paths>`: Explicit file list to stage during `mark-done`
- `--push`: Push after `mark-done`
- `--branch <name>`: Push target branch for `mark-done`
- `--json`: Print JSON output
- `--output <path>`: Save JSON output to a file
- `--help`, `-h`: Show the help text

## Typical Workflow

```bash
node ./cli/cli.js sync
node ./cli/cli.js list
node ./cli/cli.js show --issue 12
node ./cli/cli.js start-issue --issue 12
# edit files
node ./cli/cli.js mark-done --issue 12 --title "Fix issue 12" --description "Explain the change here"
```

## Notes

- The CLI looks for `.git` in the current directory and its parents, so it can be run from subdirectories inside a repository.
- For GitHub Enterprise remotes, API requests are sent to `https://<host>/api/v3`.
- `show` and `list` use the local backlog cache. Run `sync` first if you want the latest remote state.
