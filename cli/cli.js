#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const DEFAULT_RELAY_URL = "http://127.0.0.1:4317";
const BACKLOG_DIR_NAME = ".backlog";

async function main() {
  try {
    const argv = process.argv.slice(2);

    if (argv.length === 0) {
      printHelp();
      return;
    }

    const options = parseArgs(argv);

    if (options.help) {
      printHelp();
      return;
    }

    const repoRoot = await findGitRoot(options.cwd ?? process.cwd());

      switch (options.command) {
      case "sync": {
        const result = options.token
          ? await syncIssues(repoRoot, options)
          : await relaySync(repoRoot, options);
        renderIssueCollection(filterOpenIssues(result, options),options);
        return;
      }
      case "list": {
        const backlog = await ensureBacklog(repoRoot, options);
        renderIssueCollection(filterOpenIssues(backlog, options), options);
        return;
      }
      case "show": {
        const backlog = await ensureBacklog(repoRoot, options);
        const issue = findIssueByNumber(backlog, options.issueNumber);
        renderSingleIssue(issue, options);
        return;
      }
      case "start-issue": {
        const branchName = await startIssueBranch({
          issueNumber: options.issueNumber,
          repoRoot,
          runner: options.runner
        });
        console.log(branchName);
        return;
      }
      case "completed": {
        const result = options.relay
          ? await relayCompleted(repoRoot, options)
          : await commitIssueFix({
            repoRoot,
            files: options.files,
            issueNumber: options.issueNumber,
            title: options.title,
            description: options.description,
            push: options.push || options.save,
            token: options.token,
            remote: options.remote ?? "origin",
            branch: options.branch,
            lookupPath: options.lookupPath,
            runner: options.runner
          });

        if (options.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(result.commitMessage);
        if (result.pushed) {
          console.log(`Pushed to ${result.remote}${result.branch ? ` (${result.branch})` : ""}`);
        }
        if (result.closeIssueError) {
          console.error(`Warning: ${result.closeIssueError.message}`);
        }
        return;
      }
      case "report":
      case "create-issue": {
        const createdIssue = await createRemoteIssue(repoRoot, options);
        if (options.json) {
          console.log(JSON.stringify(createdIssue, null, 2));
          return;
        }

        console.log(`#${createdIssue.number}: ${createdIssue.title}`);
        return;
      }
      default:
        throw new Error(`Unsupported command: ${options.command}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    all: false,
    branch: null,
    command: "sync",
    cwd: null,
    description: null,
    files: [],
    help: false,
    issueNumber: null,
    json: false,
    label: null,
    output: null,
    push: false,
    relay: false,
    relayUrl: DEFAULT_RELAY_URL,
    remote: null,
    runner: runGitCommand,
    save: false,
    title: null,
    token: null
  };

  let index = 0;

  if (argv[0] && !argv[0].startsWith("-")) {
    options.command = argv[0];
    index = 1;
  }

  for (; index < argv.length; index += 1) {
    const current = argv[index];

    switch (current) {
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--all":
        options.all = true;
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
      case "--relay":
        options.relay = true;
        break;
      case "--relay-url":
        options.relayUrl = requireValue(argv, ++index, "--relay-url");
        break;
      case "--issue":
        options.issueNumber = parseIssueNumber(requireValue(argv, ++index, "--issue"));
        break;
      case "--title":
        options.title = requireValue(argv, ++index, "--title");
        break;
      case "--description":
        options.description = requireValue(argv, ++index, "--description");
        break;
      case "--label":
        options.label = parseIssueLabel(requireValue(argv, ++index, "--label"));
        break;
      case "--push":
        options.push = true;
        break;
      case "--save":
        options.save = true;
        break;
      case "--branch":
        options.branch = requireValue(argv, ++index, "--branch");
        break;
      case "--files":
        options.files = readFilesList(argv, index + 1);
        index += options.files.length;
        break;
      default:
        throw new Error(`Unknown argument: ${current}`);
    }
  }

  return options;
}

function parseIssueNumber(value) {
  const issueNumber = Number.parseInt(value, 10);

  if (!Number.isInteger(issueNumber) || issueNumber < 0) {
    throw new Error(`Invalid issue number: ${value}`);
  }

  return issueNumber;
}

function parseIssueLabel(value) {
  const normalized = String(value).trim().toLowerCase();
  const allowed = new Set(["bug", "improvement", "feature"]);

  if (!allowed.has(normalized)) {
    throw new Error(`Invalid label: ${value}. Allowed labels are bug, improvement, feature.`);
  }

  return normalized;
}

function readFilesList(argv, startIndex) {
  const files = [];

  for (let index = startIndex; index < argv.length; index += 1) {
    const value = argv[index];

    if (value.startsWith("--")) {
      break;
    }

    files.push(value);
  }

  if (files.length === 0) {
    throw new Error("Missing value for --files.");
  }

  return files;
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

async function readExistingBacklog(backlogPath) {
  try {
    const contents = await fs.readFile(backlogPath, "utf8");
    const parsed = JSON.parse(contents);

    if (!Array.isArray(parsed?.issues)) {
      return { issues: [] };
    }

    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { issues: [] };
    }

    throw error;
  }
}

async function updateBacklogIssueState(repoRoot, issueNumber, state) {
  const backlogPath = path.join(repoRoot, BACKLOG_DIR_NAME, "issues.json");
  const backlog = await readExistingBacklog(backlogPath);

  if (!Array.isArray(backlog.issues) || backlog.issues.length === 0) {
    return false;
  }

  let changed = false;
  const issues = backlog.issues.map((issue) => {
    if (issue.number !== issueNumber) {
      return issue;
    }

    if (issue.state === state) {
      return issue;
    }

    changed = true;
    return {
      ...issue,
      state
    };
  });

  if (!changed) {
    return false;
  }

  await writeJsonFile(backlogPath, {
    ...backlog,
    issues
  });
  return true;
}

async function writeJsonFile(targetPath, value) {
  const nextContents = `${JSON.stringify(value, null, 2)}\n`;

  try {
    const currentContents = await fs.readFile(targetPath, "utf8");

    if (currentContents === nextContents) {
      return false;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await fs.writeFile(targetPath, nextContents, "utf8");
  return true;
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

async function resolveRepositoryContext(repoRoot, remoteName) {
  const gitDir = await resolveGitDir(repoRoot);
  const remotes = await readGitRemotes(gitDir);
  const remoteUrl = remotes.get(remoteName);

  if (!remoteUrl) {
    throw new Error(`Remote "${remoteName}" was not found in ${path.join(gitDir, "config")}.`);
  }

  return {
    remoteUrl,
    repository: parseGitHubRemote(remoteUrl)
  };
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

async function syncIssues(repoRoot, options) {
  const remoteName = options.remote ?? "origin";
  const { repository, remoteUrl } = await resolveRepositoryContext(repoRoot, remoteName);
  const token = await requireGitHubToken(options, remoteUrl);
  const backlogPath = path.join(repoRoot, BACKLOG_DIR_NAME, "issues.json");
  const existingBacklog = await readExistingBacklog(backlogPath);
  const issues = await fetchOpenIssues(repository, token, repoRoot, existingBacklog);
  const result = {
    repository: `${repository.owner}/${repository.repo}`,
    host: repository.host,
    remote: remoteName,
    remoteUrl,
    issueCount: issues.length,
    issues
  };

  await writeJsonFile(backlogPath, result);

  if (options.output) {
    const outputPath = path.resolve(process.cwd(), options.output);
    await writeJsonFile(outputPath, result);
  }

  return result;
}

async function createRemoteIssue(repoRoot, options) {
  if (!options.title || !options.title.trim()) {
    throw new Error("The create-issue command requires --title <text>.");
  }

  const remoteName = options.remote ?? "origin";
  const { repository, remoteUrl } = await resolveRepositoryContext(repoRoot, remoteName);
  const token = await requireGitHubToken(options, remoteUrl);
  const url = new URL(`${repository.apiBaseUrl}/repos/${repository.owner}/${repository.repo}/issues`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...buildHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title: options.title.trim(),
      body: options.description?.trim() || "",
      ...(options.label ? { labels: [options.label] } : {})
    })
  });

  if (!response.ok) {
    const body = await safeReadJson(response);
    throw new Error(buildRepositoryApiError({
      action: "create issue",
      repository,
      tokenPresent: Boolean(token),
      response,
      body
    }));
  }

  const created = await response.json();
  return {
    number: created.number,
    title: created.title,
    description: created.body ?? "",
    htmlUrl: created.html_url,
    state: created.state
  };
}

async function closeRemoteIssue(repoRoot, options) {
  const issueNumber = options.issueNumber;

  if (!issueNumber && issueNumber !== 0) {
    throw new Error("closeRemoteIssue requires an issueNumber.");
  }

  const remoteName = options.remote ?? "origin";
  const { repository, remoteUrl } = await resolveRepositoryContext(repoRoot, remoteName);
  const token = await requireGitHubToken(options, remoteUrl);
  const url = new URL(`${repository.apiBaseUrl}/repos/${repository.owner}/${repository.repo}/issues/${issueNumber}`);
  const response = await fetch(url, {
    method: "PATCH",
    headers: {
      ...buildHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      state: "closed"
    })
  });

  if (!response.ok) {
    const body = await safeReadJson(response);
    throw new Error(buildRepositoryApiError({
      action: `close issue #${issueNumber}`,
      repository,
      tokenPresent: Boolean(token),
      response,
      body
    }));
  }

  const closed = await response.json();
  await updateBacklogIssueState(repoRoot, issueNumber, "closed");

  return {
    number: closed.number,
    state: closed.state,
    title: closed.title,
    htmlUrl: closed.html_url
  };
}

