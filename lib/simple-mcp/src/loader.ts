import { resolve } from 'path';
import { pathToFileURL } from 'url';
import type { ToolModuleExport, ToolDefinition } from './types.js';

/**
 * Load a tool module from a file path
 * Supports both default export and named exports
 *
 * @param toolPath - Absolute or relative path to the tool file
 * @returns The loaded module (single tool or multiple tools)
 * @throws Error if no valid tool exports are found
 */
export async function loadToolModule(toolPath: string): Promise<ToolModuleExport> {
  const resolvedPath = resolve(toolPath);
  const fileUrl = pathToFileURL(resolvedPath).href;

  let module;
  try {
    module = await import(fileUrl);
  } catch (error) {
    throw new Error(
      `Failed to load tool module from ${toolPath}: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  // Support default export (single tool)
  if (module.default) {
    if (isValidToolDefinition(module.default)) {
      return module.default;
    }
    throw new Error(`Default export in ${toolPath} is not a valid tool definition`);
  }

  // Support named exports (multiple tools)
  const tools: Record<string, ToolDefinition> = {};
  for (const [key, value] of Object.entries(module)) {
    if (isValidToolDefinition(value)) {
      tools[key] = value as ToolDefinition;
    }
  }

  if (Object.keys(tools).length === 0) {
    throw new Error(
      `No valid tool exports found in ${toolPath}. ` +
      `Tools must have 'description', 'parameters', and 'execute' properties.`
    );
  }

  return tools;
}

/**
 * Check if a value is a valid tool definition
 */
function isValidToolDefinition(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'description' in value &&
    'parameters' in value &&
    'execute' in value &&
    typeof (value as any).execute === 'function'
  );
}

/**
 * Load a specific export from a tool file
 *
 * @param toolPath - Path to the tool file
 * @param exportName - Name of the export to load
 * @returns The tool definition
 * @throws Error if export not found or invalid
 */
export async function loadSpecificExport(
  toolPath: string,
  exportName: string
): Promise<ToolDefinition> {
  const module = await loadToolModule(toolPath);

  // If module is a single tool (default export), check the name matches
  if ('execute' in module) {
    throw new Error(
      `Tool file ${toolPath} has a default export. ` +
      `Cannot load specific export '${exportName}'. ` +
      `Remove the export name or use named exports.`
    );
  }

  // Module has named exports
  const tool = (module as Record<string, ToolDefinition>)[exportName];
  if (!tool) {
    const availableExports = Object.keys(module as Record<string, ToolDefinition>);
    throw new Error(
      `Export '${exportName}' not found in ${toolPath}. ` +
      `Available exports: ${availableExports.join(', ')}`
    );
  }

  return tool;
}