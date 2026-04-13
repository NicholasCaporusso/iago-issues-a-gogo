import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  filterOpenIssues,
  closeRemoteIssue,
  createRemoteIssue,
  ensureBacklog,
  findIssueByNumber,
  buildIssueFixCommitMessage,
  buildRepositoryApiError,
  buildImageFileName,
  buildResolvedImageFileName,
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
  resolveGitDir,
  startIssueBranch,
  syncIssues,
  updateBacklogIssueState,
  writeJsonFile
} from "../index.js";

test("parseGitHubRemote supports SSH remotes", () => {
  assert.deepEqual(parseGitHubRemote("git@github.com:octocat/hello-world.git"), {
    apiBaseUrl: "https://api.github.com",
    host: "github.com",
    owner: "octocat",
    repo: "hello-world"
  });
});

test("parseArgs supports sync and commit-fix commands", () => {
  assert.deepEqual(
    parseArgs(["sync", "--remote", "upstream", "--json"]),
    {
      all: false,
      branch: null,
      command: "sync",
      cwd: null,
      description: null,
      files: [],
      help: false,
      issueNumber: null,
      json: true,
      label: null,
      output: null,
      push: false,
      remote: "upstream",
      runner: parseArgs([]).runner,
      title: null,
      token: null
    }
  );

  const commitArgs = parseArgs([
    "commit-fix",
    "--issue", "42",
    "--description", "Save progress",
    "--files", "src/index.js", "README.md",
    "--push",
    "--branch", "main"
  ]);

  assert.equal(commitArgs.command, "commit-fix");
  assert.equal(commitArgs.issueNumber, 42);
  assert.equal(commitArgs.description, "Save progress");
  assert.deepEqual(commitArgs.files, ["src/index.js", "README.md"]);
  assert.equal(commitArgs.push, true);
  assert.equal(commitArgs.branch, "main");
});

test("parseArgs supports create-issue command", () => {
  const createArgs = parseArgs([
    "create-issue",
    "--title", "New regression",
    "--description", "Steps to reproduce",
    "--label", "feature",
    "--remote", "upstream"
  ]);

  assert.equal(createArgs.command, "create-issue");
  assert.equal(createArgs.title, "New regression");
  assert.equal(createArgs.description, "Steps to reproduce");
  assert.equal(createArgs.label, "feature");
  assert.equal(createArgs.remote, "upstream");
});

test("parseArgs supports title and description for commit-fix", () => {
  const commitArgs = parseArgs([
    "commit-fix",
    "--issue", "42",
    "--title", "Implement parser fix",
    "--description", "Detailed explanation\nwith another line"
  ]);

  assert.equal(commitArgs.title, "Implement parser fix");
  assert.equal(commitArgs.description, "Detailed explanation\nwith another line");
});

test("parseArgs supports --all for list", () => {
  const args = parseArgs(["list", "--all"]);
  assert.equal(args.command, "list");
  assert.equal(args.all, true);
});

test("buildIssueFixCommitMessage formats issue close message", () => {
  assert.equal(
    buildIssueFixCommitMessage(123, { description: "Handle edge cases in importer" }),
    "fix(issue): close #123 - Handle edge cases in importer"
  );
});

test("buildIssueFixCommitMessage supports title and description", () => {
  assert.equal(
    buildIssueFixCommitMessage(123, {
      title: "Handle edge cases in importer",
      description: "Adds coverage for empty payloads."
    }),
    "fix(issue): close #123 - Handle edge cases in importer\n\nAdds coverage for empty payloads."
  );
});

test("buildRepositoryApiError explains private repo 404 without token", () => {
  const message = buildRepositoryApiError({
    action: "fetch issues",
    repository: {
      owner: "NicholasCaporusso",
      repo: "tools-nodejs-repo-resolver"
    },
    tokenPresent: false,
    response: { status: 404 },
    body: { message: "Not Found" }
  });

  assert.equal(
    message,
    "Failed to fetch issues for NicholasCaporusso/tools-nodejs-repo-resolver: Not Found. If this repository is private, GitHub returns 404 unless you provide --token, GITHUB_TOKEN, or GH_TOKEN."
  );
});

