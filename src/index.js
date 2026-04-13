#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      printHelp();
      return;
    }

    const repoRoot = await findGitRoot(options.cwd ?? process.cwd());
    const gitDir = await resolveGitDir(repoRoot);
    const remotes = await readGitRemotes(gitDir);
    const remoteName = options.remote ?? "origin";
    const remoteUrl = remotes.get(remoteName);

    if (!remoteUrl) {
      throw new Error(`Remote "${remoteName}" was not found in ${path.join(gitDir, "config")}.`);
    }

    const repository = parseGitHubRemote(remoteUrl);
    const token = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;
    const issues = await fetchOpenIssues(repository, token);

    const result = {
      repository: `${repository.owner}/${repository.repo}`,
      host: repository.host,
      remote: remoteName,
      remoteUrl,
      issueCount: issues.length,
      issues
    };

    if (options.output) {
      const outputPath = path.resolve(process.cwd(), options.output);
      await fs.writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
      console.log(`Saved ${issues.length} open issues to ${outputPath}`);
      return;
    }

    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`Repository: ${result.repository}`);
    console.log(`Remote: ${remoteName} (${remoteUrl})`);
    console.log(`Open issues: ${issues.length}`);

    if (issues.length === 0) {
      console.log("No open issues found.");
      return;
    }

    for (const issue of issues) {
      const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
      console.log(`#${issue.number} ${issue.title}${labels}`);
      console.log(`  ${issue.htmlUrl}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    cwd: null,
    help: false,
    json: false,
    output: null,
    remote: null,
    token: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];

    switch (current) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--cwd":
        options.cwd = requireValue(argv, ++index, "--cwd");
        break;
      case "--remote":
        options.remote = requireValue(argv, ++index, "--remote");
        break;
      case "--token":
        options.token = requireValue(argv, ++index, "--token");
        break;
      case "--output":
        options.output = requireValue(argv, ++index, "--output");
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return options;
}

function requireValue(argv, index, flagName) {
  const value = argv[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}.`);
  }

  return value;
}

async function findGitRoot(startDir) {
  let currentDir = path.resolve(startDir);

  while (true) {
    const dotGitPath = path.join(currentDir, ".git");

    if (await pathExists(dotGitPath)) {
      return currentDir;
    }

    const parentDir = path.dirname(currentDir);

    if (parentDir === currentDir) {
      throw new Error("No .git directory or file found in the current folder or its parents.");
    }

    currentDir = parentDir;
  }
}

async function resolveGitDir(repoRoot) {
  const dotGitPath = path.join(repoRoot, ".git");
  const stats = await fs.stat(dotGitPath);

  if (stats.isDirectory()) {
    return dotGitPath;
  }

  if (!stats.isFile()) {
    throw new Error(`Unsupported .git entry at ${dotGitPath}.`);
  }

  const contents = await fs.readFile(dotGitPath, "utf8");
  const match = contents.match(/gitdir:\s*(.+)\s*$/im);

  if (!match) {
    throw new Error(`Could not resolve gitdir from ${dotGitPath}.`);
  }

  return path.resolve(repoRoot, match[1].trim());
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readGitRemotes(gitDir) {
  const configPath = path.join(gitDir, "config");
  const configContent = await fs.readFile(configPath, "utf8");
  const remotes = new Map();

  let currentRemote = null;

  for (const rawLine of configContent.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.startsWith("[remote ")) {
      const remoteMatch = line.match(/^\[remote "(.+)"\]$/);
      currentRemote = remoteMatch ? remoteMatch[1] : null;
      continue;
    }

    if (!currentRemote) {
      continue;
    }

    const urlMatch = line.match(/^url\s*=\s*(.+)$/);

    if (urlMatch) {
      remotes.set(currentRemote, urlMatch[1].trim());
    }

    if (line.startsWith("[") && !line.startsWith("[remote ")) {
      currentRemote = null;
    }
  }

  return remotes;
}

function parseGitHubRemote(remoteUrl) {
  const sshMatch = remoteUrl.match(/^git@([^:]+):([^/]+)\/(.+?)(?:\.git)?$/i);

  if (sshMatch) {
    return buildRepositoryInfo(sshMatch[1], sshMatch[2], sshMatch[3]);
  }

  const sshProtocolMatch = remoteUrl.match(/^ssh:\/\/git@([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/i);

  if (sshProtocolMatch) {
    return buildRepositoryInfo(sshProtocolMatch[1], sshProtocolMatch[2], sshProtocolMatch[3]);
  }

  let parsedUrl;

  try {
    parsedUrl = new URL(remoteUrl);
  } catch {
    throw new Error(`Unsupported remote URL format: ${remoteUrl}`);
  }

  const trimmedPath = parsedUrl.pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
  const segments = trimmedPath.split("/").filter(Boolean);

  if (segments.length < 2) {
    throw new Error(`Could not determine owner/repo from remote URL: ${remoteUrl}`);
  }

  return buildRepositoryInfo(parsedUrl.hostname, segments[0], segments[1]);
}

function buildRepositoryInfo(host, owner, repo) {
  const normalizedHost = host.toLowerCase();
  const apiBaseUrl = normalizedHost === "github.com"
    ? "https://api.github.com"
    : `https://${host}/api/v3`;

  return {
    apiBaseUrl,
    host,
    owner,
    repo
  };
}

async function fetchOpenIssues(repository, token) {
  const issues = [];
  let page = 1;

  while (true) {
    const url = new URL(`${repository.apiBaseUrl}/repos/${repository.owner}/${repository.repo}/issues`);
    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    const response = await fetch(url, {
      headers: buildHeaders(token)
    });

    if (response.status === 401 || response.status === 403) {
      const body = await safeReadJson(response);
      const reason = body?.message ?? `GitHub API returned ${response.status}.`;
      throw new Error(`Authentication failed or rate limit exceeded: ${reason}`);
    }

    if (!response.ok) {
      const body = await safeReadJson(response);
      const reason = body?.message ?? `GitHub API returned ${response.status}.`;
      throw new Error(`Failed to fetch issues: ${reason}`);
    }

    const pageItems = await response.json();
    const filteredItems = pageItems
      .filter((item) => !Object.prototype.hasOwnProperty.call(item, "pull_request"))
      .map((item) => ({
        number: item.number,
        title: item.title,
        state: item.state,
        htmlUrl: item.html_url,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        author: item.user?.login ?? null,
        labels: Array.isArray(item.labels) ? item.labels.map((label) => label.name) : []
      }));

    issues.push(...filteredItems);

    if (pageItems.length < 100) {
      return issues;
    }

    page += 1;
  }
}

function buildHeaders(token) {
  const headers = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "github-issues-resolver"
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function printHelp() {
  console.log(`github-issues-resolver

Usage:
  github-issues-resolver [options]

Options:
  --cwd <path>       Start searching for the git repository from this directory.
  --remote <name>    Git remote to inspect. Defaults to "origin".
  --token <token>    GitHub token. Falls back to GITHUB_TOKEN or GH_TOKEN.
  --json             Print the full result as JSON.
  --output <path>    Save the full result as JSON to a file.
  --help, -h         Show this help message.
`);
}

if (isEntrypoint(import.meta.url)) {
  await main();
}

function isEntrypoint(moduleUrl) {
  if (!process.argv[1]) {
    return false;
  }

  return path.resolve(process.argv[1]) === fileURLToPath(moduleUrl);
}

export {
  buildHeaders,
  buildRepositoryInfo,
  fetchOpenIssues,
  findGitRoot,
  parseArgs,
  parseGitHubRemote,
  readGitRemotes,
  resolveGitDir
};
