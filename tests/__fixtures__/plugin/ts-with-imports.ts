import { join } from 'path';
import type { PluginHandlers } from '../../../src/plugin/types';

function formatPath(dir: string, file: string): string {
  return join(dir, file);
}

const plugin: PluginHandlers = {
  'agent:complete': async (event) => {
    const path = formatPath('/test', 'file.txt');
    console.log(`TS plugin with imports: ${event.agent.name} at ${path}`);
  }
};

export default plugin;