test("normalizeRepositoryRemote canonicalizes equivalent git remotes", () => {
  assert.equal(
    normalizeRepositoryRemote("git@github.com:octocat/hello-world.git"),
    "https://github.com/octocat/hello-world"
  );
  assert.equal(
    normalizeRepositoryRemote("https://github.com/octocat/hello-world.git"),
    "https://github.com/octocat/hello-world"
  );
});

test("readTokenLookup parses tsv records and ignores comments", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-read-test-"));
  const lookupPath = path.join(tempDir, "lookup.tsv");
  await fs.writeFile(lookupPath, [
    "# comment",
    "https://github.com/acme/repo.git\tsecret-a",
    "",
    "git@github.com:octocat/hello-world.git\tsecret-b"
  ].join("\n"), "utf8");

  const records = await readTokenLookup(lookupPath);

  assert.deepEqual(records, [
    { repositoryUrl: "https://github.com/acme/repo.git", token: "secret-a" },
    { repositoryUrl: "git@github.com:octocat/hello-world.git", token: "secret-b" }
  ]);
});

test("lookupTokenForRepository matches equivalent remote url formats", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-match-test-"));
  const lookupPath = path.join(tempDir, "lookup.tsv");
  await fs.writeFile(
    lookupPath,
    "git@github.com:octocat/hello-world.git\tlookup-secret\n",
    "utf8"
  );

  const token = await lookupTokenForRepository(
    "https://github.com/octocat/hello-world.git",
    lookupPath
  );

  assert.equal(token, "lookup-secret");
});

test("requireGitHubToken falls back to lookup.tsv when direct token is missing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "lookup-token-test-"));
  const lookupPath = path.join(tempDir, "lookup.tsv");
  await fs.writeFile(
    lookupPath,
    "https://github.com/acme/repo.git\tlookup-secret\n",
    "utf8"
  );

  const token = await requireGitHubToken(
    {
      token: null,
      lookupPath
    },
    "git@github.com:acme/repo.git"
  );

  assert.equal(token, "lookup-secret");
});

test("requireGitHubToken throws when no token is configured anywhere", async () => {
  await assert.rejects(
    requireGitHubToken({ token: null, lookupPath: "C:\\missing\\lookup.tsv" }, "https://github.com/acme/repo.git"),
    /requires a GitHub token/
  );
});

