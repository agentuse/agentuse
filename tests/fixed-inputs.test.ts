import { expect, it } from 'bun:test';
import { inputCandidates, buildFixedInputPack } from '../src/replay/fixed-inputs';
const recording: any = { sessionId: 'source', sourceTask: 'Create the deliverable from selected evidence', userPrompt: 'Discover live and publish after approval', original: { text: 'OLD DRAFT' }, calls: [
  { id:'web', tool:'fetch_page', state:{status:'completed',input:{url:'https://example.org'},output:'Evidence from a page.'} },
  { id:'db', tool:'query_database', state:{status:'completed',input:{query:'SELECT count(*)'},output:{count:12}} },
  { id:'write', tool:'tools__filesystem_write', state:{status:'completed',input:{content:'OLD DRAFT'},output:'success'} },
  { id:'read', tool:'tools__filesystem_read', state:{status:'completed',input:{file_path:'draft.txt'},output:'OLD DRAFT'} },
] };
const decisions = () => ({decisions:[
  {partId:'web',classification:'source-input',reason:'external page',excerpts:['Evidence from a page.']},
  {partId:'db',classification:'source-input',reason:'external query result',excerpts:['{"count":12}']},
  {partId:'write',classification:'agent-produced',reason:'draft write',excerpts:[]},
  {partId:'read',classification:'agent-produced',reason:'reads the draft just written',excerpts:[]},
],limitations:[]});
it('materializes exact evidence across tools and keeps rationale and old work out',()=>{
 const {pack,audit}=buildFixedInputPack(recording,inputCandidates(recording),decisions());
 expect(pack.sources.map(s=>s.content)).toEqual(['Evidence from a page.','{"count":12}']);
 expect(JSON.stringify(pack)).not.toContain('OLD DRAFT');
 expect(JSON.stringify(pack)).not.toContain('Discover live');
 expect(audit.sourceTask).toBe(recording.sourceTask);
 expect(audit.originalUserPrompt).toBe(recording.userPrompt);
 expect(JSON.stringify(pack)).not.toContain('external page');
 expect(audit.decisions).toHaveLength(4);
});
it('rejects recursive media wrappers and current SDK media parts as evidence',()=>{
 for (const output of [
  {nested:{_media:[]}}, {nested:{__mediaCacheRef:'cached-image'}},
  {content:[{type:'image',data:'bytes'}]}, {content:[{type:'audio',data:'bytes'}]},
  {content:[{type:'image-data',data:'bytes'}]}, {content:[{type:'file-data',data:'bytes'}]},
 ]) {
  const candidates=inputCandidates({...recording,calls:[{id:'media',tool:'fetch_media',state:{status:'completed',input:{},output}}]});
  expect(candidates[0]?.selectable).toBe(false);
 }
});
it('rejects fabricated, unknown, duplicate and incomplete selections',()=>{
 for(const mutate of [
  (s:any)=>{s.decisions[0].excerpts=['invented'];},
  (s:any)=>{s.decisions[0].partId='unknown';},
  (s:any)=>{s.decisions.push(s.decisions[0]);},
  (s:any)=>{s.decisions.pop();},
  (s:any)=>{s.decisions[0].excerpts.push('Evidence');},
 ]) {const s=decisions();mutate(s);expect(()=>buildFixedInputPack(recording,inputCandidates(recording),s)).toThrow();}
});
it('rejects selecting known mutations or leaking non-source text',()=>{
 const s=decisions();s.decisions[2]!.classification='source-input';s.decisions[2]!.excerpts=['success'];
 expect(()=>buildFixedInputPack(recording,inputCandidates(recording),s)).toThrow();
 const t=decisions();t.decisions[3]!.excerpts=['OLD DRAFT'];
 expect(()=>buildFixedInputPack(recording,inputCandidates(recording),t)).toThrow();
});
