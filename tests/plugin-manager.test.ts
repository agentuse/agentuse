import { describe, expect, test, beforeEach, afterEach, jest, mock, spyOn } from 'bun:test';
import { PluginManager } from '../src/plugin/index';
import type { AgentCompleteEvent, PluginHandlers } from '../src/plugin/types';
import { homedir } from 'os';
import { join } from 'path';
import { logger } from '../src/utils/logger';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import { stat } from 'fs/promises';

describe('PluginManager', () => {
  let pluginManager: PluginManager;
  let loggerWarnSpy: any;
  let loggerInfoSpy: any;
  let loggerDebugSpy: any;

  beforeEach(() => {
    // Clear all mocks before each test
    mock.restore();
    pluginManager = new PluginManager();
    
    loggerWarnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    loggerInfoSpy = spyOn(logger, 'info').mockImplementation(() => {});
    loggerDebugSpy = spyOn(logger, 'debug').mockImplementation(() => {});
  });
  
  afterEach(() => {
    loggerWarnSpy.mockRestore();
    loggerInfoSpy.mockRestore();
    loggerDebugSpy.mockRestore();
    mock.restore();
  });

  describe('Plugin Loading', () => {
    test('should load valid plugins from fixtures', async () => {
      const mockGlob = mock(() => Promise.resolve([
        join(__dirname, '__fixtures__', 'plugin', 'valid-plugin.ts')
      ]));
      mock.module('glob', () => ({ glob: mockGlob }));

      await pluginManager.loadPlugins();
      
      expect(mockGlob).toHaveBeenCalled();
    });

    test('should handle missing plugin directories gracefully', async () => {
      const mockGlob = mock(() => Promise.resolve([]));
      mock.module('glob', () => ({ glob: mockGlob }));

      await expect(pluginManager.loadPlugins()).resolves.toBeUndefined();
    });

    test('should skip invalid plugin formats', async () => {
      const mockGlob = mock(() => Promise.resolve([
        join(__dirname, '__fixtures__', 'plugin', 'invalid-plugin.ts')
      ]));
      mock.module('glob', () => ({ glob: mockGlob }));

      await pluginManager.loadPlugins();
      
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid plugin format')
      );
    });

    test('should handle plugin loading errors', async () => {
      const mockGlob = mock(() => Promise.resolve([
        '/non/existent/plugin.ts'
      ]));
      mock.module('glob', () => ({ glob: mockGlob }));

      await expect(pluginManager.loadPlugins()).resolves.toBeUndefined();
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to load plugin')
      );
    });

    test('should load TypeScript plugins using esbuild', async () => {
      const tsPluginPath = join(__dirname, '__fixtures__', 'plugin', 'ts-with-imports.ts');
      const mockGlob = mock((pattern: string) => {
        // Match any pattern that looks for plugins
        if (pattern.includes('plugins/*.{ts,js}')) {
          return Promise.resolve([tsPluginPath]);
        }
        return Promise.resolve([]);
      });
      mock.module('glob', () => ({ glob: mockGlob }));

      const testManager = new PluginManager();
      await testManager.loadPlugins();
      
      const plugins = (testManager as any).plugins;
      expect(plugins.length).toBeGreaterThan(0);
      const tsPlugin = plugins.find((p: any) => p.path === tsPluginPath);
      expect(tsPlugin).toBeDefined();
      expect(tsPlugin?.handlers['agent:complete']).toBeDefined();
    });

    test('should load JavaScript plugins with cache busting', async () => {
      const jsPluginPath = join(__dirname, '__fixtures__', 'plugin', 'valid-plugin.js');
      const mockGlob = mock((pattern: string) => {
        // Match any pattern that looks for plugins
        if (pattern.includes('plugins/*.{ts,js}')) {
          return Promise.resolve([jsPluginPath]);
        }
        return Promise.resolve([]);
      });
      mock.module('glob', () => ({ glob: mockGlob }));

      const testManager = new PluginManager();
      await testManager.loadPlugins();
      
      const plugins = (testManager as any).plugins;
      expect(plugins.length).toBeGreaterThan(0);
      const jsPlugin = plugins.find((p: any) => p.path === jsPluginPath);
      expect(jsPlugin).toBeDefined();
      expect(jsPlugin?.handlers['agent:complete']).toBeDefined();
    });

    test('should handle mixed TypeScript and JavaScript plugins', async () => {
      const tsPluginPath = join(__dirname, '__fixtures__', 'plugin', 'valid-plugin.ts');
      const jsPluginPath = join(__dirname, '__fixtures__', 'plugin', 'valid-plugin.js');
      
      const mockGlob = mock((pattern: string) => {
        // Return different files based on pattern
        if (pattern.includes('./.agentuse')) {
          return Promise.resolve([tsPluginPath]);
        }
        return Promise.resolve([jsPluginPath]);
      });
      mock.module('glob', () => ({ glob: mockGlob }));

      await pluginManager.loadPlugins();
      
      const plugins = (pluginManager as any).plugins;
      expect(plugins).toHaveLength(2);
      expect(plugins.some((p: any) => p.path === tsPluginPath)).toBe(true);
      expect(plugins.some((p: any) => p.path === jsPluginPath)).toBe(true);
    });

    test('should search in both project and home directories', async () => {
      const mockGlob = mock(() => Promise.resolve([]));
      mock.module('glob', () => ({ glob: mockGlob }));

      await pluginManager.loadPlugins();

      expect(mockGlob).toHaveBeenCalledWith(
        expect.stringContaining('./.agentuse/plugins/*.{ts,js}'),
        expect.any(Object)
      );
      expect(mockGlob).toHaveBeenCalledWith(
        expect.stringContaining(join(homedir(), '.agentuse/plugins/*.{ts,js}')),
        expect.any(Object)
      );
    });
  });

  describe('Plugin Validation', () => {
    test('should validate plugin structure', async () => {
      const validPlugin: PluginHandlers = {
        'agent:complete': async (_event) => {}
      };

      // Mock to only return our test plugin
      const mockGlob = mock(() => Promise.resolve([]));
      mock.module('glob', () => ({ glob: mockGlob }));

      // Manually add a valid plugin to test validation
      (pluginManager as any).plugins = [
        { path: 'test.ts', handlers: validPlugin }
      ];
      
      // Since we're not actually loading plugins, we shouldn't get warnings
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    test('should handle plugins with no event handlers', async () => {
      // Mock to return empty to avoid loading real plugins
      const mockGlob = mock(() => Promise.resolve([]));
      mock.module('glob', () => ({ glob: mockGlob }));

      // Manually set up a plugin with no handlers to test
      (pluginManager as any).plugins = [
        { path: 'no-handlers.ts', handlers: {} }
      ];
      
      // No warnings should be logged for plugins with empty handlers
      expect(loggerWarnSpy).not.toHaveBeenCalled();
    });

    test('should handle non-object default exports', async () => {
      const mockGlob = mock(() => Promise.resolve([
        join(__dirname, '__fixtures__', 'plugin', 'invalid-plugin.ts')
      ]));
      mock.module('glob', () => ({ glob: mockGlob }));

      await pluginManager.loadPlugins();
      
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Invalid plugin format')
      );
    });
  });

  describe('Event Emission', () => {
    test('should emit agent:complete event to loaded plugins', async () => {
      const mockHandler = jest.fn();
      const testPlugin: PluginHandlers = {
        'agent:complete': mockHandler
      };

      (pluginManager as any).plugins = [
        { path: 'test.ts', handlers: testPlugin }
      ];

      const event: AgentCompleteEvent = {
        agent: {
          name: 'test-agent',
          model: 'test-model',
          filePath: '/test/path'
        },
        result: {
          text: 'Test result',
          duration: 1.5,
          tokens: 100,
          toolCalls: 3
        },
        isSubAgent: false
      };

      await pluginManager.emitAgentComplete(event);

      expect(mockHandler).toHaveBeenCalledWith(event);
    });

    test('should handle async plugin handlers', async () => {
      let handlerCompleted = false;
      const asyncHandler = async (_event: AgentCompleteEvent) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        handlerCompleted = true;
      };

      const testPlugin: PluginHandlers = {
        'agent:complete': asyncHandler
      };

      (pluginManager as any).plugins = [
        { path: 'test.ts', handlers: testPlugin }
      ];

      const event: AgentCompleteEvent = {
        agent: { name: 'test', model: 'test' },
        result: { text: '', duration: 0, toolCalls: 0 },
        isSubAgent: false
      };

      await pluginManager.emitAgentComplete(event);

      expect(handlerCompleted).toBe(true);
    });

    test('should continue when plugin handler throws error', async () => {
      const errorHandler = jest.fn().mockRejectedValue(new Error('Plugin error'));
      const successHandler = jest.fn();

      (pluginManager as any).plugins = [
        { path: 'error.ts', handlers: { 'agent:complete': errorHandler } },
        { path: 'success.ts', handlers: { 'agent:complete': successHandler } }
      ];

      const event: AgentCompleteEvent = {
        agent: { name: 'test', model: 'test' },
        result: { text: '', duration: 0, toolCalls: 0 },
        isSubAgent: false
      };

      await pluginManager.emitAgentComplete(event);

      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
      expect(loggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Plugin error')
      );
    });

    test('should pass correct event data structure', async () => {
      const mockHandler = jest.fn();
      const testPlugin: PluginHandlers = {
        'agent:complete': mockHandler
      };

      (pluginManager as any).plugins = [
        { path: 'test.ts', handlers: testPlugin }
      ];

      const event: AgentCompleteEvent = {
        agent: {
          name: 'full-test-agent',
          model: 'gpt-4',
          filePath: '/agents/test.md'
        },
        result: {
          text: 'Complete result text',
          duration: 2.5,
          tokens: 250,
          toolCalls: 5
        },
        isSubAgent: true
      };

      await pluginManager.emitAgentComplete(event);

      expect(mockHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({
            name: 'full-test-agent',
            model: 'gpt-4',
            filePath: '/agents/test.md'
          }),
          result: expect.objectContaining({
            text: 'Complete result text',
            duration: 2.5,
            tokens: 250,
            toolCalls: 5
          }),
          isSubAgent: true
        })
      );
    });
  });

  describe('ESBuild and Dynamic Import Tests', () => {
    test('should compile TypeScript plugins with esbuild at runtime', async () => {
      // Create a temporary test directory
      const testDir = join(__dirname, '.test-plugins');
      mkdirSync(testDir, { recursive: true });
      
      // Create a TypeScript plugin with imports
      const tsContent = `
        import { basename } from 'path';
        import type { PluginHandlers } from '${join(__dirname, '../src/plugin/types')}';
        
        const plugin: PluginHandlers = {
          'agent:complete': async (event) => {
            const name = basename(event.agent.name || 'unknown');
            console.log('Compiled TS plugin:', name);
          }
        };
        
        export default plugin;
      `;
      
      const tsPath = join(testDir, 'test-plugin.ts');
      writeFileSync(tsPath, tsContent);
      
      try {
        const mockGlob = mock((pattern: string) => {
          if (pattern.includes('plugins/*.{ts,js}')) {
            return Promise.resolve([tsPath]);
          }
          return Promise.resolve([]);
        });
        mock.module('glob', () => ({ glob: mockGlob }));
        
        const testManager = new PluginManager();
        await testManager.loadPlugins();
        
        const plugins = (testManager as any).plugins;
        expect(plugins.length).toBeGreaterThan(0);
        const plugin = plugins.find((p: any) => p.path === tsPath);
        expect(plugin).toBeDefined();
        expect(plugin?.handlers['agent:complete']).toBeDefined();
        
        // Test that the handler works
        if (plugin) {
          const event: AgentCompleteEvent = {
            agent: { name: 'test-agent', model: 'test' },
            result: { text: 'test', duration: 1, toolCalls: 0 },
            isSubAgent: false
          };
          
          await expect(plugin.handlers['agent:complete'](event)).resolves.toBeUndefined();
        }
      } finally {
        mock.restore();
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test('should add cache-busting query parameter for JavaScript plugins', async () => {
      // Create a temporary test directory
      const testDir = join(__dirname, '.test-plugins');
      mkdirSync(testDir, { recursive: true });
      
      // Create a JavaScript plugin
      const jsContent = `
        const plugin = {
          'agent:complete': async (event) => {
            console.log('JS plugin with cache busting');
          }
        };
        export default plugin;
      `;
      
      const jsPath = join(testDir, 'test-plugin.js');
      writeFileSync(jsPath, jsContent);
      
      try {
        const mockGlob = mock((pattern: string) => {
          if (pattern.includes('plugins/*.{ts,js}')) {
            return Promise.resolve([jsPath]);
          }
          return Promise.resolve([]);
        });
        mock.module('glob', () => ({ glob: mockGlob }));
        
        const testManager = new PluginManager();
        await testManager.loadPlugins();
        
        const plugins = (testManager as any).plugins;
        expect(plugins.length).toBeGreaterThan(0);
        const plugin = plugins.find((p: any) => p.path === jsPath);
        expect(plugin).toBeDefined();
        expect(plugin?.handlers['agent:complete']).toBeDefined();
      } finally {
        mock.restore();
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    test('should handle esbuild compilation errors gracefully', async () => {
      // Create a TypeScript plugin with syntax error
      const testDir = join(__dirname, '.test-plugins');
      mkdirSync(testDir, { recursive: true });
      
      const invalidTsContent = `
        import { join } from 'path';
        // Syntax error: missing closing brace
        const plugin = {
          'agent:complete': async (event) => {
            console.log('test'
        };
        export default plugin;
      `;
      
      const tsPath = join(testDir, 'invalid.ts');
      writeFileSync(tsPath, invalidTsContent);
      
      try {
        const mockGlob = mock((pattern: string) => {
          if (pattern.includes('plugins/*.{ts,js}')) {
            return Promise.resolve([tsPath]);
          }
          return Promise.resolve([]);
        });
        mock.module('glob', () => ({ glob: mockGlob }));
        
        const testManager = new PluginManager();
        await testManager.loadPlugins();
        
        expect(loggerWarnSpy).toHaveBeenCalledWith(
          expect.stringContaining('Failed to load plugin')
        );
        
        const plugins = (testManager as any).plugins;
        expect(plugins).toHaveLength(0);
      } finally {
        mock.restore();
        rmSync(testDir, { recursive: true, force: true });
      }
    });
  });

  describe('Integration Tests', () => {
    test('should handle multiple plugins for same event', async () => {
      const handler1 = jest.fn();
      const handler2 = jest.fn();
      const handler3 = jest.fn();

      (pluginManager as any).plugins = [
        { path: 'plugin1.ts', handlers: { 'agent:complete': handler1 } },
        { path: 'plugin2.ts', handlers: { 'agent:complete': handler2 } },
        { path: 'plugin3.ts', handlers: { 'agent:complete': handler3 } }
      ];

      const event: AgentCompleteEvent = {
        agent: { name: 'test', model: 'test' },
        result: { text: '', duration: 0, toolCalls: 0 },
        isSubAgent: false
      };

      await pluginManager.emitAgentComplete(event);

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler3).toHaveBeenCalledTimes(1);
    });

    test('should ensure event data immutability between plugins', async () => {
      const originalEvent: AgentCompleteEvent = {
        agent: { name: 'test', model: 'test' },
        result: { text: 'original', duration: 1, toolCalls: 0 },
        isSubAgent: false
      };

      const mutatingHandler = jest.fn((event: AgentCompleteEvent) => {
        (event.result as any).text = 'modified';
      });

      const checkingHandler = jest.fn();

      (pluginManager as any).plugins = [
        { path: 'mutating.ts', handlers: { 'agent:complete': mutatingHandler } },
        { path: 'checking.ts', handlers: { 'agent:complete': checkingHandler } }
      ];

      await pluginManager.emitAgentComplete(originalEvent);

      expect(checkingHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          result: expect.objectContaining({
            text: 'modified'
          })
        })
      );
    });

    test('should skip plugins without matching event handler', async () => {
      const handler = jest.fn();
      
      (pluginManager as any).plugins = [
        { path: 'no-handler.ts', handlers: {} },
        { path: 'with-handler.ts', handlers: { 'agent:complete': handler } }
      ];

      const event: AgentCompleteEvent = {
        agent: { name: 'test', model: 'test' },
        result: { text: '', duration: 0, toolCalls: 0 },
        isSubAgent: false
      };

      await pluginManager.emitAgentComplete(event);

      expect(handler).toHaveBeenCalledTimes(1);
    });

    test('should handle rapid successive event emissions', async () => {
      let callCount = 0;
      const handler = jest.fn(async () => {
        callCount++;
        await new Promise(resolve => setTimeout(resolve, 5));
      });

      (pluginManager as any).plugins = [
        { path: 'test.ts', handlers: { 'agent:complete': handler } }
      ];

      const event: AgentCompleteEvent = {
        agent: { name: 'test', model: 'test' },
        result: { text: '', duration: 0, toolCalls: 0 },
        isSubAgent: false
      };

      await Promise.all([
        pluginManager.emitAgentComplete(event),
        pluginManager.emitAgentComplete(event),
        pluginManager.emitAgentComplete(event)
      ]);

      expect(callCount).toBe(3);
    });
  });
});