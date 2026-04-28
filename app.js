/* =============================================
   app.js — 职场雷达
   GitHub Issues 数据获取 + 渲染引擎
============================================= */

'use strict';

/* ── 配置存储 ─────────────────────────────── */
const STORAGE_KEY = 'job_radar_cfg';

/* 默认仓库配置，用户无需手动填写 */
const DEFAULT_CONFIG = { owner: 'gdsmzj', repo: 'gdsmzj.github.io', token: '' };

function loadConfig() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_CONFIG };
    const saved = JSON.parse(raw);
    // 若 owner/repo 为空则回退到默认值
    if (!saved.owner || !saved.repo) return { ...DEFAULT_CONFIG, token: saved.token || '' };
    return saved;
  } catch { return { ...DEFAULT_CONFIG }; }
}

function saveConfig(cfg) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
}

/* ── 全局状态 ─────────────────────────────── */
const state = {
  allIssues: [],     // 原始 issue 列表（已解析）
  filtered: [],      // 当前筛选结果
  tab: 'all',        // all | good | bad
  search: '',
  activeTag: '',
  sort: 'latest',
  page: 1,
  perPage: 12,
  loading: false,
  totalPages: 1,
  config: loadConfig(),
};

/* ── GitHub API ───────────────────────────── */
const GITHUB_API = 'https://api.github.com';

