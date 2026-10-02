import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAgent, parseAgentContent } from '../src/parser';
import { createSubAgentTools } from '../src/subagent';
import { buildSystemMessages } from '../src/runner/system-messages';

// The tool registry and the manager prompt must agree on what each child is
// called, and two children must never share one tool name (the later one
// silently replaced the earlier while the prompt listed both).

function managerWith(subagents: string): string {
  return `---\nmodel: demo:test\ntype: manager\nsubagents:\n${subagents}\n---\nManage.`;
}

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-subagent-names-'));
  await writeFile(join(root, 'review-one.agentuse'), '---\nmodel: demo:test\nname: Review One\ndescription: Reviews drafts\n---\nReview.');
  await writeFile(join(root, 'writer.agentuse'), '---\nmodel: demo:test\ndescription: Writes drafts\n---\nWrite.');
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('sub-agent tool names', () => {
  it('rejects file names that normalize to the same tool name', () => {
    expect(() => parseAgentContent(managerWith('  - path: ./review-one.agentuse\n  - path: ./review_one.agentuse'), 'm'))
      .toThrow('subagent__review_one');
  });

  it('rejects custom names that normalize to the same tool name', () => {
    expect(() => parseAgentContent(managerWith('  - path: ./a.agentuse\n    name: a b\n  - path: ./b.agentuse\n    name: a.b'), 'm'))
      .toThrow('subagent__a_b');
  });

  it('keeps normalizing custom names that are not valid tool names', () => {
    const agent = parseAgentContent(managerWith('  - path: ./a.agentuse\n    name: Code Reviewer'), 'm');
    expect(agent.config.subagents?.[0]?.name).toBe('Code Reviewer');
  });

  it('lists each child in the manager prompt under the tool name it is registered as', async () => {
    const managerPath = join(root, 'manager.agentuse');
    await writeFile(managerPath, managerWith('  - path: ./review-one.agentuse\n  - path: ./writer.agentuse\n    name: Lead Writer'));
    const agent = await parseAgent(managerPath);

    const tools = await createSubAgentTools(agent.config.subagents, root);
    const { messages } = await buildSystemMessages({ agent, isSubAgent: false, agentFilePath: managerPath, projectRoot: root, stateRoot: root });
    const prompt = messages.map(m => m.content).join('\n');

    expect(Object.keys(tools).sort()).toEqual(['subagent__Lead_Writer', 'subagent__review_one']);
    for (const toolName of Object.keys(tools)) {
      expect(prompt).toContain(`- **${toolName}**:`);
    }
  });
});
