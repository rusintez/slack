# @rusintez/slack

Agent-friendly Slack CLI with local sync. Markdown I/O by default.

## Install

```bash
npm install -g @rusintez/slack
```

Or run directly with npx:

```bash
npx @rusintez/slack --help
```

## Setup

Add your Slack workspace token (get from [Slack App Settings](https://api.slack.com/apps) > OAuth & Permissions):

```bash
slack config add work xoxb-your-bot-token
slack config default work
```

Required OAuth scopes:

- `channels:read`, `channels:history` — read public channels
- `channels:join` — join channels
- `groups:read`, `groups:history` — read private channels
- `users:read`, `users:read.email` — read user info
- `chat:write` — send/edit/delete messages
- `reactions:write` — add/remove reactions
- `search:read` — search messages

Or use env var for one-off commands:

```bash
SLACK_TOKEN=xoxb-xxx slack me
```

## Usage

### Config Management

```bash
slack config list              # List all workspaces
slack config add <name> <key>  # Add/update workspace
slack config remove <name>     # Remove workspace
slack config default <name>    # Set default workspace
```

### Reading

```bash
slack me                       # Current user
slack team                     # Workspace info
slack channels                 # List channels
slack channel #general         # Channel details
slack users                    # List users
slack user @john               # User details
slack messages #general        # Get messages
slack thread #general 1234.56  # Thread replies
slack search "deploy"          # Search messages
slack inbox                    # DMs, mentions, activity
```

### Writing

```bash
slack send #general "Hello!"                    # Send message
slack reply #general 1234.5678 "Thanks!"        # Reply to thread
slack react #general 1234.5678 thumbsup         # Add reaction
slack unreact #general 1234.5678 thumbsup       # Remove reaction
slack edit #general 1234.5678 "Updated text"    # Edit message
slack delete #general 1234.5678                 # Delete message
```

### Sync (Local Cache)

Data syncs to `~/.local/share/slack/{workspace}/` as flat JSON files (one file per entity).

```bash
slack sync                     # Sync channels, users
slack sync --full              # Full sync (remove deleted items)
slack sync --channels          # Sync only channels
slack status                   # Show sync stats
```

### Output Formats

```bash
slack channels                 # Markdown table (default)
slack channels -f json         # JSON
slack channels -f minimal      # Tab-separated, one per line
```

### Multi-workspace

```bash
slack -w work messages #general
slack -w personal channels
```

## Human-Friendly Inputs

The CLI accepts readable names instead of IDs:

- Channels: `#general`, `general`, or `C1234567890`
- Users: `@john`, `john`, `john@example.com`, or `U1234567890`
- Special: `me` resolves to the current user

## Config Location

`~/.config/slack-cli/config.json`

## License

MIT
