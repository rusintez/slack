/**
 * Polling-based trigger system for Slack
 *
 * Watches channels for new messages and fires callbacks.
 * Fetch-process-fetch model: fetches a batch, processes each message
 * in order, then fetches the next batch. No unbounded queue.
 *
 * Persists watermark to disk so the bot can resume after restart
 * without losing track of where it left off.
 *
 * Usage:
 *   const trigger = createTrigger({ token, channels: ['#general'] })
 *   trigger.on('message', async (msg, ctx) => {
 *     await ctx.reply('Got it!')
 *   })
 *   await trigger.start()
 *   // later: trigger.stop()
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  getMessages,
  postMessage,
  addReaction,
  getThreadReplies,
  authTest,
  type SlackMessage,
} from "./api.js";
import { resolveChannel } from "./resolve.js";

// ============================================================================
// Types
// ============================================================================

export interface TriggerMessage {
  ts: string;
  text: string;
  user?: string;
  channel: string;
  thread_ts?: string;
  reply_count?: number;
  bot_id?: string;
  subtype?: string;
}

export interface TriggerContext {
  /** Send a reply in the same channel (threaded if message was in a thread) */
  reply: (text: string) => Promise<{ ts: string; channel: string }>;
  /** Send a message to the channel (top-level) */
  send: (text: string) => Promise<{ ts: string; channel: string }>;
  /** React to the triggering message */
  react: (emoji: string) => Promise<void>;
  /** Get the full thread if this message is part of one */
  thread: () => Promise<SlackMessage[]>;
  /** The bot's own user ID */
  botUserId: string;
  /** The token in use */
  token: string;
}

export type MessageHandler = (
  message: TriggerMessage,
  ctx: TriggerContext,
) => Promise<void> | void;

export type ErrorHandler = (error: Error, message?: TriggerMessage) => void;

export interface TriggerOptions {
  /** Slack bot token */
  token: string;
  /** Channels to watch (names or IDs) */
  channels: string[];
  /** Poll interval in ms (default: 2000) */
  interval?: number;
  /** Workspace name for resolve cache and watermark persistence */
  workspace?: string;
  /** Ignore messages from bots including self (default: true) */
  ignoreBots?: boolean;
  /** Ignore message subtypes like channel_join, etc. (default: true) */
  ignoreSubtypes?: boolean;
  /** Only trigger on messages that mention the bot (default: false) */
  mentionsOnly?: boolean;
}

export interface Trigger {
  /** Register a message handler */
  on: (event: "message", handler: MessageHandler) => Trigger;
  /** Register an error handler */
  onError: (handler: ErrorHandler) => Trigger;
  /** Start polling */
  start: () => Promise<void>;
  /** Stop polling */
  stop: () => void;
  /** Whether the trigger is currently running */
  readonly running: boolean;
}

// ============================================================================
// Watermark persistence
// ============================================================================

interface WatermarkState {
  /** channel ID → last processed message ts */
  channels: Record<string, string>;
}

function getWatermarkDir(): string {
  return join(homedir(), ".local", "share", "slack");
}

function getWatermarkFile(workspace: string): string {
  const dir = join(getWatermarkDir(), workspace);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return join(dir, ".trigger-watermark.json");
}

function loadWatermark(workspace: string): WatermarkState {
  const file = getWatermarkFile(workspace);
  if (!existsSync(file)) return { channels: {} };
  try {
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return { channels: {} };
  }
}

function saveWatermark(workspace: string, state: WatermarkState): void {
  writeFileSync(getWatermarkFile(workspace), JSON.stringify(state, null, 2));
}

// ============================================================================
// Trigger
// ============================================================================

