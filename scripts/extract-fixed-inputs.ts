/** Select evidence from a session, independent of its tools or output format. */
import { streamText } from 'ai';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import dotenv from 'dotenv';
import { createModel } from '../src/models';
import { loadGlobalDefaults } from '../src/utils/global-config';
import { resolveProjectContext } from '../src/utils/project';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { loadReplayRecording } from '../src/replay/recording';
import { inputCandidates, SELECT_INPUTS_PROMPT, buildFixedInputPack } from '../src/replay/fixed-inputs';
const [sessionId, outputDir, model = 'openai:gpt-5.6-sol'] = process.argv.slice(2);
if (!sessionId || !outputDir) throw new Error('Usage: extract-fixed-inputs <session-id> <new-output-directory> [provider:model] (run from source project)');
try { await access(outputDir); throw new Error('Output directory already exists; choose a fresh directory'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
loadGlobalDefaults();
const context = resolveProjectContext(process.cwd());
dotenv.config({ path: context.envFile, quiet: true });
await initStorage(context.stateRoot);
const recording = await loadReplayRecording(new SessionManager(), sessionId);
const candidates = inputCandidates(recording);
const prompt = JSON.stringify({ originalUserPrompt: recording.userPrompt, records: candidates });
if (prompt.length > 240_000) throw new Error('Session exceeds selection context budget; split into explicit segments before extraction. Nothing was truncated.');
const result = streamText({ model: await createModel(model), system: SELECT_INPUTS_PROMPT, prompt,
  ...(model.startsWith('openai:') ? { providerOptions: { openai: { store: false, instructions: SELECT_INPUTS_PROMPT, reasoningEffort: 'medium' } } } : { maxOutputTokens: 16000 }),
  maxRetries: 1, abortSignal: AbortSignal.timeout(180_000),
  onError: ({error}) => console.error(error instanceof Error ? error.message : String(error)),
});
const rawText = await result.text;
const { pack, audit } = buildFixedInputPack(recording, candidates, JSON.parse(rawText));
// Refuse overwriting an earlier fixed pack. Audit rationale is kept separate.
await mkdir(outputDir, { recursive: false });
for (const [file, data] of Object.entries({ 'input-pack.json': pack, 'selection-audit.json': { model, ...audit, usage: await result.usage },
  'source-records.json': candidates, 'baseline.json': recording.original })) {
  await writeFile(resolve(outputDir,file), JSON.stringify(data,null,2)+'\n', { mode: 0o600, flag: 'wx' });
}
console.log(JSON.stringify({ outputDir, records: candidates.length, sources: pack.sources.length,
  excluded: audit.decisions.filter(d=>d.classification!=='source-input').length, model }));
