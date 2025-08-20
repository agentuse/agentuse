import type { PluginHandlers } from '../../../src/plugin/types';

const plugin: PluginHandlers = {
  'agent:complete': async (event) => {
    console.log(`Test plugin received event for agent: ${event.agent.name}`);
  }
};

export default plugin;