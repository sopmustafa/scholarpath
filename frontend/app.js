/* ═══════════════════════════════════════════════════════════════
   ScholarPath v2 — app.js
   Auth, profile, comments, live scraping, Groq AI, auto-year
═══════════════════════════════════════════════════════════════ */

const API_BASE = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? `http://localhost:3000`
  : window.location.origin;

// ─── State ──────────────────────────────────────────────────────
let currentUser        = null;
let authToken          = localStorage.getItem('sp-token') || null;
let bookmarks          = JSON.parse(localStorage.getItem('sp-bookmarks') || '[]');
let compareList        = JSON.parse(localStorage.getItem('sp-compare')   || '[]');
let currentView        = 'grid';
let currentSection     = 'search';
let allScholarships    = [];
let filteredScholarships = [];
let yearWindow         = { yearFrom: new Date().getFullYear(), yearTo: new Date().getFullYear()+3, current: new Date().getFullYear() };
let liveItems          = [];
let selectedInterests  = [];
let aiSearchTimeout    = null;

const INTEREST_OPTIONS = [
  'Research','Exchange','Leadership','Sustainability','Technology','Health',
  'Arts','Business','Law','Education','Agriculture','Climate','Peace',
  'Developing Countries','STEM','Women in STEM','Sports','Entrepreneurship',
];

// ─── Boot ────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  checkResetToken();
  checkVerifyToken();
  initGoogleSignIn();

  if (authToken) {
    try {
      const res  = await apiFetch('/api/auth/me');
      currentUser = res.user;
      enterApp();
    } catch (_) {
      authToken = null;
      localStorage.removeItem('sp-token');
      showAuth();
    }
  } else {
    showAuth();
  }
});

// ─── URL token handling ──────────────────────────────────────────
function checkResetToken() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('reset');
  if (token) {
    showAuthWrapper();
    hideAllForms();
    document.getElementById('form-reset').classList.remove('hidden');
    window._resetToken = token;
  }
}

function checkVerifyToken() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('verify') || (window.location.pathname === '/verify-email' ? new URLSearchParams(window.location.search).get('token') : null);
  if (token) {
    apiFetch(`/api/auth/verify-email?token=${token}`, 'GET', null, false)
      .then(data => {
        authToken   = data.token;
        currentUser = data.user;
        localStorage.setItem('sp-token', authToken);
        window.history.replaceState({}, '', '/');
        enterApp();
        showToast('Email verified! Welcome to ScholarPath 🎓', 'success');
      })
      .catch(() => {
        showAuth();
        setAuthMsg('Verification link is invalid or expired.', 'error');
      });
  }
}

// ─── App entry ───────────────────────────────────────────────────
async function enterApp() {
  document.getElementById('auth-wrapper').classList.add('hidden');
  document.getElementById('app-wrapper').classList.remove('hidden');
  updateSidebarUser();
  await loadYearWindow();
  initYearInputs();
  await loadScholarships();
  await loadLiveSources();
  updateBookmarkBadge();
  updateCompareBadge();
  renderDeadlines();
  renderInterestPicker();
  loadProfile();
}

function showAuth() {
  document.getElementById('auth-wrapper').classList.remove('hidden');
  document.getElementById('app-wrapper').classList.add('hidden');
}

function showAuthWrapper() {
  document.getElementById('auth-wrapper').classList.remove('hidden');
  document.getElementById('app-wrapper').classList.add('hidden');
}

// ─── Google Sign-In ──────────────────────────────────────────────
function initGoogleSignIn() {
  if (typeof google === 'undefined' || !GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === '__GOOGLE_CLIENT_ID__') return;
  const renderBtn = (containerId) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    google.accounts.id.initialize({
      client_id : GOOGLE_CLIENT_ID,
      callback  : handleGoogleCredential,
    });
    google.accounts.id.renderButton(el, { theme:'filled_black', size:'large', width:320, text:'continue_with' });
  };
  renderBtn('google-signin-btn');
  renderBtn('google-signup-btn');
}

async function handleGoogleCredential(response) {
  try {
    const data = await apiFetch('/api/auth/google', 'POST', { credential: response.credential }, false);
    authToken   = data.token;
    currentUser = data.user;
    localStorage.setItem('sp-token', authToken);
    enterApp();
    showToast(`Welcome, ${currentUser.name}! 🎓`, 'success');
  } catch (err) {
    setAuthMsg(err.message || 'Google sign-in failed', 'error');
  }
}

// ─── Auth Tab Switching ──────────────────────────────────────────
function switchAuthTab(tab) {
  hideAllForms();
  clearAuthMsg();
  document.getElementById(`form-${tab}`)?.classList.remove('hidden');
  ['login','register'].forEach(t => {
    const btn = document.getElementById(`tab-${t}`);
    if (btn) btn.classList.toggle('active', t === tab);
  });
}

function hideAllForms() {
  ['login','register','forgot','reset'].forEach(f => document.getElementById(`form-${f}`)?.classList.add('hidden'));
}