test("makeIssueBranchName returns stable issue branch names", () => {
  assert.equal(makeIssueBranchName(55), "issue/55");
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

test("extractImageReferences finds markdown and html images", () => {
  const references = extractImageReferences([
    'Before ![diagram](https://example.com/assets/diagram.png "diagram") after',
    '<img src="https://example.com/assets/render.jpg" alt="render">'
  ].join("\n"));

  assert.deepEqual(references, [
    {
      original: '![diagram](https://example.com/assets/diagram.png "diagram")',
      url: "https://example.com/assets/diagram.png"
    },
    {
      original: '<img src="https://example.com/assets/render.jpg" alt="render">',
      url: "https://example.com/assets/render.jpg"
    }
  ]);
});

test("buildImageFileName prefixes index and preserves extension", () => {
  assert.equal(
    buildImageFileName("https://example.com/assets/render.jpg?size=large", 1),
    "02-render.jpg"
  );
});

test("buildResolvedImageFileName uses content type when the URL has no extension", () => {
  assert.equal(
    buildResolvedImageFileName("https://example.com/assets/render", 1, "image/png"),
    "02-render.png"
  );
});

test("extensionFromContentType maps common image mime types", () => {
  assert.equal(extensionFromContentType("image/jpeg; charset=utf-8"), ".jpg");
  assert.equal(extensionFromContentType("image/webp"), ".webp");
});

test("detectImageExtensionFromBytes recognizes common image signatures", () => {
  assert.equal(detectImageExtensionFromBytes(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), ".png");
  assert.equal(detectImageExtensionFromBytes(Buffer.from([0xff, 0xd8, 0xff, 0xdb])), ".jpg");
});

test("localizeIssueImages downloads images and rewrites the description", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-images-test-"));
  const originalFetch = global.fetch;

  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-type") {
          return url.includes("diagram.jpg") ? "image/jpeg" : "image/png";
        }

        return null;
      }
    },
    arrayBuffer: async () => new TextEncoder().encode(`downloaded:${url}`).buffer
  });

  try {
    const rewritten = await localizeIssueImages([
      "Here is a screenshot:",
      '![screen](https://example.com/assets/screen.png)',
      '<img src="https://example.com/assets/diagram.jpg" alt="diagram">'
    ].join("\n"), 42, "token-value", tempDir);

    assert.equal(rewritten, [
      "Here is a screenshot:",
      "backlog/images/42/01-screen.png",
      "backlog/images/42/02-diagram.jpg"
    ].join("\n"));

    assert.equal(
      await fs.readFile(path.join(tempDir, "backlog", "images", "42", "01-screen.png"), "utf8"),
      "downloaded:https://example.com/assets/screen.png"
    );
    assert.equal(
      await fs.readFile(path.join(tempDir, "backlog", "images", "42", "02-diagram.jpg"), "utf8"),
      "downloaded:https://example.com/assets/diagram.jpg"
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("localizeIssueImages preserves image extension from content type when URL lacks one", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-images-ext-test-"));
  const originalFetch = global.fetch;

  global.fetch = async (url) => ({
    ok: true,
    status: 200,
    headers: {
      get(name) {
        if (String(name).toLowerCase() === "content-type") {
          return "image/webp";
        }

        return null;
      }
    },
    arrayBuffer: async () => new TextEncoder().encode(`downloaded:${url}`).buffer
  });

  try {
    const rewritten = await localizeIssueImages(
      '![screen](https://example.com/assets/screen)',
      7,
      "token-value",
      tempDir
    );

    assert.equal(rewritten, "backlog/images/7/01-screen.webp");
    assert.equal(
      await fs.readFile(path.join(tempDir, "backlog", "images", "7", "01-screen.webp"), "utf8"),
      "downloaded:https://example.com/assets/screen"
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test("localizeIssueImages infers extension from file bytes when content type is missing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "issue-images-bytes-test-"));
  const originalFetch = global.fetch;
  const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

  global.fetch = async () => ({
    ok: true,
    status: 200,
    headers: {
      get() {
        return null;
      }
    },
    arrayBuffer: async () => pngBytes.buffer.slice(
      pngBytes.byteOffset,
      pngBytes.byteOffset + pngBytes.byteLength
    )
  });

  try {
    const rewritten = await localizeIssueImages(
      '![screen](https://github.com/user-attachments/assets/123456)',
      9,
      "token-value",
      tempDir
    );

    assert.equal(rewritten, "backlog/images/9/01-123456.png");
    const stored = await fs.readFile(path.join(tempDir, "backlog", "images", "9", "01-123456.png"));
    assert.deepEqual(stored, pngBytes);
  } finally {
    global.fetch = originalFetch;
  }
});

test("commitIssueFix stages files, commits, and optionally pushes", async () => {
  const calls = [];
  const runner = async (args, cwd) => {
    calls.push({ args, cwd });
    return { stdout: "", stderr: "" };
  };
  const issueCloserCalls = [];
  const issueCloser = async (repoRoot, options) => {
    issueCloserCalls.push({ repoRoot, options });
    return { number: 77, state: "closed", title: "Issue 77", htmlUrl: "https://example.com/issues/77" };
  };

    const result = await commitIssueFix({
      repoRoot: "C:\\repo",
      files: ["src/index.js", "README.md"],
      issueNumber: 77,
      description: "Implement git workflow helper",
      push: true,
    remote: "origin",
    branch: "main",
    runner,
    issueCloser
  });

  assert.deepEqual(calls, [
    {
      args: ["add", "--", "src/index.js", "README.md"],
      cwd: "C:\\repo"
    },
    {
      args: ["commit", "-m", "fix(issue): close #77 - Implement git workflow helper"],
      cwd: "C:\\repo"
    },
    {
      args: ["push", "origin", "HEAD:main"],
      cwd: "C:\\repo"
    }
  ]);

  assert.deepEqual(issueCloserCalls, [
    {
      repoRoot: "C:\\repo",
      options: {
        issueNumber: 77,
        lookupPath: null,
        remote: "origin",
        token: null
      }
    }
  ]);

  assert.deepEqual(result, {
    branch: "main",
    closedIssue: {
      number: 77,
      state: "closed",
      title: "Issue 77",
      htmlUrl: "https://example.com/issues/77"
    },
    commitMessage: "fix(issue): close #77 - Implement git workflow helper",
    files: ["src/index.js", "README.md"],
    issueNumber: 77,
    pushed: true,
    remote: "origin"
  });
});

test("commitIssueFix validates required input", async () => {
  await assert.rejects(
    commitIssueFix({
      repoRoot: "C:\\repo",
      files: ["src/index.js"],
      description: "Missing issue number"
    }),
    /issueNumber/
  );

  await assert.rejects(
    commitIssueFix({
      repoRoot: "C:\\repo",
      files: ["src/index.js"],
      issueNumber: 10,
      title: null,
      description: null
    }),
    /--description or --title/
  );
});

test("commitIssueFix stages all files when files are omitted", async () => {
  const calls = [];
  const runner = async (args, cwd) => {
    calls.push({ args, cwd });
    return { stdout: "", stderr: "" };
  };
  const issueCloser = async () => ({ number: 12, state: "closed", title: "Issue 12", htmlUrl: "https://example.com/issues/12" });

  const result = await commitIssueFix({
    repoRoot: "C:\\repo",
    issueNumber: 12,
    description: "Checkpoint all current changes",
    runner,
    issueCloser
  });

  assert.deepEqual(calls, [
    {
      args: ["add", "."],
      cwd: "C:\\repo"
    },
    {
      args: ["commit", "-m", "fix(issue): close #12 - Checkpoint all current changes"],
      cwd: "C:\\repo"
    }
  ]);

  assert.deepEqual(result, {
    branch: null,
    closedIssue: {
      number: 12,
      state: "closed",
      title: "Issue 12",
      htmlUrl: "https://example.com/issues/12"
    },
    commitMessage: "fix(issue): close #12 - Checkpoint all current changes",
    files: [],
    issueNumber: 12,
    pushed: false,
    remote: "origin"
  });
});

test("commitIssueFix supports separate title and description", async () => {
  const calls = [];
  const runner = async (args, cwd) => {
    calls.push({ args, cwd });
    return { stdout: "", stderr: "" };
  };
  const issueCloser = async () => ({ number: 21, state: "closed", title: "Issue 21", htmlUrl: "https://example.com/issues/21" });

  const result = await commitIssueFix({
    repoRoot: "C:\\repo",
    issueNumber: 21,
    title: "Implement parser fix",
    description: "Covers malformed headers.\nAdds regression tests.",
    runner,
    issueCloser
  });

  assert.deepEqual(calls, [
    {
      args: ["add", "."],
      cwd: "C:\\repo"
    },
    {
      args: [
        "commit",
        "-m", "fix(issue): close #21 - Implement parser fix",
        "-m", "Covers malformed headers.\nAdds regression tests."
      ],
      cwd: "C:\\repo"
    }
  ]);

  assert.equal(
    result.commitMessage,
    "fix(issue): close #21 - Implement parser fix\n\nCovers malformed headers.\nAdds regression tests."
  );
  assert.equal(result.closedIssue.state, "closed");
});

test("startIssueBranch creates a new issue branch when it does not exist", async () => {
  const calls = [];
  const runner = async (args, cwd) => {
    calls.push({ args, cwd });

    if (args[0] === "rev-parse") {
      throw new Error("missing branch");
    }

    return { stdout: "", stderr: "" };
  };

  const branchName = await startIssueBranch({
    issueNumber: 8,
    repoRoot: "C:\\repo",
    runner
  });

  assert.equal(branchName, "issue/8");
  assert.deepEqual(calls, [
    { args: ["rev-parse", "--verify", "issue/8"], cwd: "C:\\repo" },
    { args: ["checkout", "-b", "issue/8"], cwd: "C:\\repo" }
  ]);
});

test("startIssueBranch checks out an existing issue branch", async () => {
  const calls = [];
  const runner = async (args, cwd) => {
    calls.push({ args, cwd });
    return { stdout: "", stderr: "" };
  };

  const branchName = await startIssueBranch({
    issueNumber: 9,
    repoRoot: "C:\\repo",
    runner
  });

  assert.equal(branchName, "issue/9");
  assert.deepEqual(calls, [
    { args: ["rev-parse", "--verify", "issue/9"], cwd: "C:\\repo" },
    { args: ["checkout", "issue/9"], cwd: "C:\\repo" }
  ]);
});

test("writeJsonFile creates parent directories and writes formatted json", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-json-test-"));
  const outputPath = path.join(tempDir, "backlog", "issues.json");

  await writeJsonFile(outputPath, { issueCount: 1, issues: [{ number: 1 }] });

  const written = await fs.readFile(outputPath, "utf8");
  assert.equal(
    written,
    '{\n  "issueCount": 1,\n  "issues": [\n    {\n      "number": 1\n    }\n  ]\n}\n'
  );
});

test("writeJsonFile avoids overwriting unchanged content", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-json-skip-test-"));
  const outputPath = path.join(tempDir, "backlog", "issues.json");
  const payload = { issueCount: 1, issues: [{ number: 1 }] };

  const firstWrite = await writeJsonFile(outputPath, payload);
  const firstStat = await fs.stat(outputPath);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const secondWrite = await writeJsonFile(outputPath, payload);
  const secondStat = await fs.stat(outputPath);

  assert.equal(firstWrite, true);
  assert.equal(secondWrite, false);
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs);
});

test("readExistingBacklog returns empty issues when file is missing", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "read-backlog-test-"));
  const backlog = await readExistingBacklog(path.join(tempDir, "backlog", "issues.json"));
  assert.deepEqual(backlog, { issues: [] });
});

