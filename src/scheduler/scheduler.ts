import { Cron } from "croner";
import { randomUUID } from "crypto";
import type { Schedule, ScheduleConfig } from "./types";
import { parseScheduleExpression } from "./parser";
import { logger, executionLog } from "../utils/logger";

export interface SchedulerOptions {
  onExecute: (schedule: Schedule) => Promise<{ success: boolean; duration: number; error?: string; sessionId?: string }>;
}

/**
 * In-memory scheduler for running agents on cron schedules
 */
export class Scheduler {
  private schedules: Map<string, Schedule> = new Map();
  private jobs: Map<string, Cron> = new Map();
  private onExecute: SchedulerOptions["onExecute"];

  constructor(options: SchedulerOptions) {
    this.onExecute = options.onExecute;
  }

  /**
   * Add a schedule for an agent
   */
  add(agentPath: string, config: ScheduleConfig): Schedule {
    const id = randomUUID();
    const expression = parseScheduleExpression(config);
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    const schedule: Schedule = {
      id,
      agentPath,
      expression,
      timezone,
      enabled: true,
      source: "yaml",
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
      async () => {
        await this.runSchedule(schedule.id);
      }
    );

    this.jobs.set(schedule.id, job);
    schedule.nextRun = job.nextRun() || null;
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
   * Find a schedule by agent path
   */
  getByAgentPath(agentPath: string): Schedule | undefined {
    for (const schedule of this.schedules.values()) {
      if (schedule.agentPath === agentPath) {
        return schedule;
      }
    }
    return undefined;
  }

  /**
   * Remove a schedule by agent path
   * @returns true if a schedule was removed, false if not found
   */
  removeByAgentPath(agentPath: string): boolean {
    const schedule = this.getByAgentPath(agentPath);
    if (!schedule) {
      return false;
    }

    // Stop the cron job
    const job = this.jobs.get(schedule.id);
    if (job) {
      job.stop();
      this.jobs.delete(schedule.id);
    }

    // Remove the schedule
    this.schedules.delete(schedule.id);

    logger.debug(`Scheduler: Removed schedule for ${agentPath}`);
    return true;
  }

  /**
   * Update a schedule for an agent (removes old, adds new)
   * @returns The new schedule, or undefined if no schedule config provided
   */
  update(agentPath: string, config: ScheduleConfig | undefined): Schedule | undefined {
    // Always remove existing schedule first
    this.removeByAgentPath(agentPath);

    // Add new schedule if config provided
    if (config) {
      return this.add(agentPath, config);
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
    logger.debug("Scheduler: All scheduled jobs stopped");
  }

  /**
   * Format schedules for display on server startup
   */
  formatScheduleTable(): string {
    const schedules = this.list();
    if (schedules.length === 0) {
      return "";
    }

    // Calculate column widths for alignment
    const maxAgentWidth = Math.max(...schedules.map((s) => s.agentPath.length));
    const maxExprWidth = Math.max(...schedules.map((s) => s.expression.length));

    const lines: string[] = [];

    for (const schedule of schedules) {
      const nextRunStr = schedule.nextRun
        ? schedule.nextRun.toLocaleString("en-US", {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })
        : "N/A";

      const agentCol = schedule.agentPath.padEnd(maxAgentWidth);
      const exprCol = schedule.expression.padEnd(maxExprWidth);

      lines.push(`    ${agentCol}  ${exprCol}  next: ${nextRunStr}`);
    }

    return lines.join("\n");
  }
}
