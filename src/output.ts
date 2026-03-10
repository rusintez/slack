/**
 * Output formatting for slack-cli
 * Supports markdown (default), JSON, and minimal formats
 */

export type OutputFormat = "md" | "json" | "minimal";

/**
 * Format data for output based on format type
 */
export function formatOutput(
  data: unknown,
  format: OutputFormat = "md",
): string {
  if (format === "json") {
    return JSON.stringify(data, null, 2);
  }

  if (format === "minimal") {
    return formatMinimal(data);
  }

  return formatMarkdown(data);
}

/**
 * Minimal format: tab-separated, one item per line
 * Good for shell scripts and piping
 */
function formatMinimal(data: unknown): string {
  if (Array.isArray(data)) {
    return data.map((item) => formatMinimalItem(item)).join("\n");
  }
  return formatMinimalItem(data);
}

function formatMinimalItem(item: unknown): string {
  if (item === null || item === undefined) return "";
  if (typeof item !== "object") return String(item);

  const obj = item as Record<string, unknown>;

  // Prioritize certain keys for output
  const priorityKeys = ["id", "name", "ts", "text", "channel", "user"];
  const values: string[] = [];

  for (const key of priorityKeys) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) {
      values.push(String(obj[key]));
    }
  }

  // If no priority keys found, use all values
  if (values.length === 0) {
    return Object.values(obj)
      .filter((v) => v !== null && v !== undefined)
      .map(String)
      .join("\t");
  }

  return values.join("\t");
}

/**
 * Markdown format: tables for arrays, key-value for objects
 * Optimized for readability by both humans and LLMs
 */
function formatMarkdown(data: unknown): string {
  if (Array.isArray(data)) {
    if (data.length === 0) return "_No results_";
    return formatTableMarkdown(data);
  }

  if (data !== null && typeof data === "object") {
    return formatObjectMarkdown(data as Record<string, unknown>);
  }

  return String(data);
}

/**
 * Format array as markdown table
 */
function formatTableMarkdown(items: unknown[]): string {
  if (items.length === 0) return "_No results_";

  // Get all keys from first few items to determine columns
  const allKeys = new Set<string>();
  for (const item of items.slice(0, 5)) {
    if (item && typeof item === "object") {
      for (const k of Object.keys(item as object)) {
        allKeys.add(k);
      }
    }
  }

  // Preferred column order
  const preferredOrder = [
    "id",
    "ts",
    "name",
    "title",
    "text",
    "channel",
    "channel_name",
    "user",
    "user_name",
    "real_name",
    "display_name",
    "email",
    "is_private",
    "is_member",
    "is_archived",
    "num_members",
    "reply_count",
    "created_at",
    "updated_at",
  ];

  // Sort columns: preferred first, then alphabetical
  const columns = Array.from(allKeys).sort((a, b) => {
    const aIdx = preferredOrder.indexOf(a);
    const bIdx = preferredOrder.indexOf(b);
    if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
    if (aIdx >= 0) return -1;
    if (bIdx >= 0) return 1;
    return a.localeCompare(b);
  });

  // Limit columns for readability (max 8)
  const displayColumns = columns.slice(0, 8);

  // Build header
  const header = `| ${displayColumns.join(" | ")} |`;
  const separator = `| ${displayColumns.map(() => "---").join(" | ")} |`;

  // Build rows
  const rows = items.map((item) => {
    const obj = (item || {}) as Record<string, unknown>;
    const values = displayColumns.map((col) => formatCellValue(obj[col]));
    return `| ${values.join(" | ")} |`;
  });

  return [header, separator, ...rows].join("\n");
}

/**
 * Format a cell value for table display
 */
function formatCellValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (value instanceof Date) {
    return value.toLocaleString();
  }

  // Handle Slack timestamps (e.g., "1234567890.123456")
  if (typeof value === "string" && /^\d{10}\.\d{6}$/.test(value)) {
    const date = new Date(parseFloat(value) * 1000);
    return date.toLocaleString();
  }

  // Truncate long strings
  const str = String(value);
  if (str.length > 60) {
    return str.slice(0, 57) + "...";
  }

  // Escape pipe characters for markdown tables
  return str.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * Format object as key-value pairs
 */
function formatObjectMarkdown(obj: Record<string, unknown>): string {
  const lines: string[] = [];

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) continue;

    const label = formatLabel(key);
    const formattedValue = formatValue(value);

    lines.push(`**${label}:** ${formattedValue}`);
  }

  return lines.join("\n");
}

/**
 * Format a key as a readable label
 */
function formatLabel(key: string): string {
  return key
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Format a value for display
 */
function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";

  if (value instanceof Date) {
    return value.toLocaleString();
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "_none_";
    if (typeof value[0] === "string") {
      return value.join(", ");
    }
    return `(${value.length} items)`;
  }

  if (typeof value === "object") {
    return JSON.stringify(value);
  }

  return String(value);
}

/**
 * Format a message for display
 */
export function formatMessage(msg: {
  ts: string;
  text: string;
  user?: string;
  user_name?: string;
  channel_name?: string;
  reply_count?: number;
}): string {
  const date = new Date(parseFloat(msg.ts) * 1000);
  const time = date.toLocaleString();
  const user = msg.user_name || msg.user || "unknown";
  const channel = msg.channel_name ? `#${msg.channel_name}` : "";
  const replies = msg.reply_count ? ` (${msg.reply_count} replies)` : "";

  return `**${user}** ${channel} _${time}_${replies}\n${msg.text}`;
}

/**
 * Format messages as a conversation thread
 */
export function formatConversation(
  messages: Array<{
    ts: string;
    text: string;
    user?: string;
    user_name?: string;
    reply_count?: number;
  }>,
): string {
  return messages.map(formatMessage).join("\n\n---\n\n");
}

/**
 * Print an error to stderr
 */
export function printError(err: unknown): void {
  if (err instanceof Error) {
    console.error(`Error: ${err.message}`);
  } else {
    console.error(`Error: ${String(err)}`);
  }
}
