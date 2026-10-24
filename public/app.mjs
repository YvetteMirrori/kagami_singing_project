import { parseLyrics, validateAnalysis, toFourLines } from './lib.mjs';
import { sample, sampleText, sampleTitle } from './sample.mjs';
import { toSoramimi } from './soramimi.mjs';

const $ = id => document.getElementById(id);
const storageKey = 'nihongo-kobito-uta-v2';
const legacyStorageKeys = ['kotoba-notebook-v1', 'kotoba-notebook-v2'];
let state = { data: null, title: '', source: '', mode: 'auto', isSample: false, model: '' };
let config = {};
let serverStatus = { local: true, configured: false };
let controller = null;
let toastTimer;
let saveTimer;
let showSoramimi = false;
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

function toast(message) {
  clearTimeout(toastTimer); $('toast').textContent = message; $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, 4500);
}
function status(message, error = false) {
  $('analysisStatus').textContent = message;
  $('analysisStatus').hidden = !message;
  $('analysisStatus').classList.toggle('error', error);
}
function persist() {
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      input: $('lyrics').value, title: $('songTitle').value, mode: $('inputMode').value,
      state, config, view: $('cleanBtn').classList.contains('selected') ? 'clean' : 'grid', fontSize: $('fontSize').value, showSoramimi
    }));
  } catch { $('storageLabel')?.remove(); toast('浏览器未能保存这次修改，请导出 JSON 留存。'); }
}
function updateCount() {
  const text = $('lyrics').value;
  $('charCount').textContent = `${text.length.toLocaleString()} / 16,000`;
  try {
    const lines = parseLyrics(text, $('inputMode').value);
    const refs = lines.filter(l => l.reference).length;
    $('inputCount').textContent = `${lines.length} 句${refs ? ` · ${refs} 行参考音` : ''}`;
    $('inputHint').textContent = '逐句换行；副歌和重复句也请完整保留。';
  } catch (error) {
    $('inputCount').textContent = text.trim() ? '检查输入格式' : '0 句';
    $('inputHint').textContent = text.trim() ? error.message : '逐句换行；副歌和重复句也请完整保留。';
  }
  updateBadge();
}
function updateBadge() {
  const stale = state.data && ($('lyrics').value !== state.source || $('inputMode').value !== state.mode);
  $('resultBadge').classList.toggle('stale', Boolean(stale));
  $('resultBadge').textContent = stale ? '输入已修改 · 待分析' : state.isSample ? '完整示例' : state.data ? '分析完成' : '对齐阅读';
}
function annotatedHTML(value) {
  return esc(value).replace(/（([^（）]+)）/g, '<span class="reading">（$1）</span>');
}
function render() {
  const data = state.data;
  $('emptyState').hidden = Boolean(data);
  $('sheetEnd').hidden = !data;
  $('copyBtn').disabled = !data; $('exportBtn').disabled = !data;
  $('sheetTitle').textContent = state.title || (data ? '未命名的歌' : '你的下一首歌');
  $('sheetEyebrow').textContent = state.isSample ? 'A SONG TO BEGIN WITH' : 'YOUR LYRIC NOTEBOOK';
  const reuseLabel = state.savings?.reusedLines ? ` · 复用 ${state.savings.reusedLines} 句` : '';
  $('sheetSubtitle').textContent = data ? `${data.lines.length} 句 · ${data.lines.reduce((n, l) => n + l.tokens.length, 0)} 个词格 · ${state.isSample ? '对话歌词完整示例' : state.model ? `由 ${state.model} 分析` : '已导入的分析'}${state.usage ? ` · ${usageLabel(state.usage)}${reuseLabel}` : ''}` : '从左侧输入歌词，开始读懂每一句。';
  $('sheet').innerHTML = data ? data.lines.map(line => `<article class="lyric-card" aria-label="第 ${line.id} 句"><div class="line-number">${String(line.id).padStart(2, '0')}</div><div class="line-body"><div class="token-scroll" tabindex="0" role="region" aria-label="第 ${line.id} 句词格，长句可左右滚动"><div class="token-grid">${line.tokens.map(token => `<div class="token"><div class="token-romaji">${esc(token.romaji)}</div><div class="token-soramimi" lang="zh-CN">${esc(toSoramimi(token.romaji, token.surface))}</div><div class="token-original" lang="ja">${annotatedHTML(token.annotated)}</div><div class="token-meaning">${esc(token.meaning)}</div></div>`).join('')}</div></div><p class="sentence-translation">${esc(line.translation)}</p></div></article>`).join('') : '';
  updateBadge();
}
function loadSample() {
  if (controller) return;
  $('lyrics').value = sampleText; $('songTitle').value = sampleTitle; $('inputMode').value = 'auto';
  state = { data: structuredClone(sample), title: sampleTitle, source: sampleText, mode: 'auto', isSample: true, model: '' };
  updateCount(); render(); persist(); status('已载入完整 33 句示例，重复句均独立保留。');
}
function setView(clean) {
  $('sheet').classList.toggle('clean-view', clean);
  $('cleanBtn').classList.toggle('selected', clean); $('gridBtn').classList.toggle('selected', !clean);
  $('cleanBtn').setAttribute('aria-pressed', String(clean)); $('gridBtn').setAttribute('aria-pressed', String(!clean));
}
function setSoramimi(visible) {
  showSoramimi = visible;
  $('sheet').classList.toggle('show-soramimi', visible);
  $('soramimiBtn').classList.toggle('selected', visible);
  $('soramimiBtn').setAttribute('aria-pressed', String(visible));
  $('soramimiBtn').setAttribute('aria-label', visible ? '隐藏中文空耳' : '显示中文空耳');
  $('soramimiLegend').hidden = !visible;
}
function busy(value) {
  for (const id of ['analyzeBtn', 'sampleBtn', 'emptySampleBtn', 'clearBtn', 'importBtn', 'lyrics', 'songTitle', 'inputMode', 'settingsBtn']) $(id).disabled = value;
  $('cancelBtn').hidden = !value;
  $('analysisProgress').hidden = !value;
  $('analysisProgress').classList.remove('is-streaming');
  $('analyzeBtn').querySelector('span').textContent = value ? '正在逐句分析…' : '开始逐句分析';
  $('workspace').setAttribute('aria-busy', String(value));
}
function updateConnection() {
  const connected = Boolean(config.apiKey || serverStatus.configured);
  $('connectionDot').classList.toggle('connected', connected);
  $('settingsBtn').title = connected ? '模型已配置，点击修改' : '尚未配置模型，点击连接';
}
function fillSettings() {
  $('baseUrl').value = config.baseUrl || '';
  $('modelName').value = config.model || '';
  $('apiKey').value = config.apiKey || '';
  $('outputFormat').value = config.format || 'json_schema';
}
function usageLabel(usage) {
  if (usage.requests === 0) return '本次未调用模型';
  if (!usage.reportedRequests) return '服务商未返回用量';
  const total = usage.promptTokens + usage.completionTokens;
  return `${total.toLocaleString()} tokens${usage.reportedRequests < usage.requests ? '（部分用量）' : ''}`;
}
async function analyze() {
  if (controller) return;
  let expected;
  try { expected = parseLyrics($('lyrics').value, $('inputMode').value); }
  catch (error) { status(error.message, true); $('lyrics').focus(); return; }
  const requestSignature = JSON.stringify([expected, config.baseUrl || serverStatus.baseUrl || '', config.model || serverStatus.model || '', config.format || serverStatus.format || 'json_schema']);
  if (state.data && !state.isSample && state.requestSignature === requestSignature) {
    state.title = $('songTitle').value.trim();
    render(); persist();
    status('已使用本机保存的完整结果，本次未调用模型。');
    return;
  }
  if (!config.apiKey) {
    status('请输入模型密钥后再开始分析。');
    fillSettings();
    $('settingsDialog').showModal();
    $('apiKey').focus();
    return;
  }
  const input = { lyrics: $('lyrics').value, mode: $('inputMode').value, config };
  const title = $('songTitle').value.trim();
  controller = new AbortController();
  busy(true); status(`正在连接模型，准备分析 ${expected.length} 句…`);
  $('analysisProgress').firstElementChild.style.width = '0%';
  $('analysisProgress').setAttribute('aria-valuenow', '0');
  let lastProgress = 0;
  try {
    const response = await fetch('/api/analyze', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input), signal: controller.signal
    });
    if (!response.ok) {
      let message = `请求失败（${response.status}）。`;
      try { message = (await response.json()).error || message; } catch {}
      throw new Error(message);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder(); let buffer = ''; let result = null; let model = ''; let usage = null; let savings = null;
    function accept(row) {
      if (!row.trim()) return;
      const event = JSON.parse(row);
      if (event.type === 'error') throw new Error(event.error);
      if (event.type === 'progress') {
        const pct = Math.max(lastProgress, Math.round(event.completed / event.total * 100));
        lastProgress = pct;
        $('analysisProgress').classList.toggle('is-streaming', event.completed === 0);
        status(event.completed === 0
          ? `已连接模型，正在生成 ${event.total} 句歌词…`
          : `正在逐句分析 · 已完成 ${event.completed} / ${event.total} 句`);
        $('analysisProgress').firstElementChild.style.width = `${pct}%`;
        $('analysisProgress').setAttribute('aria-valuenow', String(pct));
      }
      if (event.type === 'generation') {
        $('analysisProgress').classList.add('is-streaming');
        status(`模型正在生成第 ${event.start}–${event.end} 句 · 已收到 ${Number(event.received || 0).toLocaleString()} 个字符`);
      }
      if (event.type === 'done') { result = validateAnalysis(event.data, expected); model = event.model; usage = event.usage; savings = event.savings; }
    }
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      if (buffer.length > 1000000) throw new Error('模型返回的单条消息过大。');
      const chunks = buffer.split('\n'); buffer = chunks.pop();
      for (const chunk of chunks) accept(chunk);
      if (done) { accept(buffer); break; }
    }
    if (!result) throw new Error('连接已结束，但未收到完整分析结果，请重试。');
    state = { data: result, title, source: input.lyrics, mode: input.mode, isSample: false, model, requestSignature, usage,
      savings: savings ? { reusedLines: Math.max(0, expected.length - savings.generatedLines) } : null };
    render(); persist();
    status(`分析完成 · ${result.lines.length} 句已完整对齐${usage ? ` · ${usageLabel(usage)}` : ''}。`);
    toast('分析完成，可以开始逐词练习了。');
  } catch (error) {
    // 结果采用整批替换。失败或取消不会破坏已显示的上一份结果。
    status(error.name === 'AbortError' ? '分析已取消，已有结果已保留。' : error.message, error.name !== 'AbortError');
  } finally { controller?.abort(); controller = null; busy(false); }
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 15000);
  $('exportDialog').close();
}
const safeName = () => (state.title || '歌词分析').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 100);

