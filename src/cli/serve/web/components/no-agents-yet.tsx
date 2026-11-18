import { useFetch } from '../hooks/use-fetch';
import { fetchCloudState } from '../lib/api';
import { AssistantCards } from './assistant-cards';
import { useCodingAgents } from './coding-agent-list';

/**
 * Home with no agents yet: a short tutorial for making the first one. The
 * person automates work their AI assistant just did: step 1 connects it
 * (Claude Code, Codex; Claude and ChatGPT too with AgentUse Cloud), step 2 says what to send in a chat
 * that did a job, step 3 says where the result shows up.
 */
export function NoAgentsYet(props: { noProjects: boolean }) {
  const agents = useCodingAgents();
  const connected = agents.rows.some((agent) => agent.state === 'set-up');
  const withCommand = agents.rows.find((agent) => agent.state === 'set-up' && agent.command);
  const cloud = useFetch('home-cloud', () => fetchCloudState());
  const chatApps = Boolean(cloud.data?.enabled);

  return (
    <section class="no-agents" aria-labelledby="no-agents-title">
      <header class="no-agents-head">
        <p class="no-agents-eyebrow">No agents yet</p>
        <h1 id="no-agents-title">Make your first work agent</h1>
        <p class="no-agents-lede">
          Did your AI assistant just do a job for you? Ask it to turn that into a work agent, and it runs here on schedule.
        </p>
        {props.noProjects && (
          <p class="no-agents-note">There's no project yet. <a href="/settings?tab=projects">Add one in Settings</a>, or your assistant makes one for you.</p>
        )}
      </header>

      <ol class="tutorial">
        <li class={connected ? 'tutorial-step is-done' : 'tutorial-step is-current'}>
          <span class="tutorial-mark" aria-hidden="true">{connected ? '✓' : '1'}</span>
          <div class="tutorial-body">
            <h2>Connect your AI assistant</h2>
            <p>Claude Code and Codex set up in one click.{chatApps && ' For Claude and ChatGPT, Connect shows the two steps.'}</p>
            <AssistantCards agents={agents} />
          </div>
        </li>

        <li class={connected ? 'tutorial-step is-current' : 'tutorial-step'}>
          <span class="tutorial-mark" aria-hidden="true">2</span>
          <div class="tutorial-body">
            <h2>Ask it to automate what it just did</h2>
            <p>Go back to a chat where your assistant did a job for you, and send:</p>
            <div class="tutorial-chat">
              <span class="tutorial-chat-bubble">Use AgentUse to run this every Monday at 9am</span>
            </div>
            <p>
              {withCommand && <>If it doesn't pick that up, type <code>{withCommand.command}</code> in {withCommand.name} and choose automate. </>}
              No chat like that yet? Ask it to do the job once first.
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
        {chatApps ? 'Use Claude or ChatGPT on the web, or Cursor? ' : 'Use Cursor or another app? '}<a href="/settings?tab=apps">{chatApps ? 'Connect them in Settings' : 'Connect it in Settings'}</a>.
      </p>
    </section>
  );
}
