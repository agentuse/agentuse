/**
 * Goal tracking for benchmark runs
 * Enables measuring efficiency, capability, and resilience
 */

import type { ToolCallTrace } from '../plugin/types.js';
import type { GoalMetrics, TrackedGoal } from './types.js';

export type { GoalMetrics, TrackedGoal };

/**
 * Goal tracker for benchmark runs
 * Tracks goals declared by agents and associates tool calls with them
 */
export class GoalTracker {
  private goals: Map<string, TrackedGoal> = new Map();
  private activeGoalName: string | null = null;
  private goalCounter = 0;

  /**
   * Declare a new goal
   */
  declareGoal(name: string, description?: string): void {
    // If there's an active goal, mark it as abandoned
    if (this.activeGoalName) {
      const activeGoal = this.goals.get(this.activeGoalName);
      if (activeGoal && activeGoal.status === 'active') {
        activeGoal.status = 'abandoned';
        activeGoal.endTime = Date.now();
      }
    }

    const id = `goal_${++this.goalCounter}`;
    const goal: TrackedGoal = {
      id,
      name,
      ...(description !== undefined && { description }),
      startTime: Date.now(),
      status: 'active',
      toolCalls: [],
    };

    this.goals.set(name, goal);
    this.activeGoalName = name;
  }

  /**
   * Complete a goal
   */
  completeGoal(name: string, success: boolean): void {
    const goal = this.goals.get(name);
    if (!goal) {
      // Goal wasn't declared, create it retroactively
      this.declareGoal(name);
      const newGoal = this.goals.get(name)!;
      newGoal.status = success ? 'completed' : 'failed';
      newGoal.endTime = Date.now();
    } else {
      goal.status = success ? 'completed' : 'failed';
      goal.endTime = Date.now();
    }

    // Clear active goal if this was the active one
    if (this.activeGoalName === name) {
      this.activeGoalName = null;
    }
  }

  /**
   * Record a tool call (called after each tool execution)
   */
  recordToolCall(name: string, success: boolean, duration: number): void {
    if (this.activeGoalName) {
      const goal = this.goals.get(this.activeGoalName);
      if (goal && goal.status === 'active') {
        goal.toolCalls.push({ name, success, duration });
      }
    }
  }

  /**
   * Process tool call traces to associate them with goals
   * This is called after the agent run completes
   */
  processTraces(traces: ToolCallTrace[]): void {
    let currentGoalName: string | null = null;

    for (const trace of traces) {
      // Skip LLM traces
      if (trace.type === 'llm') continue;

      // Check for goal declaration/completion
      if (trace.name === 'benchmark__declare_goal') {
        const input = trace.input as { name: string; description?: string } | undefined;
        if (input?.name) {
          currentGoalName = input.name;
          // Goal should already be declared by the tool execution
        }
      } else if (trace.name === 'benchmark__complete_goal') {
        const input = trace.input as { name: string; success: boolean } | undefined;
        if (input?.name) {
          currentGoalName = null;
        }
      } else if (currentGoalName) {
        // Associate this tool call with the current goal
        const goal = this.goals.get(currentGoalName);
        if (goal) {
          goal.toolCalls.push({
            name: trace.name,
            success: trace.success ?? true,
            duration: trace.duration,
          });
        }
      }
    }

    // Mark any still-active goals as abandoned
    for (const goal of this.goals.values()) {
      if (goal.status === 'active') {
        goal.status = 'abandoned';
        goal.endTime = Date.now();
      }
    }
  }

  /**
   * Get all tracked goals
   */
  getGoals(): TrackedGoal[] {
    return Array.from(this.goals.values());
  }

  /**
   * Calculate goal metrics
   */
  getMetrics(): GoalMetrics {
    const goals = this.getGoals();

    if (goals.length === 0) {
      return {
        totalGoals: 0,
        completedGoals: 0,
        failedGoals: 0,
        abandonedGoals: 0,
        goalCompletionRate: 0,
        avgAttemptsPerGoal: 0,
        toolCallSuccessRate: 1,
        toolCallFailureRate: 0,
        recoveryRate: 1,
      };
    }

    const completedGoals = goals.filter(g => g.status === 'completed').length;
    const failedGoals = goals.filter(g => g.status === 'failed').length;
    const abandonedGoals = goals.filter(g => g.status === 'abandoned').length;

    // Calculate tool call stats
    const allToolCalls = goals.flatMap(g => g.toolCalls);
    const totalToolCalls = allToolCalls.length;
    const successfulToolCalls = allToolCalls.filter(t => t.success).length;

    // Calculate recovery rate: goals that had failures but still completed
    const goalsWithFailures = goals.filter(g =>
      g.toolCalls.some(t => !t.success)
    );
    const recoveredGoals = goalsWithFailures.filter(g => g.status === 'completed');

    const failedToolCalls = totalToolCalls - successfulToolCalls;

    return {
      totalGoals: goals.length,
      completedGoals,
      failedGoals,
      abandonedGoals,
      goalCompletionRate: completedGoals / goals.length,
      avgAttemptsPerGoal: totalToolCalls / goals.length,
      toolCallSuccessRate: totalToolCalls > 0 ? successfulToolCalls / totalToolCalls : 1,
      toolCallFailureRate: totalToolCalls > 0 ? failedToolCalls / totalToolCalls : 0,
      recoveryRate: goalsWithFailures.length > 0
        ? recoveredGoals.length / goalsWithFailures.length
        : 1, // No failures = perfect recovery
    };
  }

  /**
   * Reset the tracker for a new run
   */
  reset(): void {
    this.goals.clear();
    this.activeGoalName = null;
    this.goalCounter = 0;
  }
}
