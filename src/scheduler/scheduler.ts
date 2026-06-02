import { Cron } from "croner";
import { randomUUID } from "crypto";
import type { Schedule, ScheduleConfig } from "./types";
import { parseScheduleExpression } from "./parser";
import { logger, executionLog } from "../utils/logger";

export interface SchedulerOptions {
  onExecute: (schedule: Schedule) => Promise<{ success: boolean; duration: number; error?: string; sessionId?: string }>;
  scheduleJitterMs?: number;
}

/** JSON-friendly view of a Schedule, as returned by Scheduler.listSerialized(). */
export interface SerializedSchedule {
  id: string;
  projectId: string;
  agentPath: string;
  expression: string;
  /** Human-readable description of the cron expression. */
  human: string;
  timezone: string;
  enabled: boolean;
  jitterMs: number;
  /** ISO timestamp of the next scheduled run, or null when disabled/unknown. */
  nextRun: string | null;
  /** ISO timestamp of the last run, or null if it has never run. */
  lastRun: string | null;
  lastResult?: { success: boolean; duration: number; error?: string; sessionId?: string };
  createdAt: string;
}

/** Sort comparator: soonest next run first, schedules without a next run last. */
function compareByNextRun(a: Schedule, b: Schedule): number {
  if (!a.nextRun) return 1;
  if (!b.nextRun) return -1;
  return a.nextRun.getTime() - b.nextRun.getTime();
}

export const DEFAULT_SCHEDULE_JITTER_MS = 120_000;

function stableHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function parseStep(field: string): number | null {
  if (field === "*") {
    return 1;
  }

  const match = field.match(/^(?:\*|\d+|\d+-\d+)\/(\d+)$/);
  if (!match) {
    return null;
  }

  const step = Number.parseInt(match[1], 10);
  return Number.isFinite(step) && step > 0 ? step : null;
}

function estimateMinimumCadenceMs(expression: string): number | null {
  const fields = expression.trim().split(/\s+/);

  if (fields.length === 6) {
    const secondsStep = parseStep(fields[0]);
    return secondsStep ? secondsStep * 1000 : null;
  }

  if (fields.length === 5) {
    const minuteStep = parseStep(fields[0]);
    return minuteStep ? minuteStep * 60_000 : null;
  }

  return null;
}

function effectiveJitterCapMs(expression: string, maxJitterMs: number): number {
  const configuredCap = Math.max(0, Math.floor(maxJitterMs));
  const cadenceMs = estimateMinimumCadenceMs(expression);
  if (!cadenceMs) {
    return configuredCap;
  }

  return Math.min(configuredCap, Math.floor(cadenceMs / 2));
}

export function calculateScheduleJitterMs(
  projectId: string,
  agentPath: string,
  expression: string,
  maxJitterMs = DEFAULT_SCHEDULE_JITTER_MS
): number {
  const cap = effectiveJitterCapMs(expression, maxJitterMs);
  if (cap <= 0) {
    return 0;
  }

  return stableHash(`${projectId}:${agentPath}:${expression}`) % (cap + 1);
}

function formatDelay(delayMs: number): string {
  if (delayMs < 1000) {
    return `${delayMs}ms`;
  }

  return `${Math.round(delayMs / 1000)}s`;
}

/**
 * In-memory scheduler for running agents on cron schedules
 */
export class Scheduler {
  private schedules: Map<string, Schedule> = new Map();
  private jobs: Map<string, Cron> = new Map();
  private pendingRunTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private onExecute: SchedulerOptions["onExecute"];
  private readonly scheduleJitterMs: number;

  constructor(options: SchedulerOptions) {
    this.onExecute = options.onExecute;
    this.scheduleJitterMs = options.scheduleJitterMs ?? DEFAULT_SCHEDULE_JITTER_MS;
  }

  /**
   * Add a schedule for an agent
   */
  add(projectId: string, agentPath: string, config: ScheduleConfig): Schedule {
    const id = randomUUID();
    const expression = parseScheduleExpression(config);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const jitterMs = calculateScheduleJitterMs(projectId, agentPath, expression, this.scheduleJitterMs);

    const schedule: Schedule = {
      id,
      projectId,
      agentPath,
      expression,
      timezone,
      enabled: true,
      source: "yaml",
      jitterMs,
      nextRun: null,
      createdAt: new Date(),
    };

    this.schedules.set(id, schedule);
    this.startJob(schedule);

    return schedule;
  }