test("findIssueByNumber returns the matching issue", () => {
  const issue = findIssueByNumber({ issues: [{ number: 3, title: "Three" }] }, 3);
  assert.deepEqual(issue, { number: 3, title: "Three" });
});

test("findIssueByNumber error references backlog/issues.json", () => {
  assert.throws(
    () => findIssueByNumber({ issues: [] }, 999),
    /backlog\/issues\.json/
  );
});

test("filterOpenIssues keeps only open issues for list output", () => {
  const filtered = filterOpenIssues({
    repository: "acme/repo",
    issueCount: 3,
    issues: [
      { number: 1, state: "open", title: "Open one" },
      { number: 2, state: "closed", title: "Closed one" },
      { number: 3, state: "open", title: "Open two" }
    ]
  });

  assert.equal(filtered.issueCount, 2);
  assert.deepEqual(filtered.issues, [
    { number: 1, state: "open", title: "Open one" },
    { number: 3, state: "open", title: "Open two" }
  ]);
});

test("filterOpenIssues excludes improvement and feature labels by default", () => {
  const filtered = filterOpenIssues({
    repository: "acme/repo",
    issueCount: 4,
    issues: [
      { number: 1, state: "open", title: "Bug issue", labels: ["bug"] },
      { number: 2, state: "open", title: "Improvement issue", labels: ["improvement"] },
      { number: 3, state: "open", title: "Feature issue", labels: ["feature"] },
      { number: 4, state: "open", title: "No label issue", labels: [] }
    ]
  });

  assert.equal(filtered.issueCount, 2);
  assert.deepEqual(filtered.issues.map((issue) => issue.number), [1, 4]);
});

