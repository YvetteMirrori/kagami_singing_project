import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { toSoramimi } from '../public/soramimi.mjs';
import { mapping, syllables, source } from '../public/soramimi-data.mjs';
import { createApp } from '../server.mjs';

test('空耳映射可追溯到用户原始Excel，保留表中所有对应值', async () => {
  const bytes = await readFile(new URL('../五十音转空耳对照表.xlsx', import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), source.sha256);
  assert.equal(Object.keys(mapping).length, 70);
  for (const [romaji, chinese] of Object.entries(mapping)) assert.equal(toSoramimi(romaji), chinese);
  for (const mora of syllables.filter(key => !Object.hasOwn(mapping, key))) assert.equal(toSoramimi(mora), mora);
  assert.equal(toSoramimi('ki ke hi gi'), 'ki ke hi gi');
});

test('按音节匹配完整单词，保留无映射拗音、未知拼写与促音标记', () => {
  assert.equal(toSoramimi('watashi'), '哇它西');
  assert.equal(toSoramimi('aishiteru'), '阿一西特路');
  assert.equal(toSoramimi('kya shu cha nyu'), 'kya shu cha nyu');
  assert.equal(toSoramimi('kimochi'), 'ki莫七');
  assert.equal(toSoramimi('ya~tte ko~cchi i~ppo'), '呀~t特 口~c七 一~p剖');
  assert.equal(toSoramimi("kan'i"), "卡恩'一");
  assert.equal(toSoramimi('koo'), '口哦');
  assert.equal(toSoramimi('sayonara!'), '撒哟那啦!');
  assert.equal(toSoramimi('sayonara | ki | hi'), '撒哟那啦 | ki | hi');
  assert.equal(toSoramimi('IQga', 'IQが'), 'IQ噶');
  for (const unknown of ['xyz', 'thi', 'che', 'she', 'fa', 'Love', 'ō', 'shō', 'vye']) assert.equal(toSoramimi(unknown), unknown);
  assert.equal(toSoramimi('KI Ke HI'), 'KI Ke HI');
});

test('保留外语词格；转换不改变原罗马音或分词数据', () => {
  for (const text of ['My God', 'THE END', 'made', 'Do you know?']) assert.equal(toSoramimi(text, text), text);
  const tokens = Object.freeze([
    Object.freeze({ surface: '私', romaji: 'watashi' }),
    Object.freeze({ surface: 'は', romaji: 'wa' }),
    Object.freeze({ surface: '好き', romaji: 'suki' })
  ]);
  assert.deepEqual(tokens.map(token => toSoramimi(token.romaji, token.surface)), ['哇它西', '哇', '苏ki']);
  assert.deepEqual(tokens.map(token => token.romaji), ['watashi', 'wa', 'suki']);
});

test('空耳与规则模块能直接由网站提供，不调用模型服务', async t => {
  let modelRequests = 0;
  const server = createApp({ env: {}, fetcher: async () => { modelRequests++; throw new Error('Unexpected model request'); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base + '/');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /id="soramimiBtn"/);
  assert.match(html, /id="soramimiLegend"/);
  const app = await fetch(base + '/app.mjs');
  assert.equal(app.status, 200);
  assert.match(await app.text(), /showSoramimi/);
  for (const path of ['/soramimi.mjs', '/soramimi-data.mjs']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.ok((await response.text()).includes('export'));
  }
  assert.equal(modelRequests, 0);
});
