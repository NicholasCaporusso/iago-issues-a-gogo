#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildIssueFixCommitMessage,
  closeRemoteIssue,
  findGitRoot,
  normalizeRepositoryRemote,
  syncIssues
} from "../cli.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4317;
const DEFAULT_VAULT_PATH = path.join(getServerDir(), "vault", "repos.json");

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));

    switch (options.command) {
      case "serve":
        await serveRelay(options);
        return;
      case "add-repo":
        await addRepoCommand(options);
        return;
      default:
        printHelp();
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

function parseArgs(argv) {
  const options = {
    command: argv[0] ?? "serve",
    folder: null,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
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
        printHelp();
        process.exit(0);
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
    throw new Error("The add-repo command requires --url <repository-url>.");
  }

  if (!options.folder) {
    throw new Error("The add-repo command requires --folder <repository-folder>.");
  }

  if (!options.token) {
    throw new Error("The add-repo command requires --token <github-token>.");
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

async function serveRelay(options) {
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "POST" && request.url === "/completed") {
        const payload = await readJsonBody(request);
        const result = await handleCompletedRelay(payload, options.vaultPath);
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

  console.log(`Relay server listening on http://${options.host}:${options.port}`);
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

async function readVault(vaultPath) {
  try {
    const contents = await fs.readFile(vaultPath, "utf8");
    const parsed = JSON.parse(contents);

    if (!Array.isArray(parsed?.repos)) {
      return { repos: [] };
    }

    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { repos: [] };
    }

    throw error;
  }
}

async function writeVault(vaultPath, value) {
  await fs.mkdir(path.dirname(vaultPath), { recursive: true });
  await fs.writeFile(vaultPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
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

function printHelp() {
  console.log(`issues-relay-server

Usage:
  node ./server.js serve [--host 127.0.0.1] [--port 4317]
  node ./server.js add-repo --url <repository-url> --folder <repository-folder> --token <github-token>

Options:
  --host <host>     Host to bind the relay server to. Defaults to 127.0.0.1.
  --port <port>     Port to bind the relay server to. Defaults to 4317.
  --vault <path>    Optional path to the relay vault file.
  --url <url>       Repository URL to register in the vault.
  --folder <path>   Repository folder to register in the vault.
  --token <token>   GitHub token stored in the relay vault for this repo.
`);
}

function getServerDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

await main();
