# GitHub Issues Resolver

`tools-github-issues-resolver` is a Node.js CLI for pulling GitHub issues into a local backlog, reviewing them from the terminal, starting issue branches, and recording completed work back to the repository.

It is built to run inside a Git repository that already has a GitHub remote configured. The CLI discovers the repository root, reads the remote from Git config, talks to the GitHub Issues API, and stores a local cache under `.backlog/`.

## What It Does

- Syncs open GitHub issues into `.backlog/issues.json`
- Lists active issues from the local backlog cache
- Shows the full body for a specific issue
- Creates or switches to an `issue/<number>` branch
- Stages and commits work for an issue, then attempts to close it on GitHub
- Creates new GitHub issues from the command line
- Downloads remote images referenced in issue bodies into `.backlog/images/<issue-number>/`

## Requirements

- Node.js 18 or newer
- A Git repository with a configured GitHub remote such as `origin`
- A GitHub token provided by one of the supported authentication methods

## Authentication

Commands that talk to GitHub need a token. The CLI checks for credentials in this order:

1. `--token <token>`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `lookup.tsv`

The bundled `lookup.tsv` file is expected to use tab-separated values:

```tsv
https://github.com/owner/repo.git	ghp_exampleToken
```

The repository URL is normalized before comparison, so HTTPS and SSH remotes for the same repo will still match.

## Installation And Running

This repository does not require a build step. Run the CLI directly with Node:

```bash
node ./cli/cli.js --help
```

You can also use the package script:

```bash
npm start -- --help
```

To install the CLI globally from this repository and run it from any folder:

```bash
npm install -g .
github-issues-resolver --help
```

To build a distributable tarball first:

```bash
npm pack
npm install -g tools-github-issues-resolver-1.0.0.tgz
```

## Relay Setup

If the agent environment cannot write to `.git`, run the relay server as a separate trusted process:

```bash
node ./relay-server/server.js serve
node ./relay-server/server.js add-repo --url https://github.com/owner/repo.git --folder /path/to/repo --token ghp_example
```

Then use `completed --relay` from the CLI. The CLI sends the repository URL and folder to the relay server, and the relay validates both against its vault before committing.
If you also want the relay server to push after the completion commit, add `--save`.

## Usage

```bash
node ./cli/cli.js [command] [options]
```

If you omit the command, the CLI shows the help text.

## Commands

### `sync`

Fetches open GitHub issues from the configured remote and writes the local backlog file.

If the CLI does not have a token, `sync` sends the request to the local relay server and the server uses its vault-stored token for that repository.

```bash
node ./cli/cli.js sync
node ./cli/cli.js sync --remote upstream
node ./cli/cli.js sync --json
node ./cli/cli.js sync --output tmp/issues.json
```

Notes:

- Pull requests are filtered out automatically
- Images referenced in issue descriptions are downloaded locally when possible
- `sync` prints only open issues after applying the same filtering rules as `list`

### `list`

Reads `.backlog/issues.json` and prints the active issue queue.

```bash
node ./cli/cli.js list
node ./cli/cli.js list --all
node ./cli/cli.js list --json
```

By default, `list` only shows open issues that either:

- have no labels, or
- include the `bug` label

Use `--all` to include `improvement` and `feature` issues as well.

### `show`

Displays the full details for a single issue from the local backlog cache.

```bash
node ./cli/cli.js show --issue 12
node ./cli/cli.js show --issue 12 --json
```

If the backlog cache does not exist yet, the CLI will sync first.

### `start-issue`

Creates or switches to the local Git branch for an issue. The branch format is `issue/<number>`.

```bash
node ./cli/cli.js start-issue --issue 12
```

### `completed`

Stages changes, creates a Git commit for the issue, and then attempts to close the matching GitHub issue. It can also push the branch when requested.

```bash
node ./cli/cli.js completed --issue 12 --title "Document CLI usage" --description "Rewrite README to match the live commands."
node ./cli/cli.js completed --issue 12 --description "Fix edge case in image extension detection." --files cli/cli.js README.md
node ./cli/cli.js completed --issue 12 --title "Close issue 12" --description "Patch implementation and update docs." --push --branch issue/12
node ./cli/cli.js completed --issue 12 --title "Close issue 12" --description "Patch implementation and update docs." --relay
node ./cli/cli.js completed --issue 12 --title "Close issue 12" --description "Patch implementation and update docs." --relay --save
```

Behavior:

- If `--files` is omitted, the CLI stages everything with `git add .`
- A commit requires `--title`, `--description`, or both
- If both are provided, the title becomes the commit subject and the description becomes the commit body
- After committing, the CLI attempts to close the GitHub issue and update the cached backlog state
- If `--relay` is provided, the CLI sends the completion request to a local relay server instead of committing directly
- If `--save` is provided with `--relay`, the relay server also pushes after the completion commit

### `report`

Creates a new GitHub issue on the configured remote repository.

```bash
node ./cli/cli.js report --title "Add tests" --description "Cover sync and list flows."
```

### `create-issue`

Creates a new GitHub issue on the configured remote repository. This is an alias of `report`.

```bash
node ./cli/cli.js create-issue --title "Add tests" --description "Cover sync and list flows."
node ./cli/cli.js create-issue --title "Improve docs" --description "Clarify token lookup behavior." --label improvement
```

Supported labels:

- `bug`
- `improvement`
- `feature`

## Options

- `--cwd <path>`: Start searching for the Git repository from this directory
- `--remote <name>`: Git remote to inspect, defaulting to `origin`
- `--token <token>`: GitHub token to use for API calls
- `--all`: Include `improvement` and `feature` issues in `list` and `sync` output
- `--issue <number>`: Issue number for `show`, `report`, or `completed`
- `--title <text>`: Issue title for `create-issue`, or commit title for `completed`
- `--description <text>`: Issue description for `create-issue`, or commit message text for `completed`
- `--label <name>`: Issue label for `create-issue`
- `--files <paths>`: Explicit file list to stage during `completed`
- `--push`: Push after `completed`
- `--save`: When used with `completed --relay`, ask the relay server to push after committing
- `--branch <name>`: Push target branch for `completed`
- `--relay`: Send `completed` to a local relay server instead of committing directly
- `--relay-url <url>`: Relay server base URL for `completed --relay`, defaulting to `http://127.0.0.1:4317`
- `--json`: Print JSON output instead of formatted text
- `--output <path>`: Save JSON output to a file during `sync`
- `--help`, `-h`: Show the help text

## Backlog Layout

After a successful sync, the CLI writes files under `.backlog/`:

- `.backlog/issues.json`: cached issue metadata, labels, and descriptions
- `.backlog/images/<issue-number>/`: downloaded copies of images referenced by issue bodies

When an issue body contains Markdown image syntax or HTML `<img>` tags that point at remote URLs, the CLI downloads those files and rewrites the cached issue description to use local relative paths.

## Typical Workflow

```bash
node ./cli/cli.js sync
node ./cli/cli.js list
node ./cli/cli.js show --issue 12
node ./cli/cli.js start-issue --issue 12
# edit files
node ./cli/cli.js completed --issue 12 --title "Fix issue 12" --description "Explain the change here." --relay
```

## Notes

- The CLI searches upward from the current directory until it finds `.git`, so you can run it from subdirectories inside the repository
- GitHub Enterprise remotes are supported through `https://<host>/api/v3`
- `show` and `list` primarily use the local backlog cache; run `sync` when you want the latest open issue state
