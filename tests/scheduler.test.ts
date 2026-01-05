import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { parseScheduleExpression } from "../src/scheduler/parser";
import { Scheduler } from "../src/scheduler/scheduler";
import { logger, executionLog } from "../src/utils/logger";
import type { Schedule } from "../src/scheduler/types";

// Suppress logging during tests
let loggerDebugSpy: ReturnType<typeof spyOn>;
let executionLogStartSpy: ReturnType<typeof spyOn>;
let executionLogCompleteSpy: ReturnType<typeof spyOn>;
let executionLogFailedSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  loggerDebugSpy = spyOn(logger, "debug").mockImplementation(() => {});
  executionLogStartSpy = spyOn(executionLog, "start").mockImplementation(() => {});
  executionLogCompleteSpy = spyOn(executionLog, "complete").mockImplementation(() => {});
  executionLogFailedSpy = spyOn(executionLog, "failed").mockImplementation(() => {});
});

afterEach(() => {
  loggerDebugSpy.mockRestore();
  executionLogStartSpy.mockRestore();
  executionLogCompleteSpy.mockRestore();
  executionLogFailedSpy.mockRestore();
});

describe("Schedule Parser", () => {
  describe("parseScheduleExpression with cron", () => {
    it("passes through cron expression directly", () => {
      const result = parseScheduleExpression({ cron: "0 9 * * *" });
      expect(result).toBe("0 9 * * *");
    });

    it("handles complex cron expressions", () => {
      const result = parseScheduleExpression({ cron: "*/15 9-17 * * 1-5" });
      expect(result).toBe("*/15 9-17 * * 1-5");
    });
  });

  describe("parseScheduleExpression with interval", () => {
    it("converts seconds interval", () => {
      const result = parseScheduleExpression({ interval: "5s" });
      expect(result).toBe("*/5 * * * * *");
    });

    it("converts minutes interval", () => {
      const result = parseScheduleExpression({ interval: "10m" });
      expect(result).toBe("*/10 * * * *");
    });

    it("converts hours interval", () => {
      const result = parseScheduleExpression({ interval: "2h" });
      expect(result).toBe("0 */2 * * *");
    });

    it("converts days interval", () => {
      const result = parseScheduleExpression({ interval: "1d" });
      expect(result).toBe("0 0 */1 * *");
    });

    it("handles edge case: 1 second", () => {
      const result = parseScheduleExpression({ interval: "1s" });
      expect(result).toBe("*/1 * * * * *");
    });

    it("handles edge case: 59 seconds", () => {
      const result = parseScheduleExpression({ interval: "59s" });
      expect(result).toBe("*/59 * * * * *");
    });

    it("handles edge case: 59 minutes", () => {
      const result = parseScheduleExpression({ interval: "59m" });
      expect(result).toBe("*/59 * * * *");
    });

    it("handles edge case: 23 hours", () => {
      const result = parseScheduleExpression({ interval: "23h" });
      expect(result).toBe("0 */23 * * *");
    });

    it("throws error for 60 seconds", () => {
      expect(() => parseScheduleExpression({ interval: "60s" })).toThrow("Seconds interval must be less than 60");
    });

    it("throws error for 60 minutes", () => {
      expect(() => parseScheduleExpression({ interval: "60m" })).toThrow("Minutes interval must be less than 60");
    });

    it("throws error for 24 hours", () => {
      expect(() => parseScheduleExpression({ interval: "24h" })).toThrow("Hours interval must be less than 24");
    });

    it("throws error for invalid format", () => {
      expect(() => parseScheduleExpression({ interval: "5x" })).toThrow("Invalid interval format");
    });
  });

  describe("parseScheduleExpression with natural language (every)", () => {
    describe("aliases", () => {
      it('parses "every minute"', () => {
        const result = parseScheduleExpression({ every: "every minute" });
        expect(result).toBe("* * * * *");
      });

      it('parses "every 5 minutes" alias', () => {
        const result = parseScheduleExpression({ every: "every 5 minutes" });
        expect(result).toBe("*/5 * * * *");
      });

      it('parses "hourly"', () => {
        const result = parseScheduleExpression({ every: "hourly" });
        expect(result).toBe("0 * * * *");
      });

      it('parses "every hour"', () => {
        const result = parseScheduleExpression({ every: "every hour" });
        expect(result).toBe("0 * * * *");
      });

      it('parses "daily"', () => {
        const result = parseScheduleExpression({ every: "daily" });
        expect(result).toBe("0 0 * * *");
      });

      it('parses "weekly"', () => {
        const result = parseScheduleExpression({ every: "weekly" });
        expect(result).toBe("0 0 * * 0");
      });

      it('parses "monthly"', () => {
        const result = parseScheduleExpression({ every: "monthly" });
        expect(result).toBe("0 0 1 * *");
      });
    });

    describe("daily at time", () => {
      it('parses "daily at 9am"', () => {
        const result = parseScheduleExpression({ every: "daily at 9am" });
        expect(result).toBe("0 9 * * *");
      });

      it('parses "daily at 9:30am"', () => {
        const result = parseScheduleExpression({ every: "daily at 9:30am" });
        expect(result).toBe("30 9 * * *");
      });

      it('parses "daily at 9pm"', () => {
        const result = parseScheduleExpression({ every: "daily at 9pm" });
        expect(result).toBe("0 21 * * *");
      });

      it('parses "daily at 12am" (midnight)', () => {
        const result = parseScheduleExpression({ every: "daily at 12am" });
        expect(result).toBe("0 0 * * *");
      });

      it('parses "daily at 12pm" (noon)', () => {
        const result = parseScheduleExpression({ every: "daily at 12pm" });
        expect(result).toBe("0 12 * * *");
      });

      it('parses "daily at 14" (24h format)', () => {
        const result = parseScheduleExpression({ every: "daily at 14" });
        expect(result).toBe("0 14 * * *");
      });

      it('parses "daily at 14:30" (24h format with minutes)', () => {
        const result = parseScheduleExpression({ every: "daily at 14:30" });
        expect(result).toBe("30 14 * * *");
      });
    });

    describe("every N units", () => {
      it('parses "every 5 minutes"', () => {
        const result = parseScheduleExpression({ every: "every 5 minutes" });
        expect(result).toBe("*/5 * * * *");
      });

      it('parses "every 2 hours"', () => {
        const result = parseScheduleExpression({ every: "every 2 hours" });
        expect(result).toBe("0 */2 * * *");
      });

      it('parses "every 3 days"', () => {
        const result = parseScheduleExpression({ every: "every 3 days" });
        expect(result).toBe("0 0 */3 * *");
      });

      it('parses "every 30 seconds"', () => {
        const result = parseScheduleExpression({ every: "every 30 seconds" });
        expect(result).toBe("*/30 * * * * *");
      });

      it('parses singular "every 1 minute"', () => {
        const result = parseScheduleExpression({ every: "every 1 minute" });
        expect(result).toBe("*/1 * * * *");
      });
    });

    describe("every weekday at time", () => {
      it('parses "every weekday at 10:30"', () => {
        const result = parseScheduleExpression({ every: "every weekday at 10:30" });
        expect(result).toBe("30 10 * * 1-5");
      });

      it('parses "every weekday at 9am"', () => {
        const result = parseScheduleExpression({ every: "every weekday at 9am" });
        expect(result).toBe("0 9 * * 1-5");
      });

      it('parses "every weekday at 3pm"', () => {
        const result = parseScheduleExpression({ every: "every weekday at 3pm" });
        expect(result).toBe("0 15 * * 1-5");
      });
    });

    describe("error cases", () => {
      it("throws error for invalid expression", () => {
        expect(() => parseScheduleExpression({ every: "sometimes" })).toThrow("Cannot parse schedule expression");
      });

      it("throws error for unsupported pattern", () => {
        expect(() => parseScheduleExpression({ every: "every other tuesday" })).toThrow(
          "Cannot parse schedule expression"
        );
      });
    });
  });

  describe("parseScheduleExpression error handling", () => {
    it("throws error when no expression provided", () => {
      expect(() => parseScheduleExpression({})).toThrow("No schedule expression provided");
    });
  });
});

