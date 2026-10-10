import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { initializeExactDatabase } from './exact-schema.js';
import { loadInterviewPrepReadModel } from '../src/projections.js';

it('projects canonical failed/history rows and explicit legacy without invented bindings', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'jobctrl-interview-v12-'));
  const file=path.join(dir,'synthetic.db');
  initializeExactDatabase(file);
  const db=new Database(file);
  try {
    db.pragma('foreign_keys=ON');
    db.prepare("INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','j','https://synthetic/post','Synthetic')").run();
    db.prepare("INSERT INTO job_interview_prep(tenant_id,job_id,generation,status,generated_at,gate_status) VALUES('local','j',1,'accepted','2026-10-01','passed')").run();
    db.prepare("INSERT INTO job_interview_prep_items(tenant_id,job_id,generation,item_id,kind,title,generated_text) VALUES('local','j',1,'i','theme','Legacy','Synthetic guide')").run();
    const legacy=loadInterviewPrepReadModel(db,'local','j',1);
    expect(legacy).toMatchObject({generationContext:null,staleReasons:['legacy_unbound'],items:[{questionMetadata:null}]});
    const context={schemaVersion:'1',selectedQuestionIds:['B01'],retained:'synthetic snapshot'};
    const question={questionId:'B01',cardRevision:'1',outline:[{text:'Synthetic outline'}]};
    db.prepare("INSERT INTO job_interview_prep(tenant_id,job_id,generation,status,generated_at,gate_status,generation_context_json) VALUES('local','j',2,'failed','2026-10-02','failed',?)").run(JSON.stringify(context));
    db.prepare("INSERT INTO job_interview_prep_items(tenant_id,job_id,generation,item_id,kind,title,generated_text,question_metadata_json) VALUES('local','j',2,'i','question_outline','Question','Synthetic outline',?)").run(JSON.stringify(question));
    expect(loadInterviewPrepReadModel(db,'local','j',2)).toMatchObject({status:'failed',generationContext:context,staleReasons:[],items:[{questionMetadata:question}]});
    expect(loadInterviewPrepReadModel(db,'other','j',2)).toBeNull();
    expect(loadInterviewPrepReadModel(db,'local','j',3)).toBeNull();
  } finally {db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