async function fetchIssues(page = 1) {
  const { owner, repo, token } = state.config;
  if (!owner || !repo) throw new Error('未配置仓库');

  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=closed&per_page=100&page=${page}`;
  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const resp = await fetch(url, { headers });

  if (resp.status === 403) {
    const remaining = resp.headers.get('X-RateLimit-Remaining');
    if (remaining === '0') throw new Error('GitHub API 访问频率已达上限，请稍后重试或配置 Token。');
    throw new Error('无权限访问该仓库（403），请检查 Token 或仓库是否公开。');
  }
  if (resp.status === 404) {
    throw new Error(`仓库 ${owner}/${repo} 不存在或无访问权限（404）。`);
  }
  if (!resp.ok) {
    throw new Error(`请求失败（HTTP ${resp.status}）`);
  }

  const link = resp.headers.get('Link') || '';
  const hasNext = link.includes('rel="next"');

  const data = await resp.json();
  return { issues: data, hasNext };
}

async function loadAllIssues() {
  const allData = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const { issues, hasNext: hn } = await fetchIssues(page);
    allData.push(...issues);
    hasNext = hn;
    page++;
    if (page > 10) break; // 安全上限：最多 1000 条
  }
  return allData;
}

/* ── 标题解析 ─────────────────────────────── */

/**
 * 解析 Issue 标题
 * 格式1: 中介避雷/公司/地点/中介名称
 * 格式2: 直聘好厂/平台认证/岗位信息/工作地点/工作待遇/工作时长/薪资水平
 */
function parseIssue(issue) {
  const raw = issue.title.trim();
  const parts = raw.split('/').map(s => s.trim());
  const type = parts[0];

  const base = {
    id: issue.number,
    raw,
    url: issue.html_url,
    body: issue.body || '',
    author: issue.user?.login || '匿名',
    authorAvatar: issue.user?.avatar_url || '',
    authorUrl: issue.user?.html_url || '',
    createdAt: issue.created_at,
    updatedAt: issue.updated_at,
    reactions: issue.reactions || {},
    comments: issue.comments || 0,
    labels: (issue.labels || []).map(l => l.name),
  };

  if (type === '中介避雷') {
    return {
      ...base,
      kind: 'bad',
      company: parts[1] || '未知公司',
      city: parts[2] || '',
      agencyName: parts[3] || '',
    };
  }

  if (type === '直聘好厂') {
    return {
      ...base,
      kind: 'good',
      platform: parts[1] || '',
      jobTitle: parts[2] || '',
      city: parts[3] || '',
      benefits: parts[4] || '',
      workHours: parts[5] || '',
      salary: parts[6] || '',
      // company 从 body 第一行提取，或 parts 的额外片段
      company: extractCompanyFromBody(issue.body) || parts[1] || '未知公司',
    };
  }

  // 无法识别的格式 — 作为普通条目
  return {
    ...base,
    kind: 'unknown',
    company: parts[1] || raw,
    city: '',
  };
}

function extractCompanyFromBody(body) {
  if (!body) return '';
  // 尝试提取 **公司：xxx** 或 公司：xxx 格式
  const m = body.match(/公司[：:]\s*([^\n\r*]+)/);
  return m ? m[1].trim() : '';
}

/* ── 标签提取 ─────────────────────────────── */
function buildTagCloud(issues) {
  const cityCount = {};
  issues.forEach(i => {
    if (i.city) {
      const c = i.city.trim();
      cityCount[c] = (cityCount[c] || 0) + 1;
    }
  });
  return Object.entries(cityCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([name, count]) => ({ name, count }));
}

/* ── 过滤 & 排序 ──────────────────────────── */
function applyFilters() {
  let list = [...state.allIssues];

  // 类型 tab
  if (state.tab === 'good') list = list.filter(i => i.kind === 'good');
  else if (state.tab === 'bad') list = list.filter(i => i.kind === 'bad');

  // 城市 tag
  if (state.activeTag) {
    list = list.filter(i => i.city === state.activeTag);
  }

  // 关键词搜索
  if (state.search.trim()) {
    const q = state.search.toLowerCase();
    list = list.filter(i => {
      return (
        i.company?.toLowerCase().includes(q) ||
        i.city?.toLowerCase().includes(q) ||
        i.agencyName?.toLowerCase().includes(q) ||
        i.jobTitle?.toLowerCase().includes(q) ||
        i.salary?.toLowerCase().includes(q) ||
        i.platform?.toLowerCase().includes(q) ||
        i.body?.toLowerCase().includes(q)
      );
    });
  }

  // 排序
  if (state.sort === 'latest') {
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else if (state.sort === 'oldest') {
    list.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  } else if (state.sort === 'hot') {
    list.sort((a, b) => {
      const ra = (b.reactions?.['+1'] || 0) + (b.comments || 0);
      const rb = (a.reactions?.['+1'] || 0) + (a.comments || 0);
      return ra - rb;
    });
  }

  state.filtered = list;
  state.page = 1;
}

/* ── 日期格式化 ───────────────────────────── */
function formatDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)} 天前`;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ── 渲染卡片 ─────────────────────────────── */
function renderCard(item) {
  const a = document.createElement('a');
  a.href = item.url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.className = `entry-card card-${item.kind === 'good' ? 'good' : item.kind === 'bad' ? 'bad' : ''}`;

  if (item.kind === 'good') {
    a.innerHTML = renderGoodCard(item);
  } else if (item.kind === 'bad') {
    a.innerHTML = renderBadCard(item);
  } else {
    a.innerHTML = renderUnknownCard(item);
  }

  return a;
}

function renderGoodCard(item) {
  const reacts = item.reactions?.['+1'] || 0;
  const bodyText = item.body
    ? `<p class="card-body-text">${escHtml(item.body.slice(0, 300))}</p>`
    : '';

  const salaryHtml = item.salary
    ? `<span class="salary-pill">💰 ${escHtml(item.salary)}</span>`
    : '';

  return `
    <div class="card-header">
      <span class="card-company">${escHtml(item.company || item.jobTitle || '好厂')}</span>
      <span class="card-type-badge badge-good">✅ 好厂推荐</span>
    </div>
    <div class="card-meta">
      ${item.city ? `<span class="meta-item"><span class="meta-icon">📍</span>${escHtml(item.city)}</span>` : ''}
      ${item.jobTitle ? `<span class="meta-item"><span class="meta-icon">💼</span>${escHtml(item.jobTitle)}</span>` : ''}
      ${item.platform ? `<span class="meta-item"><span class="meta-icon">🔖</span>${escHtml(item.platform)}</span>` : ''}
    </div>
    <div class="card-fields">
      ${item.benefits ? `<div class="field-item"><span class="field-key">工作待遇</span><span class="field-val">${escHtml(item.benefits)}</span></div>` : ''}
      ${item.workHours ? `<div class="field-item"><span class="field-key">工作时长</span><span class="field-val">${escHtml(item.workHours)}</span></div>` : ''}
    </div>
    ${salaryHtml}
    ${bodyText}
    <div class="card-footer">
      <span class="card-author">
        ${item.authorAvatar ? `<img class="author-avatar" src="${escHtml(item.authorAvatar)}" alt="${escHtml(item.author)}" loading="lazy"/>` : ''}
        ${escHtml(item.author)}
      </span>
      <div class="card-reactions">
        ${reacts ? `<span class="reaction">👍 ${reacts}</span>` : ''}
        ${item.comments ? `<span class="reaction">💬 ${item.comments}</span>` : ''}
        <span class="card-date">${formatDate(item.createdAt)}</span>
      </div>
    </div>`;
}

function renderBadCard(item) {
  const reacts = item.reactions?.['-1'] || item.reactions?.confused || 0;
  const bodyText = item.body
    ? `<p class="card-body-text">${escHtml(item.body.slice(0, 300))}</p>`
    : '';

  return `
    <div class="card-header">
      <span class="card-company">${escHtml(item.company || '未知公司')}</span>
      <span class="card-type-badge badge-bad">⚠️ 中介避雷</span>
    </div>
    <div class="card-meta">
      ${item.city ? `<span class="meta-item"><span class="meta-icon">📍</span>${escHtml(item.city)}</span>` : ''}
      ${item.agencyName ? `<span class="meta-item"><span class="meta-icon">🏢</span>中介：${escHtml(item.agencyName)}</span>` : ''}
    </div>
    ${bodyText}
    <div class="card-footer">
      <span class="card-author">
        ${item.authorAvatar ? `<img class="author-avatar" src="${escHtml(item.authorAvatar)}" alt="${escHtml(item.author)}" loading="lazy"/>` : ''}
        ${escHtml(item.author)}
      </span>
      <div class="card-reactions">
        ${reacts ? `<span class="reaction">⚠️ ${reacts}</span>` : ''}
        ${item.comments ? `<span class="reaction">💬 ${item.comments}</span>` : ''}
        <span class="card-date">${formatDate(item.createdAt)}</span>
      </div>
    </div>`;
}

function renderUnknownCard(item) {
  return `
    <div class="card-header">
      <span class="card-company">${escHtml(item.company || item.raw)}</span>
    </div>
    ${item.body ? `<p class="card-body-text">${escHtml(item.body.slice(0, 200))}</p>` : ''}
    <div class="card-footer">
      <span class="card-author">${escHtml(item.author)}</span>
      <span class="card-date">${formatDate(item.createdAt)}</span>
    </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── DOM 更新 ─────────────────────────────── */
function renderGrid() {
  const grid = document.getElementById('cardGrid');
  const noResult = document.getElementById('stateNoResult');
  const loadMoreWrap = document.getElementById('loadMoreWrap');

  const start = 0;
  const end = state.page * state.perPage;
  const visible = state.filtered.slice(start, end);

  grid.innerHTML = '';
  if (visible.length === 0) {
    noResult.style.display = 'flex';
    loadMoreWrap.style.display = 'none';
    return;
  }

  noResult.style.display = 'none';
  visible.forEach(item => grid.appendChild(renderCard(item)));

  if (state.filtered.length > end) {
    loadMoreWrap.style.display = 'flex';
  } else {
    loadMoreWrap.style.display = 'none';
  }
}

function updateStats() {
  const issues = state.allIssues;
  const cities = new Set(issues.filter(i => i.city).map(i => i.city));
  document.getElementById('statTotal').textContent = issues.length;
  document.getElementById('statGood').textContent = issues.filter(i => i.kind === 'good').length;
  document.getElementById('statBad').textContent = issues.filter(i => i.kind === 'bad').length;
  document.getElementById('statCities').textContent = cities.size;
  document.getElementById('statsBar').style.display = 'grid';
}

function renderTagCloud() {
  const cloud = document.getElementById('tagCloud');
  cloud.innerHTML = '';
  const tags = buildTagCloud(state.allIssues);
  tags.forEach(({ name, count }) => {
    const btn = document.createElement('button');
    btn.className = 'tag' + (state.activeTag === name ? ' active-tag' : '');
    btn.textContent = `${name} (${count})`;
    btn.addEventListener('click', () => {
      state.activeTag = state.activeTag === name ? '' : name;
      applyFilters();
      renderTagCloud();
      renderGrid();
    });
    cloud.appendChild(btn);
  });
}

/* ── 显示/隐藏状态 ────────────────────────── */
function showState(name) {
  ['stateEmpty', 'stateLoading', 'stateError', 'stateNoResult', 'cardGrid'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
  });
  document.getElementById(name).style.display = name === 'cardGrid' ? 'grid' : 'flex';
}

/* ── 主加载流程 ───────────────────────────── */
async function loadData() {
  const { owner, repo } = state.config;
  if (!owner || !repo) {
    showState('stateEmpty');
    return;
  }

  showState('stateLoading');
  state.loading = true;

  try {
    const raw = await loadAllIssues();
    // 过滤 pull requests (有 pull_request 字段)
    const issueOnly = raw.filter(i => !i.pull_request);
    state.allIssues = issueOnly.map(parseIssue);
    applyFilters();
    updateStats();
    renderTagCloud();
    showState('cardGrid');
    renderGrid();

    // 更新提交链接
    const repoLink = document.getElementById('repoLink');
    repoLink.href = `https://github.com/${owner}/${repo}/issues`;
    const btnSubmit = document.getElementById('btnSubmitIssue');
    btnSubmit.href = `https://github.com/${owner}/${repo}/issues/new`;
  } catch (err) {
    showState('stateError');
    document.getElementById('errorTitle').textContent = '加载失败';
    document.getElementById('errorDesc').textContent = err.message;
  } finally {
    state.loading = false;
  }
}

