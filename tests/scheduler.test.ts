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
  describe("parseScheduleExpression with cron (auto-detected)", () => {
    it("passes through cron expression directly", () => {
      const result = parseScheduleExpression("0 9 * * *");
      expect(result).toBe("0 9 * * *");
    });

    it("handles complex cron expressions", () => {
      const result = parseScheduleExpression("*/15 9-17 * * 1-5");
      expect(result).toBe("*/15 9-17 * * 1-5");
    });

    it("handles 6-field cron with seconds", () => {
      const result = parseScheduleExpression("*/30 * * * * *");
      expect(result).toBe("*/30 * * * * *");
    });
  });

  describe("parseScheduleExpression with interval (auto-detected)", () => {
    it("converts seconds interval", () => {
      const result = parseScheduleExpression("5s");
      expect(result).toBe("*/5 * * * * *");
    });

    it("converts minutes interval", () => {
      const result = parseScheduleExpression("10m");
      expect(result).toBe("*/10 * * * *");
    });

    it("converts hours interval", () => {
      const result = parseScheduleExpression("2h");
      expect(result).toBe("0 */2 * * *");
    });

    it("handles edge case: 1 second", () => {
      const result = parseScheduleExpression("1s");
      expect(result).toBe("*/1 * * * * *");
    });

    it("handles edge case: 59 seconds", () => {
      const result = parseScheduleExpression("59s");
      expect(result).toBe("*/59 * * * * *");
    });

    it("handles edge case: 59 minutes", () => {
      const result = parseScheduleExpression("59m");
      expect(result).toBe("*/59 * * * *");
    });

    it("handles edge case: 23 hours", () => {
      const result = parseScheduleExpression("23h");
      expect(result).toBe("0 */23 * * *");
    });

    it("throws error for 60 seconds", () => {
      expect(() => parseScheduleExpression("60s")).toThrow("Seconds interval must be less than 60");
    });

    it("throws error for 60 minutes", () => {
      expect(() => parseScheduleExpression("60m")).toThrow("Minutes interval must be less than 60");
    });

    it("throws error for 24 hours", () => {
      expect(() => parseScheduleExpression("24h")).toThrow("Hours interval must be less than 24");
    });

    it("treats days unit as invalid (use cron for daily+)", () => {
      expect(() => parseScheduleExpression("1d")).toThrow("Invalid schedule format");
    });
  });

  describe("parseScheduleExpression error handling", () => {
    it("throws error when empty expression provided", () => {
      expect(() => parseScheduleExpression("")).toThrow("Schedule expression cannot be empty");
    });

    it("throws error when whitespace-only expression provided", () => {
      expect(() => parseScheduleExpression("   ")).toThrow("Schedule expression cannot be empty");
    });

    it("throws error for invalid format", () => {
      expect(() => parseScheduleExpression("hourly")).toThrow("Invalid schedule format");
    });

    it("throws error for unsupported pattern", () => {
      expect(() => parseScheduleExpression("every day")).toThrow("Invalid schedule format");
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
      const schedule = scheduler.add("test.agentuse", "0 9 * * *");

      expect(schedule.id).toBeDefined();
      expect(schedule.agentPath).toBe("test.agentuse");
      expect(schedule.expression).toBe("0 9 * * *");
      expect(schedule.enabled).toBe(true);
      expect(schedule.source).toBe("yaml");
      expect(schedule.createdAt).toBeInstanceOf(Date);
    });

    it("creates schedule with interval", () => {
      const schedule = scheduler.add("test.agentuse", "5m");

      expect(schedule.expression).toBe("*/5 * * * *");
    });

    it("uses system timezone", () => {
      const schedule = scheduler.add("test.agentuse", "0 9 * * *");

      expect(schedule.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    });

    it("sets nextRun for schedules", () => {
      const schedule = scheduler.add("test.agentuse", "0 9 * * *");

      expect(schedule.nextRun).toBeInstanceOf(Date);
    });
  });

  describe("get()", () => {
    it("returns schedule by ID", () => {
      const added = scheduler.add("test.agentuse", "0 9 * * *");
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
      scheduler.add("agent1.agentuse", "0 9 * * *");
      scheduler.add("agent2.agentuse", "0 10 * * *");
      scheduler.add("agent3.agentuse", "0 11 * * *");

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
      scheduler.add("agent1.agentuse", "0 9 * * *");
      scheduler.add("agent2.agentuse", "0 10 * * *");

      expect(scheduler.count).toBe(2);
    });
  });

  describe("trigger()", () => {
    it("executes schedule immediately", async () => {
      const schedule = scheduler.add("test.agentuse", "0 9 * * *");

      await scheduler.trigger(schedule.id);

      expect(mockOnExecute).toHaveBeenCalledTimes(1);
      expect(mockOnExecute).toHaveBeenCalledWith(expect.objectContaining({ agentPath: "test.agentuse" }));
    });

    it("updates lastRun and lastResult on success", async () => {
      const schedule = scheduler.add("test.agentuse", "0 9 * * *");

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
        const schedule = errorScheduler.add("test.agentuse", "0 9 * * *");
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
  });

  describe("shutdown()", () => {
    it("stops all cron jobs", () => {
      scheduler.add("agent1.agentuse", "0 9 * * *");
      scheduler.add("agent2.agentuse", "0 10 * * *");

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
      scheduler.add("test.agentuse", "0 9 * * *");

      const result = scheduler.formatScheduleTable();

      expect(result).toContain("test.agentuse");
      expect(result).toContain("0 9 * * *");
      expect(result).toContain("next:");
    });

    it("formats multiple schedules", () => {
      scheduler.add("agent1.agentuse", "0 9 * * *");
      scheduler.add("agent2.agentuse", "0 10 * * *");

      const result = scheduler.formatScheduleTable();

      expect(result).toContain("agent1.agentuse");
      expect(result).toContain("agent2.agentuse");
      expect(result).toContain("0 9 * * *");
      expect(result).toContain("0 10 * * *");
    });
  });
});
