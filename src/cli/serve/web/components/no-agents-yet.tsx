import { CodingAgentList, useCodingAgents } from './coding-agent-list';

/**
 * Home with no agents yet: a short tutorial for making the first one. The
 * person automates work their coding agent just did: step 1 adds AgentUse to
 * Claude Code and Codex, step 2 says to type /automate in a chat that did a
 * job, step 3 says where the result shows up. Addresses for other apps live in
 * Settings, so Home shows none.
 */
export function NoAgentsYet(props: { noProjects: boolean }) {
  const agents = useCodingAgents();
  const ready = agents.rows.filter((agent) => agent.state === 'set-up');
  const connected = ready.length > 0;
  const only = ready.length === 1 ? ready[0] : undefined;
  const command = only?.command ?? '/automate';
  const where = only?.name ?? 'Claude Code or Codex';

  return (
    <section class="no-agents" aria-labelledby="no-agents-title">
      <header class="no-agents-head">
        <p class="no-agents-eyebrow">No agents yet</p>
        <h1 id="no-agents-title">Make your first work agent</h1>
        <p class="no-agents-lede">
          Did Claude Code or Codex just do a job for you? Ask it to turn that into a work agent, and it runs here on schedule.
        </p>
        {props.noProjects && (
          <p class="no-agents-note">There's no project yet. <a href="/settings?tab=projects">Add one in Settings</a>, or your coding agent makes one for you.</p>
        )}
      </header>

      <ol class="tutorial">
        {!agents.error && (
          <li class={connected ? 'tutorial-step is-done' : 'tutorial-step is-current'}>
            <span class="tutorial-mark" aria-hidden="true">{connected ? '✓' : '1'}</span>
            <div class="tutorial-body">
              <h2>Connect a coding agent</h2>
              <p>AgentUse adds itself to Claude Code and Codex on this Mac, in their apps and in the terminal.</p>
              <CodingAgentList agents={agents} />
            </div>
          </li>
        )}

        <li class={connected || agents.error ? 'tutorial-step is-current' : 'tutorial-step'}>
          <span class="tutorial-mark" aria-hidden="true">2</span>
          <div class="tutorial-body">
            <h2>Ask it to automate what it just did</h2>
            <p>Go back to a chat where {where} did a job for you, and send:</p>
            <div class="tutorial-chat">
              <span class="tutorial-chat-bubble">{command} this every Monday at 9am</span>
            </div>
            <p>
              {ready.length > 1 && <>In Codex, start with $automate. </>}
              No chat like that yet? Ask it to do the job once, then type {command}.
            </p>
          </div>
        </li>

        <li class="tutorial-step">
          <span class="tutorial-mark" aria-hidden="true">3</span>
          <div class="tutorial-body">
            <h2>Say yes</h2>
            <p>It shows you a draft first. Say yes in the chat, or press Apply on the review page it links. The agent then appears here, under Agents.</p>
          </div>
        </li>
      </ol>

      <p class="no-agents-more">
        Use Claude or ChatGPT on the web, or Cursor? <a href="/settings?tab=apps">Connect them in Settings</a>.
      </p>
    </section>
  );
}