// ─── Register ────────────────────────────────────────────────────
async function handleRegister() {
  const name  = document.getElementById('reg-name')?.value.trim();
  const email = document.getElementById('reg-email')?.value.trim();
  const pass  = document.getElementById('reg-password')?.value;
  const pass2 = document.getElementById('reg-password2')?.value;

  if (!name || !email || !pass) return setAuthMsg('All fields are required.', 'error');
  if (pass !== pass2) return setAuthMsg('Passwords do not match.', 'error');
  if (pass.length < 6) return setAuthMsg('Password must be at least 6 characters.', 'error');

  try {
    const data = await apiFetch('/api/auth/register', 'POST', { name, email, password: pass }, false);
    setAuthMsg('✅ ' + data.message + ' Check your inbox!', 'success');
    ['reg-name','reg-email','reg-password','reg-password2'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
  } catch (err) {
    setAuthMsg(err.message || 'Registration failed', 'error');
  }
}

// ─── Login ───────────────────────────────────────────────────────
async function handleLogin() {
  const email = document.getElementById('login-email')?.value.trim();
  const pass  = document.getElementById('login-password')?.value;
  if (!email || !pass) return setAuthMsg('Email and password required.', 'error');

  try {
    const data = await apiFetch('/api/auth/login', 'POST', { email, password: pass }, false);
    authToken   = data.token;
    currentUser = data.user;
    localStorage.setItem('sp-token', authToken);
    enterApp();
    showToast(`Welcome back, ${currentUser.name}! 🎓`, 'success');
  } catch (err) {
    setAuthMsg(err.message || 'Login failed', 'error');
  }
}

// Allow Enter key for login
document.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    const active = document.querySelector('#form-login:not(.hidden)');
    if (active) handleLogin();
  }
});

// ─── Forgot Password ─────────────────────────────────────────────
async function handleForgot() {
  const email = document.getElementById('forgot-email')?.value.trim();
  if (!email) return setAuthMsg('Enter your email address.', 'error');
  try {
    const data = await apiFetch('/api/auth/forgot-password', 'POST', { email }, false);
    setAuthMsg('📧 ' + data.message, 'success');
  } catch (err) {
    setAuthMsg(err.message || 'Error sending reset email', 'error');
  }
}

// ─── Reset Password ──────────────────────────────────────────────
async function handleReset() {
  const token = window._resetToken;
  const pass  = document.getElementById('reset-password')?.value;
  const pass2 = document.getElementById('reset-password2')?.value;
  if (!pass || !pass2) return setAuthMsg('Both fields required.', 'error');
  if (pass !== pass2)  return setAuthMsg('Passwords do not match.', 'error');
  if (pass.length < 6) return setAuthMsg('Password must be at least 6 characters.', 'error');

  try {
    const data = await apiFetch('/api/auth/reset-password', 'POST', { token, password: pass }, false);
    setAuthMsg('✅ ' + data.message, 'success');
    window._resetToken = null;
    window.history.replaceState({}, '', '/');
    setTimeout(() => switchAuthTab('login'), 2000);
  } catch (err) {
    setAuthMsg(err.message || 'Reset failed', 'error');
  }
}

// ─── Logout ──────────────────────────────────────────────────────
function handleLogout() {
  authToken   = null;
  currentUser = null;
  localStorage.removeItem('sp-token');
  showAuth();
  switchAuthTab('login');
  showToast('Signed out', 'info');
}

// ─── Auth UI helpers ─────────────────────────────────────────────
function setAuthMsg(msg, type) {
  const el = document.getElementById('auth-msg');
  if (!el) return;
  el.textContent = msg;
  el.className   = `mb-4 px-4 py-3 rounded-xl text-sm ${type === 'success' ? 'bg-green-400/15 border border-green-400/30 text-green-400' : 'bg-red-400/15 border border-red-400/30 text-red-400'}`;
  el.classList.remove('hidden');
}

function clearAuthMsg() {
  const el = document.getElementById('auth-msg');
  if (el) { el.textContent = ''; el.classList.add('hidden'); }
}

function togglePwd(id) {
  const el = document.getElementById(id);
  if (el) el.type = el.type === 'password' ? 'text' : 'password';
}

// ─── Sidebar user info ───────────────────────────────────────────
function updateSidebarUser() {
  if (!currentUser) return;
  const nameEl   = document.getElementById('sidebar-username');
  const avatarEl = document.getElementById('sidebar-avatar');
  if (nameEl)   nameEl.textContent = currentUser.name;
  if (avatarEl) {
    const profile = null; // loaded later
    avatarEl.textContent = currentUser.name?.[0]?.toUpperCase() || '?';
  }
}

// ─── Year Window ─────────────────────────────────────────────────
async function loadYearWindow() {
  try {
    yearWindow = await apiFetch('/api/year');
  } catch (_) {
    const y = new Date().getFullYear();
    yearWindow = { yearFrom: y, yearTo: y+3, current: y };
  }
}

function initYearInputs() {
  const fe = document.getElementById('year-from');
  const te = document.getElementById('year-to');
  if (fe) { fe.min = yearWindow.current; fe.value = yearWindow.yearFrom; }
  if (te) { te.min = yearWindow.current; te.value = yearWindow.yearTo; }
  const lbl = document.getElementById('year-range-label');
  if (lbl) lbl.textContent = `${yearWindow.yearFrom} — ${yearWindow.yearTo}`;
}