  /**
   * Start a cron job for a schedule
   */
  private startJob(schedule: Schedule): void {
    const job = new Cron(
      schedule.expression,
      {
        timezone: schedule.timezone,
      },
      () => {
        this.queueScheduledRun(schedule.id);
      }
    );

    this.jobs.set(schedule.id, job);
    schedule.nextRun = job.nextRun() || null;
  }

  private queueScheduledRun(scheduleId: string): void {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || !schedule.enabled) return;

    if (this.pendingRunTimers.has(scheduleId)) {
      logger.debug(`Scheduler: ${schedule.agentPath} is already queued; skipping duplicate due event`);
      return;
    }

    if (schedule.jitterMs <= 0) {
      void this.runSchedule(schedule.id);
      return;
    }

    logger.info(`Scheduled ${schedule.agentPath} due now; starting in ${formatDelay(schedule.jitterMs)}`);
    const timer = setTimeout(() => {
      this.pendingRunTimers.delete(scheduleId);
      void this.runSchedule(scheduleId);
    }, schedule.jitterMs);
    this.pendingRunTimers.set(scheduleId, timer);
  }

  /**
   * Execute a scheduled agent run
   */
  private async runSchedule(scheduleId: string): Promise<void> {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule || !schedule.enabled) return;

    executionLog.start(schedule.agentPath);

    const startTime = Date.now();

    try {
      const result = await this.onExecute(schedule);

      schedule.lastRun = new Date();
      schedule.lastResult = result;

      // Update next run time
      const job = this.jobs.get(scheduleId);
      schedule.nextRun = job?.nextRun() || null;

      if (result.success) {
        executionLog.complete(schedule.agentPath, result.duration);
      } else {
        executionLog.failed(schedule.agentPath, result.duration, result.error);
      }
    } catch (error) {
      const duration = Date.now() - startTime;
      schedule.lastRun = new Date();
      schedule.lastResult = {
        success: false,
        duration,
        error: (error as Error).message,
      };

      // Update next run time
      const job = this.jobs.get(scheduleId);
      schedule.nextRun = job?.nextRun() || null;

      executionLog.failed(schedule.agentPath, duration, (error as Error).message);
      logger.debug(`Schedule ${scheduleId} failed: ${(error as Error).message}`);
    }
  }

  /**
   * Trigger immediate execution of a schedule
   */
  async trigger(scheduleId: string): Promise<void> {
    await this.runSchedule(scheduleId);
  }

  /**
   * Get a schedule by ID
   */
  get(scheduleId: string): Schedule | undefined {
    return this.schedules.get(scheduleId);
  }

  /**
   * List all schedules
   */
  list(): Schedule[] {
    return Array.from(this.schedules.values());
  }

  /**
   * List schedules as plain JSON-friendly objects, sorted by next run
   * (soonest first, disabled/null last). Includes a human-readable
   * description of the cron expression. Used by the serve `/schedules`
   * endpoint and the `serve schedules` CLI command.
   */
  listSerialized(): SerializedSchedule[] {
    return this.list()
      .sort(compareByNextRun)
      .map((s) => ({
        id: s.id,
        projectId: s.projectId,
        agentPath: s.agentPath,
        expression: s.expression,
        human: this.cronToHuman(s.expression),
        timezone: s.timezone,
        enabled: s.enabled,
        jitterMs: s.jitterMs,
        nextRun: s.nextRun ? s.nextRun.toISOString() : null,
        lastRun: s.lastRun ? s.lastRun.toISOString() : null,
        ...(s.lastResult && { lastResult: s.lastResult }),
        createdAt: s.createdAt.toISOString(),
      }));
  }

  /**
   * Find a schedule by project + agent path
   */
  getByAgentPath(projectId: string, agentPath: string): Schedule | undefined {
    for (const schedule of this.schedules.values()) {
      if (schedule.projectId === projectId && schedule.agentPath === agentPath) {
        return schedule;
      }
    }
    return undefined;
  }

  /**
   * Remove a schedule by project + agent path
   * @returns true if a schedule was removed, false if not found
   */
  removeByAgentPath(projectId: string, agentPath: string): boolean {
    const schedule = this.getByAgentPath(projectId, agentPath);
    if (!schedule) {
      return false;
    }

    // Stop the cron job
    const job = this.jobs.get(schedule.id);
    if (job) {
      job.stop();
      this.jobs.delete(schedule.id);
    }

    const pendingTimer = this.pendingRunTimers.get(schedule.id);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      this.pendingRunTimers.delete(schedule.id);
    }

    // Remove the schedule
    this.schedules.delete(schedule.id);

    logger.debug(`Scheduler: Removed schedule for ${projectId}:${agentPath}`);
    return true;
  }

  /**
   * Update a schedule for an agent (removes old, adds new)
   * @returns The new schedule, or undefined if no schedule config provided
   */
  update(projectId: string, agentPath: string, config: ScheduleConfig | undefined): Schedule | undefined {
    // Always remove existing schedule first
    this.removeByAgentPath(projectId, agentPath);

    // Add new schedule if config provided
    if (config) {
      return this.add(projectId, agentPath, config);
    }

    return undefined;
  }

  /**
   * Get count of enabled schedules
   */
  get count(): number {
    return this.schedules.size;
  }

  /**
   * Stop all jobs (for graceful shutdown)
   */
  shutdown(): void {
    for (const job of this.jobs.values()) {
      job.stop();
    }
    this.jobs.clear();
    for (const timer of this.pendingRunTimers.values()) {
      clearTimeout(timer);
    }
    this.pendingRunTimers.clear();
    logger.debug("Scheduler: All scheduled jobs stopped");
  }

  /**
   * Convert cron expression to human-readable format
   */
  private cronToHuman(expression: string): string {
    const parts = expression.split(" ");
    if (parts.length !== 5) return expression;

    const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

    const dayNames: Record<string, string> = {
      "0": "Sun",
      "1": "Mon",
      "2": "Tue",
      "3": "Wed",
      "4": "Thu",
      "5": "Fri",
      "6": "Sat",
      "7": "Sun",
    };

    const formatTime = (h: string, m: string): string => {
      const hourNum = parseInt(h, 10);
      const minNum = parseInt(m, 10);
      const period = hourNum >= 12 ? "pm" : "am";
      const hour12 = hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
      return minNum === 0 ? `${hour12}${period}` : `${hour12}:${m.padStart(2, "0")}${period}`;
    };

    const formatDays = (dow: string): string => {
      if (dow === "*") return "";
      const days = dow.split(",").map((d) => dayNames[d] || d);
      return days.join(", ");
    };

    // Every N hours pattern: 0 */N * * *
    if (hour.startsWith("*/") && minute === "0" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      const interval = hour.slice(2);
      return `Every ${interval}h`;
    }

    // Daily pattern: M H * * *
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*" && !hour.includes("*") && !minute.includes("*")) {
      return `Daily ${formatTime(hour, minute)}`;
    }

    // Specific days pattern: M H * * D,D
    if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*" && !hour.includes("*") && !minute.includes("*")) {
      const days = formatDays(dayOfWeek);
      return `${days} ${formatTime(hour, minute)}`;
    }

    // Fallback to original expression
    return expression;
  }

  /**
   * Format schedules for display on server startup
   */
  formatScheduleTable(): string {
    const schedules = this.list();
    if (schedules.length === 0) {
      return "";
    }

    // Sort by next run time (soonest first, null/disabled at end)
    schedules.sort(compareByNextRun);

    // Show the project prefix only when more than one project has schedules.
    const uniqueProjects = new Set(schedules.map((s) => s.projectId));
    const showProject = uniqueProjects.size > 1;

    // Pre-calculate human-readable schedules for width calculation
    const schedulesWithHuman = schedules.map((s) => ({
      schedule: s,
      humanSchedule: this.cronToHuman(s.expression),
      jitterStr: s.jitterMs > 0 ? `stagger +${formatDelay(s.jitterMs)}` : "",
      nextRunStr: s.nextRun
        ? s.nextRun.toLocaleString("en-US", {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "N/A",
      agentLabel: showProject ? `${s.projectId}/${s.agentPath}` : s.agentPath,
    }));

    // Calculate column widths for alignment
    const maxNextRunWidth = Math.max(...schedulesWithHuman.map((s) => s.nextRunStr.length));
    const maxAgentWidth = Math.max(...schedulesWithHuman.map((s) => s.agentLabel.length));

    const lines: string[] = [];

    for (const { humanSchedule, jitterStr, nextRunStr, agentLabel } of schedulesWithHuman) {
      const nextRunCol = nextRunStr.padEnd(maxNextRunWidth);
      const agentCol = agentLabel.padEnd(maxAgentWidth);
      const scheduleLabel = jitterStr ? `${humanSchedule} (${jitterStr})` : humanSchedule;

      lines.push(`    ${nextRunCol}  ${agentCol}  ${scheduleLabel}`);
    }

    return lines.join("\n");
  }
}
