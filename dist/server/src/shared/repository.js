import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const BACKLOG_DIR_NAME = ".backlog";

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

  return [
    header,
    "",
    normalizedDescription || ""
  ].join("\n");
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
      throw new Error(`Could not find a git repository root starting from ${startDir}.`);
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

  const content = await fs.readFile(dotGitPath, "utf8");
  const match = content.match(/^gitdir:\s*(.+)$/m);

  if (!match) {
    throw new Error(`Could not resolve gitdir from ${dotGitPath}.`);
  }

  return path.resolve(repoRoot, match[1].trim());
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

function normalizeRepositoryRemote(remoteUrl) {
  try {
    const repository = parseGitHubRemote(remoteUrl);
    return `https://${repository.host.toLowerCase()}/${repository.owner}/${repository.repo}`;
  } catch {
    return String(remoteUrl).trim().replace(/\.git$/i, "");
  }
}

function buildHeaders(token) {
  return {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "github-issues-resolver"
  };
}

async function syncIssues(repoRoot, options) {
  const remoteName = options.remote ?? "origin";
  const { repository, remoteUrl } = await resolveRepositoryContext(repoRoot, remoteName);
  const token = await requireGitHubToken(options, remoteUrl);
  const backlogPath = path.join(repoRoot, BACKLOG_DIR_NAME, "issues.json");
  const existingBacklog = await readExistingBacklog(backlogPath);
  const issues = await fetchOpenIssues(repository, token, {
    existingBacklog,
    remoteName,
    remoteUrl,
    repoRoot
  });
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
      remoteName,
      remoteUrl,
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

async function fetchOpenIssues(repository, token, {
  existingBacklog = { issues: [] },
  remoteName = "origin",
  remoteUrl = null,
  repoRoot = process.cwd()
} = {}) {
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

    let response;

    try {
      response = await fetch(url, {
        headers: buildHeaders(token)
      });
    } catch (error) {
      throw new Error(buildRepositoryFetchError({
        action: "fetch issues",
        error,
        remoteName,
        remoteUrl,
        repository
      }));
    }

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
        remoteName,
        remoteUrl,
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
    "image/webp": ".webp"
  };

  return extensionMap[normalized] ?? null;
}

function detectImageExtensionFromBytes(bytes) {
  if (!bytes || bytes.length < 4) {
    return null;
  }

  const signature = [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ".png"],
    [0xff, 0xd8, 0xff, ".jpg"],
    [0x47, 0x49, 0x46, 0x38, ".gif"],
    [0x52, 0x49, 0x46, 0x46, ".webp"]
  ];

  for (const entry of signature) {
    const ext = entry[entry.length - 1];
    const magic = entry.slice(0, -1);

    if (magic.every((value, index) => bytes[index] === value)) {
      return ext;
    }
  }

  return null;
}

async function writeImageBytes(bytes, destinationPath) {
  await fs.writeFile(destinationPath, bytes);
}

function toPortableRelativePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function buildRepositoryApiError({
  action,
  repository,
  remoteName = null,
  remoteUrl = null,
  tokenPresent,
  response,
  body
}) {
  const reason = body?.message ?? `GitHub API returned ${response.status}.`;
  const remoteLabel = formatRemoteLabel(remoteName, remoteUrl);

  if (response.status === 404) {
    const repoName = `${repository.owner}/${repository.repo}`;
    const authHint = tokenPresent
      ? "The remote may be wrong, the repository may not exist, or issues may be disabled."
      : "If this repository is private, GitHub returns 404 unless you provide --token, GITHUB_TOKEN, or GH_TOKEN.";
    return `Failed to ${action} from ${remoteLabel} for ${repoName}: ${reason}. ${authHint}`;
  }

  return `Failed to ${action} from ${remoteLabel}: ${reason}`;
}

function buildRepositoryFetchError({
  action,
  error,
  repository,
  remoteName = null,
  remoteUrl = null
}) {
  const remoteLabel = formatRemoteLabel(remoteName, remoteUrl);
  const repoName = `${repository.owner}/${repository.repo}`;
  const causeCode = error?.cause?.code ?? error?.code ?? null;
  const causeMessage = error?.cause?.message ?? error?.message ?? "Unknown network error.";
  const lowerMessage = causeMessage.toLowerCase();
  let causeDescription = causeMessage;

  if (causeCode) {
    if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$/i.test(causeCode)) {
      causeDescription = `network failure (${causeCode})`;
    } else if (/CERT|TLS|SSL/i.test(causeCode) || /certificate|tls|ssl/i.test(lowerMessage)) {
      causeDescription = `TLS or certificate failure (${causeCode})`;
    } else {
      causeDescription = `${causeMessage} (${causeCode})`;
    }
  } else if (/fetch failed/i.test(lowerMessage)) {
    causeDescription = "network failure while contacting GitHub";
  }

  return `Failed to ${action} from ${remoteLabel} for ${repoName}: ${causeDescription}. Check network connectivity, authentication, and repository configuration.`;
}

function formatRemoteLabel(remoteName, remoteUrl) {
  if (remoteName && remoteUrl) {
    return `${remoteName} (${remoteUrl})`;
  }

  if (remoteName) {
    return remoteName;
  }

  if (remoteUrl) {
    return remoteUrl;
  }

  return "remote";
}

async function safeReadJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

async function requireGitHubToken(options = {}, remoteUrl = null) {
  const directToken = options.token ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? null;

  if (directToken) {
    return directToken;
  }

  throw new Error("This command requires a GitHub token via --token, GITHUB_TOKEN, or GH_TOKEN.");
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export {
  BACKLOG_DIR_NAME,
  buildHeaders,
  buildIssueFixCommitMessage,
  buildRepositoryApiError,
  buildRepositoryFetchError,
  buildRepositoryInfo,
  closeRemoteIssue,
  detectImageExtensionFromBytes,
  downloadImage,
  extensionFromContentType,
  fetchOpenIssues,
  findGitRoot,
  formatRemoteLabel,
  localizeIssueImages,
  normalizeRepositoryRemote,
  parseGitHubRemote,
  readExistingBacklog,
  readGitRemotes,
  requireGitHubToken,
  resolveGitDir,
  resolveRepositoryContext,
  safeReadJson,
  sanitizeFileName,
  syncIssues,
  toPortableRelativePath,
  updateBacklogIssueState,
  writeJsonFile
};