async function ensureBacklog(repoRoot, options) {
  const backlogPath = path.join(repoRoot, BACKLOG_DIR_NAME, "issues.json");
  const backlog = await readExistingBacklog(backlogPath);

  if (Array.isArray(backlog.issues) && backlog.issues.length > 0) {
    return backlog;
  }

  return syncIssues(repoRoot, options);
}

function findIssueByNumber(backlog, issueNumber) {
  if (issueNumber === null) {
    throw new Error("The show command requires --issue <number>.");
  }

  const issue = (backlog.issues ?? []).find((entry) => entry.number === issueNumber);

  if (!issue) {
    throw new Error(`Issue #${issueNumber} was not found in .backlog/issues.json.`);
  }

  return issue;
}

function filterOpenIssues(backlog, options = {}) {
  const issues = (backlog.issues ?? []).filter((issue) => {
    if (issue.state !== "open") {
      return false;
    }

    if (options.all) {
      return true;
    }

    const labels = Array.isArray(issue.labels) ? issue.labels : [];
    return labels.length==0 || labels.includes("bug");
  });

  return {
    ...backlog,
    issueCount: issues.length,
    issues
  };
}

function renderIssueCollection(result, options) {
  if (options.output) {
      console.log(`Saved ${result.issueCount} open issues to ${path.resolve(process.cwd(), options.output)}`);
    return;
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  //console.log(`Repository: ${result.repository}`);
  //console.log(`Remote: ${result.remote} (${result.remoteUrl})`);
  console.log(`# Open issues: ${result.issueCount}`);

  if ((result.issues ?? []).length === 0) {
    console.log("No open issues found.");
    return;
  }

  for (const issue of result.issues) {
    const labels = issue.labels.length > 0 ? ` [${issue.labels.join(", ")}]` : "";
    console.log(`- Issue ${issue.number}: ${issue.title}${labels}`);
  }
}

function renderSingleIssue(issue, options) {
  if (options.json) {
    console.log(JSON.stringify(issue, null, 2));
    return;
  }

  console.log(`# Issue ${issue.number}`);
  console.log(issue.title);
  console.log("");
  console.log(issue.description || "(no description)");
}

async function startIssueBranch({
  issueNumber,
  repoRoot = process.cwd(),
  runner = runGitCommand
}) {
  if (issueNumber === null) {
    throw new Error("The report command requires --issue <number>.");
  }

  const branchName = makeIssueBranchName(issueNumber);

  try {
    await runner(["rev-parse", "--verify", branchName], repoRoot);
    await runner(["checkout", branchName], repoRoot);
  } catch {
    await runner(["checkout", "-b", branchName], repoRoot);
  }

  return branchName;
}

function makeIssueBranchName(issueNumber) {
  return `issue/${issueNumber}`;
}

async function commitIssueFix({
  repoRoot = process.cwd(),
  files,
  issueNumber,
  title = null,
  description = null,
  push = false,
  token = null,
  remote = "origin",
  branch = null,
  lookupPath = null,
  runner = runGitCommand,
  issueCloser = closeRemoteIssue
}) {
  if (!issueNumber && issueNumber !== 0) {
    throw new Error("commitIssueFix requires an issueNumber.");
  }

  if (!hasCommitText({ title, description })) {
    throw new Error("commitIssueFix requires --description or --title.");
  }

  const commitMessage = buildIssueFixCommitMessage(issueNumber, { title, description });
  await createNativeGitCommit({
    repoRoot,
    files,
    commitMessage
  });

  if (push) {
    const pushArgs = branch
      ? ["push", remote, `HEAD:${branch}`]
      : ["push", remote, "HEAD"];
    await runner(pushArgs, repoRoot);
  }

  let closedIssue = null;
  let closeIssueError = null;

  try {
    closedIssue = await issueCloser(repoRoot, {
      issueNumber,
      lookupPath,
      remote,
      token
    });
  } catch (error) {
    closeIssueError = error;
  }

  return {
    branch,
    closeIssueError,
    closedIssue,
    commitMessage,
    files: Array.isArray(files) ? [...files] : [],
    issueNumber,
    pushed: push,
    remote
  };
}

async function relayCompleted(repoRoot, options) {
  const remoteName = options.remote ?? "origin";
  const { remoteUrl } = await resolveRepositoryContext(repoRoot, remoteName);
  const relayTarget = new URL("/completed", ensureRelayBaseUrl(options.relayUrl));
  const response = await fetch(relayTarget, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "github-issues-resolver-relay-client"
    },
    body: JSON.stringify({
      branch: options.branch,
      description: options.description,
        files: Array.isArray(options.files) ? options.files : [],
        issueNumber: options.issueNumber,
        push: options.push || options.save,
        remote: remoteName,
        repositoryFolder: path.resolve(repoRoot),
        repositoryUrl: normalizeRepositoryRemote(remoteUrl),
        save: options.save,
        title: options.title
      })
  });
  const body = await safeReadJson(response);

  if (!response.ok) {
    const message = body?.error ?? body?.message ?? `Relay request failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  return {
    branch: body.branch ?? options.branch ?? null,
    closeIssueError: body.closeIssueError ? new Error(body.closeIssueError) : null,
    closedIssue: body.closedIssue ?? null,
    commitMessage: body.commitMessage ?? buildIssueFixCommitMessage(options.issueNumber, options),
    files: Array.isArray(body.files) ? body.files : (Array.isArray(options.files) ? options.files : []),
    issueNumber: body.issueNumber ?? options.issueNumber,
    pushed: Boolean(body.pushed),
    remote: body.remote ?? remoteName
  };
}

async function relaySync(repoRoot, options) {
  const remoteName = options.remote ?? "origin";
  const { remoteUrl } = await resolveRepositoryContext(repoRoot, remoteName);
  const relayTarget = new URL("/sync", ensureRelayBaseUrl(options.relayUrl));
  const response = await fetch(relayTarget, {
    method: "POST",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": "github-issues-resolver-relay-client"
    },
    body: JSON.stringify({
      remote: remoteName,
      repositoryFolder: path.resolve(repoRoot),
      repositoryUrl: normalizeRepositoryRemote(remoteUrl)
    })
  });
  const body = await safeReadJson(response);

  if (!response.ok) {
    const message = body?.error ?? body?.message ?? `Relay sync failed with HTTP ${response.status}.`;
    throw new Error(message);
  }

  if (options.output) {
    const outputPath = path.resolve(process.cwd(), options.output);
    await writeJsonFile(outputPath, body);
  }

  return body;
}

function ensureRelayBaseUrl(value) {
  const normalized = String(value ?? DEFAULT_RELAY_URL).trim();
  return normalized.endsWith("/") ? normalized : `${normalized}/`;
}

function buildIssueFixCommitMessage(issueNumber, description) {
  const normalizedDescription = description.description?.trim();
  const normalizedTitle = description.title?.trim() ?? (
    normalizedDescription
      ? normalizedDescription.replace(/\r?\n/g, " ").replace(/\s+/g, " ")
      : null
  );
  const header = normalizedTitle
    ? `fix(issue): close #${issueNumber} - ${normalizedTitle}`
    : `fix(issue): close #${issueNumber}`;

  if (!description.title?.trim() || !normalizedDescription) {
    return header;
  }

  return `${header}\n\n${normalizedDescription}`;
}