function updateYearRange() {
  let from = parseInt(document.getElementById('year-from')?.value) || yearWindow.yearFrom;
  let to   = parseInt(document.getElementById('year-to')?.value)   || yearWindow.yearTo;
  if (from > to) { if (event?.target?.id === 'year-from') { from = to; document.getElementById('year-from').value = from; } else { to = from; document.getElementById('year-to').value = to; } }
  const lbl = document.getElementById('year-range-label');
  if (lbl) lbl.textContent = `${from} — ${to}`;
  localFilter();
}

// ─── Load Scholarships ───────────────────────────────────────────
async function loadScholarships() {
  setLoading(true);
  try {
    const data      = await apiFetch('/api/scholarships?limit=200');
    allScholarships = data.scholarships || [];
    filteredScholarships = [...allScholarships];
    renderGrid();
    updateSidebarTotal();
    const c = document.getElementById('results-count');
    if (c) c.textContent = allScholarships.length;
  } catch (e) {
    showToast('Could not load scholarships. Is the server running?', 'warning');
  } finally {
    setLoading(false);
  }
}

// ─── Filter ──────────────────────────────────────────────────────
function filterScholarships() {
  const q = document.getElementById('search-input')?.value || '';
  const expl = document.getElementById('ai-explanation');
  if (expl) expl.classList.add('hidden');

  if (q.length > 5 && q.includes(' ')) {
    clearTimeout(aiSearchTimeout);
    aiSearchTimeout = setTimeout(() => aiSearch(q), 700);
  } else {
    localFilter();
  }
}

function localFilter() {
  const q       = (document.getElementById('search-input')?.value || '').toLowerCase();
  const country = document.getElementById('country-filter')?.value || '';
  const grade   = document.getElementById('grade-filter')?.value || '';
  const field   = document.getElementById('field-filter')?.value || '';
  const funding = document.getElementById('funding-filter')?.value || '';
  const yearFrom = parseInt(document.getElementById('year-from')?.value) || yearWindow.yearFrom;
  const yearTo   = parseInt(document.getElementById('year-to')?.value)   || yearWindow.yearTo;
  const sort     = document.getElementById('sort-filter')?.value || 'deadline';

  filteredScholarships = allScholarships.filter(s => {
    if (q && !s.name.toLowerCase().includes(q) && !s.organization.toLowerCase().includes(q) && !s.description.toLowerCase().includes(q) && !(s.tags||[]).some(t=>t.toLowerCase().includes(q))) return false;
    if (country && s.country !== country) return false;
    if (grade   && s.level   !== grade)   return false;
    if (field   && s.field   !== 'Any' && s.field !== field) return false;
    if (funding && s.funding !== funding) return false;
    if (s.yearStart > yearTo || s.yearEnd < yearFrom) return false;
    return true;
  });
  filteredScholarships.sort((a,b) => {
    if (sort==='deadline')    return new Date(a.deadline)-new Date(b.deadline);
    if (sort==='amount-high') return b.amount-a.amount;
    if (sort==='amount-low')  return a.amount-b.amount;
    if (sort==='name')        return a.name.localeCompare(b.name);
    return 0;
  });
  renderGrid();
  updateActiveFilters({ q, country, grade, field, funding });
  const c = document.getElementById('results-count');
  if (c) c.textContent = filteredScholarships.length;
}

async function aiSearch(query) {
  setLoading(true);
  try {
    const data = await apiFetch('/api/search', 'POST', { query });
    filteredScholarships = data.results || allScholarships;
    renderGrid();
    const expl = document.getElementById('ai-explanation');
    if (expl && data.explanation) { expl.textContent = '✦ AI: ' + data.explanation; expl.classList.remove('hidden'); }
    const c = document.getElementById('results-count');
    if (c) c.textContent = filteredScholarships.length;
  } catch (_) { localFilter(); }
  finally { setLoading(false); }
}

