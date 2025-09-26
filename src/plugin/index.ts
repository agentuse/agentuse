import { glob } from 'glob';
import { homedir, tmpdir } from 'os';
import { join, dirname, extname } from 'path';
import { pathToFileURL } from 'url';
import { stat, writeFile, rm } from 'fs/promises';
import * as esbuild from 'esbuild-wasm';
import { createHash } from 'crypto';
import type { AgentCompleteEvent, PluginHandlers } from './types';
import { logger } from '../utils/logger';

// Global initialization state for esbuild-wasm (shared across all instances)
let esbuildInitialized = false;

async function initializeEsbuild(): Promise<void> {
  if (!esbuildInitialized) {
    // In Node.js, esbuild-wasm will automatically find the WASM binary
    // from the installed package when an empty object is provided
    await esbuild.initialize({});
    esbuildInitialized = true;
  }
}

export class PluginManager {
  private plugins: Array<{ path: string; handlers: PluginHandlers }> = [];
  
  async loadPlugins(customDirs?: string[]): Promise<void> {
    // Define plugin search paths
    const pluginPaths = customDirs && customDirs.length > 0
      ? customDirs.map(dir => join(dir, '*.{ts,js}'))
      : [
          './.agentuse/plugins/*.{ts,js}',
          join(homedir(), '.agentuse/plugins/*.{ts,js}')
        ];
    
    for (const pattern of pluginPaths) {
      try {
        const files = await glob(pattern, { absolute: true });
        
        for (const file of files) {
          try {
            let module: any;
            const ext = extname(file);
            
            if (ext === '.ts') {
              // Initialize esbuild-wasm if needed
              await initializeEsbuild();
              
              // TypeScript: Bundle with esbuild-wasm and write to temp file
              const result = await esbuild.build({
                entryPoints: [file],
                bundle: true,
                platform: 'node',
                format: 'esm',
                target: 'node18',
                sourcemap: 'inline',
                absWorkingDir: dirname(file),
                write: false,
                external: ['node:*']
              });
              
              const code = result.outputFiles[0].text;
              // Create a unique temp file name based on the original file path
              const hash = createHash('md5').update(file).digest('hex').substring(0, 8);
              const tempFile = join(tmpdir(), `agentuse-plugin-${hash}.mjs`);
              
              // Write the compiled code to temp file
              await writeFile(tempFile, code);
              
              try {
                // Import from the temp file
                const tempUrl = pathToFileURL(tempFile).href + '?t=' + Date.now();
                module = await import(tempUrl);
              } finally {
                // Clean up temp file
                await rm(tempFile, { force: true }).catch(() => {});
              }
            } else {
              // JavaScript: Dynamic import with cache busting
              const fileStat = await stat(file);
              const url = pathToFileURL(file).href + '?v=' + fileStat.mtimeMs;
              module = await import(url);
            }
            
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