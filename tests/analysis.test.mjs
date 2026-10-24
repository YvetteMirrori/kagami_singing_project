import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { parseLyrics, validateAnalysis, canonical, toFourLines } from '../public/lib.mjs';
import { sample, sampleText } from '../public/sample.mjs';
import { ANALYSIS_BATCH_SIZE, ANALYSIS_MAX_PARALLEL, createApp, requestBatch, resolveConfig } from '../server.mjs';
import { expandLine, planAnalysis } from '../analysis-wire.mjs';

const compactLine = line => ({ id: line.id, t: line.translation, w: line.tokens.map(t => ({ a: t.annotated, r: t.romaji, m: t.meaning })) });

test('完整 33 句及副歌重复句均保留，四行输出不省略', () => {
  assert.equal(sample.lines.length, 33);
  validateAnalysis(sample, parseLyrics(sampleText));
  assert.deepEqual(sample.lines[8].tokens, sample.lines[24].tokens);
  assert.deepEqual(sample.lines[9].tokens, sample.lines[25].tokens);
  const text = toFourLines(sample);
  assert.equal(text.split('\n\n').length, 33);
  assert.ok(text.split('\n\n').every(l => l.split('\n').length === 4));
  assert.equal(text.match(/来吧，迈开小脚，往这边来。/g).length, 2);
});
test('自动识别音节罗马音，保留英语、德语、台词、重复句', () => {
  const lines = parseLyrics('悪戯(いたずら)は　知らん顔で\ni ta zu ra wa shi ra n ka o de\n言い訳は　涙を使って\ni i wa ke wa na mi da wo tsu ka tte\nI love you\nWir sind die Jäger\n（ねぇ）\n（ねぇ）');
  assert.equal(lines.length, 6);
  assert.equal(lines[0].reference, 'i ta zu ra wa shi ra n ka o de');
  assert.equal(lines[1].reference, 'i i wa ke wa na mi da wo tsu ka tte');
  assert.equal(lines[2].original, 'I love you');
  assert.equal(lines[3].original, 'Wir sind die Jäger');
  assert.equal(lines[4].original, lines[5].original);
  assert.equal(parseLyrics('愛\nai\n愛\nai', 'paired').length, 2);
  assert.equal(parseLyrics('愛\nai', 'raw').length, 2);
  assert.throws(() => parseLyrics('愛\n夢', 'paired'), /参考罗马音/);
});
test('自动识别带引号、长音和英语片段的参考罗马音', () => {
  const text = [
    '愛のネタバレ 「別れ」っぽいな', 'a i no ne ta ba re 「wa ka re」ppo i na',
    '景気いいけど　品性はTHE END', 'ke i ki i i ke do hi n se i wa THE END',
    '神っぽいな　それ　卑怯　神っぽいな　それ　"My God"', 'ka mi ppo i na so re hi kyo u ka mi ppo i na so re "My God"',
    '飽きっぽいんだ　オーケー　みんな　飽きっぽいんだ　オーケー', 'a ki ppo i n da oo kee mi n na a ki ppo i n da oo kee',
    '批判に見せかけ自戒の祈り　Do you know？', 'hi ha n ni mi se ka ke ji ka i no i no ri Do you know?',
    'アイウォンチュー　IQが下がっていく感じ', 'a i u o n chuu IQga sa ga tte i ku ka n ji',
    'きっしょいね　きっしょいね', 'ki ssho i ne ki ssho i ne',
    'とぅ　とぅる　"風"', 'to u to u ru "ka ze"',
    '畢竟', 'hi kkyo u'
  ].join('\n');
  const lines = parseLyrics(text);
  assert.equal(lines.length, 9);
  assert.deepEqual(lines.map(line => line.reference), [
    'a i no ne ta ba re 「wa ka re」ppo i na',
    'ke i ki i i ke do hi n se i wa THE END',
    'ka mi ppo i na so re hi kyo u ka mi ppo i na so re "My God"',
    'a ki ppo i n da oo kee mi n na a ki ppo i n da oo kee',
    'hi ha n ni mi se ka ke ji ka i no i no ri Do you know?',
    'a i u o n chuu IQga sa ga tte i ku ka n ji',
    'ki ssho i ne ki ssho i ne',
    'to u to u ru "ka ze"',
    'hi kkyo u'
  ]);
  assert.equal(parseLyrics('愛\nDo you know what I mean').length, 2);
  assert.equal(parseLyrics('愛\nWe are the children of the world').length, 2);
  assert.equal(parseLyrics('愛\nI love you').length, 2);
});
test('用户原始输入的全部参考罗马音均正确识别，含 tchi / tcha 促音', () => {
  const references = [
    'i ta zu ra wa shi ra n ka o de', 'i i wa ke wa na mi da wo tsu ka tte',
    'sa bi shi i na a so bi ta i na', 'ha chi mi tsu mi ta i ni do ro do ro',
    'a na ta ni mo a na ta ni mo', 'wa ta shi wa sa hi tsu yo u na i de sho',
    'yo no na ka ni ke n mo ho ro ro', 'ta no shi so u na o ma tsu ri ne',
    'sa a a n yo a n yo ko tchi o i de', 'te wo ta ta i te a ru ke ra tta tta',
    'i ya n yo i ya n yo so ppo mu i te', 'kyo u mo wa ta shi wa wa ru i ko i ra n ko',
    'yu me mi te wa go ku sa i shi ki', 'sa me te mi ru do su ku ro i ryo u te',
    'wa ta shi da ke tsu n za ku', 'ta no shi so u na u ta go e ne',
    'sa a ko n ya ko n ya a no ba sho e', 'mi na de i ko u ha shi re ra tta tta',
    'yo i na yo i na u ra ya me ba', 'ta no shi ku o do ru ki ma ma na shi ra nu ko',
    'i chi ni no sa n shi de ka ku re n bo', 'hi ro ku n ha ru cha n mi tsu ke ta',
    'i ki wo ki ra shi te wa o ni go kko', 'ki mi ni tsu ka ma tcha tta',
    'sa a a n yo a n yo ko tchi o i de', 'te wo ta ta i te a ru ke ra tta tta',
    'fu ru e ru i ppo fu mi da shi te', 'hi to ri ni ba i ba i',
    'ne e a i yo a i yo ko tchi o i de', 'te wo hi ra i te fu re ru a tchi tchi',
    'yo i no?yo i no?me wo a ke ta', 'kyo u mo a shi ta mo', 'mi n na to a so bo u'
  ];
  const original = sample.lines.map((line, i) => `${line.original}\n${references[i]}`).join('\n');
  const parsed = parseLyrics(original);
  assert.equal(parsed.length, 33);
  assert.deepEqual(parsed.map(l => l.reference), references);
  validateAnalysis(sample, parsed);
});
test('特殊读音括号与标点保留；校验拒绝漏句、改写、分词错位', () => {
  assert.equal(canonical('運命（さだめ）は 愛（いと）おしい'), '運命は愛おしい');
  assert.equal(canonical('（ねぇ）'), canonical('(ねぇ)'));
  assert.throws(() => validateAnalysis({ lines: sample.lines.slice(0, 32) }, parseLyrics(sampleText)), /遗漏/);
  const modified = structuredClone(sample); modified.lines[0].tokens[0].surface = '間違い';
  assert.throws(() => validateAnalysis(modified), /原词/);
  const missing = structuredClone(sample); missing.lines[0].tokens.pop();
  assert.throws(() => validateAnalysis(missing), /分词/);
  const reorder = structuredClone(sample); reorder.lines[0].id = 2;
  assert.throws(() => validateAnalysis(reorder), /顺序/);
  assert.throws(() => parseLyrics('あ'.repeat(16001)), /字符/);
  assert.throws(() => parseLyrics(Array(201).fill('愛').join('\n')), /200/);
});
test('模型设置：密钥不回传，公网只接受官方 DeepSeek 和 OpenAI API', () => {
  assert.throws(() => resolveConfig({}, {}), /密钥/);
  assert.throws(() => resolveConfig({ apiKey: 'test', baseUrl: 'http://remote.example/v1' }, {}), /HTTPS/);
  const result = resolveConfig({ apiKey: 'client-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash' }, {}, false);
  assert.equal(result.apiKey, 'client-key'); assert.equal(result.model, 'deepseek-flash');
  assert.equal(result.baseUrl, 'https://api.deepseek.com');
  assert.equal(resolveConfig({ apiKey: 'openai-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra' }, {}, false).model, 'gpt-6-astra');
  assert.throws(() => resolveConfig({ apiKey: 'x', baseUrl: 'https://attacker.example', model: 'm' }, {}, false), /官方 API/);
});
test('结构错误仅修复一次，并保持目标行及完整上下文', async () => {
  const targets = parseLyrics(sampleText).slice(0, 2);
  const config = resolveConfig({ apiKey: 'not-a-real-key' }, {});
  const requests = [];
  const mock = async (_url, opts) => {
    const body = JSON.parse(opts.body); requests.push(body);
    const lines = requests.length === 1 ? [] : sample.lines.slice(0, 2);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines }) } }] });
  };
  const result = await requestBatch(config, parseLyrics(sampleText), targets, new AbortController().signal, mock);
  assert.equal(result.length, 2); assert.equal(requests.length, 2);
  assert.equal(requests[0].response_format.json_schema.strict, true);
  assert.equal(JSON.parse(requests[0].messages[1].content).context.length, 33);
  assert.equal(requests[1].messages.at(-1).role, 'user');
});
test('兼容 JSON 模式及提供商错误不泄露密钥', async () => {
  const signal = new AbortController().signal;
  const config = resolveConfig({ apiKey: 'secret-value', format: 'json_object' }, {});
  await assert.rejects(requestBatch(config, [], [], signal, async (_url, opts) => {
    assert.deepEqual(JSON.parse(opts.body).response_format, { type: 'json_object' });
    return new Response('secret-value', { status: 401 });
  }), error => error.message.includes('401') && !error.message.includes('secret-value'));
});

