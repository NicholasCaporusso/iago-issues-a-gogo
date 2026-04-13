import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  findGitRoot,
  parseGitHubRemote,
  readGitRemotes,
  resolveGitDir
} from "../src/index.js";

test("parseGitHubRemote supports SSH remotes", () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:octocat/hello-world.git"), {
    apiBaseUrl: "https://api.github.com",
    host: "github.com",
    owner: "octocat",
    repo: "hello-world"
  });
});

test("parseGitHubRemote supports GitHub Enterprise HTTPS remotes", () => {
  assert.deepEqual(parseGitHubRemote("https://git.example.com/acme/tools.git"), {
    apiBaseUrl: "https://git.example.com/api/v3",
    host: "git.example.com",
    owner: "acme",
    repo: "tools"
  });
});

test("readGitRemotes extracts remote URLs from config", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-config-test-"));
  const gitDir = path.join(tempDir, ".git");
  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, "config"), `[core]
  repositoryformatversion = 0
[remote "origin"]
  url = git@github.com:octocat/hello-world.git
[remote "upstream"]
  url = https://github.com/acme/other.git
`, "utf8");

  const remotes = await readGitRemotes(gitDir);

  assert.equal(remotes.get("origin"), "git@github.com:octocat/hello-world.git");
  assert.equal(remotes.get("upstream"), "https://github.com/acme/other.git");
});

test("findGitRoot discovers parent repository", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "git-root-test-"));
  const repoDir = path.join(tempDir, "repo");
  const nestedDir = path.join(repoDir, "a", "b");
  await fs.mkdir(path.join(repoDir, ".git"), { recursive: true });
  await fs.mkdir(nestedDir, { recursive: true });

  const root = await findGitRoot(nestedDir);

  assert.equal(root, repoDir);
});

test("resolveGitDir supports worktree .git files", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gitdir-test-"));
  const repoDir = path.join(tempDir, "repo");
  const actualGitDir = path.join(tempDir, "actual-git-dir");
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(actualGitDir, { recursive: true });
  await fs.writeFile(path.join(repoDir, ".git"), "gitdir: ../actual-git-dir\n", "utf8");

  const resolved = await resolveGitDir(repoDir);

  assert.equal(resolved, actualGitDir);
});
