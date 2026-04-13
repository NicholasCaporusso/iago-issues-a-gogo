# GitHub Issues Resolver

Small Node.js CLI that:

- finds the nearest `.git` repository
- reads a remote URL from `.git/config`
- extracts the GitHub owner/repo from that remote
- calls the GitHub API and fetches all open issues
- includes each issue description body
- downloads issue-linked images into `backlog/images/<issueID>/`
- rewrites image references in the description to those local relative paths
- requires a token from `--token`, `GITHUB_TOKEN`, or `GH_TOKEN` for remote GitHub actions
- exposes a helper to stage files, commit an issue fix, and optionally push

## Requirements

- Node.js 18 or newer

## Usage

```bash
npm start
```

Before using commands that talk to GitHub, set a token:

```bash
export GITHUB_TOKEN=YOUR_TOKEN
```

PowerShell:

```powershell
$env:GITHUB_TOKEN="YOUR_TOKEN"
```

If a token is not provided directly, the app also checks `lookup.tsv` for a matching repository URL and uses the associated token.

With options:

```bash
node ./src/index.js sync
node ./src/index.js list
node ./src/index.js list --all
node ./src/index.js show --issue 123
node ./src/index.js create-issue --title "Add retry logic" --description "Found while investigating #123" --label improvement
node ./src/index.js start-issue --issue 123
node ./src/index.js commit-fix --issue 123 --description "Implement fix" --files src/index.js README.md
node ./src/index.js commit-fix --issue 123 --title "Implement fix" --description "Add parser fallback and tests" --files src/index.js README.md
node ./src/index.js commit-fix --issue 123 --description "Checkpoint current work"
```

Agent instructions are available in [AGENT.md](C:\workspace\tools-github-issues-resolver\AGENT.md).

## Commands

- `sync`: fetches open issues and writes `backlog/issues.json`
- `list`: reads and prints open issues from `backlog/issues.json`
- `show --issue <id>`: prints one issue
- `create-issue --title "..." [--description "..."] [--label bug|improvement|feature]`: creates a new issue in the remote repository
- `start-issue --issue <id>`: creates or switches to `issue/<id>`
- `commit-fix --issue <id> --description "..." --files ... [--push]`: stages files, commits, closes the issue, and optionally pushes
- `commit-fix --issue <id> --title "..." [--description "..."] [--files ...] [--push]`: stages files, creates a title/description commit, closes the issue, and optionally pushes

If `commit-fix` is run without `--files`, it stages all current changes with `git add .`.

By default, `list` excludes open issues labeled `improvement` or `feature`. Use `--all` to include them.

`sync` and `create-issue` require a GitHub token. Resolution order is:

1. `--token`
2. `GITHUB_TOKEN`
3. `GH_TOKEN`
4. `lookup.tsv`

`lookup.tsv` format:

```tsv
https://github.com/owner/repo.git<TAB>ghp_xxx
git@github.com:owner/other-repo.git<TAB>ghp_yyy
```

## Output

By default the CLI prints a readable issue summary. Use `--json` to print machine-readable output or `--output <path>` to save synced issue JSON to a file.

When an issue description contains Markdown images or HTML `<img>` tags, the image files are downloaded under `backlog/images/<issueID>/` and the description text is rewritten to use the local relative path instead.

## Git Helper

The module also exports `commitIssueFix(...)` for local git automation. It:

- stages the files you pass in
- creates a commit message in the format `fix(issue): close #<issueNumber> - <description>`
- optionally pushes `HEAD` to the selected remote or branch

Example:

```js
import { commitIssueFix } from "./src/index.js";

await commitIssueFix({
  repoRoot: process.cwd(),
  files: ["src/index.js", "README.md"],
  issueNumber: 42,
  description: "Handle issue image downloads",
  push: true,
  remote: "origin",
  branch: "main"
});
```

## Supported remote formats

- `git@github.com:owner/repo.git`
- `ssh://git@github.com/owner/repo.git`
- `https://github.com/owner/repo.git`
- GitHub Enterprise HTTPS or SSH remotes
