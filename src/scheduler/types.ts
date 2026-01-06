import { z } from "zod";

/**
 * Regex for interval format: 5s, 10m, 2h (sub-daily only)
 */
export const INTERVAL_REGEX = /^(\d+)(s|m|h)$/;

/**
 * Regex to detect cron expressions (5 or 6 space-separated fields)
 */
export const CRON_REGEX = /^[\d*\/,-]+(\s+[\d*\/,-]+){4,5}$/;

/**
 * Zod schema for schedule configuration in .agentuse files
 *
 * Supports:
 *   schedule: "5m"           # interval
 *   schedule: "0 9 * * *"    # cron
 *   schedule: "daily at 9am" # natural language
 */
export const ScheduleConfigSchema = z.string().min(1, "Schedule value is required");

export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;

/**
 * Runtime schedule state managed by Scheduler
 */
export interface Schedule {
  id: string;
  agentPath: string;
  expression: string; // Normalized cron expression
  timezone: string;
  enabled: boolean;
  source: "yaml";

  // Runtime state
  nextRun: Date | null;
  lastRun?: Date;
  lastResult?: {
    success: boolean;
    duration: number;
    error?: string;
    sessionId?: string;
  };

  createdAt: Date;
}
