#!/usr/bin/env node
// Deterministic, public-page website contact research for the job worker.
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {researchWebsite} from './country-industry-research.mjs';

/** Queue payload: {website: 'https://company.example'}; no LLM or browser required. */
export async function contacts(payload) {
  const website=payload?.website ?? payload?.url;
  if(typeof website!=='string' || !website.trim() || website.length>2048) {
    const e=new Error('website.contacts requires a website URL'); e.code='bad_request'; throw e;
  }
  let url;
  try {url=new URL(website.trim());} catch {const e=new Error('website must be an absolute HTTP(S) URL'); e.code='bad_request'; throw e;}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password) {const e=new Error('website must be an absolute HTTP(S) URL without credentials');e.code='bad_request';throw e;}
  return {website:url.href,...await researchWebsite(url.href)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  contacts({website:process.argv[2]}).then(result=>console.log(JSON.stringify(result,null,2))).catch(err=>{console.error(err.message);process.exitCode=1;});
}