describe("Scheduler", () => {
  let scheduler: Scheduler;
  let mockOnExecute: ReturnType<typeof mock>;

  beforeEach(() => {
    mockOnExecute = mock(() =>
      Promise.resolve({
        success: true,
        duration: 100,
        sessionId: "test-session",
      })
    );

    scheduler = new Scheduler({
      onExecute: mockOnExecute,
    });
  });

  afterEach(() => {
    scheduler.shutdown();
  });

  describe("add()", () => {
    it("creates schedule with cron expression", () => {
      const schedule = scheduler.add("test.agentuse", { cron: "0 9 * * *" });

      expect(schedule.id).toBeDefined();
      expect(schedule.agentPath).toBe("test.agentuse");
      expect(schedule.expression).toBe("0 9 * * *");
      expect(schedule.enabled).toBe(true);
      expect(schedule.source).toBe("yaml");
      expect(schedule.createdAt).toBeInstanceOf(Date);
    });

    it("creates schedule with interval", () => {
      const schedule = scheduler.add("test.agentuse", { interval: "5m" });

      expect(schedule.expression).toBe("*/5 * * * *");
    });

    it("creates schedule with natural language", () => {
      const schedule = scheduler.add("test.agentuse", { every: "daily at 9am" });

      expect(schedule.expression).toBe("0 9 * * *");
    });

    it("uses system timezone when not specified", () => {
      const schedule = scheduler.add("test.agentuse", { cron: "0 9 * * *" });

      expect(schedule.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });

    it("uses specified timezone", () => {
      const schedule = scheduler.add("test.agentuse", {
        cron: "0 9 * * *",
        timezone: "America/New_York",
      });

      expect(schedule.timezone).toBe("America/New_York");
    });

    it("respects enabled: false", () => {
      const schedule = scheduler.add("test.agentuse", {
        cron: "0 9 * * *",
        enabled: false,
      });

      expect(schedule.enabled).toBe(false);
    });

    it("sets nextRun for enabled schedules", () => {
      const schedule = scheduler.add("test.agentuse", { cron: "0 9 * * *" });

      // nextRun should be set for enabled schedules
      expect(schedule.nextRun).toBeInstanceOf(Date);
    });

    it("does not set nextRun for disabled schedules", () => {
      const schedule = scheduler.add("test.agentuse", {
        cron: "0 9 * * *",
        enabled: false,
      });

      expect(schedule.nextRun).toBeNull();
    });
  });

  describe("get()", () => {
    it("returns schedule by ID", () => {
      const added = scheduler.add("test.agentuse", { cron: "0 9 * * *" });
      const retrieved = scheduler.get(added.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(added.id);
      expect(retrieved?.agentPath).toBe("test.agentuse");
    });

    it("returns undefined for unknown ID", () => {
      const retrieved = scheduler.get("nonexistent-id");

      expect(retrieved).toBeUndefined();
    });
  });

  describe("list()", () => {
    it("returns empty array when no schedules", () => {
      const schedules = scheduler.list();

      expect(schedules).toEqual([]);
    });

    it("returns all schedules", () => {
      scheduler.add("agent1.agentuse", { cron: "0 9 * * *" });
      scheduler.add("agent2.agentuse", { cron: "0 10 * * *" });
      scheduler.add("agent3.agentuse", { cron: "0 11 * * *" });

      const schedules = scheduler.list();

      expect(schedules).toHaveLength(3);
      expect(schedules.map((s) => s.agentPath)).toEqual(["agent1.agentuse", "agent2.agentuse", "agent3.agentuse"]);
    });
  });

  describe("count", () => {
    it("returns 0 when no schedules", () => {
      expect(scheduler.count).toBe(0);
    });

    it("returns correct count", () => {
      scheduler.add("agent1.agentuse", { cron: "0 9 * * *" });
      scheduler.add("agent2.agentuse", { cron: "0 10 * * *" });

      expect(scheduler.count).toBe(2);
    });
  });

  describe("trigger()", () => {
    it("executes schedule immediately", async () => {
      const schedule = scheduler.add("test.agentuse", { cron: "0 9 * * *" });

      await scheduler.trigger(schedule.id);

      expect(mockOnExecute).toHaveBeenCalledTimes(1);
      expect(mockOnExecute).toHaveBeenCalledWith(expect.objectContaining({ agentPath: "test.agentuse" }));
    });

    it("updates lastRun and lastResult on success", async () => {
      const schedule = scheduler.add("test.agentuse", { cron: "0 9 * * *" });

      await scheduler.trigger(schedule.id);

      const updated = scheduler.get(schedule.id);
      expect(updated?.lastRun).toBeInstanceOf(Date);
      expect(updated?.lastResult).toEqual({
        success: true,
        duration: 100,
        sessionId: "test-session",
      });
    });

    it("handles execution errors gracefully", async () => {
      const errorExecute = mock(() => Promise.reject(new Error("Execution failed")));
      const errorScheduler = new Scheduler({ onExecute: errorExecute });

      try {
        const schedule = errorScheduler.add("test.agentuse", { cron: "0 9 * * *" });
        await errorScheduler.trigger(schedule.id);

        const updated = errorScheduler.get(schedule.id);
        expect(updated?.lastRun).toBeInstanceOf(Date);
        expect(updated?.lastResult?.success).toBe(false);
        expect(updated?.lastResult?.error).toBe("Execution failed");
      } finally {
        errorScheduler.shutdown();
      }
    });

    it("does nothing for nonexistent schedule", async () => {
      await scheduler.trigger("nonexistent-id");

      expect(mockOnExecute).not.toHaveBeenCalled();
    });

    it("does nothing for disabled schedule", async () => {
      const schedule = scheduler.add("test.agentuse", {
        cron: "0 9 * * *",
        enabled: false,
      });

      await scheduler.trigger(schedule.id);

      expect(mockOnExecute).not.toHaveBeenCalled();
    });
  });

  describe("shutdown()", () => {
    it("stops all cron jobs", () => {
      scheduler.add("agent1.agentuse", { cron: "0 9 * * *" });
      scheduler.add("agent2.agentuse", { cron: "0 10 * * *" });

      // Should not throw
      scheduler.shutdown();

      // Calling shutdown again should be safe
      scheduler.shutdown();
    });
  });

  describe("formatScheduleTable()", () => {
    it("returns empty string for no schedules", () => {
      const result = scheduler.formatScheduleTable();

      expect(result).toBe("");
    });

    it("formats single schedule", () => {
      scheduler.add("test.agentuse", { cron: "0 9 * * *" });

      const result = scheduler.formatScheduleTable();

      expect(result).toContain("test.agentuse");
      expect(result).toContain("0 9 * * *");
      expect(result).toContain("next:");
    });

    it("formats multiple schedules", () => {
      scheduler.add("agent1.agentuse", { cron: "0 9 * * *" });
      scheduler.add("agent2.agentuse", { cron: "0 10 * * *" });

      const result = scheduler.formatScheduleTable();

      expect(result).toContain("agent1.agentuse");
      expect(result).toContain("agent2.agentuse");
      expect(result).toContain("0 9 * * *");
      expect(result).toContain("0 10 * * *");
    });
  });
});