test('短歌词单次请求；长歌词并发分批且按原句顺序返回', async t => {
  const calls = [];
  const expected = Array.from({ length: ANALYSIS_BATCH_SIZE * 2 + 3 }, (_, i) => ({
    ...structuredClone(sample.lines[i % sample.lines.length]), id: i + 1,
    original: `${sample.lines[i % sample.lines.length].original}${i}`,
    tokens: [...structuredClone(sample.lines[i % sample.lines.length].tokens), { surface: String(i), annotated: String(i), romaji: String(i), meaning: String(i) }]
  }));
  let active = 0;
  let maxActive = 0;
  const server = createApp({ env: { OPENAI_API_KEY: 'test-only-key' }, fetcher: async (url, opts) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(opts.body); const payload = JSON.parse(body.messages[1].content);
    calls.push(payload.targetIds);
    active++; maxActive = Math.max(maxActive, active);
    // Make later batches finish first; the returned lyric rows must still be in
    // source order, independent of request completion order.
    await new Promise(resolve => setTimeout(resolve, payload.targetIds[0] === 1 ? 40 : 5));
    active--;
    const rows = payload.targetIds.map(id => {
      const input = payload.context.find(row => row[0] === id)[1];
      const line = expected[id - 1].original === input ? expected[id - 1] : { ...sample.lines[id - 1], id };
      return compactLine(line);
    });
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ lines: rows }) } }] });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base);
  assert.equal(page.status, 200); assert.ok((await page.text()).includes('词格视图'));
  const info = await (await fetch(`${base}/api/status`)).text();
  assert.ok(!info.includes('test-only-key')); assert.equal(JSON.parse(info).configured, true);
  const postLyrics = lyrics => fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lyrics }) });
  const shortLines = sample.lines.slice(0, 7).map(l => l.original);
  const shortResponse = await postLyrics(shortLines.join('\n'));
  const shortEvents = (await shortResponse.text()).trim().split('\n').map(JSON.parse);
  assert.equal(shortResponse.status, 200); assert.equal(calls.length, 1);
  assert.equal(calls[0].length, 7);
  assert.deepEqual(shortEvents.filter(e => e.type === 'progress').map(e => e.completed), [0, 7]);
  assert.equal(shortEvents.at(-1).data.lines.length, 7);

  calls.length = 0;
  const longResponse = await postLyrics(expected.map(line => line.original).join('\n'));
  const longEvents = (await longResponse.text()).trim().split('\n').map(JSON.parse);
  assert.equal(longResponse.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls.filter(batch => batch.length <= ANALYSIS_BATCH_SIZE).length, 3);
  assert.ok(maxActive > 1 && maxActive <= ANALYSIS_MAX_PARALLEL, `并发数 ${maxActive} 应大于 1 且不超过 ${ANALYSIS_MAX_PARALLEL}`);
  const result = longEvents.at(-1).data.lines;
  assert.deepEqual(result.map(line => line.id), expected.map(line => line.id));
  assert.deepEqual(result.map(line => line.original), expected.map(line => line.original));
  assert.deepEqual(longEvents.filter(e => e.type === 'progress').map(e => e.completed).at(-1), expected.length);
  const denied = await fetch(`${base}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://unrelated.example' }, body: '{}' });
  assert.equal(denied.status, 403);
  assert.equal((await fetch(`${base}/.env`)).status, 404);
});

test('紧凑输出可无损展开；参考读音不同的重复句不共用分析', () => {
  for (const line of sample.lines) assert.deepEqual(expandLine(compactLine(line), line), {
    ...line, tokens: line.tokens.map(t => ({ ...t, surface: t.annotated.replace(/([\p{Script=Han}々〆ヶヵ]+)[（(][\p{Script=Hiragana}\p{Script=Katakana}ー\s]+[）)]/gu, '$1') }))
  });
  const plan = planAnalysis(parseLyrics('運命\nsa da me\n運命\nu n me i\n運命\nsa da me', 'paired'));
  assert.equal(plan.representatives.length, 2);
  assert.deepEqual(plan.sourceIds, [1, 2, 1]);
});

test('全角与半角标点按兼容字符校验，同时恢复原歌词标点', () => {
  const expected = { id: 43, original: "Let's spread it out！  互い願ったまま" };
  const row = { id: 43, t: '让我们传播开来，彼此怀着愿望。', w: [
    { a: "Let's", r: 'lets', m: '让我们' },
    { a: 'spread', r: 'spread', m: '传播' },
    { a: 'it', r: 'it', m: '它' },
    { a: 'out!', r: 'out', m: '开来' },
    { a: '互い', r: 'tagai', m: '彼此' },
    { a: '願（ねが）った', r: 'negatta', m: '祈愿' },
    { a: 'まま', r: 'mama', m: '保持原样' }
  ] };
  const expanded = expandLine(row, expected);
  assert.equal(expanded.original, expected.original);
  assert.equal(expanded.tokens[3].annotated, 'out！');
  assert.equal(expanded.tokens.map(token => token.surface).join(''), "Let'sspreaditout！互い願ったまま");
  assert.equal(canonical(expected.original), canonical("Let's spread it out!互い願ったまま"));
  assert.equal(canonical('「夢」、見る。'), canonical('"夢",見る.'));

  const omittedMark = structuredClone(row);
  omittedMark.w[3].a = 'out';
  assert.throws(() => expandLine(omittedMark, expected), /字符|标点/);

  const quoteExpected = { id: 44, original: '「夢」、見る。' };
  const quoteRow = { id: 44, t: '看见梦。', w: [
    { a: '"夢"', r: 'yume', m: '梦' },
    { a: ',', r: 'comma', m: '、' },
    { a: '見る.', r: 'miru', m: '看见' }
  ] };
  const quoteExpanded = expandLine(quoteRow, quoteExpected);
  assert.deepEqual(quoteExpanded.tokens.map(token => token.annotated), ['「夢」', '、', '見る。']);
});

test('结构修复只重做无效句子，不回传上一份大段输出', async () => {
  const targets = parseLyrics(sampleText).slice(0, 2);
  const requests = [];
  await requestBatch(resolveConfig({ apiKey: 'test' }, {}), targets, targets, new AbortController().signal, async (_url, opts) => {
    const body = JSON.parse(opts.body); requests.push(body);
    const rows = requests.length === 1 ? [compactLine(sample.lines[0])] : [compactLine(sample.lines[1])];
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines: rows }) } }] });
  });
  assert.deepEqual(JSON.parse(requests[1].messages[1].content).targetIds, [2]);
  assert.equal(requests[1].messages.length, 2);
  assert.ok(!requests[1].messages.some(m => m.role === 'assistant'));
});

test('DeepSeek 关闭额外思考；SSE 用量统计、跨块读取与紧凑格式有效', async () => {
  const target = [{ id: 1, original: '愛', reference: '' }];
  const row = { id: 1, t: '爱', w: [{ a: '愛（あい）', r: 'ai', m: '爱' }] };
  const reports = [];
  const config = resolveConfig({ apiKey: 'test', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', format: 'json_object' }, {});
  const result = await requestBatch(config, target, target, new AbortController().signal, async (_url, opts) => {
    const body = JSON.parse(opts.body);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.ok(body.max_tokens >= 1200 && body.max_tokens <= 12000);
    const text = `data: ${JSON.stringify({ choices: [{ delta: { content: JSON.stringify({ lines: [row] }) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 0 } } })}\n\ndata: [DONE]\n\n`;
    const bytes = new TextEncoder().encode(text);
    return new Response(new ReadableStream({ start(c) { c.enqueue(bytes.slice(0, 117)); c.enqueue(bytes.slice(117)); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
  }, null, usage => reports.push(usage));
  assert.equal(result[0].tokens[0].surface, '愛');
  assert.equal(reports[0].completion_tokens, 50);
  await assert.rejects(requestBatch(config, target, target, new AbortController().signal, async () => Response.json({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] })), /截断/);
});

test('副歌只生成一次、所有重复句完整展开；同首缓存命中不调用模型', async t => {
  let calls = 0;
  const targetIds = [];
  const server = createApp({ env: { OPENAI_API_KEY: 'test' }, fetcher: async (_url, opts) => {
    calls++;
    const body = JSON.parse(opts.body);
    assert.equal(body.thinking, undefined);
    const payload = JSON.parse(body.messages[1].content);
    targetIds.push(payload.targetIds);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines: payload.targetIds.map(id => compactLine(sample.lines[id - 1])) }) } }], usage: { prompt_tokens: 100, completion_tokens: 200 } });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const post = async (config = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lyrics: sampleText, config }) });
    return (await response.text()).trim().split('\n').map(JSON.parse).at(-1);
  };
  const first = await post();
  assert.equal(first.type, 'done');
  assert.equal(targetIds[0].length, 31);
  assert.equal(first.data.lines.length, 33);
  assert.deepEqual(first.data.lines[8].tokens, first.data.lines[24].tokens);
  assert.equal(first.usage.promptTokens + first.usage.completionTokens, 300);
  const hit = await post();
  assert.equal(calls, 1);
  assert.equal(hit.usage.requests, 0);
  assert.equal(hit.savings.cachedLines, 31);
  assert.deepEqual(hit.data, first.data);
  await post({ model: 'different-model' }); assert.equal(calls, 2);
  await post({ apiKey: 'different-key' }); assert.equal(calls, 3);
});

test('公网请求按真实 Host 进入受限模式并使用用户选择的密钥与模型', async t => {
  const server = createApp({ env: { OPENAI_API_KEY: 'legacy-server-key', OPENAI_MODEL: 'legacy-server-model' }, fetcher: async (url, opts) => {
    assert.equal(url, 'https://api.openai.com/v1/chat/completions');
    assert.equal(opts.headers.Authorization, 'Bearer browser-key');
    const body = JSON.parse(opts.body);
    assert.equal(body.model, 'gpt-6-astra');
    const payload = JSON.parse(body.messages[1].content);
    const target = payload.context.find(row => row[0] === payload.targetIds[0]);
    return Response.json({ choices: [{ message: { content: JSON.stringify({ lines: [{ id: target[0], t: '爱', w: [{ a: '愛（あい）', r: 'ai', m: '爱' }] }] }) } }] });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (path, body) => new Promise((resolve, reject) => {
    const req = http.request(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { Host: 'kagami.chatghx.com', ...(body ? { 'Content-Type': 'application/json' } : {}) } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk); res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); if (body) req.end(JSON.stringify(body)); else req.end();
  });
  const status = JSON.parse((await request('/api/status')).text);
  assert.equal(status.local, false);
  const response = await request('/api/analyze', { lyrics: '愛', config: { apiKey: 'browser-key', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-astra' } });
  const result = response.text.trim().split('\n').map(JSON.parse).at(-1);
  assert.equal(result.type, 'done');
});