function clearFilters() {
  ['search-input','country-filter','grade-filter','field-filter','funding-filter'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
  if (document.getElementById('year-from')) document.getElementById('year-from').value = yearWindow.yearFrom;
  if (document.getElementById('year-to'))   document.getElementById('year-to').value   = yearWindow.yearTo;
  const lbl = document.getElementById('year-range-label');
  if (lbl) lbl.textContent = `${yearWindow.yearFrom} — ${yearWindow.yearTo}`;
  const expl = document.getElementById('ai-explanation');
  if (expl) { expl.textContent=''; expl.classList.add('hidden'); }
  filteredScholarships = [...allScholarships];
  renderGrid();
  updateActiveFilters({});
  const c = document.getElementById('results-count');
  if (c) c.textContent = filteredScholarships.length;
}

function updateActiveFilters({ q='', country='', grade='', field='', funding='' } = {}) {
  const container = document.getElementById('active-filters');
  if (!container) return;
  container.innerHTML = '';
  const add = (label, clearFn) => {
    const chip = document.createElement('span');
    chip.className = 'filter-chip';
    chip.innerHTML = `${label}<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    chip.onclick = clearFn;
    container.appendChild(chip);
  };
  if (q)       add(`"${q}"`, ()=>{ document.getElementById('search-input').value=''; filterScholarships(); });
  if (country) add(country,  ()=>{ document.getElementById('country-filter').value=''; filterScholarships(); });
  if (grade)   add(grade,    ()=>{ document.getElementById('grade-filter').value=''; filterScholarships(); });
  if (field)   add(field,    ()=>{ document.getElementById('field-filter').value=''; filterScholarships(); });
  if (funding) add(funding+' Funding', ()=>{ document.getElementById('funding-filter').value=''; filterScholarships(); });
}

// ─── Section Nav ─────────────────────────────────────────────────
function showSection(name) {
  currentSection = name;
  document.querySelectorAll('.section-content').forEach(s => s.classList.add('hidden'));
  const el = document.getElementById(`section-${name}`);
  if (el) { el.classList.remove('hidden'); el.style.animation='none'; el.offsetHeight; el.style.animation=''; }
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.section===name));
  if (name==='bookmarks') renderBookmarks();
  if (name==='compare')   renderCompare();
  if (name==='deadlines') renderDeadlines();
  if (name==='live')      renderLive();
  closeMobileSidebar();
}

// ─── Render Grid ─────────────────────────────────────────────────
function renderGrid() {
  const grid = document.getElementById('scholarship-grid');
  const noR  = document.getElementById('no-results');
  if (!grid) return;
  if (filteredScholarships.length===0) { grid.innerHTML=''; noR?.classList.remove('hidden'); return; }
  noR?.classList.add('hidden');
  grid.innerHTML = filteredScholarships.map(s => buildCard(s)).join('');
}

function buildCard(s) {
  const isBm   = bookmarks.includes(s.id);
  const isComp = compareList.includes(s.id);
  const dl     = getDaysLeft(s.deadline);
  const urgCls = dl<=30?'deadline-urgent':dl<=90?'deadline-warning':'deadline-ok';
  const lvlCls = getLevelClass(s.level);
  const fndCls = getFundingClass(s.funding);
  const dlTxt  = dl<0?'Deadline passed':dl===0?'Due today!':dl+'d left';
  const pct    = Math.max(0,Math.min(100,dl>0?(1-dl/365)*100:100));
  const isList = currentView==='list';

  if (isList) return `
    <div class="scholarship-card list-card" onclick="openModal(${s.id})">
      <div class="w-10 h-10 rounded-xl bg-white/05 flex items-center justify-center text-xl flex-shrink-0 border border-white/10">${s.flag}</div>
      <div class="flex-1 min-w-0"><div class="font-display font-600 text-sm text-white truncate">${s.name}</div><div class="text-slate2-400 text-xs mt-0.5 truncate">${s.organization}</div></div>
      <div class="hidden sm:flex items-center gap-2 flex-shrink-0"><span class="level-badge ${lvlCls}">${s.level}</span><span class="level-badge ${fndCls}">${s.funding}</span></div>
      <div class="text-right flex-shrink-0"><div class="text-xs ${urgCls}">${dlTxt}</div><div class="text-xs text-slate2-400 mt-0.5">${formatDate(s.deadline)}</div></div>
      <div onclick="event.stopPropagation()"><button class="card-action-btn ${isBm?'bookmarked':''}" onclick="toggleBookmark(${s.id})"><svg width="13" height="13" viewBox="0 0 24 24" fill="${isBm?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg></button></div>
    </div>`;

  return `
  <div class="scholarship-card" onclick="openModal(${s.id})">
    <div class="flex items-start justify-between mb-3">
      <div class="flex items-center gap-2 flex-wrap"><span class="country-chip">${s.flag} ${s.country}</span><span class="level-badge ${lvlCls}">${s.level}</span><span class="level-badge ${fndCls}">${s.funding}</span></div>
      <div class="flex items-center gap-1 flex-shrink-0" onclick="event.stopPropagation()">
        <button class="card-action-btn ${isComp?'compared':''}" onclick="toggleCompare(${s.id})" title="Compare"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 20V10M12 20V4M6 20v-6"/></svg></button>
        <button class="card-action-btn ${isBm?'bookmarked':''}" onclick="toggleBookmark(${s.id})" title="Bookmark"><svg width="13" height="13" viewBox="0 0 24 24" fill="${isBm?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg></button>
      </div>
    </div>
    <h3 class="font-display font-600 text-white text-base leading-tight mb-1">${s.name}</h3>
    <p class="text-slate2-400 text-xs mb-2">${s.organization}</p>
    <div class="amount-display text-xl mb-3">${formatAmount(s.amount,s.currency)}</div>
    <p class="text-slate2-300 text-xs leading-relaxed mb-3 line-clamp-2">${s.description}</p>
    ${(s.tags||[]).length?`<div class="flex flex-wrap gap-1 mb-3">${(s.tags||[]).slice(0,3).map(t=>`<span class="eligibility-tag">${t}</span>`).join('')}</div>`:''}
    <div class="flex items-center justify-between">
      <div class="${urgCls} text-xs font-500"><svg class="inline mr-1" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>${dlTxt}</div>
      <div class="text-xs text-slate2-400">${formatDate(s.deadline)}</div>
    </div>
    <div class="deadline-bar-bg mt-2"><div class="deadline-bar-fill" style="width:${pct}%;background:${dl<=30?'#f87171':dl<=90?'#fb923c':'var(--gold-400)'}"></div></div>
  </div>`;
}

// ─── Modal with comments ──────────────────────────────────────────
async function openModal(id) {
  let s = allScholarships.find(x=>x.id===id) || filteredScholarships.find(x=>x.id===id);
  if (!s) { try { s = await apiFetch(`/api/scholarships/${id}`); } catch(_){ return; } }

  const dl     = getDaysLeft(s.deadline);
  const urgCls = dl<=30?'deadline-urgent':dl<=90?'deadline-warning':'deadline-ok';
  const isBm   = bookmarks.includes(s.id);

  const content = document.getElementById('modal-content');
  if (!content) return;

  content.innerHTML = `
    <div class="modal-hero">
      <div class="flex items-start justify-between gap-4 mb-4">
        <div class="flex-1">
          <div class="flex items-center gap-2 flex-wrap mb-2">
            <span class="country-chip">${s.flag} ${s.country}</span>
            <span class="level-badge ${getLevelClass(s.level)}">${s.level}</span>
            <span class="level-badge ${getFundingClass(s.funding)}">${s.funding} funding</span>
            ${s.renewable?`<span class="level-badge" style="background:rgba(52,211,153,0.1);color:#34d399;border:1px solid rgba(52,211,153,0.2)">Renewable</span>`:''}
          </div>
          <h2 class="font-display text-2xl font-700 text-white leading-tight mb-1">${s.name}</h2>
          <p class="text-slate2-300 text-sm">${s.organization}</p>
        </div>
        <button onclick="closeModal()" class="card-action-btn flex-shrink-0"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>
      <div class="amount-display text-3xl mb-4">${formatAmount(s.amount,s.currency)}</div>
      <div class="flex flex-wrap gap-2">
        <a href="${s.link}" target="_blank" rel="noopener" class="apply-btn"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>Apply Now</a>
        <button onclick="toggleBookmark(${s.id})" class="card-action-btn px-3 w-auto gap-2 ${isBm?'bookmarked':''}" style="width:auto;padding:0 14px"><svg width="14" height="14" viewBox="0 0 24 24" fill="${isBm?'currentColor':'none'}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/></svg>${isBm?'Bookmarked':'Bookmark'}</button>
      </div>
    </div>
    <div class="modal-body">
      <p class="text-slate2-300 text-sm leading-relaxed mb-5">${s.description}</p>
      <div class="space-y-0 mb-5 rounded-xl overflow-hidden border border-white/06">
        ${mrow('Deadline',`<span class="${urgCls}">${formatDate(s.deadline)} (${dl>0?dl+'d left':'passed'})</span>`)}
        ${mrow('Year',`${s.yearStart}–${s.yearEnd}`)}
        ${mrow('GPA Required',s.gpa||'Not specified')}
        ${mrow('Field',s.field)}
        ${mrow('Renewable',s.renewable?'✓ Yes':'✗ No')}
        ${s.source?mrow('Source',`<span class="font-mono text-xs">${s.source}</span>`):''}
      </div>
      <div class="mb-5"><div class="text-xs text-slate2-400 uppercase tracking-widest mb-2">Eligibility</div><p class="text-sm text-slate2-300">${s.eligibility}</p></div>
      ${s.benefits?.length?`<div class="mb-5"><div class="text-xs text-slate2-400 uppercase tracking-widest mb-2">What's Covered</div><div class="flex flex-wrap gap-2">${s.benefits.map(b=>`<span class="eligibility-tag">✓ ${b}</span>`).join('')}</div></div>`:''}
      ${s.tags?.length?`<div class="flex flex-wrap gap-1.5 mb-6">${s.tags.map(t=>`<span class="filter-chip">${t}</span>`).join('')}</div>`:''}

      <!-- ── Comments ── -->
      <div class="border-t border-white/08 pt-6">
        <div class="flex items-center gap-2 mb-4">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-gold-400"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          <span class="font-display text-base font-600">Comments</span>
        </div>
        <div class="comment-compose mb-5">
          <textarea id="comment-input-${s.id}" rows="3" placeholder="Share your experience or ask a question…" class="comment-textarea w-full p-3 rounded-xl text-sm resize-none mb-2"></textarea>
          <button onclick="submitComment(${s.id})" class="apply-btn text-xs px-4 py-2">Post Comment</button>
        </div>
        <div id="comments-${s.id}" class="space-y-3"><p class="text-slate2-400 text-xs text-center py-4">Loading comments…</p></div>
      </div>
    </div>`;

  const overlay = document.getElementById('modal-overlay');
  if (overlay) overlay.classList.add('open');
  loadComments(s.id);
}

function mrow(label, value) {
  return `<div class="modal-row"><span class="modal-label">${label}</span><span class="modal-value">${value}</span></div>`;
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay')?.classList.remove('open');
}
document.addEventListener('keydown', e => { if(e.key==='Escape') document.getElementById('modal-overlay')?.classList.remove('open'); });

// ─── Comments ────────────────────────────────────────────────────
async function loadComments(scholarshipId) {
  const container = document.getElementById(`comments-${scholarshipId}`);
  if (!container) return;
  try {
    const comments = await apiFetch(`/api/comments/${scholarshipId}`);
    if (comments.length === 0) {
      container.innerHTML = '<p class="text-slate2-400 text-xs text-center py-4">No comments yet. Be the first!</p>';
      return;
    }
    container.innerHTML = comments.map(c => buildCommentHTML(c, scholarshipId)).join('');
  } catch (_) {
    container.innerHTML = '<p class="text-slate2-400 text-xs text-center py-4">Could not load comments.</p>';
  }
}

function buildCommentHTML(c, scholarshipId) {
  const initials = c.author?.[0]?.toUpperCase() || '?';
  const timeAgo  = getTimeAgo(c.createdAt);
  return `
  <div class="comment-item" id="comment-${c.id}">
    <div class="comment-avatar">${initials}</div>
    <div class="flex-1 min-w-0">
      <div class="flex items-center gap-2 mb-1">
        <span class="text-sm font-500 text-white">${c.author}</span>
        <span class="text-slate2-400 text-xs">${timeAgo}</span>
        ${c.edited?`<span class="text-slate2-400 text-xs italic">(edited)</span>`:''}
      </div>
      <p class="text-sm text-slate2-300 leading-relaxed" id="comment-text-${c.id}">${escHtml(c.text)}</p>
      ${c.isOwn?`
      <div class="flex gap-3 mt-2">
        <button onclick="deleteComment('${c.id}',${scholarshipId})" class="text-xs text-slate2-400 hover:text-red-400 transition-colors">Delete</button>
      </div>`:''}
    </div>
  </div>`;
}

async function submitComment(scholarshipId) {
  const input = document.getElementById(`comment-input-${scholarshipId}`);
  const text  = input?.value.trim();
  if (!text) return;
  try {
    const c = await apiFetch(`/api/comments/${scholarshipId}`, 'POST', { text });
    input.value = '';
    const container = document.getElementById(`comments-${scholarshipId}`);
    if (container) {
      const noComments = container.querySelector('p');
      if (noComments) noComments.remove();
      container.insertAdjacentHTML('afterbegin', buildCommentHTML(c, scholarshipId));
    }
    showToast('Comment posted!', 'success');
  } catch (err) {
    showToast(err.message || 'Could not post comment', 'warning');
  }
}

async function deleteComment(commentId, scholarshipId) {
  if (!confirm('Delete this comment?')) return;
  try {
    await apiFetch(`/api/comments/${commentId}`, 'DELETE');
    document.getElementById(`comment-${commentId}`)?.remove();
    showToast('Comment deleted', 'info');
  } catch (_) { showToast('Could not delete comment', 'warning'); }
}

// ─── Profile ─────────────────────────────────────────────────────
function renderInterestPicker() {
  const picker = document.getElementById('interests-picker');
  if (!picker) return;
  picker.innerHTML = INTEREST_OPTIONS.map(i => `
    <button type="button" onclick="toggleInterest('${i}')" id="int-${i.replace(/\s/g,'-')}"
      class="interest-tag ${selectedInterests.includes(i)?'active':''}">${i}</button>
  `).join('');
}

function toggleInterest(name) {
  const idx = selectedInterests.indexOf(name);
  if (idx === -1) selectedInterests.push(name);
  else selectedInterests.splice(idx, 1);
  const btn = document.getElementById(`int-${name.replace(/\s/g,'-')}`);
  if (btn) btn.classList.toggle('active', selectedInterests.includes(name));
}

async function loadProfile() {
  try {
    const data = await apiFetch('/api/profile');
    const p    = data.profile;
    const u    = data.user;
    if (document.getElementById('p-name'))   document.getElementById('p-name').value   = u?.name   || '';
    if (document.getElementById('p-email'))  document.getElementById('p-email').value  = u?.email  || '';
    if (document.getElementById('p-bio'))    document.getElementById('p-bio').value    = p?.bio    || '';
    if (document.getElementById('p-degree')) document.getElementById('p-degree').value = p?.degreeLevel || '';
    if (document.getElementById('p-country'))document.getElementById('p-country').value= p?.country || '';
    if (document.getElementById('p-major'))  document.getElementById('p-major').value  = p?.major  || '';
    if (document.getElementById('p-gpa'))    document.getElementById('p-gpa').value    = p?.gpa    || '';
    selectedInterests = p?.interests || [];
    renderInterestPicker();
    // Update sidebar avatar
    const avatarEl = document.getElementById('sidebar-avatar');
    if (avatarEl && p?.avatar) {
      avatarEl.innerHTML = `<img src="${p.avatar}" class="w-full h-full object-cover rounded-full"/>`;
    }
  } catch (_) {}
}

async function saveProfile() {
  const msgEl = document.getElementById('profile-msg');
  try {
    const body = {
      name        : document.getElementById('p-name')?.value.trim(),
      bio         : document.getElementById('p-bio')?.value.trim(),
      degreeLevel : document.getElementById('p-degree')?.value,
      country     : document.getElementById('p-country')?.value,
      major       : document.getElementById('p-major')?.value,
      gpa         : document.getElementById('p-gpa')?.value,
      interests   : selectedInterests,
    };
    await apiFetch('/api/profile', 'PUT', body);
    if (msgEl) { msgEl.textContent='✅ Profile saved!'; msgEl.className='mb-4 px-4 py-3 rounded-xl text-sm bg-green-400/15 border border-green-400/30 text-green-400'; msgEl.classList.remove('hidden'); setTimeout(()=>msgEl.classList.add('hidden'),3000); }
    if (currentUser && body.name) { currentUser.name = body.name; updateSidebarUser(); }
    showToast('Profile updated!', 'success');
  } catch (err) {
    if (msgEl) { msgEl.textContent='❌ '+(err.message||'Save failed'); msgEl.className='mb-4 px-4 py-3 rounded-xl text-sm bg-red-400/15 border border-red-400/30 text-red-400'; msgEl.classList.remove('hidden'); }
  }
}

// ─── Live Listings ────────────────────────────────────────────────
async function loadLiveSources() {
  try {
    const [sources, liveData] = await Promise.all([
      apiFetch('/api/sources'),
      apiFetch('/api/live'),
    ]);
    liveItems = liveData.items || [];
    renderSourcesPanel(sources);
  } catch (_) {}
}

function renderSourcesPanel(sources) {
  const panel = document.getElementById('sources-panel');
  if (!panel) return;
  panel.innerHTML = `
    <div class="text-gold-400 font-mono text-xs tracking-widest uppercase opacity-70 mb-2">Live Sources</div>
    <div class="space-y-0.5">
      ${sources.slice(0,6).map(s=>`
        <a href="${s.url}" target="_blank" rel="noopener" class="flex items-center gap-2 px-1 py-1 rounded hover:bg-white/05 group transition-colors">
          <span class="w-1.5 h-1.5 rounded-full ${s.type==='scrape'?'bg-green-400':'bg-slate2-500'} flex-shrink-0"></span>
          <span class="text-xs text-slate2-400 group-hover:text-white truncate transition-colors">${s.name}</span>
        </a>`).join('')}
    </div>
    ${liveItems.length?`<button onclick="showSection('live')" class="w-full mt-2 text-xs py-1 px-2 rounded bg-gold-400/10 border border-gold-400/20 text-gold-400 hover:bg-gold-400/20 transition-colors">${liveItems.length} live listings →</button>`:''}`;
}

function renderLive() {
  const grid = document.getElementById('live-grid');
  if (!grid) return;
  if (liveItems.length === 0) { grid.innerHTML = '<p class="text-slate2-400 text-sm text-center py-12 col-span-full">No live listings yet. Backend is scraping…</p>'; return; }
  grid.innerHTML = liveItems.map(item => `
    <a href="${item.link}" target="_blank" rel="noopener" class="scholarship-card block">
      <div class="flex items-start gap-3">
        <div class="w-8 h-8 rounded-lg bg-gold-400/10 border border-gold-400/20 flex items-center justify-center flex-shrink-0 mt-0.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-gold-400"><path d="M22 10v6M2 10l10-5 10 5-10 5z"/><path d="M6 12v5c3 3 9 3 12 0v-5"/></svg>
        </div>
        <div class="flex-1 min-w-0">
          <div class="font-display font-600 text-sm text-white leading-tight mb-1.5">${item.title}</div>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="country-chip">${item.source}</span>
            ${item.date?`<span class="text-slate2-400 text-xs">${item.date}</span>`:''}
          </div>
        </div>
        <svg class="flex-shrink-0 text-slate2-400 mt-0.5" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
      </div>
    </a>`).join('');
}

// ─── Bookmarks ────────────────────────────────────────────────────
function toggleBookmark(id) {
  const idx = bookmarks.indexOf(id);
  if (idx===-1) { bookmarks.push(id); showToast('Bookmarked!','success'); }
  else          { bookmarks.splice(idx,1); showToast('Bookmark removed','info'); }
  localStorage.setItem('sp-bookmarks',JSON.stringify(bookmarks));
  updateBookmarkBadge(); renderGrid();
  if (currentSection==='bookmarks') renderBookmarks();
}

function updateBookmarkBadge() {
  const b = document.getElementById('bookmark-count-badge');
  if (!b) return;
  if (bookmarks.length>0) { b.textContent=bookmarks.length; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function renderBookmarks() {
  const grid = document.getElementById('bookmark-grid');
  const empty = document.getElementById('no-bookmarks');
  if (!grid) return;
  const bms = allScholarships.filter(s=>bookmarks.includes(s.id));
  if (bms.length===0) { grid.innerHTML=''; empty?.classList.remove('hidden'); return; }
  empty?.classList.add('hidden');
  grid.innerHTML = bms.map(s=>buildCard(s)).join('');
}

// ─── Compare ─────────────────────────────────────────────────────
function toggleCompare(id) {
  const idx = compareList.indexOf(id);
  if (idx===-1) { if (compareList.length>=3) { showToast('Max 3 to compare','warning'); return; } compareList.push(id); showToast('Added to compare','info'); }
  else          { compareList.splice(idx,1); showToast('Removed from compare','info'); }
  localStorage.setItem('sp-compare',JSON.stringify(compareList));
  updateCompareBadge(); renderGrid();
  if (currentSection==='compare') renderCompare();
}

function updateCompareBadge() {
  const b = document.getElementById('compare-count-badge');
  if (!b) return;
  if (compareList.length>0) { b.textContent=compareList.length; b.classList.remove('hidden'); }
  else b.classList.add('hidden');
}

function renderCompare() {
  const empty = document.getElementById('no-compare');
  const table = document.getElementById('compare-table');
  if (!table) return;
  const items = allScholarships.filter(s=>compareList.includes(s.id));
  if (items.length===0) { empty?.classList.remove('hidden'); table.classList.add('hidden'); table.innerHTML=''; return; }
  empty?.classList.add('hidden'); table.classList.remove('hidden');
  const rows = [['Country',i=>`${i.flag} ${i.country}`],['Level',i=>i.level],['Field',i=>i.field],['Funding',i=>i.funding],['Amount',i=>formatAmount(i.amount,i.currency)],['Deadline',i=>formatDate(i.deadline)],['GPA',i=>i.gpa||'N/A'],['Renewable',i=>i.renewable?'✓ Yes':'✗ No'],['Benefits',i=>(i.benefits||[]).join(', ')]];
  table.innerHTML=`<table class="compare-table w-full"><thead><tr><th>Feature</th>${items.map(i=>`<th><div class="text-sm mb-1">${i.flag} ${i.name}</div><button onclick="toggleCompare(${i.id})" class="text-xs text-slate2-400 hover:text-red-400">Remove</button></th>`).join('')}</tr></thead><tbody>${rows.map(([label,fn])=>`<tr><td>${label}</td>${items.map(i=>`<td>${fn(i)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

// ─── Deadlines ────────────────────────────────────────────────────
function renderDeadlines() {
  const list = document.getElementById('deadline-list');
  if (!list || allScholarships.length===0) return;
  const now    = new Date();
  const sorted = [...allScholarships]
    .map(s=>({...s,daysLeft:getDaysLeft(s.deadline)}))
    .sort((a,b)=>a.daysLeft-b.daysLeft);
  list.innerHTML = sorted.map(s=>{
    const cls = s.daysLeft<=30?'urgent':s.daysLeft<=90?'warning':'ok';
    const badgeTxt = s.daysLeft<0?'Passed':s.daysLeft===0?'Today':s.daysLeft;
    const sub = s.daysLeft>0&&s.daysLeft!==0?'days':'';
    return `<div class="deadline-item ${cls}" onclick="openModal(${s.id})" style="cursor:pointer">
      <div class="days-badge ${cls}"><span>${badgeTxt}</span>${sub?`<span class="days-label">${sub}</span>`:''}</div>
      <div class="flex-1 min-w-0"><div class="font-display font-600 text-sm text-white mb-0.5 truncate">${s.name}</div><div class="text-slate2-400 text-xs truncate">${s.organization}</div></div>
      <div class="text-right flex-shrink-0"><div class="text-xs text-slate2-300">${formatDate(s.deadline)}</div><div class="amount-display text-sm mt-0.5">${formatAmount(s.amount,s.currency)}</div></div>
    </div>`;
  }).join('');
}

// ─── View toggle ─────────────────────────────────────────────────
function setView(v) {
  currentView = v;
  document.getElementById('view-grid')?.classList.toggle('active',v==='grid');
  document.getElementById('view-list')?.classList.toggle('active',v==='list');
  document.getElementById('scholarship-grid')?.classList.toggle('list-view',v==='list');
  renderGrid();
}

function updateSidebarTotal() {
  const el = document.getElementById('sidebar-total');
  if (el) el.textContent = allScholarships.length;
}

// ─── Mobile sidebar ───────────────────────────────────────────────
function toggleMobileSidebar() { document.getElementById('sidebar')?.classList.toggle('open'); document.getElementById('mobile-overlay')?.classList.toggle('hidden'); }
function closeMobileSidebar()  { document.getElementById('sidebar')?.classList.remove('open'); document.getElementById('mobile-overlay')?.classList.add('hidden'); }

// ─── Loading ──────────────────────────────────────────────────────
function setLoading(state) {
  document.getElementById('loading-indicator')?.classList.toggle('hidden',!state);
}

// ─── API helper ───────────────────────────────────────────────────
async function apiFetch(path, method='GET', body=null, useAuth=true) {
  const headers = { 'Content-Type':'application/json' };
  if (useAuth && authToken) headers['Authorization'] = `Bearer ${authToken}`;
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);
  const res  = await fetch(`${API_BASE}${path}`, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

// ─── Utils ───────────────────────────────────────────────────────
function getDaysLeft(d)   { return Math.ceil((new Date(d)-new Date())/86400000); }
function formatDate(str)  { return new Date(str).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }
function formatAmount(amt,currency) {
  if (!currency) return '';
  if (currency.includes('/')) return `${amt.toLocaleString()} ${currency}`;
  try { return new Intl.NumberFormat('en-US',{style:'currency',currency:currency.substring(0,3),maximumFractionDigits:0}).format(amt); }
  catch(_) { return `${amt.toLocaleString()} ${currency}`; }
}
function getLevelClass(l) { return {Undergraduate:'level-undergraduate',Postgraduate:'level-postgraduate',PhD:'level-phd','High School':'level-high-school',Vocational:'level-vocational'}[l]||'level-postgraduate'; }
function getFundingClass(f){ return {Full:'funding-full',Partial:'funding-partial',Tuition:'funding-tuition'}[f]||'funding-partial'; }
function escHtml(str)     { return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function getTimeAgo(iso)  {
  const diff = Date.now()-new Date(iso).getTime();
  const m=Math.floor(diff/60000),h=Math.floor(m/60),d=Math.floor(h/24);
  if (d>0) return `${d}d ago`;
  if (h>0) return `${h}h ago`;
  if (m>0) return `${m}m ago`;
  return 'just now';
}

function showToast(msg, type='info') {
  const c = document.getElementById('toast-container');
  if (!c) return;
  const icons = { success:'<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>', warning:'<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>', info:'<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>' };
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = `<svg class="toast-icon flex-shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icons[type]||icons.info}</svg><span>${msg}</span>`;
  c.appendChild(t);
  setTimeout(()=>{ t.style.animation='slideOut 0.3s ease forwards'; setTimeout(()=>t.remove(),300); },3500);
}
