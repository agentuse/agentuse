import { z } from "zod";

/**
 * Natural language schedule aliases that map to cron expressions
 */
export const SCHEDULE_ALIASES: Record<string, string> = {
  "every minute": "* * * * *",
  "every 5 minutes": "*/5 * * * *",
  "every 10 minutes": "*/10 * * * *",
  "every 15 minutes": "*/15 * * * *",
  "every 30 minutes": "*/30 * * * *",
  "every hour": "0 * * * *",
  "hourly": "0 * * * *",
  "daily": "0 0 * * *",
  "weekly": "0 0 * * 0",
  "monthly": "0 0 1 * *",
};

/**
 * Regex for interval format: 5s, 10m, 2h, 1d
 */
export const INTERVAL_REGEX = /^(\d+)(s|m|h|d)$/;

/**
 * Zod schema for schedule configuration in .agentuse files
 */
export const ScheduleConfigSchema = z
  .object({
    cron: z.string().optional(),
    interval: z.string().regex(INTERVAL_REGEX, "Invalid interval format. Use: 5s, 10m, 2h, 1d").optional(),
    every: z.string().optional(),
    enabled: z.boolean().default(true),
    timezone: z.string().optional(),
  })
  .refine((data) => data.cron || data.interval || data.every, {
    message: "Must specify one of: cron, interval, or every",
  })
  .refine((data) => [data.cron, data.interval, data.every].filter(Boolean).length === 1, {
    message: "Cannot specify multiple schedule types (cron, interval, every)",
  });

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
