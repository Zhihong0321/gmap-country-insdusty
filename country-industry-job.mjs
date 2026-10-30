// Queue adapter for the complete country + industry pipeline.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const HERE=path.dirname(fileURLToPath(import.meta.url));
function invalid(message){const error=new Error(message);error.code='bad_request';return error;}
export function normalizePayload(payload){
  if(!payload || typeof payload!=='object' || Array.isArray(payload))throw invalid('country.industry requires an object with country and industry');
  const {country,industry}=payload;
  if(typeof country!=='string'||!country.trim()||country.length>120||typeof industry!=='string'||!industry.trim()||industry.length>160)throw invalid('country and industry must be nonempty strings');
  return {country:country.trim(),industry:industry.trim()};
}
export function createProgressParser(send) {
  let pending='', total=null, mapsDone=0;
  return chunk => {
    pending += chunk.toString();
    let pos;
    while ((pos=pending.indexOf('\n')) !== -1) {
      const line=pending.slice(0,pos).trim(); pending=pending.slice(pos+1);
      let m=/^Planned (\d+) cities/.exec(line);
      if(m) {total=Number(m[1]);send({phase:'maps',completed:mapsDone,total,message:'Searching Google Maps'});continue;}
      m=/^Resumed (\d+) completed searches/.exec(line);
      if(m) {mapsDone=Number(m[1]);send({phase:'maps',completed:mapsDone,total,message:'Searching Google Maps'});continue;}
      if(line.startsWith('{')) {try {const x=JSON.parse(line);if(x.place && ('found' in x || 'blocked' in x)){mapsDone++;send({phase:'maps',completed:mapsDone,total,message:'Searching Google Maps'});}}catch{}}
      m=/^Finished (\d+) searches;/.exec(line);
      if(m) {mapsDone=Number(m[1]);send({phase:'maps',completed:mapsDone,total:total || mapsDone,message:'Maps search complete'});continue;}
      m=/^(?:Processed (\d+)\/(\d+):|(?:Beginning|Completed) website research: (\d+)\/(\d+))/.exec(line);
      if(m) send({phase:'contacts',completed:Number(m[1]??m[3]),total:Number(m[2]??m[4]),message:'Researching company websites'});
    }
  };
}
function execute(args,onProgress=()=>{}){return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(HERE,'country-industry-research.mjs'),...args],{stdio:['ignore','pipe','pipe']});
  let last='';const parse=createProgressParser(onProgress);const capture=chunk=>{last=(last+chunk.toString()).slice(-12000);};child.stdout.on('data',chunk=>{capture(chunk);parse(chunk);});child.stderr.on('data',capture);
  child.on('error',reject);child.on('close',(code,signal)=>code===0?resolve():reject(new Error('country-industry pipeline stopped ('+(signal||code)+'): '+last.slice(-2000))));
});}
/** Return CSV as text in the broker's JSON result; the hub need not access local paths. */
export async function countryIndustry(payload,job=null,options={}){
  const plan=normalizePayload(payload);
  const root=options.root || process.env.COUNTRY_INDUSTRY_JOB_ROOT || path.join(os.homedir(),'.gmap-worker','country-industry');
  const identity=String(job?.id ?? crypto.randomUUID());
  const key=crypto.createHash('sha256').update(identity).digest('hex').slice(0,24);
  const output=path.join(root,key);fs.mkdirSync(output,{recursive:true});
  const runner=options.execute||execute;
  await runner(['--country',plan.country,'--industry',plan.industry,'--output',output],options.onProgress);
  const csvPath=path.join(output,'companies.csv'), mapsPath=path.join(output,'maps.json'), contactsPath=path.join(output,'contacts.json');
  if(!fs.existsSync(csvPath)||!fs.existsSync(mapsPath)||!fs.existsSync(contactsPath))throw new Error('pipeline finished without all expected result files');
  const maps=JSON.parse(fs.readFileSync(mapsPath,'utf8'));
  const contacts=JSON.parse(fs.readFileSync(contactsPath,'utf8'));
  const csv=fs.readFileSync(csvPath,'utf8');
  if(!contacts.summary||contacts.summary.processed!==maps.businesses.length) throw new Error('pipeline results are incomplete: not every listing was processed');
  return {country:plan.country,industry:plan.industry,filename:'country-industry-report.csv',contentType:'text/csv; charset=utf-8',csv,summary:{...contacts.summary,searches:maps.scans.length,possibleLimits:maps.scans.filter(s=>s.possibleLimit).length},coverageNote:'Maps search results are not an exhaustive census; some searches may be capped or incomplete.'};
}