function hasCommitText({ title, description }) {
  return Boolean(title?.trim() || description?.trim());
}

function buildCommitCommandArgs(commitMessage) {
  const parts = commitMessage.split(/\r?\n\r?\n/);
  const args = ["commit"];

  for (const part of parts) {
    args.push("-m", part);
  }

  return args;
}

async function createNativeGitCommit({
  repoRoot,
  files,
  commitMessage
}) {
  const gitDir = await resolveGitDir(repoRoot);
  const head = await readHeadReference(gitDir);
  const parent = head.commitHash;
  const trackedEntries = parent
    ? await readTreeEntriesFromCommit(gitDir, parent)
    : new Map();
  const nextEntries = Array.isArray(files) && files.length > 0
    ? await applySelectedWorkingTreeChanges(repoRoot, trackedEntries, files)
    : await readWorkingTreeEntries(repoRoot);

  if (areEntryMapsEqual(trackedEntries, nextEntries)) {
    throw new Error("Nothing to commit.");
  }

  const treeHash = await writeTreeFromEntries(gitDir, nextEntries);
  const identity = await resolveCommitIdentity(repoRoot, gitDir);
  const commitHash = await writeCommitObject(gitDir, {
    treeHash,
    parent,
    message: commitMessage,
    identity
  });

  await updateGitReferences(gitDir, head, commitHash, commitMessage, identity);
  await writeGitIndex(gitDir, repoRoot, nextEntries);
  await fs.writeFile(path.join(gitDir, "COMMIT_EDITMSG"), `${commitMessage}\n`, "utf8");

  return commitHash;
}

