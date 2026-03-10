#!/usr/bin/env node
/**
 * slack-cli - Agent-friendly Slack CLI with local sync
 *
 * Usage:
 *   slack config add <name> <token>  # Add workspace
 *   slack sync                       # Sync workspace to local DB
 *   slack channels                   # List channels
 *   slack messages #channel          # Get messages
 *   slack send #channel "message"    # Send message
 */

import { Command, Option } from "@commander-js/extra-typings";
import * as api from "./api.js";
import * as syncLib from "./sync.js";
import type { SlackChannel, SlackUser } from "./api.js";
import {
  addWorkspace,
  getDefaultWorkspaceName,
  getToken,
  getWorkspace,
  listWorkspaces,
  removeWorkspace,
  setDefaultWorkspace,
  updateWorkspaceMetadata,
} from "./config.js";
import {
  formatConversation,
  formatOutput,
  type OutputFormat,
  printError,
} from "./output.js";
import { resolveChannel, resolveUser, getUserName } from "./resolve.js";

const program = new Command()
  .name("slack")
  .description("Agent-friendly Slack CLI with local sync")
  .version("0.1.0")
  .addOption(
    new Option("-w, --workspace <name>", "Workspace to use").env(
      "SLACK_WORKSPACE",
    ),
  )
  .addOption(
    new Option("-f, --format <format>", "Output format")
      .choices(["md", "json", "minimal"] as const)
      .default("md" as const),
  );

// ============================================================================
// Config Commands
// ============================================================================

const configCmd = program
  .command("config")
  .description("Manage workspace configuration");

