# Manager Demo

A simple demo showing the manager pattern with 3 subagents collaborating to create content.

## What's in this demo

- **manager.agentuse** - Team manager that coordinates work
- **agents/researcher.agentuse** - Finds interesting topics
- **agents/writer.agentuse** - Writes articles from topic briefs
- **agents/reviewer.agentuse** - Reviews articles for quality

## How it works

1. Manager reads the goal (create 3 articles about productivity)
2. Manager delegates to researcher to find topics
3. Researcher saves topics to the shared store
4. Manager delegates to writer for each topic
5. Writer creates articles and saves to store
6. Manager delegates to reviewer for quality check
7. Manager tracks all progress in the shared store

## Run

```bash
agentuse run manager.agentuse
```

Or with npx:

```bash
npx tsx src/index.ts run templates/manager-demo/manager.agentuse
```

## Check store state

After running, you can see the persisted data:

```bash
cat .agentuse/store/demo-content/items.json
```

## Key concepts demonstrated

### Shared Store
All agents use `store: "demo-content"` which means they share the same persistent storage. This allows:
- Researcher to create topics that Writer can read
- Writer to create articles that Reviewer can read
- Manager to track overall progress

### Manager Type
The manager uses `type: manager` which automatically injects orchestration prompts that help it:
- Understand its role as coordinator
- Know how to delegate effectively
- Track progress using the store

### Subagents
Subagents are defined in the manager's config and automatically become available as tools:
- `subagent__researcher` - Call the researcher
- `subagent__writer` - Call the writer
- `subagent__reviewer` - Call the reviewer

## Customization

To adapt this pattern for your own use case:

1. **Change the goal** - Edit the Goal section in manager.agentuse
2. **Modify the SOP** - Update the Standard Operating Procedure
3. **Add/remove agents** - Create new .agentuse files in the agents/ directory
4. **Adjust models** - Use different models for cost/performance tradeoffs
