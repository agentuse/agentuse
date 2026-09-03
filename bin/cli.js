#!/usr/bin/env node
// Persist V8 bytecode for the 2.8 MB bundle so later starts skip re-compiling
// it (~35 ms per process, paid again by every serve worker spawn). Dynamic
// import on purpose: a static one would be hoisted above the enable call.
import { enableCompileCache } from 'node:module';
try { enableCompileCache?.(); } catch { /* older runtime or read-only tmp: run uncached */ }
await import('../dist/index.js');
