#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const sessionId = process.argv[2];
if (!/^01[A-Z0-9]+$/.test(sessionId ?? '')) {
  throw new Error('Usage: node benchmarks/cache-input/analyze-session.mjs <session-id>');
}

const pathResult = spawnSync('agentuse', ['sessions', 'path'], { encoding: 'utf8' });
if (pathResult.status !== 0) throw new Error(pathResult.stderr || 'Could not locate sessions');
const sessionsRoot = pathResult.stdout.match(/^Sessions:\s+(.+)$/m)?.[1];
if (!sessionsRoot) throw new Error('Sessions path was not reported');
const sessionMatches = (await readdir(sessionsRoot)).filter(name => name.startsWith(sessionId));
if (sessionMatches.length === 0) throw new Error(`Session not found: ${sessionId}`);
if (sessionMatches.length > 1) throw new Error(`Session prefix is ambiguous: ${sessionId}`);
const [sessionDirName] = sessionMatches;
const sessionDir = join(sessionsRoot, sessionDirName);
const messageDirName = (await readdir(sessionDir)).find(name => /^01[A-Z0-9]+$/.test(name));
if (!messageDirName) throw new Error('Primary message directory not found');
const partDir = join(sessionDir, messageDirName, 'part');

const rows = new Map();
const parts = [];
for (const file of (await readdir(partDir)).filter(file => file.endsWith('.json')).sort()) {
  parts.push(JSON.parse(await readFile(join(partDir, file), 'utf8')));
}
const recordedStepIds = new Set(parts
  .filter(part => part.type === 'step-finish' && part.modelStepUsage?.stepId)
  .map(part => part.modelStepUsage.stepId));
const fixtureCalls = [];
for (const part of parts) {
  const command = part?.state?.input?.command;
  const label = typeof command === 'string' ? command.match(/--label\s+([a-z0-9-]+)/i)?.[1] : undefined;
  if (label) {
    fixtureCalls.push({
      label,
      callOrder: part.id,
      completedAt: part?.state?.time?.end ?? null,
    });
  }
  const isStepRecord = part.type === 'step-finish';
  const usage = isStepRecord ? part.modelStepUsage : part?.state?.metadata?.modelStepUsage;
  if (!usage || (!isStepRecord && recordedStepIds.has(usage.stepId))) continue;
  const fingerprint = usage.requestFingerprint;
  const metadata = usage.responseMetadata;
  const key = isStepRecord ? part.id : usage.stepId ?? fingerprint?.allHash ?? part.id;
  if (rows.has(key)) continue;
  rows.set(key, {
    request: rows.size + 1,
    input: usage.input,
    cached: metadata ? metadata.cachedInputTokens : usage.cachedInput,
    cacheWrite: metadata?.cacheWriteTokens,
    ordinaryUncached: metadata?.uncachedInputTokens,
    responseId: metadata?.responseId,
    model: metadata?.model,
    serviceTier: metadata?.serviceTier,
    diagnosticType: metadata?.diagnosticType,
    diagnosticReason: metadata?.diagnosticReason,
    output: usage.output,
    prefix: fingerprint?.prefixUnchanged ?? null,
    all: fingerprint?.allHash?.slice(0, 12),
  });
}

const ordered = [...rows.values()].sort((left, right) => left.request - right.request);
console.table(ordered);
const comparisons = ordered.slice(1);
const sum = key => ordered.reduce((total, row) => total + (row[key] ?? 0), 0);
const totalInput = sum('input');
const totalCached = sum('cached');
const resolvedSessionId = sessionDirName.match(/^01[A-Z0-9]{24}/)?.[0] ?? sessionId;
const callOrder = fixtureCalls.toSorted((left, right) => left.callOrder.localeCompare(right.callOrder)).map(call => call.label);
const completionOrder = fixtureCalls.toSorted((left, right) => (left.completedAt ?? 0) - (right.completedAt ?? 0)).map(call => call.label);
console.log(JSON.stringify({
  session: resolvedSessionId,
  requests: ordered.length,
  totals: {
    input: totalInput,
    cachedInput: ordered.every(row => row.cached !== undefined) ? totalCached : null,
    // Includes writes; not the ordinary uncached category.
    uncachedInput: ordered.every(row => row.cached !== undefined) ? totalInput - totalCached : null,
    cacheWriteTokens: ordered.every(row => row.cacheWrite !== undefined) ? sum('cacheWrite') : null,
    ordinaryUncachedInput: ordered.every(row => row.ordinaryUncached !== undefined) ? sum('ordinaryUncached') : null,
    output: sum('output'),
  },
  unchangedPrefixes: comparisons.filter(row => row.prefix === true).length,
  changedPrefixes: comparisons.filter(row => row.prefix === false).map(row => row.request),
  zeroCacheRequests: ordered.filter(row => row.cached === 0).map(row => row.request),
  cacheHits: ordered.filter(row => row.cached > 0).map(row => ({ request: row.request, cached: row.cached })),
  ...(callOrder.length > 0 && { toolCalls: { callOrder, completionOrder } }),
}, null, 2));
