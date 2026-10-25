import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseLyrics, validateAnalysis } from './public/lib.mjs';
import { compactSchema, expandLine, planAnalysis } from './analysis-wire.mjs';
import { normalizeSongTitle, openDatabase } from './database.mjs';

const root = new URL('./', import.meta.url);
const prompt = await readFile(new URL('prompts/compact.txt', root), 'utf8');
const staticFiles = new Map([
  ['/', ['public/index.html', 'text/html']],
  ['/styles.css', ['public/styles.css', 'text/css']],
  ['/patch.css', ['public/patch.css', 'text/css']],
  ['/app.mjs', ['public/app.mjs', 'text/javascript']],
  ['/lib.mjs', ['public/lib.mjs', 'text/javascript']],
  ['/soramimi.mjs', ['public/soramimi.mjs', 'text/javascript']],
  ['/soramimi-data.mjs', ['public/soramimi-data.mjs', 'text/javascript']],
  ['/sample.mjs', ['public/sample.mjs', 'text/javascript']]
  ,['/admin/', ['public/admin.html', 'text/html']]
  ,['/admin.css', ['public/admin.css', 'text/css']]
  ,['/admin.mjs', ['public/admin.mjs', 'text/javascript']]
]);
function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}
async function readJson(req, limit = 180000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求过大，请分段输入。');
    chunks.push(chunk);
  }
  // Decode after joining bytes: a network chunk can split a Japanese UTF-8 character.
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('请求不是有效 JSON。'); }
}
function requestIp(req) {
  const forwarded = req.headers['cf-connecting-ip'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
}
function sameOrigin(req) {
  if (typeof req.headers.origin !== 'string') return false;
  try {
    const origin = new URL(req.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && origin.host === req.headers.host;
  } catch { return false; }
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map(piece => piece.trim().split(/=(.*)/s, 2)).filter(([key, value]) => key && value !== undefined));
}
function publicAnalysis(value) {
  const validated = validateAnalysis(value);
  return { lines: validated.lines.map(line => ({
    id: line.id,
    original: line.original,
    translation: line.translation,
    tokens: line.tokens.map(token => ({ surface: token.surface, annotated: token.annotated, romaji: token.romaji, meaning: token.meaning }))
  })) };
}
export function resolveConfig(input = {}, env = process.env, local = true) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('模型设置无效。');
  const config = {
    apiKey: input.apiKey || env.OPENAI_API_KEY || '',
    baseUrl: input.baseUrl || env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
    model: input.model || env.OPENAI_MODEL || 'gpt-6-astra',
    format: input.format || env.LLM_OUTPUT_MODE || 'json_schema'
  };
  if (Object.values(config).some(v => typeof v !== 'string') || config.model.length > 150 || config.apiKey.length > 1000) throw new Error('模型设置无效。');
  if (!config.apiKey.trim()) throw new Error('还没有配置模型密钥。请点击右上角「模型设置」，或在 .env 中填写 OPENAI_API_KEY。');
  const url = new URL(config.baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写有效的 API 根地址。');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('远程模型服务必须使用 HTTPS。');
  if (!local && !['api.deepseek.com', 'api.openai.com'].includes(url.hostname)) throw new Error('公网暂时只支持 DeepSeek 与 OpenAI 官方 API 地址。');
  if (!['json_schema', 'json_object', 'prompt'].includes(config.format)) throw new Error('不支持的输出格式。');
  config.baseUrl = config.baseUrl.replace(/\/+$/, '');
  return config;
}

function normalizeAnalysisResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  // Some OpenAI-compatible reasoning models use "sentences" for the same
  // top-level collection even when the prompt requests "lines".
  if (!Array.isArray(value.lines) && Array.isArray(value.sentences)) {
    return { ...value, lines: value.sentences };
  }
  return value;
}

