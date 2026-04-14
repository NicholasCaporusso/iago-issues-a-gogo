import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import process from "node:process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(repoRoot, "dist", "release");
const exePath = path.join(distDir, "github-issues-resolver.exe");
const lookupSource = path.join(repoRoot, "server", "lookup.tsv");
const buildId = `${Date.now()}-${process.pid}`;
const seaBlobPath = path.join(os.tmpdir(), `github-issues-resolver-sea-${buildId}.blob`);
const seaConfigPath = path.join(os.tmpdir(), `github-issues-resolver-sea-${buildId}.json`);
const bootstrapPath = path.join(os.tmpdir(), `github-issues-resolver-sea-${buildId}.cjs`);
const postjectCli = require.resolve("postject/dist/cli.js");

await main();

async function main() {
  const tempArtifacts = [seaBlobPath, seaConfigPath, bootstrapPath];

  try {
    await fs.mkdir(distDir, { recursive: true });
    await fs.writeFile(bootstrapPath, buildSeaBootstrapSource(), "utf8");
    await fs.writeFile(seaConfigPath, JSON.stringify({
      assets: {
        "cli.js": path.join(repoRoot, "cli", "cli.js")
      },
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

    if (await pathExists(lookupSource)) {
      await fs.copyFile(lookupSource, path.join(distDir, "lookup.tsv"));
    }

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

function buildSeaBootstrapSource() {
  return `'use strict';

const { getAsset } = require('node:sea');

(async () => {
  const source = getAsset('cli.js', 'utf8');
  const moduleUrl = \`data:text/javascript;base64,\${Buffer.from(source, 'utf8').toString('base64')}\`;
  const module = await import(moduleUrl);

  if (typeof module.main !== 'function') {
    throw new Error('The embedded CLI did not export main().');
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

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}