$('analyzeBtn').addEventListener('click', analyze);
$('cancelBtn').addEventListener('click', () => controller?.abort());
for (const id of ['sampleBtn', 'emptySampleBtn']) $(id).addEventListener('click', () => { loadSample(); if (id === 'emptySampleBtn') $('sheetTitle').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
$('clearBtn').addEventListener('click', () => { $('lyrics').value = ''; updateCount(); persist(); $('lyrics').focus(); });
for (const id of ['lyrics', 'inputMode']) $(id).addEventListener('input', () => { updateCount(); clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250); });
$('songTitle').addEventListener('input', () => { if (state.data) { state.title = $('songTitle').value.trim(); $('sheetTitle').textContent = state.title || '未命名的歌'; } clearTimeout(saveTimer); saveTimer = setTimeout(persist, 250); });
$('gridBtn').addEventListener('click', () => { setView(false); persist(); });
$('cleanBtn').addEventListener('click', () => { setView(true); persist(); });
$('fontSize').addEventListener('input', () => { document.documentElement.style.setProperty('--jp-size', `${$('fontSize').value}px`); persist(); });
$('soramimiBtn').addEventListener('click', () => { setSoramimi(!showSoramimi); persist(); });
$('focusBtn').addEventListener('click', () => {
  const focus = document.body.classList.toggle('focus-mode');
  $('focusBtn').setAttribute('aria-pressed', String(focus)); $('focusBtn').setAttribute('aria-label', focus ? '退出专注阅读' : '专注阅读');
});
$('copyBtn').addEventListener('click', async () => {
  if (!state.data) return;
  try { await navigator.clipboard.writeText(toFourLines(state.data)); toast('已复制全部句子的四行文本。'); }
  catch { toast('浏览器不允许复制，请使用「导出 → TXT」。'); }
});
for (const [button, dialog] of [['settingsBtn', 'settingsDialog'], ['guideBtn', 'guideDialog'], ['exportBtn', 'exportDialog']]) $(button).addEventListener('click', () => $(dialog).showModal());
document.querySelectorAll('.close-dialog').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
$('settingsForm').addEventListener('submit', event => {
  event.preventDefault();
  const baseUrl = $('baseUrl').value.trim();
  try {
    const parsed = new URL(baseUrl);
    if (!['https:', 'http:'].includes(parsed.protocol) || /\/chat\/completions\/?$/.test(parsed.pathname) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error();
  } catch { $('settingsStatus').textContent = '请填写有效的 API 根地址，例如 DeepSeek 或 OpenAI 的地址。'; return; }
  const model = $('modelName').value.trim();
  if (!model) { $('settingsStatus').textContent = '请填写你要使用的模型名称。'; $('modelName').focus(); return; }
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) { $('settingsStatus').textContent = '请输入 API Key；密钥只保存在本机浏览器。'; $('apiKey').focus(); return; }
  config = { baseUrl, model, apiKey, format: $('outputFormat').value };
  persist(); updateConnection(); $('settingsStatus').textContent = ''; $('settingsDialog').close();
  toast('模型设置已保存。点击「开始逐句分析」使用。');
});
$('forgetKeyBtn').addEventListener('click', () => { config.apiKey = ''; $('apiKey').value = ''; persist(); updateConnection(); toast('已清除本机保存的密钥。'); });
$('exportJsonBtn').addEventListener('click', () => { if (state.data) download(`${safeName()}.json`, JSON.stringify({ version: 1, title: state.title, source: state.source, mode: state.mode, isSample: state.isSample, model: state.model, showSoramimi, ...state.data }, null, 2), 'application/json;charset=utf-8'); });
$('exportTextBtn').addEventListener('click', () => { if (state.data) download(`${safeName()}.txt`, toFourLines(state.data), 'text/plain;charset=utf-8'); });
$('printBtn').addEventListener('click', () => { $('exportDialog').close(); window.print(); });
$('importBtn').addEventListener('click', () => $('importFile').click());
$('importFile').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    if (file.size > 1500000) throw new Error('文件太大，请导入小于 1.5 MB 的分析 JSON。');
    const value = JSON.parse(await file.text());
    const data = validateAnalysis(value);
    const source = typeof value.source === 'string' ? value.source : data.lines.map(l => l.original).join('\n');
    const mode = ['raw', 'paired', 'auto'].includes(value.mode) ? value.mode : 'raw';
    validateAnalysis(data, parseLyrics(source, mode));
    state = { data: { lines: data.lines }, title: typeof value.title === 'string' ? value.title.slice(0, 120) : file.name.replace(/\.json$/i, ''), source, mode, isSample: value.isSample === true, model: typeof value.model === 'string' ? value.model.slice(0, 150) : '' };
    setSoramimi(value.showSoramimi === true);
    $('lyrics').value = source; $('songTitle').value = state.title; $('inputMode').value = mode;
    updateCount(); render(); persist(); status(`已导入 ${data.lines.length} 句完整分析。`); toast('分析已导入。');
  } catch (error) { toast(`导入失败：${error.message}`); }
  finally { event.target.value = ''; }
});

