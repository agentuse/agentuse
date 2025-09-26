/**
 * Trace Reporter Plugin
 *
 * Reports performance traces for agent executions, showing timing
 * information for LLM calls, tool executions, and sub-agent runs.
 *
 * Installation:
 * 1. Copy this file to .agentuse/plugins/trace-reporter.js
 * 2. Run any agent to see performance traces after completion
 */

export default {
  "agent:complete": async (event) => {
    // Only process if traces are available and not a sub-agent
    if (!event.result.toolCallTraces || event.isSubAgent) {
      return;
    }

    console.log("\n📊 Performance Traces:");

    // Display each trace with appropriate icon
    for (const trace of event.result.toolCallTraces) {
      const icon =
        trace.type === "llm" ? "🧠" : trace.type === "subagent" ? "🤖" : "🔧";

      console.log(`  ${icon} ${trace.name}: ${trace.duration}ms`);

      if (trace.tokens) {
        console.log(`     └─ Tokens: ${trace.tokens}`);
      }
    }

    // Calculate summary statistics
    const llmCalls = event.result.toolCallTraces.filter(
      (t) => t.type === "llm"
    );
    const toolCalls = event.result.toolCallTraces.filter(
      (t) => t.type === "tool"
    );
    const subagentCalls = event.result.toolCallTraces.filter(
      (t) => t.type === "subagent"
    );

    console.log("\n📈 Summary:");
    console.log(
      `  LLM calls: ${llmCalls.length} (${llmCalls.reduce(
        (sum, t) => sum + t.duration,
        0
      )}ms total)`
    );
    console.log(
      `  Tool calls: ${toolCalls.length} (${toolCalls.reduce(
        (sum, t) => sum + t.duration,
        0
      )}ms total)`
    );
    console.log(
      `  Sub-agents: ${subagentCalls.length} (${subagentCalls.reduce(
        (sum, t) => sum + t.duration,
        0
      )}ms total)`
    );
  },
};