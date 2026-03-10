/**
 * Configuration management for slack-cli
 * Handles workspace tokens and settings
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface Workspace {
  name: string;
  token: string;
  teamId?: string;
  teamName?: string;
  addedAt: string;
  lastSyncAt?: string;
}

export interface Config {
  workspaces: Workspace[];
  defaultWorkspace?: string;
}

const CONFIG_DIR = join(homedir(), ".config", "slack-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

export function getConfigDir(): string {
  return CONFIG_DIR;
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

export function loadConfig(): Config {
  ensureConfigDir();
  if (!existsSync(CONFIG_FILE)) {
    return { workspaces: [] };
  }
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(raw) as Config;
  } catch {
    return { workspaces: [] };
  }
}

export function saveConfig(config: Config): void {
  ensureConfigDir();
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function addWorkspace(name: string, token: string): void {
  const config = loadConfig();
  const existing = config.workspaces.findIndex((w) => w.name === name);

  const workspace: Workspace = {
    name,
    token,
    addedAt: new Date().toISOString(),
  };

  if (existing >= 0) {
    config.workspaces[existing] = {
      ...config.workspaces[existing],
      ...workspace,
    };
  } else {
    config.workspaces.push(workspace);
  }

  // Set as default if it's the first workspace
  if (config.workspaces.length === 1) {
    config.defaultWorkspace = name;
  }

  saveConfig(config);
}

export function removeWorkspace(name: string): boolean {
  const config = loadConfig();
  const index = config.workspaces.findIndex((w) => w.name === name);

  if (index < 0) return false;

  config.workspaces.splice(index, 1);

  if (config.defaultWorkspace === name) {
    config.defaultWorkspace = config.workspaces[0]?.name;
  }

  saveConfig(config);
  return true;
}

export function setDefaultWorkspace(name: string): boolean {
  const config = loadConfig();
  const workspace = config.workspaces.find((w) => w.name === name);

  if (!workspace) return false;

  config.defaultWorkspace = name;
  saveConfig(config);
  return true;
}

export function getWorkspace(name?: string): Workspace | undefined {
  const config = loadConfig();
  const workspaceName = name || config.defaultWorkspace;

  if (!workspaceName) return undefined;

  return config.workspaces.find((w) => w.name === workspaceName);
}

export function getToken(workspaceName?: string): string {
  // Check environment variable first
  const envToken = process.env.SLACK_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (envToken) return envToken;

  const workspace = getWorkspace(workspaceName);
  if (!workspace) {
    const config = loadConfig();
    const available = config.workspaces.map((w) => w.name).join(", ");
    if (available) {
      throw new Error(
        `Workspace "${workspaceName}" not found. Available: ${available}`,
      );
    }
    throw new Error(
      "No workspace configured. Run: slack config add <name> <token>",
    );
  }

  return workspace.token;
}

export function updateWorkspaceMetadata(
  name: string,
  metadata: Partial<Pick<Workspace, "teamId" | "teamName" | "lastSyncAt">>,
): void {
  const config = loadConfig();
  const workspace = config.workspaces.find((w) => w.name === name);

  if (workspace) {
    Object.assign(workspace, metadata);
    saveConfig(config);
  }
}

export function listWorkspaces(): Workspace[] {
  return loadConfig().workspaces;
}

export function getDefaultWorkspaceName(): string | undefined {
  return loadConfig().defaultWorkspace;
}
