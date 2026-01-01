/**
 * Goal tracking tools for benchmark runs
 * These tools are auto-injected during benchmarks to enable explicit goal tracking
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import type { GoalTracker } from './goal-tracker.js';

/**
 * Create goal tracking tools bound to a GoalTracker instance
 */
export function createGoalTools(tracker: GoalTracker): Record<string, Tool> {
  return {
    benchmark__declare_goal: {
      description: `Declare a new goal or sub-task you're working on. Use this when starting work on a distinct objective.
This helps benchmark your problem-solving approach by tracking:
- How many goals you set
- How many tool calls you make per goal
- Whether you recover from failures

Example: declare_goal({ name: "Find database schema", description: "Locate and understand the database structure" })`,
      inputSchema: z.object({
        name: z.string().describe('A short, descriptive name for this goal'),
        description: z.string().optional().describe('Optional longer description of what you\'re trying to accomplish'),
      }),
      execute: async ({ name, description }: { name: string; description?: string }): Promise<string> => {
        tracker.declareGoal(name, description);
        return JSON.stringify({
          success: true,
          message: `Goal "${name}" declared. Tool calls will now be tracked against this goal.`,
        });
      },
    },

    benchmark__complete_goal: {
      description: `Mark a goal as completed or failed. Use this when you've finished working on a goal, whether successfully or not.

Example successful: complete_goal({ name: "Find database schema", success: true })
Example failed: complete_goal({ name: "Find database schema", success: false })`,
      inputSchema: z.object({
        name: z.string().describe('The name of the goal to complete (must match a declared goal)'),
        success: z.boolean().describe('Whether the goal was achieved successfully'),
      }),
      execute: async ({ name, success }: { name: string; success: boolean }): Promise<string> => {
        tracker.completeGoal(name, success);
        return JSON.stringify({
          success: true,
          message: `Goal "${name}" marked as ${success ? 'completed' : 'failed'}.`,
        });
      },
    },
  };
}

/**
 * System prompt addition for goal tracking
 */
export const GOAL_TRACKING_PROMPT = `
## Goal Tracking (Benchmark Mode) - REQUIRED

**IMPORTANT: You MUST use goal tracking tools for this benchmark.**

Before making ANY tool calls to accomplish the task, you MUST first call:
- **benchmark__declare_goal**: Declare what you're about to work on

When you finish a goal (successfully or not), you MUST call:
- **benchmark__complete_goal**: Mark the goal as done

**This is mandatory.** Your first action after reading the task should be to declare a goal.

Example workflow (you MUST follow this pattern):
1. benchmark__declare_goal({ name: "Get database schema", description: "Retrieve the schema" })
2. [Make tool calls to accomplish the goal]
3. benchmark__complete_goal({ name: "Get database schema", success: true })

If the task has multiple steps, declare and complete goals for each step.
`;