export function createTrigger(options: TriggerOptions): Trigger {
  const {
    token,
    channels,
    interval = 2000,
    workspace,
    ignoreBots = true,
    ignoreSubtypes = true,
    mentionsOnly = false,
  } = options;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let botUserId: string | undefined;

  // channel ID → last processed ts
  const watermarks = new Map<string, string>();
  const channelIds: string[] = [];
  const handlers: MessageHandler[] = [];
  let errorHandler: ErrorHandler = (err) =>
    console.error("[slack-trigger]", err.message);

  // Workspace name for persistence (falls back to "default")
  const wsName = workspace || "default";

  function persistWatermarks() {
    const state: WatermarkState = { channels: {} };
    for (const [id, ts] of watermarks) {
      state.channels[id] = ts;
    }
    saveWatermark(wsName, state);
  }

  function buildContext(
    message: TriggerMessage,
    channelId: string,
  ): TriggerContext {
    const threadTs = message.thread_ts || message.ts;
    return {
      botUserId: botUserId!,
      token,
      reply: (text: string) =>
        postMessage(token, channelId, text, { thread_ts: threadTs }),
      send: (text: string) => postMessage(token, channelId, text),
      react: (emoji: string) =>
        addReaction(token, channelId, message.ts, emoji),
      thread: async () => {
        const { messages } = await getThreadReplies(
          token,
          channelId,
          threadTs,
        );
        return messages;
      },
    };
  }

  function shouldProcess(msg: SlackMessage): boolean {
    if (ignoreBots && (msg.bot_id || msg.user === botUserId)) return false;
    if (ignoreSubtypes && msg.subtype) return false;
    if (mentionsOnly && botUserId && !msg.text.includes(`<@${botUserId}>`))
      return false;
    return true;
  }

  /**
   * Core loop: fetch one batch per channel, process each message
   * in chronological order, advance watermark after each message.
   * Returns true if any messages were processed (caller should
   * fetch again immediately instead of sleeping).
   */
  async function tick(): Promise<boolean> {
    let processed = false;

    for (const channelId of channelIds) {
      const oldest = watermarks.get(channelId)!;

      let batch: SlackMessage[];
      try {
        const res = await getMessages(token, channelId, {
          oldest,
          limit: 100,
        });
        batch = res.messages;
      } catch (err) {
        errorHandler(
          err instanceof Error ? err : new Error(String(err)),
        );
        continue;
      }

      // conversations.history returns newest-first, reverse for chronological
      const newMessages = batch
        .filter((m) => m.ts > oldest)
        .filter(shouldProcess)
        .reverse();

      // Process each message sequentially
      for (const msg of newMessages) {
        const triggerMsg: TriggerMessage = {
          ts: msg.ts,
          text: msg.text,
          user: msg.user,
          channel: channelId,
          thread_ts: msg.thread_ts,
          reply_count: msg.reply_count,
          bot_id: msg.bot_id,
          subtype: msg.subtype,
        };

        const ctx = buildContext(triggerMsg, channelId);

        for (const handler of handlers) {
          try {
            await handler(triggerMsg, ctx);
          } catch (err) {
            errorHandler(
              err instanceof Error ? err : new Error(String(err)),
              triggerMsg,
            );
          }
        }

        // Advance watermark after each message so a crash mid-batch
        // resumes from the last successfully processed message
        watermarks.set(channelId, msg.ts);
        persistWatermarks();
        processed = true;
      }

      // If batch had messages but all were filtered, still advance
      // watermark to the newest ts so we don't re-fetch them
      if (batch.length > 0) {
        const newest = batch[0].ts;
        if (newest > oldest) {
          watermarks.set(channelId, newest);
          persistWatermarks();
        }
      }
    }

    return processed;
  }

  async function loop() {
    while (running) {
      const hadWork = await tick();
      if (!running) break;
      if (!hadWork) {
        // Nothing to process — sleep before next poll
        await new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            timer = null;
            resolve();
          }, interval);
        });
      }
      // Had work — fetch again immediately
    }
  }

  const trigger: Trigger = {
    on(_event: "message", handler: MessageHandler) {
      handlers.push(handler);
      return trigger;
    },

    onError(handler: ErrorHandler) {
      errorHandler = handler;
      return trigger;
    },

    async start() {
      if (running) return;

      // Resolve bot identity
      const auth = await authTest(token);
      botUserId = auth.user_id;

      // Load persisted watermarks (resume after crash)
      const saved = loadWatermark(wsName);
      const nowTs = String(Date.now() / 1000);

      // Resolve channel names → IDs
      for (const ch of channels) {
        const id = await resolveChannel(token, ch, workspace);
        channelIds.push(id);
        // Use saved watermark if available, otherwise start from now
        watermarks.set(id, saved.channels[id] || nowTs);
      }

      running = true;
      loop();
    },

    stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },

    get running() {
      return running;
    },
  };

  return trigger;
}
