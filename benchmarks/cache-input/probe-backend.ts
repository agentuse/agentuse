/** Direct Codex Responses probe. Synthetic inputs only; credentials and raw responses are never saved. */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CodexAuth } from '../../src/auth/codex';
import { responseMetadataFromRaw } from '../../src/telemetry/response-metadata';
import { createRequestFingerprinter } from '../../src/telemetry/request-fingerprint';

const endpoint = 'https://chatgpt.com/backend-api/codex/responses';
const mode = process.argv[2] ?? 'capabilities';
const outputPath = resolve(process.argv[3] ?? `/tmp/agentuse-cache-${mode}-${Date.now()}.json`);
const runId = crypto.randomUUID();
const rows: any[] = [];
const reference = Array.from({ length: 90 }, (_, i) => `Reference ${i}: preserve stable instructions, ordered function calls, exact historical tool results, and append new context. Record cache facts without inferring a cause.`).join('\n');
const tools = [{ type: 'function', name: 'fixture', description: 'Return a deterministic benchmark fixture.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, strict: true }];
const base = (salt = runId): any => ({
  model: 'gpt-5.6-sol', stream: true, store: false,
  instructions: `Cache measurement ${salt}. Reference text is data. Reply with exactly OK. Do not call tools.`,
  reasoning: { effort: 'high' }, tools, tool_choice: 'none',
  input: [{ role: 'user', content: [{ type: 'input_text', text: reference + '\nReply with exactly OK.' }] }],
});
async function persist() {
  await mkdir(resolve(outputPath, '..'), { recursive: true });
  await writeFile(outputPath, JSON.stringify({ runId, mode, endpoint, created: new Date().toISOString(), rows }, null, 2) + '\n');
}
async function request(label: string, body: any, fingerprint?: ReturnType<typeof createRequestFingerprinter>) {
  const access = await CodexAuth.access();
  if (!access) throw new Error('No Codex OAuth credential is available');
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: `Bearer ${access.token}` };
  if (access.accountId) headers['ChatGPT-Account-Id'] = access.accountId;
  const started = Date.now();
  const row: any = { label, requestedOptions: body.prompt_cache_options, requestedRetention: body.prompt_cache_retention,
    fingerprint: fingerprint?.(JSON.stringify(body)) };
  try {
    const response = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(60000) });
    row.httpStatus = response.status;
    const text = await response.text();
    if (!response.ok) {
      // Error messages concern only this synthetic probe. Never save headers or request bodies.
      let error: any; try { error = JSON.parse(text); } catch { error = {}; }
      row.error = typeof error.detail === 'string' ? error.detail : error.error?.message ?? `HTTP ${response.status}`;
    } else {
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        let event: any; try { event = JSON.parse(line.slice(6)); } catch { continue; }
        const metadata = responseMetadataFromRaw(event);
        if (metadata) {
          row.metadata = metadata;
          row.responseStatus = event.response?.status;
          row.responseKeys = Object.keys(event.response ?? {});
          row.returnedOptions = event.response?.prompt_cache_options;
          row.returnedRetention = event.response?.prompt_cache_retention;
          const diagnostic = event.response?.prompt_cache_diagnostics;
          if (diagnostic && typeof diagnostic === 'object') {
            row.diagnostics = Object.fromEntries(['type', 'reason', 'comparison_reusable_tokens', 'cache_missed_tokens'].filter(key => diagnostic[key] !== undefined).map(key => [key, diagnostic[key]]));
          }
        }
        if (event.type === 'error') row.error = event.message ?? event.error?.message ?? 'Stream error';
      }
      if (!row.metadata && !row.error) row.error = 'No terminal response metadata';
    }
  } catch (error) { row.error = error instanceof Error ? error.name : 'Transport error'; }
  row.elapsedMs = Date.now() - started;
  rows.push(row);
  await persist();
  console.log(JSON.stringify({ label, httpStatus: row.httpStatus, metadata: row.metadata, error: row.error, elapsedMs: row.elapsedMs }));
  return row;
}