async function readHeadReference(gitDir) {
  const headPath = path.join(gitDir, "HEAD");
  const contents = (await fs.readFile(headPath, "utf8")).trim();

  if (contents.startsWith("ref: ")) {
    const ref = contents.slice(5).trim();
    const refPath = path.join(gitDir, ...ref.split("/"));
    let commitHash = null;

    try {
      commitHash = (await fs.readFile(refPath, "utf8")).trim() || null;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    return {
      headPath,
      ref,
      refPath,
      commitHash
    };
  }

  return {
    headPath,
    ref: null,
    refPath: null,
    commitHash: contents || null
  };
}

async function readTreeEntriesFromCommit(gitDir, commitHash) {
  const commitObject = await readGitObject(gitDir, commitHash);

  if (commitObject.type !== "commit") {
    throw new Error(`Object ${commitHash} is not a commit.`);
  }

  const commitText = commitObject.body.toString("utf8");
  const treeMatch = commitText.match(/^tree ([0-9a-f]{40})$/m);

  if (!treeMatch) {
    throw new Error(`Commit ${commitHash} does not contain a tree.`);
  }

  return readTreeEntries(gitDir, treeMatch[1], "");
}

async function readTreeEntries(gitDir, treeHash, prefix) {
  const treeObject = await readGitObject(gitDir, treeHash);

  if (treeObject.type !== "tree") {
    throw new Error(`Object ${treeHash} is not a tree.`);
  }

  const entries = new Map();
  let offset = 0;

  while (offset < treeObject.body.length) {
    const spaceIndex = treeObject.body.indexOf(0x20, offset);
    const mode = treeObject.body.slice(offset, spaceIndex).toString("utf8");
    const nullIndex = treeObject.body.indexOf(0x00, spaceIndex + 1);
    const name = treeObject.body.slice(spaceIndex + 1, nullIndex).toString("utf8");
    const hash = treeObject.body.slice(nullIndex + 1, nullIndex + 21).toString("hex");
    const entryPath = prefix ? `${prefix}/${name}` : name;
    offset = nullIndex + 21;

    if (mode === "40000") {
      const childEntries = await readTreeEntries(gitDir, hash, entryPath);

      for (const [childPath, childEntry] of childEntries) {
        entries.set(childPath, childEntry);
      }

      continue;
    }

    entries.set(entryPath, {
      hash,
      mode
    });
  }

  return entries;
}

async function readGitObject(gitDir, hash) {
  const objectPath = path.join(gitDir, "objects", hash.slice(0, 2), hash.slice(2));
  const compressed = await fs.readFile(objectPath);
  const raw = zlib.inflateSync(compressed);
  const separatorIndex = raw.indexOf(0x00);
  const header = raw.slice(0, separatorIndex).toString("utf8");
  const [type] = header.split(" ");

  return {
    type,
    body: raw.slice(separatorIndex + 1)
  };
}

async function applySelectedWorkingTreeChanges(repoRoot, trackedEntries, files) {
  const nextEntries = new Map(trackedEntries);

  for (const file of files) {
    const normalizedPath = normalizeRepoRelativePath(file);
    const absolutePath = path.resolve(repoRoot, normalizedPath);
    const relativePath = path.relative(repoRoot, absolutePath);

    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`File path is outside the repository: ${file}`);
    }

    let stats = null;

    try {
      stats = await fs.stat(absolutePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }

    if (!stats) {
      nextEntries.delete(normalizedPath);
      continue;
    }

    if (stats.isDirectory()) {
      for (const entryPath of [...nextEntries.keys()]) {
        if (entryPath === normalizedPath || entryPath.startsWith(`${normalizedPath}/`)) {
          nextEntries.delete(entryPath);
        }
      }

      const childEntries = await walkWorkingTree(repoRoot, absolutePath);

      for (const [childPath, entry] of childEntries) {
        nextEntries.set(childPath, entry);
      }

      continue;
    }

    const entry = await createWorkingTreeEntry(repoRoot, absolutePath);
    nextEntries.set(normalizedPath, entry);
  }

  return nextEntries;
}