test("filterOpenIssues includes all open issues when --all is used", () => {
  const filtered = filterOpenIssues({
    repository: "acme/repo",
    issueCount: 3,
    issues: [
      { number: 1, state: "open", title: "Bug issue", labels: ["bug"] },
      { number: 2, state: "open", title: "Improvement issue", labels: ["improvement"] },
      { number: 3, state: "open", title: "Feature issue", labels: ["feature"] }
    ]
  }, { all: true });

  assert.equal(filtered.issueCount, 3);
  assert.deepEqual(filtered.issues.map((issue) => issue.number), [1, 2, 3]);
});

test("ensureBacklog returns existing backlog when populated", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ensure-backlog-test-"));
  const backlogPath = path.join(tempDir, "backlog", "issues.json");
  await writeJsonFile(backlogPath, {
    repository: "acme/repo",
    issueCount: 1,
    issues: [{ number: 5, title: "Cached" }]
  });

  const backlog = await ensureBacklog(tempDir, { remote: "origin" });
  assert.equal(backlog.issueCount, 1);
  assert.deepEqual(backlog.issues, [{ number: 5, title: "Cached" }]);
});

test("createRemoteIssue posts a new issue to the repository API", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "create-issue-test-"));
  const gitDir = path.join(tempDir, ".git");
  const originalFetch = global.fetch;
  let requestInfo = null;

  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, "config"), `[remote "origin"]
  url = https://github.com/acme/repo.git
`, "utf8");

  global.fetch = async (url, init) => {
    requestInfo = {
      url: String(url),
      method: init?.method,
      authorization: init?.headers?.Authorization,
      contentType: init?.headers?.["Content-Type"],
      body: init?.body
    };

    return {
      ok: true,
      status: 201,
      json: async () => ({
        number: 88,
        title: "New regression",
        body: "Steps to reproduce",
        html_url: "https://github.com/acme/repo/issues/88",
        state: "open"
      })
    };
  };

  try {
    const createdIssue = await createRemoteIssue(tempDir, {
      remote: "origin",
      token: "secret-token",
      title: "New regression",
      description: "Steps to reproduce",
      label: "feature"
    });

    assert.deepEqual(requestInfo, {
      url: "https://api.github.com/repos/acme/repo/issues",
      method: "POST",
      authorization: "Bearer secret-token",
      contentType: "application/json",
      body: JSON.stringify({
        title: "New regression",
        body: "Steps to reproduce",
        labels: ["feature"]
      })
    });

    assert.deepEqual(createdIssue, {
      number: 88,
      title: "New regression",
      description: "Steps to reproduce",
      htmlUrl: "https://github.com/acme/repo/issues/88",
      state: "open"
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test("updateBacklogIssueState marks a local issue as closed", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "backlog-close-test-"));
  const backlogPath = path.join(tempDir, "backlog", "issues.json");
  await writeJsonFile(backlogPath, {
    repository: "acme/repo",
    issueCount: 2,
    issues: [
      { number: 5, title: "Open issue", state: "open" },
      { number: 6, title: "Other issue", state: "open" }
    ]
  });

  const changed = await updateBacklogIssueState(tempDir, 5, "closed");
  const backlog = await readExistingBacklog(backlogPath);

  assert.equal(changed, true);
  assert.equal(backlog.issues.find((issue) => issue.number === 5)?.state, "closed");
  assert.equal(backlog.issues.find((issue) => issue.number === 6)?.state, "open");
});

