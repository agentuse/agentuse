import { expect, it } from 'bun:test';
import { runOutputLoop, outputJudgmentSchema } from '../src/replay/output-loop';
const verdict = (pass:boolean) => ({pass,understanding:'A direct answer',critique:pass?'Pass.':'Unsupported factual claim.'});
it('feeds revised instructions to a fresh writer and stops on a pass',async()=>{
 const writerInputs:any[]=[];const saved:any[]=[];
 const result=await runOutputLoop({maxRounds:3,
 generate:async input=>{writerInputs.push(input);return input.round===1?'First output':'Second output';},
 evaluate:async(_,round)=>verdict(round===2),
 revise:async()=>({guidance:'Separate preference from fact.',reason:'Address unsupported claim.'}),
 saveRound:async r=>{saved.push(structuredClone(r));}});
 expect(result.status).toBe('passed');expect(result.rounds).toHaveLength(2);
 expect(writerInputs).toEqual([{round:1,guidance:''},{round:2,guidance:'Separate preference from fact.'}]);
 expect(JSON.stringify(writerInputs)).not.toContain('First output');
 expect(saved).toHaveLength(3);
});
it('stops at the bound without revising or accepting a failed final output',async()=>{
 let revisions=0;
 const result=await runOutputLoop({maxRounds:3,generate:async r=>`Output ${r.round}`,evaluate:async()=>verdict(false),
 revise:async()=>({guidance:`Guidance ${++revisions}`,reason:'Failed evidence check.'}),saveRound:async()=>{}});
 expect(result.status).toBe('exhausted');expect(result.rounds).toHaveLength(3);expect(revisions).toBe(2);
});
it('does not revise a passing draft',async()=>{
 const result=await runOutputLoop({maxRounds:3,generate:async()=> 'Good output',evaluate:async()=>verdict(true),
 revise:async()=>{throw new Error('Should not revise');},saveRound:async()=>{}});
 expect(result.status).toBe('passed');expect(result.rounds).toHaveLength(1);
});
it('rejects empty outputs instead of treating them as successful',async()=>{
 await expect(runOutputLoop({maxRounds:3,generate:async()=>'',evaluate:async()=>verdict(true),
 revise:async()=>({guidance:'unused',reason:'unused'}),saveRound:async()=>{}})).rejects.toThrow('no output');
});

it('accepts an empty passing critique but rejects an empty failing critique',()=>{
 expect(outputJudgmentSchema.parse({pass:true,understanding:'Fits the conversation.',critique:''}).pass).toBe(true);
 expect(()=>outputJudgmentSchema.parse({pass:false,understanding:'Unsupported.',critique:''})).toThrow();
});