async function readWorkingTreeEntries(repoRoot) {
  return walkWorkingTree(repoRoot, repoRoot);
}

async function walkWorkingTree(repoRoot, currentDir, ignoreRules = null, entries = new Map()) {
  const activeRules = ignoreRules ?? await loadIgnoreRules(repoRoot);
  const children = await fs.readdir(currentDir, { withFileTypes: true });

  children.sort((left, right) => left.name.localeCompare(right.name));

  for (const child of children) {
    const absolutePath = path.join(currentDir, child.name);
    const relativePath = normalizeRepoRelativePath(path.relative(repoRoot, absolutePath));

    if (!relativePath || relativePath === ".git" || relativePath.startsWith(".git/")) {
      continue;
    }

    const directoryPath = child.isDirectory() ? `${relativePath}/` : relativePath;

    if (matchesIgnoreRules(directoryPath, child.isDirectory(), activeRules)) {
      continue;
    }

    if (child.isDirectory()) {
      await walkWorkingTree(repoRoot, absolutePath, activeRules, entries);
      continue;
    }

    entries.set(relativePath, await createWorkingTreeEntry(repoRoot, absolutePath));
  }

  return entries;
}

async function loadIgnoreRules(repoRoot) {
  const rules = [];

  for (const ignorePath of [
    path.join(repoRoot, ".gitignore"),
    path.join(repoRoot, ".git", "info", "exclude")
  ]) {
    try {
      const contents = await fs.readFile(ignorePath, "utf8");

      for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#")) {
          continue;
        }

        rules.push(line);
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return rules;
}

function matchesIgnoreRules(relativePath, isDirectory, rules) {
  return rules.some((rule) => matchesSingleIgnoreRule(relativePath, isDirectory, rule));
}

function matchesSingleIgnoreRule(relativePath, isDirectory, rule) {
  const normalizedRule = rule.replace(/\\/g, "/");

  if (normalizedRule.endsWith("/")) {
    const directoryRule = normalizedRule;
    return isDirectory && relativePath === directoryRule.slice(0, -1)
      || relativePath.startsWith(directoryRule);
  }

  if (normalizedRule.includes("*")) {
    const pattern = `^${escapeRegExp(normalizedRule).replace(/\\\*/g, ".*")}$`;
    return new RegExp(pattern, "i").test(relativePath);
  }

  return relativePath === normalizedRule || relativePath.endsWith(`/${normalizedRule}`);
}

function escapeRegExp(value) {
  return value.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

async function createWorkingTreeEntry(repoRoot, absolutePath) {
  const relativePath = normalizeRepoRelativePath(path.relative(repoRoot, absolutePath));
  const contents = await fs.readFile(absolutePath);

  return {
    hash: await writeBlobObject(await resolveGitDir(repoRoot), contents),
    mode: "100644"
  };
}

async function writeBlobObject(gitDir, contents) {
  return writeGitObject(gitDir, "blob", contents);
}

async function writeTreeFromEntries(gitDir, entries) {
  const root = new Map();

  for (const [entryPath, entry] of entries) {
    const segments = entryPath.split("/");
    let current = root;

    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];

      if (!current.has(segment)) {
        current.set(segment, new Map());
      }

      current = current.get(segment);
    }

    current.set(segments.at(-1), entry);
  }

  return writeTreeNode(gitDir, root);
}

async function writeTreeNode(gitDir, node) {
  const parts = [];
  const names = [...node.keys()].sort((left, right) => left.localeCompare(right));

  for (const name of names) {
    const value = node.get(name);
    const isDirectory = value instanceof Map;
    const hash = isDirectory
      ? await writeTreeNode(gitDir, value)
      : value.hash;
    const mode = isDirectory ? "40000" : value.mode;
    const header = Buffer.from(`${mode} ${name}\0`, "utf8");
    const hashBuffer = Buffer.from(hash, "hex");

    parts.push(header, hashBuffer);
  }

  return writeGitObject(gitDir, "tree", Buffer.concat(parts));
}

async function writeCommitObject(gitDir, { treeHash, parent, message, identity }) {
  const lines = [
    `tree ${treeHash}`
  ];

  if (parent) {
    lines.push(`parent ${parent}`);
  }

  const signature = `${identity.name} <${identity.email}> ${identity.timestamp} ${identity.timezone}`;
  lines.push(`author ${signature}`);
  lines.push(`committer ${signature}`);
  lines.push("");
  lines.push(message);

  return writeGitObject(gitDir, "commit", Buffer.from(lines.join("\n"), "utf8"));
}

async function writeGitObject(gitDir, type, body) {
  const header = Buffer.from(`${type} ${body.length}\0`, "utf8");
  const payload = Buffer.concat([header, body]);
  const hash = crypto.createHash("sha1").update(payload).digest("hex");
  const objectPath = path.join(gitDir, "objects", hash.slice(0, 2), hash.slice(2));

  if (!await pathExists(objectPath)) {
    await fs.mkdir(path.dirname(objectPath), { recursive: true });
    await fs.writeFile(objectPath, zlib.deflateSync(payload));
  }

  return hash;
}

async function resolveCommitIdentity(repoRoot, gitDir) {
  const config = await readCombinedGitConfig(repoRoot, gitDir);
  const name = process.env.GIT_AUTHOR_NAME
    ?? process.env.GIT_COMMITTER_NAME
    ?? process.env.USERNAME
    ?? config.get("user.name")
    ?? "Codex";
  const email = process.env.GIT_AUTHOR_EMAIL
    ?? process.env.GIT_COMMITTER_EMAIL
    ?? config.get("user.email")
    ?? "codex@local";
  const now = new Date();

  return {
    email,
    name,
    timestamp: Math.floor(now.getTime() / 1000),
    timezone: formatTimezoneOffset(now.getTimezoneOffset())
  };
}