configCmd
  .command("add")
  .description("Add or update a workspace")
  .argument("<name>", "Workspace name (e.g., mycompany)")
  .argument("<token>", "Slack Bot/User token (xoxb-... or xoxp-...)")
  .action(async (name, token) => {
    try {
      // Validate token by testing it
      const auth = await api.authTest(token);
      addWorkspace(name, token);
      updateWorkspaceMetadata(name, {
        teamId: auth.team_id,
        teamName: auth.team,
      });
      console.log(
        `Added workspace "${name}" (${auth.team}). Run \`slack sync -w ${name}\` to sync.`,
      );
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

configCmd
  .command("remove")
  .description("Remove a workspace")
  .argument("<name>", "Workspace name")
  .action((name) => {
    if (removeWorkspace(name)) {
      console.log(`Removed workspace "${name}"`);
    } else {
      console.error(`Workspace "${name}" not found`);
      process.exit(1);
    }
  });

configCmd
  .command("list")
  .description("List configured workspaces")
  .action((_, cmd) => {
    const { format } = cmd.optsWithGlobals();
    const workspaces = listWorkspaces();
    const defaultName = getDefaultWorkspaceName();

    if (workspaces.length === 0) {
      console.log(
        "No workspaces configured. Run: slack config add <name> <token>",
      );
      return;
    }

    const data = workspaces.map((w) => ({
      name: w.name,
      team: w.teamName || "-",
      default: w.name === defaultName ? "Yes" : "",
      lastSync: w.lastSyncAt || "Never",
    }));

    console.log(formatOutput(data, format as OutputFormat));
  });

configCmd
  .command("default")
  .description("Set default workspace")
  .argument("<name>", "Workspace name")
  .action((name) => {
    if (setDefaultWorkspace(name)) {
      console.log(`Default workspace set to "${name}"`);
    } else {
      const available = listWorkspaces()
        .map((w) => w.name)
        .join(", ");
      console.error(`Workspace "${name}" not found. Available: ${available}`);
      process.exit(1);
    }
  });

// ============================================================================
// Sync Commands
// ============================================================================

program
  .command("sync")
  .description(
    "Sync workspace data to local JSON files (~/.local/share/slack/)",
  )
  .option("--channels", "Sync only channels")
  .option("--users", "Sync only users")
  .option("--full", "Full sync (remove deleted items)")
  .action(async (opts, cmd) => {
    const { workspace } = cmd.optsWithGlobals();
    const workspaceConfig = getWorkspace(workspace);

    if (!workspaceConfig) {
      console.error(
        "No workspace configured. Run: slack config add <name> <token>",
      );
      process.exit(1);
    }

    const token = workspaceConfig.token;
    const wsName = workspaceConfig.name;

    try {
      const collections: Array<"channels" | "users"> = [];
      if (opts.channels) collections.push("channels");
      if (opts.users) collections.push("users");

      const result = await syncLib.sync(token, wsName, {
        collections: collections.length > 0 ? collections : undefined,
        full: opts.full,
        onProgress: (p) => {
          process.stderr.write(`\r  ${p.collection}: ${p.fetched} synced`);
        },
      });

      process.stderr.write("\n");

      for (const [collection, count] of Object.entries(result.synced)) {
        console.log(`  ${collection}: ${count} synced`);
        const removedCount = result.removed[collection] || 0;
        if (removedCount > 0) {
          console.log(`  ${collection}: ${removedCount} removed`);
        }
      }

      updateWorkspaceMetadata(wsName, {
        lastSyncAt: new Date().toISOString(),
      });

      console.log("Sync complete!");
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show sync status and database stats")
  .action(async (_, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const workspaceConfig = getWorkspace(workspace);

    if (!workspaceConfig) {
      console.error("No workspace configured.");
      process.exit(1);
    }

    try {
      const status = syncLib.getSyncStatus(workspaceConfig.name);

      if (format === "json") {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.log(`Workspace: ${workspaceConfig.name}`);
        console.log(`Data dir: ${status.dataDir}`);
        console.log(`Last sync: ${status.lastSyncAt || "Never"}`);
        for (const [name, info] of Object.entries(status.collections)) {
          console.log(`  ${name}: ${info.count} items`);
        }
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// Identity Commands
// ============================================================================

program
  .command("me")
  .description("Show current user info")
  .action(async (_, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    try {
      const token = getToken(workspace);
      const auth = await api.authTest(token);
      console.log(formatOutput(auth, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("team")
  .description("Show team/workspace info")
  .action(async (_, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    try {
      const token = getToken(workspace);
      const team = await api.getTeamInfo(token);
      console.log(formatOutput(team, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// Channel Commands
// ============================================================================

program
  .command("channels")
  .description("List channels")
  .option("--all", "Include archived channels")
  .option("--private", "Include private channels")
  .option("--local", "Use local database (requires sync)")
  .action(async (opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const wsConfig = getWorkspace(workspace);

    try {
      let channels: Array<{
        id: string;
        name: string;
        is_private?: boolean;
        is_archived?: boolean;
        num_members?: number;
      }>;

      if (opts.local && wsConfig) {
        channels = syncLib.readAllResources<SlackChannel>(
          wsConfig.name,
          "channels",
        );
      } else {
        const token = getToken(workspace);
        const types = opts.private
          ? "public_channel,private_channel"
          : "public_channel";
        channels = await api.fetchAllChannels(token, types);

        if (!opts.all) {
          channels = channels.filter((c) => !c.is_archived);
        }
      }

      const data = channels.map((c) => ({
        id: c.id,
        name: c.name,
        private: "is_private" in c ? c.is_private : false,
        members: "num_members" in c ? c.num_members : 0,
      }));

      console.log(formatOutput(data, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("channel")
  .description("Get channel info")
  .argument("<channel>", "Channel name or ID (#general or C1234)")
  .action(async (channelArg, _, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);
      const channel = await api.getChannel(token, channelId);
      console.log(formatOutput(channel, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("join")
  .description("Join a channel")
  .argument("<channel>", "Channel name or ID")
  .action(async (channelArg, _, cmd) => {
    const { workspace } = cmd.optsWithGlobals();
    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);
      const channel = await api.joinChannel(token, channelId);
      console.log(`Joined #${channel.name}`);
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("leave")
  .description("Leave a channel")
  .argument("<channel>", "Channel name or ID")
  .action(async (channelArg, _, cmd) => {
    const { workspace } = cmd.optsWithGlobals();
    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);
      await api.leaveChannel(token, channelId);
      console.log(`Left channel`);
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// User Commands
// ============================================================================

program
  .command("users")
  .description("List users")
  .option("--bots", "Include bots")
  .option("--local", "Use local database (requires sync)")
  .action(async (opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const wsConfig = getWorkspace(workspace);

    try {
      let users: Array<{
        id: string;
        name: string;
        real_name?: string | null;
        is_bot?: boolean;
        deleted?: boolean;
        email?: string | null;
        profile?: { email?: string };
      }>;

      if (opts.local && wsConfig) {
        users = syncLib.readAllResources<SlackUser>(wsConfig.name, "users");
      } else {
        const token = getToken(workspace);
        users = await api.fetchAllUsers(token);
      }

      if (!opts.bots) {
        users = users.filter((u) => !u.is_bot);
      }

      const data = users
        .filter((u) => !u.deleted)
        .map((u) => ({
          id: u.id,
          name: u.name,
          real_name: u.real_name,
          email: u.email || u.profile?.email,
        }));

      console.log(formatOutput(data, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("user")
  .description("Get user info")
  .argument("<user>", "Username or ID (@john, john, or U1234)")
  .action(async (userArg, _, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    try {
      const token = getToken(workspace);
      const userId = await resolveUser(token, userArg, workspace);
      const user = await api.getUser(token, userId);
      console.log(formatOutput(user, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// Message Commands
// ============================================================================

program
  .command("messages")
  .description("Get messages from a channel")
  .argument("<channel>", "Channel name or ID")
  .option("-n, --limit <n>", "Number of messages", "20")
  .option("--local", "Use local database (requires sync)")
  .action(async (channelArg, opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const wsConfig = getWorkspace(workspace);

    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);
      const limit = parseInt(opts.limit);

      let messages: Array<{
        ts: string;
        text: string;
        user?: string | null;
        user_id?: string | null;
        reply_count?: number;
      }>;

      if (opts.local) {
        // Local message sync not supported in flat JSON mode — fall through to API
        const res = await api.getMessages(token, channelId, { limit });
        messages = res.messages;
      } else {
        const res = await api.getMessages(token, channelId, { limit });
        messages = res.messages;
      }

      // Enrich with user names
      const enriched = await Promise.all(
        messages.map(async (m) => {
          const userId = m.user || m.user_id || null;
          const userName = userId
            ? await getUserName(token, userId, workspace).catch(() => userId)
            : "bot";
          return {
            ts: m.ts,
            user: userName,
            text: m.text,
            replies: m.reply_count || 0,
          };
        }),
      );

      if (format === "md") {
        console.log(
          formatConversation(
            enriched.map((m) => ({ ...m, user_name: m.user as string })),
          ),
        );
      } else {
        console.log(formatOutput(enriched, format as OutputFormat));
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("thread")
  .description("Get thread replies")
  .argument("<channel>", "Channel name or ID")
  .argument("<ts>", "Thread timestamp")
  .action(async (channelArg, ts, _, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();

    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);
      const { messages } = await api.getThreadReplies(token, channelId, ts);

      // Enrich with user names
      const enriched = await Promise.all(
        messages.map(async (m) => {
          const userName = m.user
            ? await getUserName(token, m.user, workspace).catch(() => m.user)
            : "bot";
          return {
            ts: m.ts,
            user: userName,
            text: m.text,
          };
        }),
      );

      if (format === "md") {
        console.log(
          formatConversation(
            enriched.map((m) => ({ ...m, user_name: m.user as string })),
          ),
        );
      } else {
        console.log(formatOutput(enriched, format as OutputFormat));
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// Inbox Commands
// ============================================================================

program
  .command("inbox")
  .description("Check DMs, mentions, and recent activity")
  .option("--dms", "Show only DMs")
  .option("--mentions", "Show only mentions")
  .option("-n, --limit <n>", "Number of items", "10")
  .action(async (opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();

    try {
      const token = getToken(workspace);
      const auth = await api.authTest(token);
      const limit = parseInt(opts.limit);
      const showAll = !opts.dms && !opts.mentions;

      const results: Array<{
        type: string;
        channel: string;
        from: string;
        text: string;
        ts: string;
      }> = [];

      // Check DMs
      if (showAll || opts.dms) {
        try {
          const ims = await api.slack<{
            channels: Array<{ id: string; user: string }>;
          }>(token, "conversations.list", { types: "im", limit: 20 });

          for (const im of ims.channels || []) {
            try {
              const hist = await api.slack<{
                messages: Array<{ ts: string; text: string; user?: string }>;
              }>(token, "conversations.history", { channel: im.id, limit: 5 });
              const msgs =
                hist.messages?.filter(
                  (m) => m.user && m.user !== auth.user_id,
                ) || [];
              for (const m of msgs.slice(0, 3)) {
                results.push({
                  type: "dm",
                  channel: `@${im.user}`,
                  from: m.user || "unknown",
                  text: m.text?.slice(0, 100) || "",
                  ts: m.ts,
                });
              }
            } catch {
              // No access
            }
          }
        } catch {
          if (format === "md")
            console.log("_Cannot access DMs (missing im:history scope)_\n");
        }
      }

      // Check mentions
      if (showAll || opts.mentions) {
        try {
          const search = await api.slack<{
            messages: {
              matches: Array<{
                ts: string;
                text: string;
                channel: { id: string; name: string };
                user: string;
                permalink: string;
              }>;
            };
          }>(token, "search.messages", {
            query: `<@${auth.user_id}>`,
            count: limit,
            sort: "timestamp",
          });

          for (const m of search.messages?.matches || []) {
            results.push({
              type: "mention",
              channel: `#${m.channel.name}`,
              from: m.user,
              text: m.text?.slice(0, 100) || "",
              ts: m.ts,
            });
          }
        } catch {
          if (format === "md")
            console.log(
              "_Cannot search mentions (missing search:read scope)_\n",
            );
        }
      }

      if (results.length === 0) {
        console.log("No new messages or mentions");
        return;
      }

      // Sort by timestamp descending
      results.sort((a, b) => parseFloat(b.ts) - parseFloat(a.ts));

      const output = results.slice(0, limit).map((r) => ({
        type: r.type,
        channel: r.channel,
        from: r.from,
        text: r.text,
        time: new Date(parseFloat(r.ts) * 1000).toLocaleString(),
      }));

      console.log(formatOutput(output, format as OutputFormat));
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// Search Commands
// ============================================================================

program
  .command("search")
  .description("Search messages")
  .argument("<query>", "Search query")
  .option("-n, --limit <n>", "Number of results", "20")
  .option("--local", "Search local database (requires sync)")
  .option("-c, --channel <channel>", "Filter by channel")
  .action(async (query, opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();
    const wsConfig = getWorkspace(workspace);

    try {
      if (opts.local) {
        // Local search not supported in flat JSON mode — fall through to API
        console.error(
          "Local search is not available. Using API search instead.",
        );
      }

      {
        const token = getToken(workspace);
        const { messages, total } = await api.searchMessages(token, query, {
          count: parseInt(opts.limit),
        });

        const data = messages.map((m) => ({
          channel: `#${m.channel.name}`,
          ts: m.ts,
          user: m.user,
          text: m.text.slice(0, 100),
          link: m.permalink,
        }));

        if (format === "md") {
          console.log(`Found ${total} results:\n`);
        }
        console.log(formatOutput(data, format as OutputFormat));
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// Send Commands
// ============================================================================

program
  .command("send")
  .description("Send a message to a channel")
  .argument("<channel>", "Channel name or ID")
  .argument("<text>", "Message text")
  .option("-t, --thread <ts>", "Reply to thread")
  .action(async (channelArg, text, opts, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();

    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);

      const result = await api.postMessage(token, channelId, text, {
        thread_ts: opts.thread,
      });

      if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Message sent (ts: ${result.ts})`);
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("reply")
  .description("Reply to a thread")
  .argument("<channel>", "Channel name or ID")
  .argument("<thread>", "Thread timestamp to reply to")
  .argument("<text>", "Reply text")
  .action(async (channelArg, thread, text, _, cmd) => {
    const { workspace, format } = cmd.optsWithGlobals();

    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);

      const result = await api.postMessage(token, channelId, text, {
        thread_ts: thread,
      });

      if (format === "json") {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Reply sent (ts: ${result.ts})`);
      }
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("react")
  .description("Add a reaction to a message")
  .argument("<channel>", "Channel name or ID")
  .argument("<ts>", "Message timestamp")
  .argument("<emoji>", "Emoji name (e.g., thumbsup or :thumbsup:)")
  .action(async (channelArg, ts, emoji, _, cmd) => {
    const { workspace } = cmd.optsWithGlobals();

    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);

      await api.addReaction(token, channelId, ts, emoji);
      console.log(`Reaction :${emoji.replace(/:/g, "")}: added`);
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("unreact")
  .description("Remove a reaction from a message")
  .argument("<channel>", "Channel name or ID")
  .argument("<ts>", "Message timestamp")
  .argument("<emoji>", "Emoji name")
  .action(async (channelArg, ts, emoji, _, cmd) => {
    const { workspace } = cmd.optsWithGlobals();

    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);

      await api.removeReaction(token, channelId, ts, emoji);
      console.log(`Reaction :${emoji.replace(/:/g, "")}: removed`);
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// ============================================================================
// Edit/Delete Commands
// ============================================================================

program
  .command("edit")
  .description("Edit a message")
  .argument("<channel>", "Channel name or ID")
  .argument("<ts>", "Message timestamp")
  .argument("<text>", "New message text")
  .action(async (channelArg, ts, text, _, cmd) => {
    const { workspace } = cmd.optsWithGlobals();

    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);

      await api.updateMessage(token, channelId, ts, text);
      console.log("Message updated");
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

program
  .command("delete")
  .description("Delete a message")
  .argument("<channel>", "Channel name or ID")
  .argument("<ts>", "Message timestamp")
  .action(async (channelArg, ts, _, cmd) => {
    const { workspace } = cmd.optsWithGlobals();

    try {
      const token = getToken(workspace);
      const channelId = await resolveChannel(token, channelArg, workspace);

      await api.deleteMessage(token, channelId, ts);
      console.log("Message deleted");
    } catch (err) {
      printError(err);
      process.exit(1);
    }
  });

// Parse and run
program.parse();
