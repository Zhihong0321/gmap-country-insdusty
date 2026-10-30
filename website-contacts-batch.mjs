#!/usr/bin/env node
// Run the deterministic contact stage over a saved Maps business list.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {contacts} from './website-contacts.mjs';

function save(file,state) {
  const temp=file+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(state,null,2));
  fs.renameSync(temp,file);
}
export async function runBatch(businesses,{output,concurrency=4,research=contacts}={}) {
  if(!Array.isArray(businesses) || !output || !Number.isInteger(concurrency) || concurrency<1 || concurrency>20) throw new Error('Expected a business array, output file, and concurrency between 1 and 20.');
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify(businesses)).digest('hex');
  const state=fs.existsSync(output)?JSON.parse(fs.readFileSync(output,'utf8')):{version:1,inputFingerprint:fingerprint,total:businesses.length,results:{}};
  if(state.inputFingerprint!==fingerprint) throw new Error('The output belongs to a different input list; choose a new output file.');
  const pending=businesses.map((_,i)=>i).filter(i=>!state.results[i] || ['failed','partial','blocked'].includes(state.results[i].contact?.status));
  let cursor=0;
  save(output,state);
  async function worker() {
    while(cursor<pending.length) {
      const i=pending[cursor++], business=businesses[i];
      let contact;
      try {contact=business.website?await research({website:business.website}):{website:null,status:'no_website',emails:[],phones:[],people:[],links:[],pages:[],errors:[]};}
      catch(error) {contact={website:business.website??null,status:'failed',emails:[],phones:[],people:[],links:[],pages:[],errors:[{url:business.website??null,error:error.message}]};}
      const previous=state.results[i]?.contact;
      // A retry must not erase useful contacts from an earlier partial crawl.
      if(previous?.status==='partial') {
        for(const [field,key] of [['emails','email'],['phones','normalized'],['people','name'],['links','url']]) {
          const merged=new Map();
          for(const item of [...(previous[field]||[]),...(contact[field]||[])]) if(!merged.has(item[key])) merged.set(item[key],item);
          contact[field]=[...merged.values()];
        }
        contact.pages=[...new Set([...(previous.pages||[]),...(contact.pages||[])])];
        if(contact.status==='failed'||contact.status==='blocked') contact.status='partial';
      }
      state.results[i]={business,contact};
      state.updatedAt=new Date().toISOString();
      save(output,state);
      console.log(`Processed ${Object.keys(state.results).length}/${businesses.length}: ${business.name || business.website || 'unnamed'} (${contact.status})`);
    }
  }
  await Promise.all(Array.from({length:Math.min(concurrency,pending.length)},()=>worker()));
  const results=Object.values(state.results);
  const summary={total:businesses.length,processed:results.length,withEmail:results.filter(x=>x.contact.emails?.length).length,withPhone:results.filter(x=>x.contact.phones?.length).length,failed:results.filter(x=>x.contact.status==='failed').length,partial:results.filter(x=>x.contact.status==='partial').length,blocked:results.filter(x=>x.contact.status==='blocked').length,noWebsite:results.filter(x=>x.contact.status==='no_website').length};
  state.summary=summary; save(output,state); return state;
}
async function main() {
  const flags={};for(let i=2;i<process.argv.length;i++){const k=process.argv[i];if(!['--input','--output','--concurrency'].includes(k)||!process.argv[i+1])throw new Error('Usage: node website-contacts-batch.mjs --input listings.json --output contacts.json [--concurrency 4]');flags[k.slice(2)]=process.argv[++i];}
  if(!flags.input||!flags.output)throw new Error('Both --input and --output are required.');
  const value=JSON.parse(fs.readFileSync(flags.input,'utf8'));const businesses=Array.isArray(value)?value:value.businesses;
  const state=await runBatch(businesses,{output:path.resolve(flags.output),concurrency:Number(flags.concurrency||4)});
  console.log(JSON.stringify(state.summary));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(err=>{console.error(err.message);process.exitCode=1;});