async function readCombinedGitConfig(repoRoot, gitDir) {
  const entries = new Map();

  for (const configPath of [
    path.join(process.env.USERPROFILE ?? "", ".gitconfig"),
    path.join(repoRoot, ".git", "config"),
    path.join(gitDir, "config")
  ]) {
    if (!configPath) {
      continue;
    }

    try {
      const contents = await fs.readFile(configPath, "utf8");
      let section = null;

      for (const rawLine of contents.split(/\r?\n/)) {
        const line = rawLine.trim();

        if (!line || line.startsWith("#") || line.startsWith(";")) {
          continue;
        }

        const sectionMatch = line.match(/^\[([^\]]+)\]$/);

        if (sectionMatch) {
          section = sectionMatch[1].replace(/\s*".*?"\s*$/, "").trim().toLowerCase();
          continue;
        }

        const kvMatch = line.match(/^([A-Za-z0-9.-]+)\s*=\s*(.+)$/);

        if (section && kvMatch) {
          entries.set(`${section}.${kvMatch[1].toLowerCase()}`, kvMatch[2].trim());
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return entries;
}

function formatTimezoneOffset(offsetMinutes) {
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absoluteMinutes / 60)).padStart(2, "0");
  const minutes = String(absoluteMinutes % 60).padStart(2, "0");
  return `${sign}${hours}${minutes}`;
}

async function updateGitReferences(gitDir, head, commitHash, commitMessage, identity) {
  if (head.ref && head.refPath) {
    await fs.mkdir(path.dirname(head.refPath), { recursive: true });
    await fs.writeFile(head.refPath, `${commitHash}\n`, "utf8");
  } else {
    await fs.writeFile(head.headPath, `${commitHash}\n`, "utf8");
  }

  await appendReflog(path.join(gitDir, "logs", "HEAD"), head.commitHash, commitHash, identity, commitMessage);

  if (head.ref) {
    await appendReflog(path.join(gitDir, "logs", ...head.ref.split("/")), head.commitHash, commitHash, identity, commitMessage);
  }
}

async function appendReflog(logPath, oldHash, newHash, identity, message) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  const previous = oldHash ?? "0".repeat(40);
  const line = `${previous} ${newHash} ${identity.name} <${identity.email}> ${identity.timestamp} ${identity.timezone}\t${message}\n`;
  await fs.appendFile(logPath, line, "utf8");
}

async function writeGitIndex(gitDir, repoRoot, entries) {
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "ascii");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.size, 8);

  const buffers = [header];
  const sortedEntries = [...entries.entries()].sort(([left], [right]) => left.localeCompare(right));

  for (const [entryPath, entry] of sortedEntries) {
    const absolutePath = path.join(repoRoot, ...entryPath.split("/"));
    const stats = await fs.stat(absolutePath);
    const pathBuffer = Buffer.from(entryPath, "utf8");
    const entryBuffer = Buffer.alloc(62);
    const ctimeMs = stats.birthtimeMs || stats.ctimeMs;
    const mtimeMs = stats.mtimeMs;

    entryBuffer.writeUInt32BE(Math.floor(ctimeMs / 1000), 0);
    entryBuffer.writeUInt32BE(Math.floor((ctimeMs % 1000) * 1_000_000), 4);
    entryBuffer.writeUInt32BE(Math.floor(mtimeMs / 1000), 8);
    entryBuffer.writeUInt32BE(Math.floor((mtimeMs % 1000) * 1_000_000), 12);
    entryBuffer.writeUInt32BE((stats.dev ?? 0) >>> 0, 16);
    entryBuffer.writeUInt32BE((stats.ino ?? 0) >>> 0, 20);
    entryBuffer.writeUInt32BE(parseInt(entry.mode, 8), 24);
    entryBuffer.writeUInt32BE((stats.uid ?? 0) >>> 0, 28);
    entryBuffer.writeUInt32BE((stats.gid ?? 0) >>> 0, 32);
    entryBuffer.writeUInt32BE((stats.size ?? 0) >>> 0, 36);
    Buffer.from(entry.hash, "hex").copy(entryBuffer, 40);
    entryBuffer.writeUInt16BE(Math.min(pathBuffer.length, 0x0fff), 60);

    const fullEntry = Buffer.concat([entryBuffer, pathBuffer, Buffer.from([0x00])]);
    const padding = (8 - (fullEntry.length % 8)) % 8;
    buffers.push(fullEntry, Buffer.alloc(padding));
  }

  const payload = Buffer.concat(buffers);
  const checksum = crypto.createHash("sha1").update(payload).digest();
  await fs.writeFile(path.join(gitDir, "index"), Buffer.concat([payload, checksum]));
}

function areEntryMapsEqual(left, right) {
  if (left.size !== right.size) {
    return false;
  }

  for (const [entryPath, leftEntry] of left) {
    const rightEntry = right.get(entryPath);

    if (!rightEntry || rightEntry.hash !== leftEntry.hash || rightEntry.mode !== leftEntry.mode) {
      return false;
    }
  }

  return true;
}

