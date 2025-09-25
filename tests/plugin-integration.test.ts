import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { PluginManager } from '../src/plugin/index';
import type { AgentCompleteEvent } from '../src/plugin/types';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';

describe('Plugin Integration Tests', () => {
  const testPluginDir = './.agentuse/plugins';
  
  beforeEach(() => {
    // Create test plugin directory
    mkdirSync(testPluginDir, { recursive: true });
  });
  
  afterEach(() => {
    // Clean up test plugins
    rmSync(testPluginDir, { recursive: true, force: true });
  });
  
  test('should load and execute TypeScript plugin with imports', async () => {
    // Create a TypeScript plugin that uses imports
    const tsPluginContent = `
import { basename } from 'path';
import type { PluginHandlers } from '../../src/plugin/types';

let executed = false;

const plugin: PluginHandlers = {
  'agent:complete': async (event) => {
    executed = true;
    const name = basename(event.agent.name || 'unknown');
    console.log('TypeScript plugin executed for:', name);
  }
};

export default plugin;
`;
    
    writeFileSync(join(testPluginDir, 'test-plugin.ts'), tsPluginContent);
    
    const pluginManager = new PluginManager();
    await pluginManager.loadPlugins([testPluginDir]);
    
    const plugins = (pluginManager as any).plugins;
    expect(plugins.length).toBeGreaterThan(0);
    
    // Find our test plugin
    const testPlugin = plugins.find((p: any) => p.path.includes('test-plugin.ts'));
    expect(testPlugin).toBeDefined();
    expect(testPlugin?.handlers['agent:complete']).toBeDefined();
    
    // Execute the plugin
    const event: AgentCompleteEvent = {
      agent: { name: 'test-agent', model: 'test-model' },
      result: { text: 'test result', duration: 1.5, toolCalls: 2 },
      isSubAgent: false
    };
    
    await pluginManager.emitAgentComplete(event);
  });
  
  test('should load and execute JavaScript plugin', async () => {
    // Create a JavaScript plugin
    const jsPluginContent = `
const plugin = {
  'agent:complete': async (event) => {
    console.log('JavaScript plugin executed for:', event.agent.name);
  }
};

export default plugin;
`;
    
    writeFileSync(join(testPluginDir, 'test-plugin.js'), jsPluginContent);
    
    const pluginManager = new PluginManager();
    await pluginManager.loadPlugins([testPluginDir]);
    
    const plugins = (pluginManager as any).plugins;
    expect(plugins.length).toBeGreaterThan(0);
    
    // Find our test plugin
    const testPlugin = plugins.find((p: any) => p.path.includes('test-plugin.js'));
    expect(testPlugin).toBeDefined();
    expect(testPlugin?.handlers['agent:complete']).toBeDefined();
    
    // Execute the plugin
    const event: AgentCompleteEvent = {
      agent: { name: 'js-test-agent', model: 'test-model' },
      result: { text: 'test result', duration: 0.5, toolCalls: 1 },
      isSubAgent: false
    };
    
    await pluginManager.emitAgentComplete(event);
  });
  
  test('should handle TypeScript compilation errors gracefully', async () => {
    // Create a TypeScript plugin with syntax error
    const invalidTsContent = `
import { join } from 'path';

const plugin = {
  'agent:complete': async (event) => {
    console.log('test' // Missing closing parenthesis
  }
};

export default plugin;
`;
    
    writeFileSync(join(testPluginDir, 'invalid.ts'), invalidTsContent);
    
    const pluginManager = new PluginManager();
    await pluginManager.loadPlugins([testPluginDir]);
    
    // Plugin should fail to load but not crash
    const plugins = (pluginManager as any).plugins;
    const invalidPlugin = plugins.find((p: any) => p.path.includes('invalid.ts'));
    expect(invalidPlugin).toBeUndefined();
  });
  
  test('should load multiple plugins of different types', async () => {
    // Create TypeScript plugin
    const tsContent = `
import type { PluginHandlers } from '../../src/plugin/types';

const plugin: PluginHandlers = {
  'agent:complete': async (event) => {
    console.log('TS plugin:', event.agent.name);
  }
};

export default plugin;
`;
    
    // Create JavaScript plugin
    const jsContent = `
const plugin = {
  'agent:complete': async (event) => {
    console.log('JS plugin:', event.agent.name);
  }
};

export default plugin;
`;
    
    writeFileSync(join(testPluginDir, 'plugin1.ts'), tsContent);
    writeFileSync(join(testPluginDir, 'plugin2.js'), jsContent);
    
    const pluginManager = new PluginManager();
    await pluginManager.loadPlugins([testPluginDir]);
    
    const plugins = (pluginManager as any).plugins;
    expect(plugins.length).toBe(2);
    
    // Check both plugins loaded
    const tsPlugin = plugins.find((p: any) => p.path.includes('plugin1.ts'));
    const jsPlugin = plugins.find((p: any) => p.path.includes('plugin2.js'));
    
    expect(tsPlugin).toBeDefined();
    expect(jsPlugin).toBeDefined();
    
    // Execute both plugins
    const event: AgentCompleteEvent = {
      agent: { name: 'multi-test', model: 'test-model' },
      result: { text: 'test', duration: 1, toolCalls: 0 },
      isSubAgent: false
    };
    
    await pluginManager.emitAgentComplete(event);
  });
});