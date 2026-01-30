import { describe, it, expect } from "bun:test";
import { buildManagerPrompt } from "../src/manager/prompt";
import type { ManagerPromptContext } from "../src/manager/types";

describe("buildManagerPrompt", () => {
  describe("basic prompt structure", () => {
    it("generates prompt with all sections", () => {
      const context: ManagerPromptContext = {
        subagents: [
          { name: "researcher", description: "Finds information", path: "./researcher.agentuse" },
        ],
        storeName: "test-store",
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("You are a team manager agent");
      expect(prompt).toContain("## Your Responsibilities");
      expect(prompt).toContain("## Your Team");
      expect(prompt).toContain("## Work Tracking");
      expect(prompt).toContain("## Delegation Guidelines");
      expect(prompt).toContain("## When Blocked");
      expect(prompt).toContain("## Progress Reporting");
    });

    it("includes responsibilities framework", () => {
      const context: ManagerPromptContext = {
        subagents: [],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("1. **UNDERSTAND**");
      expect(prompt).toContain("2. **CHECK**");
      expect(prompt).toContain("3. **DECIDE**");
      expect(prompt).toContain("4. **DELEGATE**");
      expect(prompt).toContain("5. **TRACK**");
      expect(prompt).toContain("6. **REPEAT**");
    });
  });

  describe("subagent formatting", () => {
    it("formats single subagent with description", () => {
      const context: ManagerPromptContext = {
        subagents: [
          { name: "writer", description: "Creates content", path: "./writer.agentuse" },
        ],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("- **writer**: Creates content");
    });

    it("formats multiple subagents", () => {
      const context: ManagerPromptContext = {
        subagents: [
          { name: "researcher", description: "Finds information", path: "./researcher.agentuse" },
          { name: "writer", description: "Creates content", path: "./writer.agentuse" },
          { name: "reviewer", description: "Reviews quality", path: "./reviewer.agentuse" },
        ],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("- **researcher**: Finds information");
      expect(prompt).toContain("- **writer**: Creates content");
      expect(prompt).toContain("- **reviewer**: Reviews quality");
    });

    it("handles subagent without description", () => {
      const context: ManagerPromptContext = {
        subagents: [
          { name: "helper", path: "./helper.agentuse" },
        ],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("- **helper**: No description available");
    });

    it("shows message when no subagents configured", () => {
      const context: ManagerPromptContext = {
        subagents: [],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("(No subagents configured)");
    });
  });

  describe("schedule section", () => {
    it("shows manual run message when no schedule", () => {
      const context: ManagerPromptContext = {
        subagents: [],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("## Schedule Context");
      expect(prompt).toContain("being run manually or on-demand");
      expect(prompt).toContain("Complete your work in this session");
    });

    it("includes schedule info when configured", () => {
      const context: ManagerPromptContext = {
        subagents: [],
        schedule: {
          cron: "0 9 * * *",
          humanReadable: "Every day at 9:00 AM",
        },
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("You run: **Every day at 9:00 AM** (`0 9 * * *`)");
    });

    it("includes pacing guidance for scheduled runs", () => {
      const context: ManagerPromptContext = {
        subagents: [],
        schedule: {
          cron: "0 * * * *",
          humanReadable: "Every hour",
        },
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("Consider this frequency when pacing work");
      expect(prompt).toContain("Don't rush to complete everything");
      expect(prompt).toContain("Check current progress vs targets");
    });
  });

  describe("work tracking section", () => {
    it("shows store instructions when configured", () => {
      const context: ManagerPromptContext = {
        subagents: [],
        storeName: "my-project",
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain('Use the store to track work items in the "my-project" store');
      expect(prompt).toContain("store_create");
      expect(prompt).toContain("store_update");
      expect(prompt).toContain("store_list");
    });

    it("shows no-store message when not configured", () => {
      const context: ManagerPromptContext = {
        subagents: [],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("No persistent store is configured");
      expect(prompt).toContain("track work items in your working memory");
      expect(prompt).toContain("store: true");
    });

    it("includes common store operations examples", () => {
      const context: ManagerPromptContext = {
        subagents: [],
        storeName: "test",
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain('type: "task"');
      expect(prompt).toContain('status: "pending"');
      expect(prompt).toContain('status: "in_progress"');
      expect(prompt).toContain('status: "done"');
    });
  });

  describe("delegation guidelines", () => {
    it("includes delegation best practices", () => {
      const context: ManagerPromptContext = {
        subagents: [{ name: "worker", path: "./worker.agentuse" }],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("clear, specific instructions");
      expect(prompt).toContain("relevant context from previous work");
      expect(prompt).toContain("store item ID");
      expect(prompt).toContain("expected outputs");
    });
  });

  describe("blocker handling", () => {
    it("includes blocker instructions", () => {
      const context: ManagerPromptContext = {
        subagents: [],
      };

      const prompt = buildManagerPrompt(context);

      expect(prompt).toContain("## When Blocked");
      expect(prompt).toContain("need human input");
      expect(prompt).toContain("blocked on");
      expect(prompt).toContain("decision or input you need");
    });
  });

  describe("full context integration", () => {
    it("generates complete prompt with all options", () => {
      const context: ManagerPromptContext = {
        subagents: [
          { name: "researcher", description: "Finds topics", path: "./researcher.agentuse" },
          { name: "writer", description: "Writes articles", path: "./writer.agentuse" },
          { name: "reviewer", description: "Reviews quality", path: "./reviewer.agentuse" },
        ],
        storeName: "content-pipeline",
        schedule: {
          cron: "0 */2 * * *",
          humanReadable: "Every 2 hours",
        },
      };

      const prompt = buildManagerPrompt(context);

      // All sections present
      expect(prompt).toContain("team manager agent");
      expect(prompt).toContain("Every 2 hours");
      expect(prompt).toContain("researcher");
      expect(prompt).toContain("writer");
      expect(prompt).toContain("reviewer");
      expect(prompt).toContain("content-pipeline");

      // Core manager guidance
      expect(prompt).toContain("orchestration and tracking");
      expect(prompt).toContain("Delegate effectively");
    });
  });
});
