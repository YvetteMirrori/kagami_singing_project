const $ = id => document.getElementById(id);
const escapeHtml = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
let selectedStatus = 'pending';
let authenticated = false;
let loadSequence = 0;

function message(id, text = '', error = false) {
  const node = $(id); node.textContent = text; node.classList.toggle('error', error);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `请求失败（${response.status}）`);
  return value;
}

function showDashboard(value) {
  authenticated = value;
  $('loginPanel').hidden = authenticated;
  $('reviewPanel').hidden = !authenticated;
  $('logoutBtn').hidden = !authenticated;
  if (authenticated) loadRequests();
}

function renderRequests(requests) {
  $('reviewSummary').textContent = `${requests.length} 条${selectedStatus === 'pending' ? '待审核' : selectedStatus === 'approved' ? '已通过' : '已拒绝'}申请`;
  if (!requests.length) {
    $('requestList').innerHTML = '<div class="empty">当前没有申请。</div>';
    return;
  }
  $('requestList').innerHTML = requests.map(request => {
    const lines = request.data.lines.map(line => `<article class="lyric-line"><div class="lyric-original">${escapeHtml(line.original)}</div><div class="lyric-translation">${escapeHtml(line.translation)}</div><div class="lyric-tokens">${line.tokens.map(token => `<span class="token-preview">${escapeHtml(token.romaji)}<small>${escapeHtml(token.annotated)} · ${escapeHtml(token.meaning)}</small></span>`).join('')}</div></article>`).join('');
    const actions = request.status === 'pending' ? `<div class="request-actions"><button class="button approve" data-action="approve" data-id="${request.id}" type="button">审核通过</button><button class="button reject" data-action="reject" data-id="${request.id}" type="button">拒绝</button></div>` : '';
    const note = request.reviewNote ? `<p class="request-meta">审核备注：${escapeHtml(request.reviewNote)}</p>` : '';
    return `<article class="request-item"><div class="request-top"><div><div class="request-title">${escapeHtml(request.title)}</div><div class="request-meta">提交于 ${escapeHtml(new Date(request.submittedAt).toLocaleString('zh-CN'))} · ${request.data.lines.length} 句</div>${note}</div>${actions}</div><details class="request-preview"><summary>查看完整歌词及分词</summary><div class="lyric-preview">${lines}</div></details></article>`;
  }).join('');
}

async function loadRequests() {
  const sequence = ++loadSequence;
  message('adminMessage', '');
  try {
    const result = await api(`/api/admin/requests?status=${selectedStatus}`);
    if (sequence === loadSequence) renderRequests(result.requests);
  }
  catch (error) { if (sequence === loadSequence) message('adminMessage', error.message, true); }
}

$('loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('loginForm').querySelector('button'); button.disabled = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: $('adminPassword').value }) });
    $('adminPassword').value = ''; message('loginMessage'); showDashboard(true);
  } catch (error) { message('loginMessage', error.message, true); }
  finally { button.disabled = false; }
});

$('logoutBtn').addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); }
  finally { showDashboard(false); }
});
$('refreshBtn').addEventListener('click', loadRequests);
window.addEventListener('focus', () => { if (authenticated) loadRequests(); });
document.addEventListener('visibilitychange', () => { if (authenticated && !document.hidden) loadRequests(); });
$('filters').addEventListener('click', event => {
  const button = event.target.closest('[data-status]');
  if (!button) return;
  selectedStatus = button.dataset.status;
  $('filters').querySelectorAll('button').forEach(item => item.classList.toggle('selected', item === button));
  loadRequests();
});
$('requestList').addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const action = button.dataset.action;
  const note = action === 'reject' ? (prompt('拒绝原因（选填）') || '') : '';
  button.disabled = true;
  try {
    await api(`/api/admin/requests/${button.dataset.id}/${action}`, { method: 'POST', body: JSON.stringify({ note }) });
    message('adminMessage', action === 'approve' ? '歌曲已写入公开歌曲库。' : '申请已拒绝。');
    await loadRequests();
  } catch (error) { message('adminMessage', error.message, true); button.disabled = false; }
});

try { showDashboard((await api('/api/admin/session')).authenticated === true); }
catch { showDashboard(false); }
