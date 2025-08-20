import { glob } from 'glob';
import { homedir } from 'os';
import { join, resolve } from 'path';
import type { AgentCompleteEvent, PluginHandlers } from './types';
import { logger } from '../utils/logger';

export class PluginManager {
  private plugins: Array<{ path: string; handlers: PluginHandlers }> = [];
  
  async loadPlugins(): Promise<void> {
    // Define plugin search paths
    const pluginPaths = [
      './.agentuse/plugins/*.{ts,js}',
      join(homedir(), '.agentuse/plugins/*.{ts,js}')
    ];
    
    for (const pattern of pluginPaths) {
      try {
        const files = await glob(pattern, { absolute: true });
        
        for (const file of files) {
          try {
            // Clear require cache to allow hot-reloading in development
            const resolvedPath = resolve(file);
            if (require.cache[resolvedPath]) {
              delete require.cache[resolvedPath];
            }
            
            // Import the plugin module
            const module = await import(resolvedPath);
            const plugin = module.default;
            
            // Validate it's an object with handler functions
            if (plugin && typeof plugin === 'object') {
              this.plugins.push({ path: file, handlers: plugin });
              logger.debug(`Loaded plugin: ${file}`);
            } else {
              logger.warn(`Invalid plugin format in ${file}: must export default object with event handlers`);
            }
          } catch (error) {
            logger.warn(`Failed to load plugin ${file}: ${(error as Error).message}`);
          }
        }
      } catch (error) {
        // Glob pattern might not match anything, that's okay
        if ((error as any).code !== 'ENOENT') {
          logger.debug(`Plugin search path ${pattern} not found or inaccessible`);
        }
      }
    }
    
    if (this.plugins.length > 0) {
      logger.info(`Loaded ${this.plugins.length} plugin(s)`);
    }
  }
  
  async emitAgentComplete(event: AgentCompleteEvent): Promise<void> {
    for (const { path, handlers } of this.plugins) {
      if (handlers['agent:complete']) {
        const pluginName = path.split('/').pop() || path;
        try {
          await handlers['agent:complete'](event);
          logger.info(`Plugin '${pluginName}' executed successfully`);
        } catch (error) {
          logger.info(`Plugin '${pluginName}' failed: ${(error as Error).message}`);
          logger.warn(`Plugin error in ${path}: ${(error as Error).message}`);
        }
      }
    }
  }
}

// Export types for plugin authors
export type { AgentCompleteEvent, PluginHandlers, Plugin } from './types';