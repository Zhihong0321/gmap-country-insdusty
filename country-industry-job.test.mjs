import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {spawn} from 'node:child_process';
import {countryIndustry} from './country-industry-job.mjs';

test('job rejects invalid inputs and returns actual CSV and coverage metadata',async()=>{
  await assert.rejects(countryIndustry({country:' ',industry:'x'}),{code:'bad_request'});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'country-job-test-'));
  try{
    const execute=async args=>{const dir=args[args.indexOf('--output')+1];fs.writeFileSync(path.join(dir,'companies.csv'),'name,email\r\nExample,info@example.com\r\n');fs.writeFileSync(path.join(dir,'maps.json'),JSON.stringify({businesses:[{}],scans:[{possibleLimit:true}]}));fs.writeFileSync(path.join(dir,'contacts.json'),JSON.stringify({summary:{processed:1,total:1}}));};
    const r=await countryIndustry({country:' Malaysia ',industry:'advertising'},{id:'job/1'},{root,execute});
    assert.equal(r.country,'Malaysia');assert.match(r.csv,/info@example.com/);assert.equal(r.summary.possibleLimits,1);
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('worker claims a country.industry job and posts its CSV to the broker',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'country-broker-test-'));
  const id='test-country-job';const dir=path.join(root,crypto.createHash('sha256').update(id).digest('hex').slice(0,24));fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir,'locations.txt'),'Stub location\n');
  fs.writeFileSync(path.join(dir,'research-plan.json'),JSON.stringify({country:'Testland',industry:'advertising',max:200}));
  fs.writeFileSync(path.join(dir,'maps.json'),JSON.stringify({version:1,plan:{keywords:['advertising'],places:['Stub location'],max:200},scans:[{keyword:'advertising',place:'Stub location',businesses:[],blocked:false}],businesses:[]}));
  let claimed=false,posted;let finish;const received=new Promise(resolve=>finish=resolve);
  const server=http.createServer((req,res)=>{
    if(req.method==='GET'&&req.url.startsWith('/api/jobs/next')){if(!claimed){claimed=true;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({job:{id,type:'country.industry',payload:{country:'Testland',industry:'advertising'}}}));}else{res.writeHead(204);res.end();}return;}
    if(req.method==='POST'&&req.url===`/api/jobs/${id}/result`){let body='';req.on('data',x=>body+=x);req.on('end',()=>{posted=JSON.parse(body);res.writeHead(200,{'content-type':'application/json'});res.end('{}');finish();});return;}
    res.writeHead(200,{'content-type':'application/json'});res.end('{}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const child=spawn(process.execPath,['worker.mjs'],{cwd:process.cwd(),env:{...process.env,LAB_URL:`http://127.0.0.1:${server.address().port}`,LAB_TOKEN:'test',WORKER_TYPES:'country.industry',WORKER_NAME:'test-country-worker',WORKER_DASHBOARD_DISABLE:'1',COUNTRY_INDUSTRY_JOB_ROOT:root},stdio:'ignore'});
  try{
    let timeout;await Promise.race([received,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('worker did not report result')),15000);})]).finally(()=>clearTimeout(timeout));
    assert.equal(posted.ok,true);assert.equal(posted.result.country,'Testland');assert.match(posted.result.csv,/^name,category,address,phone,website,/);assert.equal(posted.result.summary.processed,0);
  }finally{child.kill('SIGTERM');await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
});

test('progress parser reports Maps and contact milestones from streamed process output',async()=>{
  const {createProgressParser}=await import('./country-industry-job.mjs');const events=[];const parse=createProgressParser(x=>events.push(x));
  parse(Buffer.from('Planned 3 cit'));parse(Buffer.from('ies.\n{"place":"KL","found":10}\n'));
  parse(Buffer.from('Finished 3 searches; 20 unique listings.\nBeginning website research: 0/20\nProcessed 7/20: Example (ok)\n'));
  assert.deepEqual(events.map(x=>[x.phase,x.completed,x.total]),[['maps',0,3],['maps',1,3],['maps',3,3],['contacts',0,20],['contacts',7,20]]);
});
