/**
 * Slack Web API client
 * Thin wrapper around fetch with typed responses
 */

const BASE_URL = "https://slack.com/api";

export interface SlackResponse<T = unknown> {
  ok: boolean;
  error?: string;
  response_metadata?: {
    next_cursor?: string;
  };
  [key: string]: unknown;
}

export interface SlackUser {
  id: string;
  name: string;
  real_name?: string;
  profile?: {
    display_name?: string;
    email?: string;
    image_48?: string;
  };
  is_bot?: boolean;
  is_admin?: boolean;
  is_owner?: boolean;
  deleted?: boolean;
}

export interface SlackChannel {
  id: string;
  name: string;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  topic?: { value: string };
  purpose?: { value: string };
  num_members?: number;
  created?: number;
}

export interface SlackMessage {
  ts: string;
  user?: string;
  text: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: Array<{ name: string; count: number; users: string[] }>;
  attachments?: unknown[];
  edited?: { ts: string };
  bot_id?: string;
  subtype?: string;
}

export interface SlackTeam {
  id: string;
  name: string;
  domain: string;
  icon?: { image_68?: string };
}

export class SlackApiError extends Error {
  constructor(
    public method: string,
    public slackError: string,
    message?: string
  ) {
    super(message || `Slack API error in ${method}: ${slackError}`);
    this.name = "SlackApiError";
  }
}

/**
 * Make a Slack API request
 */
export async function slack<T = unknown>(
  token: string,
  method: string,
  params: Record<string, unknown> = {}
): Promise<SlackResponse<T> & T> {
  const url = new URL(`${BASE_URL}/${method}`);

  // For GET requests with simple params, use query string
  // For POST requests or complex data, use JSON body
  const isGetMethod = ["auth.test", "users.list", "conversations.list"].some(
    (m) => method.startsWith(m.split(".")[0])
  );

  const hasComplexParams = Object.values(params).some(
    (v) => typeof v === "object" || (typeof v === "string" && v.length > 100)
  );

  let response: Response;

  if (isGetMethod && !hasComplexParams) {
    // GET with query params
    Object.entries(params).forEach(([k, v]) => {
      if (v !== undefined && v !== null) {
        url.searchParams.set(k, String(v));
      }
    });

    response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });
  } else {
    // POST with JSON body
    response = await fetch(url.toString(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(params),
    });
  }

  const data = (await response.json()) as SlackResponse<T> & T;

  if (!data.ok) {
    throw new SlackApiError(method, data.error || "unknown_error");
  }

  return data;
}

// ============================================================================
// Auth & Identity
// ============================================================================

export async function authTest(
  token: string
): Promise<{ user_id: string; user: string; team_id: string; team: string }> {
  const res = await slack<{
    user_id: string;
    user: string;
    team_id: string;
    team: string;
  }>(token, "auth.test");
  return res;
}

// ============================================================================
// Users
// ============================================================================

export async function listUsers(
  token: string,
  cursor?: string
): Promise<{ users: SlackUser[]; next_cursor?: string }> {
  const res = await slack<{ members: SlackUser[] }>(token, "users.list", {
    limit: 200,
    cursor,
  });
  return {
    users: res.members,
    next_cursor: res.response_metadata?.next_cursor,
  };
}

export async function getUser(token: string, userId: string): Promise<SlackUser> {
  const res = await slack<{ user: SlackUser }>(token, "users.info", {
    user: userId,
  });
  return res.user;
}

/**
 * Fetch all users with pagination
 */
export async function fetchAllUsers(token: string): Promise<SlackUser[]> {
  const allUsers: SlackUser[] = [];
  let cursor: string | undefined;

  do {
    const { users, next_cursor } = await listUsers(token, cursor);
    allUsers.push(...users);
    cursor = next_cursor;
  } while (cursor);

  return allUsers;
}

// ============================================================================
// Channels / Conversations
// ============================================================================

export async function listChannels(
  token: string,
  options: {
    types?: string;
    exclude_archived?: boolean;
    cursor?: string;
  } = {}
): Promise<{ channels: SlackChannel[]; next_cursor?: string }> {
  const res = await slack<{ channels: SlackChannel[] }>(
    token,
    "conversations.list",
    {
      types: options.types || "public_channel,private_channel",
      exclude_archived: options.exclude_archived ?? true,
      limit: 200,
      cursor: options.cursor,
    }
  );
  return {
    channels: res.channels,
    next_cursor: res.response_metadata?.next_cursor,
  };
}

export async function getChannel(
  token: string,
  channelId: string
): Promise<SlackChannel> {
  const res = await slack<{ channel: SlackChannel }>(
    token,
    "conversations.info",
    { channel: channelId }
  );
  return res.channel;
}

