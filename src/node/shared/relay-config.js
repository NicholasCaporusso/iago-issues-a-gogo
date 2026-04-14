import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const DEFAULT_RELAY_PORT = 4317;
const RELAY_CONFIG_FILE_NAME = "relay-config.json";
const WORKSPACE_MARKERS = ["package.json", "AGENT.md"];

function getModuleDir() {
  return path.dirname(fileURLToPath(import.meta.url));
}

async function findWorkspaceRoot(startDir = process.cwd()) {
  const rootsToTry = [startDir, getModuleDir()];

  for (const root of rootsToTry) {
    let currentDir = path.resolve(root);

    while (true) {
      if (await isWorkspaceRoot(currentDir)) {
        return currentDir;
      }

      const parentDir = path.dirname(currentDir);
      if (parentDir === currentDir) {
        break;
      }

      currentDir = parentDir;
    }
  }

  throw new Error(`Could not find the workspace root starting from ${startDir}.`);
}

async function isWorkspaceRoot(dir) {
  try {
    await Promise.all(WORKSPACE_MARKERS.map((marker) => fs.access(path.join(dir, marker))));
    return true;
  } catch {
    return false;
  }
}

async function readRelayConfig(startDir = process.cwd()) {
  const workspaceRoot = await findWorkspaceRoot(startDir);
  const configPath = path.join(workspaceRoot, RELAY_CONFIG_FILE_NAME);

  try {
    const contents = await fs.readFile(configPath, "utf8");
    const config = JSON.parse(contents);
    return {
      configPath,
      relayPort: parseRelayPort(config.relayPort ?? config.port ?? DEFAULT_RELAY_PORT)
    };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {
        configPath,
        relayPort: DEFAULT_RELAY_PORT
      };
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Failed to parse ${configPath}: ${error.message}`);
    }

    throw error;
  }
}

async function writeRelayConfig(nextConfig, startDir = process.cwd()) {
  const workspaceRoot = await findWorkspaceRoot(startDir);
  const configPath = path.join(workspaceRoot, RELAY_CONFIG_FILE_NAME);
  const relayPort = parseRelayPort(nextConfig.relayPort);
  const contents = `${JSON.stringify({ relayPort }, null, 2)}\n`;
  await fs.writeFile(configPath, contents, "utf8");
  return {
    configPath,
    relayPort
  };
}

async function setRelayPort(relayPort, startDir = process.cwd()) {
  return writeRelayConfig({ relayPort }, startDir);
}

function parseRelayPort(value) {
  const relayPort = Number.parseInt(String(value), 10);

  if (!Number.isInteger(relayPort) || relayPort < 1 || relayPort > 65535) {
    throw new Error(`Invalid relay port: ${value}`);
  }

  return relayPort;
}

function relayUrlForPort(relayPort) {
  return `http://127.0.0.1:${parseRelayPort(relayPort)}`;
}

export {
  DEFAULT_RELAY_PORT,
  findWorkspaceRoot,
  parseRelayPort,
  readRelayConfig,
  relayUrlForPort,
  setRelayPort,
  writeRelayConfig
};
