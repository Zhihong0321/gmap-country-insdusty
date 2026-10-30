import {test} from 'node:test';
import assert from 'node:assert/strict';
import {locationsFromCsv,extractContacts,researchWebsite} from './country-industry-research.mjs';

test('selects and deduplicates locations in the requested country',()=>{
  const csv='name,country,subcountry,geonameid\n"George Town",Malaysia,Penang,1\nGeorge Town,Malaysia,Penang,1\nParis,France,Île-de-France,2\n';
  assert.deepEqual(locationsFromCsv(csv,'malaysia'),['George Town, Penang, Malaysia']);
});
test('extracts public emails and structured people with evidence, without script email noise',()=>{
  const html='<a href="mailto:HELLO%40example.com?subject=Hi">Email</a> sales@example.com<script>"fake@example.com"</script><script type="application/ld+json">{"@type":"Person","name":"Jane Lee","jobTitle":"Director"}</script>';
  const r=extractContacts(html,'https://example.com/contact');
  assert.deepEqual(r.emails.map(x=>x.email),['hello@example.com','sales@example.com']);
  assert.deepEqual(r.people,[{name:'Jane Lee',role:'Director',source:'https://example.com/contact'}]);
});
test('visits only related pages on the same host and preserves contact source',async()=>{
  const seen=[];
  const fetchPage=async url=>{seen.push(url);return url==='https://example.com/'?{url,html:'<a href="/contact">Contact</a><a href="https://other.com/team">Team</a>'}:{url,html:'Contact: hello@example.com'};};
  const result=await researchWebsite('https://example.com/',fetchPage);
  assert.deepEqual(seen,['https://example.com/','https://example.com/contact']);
  assert.equal(result.emails[0].source,'https://example.com/contact');
  assert.equal(result.status,'ok');
});
test('distinguishes missing and inaccessible sites',async()=>{
  assert.equal((await researchWebsite(null)).status,'no_website');
  assert.equal((await researchWebsite('https://example.com/',async()=>{throw new Error('unavailable');})).status,'failed');
});
test('prioritizes contact links when a site has many about pages',async()=>{
  const seen=[]; const fetchPage=async url=>{seen.push(url);return {url,html:url==='https://example.com/'?'<a href="/about/one">About one</a><a href="/about/two">About two</a><a href="/about/three">About three</a><a href="/contact">Contact</a>':''};};
  await researchWebsite('https://example.com/',fetchPage);
  assert.equal(seen[1],'https://example.com/contact');
});

test('limited pilots distribute businesses across locations',async()=>{
  const {sampleAcrossLocations}=await import('./country-industry-research.mjs');
  const b=[{name:'A',searches:[{place:'KL'}]},{name:'B',searches:[{place:'KL'}]},{name:'C',searches:[{place:'Penang'}]},{name:'D',searches:[{place:'Penang'}]}];
  assert.deepEqual(sampleAcrossLocations(b,3).map(x=>x.name),['A','C','B']);
});

test('extracts linked and labeled phones, structured contacts, and public contact channels with source',()=>{
  const html=`<a href="tel:+60312345678">Call</a> <p>Phone: +60 12-345 6789</p>
    <a href="https://wa.me/60123456789">WhatsApp</a><a href="https://www.linkedin.com/company/test">LinkedIn</a>
    <script type="application/ld+json">{"@type":"Organization","telephone":"+60 3 9988 7766","email":"sales@agency.my","employee":{"@type":"Person","name":"Jane Lee","jobTitle":"Director"}}</script>`;
  const result=extractContacts(html,'https://agency.my/contact');
  assert.deepEqual(result.phones.map(x=>x.normalized),['+60312345678','+60123456789','+60399887766']);
  assert.equal(result.phones[0].source,'https://agency.my/contact');
  assert.equal(result.emails[0].email,'sales@agency.my');
  assert.deepEqual(result.links.map(x=>x.type),['whatsapp','social']);
  assert.equal(result.people[0].name,'Jane Lee');
});
test('website.contacts validates payload and blocks local addresses',async()=>{
  const {contacts}=await import('./website-contacts.mjs');
  await assert.rejects(contacts({}),{code:'bad_request'});
  await assert.rejects(contacts({website:'file:///etc/passwd'}),{code:'bad_request'});
  const result=await contacts({website:'http://127.0.0.1/'});
  assert.equal(result.status,'failed');
  assert.match(result.errors[0].error,/non-public/);
});

test('batch resumes completed records and retries failures without losing results',async()=>{
  const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
  const {runBatch}=await import('./website-contacts-batch.mjs');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'contacts-test-'));const output=path.join(dir,'results.json');
  const businesses=[{name:'A',website:'https://a.example'},{name:'B',website:'https://b.example'},{name:'C'}];let calls=[];
  const fetcher=async ({website})=>{calls.push(website);return {status:website.includes('b.example')?'failed':'ok',emails:[],phones:[],people:[],links:[],pages:[],errors:[]};};
  try {
    let state=await runBatch(businesses,{output,concurrency:2,research:fetcher});
    assert.equal(state.summary.processed,3);assert.equal(state.summary.failed,1);assert.equal(state.summary.noWebsite,1);
    calls=[];state=await runBatch(businesses,{output,concurrency:2,research:fetcher});
    assert.deepEqual(calls,['https://b.example']);assert.equal(Object.keys(state.results).length,3);
    await assert.rejects(runBatch([{name:'changed'}],{output,research:fetcher}),/different input/);
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});

test('a verification wall is reported as blocked, not a successful empty crawl',async()=>{
  const r=await researchWebsite('https://example.com/',async url=>({url,html:'<main>Verify you are human</main>'}));
  assert.equal(r.status,'blocked');assert.equal(r.errors[0].error,'verification challenge');
});