test("closeRemoteIssue patches the issue state and updates the backlog", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "close-remote-issue-test-"));
  const gitDir = path.join(tempDir, ".git");
  const backlogPath = path.join(tempDir, "backlog", "issues.json");
  const originalFetch = global.fetch;
  let requestInfo = null;

  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, "config"), `[remote "origin"]
  url = https://github.com/acme/repo.git
`, "utf8");
  await writeJsonFile(backlogPath, {
    repository: "acme/repo",
    issueCount: 1,
    issues: [{ number: 88, title: "Closable issue", state: "open" }]
  });

  global.fetch = async (url, init) => {
    requestInfo = {
      url: String(url),
      method: init?.method,
      authorization: init?.headers?.Authorization,
      contentType: init?.headers?.["Content-Type"],
      body: init?.body
    };

    return {
      ok: true,
      status: 200,
      json: async () => ({
        number: 88,
        title: "Closable issue",
        html_url: "https://github.com/acme/repo/issues/88",
        state: "closed"
      })
    };
  };

  try {
    const closedIssue = await closeRemoteIssue(tempDir, {
      issueNumber: 88,
      remote: "origin",
      token: "secret-token"
    });
    const backlog = await readExistingBacklog(backlogPath);

    assert.deepEqual(requestInfo, {
      url: "https://api.github.com/repos/acme/repo/issues/88",
      method: "PATCH",
      authorization: "Bearer secret-token",
      contentType: "application/json",
      body: JSON.stringify({ state: "closed" })
    });
    assert.deepEqual(closedIssue, {
      number: 88,
      state: "closed",
      title: "Closable issue",
      htmlUrl: "https://github.com/acme/repo/issues/88"
    });
    assert.equal(backlog.issues[0].state, "closed");
  } finally {
    global.fetch = originalFetch;
  }
});