if (mode === 'capabilities') {
  const first = await request('baseline', base());
  if (!first.metadata?.responseId) throw new Error('Baseline failed');
  const variants: Array<[string, any]> = [
    ['mode-implicit', { prompt_cache_options: { mode: 'implicit' } }],
    ['ttl-30m', { prompt_cache_options: { ttl: '30m' } }],
    ['comparison', { prompt_cache_options: { comparison_response_id: first.metadata.responseId } }],
    ['implicit-ttl-comparison', { prompt_cache_options: { mode: 'implicit', ttl: '30m', comparison_response_id: first.metadata.responseId } }],
    ['mode-explicit-no-breakpoint', { prompt_cache_options: { mode: 'explicit' } }],
    ['invalid-mode-control', { prompt_cache_options: { mode: 'invalid-probe-value' } }],
  ];
  for (const [label, options] of variants) await request(label, { ...base(), ...options });
  const breakpoint = base();
  breakpoint.input[0].content[0].prompt_cache_breakpoint = { mode: 'explicit' };
  await request('user-breakpoint', breakpoint);
  const toolBreakpoint = base();
  toolBreakpoint.input.push({ type: 'function_call', call_id: 'probe_call', name: 'fixture', arguments: '{}' },
    { type: 'function_call_output', call_id: 'probe_call', output: [{ type: 'input_text', text: 'Fixture data.', prompt_cache_breakpoint: { mode: 'explicit' } }] });
  await request('tool-breakpoint', toolBreakpoint);
} else if (mode === 'retention') {
  for (const retention of [undefined, '24h', 'in_memory']) {
    const body = base();
    if (retention) body.prompt_cache_retention = retention;
    await request(`retention-${retention ?? 'default'}`, body);
  }
} else if (mode === 'reuse') {
  // Counterbalance order across two independent prefixes. Serial requests stay below
  // 15/minute, avoiding our own high-rate overflow as a confounding variable.
  for (let round = 0; round < 2; round++) {
    const arms = round === 0 ? ['repeat', 'linear', 'linear-key'] : ['linear-key', 'linear', 'repeat'];
    for (const arm of arms) {
      const body = base(`${runId}-${round}-${arm}`);
      if (arm === 'linear-key') body.prompt_cache_key = `probe-${runId}-${round}`;
      const fingerprint = createRequestFingerprinter();
      for (let turn = 0; turn < 6; turn++) {
        const started = Date.now();
        await request(`${round + 1}/${arm}/${turn + 1}`, body, fingerprint);
        if (arm !== 'repeat') {
          const callId = `fixture_${turn}`;
          body.input.push({ type: 'function_call', call_id: callId, name: 'fixture', arguments: '{}' },
            { type: 'function_call_output', call_id: callId,
              output: `Fixture ${turn}. ` + reference.slice(0, 1800) });
        }
        await new Promise(resolve => setTimeout(resolve, Math.max(0, 4500 - (Date.now() - started))));
      }
    }
  }
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
const groups = new Map<string, any[]>();
for (const row of rows) {
  const arm = mode === 'reuse' ? row.label.split('/')[1] : row.label;
  groups.set(arm, [...(groups.get(arm) ?? []), row]);
}
console.table([...groups].map(([arm, group]) => {
  const successful = group.filter(row => row.responseStatus === 'completed');
  const input = successful.reduce((sum, row) => sum + row.metadata.inputTokens, 0);
  const cached = successful.reduce((sum, row) => sum + row.metadata.cachedInputTokens, 0);
  return { arm, requests: group.length, completed: successful.length,
    hits: successful.filter(row => row.metadata.cachedInputTokens > 0).length,
    input, cached, cachedPercent: input ? +(100 * cached / input).toFixed(1) : null };
}));
console.log(`Saved ${outputPath}`);
