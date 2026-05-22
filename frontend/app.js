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
  if (!token) return;
  showAuthWrapper();
  hideAllForms();
  const resetForm = document.getElementById('form-reset');
  if (resetForm) resetForm.classList.remove('hidden');
  // Hide tabs since we're in reset mode
  const tabs = document.getElementById('auth-tabs');
  if (tabs) tabs.classList.add('hidden');
  window._resetToken = token;
  setAuthMsg('Enter your new password below.', 'success');
}

function checkVerifyToken() {
  const params = new URLSearchParams(window.location.search);
  const token  = params.get('verify');
  if (!token) return;

  // Show a loading state while verifying
  showAuthWrapper();
  hideAllForms();
  const msgEl = document.getElementById('auth-msg');
  if (msgEl) {
    msgEl.textContent = '⏳ Verifying your email…';
    msgEl.className   = 'mb-4 px-4 py-3 rounded-xl text-sm bg-gold-400/15 border border-gold-400/30 text-gold-400';
    msgEl.classList.remove('hidden');
  }

  apiFetch(`/api/auth/verify-email?token=${token}`, 'GET', null, false)
    .then(data => {
      authToken   = data.token;
      currentUser = data.user;
      localStorage.setItem('sp-token', authToken);
      window.history.replaceState({}, '', '/');
      enterApp();
      showToast('✅ Email verified! Welcome to ScholarPath 🎓', 'success');
    })
    .catch(err => {
      showAuth();
      switchAuthTab('login');
      setAuthMsg('❌ ' + (err.message || 'Verification link is invalid or expired. Try signing up again.'), 'error');
    });
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
  // If Google script not loaded yet, retry after 1s
  if (typeof google === 'undefined') {
    setTimeout(initGoogleSignIn, 1000);
    return;
  }
  if (!GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID === '__GOOGLE_CLIENT_ID__') {
    // Show fallback text in Google button containers
    ['google-signin-btn','google-signup-btn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.innerHTML = '<p style="color:#607d8b;font-size:12px;text-align:center">Google Sign-In not configured.<br>Set GOOGLE_CLIENT_ID in index.html</p>';
    });
    return;
  }
  try {
    google.accounts.id.initialize({
      client_id : GOOGLE_CLIENT_ID,
      callback  : handleGoogleCredential,
      ux_mode   : 'popup',
    });
    ['google-signin-btn','google-signup-btn'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      google.accounts.id.renderButton(el, {
        theme : 'filled_black',
        size  : 'large',
        width : 320,
        text  : 'continue_with',
        shape : 'rectangular',
      });
    });
  } catch(e) {
    console.warn('[google] init failed:', e.message);
  }
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
      <div class="hidden sm:flex items-center gap-2 flex-shrink-0"><s
