#!/usr/bin/env node

// Wrapper script to run the TypeScript CLI with tsx if needed
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Check if we need to use tsx (in development) or run compiled JS (in production)
const cliPath = join(__dirname, '..', 'dist', 'cli.js');
const cliSourcePath = join(__dirname, '..', 'src', 'cli.ts');

// Try to import the compiled version first
try {
  await import(cliPath);
} catch (error) {
  // Fall back to source with tsx
  console.error('Note: Running from source with tsx. Run `npm run build` for production.');
  const { register } = await import('tsx/esm/api');
  register();
  await import(cliSourcePath);
}