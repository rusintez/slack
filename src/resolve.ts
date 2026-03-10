/**
 * Human-friendly name resolution for Slack entities
 * Converts #channel-name, @username, etc. to IDs
 * Uses local JSON cache when available, falls back to API
 */

import * as api from "./api.js";
import { readAllResources, findResource } from "./sync.js";
import type { SlackChannel, SlackUser } from "./api.js";

// In-memory cache for session
const cache: {
  channels: Map<string, string>;
  users: Map<string, string>;
  myUserId?: string;
} = {
  channels: new Map(),
  users: new Map(),
};

/**
 * Resolve a channel name or ID to a channel ID
 * Accepts: #general, general, C1234567890
 */
export async function resolveChannel(
  token: string,
  nameOrId: string,
  workspaceName?: string,
): Promise<string> {
  // Already an ID?
  if (/^C[A-Z0-9]+$/i.test(nameOrId)) {
    return nameOrId;
  }

  const cleanName = nameOrId.replace(/^#/, "").toLowerCase();

  // Check session cache
  if (cache.channels.has(cleanName)) {
    return cache.channels.get(cleanName)!;
  }

  // Try local JSON files first
  if (workspaceName) {
    const channel = findResource<SlackChannel>(
      workspaceName,
      "channels",
      (ch) => ch.name.toLowerCase() === cleanName,
    );
    if (channel) {
      cache.channels.set(cleanName, channel.id);
      return channel.id;
    }
  }

  // Fetch from API
  const channels = await api.fetchAllChannels(token);
  for (const ch of channels) {
    cache.channels.set(ch.name.toLowerCase(), ch.id);
  }

  const id = cache.channels.get(cleanName);
  if (!id) {
    const available = channels
      .slice(0, 10)
      .map((c) => `#${c.name}`)
      .join(", ");
    throw new Error(
      `Channel "${nameOrId}" not found. Available: ${available}${channels.length > 10 ? "..." : ""}`,
    );
  }

  return id;
}

/**
 * Resolve a user name or ID to a user ID
 * Accepts: @john, john, john@example.com, U1234567890, "me"
 */
export async function resolveUser(
  token: string,
  nameOrId: string,
  workspaceName?: string,
): Promise<string> {
  // Already an ID?
  if (/^U[A-Z0-9]+$/i.test(nameOrId)) {
    return nameOrId;
  }

  // Handle "me"
  if (nameOrId.toLowerCase() === "me") {
    if (cache.myUserId) {
      return cache.myUserId;
    }
    const auth = await api.authTest(token);
    cache.myUserId = auth.user_id;
    return auth.user_id;
  }

  const cleanName = nameOrId.replace(/^@/, "").toLowerCase();

  // Check session cache
  if (cache.users.has(cleanName)) {
    return cache.users.get(cleanName)!;
  }

  // Try local JSON files first
  if (workspaceName) {
    const user = findResource<SlackUser>(workspaceName, "users", (u) => {
      if (u.name.toLowerCase() === cleanName) return true;
      if (u.profile?.display_name?.toLowerCase() === cleanName) return true;
      if (u.profile?.email?.toLowerCase() === cleanName) return true;
      return false;
    });
    if (user) {
      cache.users.set(cleanName, user.id);
      return user.id;
    }
  }

  // Fetch from API
  const users = await api.fetchAllUsers(token);
  for (const u of users) {
    cache.users.set(u.name.toLowerCase(), u.id);
    if (u.profile?.display_name) {
      cache.users.set(u.profile.display_name.toLowerCase(), u.id);
    }
    if (u.profile?.email) {
      cache.users.set(u.profile.email.toLowerCase(), u.id);
    }
  }

  const id = cache.users.get(cleanName);
  if (!id) {
    const available = users
      .filter((u) => !u.is_bot && !u.deleted)
      .slice(0, 10)
      .map((u) => `@${u.name}`)
      .join(", ");
    throw new Error(
      `User "${nameOrId}" not found. Available: ${available}${users.length > 10 ? "..." : ""}`,
    );
  }

  return id;
}

/**
 * Resolve multiple channels
 */
export async function resolveChannels(
  token: string,
  names: string[],
  workspaceName?: string,
): Promise<string[]> {
  return Promise.all(names.map((n) => resolveChannel(token, n, workspaceName)));
}

/**
 * Resolve multiple users
 */
export async function resolveUsers(
  token: string,
  names: string[],
  workspaceName?: string,
): Promise<string[]> {
  return Promise.all(names.map((n) => resolveUser(token, n, workspaceName)));
}

/**
 * Get channel name from ID (reverse lookup)
 */
export async function getChannelName(
  token: string,
  channelId: string,
  workspaceName?: string,
): Promise<string> {
  // Check cache (reverse)
  for (const [name, id] of cache.channels.entries()) {
    if (id === channelId) return name;
  }

  // Try local JSON
  if (workspaceName) {
    const channel = findResource<SlackChannel>(
      workspaceName,
      "channels",
      (ch) => ch.id === channelId,
    );
    if (channel) {
      cache.channels.set(channel.name.toLowerCase(), channel.id);
      return channel.name;
    }
  }

  // Fetch from API
  const channel = await api.getChannel(token, channelId);
  cache.channels.set(channel.name.toLowerCase(), channel.id);
  return channel.name;
}

/**
 * Get user display name from ID (reverse lookup)
 */
export async function getUserName(
  token: string,
  userId: string,
  workspaceName?: string,
): Promise<string> {
  // Check cache (reverse)
  for (const [name, id] of cache.users.entries()) {
    if (id === userId) return name;
  }

  // Try local JSON
  if (workspaceName) {
    const user = findResource<SlackUser>(
      workspaceName,
      "users",
      (u) => u.id === userId,
    );
    if (user) {
      const displayName =
        user.profile?.display_name || user.real_name || user.name;
      cache.users.set(user.name.toLowerCase(), user.id);
      return displayName;
    }
  }

  // Fetch from API
  const user = await api.getUser(token, userId);
  const displayName = user.profile?.display_name || user.real_name || user.name;
  cache.users.set(user.name.toLowerCase(), user.id);
  return displayName;
}

/**
 * Clear the resolution cache
 */
export function clearCache(): void {
  cache.channels.clear();
  cache.users.clear();
  cache.myUserId = undefined;
}