function normalizeRepoRelativePath(filePath) {
  return filePath.split(path.sep).join("/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
}

async function runGitCommand(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(new Error(`Failed to run git ${args.join(" ")}: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      const reason = stderr.trim() || stdout.trim() || `git exited with code ${code}`;
      reject(new Error(`Git command failed: git ${args.join(" ")}\n${reason}`));
    });
  });
}

async function fetchOpenIssues(repository, token, repoRoot = process.cwd(), existingBacklog = { issues: [] }) {
  const issues = [];
  let page = 1;
  const existingIssues = new Map(
    (existingBacklog?.issues ?? []).map((issue) => [issue.number, issue])
  );

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
      throw new Error(buildRepositoryApiError({
        action: "fetch issues",
        repository,
        tokenPresent: Boolean(token),
        response,
        body
      }));
    }

    const pageItems = await response.json();
    const filteredItems = await Promise.all(
      pageItems
        .filter((item) => !Object.prototype.hasOwnProperty.call(item, "pull_request"))
        .map(async (item) => {
          const existingIssue = existingIssues.get(item.number);

          if (existingIssue && existingIssue.updatedAt === item.updated_at) {
            return existingIssue;
          }

          const description = await localizeIssueImages(item.body ?? "", item.number, token, repoRoot);

          return {
            number: item.number,
            title: item.title,
            description,
            state: item.state,
            htmlUrl: item.html_url,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            author: item.user?.login ?? null,
            labels: Array.isArray(item.labels) ? item.labels.map((label) => label.name) : []
          };
        })
    );

    issues.push(...filteredItems);

    if (pageItems.length < 100) {
      return issues;
    }

    page += 1;
  }
}

async function localizeIssueImages(description, issueNumber, token, repoRoot) {
  const references = extractImageReferences(description);

  if (references.length === 0) {
    return description;
  }

  let rewritten = description;
  const issueImageDir = path.join(repoRoot, BACKLOG_DIR_NAME, "images", String(issueNumber));
  await fs.mkdir(issueImageDir, { recursive: true });

  for (let index = 0; index < references.length; index += 1) {
    const reference = references[index];
    const relativePath = await downloadImage(reference.url, issueImageDir, index, token, repoRoot);

    rewritten = rewritten.replace(reference.original, relativePath);
  }

  return rewritten;
}

function extractImageReferences(description) {
  const references = [];
  const markdownPattern = /!\[[^\]]*]\((https?:\/\/[^)\s]+(?:\s+"[^"]*")?)\)/gi;
  const htmlPattern = /<img\b[^>]*?\bsrc=["'](https?:\/\/[^"']+)["'][^>]*?>/gi;

  for (const match of description.matchAll(markdownPattern)) {
    const rawTarget = match[1].trim();
    const url = rawTarget.split(/\s+"/)[0];
    references.push({
      original: match[0],
      url
    });
  }

  for (const match of description.matchAll(htmlPattern)) {
    references.push({
      original: match[0],
      url: match[1]
    });
  }

  return references;
}

function buildImageFileName(imageUrl, index) {
  const cleanName = getSanitizedBaseName(imageUrl, index);
  const prefix = `${String(index + 1).padStart(2, "0")}-`;

  return `${prefix}${cleanName}`;
}

function getSanitizedBaseName(imageUrl, index) {
  let parsedUrl;

  try {
    parsedUrl = new URL(imageUrl);
  } catch {
    return `image-${index + 1}`;
  }

  const rawName = path.posix.basename(parsedUrl.pathname) || `image-${index + 1}`;
  return sanitizeFileName(rawName);
}

function sanitizeFileName(fileName) {
  return fileName.replace(/[^A-Za-z0-9._-]/g, "_");
}

async function downloadImage(imageUrl, issueImageDir, index, token, repoRoot) {
  const response = await fetch(imageUrl, {
    headers: buildHeaders(token)
  });

  if (!response.ok) {
    throw new Error(`Failed to download image ${imageUrl}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const fileName = buildResolvedImageFileName(
    imageUrl,
    index,
    response.headers.get("content-type"),
    bytes
  );
  const destinationPath = path.join(issueImageDir, fileName);

  if (!await pathExists(destinationPath)) {
    await writeImageBytes(bytes, destinationPath);
  }

  return toPortableRelativePath(path.relative(repoRoot, destinationPath));
}

function buildResolvedImageFileName(imageUrl, index, contentType, bytes = null) {
  const baseName = getSanitizedBaseName(imageUrl, index);

  if (hasFileExtension(baseName)) {
    return buildImageFileName(imageUrl, index);
  }

  const extension = extensionFromContentType(contentType) ?? detectImageExtensionFromBytes(bytes) ?? ".img";
  return `${buildImageFileName(imageUrl, index)}${extension}`;
}

function hasFileExtension(fileName) {
  return /\.[A-Za-z0-9]+$/.test(fileName);
}

function extensionFromContentType(contentType) {
  const normalized = String(contentType ?? "").split(";")[0].trim().toLowerCase();
  const extensionMap = {
    "image/apng": ".apng",
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/svg+xml": ".svg",
    "image/webp": ".webp",
    "image/bmp": ".bmp",
    "image/tiff": ".tif"
  };

  return extensionMap[normalized] ?? null;
}

function detectImageExtensionFromBytes(bytes) {
  if (!bytes || bytes.length < 4) {
    return null;
  }

  if (matchesSignature(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return ".png";
  }

  if (matchesSignature(bytes, [0xff, 0xd8, 0xff])) {
    return ".jpg";
  }

  if (matchesSignature(bytes, [0x47, 0x49, 0x46, 0x38])) {
    return ".gif";
  }

  if (matchesSignature(bytes, [0x42, 0x4d])) {
    return ".bmp";
  }

  if (matchesSignature(bytes, [0x52, 0x49, 0x46, 0x46]) && bytes.slice(8, 12).toString("ascii") === "WEBP") {
    return ".webp";
  }

  if (bytes.slice(0, 4).toString("ascii") === "<svg" || bytes.slice(0, 256).toString("utf8").includes("<svg")) {
    return ".svg";
  }

  if (
    (bytes[0] === 0x49 && bytes[1] === 0x49 && bytes[2] === 0x2a && bytes[3] === 0x00) ||
    (bytes[0] === 0x4d && bytes[1] === 0x4d && bytes[2] === 0x00 && bytes[3] === 0x2a)
  ) {
    return ".tif";
  }

  return null;
}

function matchesSignature(bytes, signature) {
  if (bytes.length < signature.length) {
    return false;
  }

  return signature.every((value, index) => bytes[index] === value);
}

async function writeImageBytes(bytes, destinationPath) {
  await fs.writeFile(destinationPath, bytes);
}

function toPortableRelativePath(filePath) {
  return filePath.split(path.sep).join("/");
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

async function requireGitHubToken(options = {}, remoteUrl = null) {
  const directToken = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;

  if (directToken) {
    return directToken;
  }

  if (remoteUrl) {
    const lookupToken = await lookupTokenForRepository(remoteUrl, options.lookupPath);

    if (lookupToken) {
      return lookupToken;
    }
  }

  throw new Error("This command requires a GitHub token via --token, GITHUB_TOKEN, GH_TOKEN, or lookup.tsv.");
}

async function lookupTokenForRepository(remoteUrl, lookupPath = getDefaultLookupPath()) {
  const records = await readTokenLookup(lookupPath ?? getDefaultLookupPath());
  const target = normalizeRepositoryRemote(remoteUrl);

  for (const record of records) {
    if (normalizeRepositoryRemote(record.repositoryUrl) === target) {
      return record.token;
    }
  }

  return null;
}

async function readTokenLookup(lookupPath = getDefaultLookupPath()) {
  try {
    const contents = await fs.readFile(lookupPath ?? getDefaultLookupPath(), "utf8");
    const records = [];

    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();

      if (!line || line.startsWith("#")) {
        continue;
      }

      const separatorIndex = rawLine.indexOf("\t");

      if (separatorIndex === -1) {
        continue;
      }

      const repositoryUrl = rawLine.slice(0, separatorIndex).trim();
      const token = rawLine.slice(separatorIndex + 1).trim();

      if (!repositoryUrl || !token) {
        continue;
      }

      records.push({ repositoryUrl, token });
    }

    return records;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

function normalizeRepositoryRemote(remoteUrl) {
  try {
    const repository = parseGitHubRemote(remoteUrl);
    return `https://${repository.host.toLowerCase()}/${repository.owner}/${repository.repo}`;
  } catch {
    return String(remoteUrl).trim().replace(/\.git$/i, "");
  }
}

function getDefaultLookupPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "lookup.tsv");
}

function buildRepositoryApiError({ action, repository, tokenPresent, response, body }) {
  const reason = body?.message ?? `GitHub API returned ${response.status}.`;

  if (response.status === 404) {
    const repoName = `${repository.owner}/${repository.repo}`;
    const authHint = tokenPresent
      ? "The remote may be wrong, the repository may not exist, or issues may be disabled."
      : "If this repository is private, GitHub returns 404 unless you provide --token, GITHUB_TOKEN, or GH_TOKEN.";
    return `Failed to ${action} for ${repoName}: ${reason}. ${authHint}`;
  }

  return `Failed to ${action}: ${reason}`;
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
    github-issues-resolver [command] [options]

  Commands:
  sync                Download open issues and save .backlog/issues.json. Falls back to the relay server when no token is provided.
  list                Read and print issues from .backlog/issues.json.
  show                Print one issue from .backlog/issues.json.
  start-issue         Create or switch to the branch for an issue.
  completed           Stage files, commit progress for an issue, and close it.
  report              Create a new issue on the remote repository.
  create-issue        Create a new issue on the remote repository.

  Options:
    --cwd <path>       Start searching for the git repository from this directory.
    --remote <name>    Git remote to inspect. Defaults to "origin".
    --token <token>    GitHub token. Falls back to GITHUB_TOKEN or GH_TOKEN.
    --all              Include improvement and feature issues in list output.
    --issue <number>   Issue number for show, start-issue, or completed.
    --title <text>     Issue title for report/create-issue or commit title for completed.
    --description <t>  Issue description for report/create-issue or commit text for completed.
    --label <name>     Issue label for report/create-issue. One of: bug, improvement, feature.
    --files <paths>    Files to stage for completed.
    --push             Push after completed.
    --save             Ask the relay flow to push after completed.
    --branch <name>    Push target branch for completed.
    --relay            Send completed to the local relay server instead of committing directly.
    --relay-url <url>  Relay server base URL. Defaults to http://127.0.0.1:4317.
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
  filterOpenIssues,
  closeRemoteIssue,
  createRemoteIssue,
  ensureBacklog,
  findIssueByNumber,
  buildIssueFixCommitMessage,
  buildRepositoryApiError,
  buildHeaders,
  buildImageFileName,
  buildResolvedImageFileName,
  buildRepositoryInfo,
  makeIssueBranchName,
  commitIssueFix,
  detectImageExtensionFromBytes,
  extensionFromContentType,
  extractImageReferences,
  fetchOpenIssues,
  findGitRoot,
  localizeIssueImages,
  lookupTokenForRepository,
  normalizeRepositoryRemote,
  parseArgs,
  parseGitHubRemote,
  requireGitHubToken,
  relayCompleted,
  readTokenLookup,
  readExistingBacklog,
  readGitRemotes,
  renderIssueCollection,
  renderSingleIssue,
  resolveGitDir,
  resolveRepositoryContext,
  runGitCommand,
  startIssueBranch,
  syncIssues,
  updateBacklogIssueState,
  writeJsonFile
};
