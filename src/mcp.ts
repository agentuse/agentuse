import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'child_process';

export interface MCPServerConfig {
  command: string;
  args: string[];
}

export interface MCPServersConfig {
  [name: string]: MCPServerConfig;
}

export interface MCPConnection {
  name: string;
  client: Client;
}

/**
 * Connect to MCP servers via stdio transport
 * @param servers Optional server configurations
 * @returns Array of MCP client connections
 */
export async function connectMCP(servers?: MCPServersConfig): Promise<MCPConnection[]> {
  if (!servers) return [];
  
  const connections: MCPConnection[] = [];
  
  for (const [name, config] of Object.entries(servers)) {
    try {
      // Create stdio transport
      const transport = new StdioClientTransport({
        command: config.command,
        args: config.args
      });
      
      // Create MCP client
      const client = new Client({
        name,
        version: '1.0.0'
      }, {
        capabilities: {}
      });
      
      // Connect to the server
      await client.connect(transport);
      
      connections.push({
        name,
        client
      });
      
      console.log(`Connected to MCP server: ${name}`);
    } catch (error) {
      console.error(`Failed to connect to MCP server ${name}:`, error);
      throw new Error(`Failed to connect to MCP server: ${name}`);
    }
  }
  
  return connections;
}

/**
 * Get available tools from MCP connections
 * @param connections Array of MCP connections
 * @returns Tools in AI SDK format
 */
export async function getMCPTools(connections: MCPConnection[]): Promise<any> {
  const tools: any = {};
  
  for (const connection of connections) {
    try {
      // List available tools from the MCP server
      const response = await connection.client.request({
        method: 'tools/list'
      });
      
      if (response.tools) {
        for (const tool of response.tools) {
          // Convert MCP tool to AI SDK format
          tools[tool.name] = {
            description: tool.description,
            parameters: tool.inputSchema || {},
            execute: async (args: any) => {
              const result = await connection.client.request({
                method: 'tools/call',
                params: {
                  name: tool.name,
                  arguments: args
                }
              });
              return result;
            }
          };
        }
      }
    } catch (error) {
      console.error(`Failed to get tools from ${connection.name}:`, error);
    }
  }
  
  return tools;
}