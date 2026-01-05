import { SCHEDULE_ALIASES, INTERVAL_REGEX } from "./types";

/**
 * Convert interval string to cron expression
 * @example "5m" -> every 5 minutes, "1h" -> every hour
 */
function intervalToCron(interval: string): string {
  const match = interval.match(INTERVAL_REGEX);
  if (!match) {
    throw new Error(`Invalid interval format: ${interval}. Expected: 5s, 10m, 2h, 1d`);
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
    case "d":
      return `0 0 */${num} * *`;
    default:
      throw new Error(`Unknown interval unit: ${unit}`);
  }
}

/**
 * Parse natural language schedule expression
 * @example "daily at 9am", "every weekday at 10:30"
 */
function parseNaturalLanguage(expr: string): string {
  const normalized = expr.toLowerCase().trim();

  // Check simple aliases first
  if (SCHEDULE_ALIASES[normalized]) {
    return SCHEDULE_ALIASES[normalized];
  }

  // Parse "daily at HH:MM" or "daily at Ham/Hpm"
  const dailyAtMatch = normalized.match(/^daily at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (dailyAtMatch) {
    let hour = parseInt(dailyAtMatch[1], 10);
    const minute = dailyAtMatch[2] ? parseInt(dailyAtMatch[2], 10) : 0;
    const meridiem = dailyAtMatch[3];

    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    return `${minute} ${hour} * * *`;
  }

  // Parse "every N minutes/hours/days"
  const everyNMatch = normalized.match(/^every (\d+) (second|minute|hour|day)s?$/);
  if (everyNMatch) {
    const num = parseInt(everyNMatch[1], 10);
    const unit = everyNMatch[2];

    switch (unit) {
      case "second":
        return `*/${num} * * * * *`;
      case "minute":
        return `*/${num} * * * *`;
      case "hour":
        return `0 */${num} * * *`;
      case "day":
        return `0 0 */${num} * *`;
    }
  }

  // Parse "every weekday at HH:MM"
  const weekdayAtMatch = normalized.match(/^every weekday at (\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (weekdayAtMatch) {
    let hour = parseInt(weekdayAtMatch[1], 10);
    const minute = weekdayAtMatch[2] ? parseInt(weekdayAtMatch[2], 10) : 0;
    const meridiem = weekdayAtMatch[3];

    if (meridiem === "pm" && hour < 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;

    return `${minute} ${hour} * * 1-5`;
  }

  throw new Error(
    `Cannot parse schedule expression: "${expr}". Use cron format, interval (5m, 1h), or supported patterns like "daily at 9am".`
  );
}

/**
 * Parse schedule config into normalized cron expression
 */
export function parseScheduleExpression(config: {
  cron?: string;
  interval?: string;
  every?: string;
}): string {
  if (config.cron) {
    return config.cron;
  }

  if (config.interval) {
    return intervalToCron(config.interval);
  }

  if (config.every) {
    return parseNaturalLanguage(config.every);
  }

  throw new Error("No schedule expression provided");
}
