#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    if (options.help) {
      printHelp();
      return;
    }

    const repoRoot = await findGitRoot(options.cwd ?? process.cwd());

    switch (options.command) {
      case "sync": {
        const result = await syncIssues(repoRoot, options);
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
      case "commit-fix": {
        const result = await commitIssueFix({
          repoRoot,
          files: options.files,
          issueNumber: options.issueNumber,
          title: options.title,
          description: options.description,
          push: options.push,
          token: options.token,
          remote: options.remote ?? "origin",
          branch: options.branch,
          lookupPath: options.lookupPath,
          runner: options.runner
        });
        console.log(result.commitMessage);
        if (result.pushed) {
          console.log(`Pushed to ${result.remote}${result.branch ? ` (${result.branch})` : ""}`);
        }
        return;
      }
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
    remote: null,
    runner: runGitCommand,
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
  const allowed = new Set(["bug", "enhancement"]);

  if (!allowed.has(normalized)) {
    throw new Error(`Invalid label: ${value}. Allowed labels are bug, enhancement.`);
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
  const backlogPath = path.join(repoRoot, "backlog", "issues.json");
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
  const backlogPath = path.join(repoRoot, "backlog", "issues.json");
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
  const backlogPath = path.join(repoRoot, "backlog", "issues.json");
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
    throw new Error(`Issue #${issueNumber} was not found in backlog/issues.json.`);
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
    throw new Error("The start-issue command requires --issue <number>.");
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

  if (Array.isArray(files) && files.length > 0) {
    await runner(["add", "--", ...files], repoRoot);
  } else {
    await runner(["add", "."], repoRoot);
  }

  const commitMessage = buildIssueFixCommitMessage(issueNumber, { title, description });
  await runner(buildCommitCommandArgs(commitMessage), repoRoot);

  if (push) {
    const pushArgs = branch
      ? ["push", remote, `HEAD:${branch}`]
      : ["push", remote, "HEAD"];
    await runner(pushArgs, repoRoot);
  }

  const closedIssue = await issueCloser(repoRoot, {
    issueNumber,
    lookupPath,
    remote,
    token
  });

  return {
    branch,
    closedIssue,
    commitMessage,
    files: Array.isArray(files) ? [...files] : [],
    issueNumber,
    pushed: push,
    remote
  };
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
  const issueImageDir = path.join(repoRoot, "backlog", "images", String(issueNumber));
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
  const records = await readTokenLookup(lookupPath);
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
    const contents = await fs.readFile(lookupPath, "utf8");
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
  sync                Download open issues and save backlog/issues.json.
  list                Read and print issues from backlog/issues.json.
  show                Print one issue from backlog/issues.json.
  start-issue         Create or switch to the branch for an issue.
  commit-fix          Stage files, commit progress for an issue, and optionally push.
  create-issue        Create a new issue on the remote repository.

  Options:
    --cwd <path>       Start searching for the git repository from this directory.
    --remote <name>    Git remote to inspect. Defaults to "origin".
    --token <token>    GitHub token. Falls back to GITHUB_TOKEN or GH_TOKEN.
    --all              Include enhancement issues in list output.
    --issue <number>   Issue number for show, start-issue, or commit-fix.
    --title <text>     Issue title for create-issue or commit title for commit-fix.
    --description <t>  Issue description for create-issue or commit description/text for commit-fix.
    --label <name>     Issue label for create-issue. One of: bug, enhancement.
    --files <paths>    Files to stage for commit-fix.
  --push             Push after commit-fix.
  --branch <name>    Push target branch for commit-fix.
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
