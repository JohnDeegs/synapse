// End-to-end API tests against the JSON file store. Run: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synapse-test-'));
process.env.DATA_FILE = path.join(tmpDir, 'data.json');
process.env.JWT_SECRET = 'test-secret';
process.env.PORT = '0';
delete process.env.STORE;

const server = require('../server');
let base, token;

async function api(method, url, body, auth = token) {
  const res = await fetch(base + url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

before(async () => {
  if (!server.listening) await new Promise(r => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const reg = await api('POST', '/auth/register', { email: 'Me@Example.com', password: 'password123' }, null);
  assert.equal(reg.status, 201);
  token = reg.body.token;
});

after(() => {
  server.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('auth: duplicate email is rejected case-insensitively, login works', async () => {
  const dup = await api('POST', '/auth/register', { email: 'me@example.com', password: 'password123' }, null);
  assert.equal(dup.status, 409);
  const bad = await api('POST', '/auth/login', { email: 'me@example.com', password: 'wrong-pass' }, null);
  assert.equal(bad.status, 401);
  const ok = await api('POST', '/auth/login', { email: 'ME@example.com', password: 'password123' }, null);
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
});

test('items require auth', async () => {
  const res = await api('GET', '/items', undefined, null);
  assert.equal(res.status, 401);
});

test('PARA roots are seeded and cannot be changed or deleted', async () => {
  const { body } = await api('GET', '/items');
  assert.deepEqual(body.map(i => i.id).sort(), ['root-archive', 'root-areas', 'root-projects', 'root-resources']);
  assert.equal((await api('PATCH', '/items/root-projects', { title: 'X' })).status, 400);
  assert.equal((await api('DELETE', '/items/root-projects')).status, 400);
});

test('folders and links: create, kind detection, duplicates', async () => {
  const folder = await api('POST', '/items', { type: 'folder', parentId: 'root-projects', title: 'Board Pack', priority: 'P1', dueDate: '2026-11-30', tags: ['#Finance', 'finance', ' Q4 '] });
  assert.equal(folder.status, 201);
  assert.deepEqual(folder.body.tags, ['finance', 'q4']);
  assert.equal(folder.body.para, 'projects');

  const gdoc = await api('POST', '/items', {
    type: 'link', parentId: folder.body.id, title: 'Budget sheet',
    url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit?usp=sharing',
    note: 'Final numbers, needs sign-off',
  });
  assert.equal(gdoc.status, 201);
  assert.equal(gdoc.body.kind, 'gdoc');
  assert.deepEqual(gdoc.body.path, ['root-projects', folder.body.id]);

  // Same doc, different suffix: counts as one link
  const dup = await api('POST', '/items', {
    type: 'link', parentId: 'root-resources',
    url: 'https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/view#gid=0',
  });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.existing.id, gdoc.body.id);

  const sp = await api('POST', '/items', {
    type: 'link', parentId: folder.body.id, title: 'Board paper draft',
    url: 'https://contoso.sharepoint.com/:w:/r/sites/Finance/_layouts/15/Doc.aspx?sourcedoc=%7BABCD-1234%7D&file=Board.docx',
  });
  assert.equal(sp.body.kind, 'sharepoint');
  assert.equal(sp.body.site, 'contoso.sharepoint.com/sites/finance');

  const local = await api('POST', '/items', { type: 'link', parentId: folder.body.id, url: 'C:\\Users\\me\\Board\\notes.pdf' });
  assert.equal(local.body.kind, 'local');
  assert.equal(local.body.title, 'C:\\Users\\me\\Board\\notes.pdf');

  const bad = await api('POST', '/items', { type: 'link', parentId: folder.body.id, url: 'javascript:alert(1)' });
  assert.equal(bad.status, 400);

  const childOfLink = await api('POST', '/items', { type: 'folder', parentId: gdoc.body.id, title: 'Nope' });
  assert.equal(childOfLink.status, 400);
});

test('lookup finds a filed URL with its breadcrumb', async () => {
  const hit = await api('GET', '/items/lookup?url=' + encodeURIComponent('https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz/edit'));
  assert.equal(hit.body.item.title, 'Budget sheet');
  assert.deepEqual(hit.body.breadcrumb, ['Projects', 'Board Pack']);
  const miss = await api('GET', '/items/lookup?url=' + encodeURIComponent('https://example.com/nothing'));
  assert.equal(miss.body.item, null);
});

test('suggest ranks folders by same place, recency and matching words', async () => {
  const other = await api('POST', '/items', { type: 'folder', parentId: 'root-areas', title: 'Hiring', note: 'Interview loops and offers' });

  // A new doc from the same SharePoint site lands on Board Pack
  const site = await api('GET', '/items/suggest?url=' + encodeURIComponent('https://contoso.sharepoint.com/sites/Finance/Shared%20Documents/Q4.xlsx') + '&title=Q4%20forecast');
  assert.equal(site.body[0].breadcrumb.join(' / '), 'Projects / Board Pack');
  assert.ok(site.body[0].reasons.includes('same place'));

  // Title words beat recency when nothing else matches
  const words = await api('GET', '/items/suggest?url=' + encodeURIComponent('https://example.org/x') + '&title=Interview%20scorecard');
  assert.equal(words.body[0].folderId, other.body.id);
  assert.ok(words.body[0].reasons.includes('matching words'));

  await api('DELETE', `/items/${other.body.id}`);
});

test('search and filters', async () => {
  const q = await api('GET', '/items?q=sign-off');
  assert.deepEqual(q.body.map(i => i.title), ['Budget sheet']);
  const tag = await api('GET', '/items?tag=Finance');
  assert.deepEqual(tag.body.map(i => i.title), ['Board Pack']);
  const due = await api('GET', '/items?dueBefore=2026-12-01');
  assert.deepEqual(due.body.map(i => i.title), ['Board Pack']);
  const links = await api('GET', '/items?type=link&para=projects');
  assert.equal(links.body.length, 3);
  const tags = await api('GET', '/tags');
  assert.deepEqual(tags.body, [{ name: 'finance', count: 1 }, { name: 'q4', count: 1 }]);
});

test('moving a folder to Archive moves its whole subtree', async () => {
  const [folder] = (await api('GET', '/items?q=board pack&type=folder')).body;
  const sub = await api('POST', '/items', { type: 'folder', parentId: folder.id, title: 'Drafts' });
  const deep = await api('POST', '/items', { type: 'link', parentId: sub.body.id, url: 'https://example.com/draft' });

  const intoSelf = await api('PATCH', `/items/${folder.id}`, { parentId: sub.body.id });
  assert.equal(intoSelf.status, 400);

  const moved = await api('PATCH', `/items/${folder.id}`, { parentId: 'root-archive' });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.para, 'archive');

  const d = (await api('GET', `/items/${deep.body.id}`)).body;
  assert.equal(d.para, 'archive');
  assert.deepEqual(d.path, ['root-archive', folder.id, sub.body.id]);
});

test('delete removes a folder and its descendants', async () => {
  const [folder] = (await api('GET', '/items?q=board pack&type=folder')).body;
  const before = (await api('GET', '/items')).body.length;
  const del = await api('DELETE', `/items/${folder.id}`);
  assert.equal(del.body.deleted, 6); // folder, 3 links, Drafts, deep link
  assert.equal((await api('GET', '/items')).body.length, before - 6);
});

test('data survives a reload of the file store', async () => {
  const raw = JSON.parse(fs.readFileSync(process.env.DATA_FILE, 'utf8'));
  assert.equal(Object.keys(raw.users).length, 1);
  assert.ok(Object.values(raw.items)[0]['root-projects']);
});
