import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const distDir = path.join(repoRoot, "dist", "server");
const exePath = path.join(distDir, "issues-relay-server.exe");
const buildId = `${Date.now()}-${process.pid}`;
const seaBlobPath = path.join(os.tmpdir(), `issues-relay-server-sea-${buildId}.blob`);
const seaConfigPath = path.join(os.tmpdir(), `issues-relay-server-sea-${buildId}.json`);
const bootstrapPath = path.join(os.tmpdir(), `issues-relay-server-sea-${buildId}.cjs`);
const postjectCli = require.resolve("postject/dist/cli.js");

await main();

async function main() {
  const tempArtifacts = [seaBlobPath, seaConfigPath, bootstrapPath];

  try {
    await removeDirWithRetry(distDir);
    await fs.mkdir(distDir, { recursive: true });
    await fs.cp(path.join(repoRoot, "src", "node", "server"), path.join(distDir, "src", "node", "server"), {
      errorOnExist: false,
      force: false,
      recursive: true
    });
    await fs.cp(path.join(repoRoot, "src", "node", "shared"), path.join(distDir, "src", "node", "shared"), {
      errorOnExist: false,
      force: false,
      recursive: true
    });
    await fs.writeFile(bootstrapPath, buildSeaBootstrapSource(), "utf8");
    await fs.writeFile(seaConfigPath, JSON.stringify({
      disableExperimentalSEAWarning: true,
      main: bootstrapPath,
      output: seaBlobPath
    }, null, 2), "utf8");

    await runCommand(process.execPath, ["--experimental-sea-config", seaConfigPath], repoRoot);
    await fs.writeFile(exePath, await fs.readFile(process.execPath));
    await runCommand(process.execPath, [
      postjectCli,
      exePath,
      "NODE_SEA_BLOB",
      seaBlobPath,
      "--sentinel-fuse",
      "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2",
      "--overwrite"
    ], repoRoot);

    console.log(`Built Windows executable at ${exePath}`);
  } finally {
    await Promise.all(tempArtifacts.map(async (target) => {
      try {
        await fs.unlink(target);
      } catch (error) {
        if (error?.code !== "ENOENT") {
          throw error;
        }
      }
    }));
  }
}

async function removeDirWithRetry(targetPath, attempts = 5) {
  for (let index = 0; index < attempts; index += 1) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!["EPERM", "EBUSY", "EACCES"].includes(error?.code) || index === attempts - 1) {
        console.warn(`Warning: could not clean ${targetPath}: ${error?.message ?? error}`);
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
}

function buildSeaBootstrapSource() {
  return `'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const serverPath = path.join(path.dirname(process.execPath), 'src', 'node', 'server', 'server.js');
  const module = await import(pathToFileURL(serverPath).href);

  if (typeof module.main !== 'function') {
    throw new Error('The relay server entrypoint did not export main().');
  }

  await module.main();
})().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
`;
}

async function runCommand(command, args, cwd) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "inherit"
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Command failed: ${command} ${args.join(" ")} (exit code ${code})`));
    });
  });
}