/* ── 配置弹窗 ─────────────────────────────── */
function openModal() {
  const modal = document.getElementById('configModal');
  modal.classList.add('open');
  document.getElementById('cfgOwner').value = state.config.owner;
  document.getElementById('cfgRepo').value = state.config.repo;
  document.getElementById('cfgToken').value = state.config.token || '';
}

function closeModal() {
  document.getElementById('configModal').classList.remove('open');
}

/* ── 初始化事件绑定 ───────────────────────── */
function init() {
  /* 配置弹窗（入口已隐藏，保留绑定以兼容） */
  document.getElementById('btnConfig').addEventListener('click', openModal);
  const btnOpenCfg = document.getElementById('btnOpenConfig');
  if (btnOpenCfg) btnOpenCfg.addEventListener('click', openModal);
  document.getElementById('btnCloseModal').addEventListener('click', closeModal);
  document.getElementById('btnCancelConfig').addEventListener('click', closeModal);
  document.getElementById('configModal').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal();
  });

  document.getElementById('btnSaveConfig').addEventListener('click', () => {
    const owner = document.getElementById('cfgOwner').value.trim();
    const repo = document.getElementById('cfgRepo').value.trim();
    const token = document.getElementById('cfgToken').value.trim();
    if (!owner || !repo) {
      alert('请填写仓库所有者和仓库名称');
      return;
    }
    state.config = { owner, repo, token };
    saveConfig(state.config);
    closeModal();
    loadData();
  });

  /* 重试 */
  document.getElementById('btnRetry').addEventListener('click', loadData);

  /* Tab 切换 */
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      state.tab = btn.dataset.tab;
      applyFilters();
      renderGrid();
    });
  });

  /* 搜索 */
  let searchTimer;
  document.getElementById('searchInput').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value;
      applyFilters();
      renderGrid();
    }, 250);
  });

  /* 排序 */
  document.getElementById('sortSelect').addEventListener('change', e => {
    state.sort = e.target.value;
    applyFilters();
    renderGrid();
  });

  /* 加载更多 */
  document.getElementById('btnLoadMore').addEventListener('click', () => {
    state.page++;
    renderGrid();
  });

  /* 启动加载 */
  loadData();
}

/* ── 入口 ─────────────────────────────────── */
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
