#!/usr/bin/env node
// Discover businesses on Maps, then collect explicitly published contact details.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CITY_DATA = 'https://raw.githubusercontent.com/datasets/world-cities/main/data/world-cities.csv';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = text => String(text || '').normalize('NFKC').toLowerCase().trim();
const slug = text => normalize(text).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'research';
function csvRows(text) {
  const rows = []; let row = [], value = '', quoted = false;
  for (let i=0; i<text.length; i++) {
    const c=text[i];
    if (c==='"' && quoted && text[i+1]==='"') {value+='"'; i++;}
    else if (c==='"') quoted=!quoted;
    else if (c===',' && !quoted) {row.push(value); value='';}
    else if ((c==='\n' || c==='\r') && !quoted) {if(c==='\r' && text[i+1]==='\n') i++; row.push(value); if(row.some(Boolean)) rows.push(row); row=[]; value='';}
    else value+=c;
  }
  if (value || row.length) {row.push(value); rows.push(row);}
  return rows;
}
export function locationsFromCsv(csv, country) {
  const rows=csvRows(csv), header=rows.shift();
  const ci=header.indexOf('country'), ni=header.indexOf('name'), si=header.indexOf('subcountry');
  if ([ci,ni,si].includes(-1)) throw new Error('City dataset has an unexpected format');
  const matches=rows.filter(r=>normalize(r[ci])===normalize(country));
  const seen=new Set(), places=[];
  for (const r of matches) {
    const parts=[r[ni],r[si],r[ci]].filter(Boolean), place=[...new Set(parts)].join(', '), key=normalize(place);
    if (!seen.has(key)) {seen.add(key); places.push(place);}
  }
  return places;
}
function publicAddress(ip) {
  if (net.isIP(ip)===4) {
    const [a,b]=ip.split('.').map(Number);
    return !(a===0||a===10||a===127||a>=224||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19)));
  }
  if (net.isIP(ip)===6) {
    const s=ip.toLowerCase();
    return !(s==='::1'||s==='::'||s.startsWith('fc')||s.startsWith('fd')||/^fe[89ab]/.test(s)||s.startsWith('::ffff:'));
  }
  return false;
}
async function validateUrl(url) {
  const u=new URL(url);
  if (!['http:','https:'].includes(u.protocol) || u.username || u.password) throw new Error('unsupported website URL');
  const host=u.hostname.replace(/^\[|\]$/g,'');
  if (host==='localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new Error('non-public website');
  const addresses=net.isIP(host) ? [{address:host}] : await dns.lookup(host,{all:true});
  if (!addresses.length || addresses.some(a=>!publicAddress(a.address))) throw new Error('website resolves to a non-public address');
  return u;
}
async function getPage(url) {
  let current=url;
  for (let i=0;i<4;i++) {
    await validateUrl(current);
    const res=await fetch(current,{redirect:'manual',signal:AbortSignal.timeout(12000),headers:{'user-agent':'CountryIndustryResearch/1.0 (public business contact research)','accept':'text/html,application/xhtml+xml'}});
    if ([301,302,303,307,308].includes(res.status)) {const to=res.headers.get('location'); if(!to) throw new Error('redirect without location'); current=new URL(to,current).href; continue;}
    if (!res.ok) throw new Error('HTTP '+res.status);
    if (!/text\/html|application\/xhtml\+xml/i.test(res.headers.get('content-type') || '')) throw new Error('not an HTML page');
    const reader=res.body.getReader(); let chunks=[], total=0;
    try {while(true){const {done,value}=await reader.read(); if(done) break; total+=value.length; if(total>5000000) throw new Error('page too large'); chunks.push(value);}} finally {reader.releaseLock();}
    return {url:current,html:Buffer.concat(chunks.map(b=>Buffer.from(b))).toString('utf8')};
  }
  throw new Error('too many redirects');
}
const decode = s => String(s || '').replace(/&#(\d+);/g,(_,x)=>String.fromCodePoint(Number(x))).replace(/&#x([0-9a-f]+);/gi,(_,x)=>String.fromCodePoint(parseInt(x,16))).replace(/&amp;/gi,'&').replace(/&quot;/gi,'"').replace(/&apos;/gi,"'").replace(/&lt;/gi,'<').replace(/&gt;/gi,'>');
export function extractContacts(html, sourceUrl) {
  const emails=new Map(), phones=new Map(), people=[], links=new Map();
  const addEmail=raw=>{
    let val=decode(raw).replace(/^mailto:/i,'').split('?')[0].trim();
    try { val=decodeURIComponent(val); } catch {}
    val=val.toLowerCase();
    if (/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i.test(val) && !/\.(png|jpe?g|gif|webp|svg)$/i.test(val)) emails.set(val,{email:val,source:sourceUrl});
  };
  const addPhone = raw => {
    let value=decode(String(raw || '')).replace(/^tel:/i,'').split('?')[0].trim();
    try {value=decodeURIComponent(value);} catch {}
    const digits=value.replace(/\D/g,'');
    if (digits.length < 7 || digits.length > 15 || !/^[+\d()\s.\-/]+$/.test(value)) return;
    const key=(value.trim().startsWith('+')?'+':'')+digits;
    if(!phones.has(key)) phones.set(key,{phone:value,normalized:key,source:sourceUrl});
  };
  const addLink = (raw, type) => {
    try {const u=new URL(decode(raw),sourceUrl); if (!['http:','https:'].includes(u.protocol) || u.username || u.password) return; u.hash=''; const key=type+'|'+u.href; if(!links.has(key)) links.set(key,{type,url:u.href,source:sourceUrl});} catch {}
  };
  for (const m of html.matchAll(/mailto:([^"'\s<>]+)/gi)) addEmail(m[1]);
  for (const m of html.matchAll(/(?:href|content)\s*=\s*["']tel:([^"']+)["']/gi)) addPhone(m[1]);
  for (const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi)) {
    try {const u=new URL(decode(m[1]),sourceUrl), host=u.hostname.toLowerCase().replace(/^www\./,'');
      if(host==='wa.me'||host==='api.whatsapp.com') addLink(u.href,'whatsapp');
      else if (['facebook.com','instagram.com','linkedin.com','youtube.com','tiktok.com'].some(d=>host===d||host.endsWith('.'+d))) addLink(u.href,'social');
    } catch {}
  }
  const visible=decode(html.replace(/<script\b[\s\S]*?<\/script>|<style\b[\s\S]*?<\/style>/gi,' ').replace(/<[^>]+>/g,' '));
  for (const m of visible.matchAll(/[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)) addEmail(m[0]);
  for (const m of visible.matchAll(/(?:phone|tel(?:ephone)?|call|mobile|whatsapp|telefon|hubungi)\s*[:：-]?\s*(\+?\d[\d ()\-.\/]{5,23}\d)/gi)) addPhone(m[1]);
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const visit=x=>{if(!x||typeof x!=='object')return;if(Array.isArray(x)){x.forEach(visit);return;}
        const types=Array.isArray(x['@type'])?x['@type']:[x['@type']];
        if(types.some(t=>String(t).toLowerCase()==='person') && typeof x.name==='string' && x.name.trim()) people.push({name:x.name.trim(),role:typeof x.jobTitle==='string'?x.jobTitle.trim():null,source:sourceUrl});
        if (typeof x.telephone==='string') addPhone(x.telephone);
        if (typeof x.email==='string') addEmail(x.email);
        for(const v of Object.values(x)) if(typeof v==='object') visit(v);
      }; visit(JSON.parse(m[1]));
    } catch {}
  }
  return {emails:[...emails.values()],phones:[...phones.values()],people,links:[...links.values()]};
}
function contactLinks(html,base) {
  const origin=new URL(base); const candidates=[];
  for(const m of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const label=decode(m[2].replace(/<[^>]*>/g,' '));
    if (!/contact|about|team|leadership|management|staff|people|hubungi|tentang/i.test(label+' '+m[1])) continue;
    try {const u=new URL(decode(m[1]),base); if(['http:','https:'].includes(u.protocol) && u.hostname.replace(/^www\./,'')===origin.hostname.replace(/^www\./,'')) {u.hash=''; candidates.push({url:u.href,priority:/contact|hubungi/i.test(label+' '+m[1]) ? 0 : /team|leadership|management|staff|people/i.test(label+' '+m[1]) ? 1 : 2});}} catch {}
  }
  candidates.sort((a,b)=>a.priority-b.priority);
  return [...new Set(candidates.map(c=>c.url))].slice(0,3);
}
export async function researchWebsite(website, fetchPage=getPage) {
  if(!website) return {status:'no_website',emails:[],phones:[],people:[],links:[],pages:[],errors:[]};
  const emails=new Map(),phones=new Map(),people=new Map(),links=new Map(),pages=[],errors=[]; let blocked=false;
  let home;
  try {home=await fetchPage(website);} catch(e) {return {status:'failed',emails:[],phones:[],people:[],links:[],pages,errors:[{url:website,error:e.message}]};}
  const queue=[home,...contactLinks(home.html,home.url)];
  for(const item of queue) {
    let page; try {page=typeof item==='string'?await fetchPage(item):item;} catch(e) {errors.push({url:item,error:e.message});continue;}
    pages.push(page.url);
    if (/verify (?:that )?you are human|checking your browser before accessing|unusual traffic from your computer|captcha challenge/i.test(page.html.replace(/<[^>]*>/g,' '))) {blocked=true; errors.push({url:page.url,error:'verification challenge'}); break;}
    const found=extractContacts(page.html,page.url);
    for(const e of found.emails) if(!emails.has(e.email)) emails.set(e.email,e);
    for(const p of found.phones) if(!phones.has(p.normalized)) phones.set(p.normalized,p);
    for(const l of found.links) if(!links.has(l.type+'|'+l.url)) links.set(l.type+'|'+l.url,l);
    for(const p of found.people) if(!people.has(normalize(p.name)+'|'+normalize(p.role))) people.set(normalize(p.name)+'|'+normalize(p.role),p);
  }
  return {status:blocked?'blocked':errors.length?'partial':'ok',emails:[...emails.values()],phones:[...phones.values()],people:[...people.values()],links:[...links.values()],pages,errors};
}
function writeJson(file,data){const tmp=file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(data,null,2));fs.renameSync(tmp,file);}
function writeCsv(file,rows){const fields=['name','category','address','phone','website','emails','email_sources','website_phones','phone_sources','people','people_sources','contact_links','mapsUrl','search_locations','research_status','research_errors']; const cell=v=>{let s=String(v??'');if(/^\s*[=+@-]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';};fs.writeFileSync(file+'.tmp',[fields.join(','),...rows.map(r=>fields.map(f=>cell(r[f])).join(','))].join('\n')+'\n');fs.renameSync(file+'.tmp',file);}
// Spread a limited pilot across locations instead of selecting only the first city.
export function sampleAcrossLocations(businesses, limit) {
  const groups = new Map();
  for (const b of businesses) {
    const place = b.searches?.[0]?.place || '';
    if (!groups.has(place)) groups.set(place, []);
    groups.get(place).push(b);
  }
  const selected = [];
  while (selected.length < limit) {
    let added = false;
    for (const group of groups.values()) {
      if (group.length && selected.length < limit) { selected.push(group.shift()); added = true; }
    }
    if (!added) break;
  }
  return selected;
}
function argsOf(args){const o={};for(let i=0;i<args.length;i++){const k=args[i];if(!['--country','--industry','--places','--output','--limit','--max','--delay-ms'].includes(k)||!args[i+1])throw new Error('Usage: node country-industry-research.mjs --country Malaysia --industry advertising [--places towns.txt] [--output directory] [--limit number]');o[k.slice(2)]=args[++i];}if(!o.country?.trim()||!o.industry?.trim())throw new Error('Both --country and --industry are required.');for(const k of ['limit','max','delay-ms'])if(o[k]!==undefined&&(!/^\d+$/.test(o[k])||(k!=='delay-ms'&&Number(o[k])<1)))throw new Error('--'+k+' must be a valid '+(k==='delay-ms'?'nonnegative':'positive')+' integer');return o;}
async function runChild(args){await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[path.join(HERE,'gmap-industry.mjs'),...args],{stdio:'inherit'});child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error('Maps discovery stopped (exit '+code+'); rerun to resume.')));});}
async function main(){
  const o=argsOf(process.argv.slice(2));const dir=path.resolve(o.output || path.join('country-industry-results',slug(o.country)+'-'+slug(o.industry)));fs.mkdirSync(dir,{recursive:true});
  const placesFile=path.join(dir,'locations.txt');
  if(o.places){const given=fs.readFileSync(o.places,'utf8');if(fs.existsSync(placesFile)&&fs.readFileSync(placesFile,'utf8')!==given)throw new Error('Existing output has a different location list. Choose a new output directory.');if(!fs.existsSync(placesFile))fs.writeFileSync(placesFile,given);}
  else if(!fs.existsSync(placesFile)) {console.log('Getting city list for '+o.country+'...');const response=await fetch(CITY_DATA,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('Could not download city list: HTTP '+response.status);const places=locationsFromCsv(await response.text(),o.country);if(!places.length)throw new Error('Country not found in city dataset. Use its English name or provide --places.');fs.writeFileSync(placesFile,places.join('\n')+'\n');console.log(`Planned ${places.length} cities. This population-based list does not include every town.`);}
  const planFile=path.join(dir,'research-plan.json');const plan={country:o.country.trim(),industry:o.industry.trim(),max:Number(o.max||200)};
  if(fs.existsSync(planFile)&&JSON.stringify(JSON.parse(fs.readFileSync(planFile)))!==JSON.stringify(plan))throw new Error('Existing output belongs to another plan. Choose a new output directory.');
  if(!fs.existsSync(planFile))writeJson(planFile,plan);
  console.log('Planned '+fs.readFileSync(placesFile,'utf8').split(/\r?\n/).filter(x=>x.trim()&&!x.trim().startsWith('#')).length+' cities.');
  const mapsFile=path.join(dir,'maps.json');
  await runChild(['--keyword',plan.industry,'--places',placesFile,'--output',mapsFile,'--max',String(plan.max),'--delay-ms',String(o['delay-ms']??2000)]);
  const maps=JSON.parse(fs.readFileSync(mapsFile));
  const businesses=o.limit?sampleAcrossLocations(maps.businesses,Number(o.limit)):maps.businesses;
  console.log('Beginning website research: 0/'+businesses.length);
  const {runBatch}=await import('./website-contacts-batch.mjs');
  const state=await runBatch(businesses,{output:path.join(dir,'contacts.json'),concurrency:4});
  console.log('Completed website research: '+state.summary.processed+'/'+businesses.length);
  const rows=Object.keys(state.results).sort((a,b)=>Number(a)-Number(b)).map(i=>{
    const {business,contact}=state.results[i];
    return {...business,emails:(contact.emails||[]).map(x=>x.email).join('; '),email_sources:(contact.emails||[]).map(x=>x.source).join('; '),website_phones:(contact.phones||[]).map(x=>x.phone).join('; '),phone_sources:(contact.phones||[]).map(x=>x.source).join('; '),contact_links:(contact.links||[]).map(x=>x.url).join('; '),search_locations:[...new Set((business.searches||[]).map(s=>s.place).filter(Boolean))].join('; '),research_errors:(contact.errors||[]).map(x=>`${x.url||''}: ${x.error||''}`).join('; '),people:(contact.people||[]).map(x=>[x.name,x.role].filter(Boolean).join(' — ')).join('; '),people_sources:(contact.people||[]).map(x=>x.source).join('; '),research_status:contact.status};
  });
  writeCsv(path.join(dir,'companies.csv'),rows);
  console.log(`Finished ${state.summary.processed} listings. Output: ${dir}. Inspect maps.json for coverage and possible limits.`);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(e=>{console.error(e.message);process.exitCode=1;});
