// Unit tests for web/synapse-ai.js using a tiny hand-made model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AI = require('../web/synapse-ai.js');

// 4-dim vectors: finance ~ dim 0, hiring ~ dim 1, travel ~ dim 2.
const VOCAB = {
  '[PAD]': [0, 0, 0, 0], '[UNK]': [0, 0, 0, 1], '[CLS]': [0, 0, 0, 1], '[SEP]': [0, 0, 0, 1],
  budget: [1, 0, 0, 0], forecast: [0.9, 0.1, 0, 0], board: [0.8, 0, 0.2, 0], finance: [1, 0, 0, 0], q4: [0.7, 0, 0, 0.3],
  hiring: [0, 1, 0, 0], interview: [0, 1, 0, 0], candidate: [0.1, 0.9, 0, 0], offer: [0.2, 0.8, 0, 0], '##s': [0, 0, 0, 0.1],
  flight: [0, 0, 1, 0], hotel: [0, 0.1, 0.9, 0], trip: [0, 0, 1, 0], hello: [0.3, 0.3, 0.3, 0.3], world: [0.3, 0.3, 0.3, 0.3],
};

function fakeFiles() {
  const tokens = Object.keys(VOCAB);
  const data = new Float32Array(tokens.flatMap(t => VOCAB[t]));
  let header = JSON.stringify({ embeddings: { dtype: 'F32', shape: [tokens.length, 4], data_offsets: [0, data.byteLength] } });
  header += ' '.repeat((8 - (header.length % 8)) % 8);
  const buf = new ArrayBuffer(8 + header.length + data.byteLength);
  new DataView(buf).setBigUint64(0, BigInt(header.length), true);
  new Uint8Array(buf, 8, header.length).set(new TextEncoder().encode(header));
  new Uint8Array(buf, 8 + header.length).set(new Uint8Array(data.buffer));
  return { model: buf, vocab: new TextEncoder().encode(tokens.join('\n')).buffer };
}

async function fakeModel() {
  const files = fakeFiles();
  return AI.load({ fetchFile: spec => Promise.resolve(spec.name === 'vocab.txt' ? files.vocab : files.model) });
}

const vec = (model, text) => AI.embed(model, text);
const enc = (model, text) => ({ model: AI.MODEL_ID, v: AI.encode(vec(model, text)) });

test('BERT-style basic tokenizer: lowercases, strips accents, splits punctuation', () => {
  assert.deepEqual(AI._internal.basicTokens('Héllo, WORLD!  Q4-plan'), ['hello', ',', 'world', '!', 'q4', '-', 'plan']);
});

test('WordPiece splits on known sub-words and drops unknown words', async () => {
  const model = await fakeModel();
  const ids = AI._internal.tokenize(model, 'Interviews zzzz budget');
  const names = ids.map(id => [...model.vocab].find(([, i]) => i === id)[0]);
  assert.deepEqual(names, ['interview', '##s', 'budget']);
});

test('embed: normalised mean of token vectors, null for no known words', async () => {
  const model = await fakeModel();
  const v = vec(model, 'Budget forecast');
  assert.ok(Math.abs(Math.hypot(...v) - 1) < 1e-6);
  assert.ok(v[0] > 0.95);
  assert.equal(vec(model, 'zzzz qqqq'), null);
});

test('int8 encode/decode keeps direction', async () => {
  const model = await fakeModel();
  const v = vec(model, 'candidate offer hotel');
  const back = AI.decode(AI.encode(v));
  const cos = v.reduce((s, x, i) => s + x * back[i], 0);
  assert.ok(cos > 0.999, `cosine ${cos}`);
});

test('integrity check accepts matching files and rejects tampered ones', async () => {
  const buf = new TextEncoder().encode('hello').buffer;
  const sha256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
  await AI._internal.verify({ name: 'x', size: 5, sha256 }, buf);
  // git blob sha1 of "hello" (no newline)
  await AI._internal.verify({ name: 'x', size: 5, gitSha1: 'b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0' }, buf);
  await assert.rejects(AI._internal.verify({ name: 'x', size: 5, sha256: '0'.repeat(64) }, buf), /integrity/);
  await assert.rejects(AI._internal.verify({ name: 'x', size: 6, sha256 }, buf), /size/);
});

test('folder suggestions, search, tags and tidy-up hints', async () => {
  const model = await fakeModel();
  const now = '2026-10-27T00:00:00.000Z';
  const base = { note: '', tags: [], lastTouched: now };
  const items = [
    { ...base, id: 'root-projects', type: 'folder', parentId: null, para: 'projects', title: 'Projects' },
    { ...base, id: 'root-archive', type: 'folder', parentId: null, para: 'archive', title: 'Archive' },
    { ...base, id: 'fin', type: 'folder', parentId: 'root-projects', para: 'projects', title: 'Board finance' },
    { ...base, id: 'hire', type: 'folder', parentId: 'root-projects', para: 'projects', title: 'Hiring' },
    { ...base, id: 'old', type: 'folder', parentId: 'root-archive', para: 'archive', title: 'Budget forecast' },
    { ...base, id: 'l1', type: 'link', parentId: 'fin', para: 'projects', title: 'Q4 budget', tags: ['money'] },
    { ...base, id: 'l2', type: 'link', parentId: 'fin', para: 'projects', title: 'Forecast' },
    { ...base, id: 'l3', type: 'link', parentId: 'hire', para: 'projects', title: 'Interview candidate', tags: ['people'] },
    { ...base, id: 'l4', type: 'link', parentId: 'hire', para: 'projects', title: 'Offer letter' },
    // Misfiled: a budget doc sitting in Hiring
    { ...base, id: 'l5', type: 'link', parentId: 'hire', para: 'projects', title: 'Budget forecast board' },
    // Duplicate meaning of l1
    { ...base, id: 'l6', type: 'link', parentId: 'fin', para: 'projects', title: 'Budget q4' },
  ];
  for (const i of items) if (i.parentId) i.embedding = enc(model, AI.textFor(i));
  assert.deepEqual(AI.missing(items), []);

  const index = AI.buildIndex(items);
  const folders = AI.suggestFolders(index, vec(model, 'Finance budget review'));
  assert.equal(folders[0].folderId, 'fin');
  assert.ok(!folders.some(f => f.folderId === 'old'), 'archived folders not suggested');

  const found = AI.search(index, vec(model, 'candidates'));
  assert.equal(found[0].id, 'l3');

  const tags = AI.suggestTags(index, vec(model, 'budget forecast'));
  assert.equal(tags[0].tag, 'money');
  assert.deepEqual(AI.suggestTags(index, vec(model, 'budget'), { exclude: ['money'] }).map(t => t.tag).includes('money'), false);

  const h = AI.hints(index);
  const move = h.find(x => x.type === 'move');
  assert.equal(move.itemId, 'l5');
  assert.equal(move.toFolderId, 'fin');
  const dup = h.find(x => x.type === 'duplicate');
  assert.deepEqual([dup.itemId, dup.otherId].sort(), ['l1', 'l6']);

  // Vectors from another model version count as missing
  items[5].embedding.model = 'other@1';
  assert.deepEqual(AI.missing(items).map(i => i.id), ['l1']);
});

test('extension/synapse-ai.js is an identical copy of web/synapse-ai.js', () => {
  const norm = p => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  assert.equal(
    norm(path.join(__dirname, '../../extension/synapse-ai.js')),
    norm(path.join(__dirname, '../web/synapse-ai.js')),
    'run: cp server/web/synapse-ai.js extension/synapse-ai.js',
  );
});
