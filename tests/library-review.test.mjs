import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';

const analysis = {
  lines: [{
    id: 1,
    original: '猫がいる',
    translation: '有一只猫。',
    tokens: [
      { surface: '猫', annotated: '猫（ねこ）', romaji: 'neko', meaning: '猫' },
      { surface: 'が', annotated: 'が', romaji: 'ga', meaning: '主语标记' },
      { surface: 'いる', annotated: 'いる', romaji: 'iru', meaning: '存在' }
    ]
  }]
};

test('song submissions stay private until admin approval, then become searchable and loadable', async t => {
  let modelCalls = 0;
  const app = createApp({ env: { DATABASE_PATH: ':memory:', ADMIN_PASSWORD: 'test-password' }, fetcher: async () => { modelCalls++; throw new Error('unexpected model request'); } });
  app.listen(0, '127.0.0.1');
  await new Promise(resolve => app.once('listening', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));

  const origin = `http://127.0.0.1:${app.address().port}`;
  const request = (path, options = {}) => fetch(`${origin}${path}`, options);
  const headers = { Origin: origin, 'Content-Type': 'application/json' };

  assert.deepEqual((await (await request('/api/library')).json()).songs, []);
  assert.deepEqual((await (await request('/api/songs?prefix=猫')).json()).songs, []);
  const submitted = await request('/api/upload-requests', { method: 'POST', headers, body: JSON.stringify({ title: '猫の歌', data: analysis }) });
  const submittedValue = await submitted.json();
  assert.equal(submitted.status, 201, JSON.stringify(submittedValue));
  const duplicate = await request('/api/upload-requests', { method: 'POST', headers, body: JSON.stringify({ title: '猫の歌', data: analysis }) });
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), submittedValue);
  const receipt = await request('/api/upload-requests/receipt', { method: 'POST', headers, body: JSON.stringify({ id: submittedValue.id, title: '猫の歌', data: analysis }) });
  assert.deepEqual(await receipt.json(), submittedValue);
  const wrongData = structuredClone(analysis); wrongData.lines[0].translation = '修改了';
  assert.equal((await request('/api/upload-requests/receipt', { method: 'POST', headers, body: JSON.stringify({ id: submittedValue.id, title: '猫の歌', data: wrongData }) })).status, 404);
  assert.equal((await request('/api/upload-requests/receipt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: submittedValue.id, title: '猫の歌', data: analysis }) })).status, 403);
  assert.deepEqual((await (await request('/api/songs?prefix=猫')).json()).songs, []);
  assert.equal((await request('/api/admin/requests')).status, 401);

  const login = await request('/api/admin/login', { method: 'POST', headers, body: JSON.stringify({ password: 'test-password' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  const pending = await request('/api/admin/requests?status=pending', { headers: { Cookie: cookie } });
  const pendingValue = await pending.json();
  assert.equal(pendingValue.requests.length, 1);
  const requestId = pendingValue.requests[0].id;
  const approved = await request(`/api/admin/requests/${requestId}/approve`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ note: '' }) });
  assert.equal(approved.status, 200);

  const search = await request('/api/songs?prefix=猫の');
  const songs = (await search.json()).songs;
  assert.equal(songs.length, 1);
  assert.equal(songs[0].title, '猫の歌');
  const loaded = await request(`/api/songs/${songs[0].id}`);
  assert.deepEqual((await loaded.json()).song.data, analysis);
  const library = (await (await request('/api/library')).json()).songs;
  assert.deepEqual(library, [{ id: songs[0].id, title: '猫の歌', lineCount: 1 }]);
  assert.equal(modelCalls, 0);
});

test('admin login rejects a wrong password and does not issue a session cookie', async t => {
  const app = createApp({ env: { DATABASE_PATH: ':memory:', ADMIN_PASSWORD: 'test-password' } });
  app.listen(0, '127.0.0.1');
  await new Promise(resolve => app.once('listening', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const response = await fetch(`${origin}/api/admin/login`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-incorrect' })
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('set-cookie'), null);
});


test('曲库列出全部已审核歌曲，超过搜索的十首限制且不公开待审核数据', async t => {
  let modelCalls = 0;
  const app = createApp({ env: { DATABASE_PATH: ':memory:', ADMIN_PASSWORD: 'test-password' }, fetcher: async () => { modelCalls++; throw new Error('unexpected model request'); } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const headers = { Origin: origin, 'Content-Type': 'application/json' };
  const login = await fetch(`${origin}/api/admin/login`, { method: 'POST', headers, body: JSON.stringify({ password: 'test-password' }) });
  const cookie = login.headers.get('set-cookie').split(';', 1)[0];
  for (let i = 12; i >= 0; i--) {
    const submitted = await fetch(`${origin}/api/upload-requests`, { method: 'POST', headers: { ...headers, 'CF-Connecting-IP': `192.0.2.${i + 1}` }, body: JSON.stringify({ title: `曲目${String(i).padStart(2, '0')}`, data: analysis }) });
    assert.equal(submitted.status, 201);
    const { id } = await submitted.json();
    if (i === 0) continue;
    const reviewed = await fetch(`${origin}/api/admin/requests/${id}/approve`, { method: 'POST', headers: { ...headers, Cookie: cookie }, body: '{}' });
    assert.equal(reviewed.status, 200);
  }
  const library = await fetch(`${origin}/api/library`);
  assert.equal(library.status, 200);
  const songs = (await library.json()).songs;
  assert.equal(songs.length, 12);
  assert.deepEqual(songs.map(song => song.title), Array.from({ length: 12 }, (_, i) => `曲目${String(i + 1).padStart(2, '0')}`));
  assert.ok(songs.every(song => song.lineCount === 1 && !('data' in song)));
  const loaded = await fetch(`${origin}/api/songs/${songs[0].id}`);
  assert.deepEqual((await loaded.json()).song.data, analysis);
  assert.equal(modelCalls, 0);
});
