# GitHub Issues Resolver

Small Node.js CLI that:

- finds the nearest `.git` repository
- reads a remote URL from `.git/config`
- extracts the GitHub owner/repo from that remote
- calls the GitHub API and fetches all open issues
- uses a token from `--token`, `GITHUB_TOKEN`, or `GH_TOKEN` when available

## Requirements

- Node.js 18 or newer

## Usage

```bash
npm start
```

With options:

```bash
node ./src/index.js --remote origin --json
node ./src/index.js --token YOUR_TOKEN --output issues.json
node ./src/index.js --cwd /path/to/repo
```

## Output

By default the CLI prints a readable issue summary. Use `--json` to print machine-readable output or `--output <path>` to save it as JSON.

## Supported remote formats

- `git@github.com:owner/repo.git`
- `ssh://git@github.com/owner/repo.git`
- `https://github.com/owner/repo.git`
- GitHub Enterprise HTTPS or SSH remotes
