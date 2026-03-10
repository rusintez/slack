/**
 * Polling-based trigger system for Slack
 *
 * Watches channels for new messages and fires callbacks.
 * Processes messages in order, one at a time (queue model).
 *
 * Usage:
 *   const trigger = createTrigger({ token, channels: ['#general'] })
 *   trigger.on('message', async (msg, ctx) => {
 *     await ctx.reply('Got it!')
 *   })
 *   trigger.start()
 *   // later: trigger.stop()
 */

import {
  getMessages,
  postMessage,
  addReaction,
  getThreadReplies,
  authTest,
  type SlackMessage,
} from "./api.js";
import { resolveChannel } from "./resolve.js";

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

export type ErrorHandler = (
  error: Error,
  message?: TriggerMessage,
) => void;

export interface TriggerOptions {
  /** Slack bot token */
  token: string;
  /** Channels to watch (names or IDs) */
  channels: string[];
  /** Poll interval in ms (default: 2000) */
  interval?: number;
  /** Workspace name for resolve cache (optional) */
  workspace?: string;
  /** Ignore messages from bots including self (default: true) */
  ignoreBots?: boolean;
  /** Ignore message subtypes like channel_join, etc. (default: true) */
  ignoreSubtypes?: boolean;
  /** Only trigger on messages that mention the bot (default: false) */
  mentionsOnly?: boolean;
}

interface ChannelState {
  id: string;
  lastTs: string;
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
  const channelStates = new Map<string, ChannelState>();
  const handlers: MessageHandler[] = [];
  let errorHandler: ErrorHandler = (err) => console.error("[slack-trigger]", err.message);

  // Queue: process messages sequentially
  const queue: Array<{ message: TriggerMessage; channelId: string }> = [];
  let processing = false;

  async function processQueue() {
    if (processing) return;
    processing = true;

    while (queue.length > 0) {
      const item = queue.shift()!;
      const ctx = buildContext(item.message, item.channelId);

      for (const handler of handlers) {
        try {
          await handler(item.message, ctx);
        } catch (err) {
          errorHandler(err instanceof Error ? err : new Error(String(err)), item.message);
        }
      }
    }

    processing = false;
  }

  function buildContext(message: TriggerMessage, channelId: string): TriggerContext {
    const threadTs = message.thread_ts || message.ts;

    return {
      botUserId: botUserId!,
      token,
      reply: (text: string) =>
        postMessage(token, channelId, text, { thread_ts: threadTs }),
      send: (text: string) =>
        postMessage(token, channelId, text),
      react: (emoji: string) =>
        addReaction(token, channelId, message.ts, emoji),
      thread: async () => {
        const { messages } = await getThreadReplies(token, channelId, threadTs);
        return messages;
      },
    };
  }

  function shouldProcess(msg: SlackMessage): boolean {
    if (ignoreBots && (msg.bot_id || msg.user === botUserId)) return false;
    if (ignoreSubtypes && msg.subtype) return false;
    if (mentionsOnly && botUserId && !msg.text.includes(`<@${botUserId}>`)) return false;
    return true;
  }

  async function poll() {
    for (const [, state] of channelStates) {
      try {
        const { messages } = await getMessages(token, state.id, {
          oldest: state.lastTs,
          limit: 100,
        });

        // Messages come newest-first, reverse for chronological order
        const newMessages = messages
          .filter((m) => m.ts > state.lastTs)
          .filter(shouldProcess)
          .reverse();

        for (const msg of newMessages) {
          queue.push({
            message: {
              ts: msg.ts,
              text: msg.text,
              user: msg.user,
              channel: state.id,
              thread_ts: msg.thread_ts,
              reply_count: msg.reply_count,
              bot_id: msg.bot_id,
              subtype: msg.subtype,
            },
            channelId: state.id,
          });
        }

        // Advance watermark
        if (messages.length > 0) {
          const latest = messages[0].ts; // newest
          if (latest > state.lastTs) {
            state.lastTs = latest;
          }
        }
      } catch (err) {
        errorHandler(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Kick off processing (non-blocking relative to next poll)
    processQueue();
  }

  function scheduleNext() {
    if (!running) return;
    timer = setTimeout(async () => {
      await poll();
      scheduleNext();
    }, interval);
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

      // Resolve channel names → IDs and set initial watermark to "now"
      const nowTs = String(Date.now() / 1000);
      for (const ch of channels) {
        const id = await resolveChannel(token, ch, workspace);
        channelStates.set(id, { id, lastTs: nowTs });
      }

      running = true;
      // Do first poll immediately
      await poll();
      scheduleNext();
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
