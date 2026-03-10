# @rusintez/slack

Agent-friendly Slack CLI with local JSON sync. Markdown I/O by default.

## Setup

```bash
# Add a workspace (use a Slack Bot or User token)
slack config add myworkspace xoxb-your-token-here

# Sync workspace data locally (channels, users, messages)
slack sync
```

## Commands

### Configuration

| Command                           | Description                |
| --------------------------------- | -------------------------- |
| `slack config add <name> <token>` | Add/update a workspace     |
| `slack config remove <name>`      | Remove a workspace         |
| `slack config list`               | List configured workspaces |
| `slack config default <name>`     | Set default workspace      |

### Sync & Status

| Command                 | Description                                        |
| ----------------------- | -------------------------------------------------- |
| `slack sync`            | Sync channels and users to `~/.local/share/slack/` |
| `slack sync --full`     | Full sync (remove deleted items)                   |
| `slack sync --channels` | Sync only channels                                 |
| `slack sync --users`    | Sync only users                                    |
| `slack status`          | Show sync status and file counts                   |

### Reading

| Command                                   | Description          |
| ----------------------------------------- | -------------------- |
| `slack me`                                | Current user info    |
| `slack team`                              | Team/workspace info  |
| `slack channels`                          | List channels        |
| `slack channel #general`                  | Get channel details  |
| `slack users`                             | List users           |
| `slack user @john`                        | Get user details     |
| `slack messages #general [-n 20]`         | Get channel messages |
| `slack thread #general 1234567890.123456` | Get thread replies   |
| `slack search "query"`                    | Search messages      |

### Writing

| Command                                       | Description       |
| --------------------------------------------- | ----------------- |
| `slack send #general "Hello!"`                | Send a message    |
| `slack reply #general 1234.5678 "reply"`      | Reply to a thread |
| `slack react #general 1234.5678 :thumbsup:`   | Add reaction      |
| `slack unreact #general 1234.5678 :thumbsup:` | Remove reaction   |
| `slack edit #general 1234.5678 "new text"`    | Edit a message    |
| `slack delete #general 1234.5678`             | Delete a message  |

## Global Options

| Option                   | Description                                      |
| ------------------------ | ------------------------------------------------ |
| `-w, --workspace <name>` | Use specific workspace                           |
| `-f, --format <format>`  | Output format: `md` (default), `json`, `minimal` |

## Output Formats

- **md** (default): Markdown tables and formatted text - readable by humans and LLMs
- **json**: Structured JSON for programmatic use
- **minimal**: Tab-separated, one item per line - good for shell scripts

## Local Sync

Channels and users are synced to flat JSON files at `~/.local/share/slack/{workspace}/`:

```
~/.local/share/slack/{workspace}/
├── team.json
├── channels/{id}.json
├── users/{id}.json
└── .sync-state.json
```

Use `--local` flag to read from synced files instead of the API:

```bash
slack channels --local
slack users --local
```

## Examples

```bash
# Setup
slack config add work xoxb-123-456-abc
slack sync

# Read recent messages
slack messages #engineering -n 50

# Search across all synced messages
slack search "deploy production" --local

# Send a message
slack send #general "Build complete!"

# Reply to a thread
slack reply #general 1707123456.789012 "Thanks for the update"

# Get JSON output for scripting
slack channels -f json | jq '.[] | select(.private == true)'
```

## Human-Friendly Inputs

The CLI accepts human-readable names instead of IDs:

- Channels: `#general`, `general`, or `C1234567890`
- Users: `@john`, `john`, `john@example.com`, or `U1234567890`
- Special: `me` resolves to the current user

## Environment Variables

| Variable          | Description                      |
| ----------------- | -------------------------------- |
| `SLACK_TOKEN`     | Default token (overrides config) |
| `SLACK_BOT_TOKEN` | Alternative token variable       |
| `SLACK_WORKSPACE` | Default workspace name           |

## Getting a Slack Token

1. Go to https://api.slack.com/apps
2. Create a new app or select existing
3. Add OAuth scopes under "OAuth & Permissions":
   - `channels:read`, `channels:history` - Read public channels
   - `groups:read`, `groups:history` - Read private channels
   - `users:read`, `users:read.email` - Read user info
   - `chat:write` - Send messages
   - `reactions:write` - Add reactions
   - `search:read` - Search messages
4. Install app to workspace
5. Copy the Bot Token (`xoxb-...`) or User Token (`xoxp-...`)