export async function joinChannel(
  token: string,
  channelId: string
): Promise<SlackChannel> {
  const res = await slack<{ channel: SlackChannel }>(
    token,
    "conversations.join",
    { channel: channelId }
  );
  return res.channel;
}

export async function leaveChannel(
  token: string,
  channelId: string
): Promise<void> {
  await slack(token, "conversations.leave", { channel: channelId });
}

/**
 * Fetch all channels with pagination
 */
export async function fetchAllChannels(
  token: string,
  types?: string
): Promise<SlackChannel[]> {
  const allChannels: SlackChannel[] = [];
  let cursor: string | undefined;

  do {
    const { channels, next_cursor } = await listChannels(token, {
      types,
      cursor,
    });
    allChannels.push(...channels);
    cursor = next_cursor;
  } while (cursor);

  return allChannels;
}

// ============================================================================
// Messages
// ============================================================================

export async function getMessages(
  token: string,
  channel: string,
  options: { limit?: number; oldest?: string; latest?: string; cursor?: string } = {}
): Promise<{ messages: SlackMessage[]; next_cursor?: string; has_more?: boolean }> {
  const res = await slack<{ messages: SlackMessage[]; has_more?: boolean }>(
    token,
    "conversations.history",
    {
      channel,
      limit: options.limit || 100,
      oldest: options.oldest,
      latest: options.latest,
      cursor: options.cursor,
    }
  );
  return {
    messages: res.messages,
    next_cursor: res.response_metadata?.next_cursor,
    has_more: res.has_more,
  };
}

export async function getThreadReplies(
  token: string,
  channel: string,
  threadTs: string,
  options: { limit?: number; cursor?: string } = {}
): Promise<{ messages: SlackMessage[]; next_cursor?: string }> {
  const res = await slack<{ messages: SlackMessage[] }>(
    token,
    "conversations.replies",
    {
      channel,
      ts: threadTs,
      limit: options.limit || 100,
      cursor: options.cursor,
    }
  );
  return {
    messages: res.messages,
    next_cursor: res.response_metadata?.next_cursor,
  };
}

// ============================================================================
// Posting Messages
// ============================================================================

export async function postMessage(
  token: string,
  channel: string,
  text: string,
  options: { thread_ts?: string; unfurl_links?: boolean } = {}
): Promise<{ ts: string; channel: string }> {
  const res = await slack<{ ts: string; channel: string }>(
    token,
    "chat.postMessage",
    {
      channel,
      text,
      ...options,
    }
  );
  return { ts: res.ts, channel: res.channel };
}

export async function updateMessage(
  token: string,
  channel: string,
  ts: string,
  text: string
): Promise<{ ts: string }> {
  const res = await slack<{ ts: string }>(token, "chat.update", {
    channel,
    ts,
    text,
  });
  return { ts: res.ts };
}

export async function deleteMessage(
  token: string,
  channel: string,
  ts: string
): Promise<void> {
  await slack(token, "chat.delete", { channel, ts });
}

// ============================================================================
// Reactions
// ============================================================================

export async function addReaction(
  token: string,
  channel: string,
  ts: string,
  emoji: string
): Promise<void> {
  await slack(token, "reactions.add", {
    channel,
    timestamp: ts,
    name: emoji.replace(/^:|:$/g, ""),
  });
}

export async function removeReaction(
  token: string,
  channel: string,
  ts: string,
  emoji: string
): Promise<void> {
  await slack(token, "reactions.remove", {
    channel,
    timestamp: ts,
    name: emoji.replace(/^:|:$/g, ""),
  });
}

// ============================================================================
// Search
// ============================================================================

export async function searchMessages(
  token: string,
  query: string,
  options: { count?: number; sort?: "score" | "timestamp" } = {}
): Promise<{
  messages: Array<{
    channel: { id: string; name: string };
    ts: string;
    text: string;
    user: string;
    permalink: string;
  }>;
  total: number;
}> {
  const res = await slack<{
    messages: {
      matches: Array<{
        channel: { id: string; name: string };
        ts: string;
        text: string;
        user: string;
        permalink: string;
      }>;
      total: number;
    };
  }>(token, "search.messages", {
    query,
    count: options.count || 20,
    sort: options.sort || "timestamp",
  });
  return {
    messages: res.messages.matches,
    total: res.messages.total,
  };
}

// ============================================================================
// Team Info
// ============================================================================

export async function getTeamInfo(token: string): Promise<SlackTeam> {
  const res = await slack<{ team: SlackTeam }>(token, "team.info");
  return res.team;
}