function restore() {
  const saves = [];
  for (const key of [storageKey, ...legacyStorageKeys]) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const candidate = JSON.parse(raw);
      if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) saves.push({ key, value: candidate });
    } catch { /* Skip malformed data and keep looking for an older usable save. */ }
  }
  const hasFinishedAnalysis = ({ value }) => {
    const data = value.state?.data || value.analysis;
    if (!data || value.state?.isSample === true) return false;
    try { validateAnalysis(data); return true; } catch { return false; }
  };
  // A previous build may have already written the built-in example under the
  // new key. Prefer a saved user analysis from an older key in that case.
  const selected = saves.find(save => save.key === storageKey && hasFinishedAnalysis(save))
    || saves.find(hasFinishedAnalysis)
    || saves.find(save => save.key === storageKey)
    || saves[0];
  const value = selected?.value || null;
  const foundKey = selected?.key || storageKey;
  if (!value) { loadSample(); return; }

  const saved = value.state && typeof value.state === 'object' ? value.state : {};
  const savedMode = ['auto', 'raw', 'paired'].includes(saved.mode) ? saved.mode : 'auto';
  const savedSource = typeof saved.source === 'string' ? saved.source.slice(0, 16000) : '';
  let savedData = null;
  const candidateData = saved.data || value.analysis;
  if (candidateData) {
    try {
      // The saved analysis is independent of the editable input box. Validate its
      // internal structure first, then use the saved source only as an extra check.
      savedData = { lines: validateAnalysis(candidateData).lines };
      if (savedSource) {
        try { validateAnalysis(savedData, parseLyrics(savedSource, savedMode)); }
        catch { /* Preserve a structurally valid result even if its source is stale. */ }
      }
    } catch { savedData = null; }
  }
  const resultSource = savedSource || (savedData ? savedData.lines.map(line => line.original).join('\n') : '');
  state = {
    data: savedData,
    title: typeof saved.title === 'string' ? saved.title.slice(0, 120) : (typeof value.title === 'string' ? value.title.slice(0, 120) : ''),
    source: resultSource,
    mode: savedMode,
    isSample: saved.isSample === true,
    model: typeof saved.model === 'string' ? saved.model.slice(0, 150) : '',
    requestSignature: typeof saved.requestSignature === 'string' && savedData ? saved.requestSignature : '',
    usage: saved.usage && typeof saved.usage === 'object' ? saved.usage : null,
    savings: saved.savings && typeof saved.savings === 'object' ? saved.savings : null
  };
  config = value.config && typeof value.config === 'object' ? {
    baseUrl: typeof value.config.baseUrl === 'string' ? value.config.baseUrl.slice(0, 500) : '',
    model: typeof value.config.model === 'string' ? value.config.model.slice(0, 150) : '',
    apiKey: typeof value.config.apiKey === 'string' ? value.config.apiKey.slice(0, 1000) : '',
    format: ['json_schema', 'json_object', 'prompt'].includes(value.config.format) ? value.config.format : 'json_schema'
  } : {};
  $('lyrics').value = typeof value.input === 'string' ? value.input.slice(0, 16000) : resultSource;
  $('songTitle').value = typeof value.title === 'string' ? value.title.slice(0, 120) : state.title;
  $('inputMode').value = ['auto', 'raw', 'paired'].includes(value.mode) ? value.mode : savedMode;
  const size = Math.max(17, Math.min(27, Number(value.fontSize) || 21));
  $('fontSize').value = size; document.documentElement.style.setProperty('--jp-size', `${size}px`);
  setView(value.view === 'clean');
  setSoramimi(value.showSoramimi === true);
  if (foundKey !== storageKey) {
    try { localStorage.setItem(storageKey, JSON.stringify({ ...value, state })); }
    catch { /* The legacy save remains untouched if the browser is out of space. */ }
  }
  updateCount(); render();
}
restore();
try {
  const response = await fetch('/api/status');
  if (!response.ok) throw new Error();
  serverStatus = await response.json();
  $('modelName').placeholder = '例如 deepseek-flash 或 OpenAI 模型 ID';
  $('outputFormat').value = 'json_schema';
  $('configFields').disabled = false;
  $('publicConfigNote').hidden = serverStatus.local;
  $('forgetKeyBtn').hidden = false;
  fillSettings();
  updateConnection();
} catch { status('未连接本地服务。请运行启动脚本，再通过 http://127.0.0.1:8787 打开网页。', true); }
