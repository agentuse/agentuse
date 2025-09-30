#!/usr/bin/env node

// Wrapper to run the TypeScript CLI
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Try compiled version first, fall back to source
const cliPath = join(__dirname, '..', 'dist', 'index.js');

try {
  await import(cliPath);
} catch (error) {
  // Fall back to source with tsx in development
  console.error('Note: Running from source. Run `npm run build` for production.');
  const { register } = await import('tsx/esm/api');
  register();
  await import(join(__dirname, '..', 'src', 'index.ts'));
}