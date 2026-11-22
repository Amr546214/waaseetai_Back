import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';

test('all assessment routes containing questions or mutating exams reject a normal browser, including existing-attempt status', async t => {
 const dir=mkdtempSync(join(tmpdir(),'seb-routes-')); const file=join(dir,'approved.seb'); writeFileSync(file,'test-config');
 const old={...process.env};
 Object.assign(process.env,{EXAM_SEB_MODE:'required',EXAM_SEB_CONFIG_FILE:file,EXAM_SEB_CONFIG_FILE_SHA256:createHash('sha256').update('test-config').digest('hex'),EXAM_SEB_BROWSER_EXAM_KEYS:'a'.repeat(64),EXAM_PUBLIC_ORIGIN:'https://dev.example.test'});
 t.after(()=>{for(const k of Object.keys(process.env)) if(!(k in old)) delete process.env[k];Object.assign(process.env,old);rmSync(dir,{recursive:true});});
 const next=(_q:any,_s:any,n:any)=>n();
 const reached=(_q:any,s:any)=>s.json({questions:['must not leak']});
 mock.module('../middlewares/auth.middleware',{namedExports:{authenticate:next,requireActiveUser:next,authorize:()=>next}});
 mock.module('../middlewares/rate-limit.middleware',{namedExports:{aiLimiter:next,apiLimiter:next}});
 mock.module('../controllers/ai-assessment.controller',{namedExports:{generateAssessmentController:reached,submitAssessmentController:reached,getAttemptStatusController:reached}});
 mock.module('../controllers/exam-attempt.controller',{namedExports:{getActiveAttempt:reached,saveAttemptAnswers:reached,logAttemptEvent:reached}});
 const {default:router}=await import('./ai-assessment.routes');
 const app=express();app.use('/api/assessments',router);
 const server=app.listen(0,'127.0.0.1'); await new Promise<void>(r=>server.once('listening',r));t.after(()=>new Promise<void>((r,j)=>server.close(e=>e?j(e):r())));
 const base=`http://127.0.0.1:${(server.address() as any).port}/api/assessments`;
 for(const [method,path] of [['GET','/active'],['GET','/existing/status'],['POST','/generate'],['PUT','/existing/answers'],['POST','/existing/events'],['POST','/existing/submit']]) {
  const r=await fetch(base+path,{method,headers:{'User-Agent':'SafeExamBrowser'}});const body=await r.json();
  assert.equal(r.status,403,path);assert.equal(body.code,'EXAM_ENVIRONMENT_REQUIRED',path);assert.equal(body.questions,undefined,path);
 }
});
