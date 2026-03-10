/**
 * Flat JSON sync for Slack workspaces
 * Convention: ~/.local/share/slack/{workspace}/{collection}/{id}.json
 * Follows same pattern as linear, gh-sync, gmail CLIs
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as api from "./api.js";

// Types
interface SyncState {
  lastSyncAt: string | null;
  cursors: Record<string, string | null>;
}

interface SyncProgress {
  collection: string;
  fetched: number;
}

type ProgressCallback = (progress: SyncProgress) => void;

// Collections
const COLLECTIONS = ["channels", "users"] as const;
type Collection = (typeof COLLECTIONS)[number];

// Data directory: ~/.local/share/slack/{workspace}
function getDataDir(workspaceName: string): string {
  return join(homedir(), ".local", "share", "slack", workspaceName);
}

function getStateFile(workspaceName: string): string {
  return join(getDataDir(workspaceName), ".sync-state.json");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

// Sync state management
function loadSyncState(workspaceName: string): SyncState {
  const stateFile = getStateFile(workspaceName);
  if (!existsSync(stateFile)) {
    return { lastSyncAt: null, cursors: {} };
  }
  try {
    return JSON.parse(readFileSync(stateFile, "utf-8"));
  } catch {
    return { lastSyncAt: null, cursors: {} };
  }
}

function saveSyncState(workspaceName: string, state: SyncState): void {
  ensureDir(getDataDir(workspaceName));
  writeFileSync(getStateFile(workspaceName), JSON.stringify(state, null, 2));
}

// Resource I/O
function writeResource(
  workspaceName: string,
  collection: string,
  id: string,
  resource: unknown,
): void {
  const dir = join(getDataDir(workspaceName), collection);
  ensureDir(dir);
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(resource, null, 2));
}

function readResource<T>(
  workspaceName: string,
  collection: string,
  id: string,
): T | null {
  const filePath = join(getDataDir(workspaceName), collection, `${id}.json`);
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf-8")) as T;
  } catch {
    return null;
  }
}

function removeResource(
  workspaceName: string,
  collection: string,
  id: string,
): boolean {
  const filePath = join(getDataDir(workspaceName), collection, `${id}.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
    return true;
  }
  return false;
}

function getExistingIds(
  workspaceName: string,
  collection: string,
): Set<string> {
  const dir = join(getDataDir(workspaceName), collection);
  if (!existsSync(dir)) return new Set();
  try {
    return new Set(
      readdirSync(dir)
        .filter((f) => f.endsWith(".json") && !f.startsWith("."))
        .map((f) => f.replace(".json", "")),
    );
  } catch {
    return new Set();
  }
}

function readAllResources<T>(workspaceName: string, collection: string): T[] {
  const dir = join(getDataDir(workspaceName), collection);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json") && !f.startsWith("."))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), "utf-8")) as T;
        } catch {
          return null;
        }
      })
      .filter((x): x is T => x !== null);
  } catch {
    return [];
  }
}

// Find a resource by a predicate (scan collection)
function findResource<T>(
  workspaceName: string,
  collection: string,
  predicate: (item: T) => boolean,
): T | null {
  const dir = join(getDataDir(workspaceName), collection);
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter(
      (f) => f.endsWith(".json") && !f.startsWith("."),
    );
    for (const f of files) {
      try {
        const item = JSON.parse(readFileSync(join(dir, f), "utf-8")) as T;
        if (predicate(item)) return item;
      } catch {
        continue;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// Sync options
export interface SyncOptions {
  collections?: Collection[];
  full?: boolean;
  onProgress?: ProgressCallback;
}

// Main sync function
export async function sync(
  token: string,
  workspaceName: string,
  options: SyncOptions = {},
): Promise<{
  workspaceName: string;
  synced: Record<string, number>;
  removed: Record<string, number>;
}> {
  const collectionsToSync = options.collections || [...COLLECTIONS];
  const state = loadSyncState(workspaceName);
  const isFullSync = options.full || state.lastSyncAt === null;

  // Write team info
  try {
    const team = await api.getTeamInfo(token);
    ensureDir(getDataDir(workspaceName));
    writeFileSync(
      join(getDataDir(workspaceName), "team.json"),
      JSON.stringify(team, null, 2),
    );
    options.onProgress?.({ collection: "team", fetched: 1 });
  } catch {
    // Non-fatal — some tokens don't have team:read scope
  }

  const synced: Record<string, number> = {};
  const removed: Record<string, number> = {};

  // Sync channels
  if (collectionsToSync.includes("channels")) {
    synced.channels = 0;
    removed.channels = 0;
    const seenIds = new Set<string>();

    const channels = await api.fetchAllChannels(token);
    for (const ch of channels) {
      writeResource(workspaceName, "channels", ch.id, ch);
      seenIds.add(ch.id);
      synced.channels++;
    }
    options.onProgress?.({ collection: "channels", fetched: synced.channels });

    if (isFullSync) {
      const existing = getExistingIds(workspaceName, "channels");
      for (const id of existing) {
        if (!seenIds.has(id)) {
          if (removeResource(workspaceName, "channels", id)) {
            removed.channels++;
          }
        }
      }
    }
  }

  // Sync users
  if (collectionsToSync.includes("users")) {
    synced.users = 0;
    removed.users = 0;
    const seenIds = new Set<string>();

    const users = await api.fetchAllUsers(token);
    for (const u of users) {
      writeResource(workspaceName, "users", u.id, u);
      seenIds.add(u.id);
      synced.users++;
    }
    options.onProgress?.({ collection: "users", fetched: synced.users });

    if (isFullSync) {
      const existing = getExistingIds(workspaceName, "users");
      for (const id of existing) {
        if (!seenIds.has(id)) {
          if (removeResource(workspaceName, "users", id)) {
            removed.users++;
          }
        }
      }
    }
  }

  state.lastSyncAt = new Date().toISOString();
  saveSyncState(workspaceName, state);

  return { workspaceName, synced, removed };
}

// Get sync status
export function getSyncStatus(workspaceName: string): {
  dataDir: string;
  lastSyncAt: string | null;
  collections: Record<string, { count: number }>;
} {
  const dataDir = getDataDir(workspaceName);
  const state = loadSyncState(workspaceName);

  const collections: Record<string, { count: number }> = {};
  for (const collection of COLLECTIONS) {
    const ids = getExistingIds(workspaceName, collection);
    collections[collection] = { count: ids.size };
  }

  return { dataDir, lastSyncAt: state.lastSyncAt, collections };
}

// Reset sync state
export function resetSyncState(workspaceName: string): void {
  const stateFile = getStateFile(workspaceName);
  if (existsSync(stateFile)) {
    unlinkSync(stateFile);
  }
}

// List synced workspaces
export function listSyncedWorkspaces(): string[] {
  const baseDir = join(homedir(), ".local", "share", "slack");
  if (!existsSync(baseDir)) return [];
  try {
    return readdirSync(baseDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

export {
  COLLECTIONS,
  readResource,
  readAllResources,
  findResource,
  getDataDir,
  getExistingIds,
};
export type { Collection };
