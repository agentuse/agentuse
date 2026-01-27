import cronstrue from "cronstrue";
import { INTERVAL_REGEX, CRON_REGEX } from "./types";

/**
 * Convert interval string to cron expression
 * @example "5m" -> every 5 minutes, "1h" -> every hour
 */
function intervalToCron(interval: string): string {
  const match = interval.match(INTERVAL_REGEX);
  if (!match) {
    throw new Error(`Invalid interval format: ${interval}. Expected: 5s, 10m, 2h`);
  }

  const [, value, unit] = match;
  const num = parseInt(value, 10);

  switch (unit) {
    case "s":
      // Croner supports seconds as 6-field cron
      if (num >= 60) throw new Error("Seconds interval must be less than 60");
      return `*/${num} * * * * *`;
    case "m":
      if (num >= 60) throw new Error("Minutes interval must be less than 60");
      return `*/${num} * * * *`;
    case "h":
      if (num >= 24) throw new Error("Hours interval must be less than 24");
      return `0 */${num} * * *`;
    default:
      throw new Error(`Unknown interval unit: ${unit}`);
  }
}

/**
 * Parse schedule expression into normalized cron expression
 *
 * Supports two formats (auto-detected):
 * - Interval: "5s", "10m", "2h", "1d"
 * - Cron: "0 9 * * *"
 */
export function parseScheduleExpression(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error("Schedule expression cannot be empty");
  }

  // 1. Check if it's an interval format (e.g., "5m", "1h")
  if (INTERVAL_REGEX.test(trimmed)) {
    return intervalToCron(trimmed);
  }

  // 2. Check if it's a cron expression (5 or 6 space-separated fields)
  if (CRON_REGEX.test(trimmed)) {
    return trimmed;
  }

  throw new Error(
    `Invalid schedule format: "${value}". Use interval (e.g., "5m", "2h") or cron (e.g., "0 0 * * *").`
  );
}

/**
 * Format a schedule expression into human-readable text
 * @example "5m" -> "Every 5 minutes", "0 9 * * *" -> "At 09:00 AM"
 */
export function formatScheduleHuman(value: string): string {
  const trimmed = value.trim();

  // Handle interval format
  if (INTERVAL_REGEX.test(trimmed)) {
    const match = trimmed.match(INTERVAL_REGEX);
    if (match) {
      const [, num, unit] = match;
      const n = parseInt(num, 10);
      const unitNames: Record<string, [string, string]> = {
        s: ["second", "seconds"],
        m: ["minute", "minutes"],
        h: ["hour", "hours"],
      };
      const [singular, plural] = unitNames[unit] || [unit, unit];
      return n === 1 ? `Every ${singular}` : `Every ${n} ${plural}`;
    }
  }

  // Handle cron format using cronstrue
  if (CRON_REGEX.test(trimmed)) {
    try {
      return cronstrue.toString(trimmed, { use24HourTimeFormat: false });
    } catch {
      return trimmed;
    }
  }

  return trimmed;
}
