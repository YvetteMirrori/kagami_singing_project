import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';

test('上传 JSON 的网络分块切在日文 UTF-8 字符中间时，不损坏歌词或丢失申请', async t => {
  const app = createApp({ env: { DATABASE_PATH: ':memory:' } });
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { app.closeAllConnections(); app.close(resolve); }));
  const origin = `http://127.0.0.1:${app.address().port}`;
  const data = { lines: [{ id: 1, original: '猫がいる', translation: '有猫。', tokens: [
    { surface: '猫', annotated: '猫（ねこ）', romaji: 'neko', meaning: '猫' },
    { surface: 'が', annotated: 'が', romaji: 'ga', meaning: '主语' },
    { surface: 'いる', annotated: 'いる', romaji: 'iru', meaning: '存在' }
  ] }] };
  const bytes = Buffer.from(JSON.stringify({ title: 'Test UTF-8', data }));
  const split = bytes.indexOf(Buffer.from('猫がいる')) + 1;
  const result = await new Promise((resolve, reject) => {
    const req = http.request(`${origin}/api/upload-requests`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.on('error', reject);
    req.write(bytes.subarray(0, split));
    setTimeout(() => req.end(bytes.subarray(split)), 20);
  });
  assert.equal(result.status, 201, JSON.stringify(result.value));
  const receipt = await fetch(`${origin}/api/upload-requests/receipt`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: result.value.id, title: 'Test UTF-8', data }) });
  assert.equal(receipt.status, 200);
});