test("syncIssues requires a token before calling the repository API", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-token-test-"));
  const gitDir = path.join(tempDir, ".git");

  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, "config"), `[remote "origin"]
  url = https://github.com/acme/repo.git
`, "utf8");

  await assert.rejects(
    syncIssues(tempDir, {
      remote: "origin",
      token: null
    }),
    /requires a GitHub token/
  );
});

test("syncIssues can use lookup.tsv when explicit token is absent", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "sync-lookup-test-"));
  const gitDir = path.join(tempDir, ".git");
  const lookupPath = path.join(tempDir, "lookup.tsv");
  const originalFetch = global.fetch;
  let authHeader = null;

  await fs.mkdir(gitDir, { recursive: true });
  await fs.writeFile(path.join(gitDir, "config"), `[remote "origin"]
  url = https://github.com/acme/repo.git
`, "utf8");
  await fs.writeFile(lookupPath, "https://github.com/acme/repo.git\tlookup-secret\n", "utf8");

  global.fetch = async (_url, init) => {
    authHeader = init?.headers?.Authorization;
    return {
      ok: true,
      status: 200,
      json: async () => []
    };
  };

  try {
    const result = await syncIssues(tempDir, {
      remote: "origin",
      token: null,
      lookupPath
    });

    assert.equal(authHeader, "Bearer lookup-secret");
    assert.equal(result.issueCount, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test("fetchOpenIssues reuses unchanged issues from existing backlog", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "fetch-issues-cache-test-"));
  const existingIssue = {
    number: 11,
    title: "Cached issue",
    description: "backlog/images/11/01-screenshot.png",
    state: "open",
    htmlUrl: "https://github.com/acme/repo/issues/11",
    createdAt: "2026-04-10T10:00:00Z",
    updatedAt: "2026-04-11T10:00:00Z",
    author: "octocat",
    labels: ["bug"]
  };
  const originalFetch = global.fetch;
  let imageDownloadAttempted = false;

  global.fetch = async (url) => {
    if (String(url).includes("/repos/acme/repo/issues")) {
      return {
        ok: true,
        status: 200,
        json: async () => ([{
          number: 11,
          title: "Updated title from API that should be ignored when unchanged",
          body: "![image](https://example.com/assets/issue-11.png)",
          state: "open",
          html_url: "https://github.com/acme/repo/issues/11",
          created_at: "2026-04-10T10:00:00Z",
          updated_at: "2026-04-11T10:00:00Z",
          user: { login: "octocat" },
          labels: [{ name: "bug" }]
        }])
      };
    }

    imageDownloadAttempted = true;
    throw new Error(`Unexpected image download: ${url}`);
  };

  try {
    const issues = await fetchOpenIssues(
      {
        apiBaseUrl: "https://api.github.com",
        owner: "acme",
        repo: "repo"
      },
      "token-value",
      tempDir,
      { issues: [existingIssue] }
    );

    assert.deepEqual(issues, [existingIssue]);
    assert.equal(imageDownloadAttempted, false);
  } finally {
    global.fetch = originalFetch;
  }
});
