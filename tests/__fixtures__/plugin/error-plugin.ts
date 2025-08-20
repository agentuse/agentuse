import type { PluginHandlers } from '../../../src/plugin/types';

const plugin: PluginHandlers = {
  'agent:complete': async (_event) => {
    throw new Error('Test plugin error');
  }
};

export default plugin;