export async function requestBatch(config, context, targets, signal, fetcher = fetch, onProgress = null, onUsage = null, onLine = null) {
  const accepted = new Map();
  let repair = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const pending = targets.filter(line => !accepted.has(line.id));
    const messages = [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify({ context: context.map(line => line.reference ? [line.id, line.original, line.reference] : [line.id, line.original]), targetIds: pending.map(line => line.id), ...(repair ? { repair } : {}) }) }
    ];
    const body = { model: config.model, messages };
    const officialDeepSeek = new URL(config.baseUrl).hostname === 'api.deepseek.com' && config.model.startsWith('deepseek-');
    if (officialDeepSeek) {
      body.thinking = { type: 'disabled' };
      body.max_tokens = Math.min(12000, Math.max(1200, pending.reduce((n, line) => n + Math.max(120, line.original.length * 12), 0)));
    }
    if (config.format === 'json_schema') body.response_format = { type: 'json_schema', json_schema: { name: 'lyrics_analysis', strict: true, schema: compactSchema } };
    if (config.format === 'json_object') body.response_format = { type: 'json_object' };
    const response = await fetcher(`${config.baseUrl}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.any([signal, AbortSignal.timeout(config.timeoutMs || 90000)])
    });
    if (!response.ok) {
      const code = response.status;
      const hint = code === 401 || code === 403 ? '请检查密钥和模型访问权限。' : code === 429 ? '请求限流或余额不足，请检查额度或稍后重试。' : code === 400 ? '请检查模型名称与输出格式，兼容服务可尝试 JSON 对象模式。' : '请检查服务地址或稍后重试。';
      throw new Error(`模型服务返回 ${code}。${hint}`);
    }
    let usage = null;
    try {
      let content = '';
      let finishReason = '';
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        if (!response.body) throw new Error('模型没有返回有效文本。');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let received = 0;
        let lastProgressAt = 0;
        let lastReportedChars = 0;
        const acceptSSE = row => {
          if (!row.startsWith('data:')) return;
          const payload = row.slice(5).trim();
          if (!payload || payload === '[DONE]') return;
          let event;
          try { event = JSON.parse(payload); } catch { return; }
          if (event.usage) usage = event.usage;
          if (event.error) throw new Error('模型流式响应中断，请重试。');
          const choice = event.choices?.[0];
          if (choice?.delta?.refusal) throw new Error('模型未能处理这段输入，请更换模型或调整输入后重试。');
          if (typeof choice?.delta?.content === 'string') {
            content += choice.delta.content;
            received += choice.delta.content.length;
            const now = Date.now();
            if (now - lastProgressAt >= 300 || received - lastReportedChars >= 800) {
              lastProgressAt = now;
              lastReportedChars = received;
              onProgress?.(received);
            }
          }
          if (choice?.finish_reason) finishReason = choice.finish_reason;
        };
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          const rows = buffer.split(/\r?\n/);
          buffer = rows.pop() || '';
          for (const row of rows) acceptSSE(row);
          if (done) { acceptSSE(buffer); break; }
        }
      } else {
        const data = await response.json();
        usage = data.usage || null;
        const reply = data.choices?.[0];
        if (reply?.message?.refusal) throw new Error('模型未能处理这段输入，请更换模型或调整输入后重试。');
        finishReason = reply?.finish_reason || '';
        content = reply?.message?.content || '';
      }
      if (finishReason === 'length') throw new Error('模型输出被截断，请减少歌词长度或调整服务输出上限。');
      if (typeof content !== 'string' || content.length > 500000) throw new Error('模型没有返回有效文本。');
      const result = normalizeAnalysisResult(JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')));
      if (!Array.isArray(result?.lines)) throw new Error('缺少 lines 数组。');
      let issue = '';
      for (const expected of pending) {
        const matches = result.lines.filter(row => row?.id === expected.id);
        try {
          if (matches.length !== 1) throw new Error(`第 ${expected.id} 句缺失或编号重复。`);
          const line = expandLine(matches[0], expected);
          accepted.set(expected.id, line);
          onLine?.(line);
        } catch (error) { issue ||= error.message; }
      }
      if (issue) throw new Error(issue);
      return validateAnalysis({ lines: targets.map(line => accepted.get(line.id)) }, targets).lines;
    } catch (error) {
      if (signal.aborted) throw error;
      if (error.message.includes('截断')) throw error;
      if (attempt) throw new Error(`模型结果校验失败：${error.message}`);
      repair = `上次校验失败：${error.message}。仅重新生成本次 targetIds，按固定 id/t/w/a/r/m 格式，保持原文所有字符。`;
    } finally { onUsage?.(usage); }
  }
}
export const ANALYSIS_BATCH_SIZE = 40;
export const ANALYSIS_MAX_PARALLEL = 3;

function isLocalRequest(req) {
  const hostname = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
  return ['127.0.0.1', 'localhost', '[::1]'].includes(hostname);
}

export function createApp({ env = process.env, fetcher = fetch } = {}) {
  if (env.NODE_ENV === 'production' && !env.DATABASE_PATH) throw new Error('生产环境必须配置 DATABASE_PATH。');
  const db = openDatabase(env.DATABASE_PATH || ':memory:');
  const visitors = new Map();
  const uploadAttempts = new Map();
  const loginAttempts = new Map();
  const adminSessions = new Map();
  const cache = new Map();
  let cacheBytes = 0;
  const remember = (key, line) => {
    if (cache.has(key)) return;
    const size = Buffer.byteLength(JSON.stringify(line));
    cache.set(key, { line, size, expires: Date.now() + 86400000 }); cacheBytes += size;
    while (cache.size > 1000 || cacheBytes > 10000000) {
      const oldest = cache.keys().next().value;
      cacheBytes -= cache.get(oldest).size; cache.delete(oldest);
    }
  };
  let running = 0;
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (req.method === 'GET' && pathname === '/admin') { res.writeHead(308, { Location: '/admin/' }); res.end(); return; }
    if (req.method === 'GET' && staticFiles.has(pathname)) {
      const [file, type] = staticFiles.get(pathname);
      try { const bytes = await readFile(new URL(file, root)); res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); res.end(bytes); }
      catch { sendJson(res, 500, { error: '页面文件缺失。' }); }
      return;
    }
    if (req.method === 'GET' && pathname === '/api/status') {
      const local = isLocalRequest(req);
      sendJson(res, 200, { configured: Boolean(env.OPENAI_API_KEY), model: env.OPENAI_MODEL || 'gpt-6-astra', baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', local, format: env.LLM_OUTPUT_MODE || 'json_schema' }); return;
    }
    if (req.method === 'GET' && pathname === '/api/songs') {
      const prefix = new URL(req.url, 'http://localhost').searchParams.get('prefix')?.trim() || '';
      if (!prefix || prefix.length > 120) { sendJson(res, 200, { songs: [] }); return; }
      const key = normalizeSongTitle(prefix).replace(/[\\%_]/g, '\\$&');
      const songs = db.prepare("SELECT id, title, line_count AS lineCount FROM songs WHERE title_key LIKE ? ESCAPE '\\' ORDER BY title_key LIMIT 10").all(`${key}%`);
      sendJson(res, 200, { songs }); return;
    }
    const songMatch = pathname.match(/^\/api\/songs\/(\d+)$/);
    if (req.method === 'GET' && songMatch) {
      const song = db.prepare('SELECT id, title, data FROM songs WHERE id = ?').get(Number(songMatch[1]));
      if (!song) { sendJson(res, 404, { error: '没有找到这首已审核歌曲。' }); return; }
      sendJson(res, 200, { song: { id: song.id, title: song.title, data: JSON.parse(song.data) } }); return;
    }
    if (req.method === 'POST' && ['/api/upload-requests', '/api/upload-requests/receipt'].includes(pathname)) {
      if (!sameOrigin(req)) { sendJson(res, 403, { error: '只允许从本站提交上传申请。' }); return; }
      if (!req.headers['content-type']?.startsWith('application/json')) { sendJson(res, 415, { error: '请使用 JSON 请求。' }); return; }
      const checkingReceipt = pathname.endsWith('/receipt');
      const now = Date.now(), ip = requestIp(req);
      for (const [key, value] of uploadAttempts) if (now - value.started > 3600000) uploadAttempts.delete(key);
      const entry = uploadAttempts.get(ip) || { started: now, count: 0 };
      try {
        const input = await readJson(req, 2000000);
        const title = typeof input.title === 'string' ? input.title.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
        if (!title || title.length > 120) throw new Error('请填写有效的歌曲官方原名（最多 120 个字符）。');
        const data = publicAnalysis(input.data);
        const encoded = JSON.stringify(data);
        if (Buffer.byteLength(encoded) > 1800000) throw new Error('翻译数据过大，暂时无法提交。');
        const titleKey = normalizeSongTitle(title);
        if (checkingReceipt) {
          const receipt = Number.isSafeInteger(input.id) && db.prepare('SELECT id, status FROM upload_requests WHERE id = ? AND title_key = ? AND data = ?').get(input.id, titleKey, encoded);
          if (!receipt) { sendJson(res, 404, { error: '服务器中没有这条上传记录，请重新提交。' }); return; }
          sendJson(res, 200, { id: receipt.id, status: receipt.status }); return;
        }
        if (db.prepare('SELECT 1 FROM songs WHERE title_key = ?').get(titleKey)) { sendJson(res, 409, { error: '数据库中已有这首歌，可直接搜索使用。' }); return; }
        const pending = db.prepare("SELECT id, data FROM upload_requests WHERE title_key = ? AND status = 'pending'").get(titleKey);
        if (pending) {
          if (pending.data === encoded) { sendJson(res, 200, { id: pending.id, status: 'pending' }); return; }
          sendJson(res, 409, { error: '这首歌已有一条待审核申请。' }); return;
        }
        if (entry.count >= 5) { sendJson(res, 429, { error: '上传申请较多，请一小时后重试。' }); return; }
        entry.count++; uploadAttempts.set(ip, entry);
        const result = db.prepare('INSERT INTO upload_requests(title, title_key, data, line_count, submitted_at) VALUES(?, ?, ?, ?, ?)').run(title, titleKey, encoded, data.lines.length, new Date().toISOString());
        sendJson(res, 201, { id: Number(result.lastInsertRowid), status: 'pending' });
      } catch (error) { sendJson(res, 400, { error: error.message || '申请提交失败。' }); }
      return;
    }
    if (pathname.startsWith('/api/admin/')) {
      const sessionCookie = parseCookies(req.headers.cookie).kagami_admin || '';
      const sessionKey = createHash('sha256').update(sessionCookie).digest('hex');
      let session = adminSessions.get(sessionKey);
      if (session && session.expires <= Date.now()) { adminSessions.delete(sessionKey); session = null; }
      if (req.method === 'GET' && pathname === '/api/admin/session') { sendJson(res, 200, { authenticated: Boolean(session) }); return; }
      if (req.method === 'POST' && pathname === '/api/admin/login') {
        if (!sameOrigin(req)) { sendJson(res, 403, { error: '登录请求来源无效。' }); return; }
        if (typeof env.ADMIN_PASSWORD !== 'string' || !env.ADMIN_PASSWORD) { sendJson(res, 503, { error: '后台密码尚未在服务器配置。' }); return; }
        const now = Date.now(), ip = requestIp(req);
        for (const [key, value] of loginAttempts) if (now - value.started > 900000) loginAttempts.delete(key);
        const entry = loginAttempts.get(ip) || { started: now, count: 0 };
        if (entry.count >= 8) { sendJson(res, 429, { error: '登录尝试过多，请 15 分钟后重试。' }); return; }
        let input;
        try { input = await readJson(req, 4096); } catch (error) { sendJson(res, 400, { error: error.message }); return; }
        entry.count++;
        const provided = createHash('sha256').update(typeof input.password === 'string' ? input.password : '').digest();
        const expected = createHash('sha256').update(env.ADMIN_PASSWORD).digest();
        if (!timingSafeEqual(provided, expected)) { loginAttempts.set(ip, entry); sendJson(res, 401, { error: '后台密码不正确。' }); return; }
        loginAttempts.delete(ip);
        const token = randomBytes(32).toString('base64url');
        adminSessions.set(createHash('sha256').update(token).digest('hex'), { expires: now + 28800000 });
        const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https' || String(req.headers['cf-visitor'] || '').includes('https');
        res.setHeader('Set-Cookie', `kagami_admin=${token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=28800${secure ? '; Secure' : ''}`);
        sendJson(res, 200, { authenticated: true }); return;
      }
      if (req.method === 'POST' && pathname === '/api/admin/logout') {
        if (!sameOrigin(req)) { sendJson(res, 403, { error: '请求来源无效。' }); return; }
        if (session) adminSessions.delete(sessionKey);
        res.setHeader('Set-Cookie', 'kagami_admin=; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=0');
        sendJson(res, 200, { authenticated: false }); return;
      }
      if (!session) { sendJson(res, 401, { error: '请先登录后台。' }); return; }
      session.expires = Date.now() + 28800000;
      if (req.method === 'GET' && pathname === '/api/admin/requests') {
        const status = new URL(req.url, 'http://localhost').searchParams.get('status') || 'pending';
        if (!['pending', 'approved', 'rejected'].includes(status)) { sendJson(res, 400, { error: '申请状态无效。' }); return; }
        const requests = db.prepare('SELECT id, title, status, submitted_at AS submittedAt, reviewed_at AS reviewedAt, review_note AS reviewNote, data FROM upload_requests WHERE status = ? ORDER BY submitted_at DESC LIMIT 100').all(status).map(row => ({ ...row, data: JSON.parse(row.data) }));
        sendJson(res, 200, { requests }); return;
      }
      const reviewMatch = pathname.match(/^\/api\/admin\/requests\/(\d+)\/(approve|reject)$/);
      if (req.method === 'POST' && reviewMatch) {
        if (!sameOrigin(req)) { sendJson(res, 403, { error: '审核请求来源无效。' }); return; }
        const id = Number(reviewMatch[1]), action = reviewMatch[2];
        const request = db.prepare('SELECT id, title, title_key, data, line_count, status FROM upload_requests WHERE id = ?').get(id);
        if (!request || request.status !== 'pending') { sendJson(res, 404, { error: '待审核申请不存在或已处理。' }); return; }
        let note = '';
        try { const input = await readJson(req, 4096); note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) : ''; }
        catch (error) { sendJson(res, 400, { error: error.message }); return; }
        db.exec('BEGIN IMMEDIATE');
        try {
          const reviewedAt = new Date().toISOString();
          if (action === 'approve') {
            db.prepare('INSERT INTO songs(title, title_key, data, line_count, created_at) VALUES(?, ?, ?, ?, ?)').run(request.title, request.title_key, request.data, request.line_count, reviewedAt);
          }
          db.prepare('UPDATE upload_requests SET status = ?, reviewed_at = ?, review_note = ? WHERE id = ? AND status = ?').run(action === 'approve' ? 'approved' : 'rejected', reviewedAt, note, id, 'pending');
          db.exec('COMMIT');
          sendJson(res, 200, { status: action === 'approve' ? 'approved' : 'rejected' });
        } catch (error) {
          db.exec('ROLLBACK');
          sendJson(res, error.code === 'ERR_SQLITE_ERROR' ? 409 : 400, { error: action === 'approve' ? '歌曲无法加入数据库，可能已被审核收录。' : '审核操作失败。' });
        }
        return;
      }
      sendJson(res, 404, { error: '后台接口不存在。' }); return;
    }
    if (req.method !== 'POST' || pathname !== '/api/analyze') { sendJson(res, 404, { error: '页面不存在。' }); return; }
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}` && req.headers.origin !== `https://${req.headers.host}`) {
      sendJson(res, 403, { error: '只允许从本站提交歌词。' }); return;
    }
    if (!req.headers['content-type']?.startsWith('application/json')) { sendJson(res, 415, { error: '请使用 JSON 请求。' }); return; }
    if (running >= 2) { sendJson(res, 429, { error: '当前分析任务较多，请稍后重试。' }); return; }
    const now = Date.now();
    for (const [key, entry] of visitors) if (now - entry.start > 600000) visitors.delete(key);
    // Cloudflare Tunnel connects through loopback, so the socket address is
    // shared by every visitor. Use the edge-provided client IP for per-user limits.
    const ip = requestIp(req);
    const entry = visitors.get(ip) || { start: now, count: 0 };
    if (entry.count >= 20) { sendJson(res, 429, { error: '分析次数较多，请十分钟后重试。' }); return; }
    entry.count++; visitors.set(ip, entry);
    running++;
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const emit = value => { if (!res.destroyed) res.write(`${JSON.stringify(value)}\n`); };
    try {
      const input = await readJson(req);
      const lines = parseLyrics(input.lyrics, input.mode || 'auto');
      const config = resolveConfig(input.config, env, isLocalRequest(req));
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Accel-Buffering': 'no' });
      emit({ type: 'progress', completed: 0, total: lines.length });
      const { representatives, sourceIds } = planAnalysis(lines);
      // Scope reuse to the exact song, provider, model, format and credential.
      const scope = createHash('sha256').update(JSON.stringify([lines, config.baseUrl, config.model, config.format, config.apiKey])).digest('hex');
      const analyzed = new Map();
      const pending = representatives.filter(line => {
        const hit = cache.get(`${scope}:${line.id}`);
        if (hit && hit.expires > Date.now()) { analyzed.set(line.id, hit.line); return false; }
        if (hit) { cacheBytes -= hit.size; cache.delete(`${scope}:${line.id}`); }
        return true;
      });
      const usage = { promptTokens: 0, completionTokens: 0, reasoningTokens: 0, requests: 0, reportedRequests: 0 };
      const batchSize = ANALYSIS_BATCH_SIZE;
      const batches = [];
      for (let offset = 0; offset < pending.length; offset += batchSize) batches.push({ targets: pending.slice(offset, offset + batchSize) });
      let nextBatch = 0;
      let completed = sourceIds.filter(id => analyzed.has(id)).length;
      if (completed) emit({ type: 'progress', completed, total: lines.length });
      let firstFailure = null;
      const workers = Array.from({ length: Math.min(ANALYSIS_MAX_PARALLEL, batches.length) }, async () => {
        while (true) {
          controller.signal.throwIfAborted();
          const index = nextBatch++;
          if (index >= batches.length || firstFailure) return;
          const batch = batches[index];
          try {
            const results = await requestBatch(config, lines, batch.targets, controller.signal, fetcher, received => {
              emit({ type: 'generation', start: batch.targets[0].id, end: batch.targets.at(-1).id, received });
            }, report => {
              usage.requests++;
              if (!report) return;
              usage.reportedRequests++;
              usage.promptTokens += Number(report.prompt_tokens) || 0;
              usage.completionTokens += Number(report.completion_tokens) || 0;
              usage.reasoningTokens += Number(report.completion_tokens_details?.reasoning_tokens) || 0;
            }, line => remember(`${scope}:${line.id}`, line));
            results.forEach(line => analyzed.set(line.id, line));
            completed = sourceIds.filter(id => analyzed.has(id)).length;
            emit({ type: 'progress', completed, total: lines.length, batchStart: batch.targets[0].id, batchEnd: batch.targets.at(-1).id });
          } catch (error) {
            firstFailure ||= error;
            controller.abort();
            throw error;
          }
        }
      });
      const settled = await Promise.allSettled(workers);
      if (firstFailure) throw firstFailure;
      const rejected = settled.find(result => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      const output = lines.map((line, index) => ({ ...analyzed.get(sourceIds[index]), id: line.id, original: line.original }));
      validateAnalysis({ lines: output }, lines);
      emit({ type: 'done', data: { lines: output }, model: config.model, usage,
        savings: { totalLines: lines.length, uniqueLines: representatives.length, cachedLines: representatives.length - pending.length, generatedLines: pending.length } }); res.end();
    } catch (error) {
      if (!res.destroyed) {
        const message = error.name === 'TimeoutError' ? '模型响应超时，请稍后重试或缩短歌词。' : error.message === 'fetch failed' ? '无法连接模型服务，请检查网络和 API 根地址。' : error.message;
        if (res.headersSent) { emit({ type: 'error', error: message }); res.end(); }
        else sendJson(res, 400, { error: message });
      }
    } finally { running--; }
  });
  server.on('close', () => db.close());
  return server;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 8787);
  const server = createApp();
  server.requestTimeout = 120000;
  server.listen(port, host, () => console.log(`\n  日语小白唱见拯救计划\n  http://${host}:${port}\n  ${process.env.OPENAI_API_KEY ? '模型已配置' : '示例可用；在网页「模型设置」中接入模型'}\n`));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请在 .env 中修改 PORT。` : error.message); process.exitCode = 1; });
}
