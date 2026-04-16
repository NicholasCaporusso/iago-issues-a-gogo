#!/usr/bin/env node

import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildRepositoryApiError,
  buildIssueFixCommitMessage,
  closeRemoteIssue,
  findGitRoot,
  normalizeRepositoryRemote,
  parseGitHubRemote,
  safeReadJson,
  syncIssues
} from "../shared/repository.js";
import {
  DEFAULT_RELAY_PORT,
  readRelayConfig,
  relayUrlForPort,
  setRelayPort
} from "../shared/relay-config.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_VAULT_PATH = path.join(getServerDir(), "vault", "repos.json");
const VAULT_SECRET = crypto.createHash("sha256").update("tools-github-issues-resolver:relay-vault:v1").digest();
const VAULT_TOKEN_PREFIX = "enc";
const VAULT_TOKEN_VERSION = "v1";

async function main() {
  try {
    const relayConfig = await readRelayConfig();
    const options = parseArgs(process.argv.slice(2), relayConfig.relayPort);

    if (options.help) {
      printHelp(relayConfig);
      return;
    }

    switch (options.command) {
      case "serve":
        await serveRelay(options, relayConfig);
        return;
      case "repl":
        await startVaultRepl(options, relayConfig);
        return;
      case "client":
        if (options.commandArgs[0] === "help") {
          printClientHelp();
          return;
        }
        break;
      case "add":
        await addRepoCommand(options);
        return;
      case "delete":
        await deleteRepoCommand(options);
        return;
      case "issues":
        await printVaultIssueCounts(options.vaultPath);
        return;
      case "set-port":
        await setPortCommand(options);
        return;
      default:
        printHelp(relayConfig);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv, defaultPort) {
  const options = {
    command: argv[0] ?? "serve",
    commandArgs: argv.slice(1),
    folder: null,
    host: DEFAULT_HOST,
    port: defaultPort,
    portProvided: false,
    token: null,
    url: null,
    vaultPath: DEFAULT_VAULT_PATH
  };

  for (let index = 1; index < argv.length; index += 1) {
    const current = argv[index];

    switch (current) {
      case "--host":
        options.host = requireValue(argv, ++index, "--host");
        break;
      case "--port":
        options.port = parsePort(requireValue(argv, ++index, "--port"));
        options.portProvided = true;
        break;
      case "--url":
        options.url = requireValue(argv, ++index, "--url");
        break;
      case "--folder":
        options.folder = requireValue(argv, ++index, "--folder");
        break;
      case "--token":
        options.token = requireValue(argv, ++index, "--token");
        break;
      case "--vault":
        options.vaultPath = requireValue(argv, ++index, "--vault");
        break;
      case "--help":
      case "-h":
        options.help = true;
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

function parsePort(value) {
  const port = Number.parseInt(value, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

async function addRepoCommand(options) {
  if (!options.url) {
    throw new Error("The add command requires --url <repository-url>.");
  }

  if (!options.folder) {
    throw new Error("The add command requires --folder <repository-folder>.");
  }

  if (!options.token) {
    throw new Error("The add command requires --token <github-token>.");
  }

  const repoRoot = await findGitRoot(path.resolve(options.folder));
  const normalizedUrl = normalizeRepositoryRemote(options.url);
  const vault = await readVault(options.vaultPath);
  const nextRecord = {
    folder: repoRoot,
    repositoryUrl: normalizedUrl,
    token: options.token,
    updatedAt: new Date().toISOString()
  };
  const existingIndex = vault.repos.findIndex((repo) => {
    return repo.repositoryUrl === normalizedUrl || path.resolve(repo.folder) === repoRoot;
  });

  if (existingIndex >= 0) {
    vault.repos[existingIndex] = {
      ...vault.repos[existingIndex],
      ...nextRecord
    };
  } else {
    vault.repos.push({
      createdAt: nextRecord.updatedAt,
      ...nextRecord
    });
  }

  await writeVault(options.vaultPath, vault);
  console.log(`Stored ${normalizedUrl} -> ${repoRoot}`);
}

async function deleteRepoCommand(options) {
  if (!options.url) {
    throw new Error("The delete command requires --url <repository-url>.");
  }

  const normalizedUrl = normalizeRepositoryRemote(options.url);
  const vault = await readVault(options.vaultPath);
  const beforeLength = vault.repos.length;
  vault.repos = vault.repos.filter((repo) => normalizeRepositoryRemote(repo.repositoryUrl) !== normalizedUrl);

  if (vault.repos.length === beforeLength) {
    throw new Error(`Repository not found in vault: ${normalizedUrl}`);
  }

  await writeVault(options.vaultPath, vault);
  console.log(`Deleted ${normalizedUrl} from the vault`);
}

async function setPortCommand(options) {
  if (!options.portProvided) {
    throw new Error("The set-port command requires --port <number>.");
  }

  const result = await setRelayPort(options.port);
  console.log(`Relay port updated to ${result.relayPort} in ${result.configPath}`);
  console.log("Restart the relay server for the new port to take effect.");
}

async function serveRelay(options) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/completed") {
        const payload = await readJsonBody(request);
        const result = await handleCompletedRelay(payload, options.vaultPath);
        respondJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && (request.url === "/report" || request.url === "/create-issue")) {
        const payload = await readJsonBody(request);
        const result = await handleReportRelay(payload, options.vaultPath);
        respondJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && request.url === "/sync") {
        const payload = await readJsonBody(request);
        const result = await handleSyncRelay(payload, options.vaultPath);
        respondJson(response, 200, result);
        return;
      }

      if (request.method === "GET" && request.url === "/health") {
        respondJson(response, 200, { ok: true });
        return;
      }

      respondJson(response, 404, { error: "Not found." });
    } catch (error) {
      respondJson(response, 400, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });

  console.log(`iago-server listening on http://${options.host}:${options.port}`);
  await startVaultRepl(options, {
    onQuit: async () => {
      await closeServer(server);
    }
  });
}

async function startVaultRepl(options, relayConfig, hooks = {}) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log("iago-server vault REPL");
  console.log("Type 'help' for commands, or 'quit' to exit.");

  try {
    while (true) {
      let input;

      try {
        input = (await rl.question("iago-server> ")).trim();
      } catch (error) {
        if (error?.code === "ERR_USE_AFTER_CLOSE" || /readline was closed/i.test(error?.message ?? "")) {
          break;
        }

        throw error;
      }

      if (!input) {
        continue;
      }

      const [command, ...args] = parseReplInput(input);
      const normalizedCommand = command.toLowerCase();

      if (normalizedCommand === "exit" || normalizedCommand === "quit") {
        if (typeof hooks.onQuit === "function") {
          await hooks.onQuit();
        }
        break;
      }

      if (normalizedCommand === "help") {
        printReplHelp(relayConfig);
        continue;
      }

      if (normalizedCommand === "client" && args[0] === "help") {
        printClientHelp();
        continue;
      }

      if (normalizedCommand === "list") {
        await printVaultEntries(options.vaultPath);
        continue;
      }

      if (normalizedCommand === "issues") {
        await printVaultIssueCounts(options.vaultPath);
        continue;
      }

      if (normalizedCommand === "add") {
        const repoOptions = await buildRepoEntryFromReplArgs(rl, options.vaultPath, args);
        await addRepoCommand(repoOptions);
        continue;
      }

      if (normalizedCommand === "delete") {
        const deleteOptions = await buildDeleteRepoArgs(rl, options.vaultPath, args);
        await deleteRepoCommand(deleteOptions);
        continue;
      }

      if (normalizedCommand === "set-port") {
        const nextPort = parseReplPort(args);
        await setPortCommand({ port: nextPort });
        continue;
      }

      console.log(`Unknown command: ${command}`);
      printReplHelp(relayConfig);
    }
  } finally {
    rl.close();
  }
}

async function handleCompletedRelay(payload, vaultPath) {
  const issueNumber = Number.parseInt(String(payload.issueNumber), 10);

  if (!Number.isInteger(issueNumber) || issueNumber < 0) {
    throw new Error("The relay request requires a valid issueNumber.");
  }

  const repositoryUrl = normalizeRepositoryRemote(payload.repositoryUrl);
  const repositoryFolder = await findGitRoot(path.resolve(String(payload.repositoryFolder ?? "")));
  const vault = await readVault(vaultPath);
  const repo = vault.repos.find((entry) => {
    return entry.repositoryUrl === repositoryUrl && path.resolve(entry.folder) === repositoryFolder;
  });

  if (!repo) {
    throw new Error(`Repository is not registered in the relay vault: ${repositoryUrl} (${repositoryFolder})`);
  }

  const result = await commitIssueViaGit({
    repoRoot: repo.folder,
    files: Array.isArray(payload.files) ? payload.files : [],
    issueNumber,
    title: payload.title ?? null,
    description: payload.description ?? null,
    push: Boolean(payload.push || payload.save),
    token: repo.token,
    remote: payload.remote ?? "origin",
    branch: payload.branch ?? null
  });

  return {
    branch: result.branch,
    closeIssueError: result.closeIssueError?.message ?? null,
    closedIssue: result.closedIssue,
    commitMessage: result.commitMessage,
    files: result.files,
    issueNumber: result.issueNumber,
    ok: true,
    pushed: result.pushed,
    remote: result.remote,
    repositoryFolder: repo.folder,
    repositoryUrl: repo.repositoryUrl
  };
}

async function handleSyncRelay(payload, vaultPath) {
  const repositoryUrl = normalizeRepositoryRemote(payload.repositoryUrl);
  const repositoryFolder = await findGitRoot(path.resolve(String(payload.repositoryFolder ?? "")));
  const vault = await readVault(vaultPath);
  const repo = vault.repos.find((entry) => {
    return entry.repositoryUrl === repositoryUrl && path.resolve(entry.folder) === repositoryFolder;
  });

  if (!repo) {
    throw new Error(`Repository is not registered in the relay vault: ${repositoryUrl} (${repositoryFolder})`);
  }

  const result = await syncIssues(repo.folder, {
    remote: payload.remote ?? "origin",
    token: repo.token
  });

  return {
    ...result,
    ok: true,
    repositoryFolder: repo.folder,
    repositoryUrl: repo.repositoryUrl
  };
}

async function handleReportRelay(payload, vaultPath) {
  if (!payload?.title || !String(payload.title).trim()) {
    throw new Error("The relay request requires a title.");
  }

  const repositoryUrl = normalizeRepositoryRemote(payload.repositoryUrl);
  const repositoryFolder = await findGitRoot(path.resolve(String(payload.repositoryFolder ?? "")));
  const vault = await readVault(vaultPath);
  const repo = vault.repos.find((entry) => {
    return entry.repositoryUrl === repositoryUrl && path.resolve(entry.folder) === repositoryFolder;
  });

  if (!repo) {
    throw new Error(`Repository is not registered in the relay vault: ${repositoryUrl} (${repositoryFolder})`);
  }

  const issue = await createRepositoryIssue({
    repository: parseGitHubRemote(repo.repositoryUrl),
    token: repo.token,
    remoteName: payload.remote ?? "origin",
    remoteUrl: repo.repositoryUrl,
    title: String(payload.title).trim(),
    description: String(payload.description ?? "").trim(),
    label: payload.label
  });

  return {
    ...issue,
    ok: true,
    repositoryFolder: repo.folder,
    repositoryUrl: repo.repositoryUrl
  };
}

async function commitIssueViaGit({
  repoRoot,
  files,
  issueNumber,
  title = null,
  description = null,
  push = false,
  token = null,
  remote = "origin",
  branch = null
}) {
  if (!issueNumber && issueNumber !== 0) {
    throw new Error("completed requires --issue <number>.");
  }

  if (!title?.trim() && !description?.trim()) {
    throw new Error("completed requires --description or --title.");
  }

  if (Array.isArray(files) && files.length > 0) {
    await runGitCommand(["add", "--", ...files], repoRoot);
  } else {
    await runGitCommand(["add", "."], repoRoot);
  }

  const commitMessage = buildIssueFixCommitMessage(issueNumber, { title, description });
  await runGitCommand(buildCommitCommandArgs(commitMessage), repoRoot);

  if (push) {
    const pushArgs = branch
      ? ["push", remote, `HEAD:${branch}`]
      : ["push", remote, "HEAD"];
    await runGitCommand(pushArgs, repoRoot);
  }

  let closedIssue = null;
  let closeIssueError = null;

  try {
    closedIssue = await closeRemoteIssue(repoRoot, {
      issueNumber,
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

async function createRepositoryIssue({
  repository,
  token,
  remoteName,
  remoteUrl,
  title,
  description,
  label
}) {
  const url = new URL(`${repository.apiBaseUrl}/repos/${repository.owner}/${repository.repo}/issues`);
  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...buildHeaders(token),
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      title,
      body: description,
      ...(label ? { labels: [String(label).trim()] } : {})
    })
  });

  if (!response.ok) {
    const body = await safeReadJson(response);
    throw new Error(buildRepositoryApiError({
      action: "create issue",
      repository,
      remoteName,
      remoteUrl,
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

async function readVault(vaultPath) {
  try {
    const contents = await fs.readFile(vaultPath, "utf8");
    const parsed = JSON.parse(contents);

    if (!Array.isArray(parsed?.repos)) {
      return { repos: [] };
    }

    return {
      ...parsed,
      repos: parsed.repos.map(decodeVaultRepo)
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { repos: [] };
    }

    throw error;
  }
}

async function writeVault(vaultPath, value) {
  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  const serialized = {
    ...value,
    repos: Array.isArray(value?.repos) ? value.repos.map(encodeVaultRepo) : []
  };
  await fs.writeFile(vaultPath, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
}

function encodeVaultRepo(repo) {
  return {
    ...repo,
    token: encryptVaultToken(repo.token)
  };
}

function decodeVaultRepo(repo) {
  return {
    ...repo,
    token: decryptVaultToken(repo.token)
  };
}

function encryptVaultToken(token) {
  if (typeof token !== "string" || token.length === 0) {
    throw new Error("The relay vault requires a token to encrypt.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", VAULT_SECRET, iv);
  const encrypted = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    VAULT_TOKEN_PREFIX,
    VAULT_TOKEN_VERSION,
    iv.toString("hex"),
    authTag.toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

function decryptVaultToken(token) {
  if (typeof token !== "string" || !token.startsWith(`${VAULT_TOKEN_PREFIX}:`)) {
    return token;
  }

  const parts = token.split(":");
  if (parts.length !== 5 || parts[0] !== VAULT_TOKEN_PREFIX || parts[1] !== VAULT_TOKEN_VERSION) {
    throw new Error("The relay vault contains an invalid encrypted token.");
  }

  const [, , ivHex, authTagHex, encryptedHex] = parts;
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    VAULT_SECRET,
    Buffer.from(ivHex, "hex")
  );

  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedHex, "hex")),
    decipher.final()
  ]);

  return decrypted.toString("utf8");
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks).toString("utf8");

  if (!body) {
    return {};
  }

  try {
    return JSON.parse(body);
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function respondJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function printHelp(relayConfig) {
  console.log(`iago-server

  Usage:
    iago-server serve [--host 127.0.0.1] [--port <port>] [--vault <path>]
    iago-server repl
    iago-server list [--vault <path>]
    iago-server issues [--vault <path>]
    iago-server add --url <repository-url> --folder <repository-folder> --token <github-token>
    iago-server delete --url <repository-url>
    iago-server client help
    iago-server set-port --port <port>

Default command:
  repl

Options:
  --host <host>     Host to bind the relay server to. Defaults to 127.0.0.1.
  --port <port>     Port to bind the relay server to. Defaults to the shared relay config.
  --vault <path>    Optional path to the relay vault file.
  --url <url>       Repository URL to register in the vault.
  --folder <path>   Repository folder to register in the vault.
  --token <token>   GitHub token stored in the relay vault for this repo.

Shared relay config:
  ${relayConfig.configPath}
  Default port: ${relayConfig.relayPort}

The serve command starts the HTTP listener and opens the REPL in the same process.
`);
}

function printReplHelp(relayConfig) {
  console.log(`
  Commands:
    help      Show this help.
    client    client help
              Show the client command reference.
    list      list [--vault <path>]
              Show repositories currently stored in the vault.
    add       add --url <repository-url> --folder <repository-folder> --token <github-token> [--vault <path>]
              Add or update a repository in the vault.
    delete    delete --url <repository-url> [--vault <path>]
              Remove a repository from the vault.
    issues    issues [--vault <path>]
              Check the number of open issues for each stored repository.
    set-port  set-port <port>
              Update the shared relay config with a new server port.
    quit      Leave the REPL.
    exit      Same as quit.

Shared relay config:
  ${relayConfig.configPath}
  Default port: ${relayConfig.relayPort}
`);
}

function printClientHelp() {
  console.log(`iago

Usage:
  iago sync [--cwd <path>] [--remote <name>] [--token <token>] [--relay] [--relay-url <url>]
  iago list [--cwd <path>] [--all] [--json] [--output <path>]
  iago show --issue <number> [--cwd <path>] [--json] [--output <path>]
  iago start-issue --issue <number> [--cwd <path>]
  iago completed --issue <number> --files <paths>... [--cwd <path>] [--title <text>] [--description <text>] [--token <token>] [--push] [--branch <name>] [--json] [--relay] [--save]
  iago report --title <text> --description <text> --label <bug|improvement|feature> [--cwd <path>] [--token <token>] [--json] [--output <path>]
  iago create-issue --title <text> --description <text> --label <bug|improvement|feature> [--cwd <path>] [--token <token>] [--json] [--output <path>]
  iago set-port --port <number>

Commands:
  sync         Download open GitHub issues into the local backlog.
  list         Print issues from the local backlog.
  show         Print one issue from the local backlog.
  start-issue  Create or switch to the branch for an issue.
  completed    Stage files, commit the work, and close the issue.
  report       Create a new issue on the remote repository.
  create-issue Same as report.
  set-port     Update the shared relay config with a new server port.

Authentication:
  --token <token>
  GITHUB_TOKEN
  GH_TOKEN
`);
}

async function buildRepoEntryFromReplArgs(rl, vaultPath, args) {
  const parsed = parseReplFlags(args);
  const repositoryUrl = parsed.url ?? (await rl.question("Repository URL: ")).trim();
  const folder = parsed.folder ?? (await rl.question("Repository folder: ")).trim();
  const token = parsed.token ?? (await rl.question("GitHub token: ")).trim();

  return {
  command: "add",
    folder,
    token,
    url: repositoryUrl,
    vaultPath
  };
}

async function buildDeleteRepoArgs(rl, vaultPath, args) {
  const parsed = parseReplFlags(args);
  const repositoryUrl = parsed.url ?? (await rl.question("Repository URL: ")).trim();

  return {
    command: "delete",
    url: repositoryUrl,
    vaultPath
  };
}

function parseReplInput(input) {
  const tokens = input.match(/"([^"]*)"|'([^']*)'|(?:\S+)/g) ?? [];

  return tokens.map((token) => {
    if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
      return token.slice(1, -1);
    }

    return token;
  });
}

function parseReplPort(args) {
  if (args[0] === "--port") {
    return parsePort(requireValue(args, 1, "--port"));
  }

  if (args[0]) {
    return parsePort(args[0]);
  }

  throw new Error("The set-port command requires a port number.");
}

function parseReplFlags(args) {
  const result = {
    folder: null,
    token: null,
    url: null
  };

  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];

    switch (current) {
      case "--url":
        result.url = requireReplValue(args, ++index, "--url");
        break;
      case "--folder":
        result.folder = requireReplValue(args, ++index, "--folder");
        break;
      case "--token":
        result.token = requireReplValue(args, ++index, "--token");
        break;
      case "--help":
      case "-h":
        break;
      default:
        throw new Error(`Unknown REPL argument: ${current}`);
    }
  }

  return result;
}

function requireReplValue(args, index, flagName) {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`Missing value for ${flagName}.`);
  }

  return value;
}

async function printVaultEntries(vaultPath) {
  const vault = await readVault(vaultPath);

  if (!vault.repos.length) {
    console.log("No repositories are stored in the vault.");
    return;
  }

  for (const repo of vault.repos) {
    console.log(`- ${repo.repositoryUrl} -> ${repo.folder}`);
  }
}

async function printVaultIssueCounts(vaultPath) {
  const vault = await readVault(vaultPath);

  if (!vault.repos.length) {
    console.log("No repositories are stored in the vault.");
    return;
  }

  for (const repo of vault.repos) {
    const result = await fetchRepositoryBacklog(repo);
    console.log(`- ${repo.repositoryUrl} -> ${repo.folder}: ${result.issueCount} open issues`);
  }
}

async function fetchRepositoryBacklog(repo) {
  const repository = parseGitHubRemote(repo.repositoryUrl);
  const existingBacklog = await readExistingBacklog(path.join(repo.folder, BACKLOG_DIR_NAME, "issues.json"));
  const token = repo.token ?? "";
  const issues = await fetchRepositoryIssues({
    repository,
    token,
    remoteName: "vault",
    remoteUrl: repo.repositoryUrl,
    existingBacklog
  });

  return buildRepositoryBacklog(repository, repo.repositoryUrl, issues);
}

async function fetchRepositoryIssues({
  repository,
  token,
  remoteName,
  remoteUrl,
  existingBacklog = { issues: [] }
}) {
  let page = 1;
  const issues = [];
  const existingIssues = new Map((existingBacklog?.issues ?? []).map((issue) => [issue.number, issue]));

  while (true) {
    const url = new URL(`${repository.apiBaseUrl}/repos/${repository.owner}/${repository.repo}/issues`);
    url.searchParams.set("state", "open");
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));

    let response;

    try {
      response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "iago"
        }
      });
    } catch (error) {
      throw new Error(`Failed to fetch issue count for ${remoteUrl}: ${error.message}`);
    }

    if (response.status === 401 || response.status === 403) {
      const body = await safeReadJson(response);
      const reason = body?.message ?? `GitHub API returned ${response.status}.`;
      throw new Error(`Authentication failed or rate limit exceeded for ${remoteUrl}: ${reason}`);
    }

    if (!response.ok) {
      const body = await safeReadJson(response);
      throw new Error(buildRepositoryApiError({
        action: "fetch issue count",
        repository,
        remoteName,
        remoteUrl,
        tokenPresent: Boolean(token.trim()),
        response,
        body
      }));
    }

    const pageItems = await response.json();
    const openIssues = pageItems.filter((entry) => !Object.prototype.hasOwnProperty.call(entry, "pull_request"));
    for (const item of openIssues) {
      const existingIssue = existingIssues.get(item.number);
      if (existingIssue && existingIssue.updatedAt === item.updated_at) {
        issues.push(existingIssue);
        continue;
      }

      issues.push({
        number: item.number,
        title: item.title,
        description: item.body ?? "",
        state: item.state,
        htmlUrl: item.html_url,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        author: item.user?.login ?? null,
        labels: Array.isArray(item.labels) ? item.labels.map((label) => label.name) : []
      });
    }

    if (pageItems.length < 100) {
      return issues;
    }

    page += 1;
  }
}

function buildRepositoryBacklog(repository, repositoryUrl, issues) {
  return {
    repository: `${repository.owner}/${repository.repo}`,
    host: repository.host,
    remote: "vault",
    remoteUrl: repositoryUrl,
    issueCount: issues.length,
    issues
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function getServerDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

if (isEntrypoint(import.meta.url)) {
  await main();
}

function isEntrypoint(moduleUrl) {
  if (!process.argv[1]) {
    return false;
  }

  try {
    const modulePath = fileURLToPath(moduleUrl);
    const argvPath = path.resolve(process.argv[1]);

    return argvPath === modulePath || `${argvPath}.js` === modulePath;
  } catch {
    return false;
  }
}

export {
  main
};
