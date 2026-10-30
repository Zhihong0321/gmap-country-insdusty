import { test } from 'node:test';
import assert from 'node:assert/strict';
import {businessKey, mergeResults} from './gmap-industry.mjs';

test('deduplicates overlapping searches by place id while retaining provenance', () => {
  const a = {name:'Agency', mapsUrl:'https://google.com/maps/place/a/data=!19sChIJ123', phone:null};
  const b = {...a, phone:'0123456789'};
  const rows = mergeResults([{keyword:'agency',place:'KL',businesses:[a]}, {keyword:'marketing',place:'PJ',businesses:[b]}]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].phone, '0123456789');
  assert.deepEqual(rows[0].searches.map(s => s.place), ['KL', 'PJ']);
});
test('keeps distinct places with the same name and excludes blocked results', () => {
  const a = {name:'Same',mapsUrl:'https://google.com/maps/place/a/data=!19sChIJ1'};
  const b = {name:'Same',mapsUrl:'https://google.com/maps/place/b/data=!19sChIJ2'};
  assert.notEqual(businessKey(a),businessKey(b));
  assert.equal(mergeResults([{businesses:[a,b]},{blocked:true,businesses:[{name:'blocked'}]}]).length,2);
});
