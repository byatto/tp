// ═══════════════════════════════════════════════════════════
// TRIGPOINT v3.0 — app.js
// Types replace categories, TCT replaces urgent, age-based
// urgency, weekly review mode
// ═══════════════════════════════════════════════════════════

const STORAGE_KEY        = 'trigpoint_v2_data';
const CLOUD_URL_KEY      = 'trigpoint_v2_cloud_url';
const CLOUD_KEY_KEY      = 'trigpoint_v2_cloud_key';
const THEME_KEY          = 'trigpoint_v2_theme';
const ACTIVE_ACCOUNT_KEY = 'trigpoint_v2_account';
const LAST_REVIEW_KEY    = 'trigpoint_v3_last_review';
const REVIEW_SNOOZE_KEY  = 'trigpoint_v3_review_snooze';
const MIGRATED_KEY       = 'trigpoint_v3_migrated';

const DEFAULT_ACCOUNTS = [{ name: 'Personal', color: '#0033CC' }, { name: 'Work', color: '#00875A' }];
const DEFAULT_TYPES    = ['action', 'waiting', 'project', 'note', 'someday'];

const TYPE_CONFIG = [
  { key: 'action',  label: 'Action',  color: '#0033CC', bg: 'rgba(0,51,204,0.08)',   darkColor: '#4D7CFF', darkBg: 'rgba(77,124,255,0.12)' },
  { key: 'waiting', label: 'Waiting', color: '#6554C0', bg: 'rgba(101,84,192,0.08)', darkColor: '#998DD9', darkBg: 'rgba(153,141,217,0.12)' },
  { key: 'project', label: 'Project', color: '#00875A', bg: 'rgba(0,135,90,0.08)',   darkColor: '#36B37E', darkBg: 'rgba(54,179,126,0.12)' },
  { key: 'note',    label: 'Note',    color: '#FF8B00', bg: 'rgba(255,139,0,0.08)',   darkColor: '#FFAB00', darkBg: 'rgba(255,171,0,0.12)' },
  { key: 'someday', label: 'Someday', color: '#00A3BF', bg: 'rgba(0,163,191,0.08)',   darkColor: '#00B8D9', darkBg: 'rgba(0,184,217,0.12)' },
];

function getTypeStyle(type) {
  const cfg = TYPE_CONFIG.find(t => t.key === type);
  if (!cfg) return { color: 'var(--text-muted)', bg: 'var(--bg-hover)', label: type || 'Inbox' };
  const isDark = document.body.getAttribute('data-theme') === 'dark';
  return { color: isDark ? cfg.darkColor : cfg.color, bg: isDark ? cfg.darkBg : cfg.bg, label: cfg.label };
}

// ═══ MIGRATION v2 → v3 ═══
function migrateV2toV3(d) {
  if (localStorage.getItem(MIGRATED_KEY)) return d;

  const catMap = {
    strategic: 'action', operational: 'action', reactive: 'action',
    waiting: 'waiting', twain: 'action', personal: 'action',
    note: 'note', task: 'action', Task: 'action'
  };

  d.items.forEach(item => {
    if (item.category !== undefined && item.type === undefined) {
      item.type = catMap[item.category] || (item.category ? 'action' : '');
    }
    if (item._urgent !== undefined && item._tct === undefined) {
      item._tct = item._urgent;
      delete item._urgent;
    }
    if (item._tct === undefined) item._tct = false;
    if (item.type === undefined) item.type = '';
  });

  d.types = DEFAULT_TYPES;

  const seen = new Map();
  d.accounts.forEach(acc => {
    const lower = acc.name.toLowerCase();
    if (!seen.has(lower)) { seen.set(lower, acc); }
    else {
      const canonical = seen.get(lower);
      d.items.forEach(item => { if (item.account === acc.name) item.account = canonical.name; });
    }
  });
  d.accounts = Array.from(seen.values());

  localStorage.setItem(MIGRATED_KEY, 'true');
  return d;
}

// ═══ STATE ═══
let data          = loadData();
let activeAccount = localStorage.getItem(ACTIVE_ACCOUNT_KEY) || data.accounts[0]?.name || 'Personal';
let currentView   = 'capture';
let activeFilter  = 'all';
let allAccounts   = false;
let undoItem      = null;
let undoTimer     = null;

if (!data.accounts.find(a => a.name === activeAccount)) {
  activeAccount = data.accounts[0]?.name || 'Personal';
}

// ═══ DATA ═══
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      let d = JSON.parse(raw);
      if (!Array.isArray(d.items))    d.items    = [];
      if (!Array.isArray(d.accounts)) d.accounts = DEFAULT_ACCOUNTS;
      if (!Array.isArray(d.types))    d.types    = DEFAULT_TYPES;
      d.items = d.items.filter(i => i && typeof i.id === 'string' && typeof i.text === 'string');
      d.items.forEach(i => {
        if (!i.createdAt) i.createdAt = new Date().toISOString();
        if (!i.status) i.status = 'inbox';
        // Inbox items may legitimately be unassigned (account: ''); only backfill
        // an account for items that have already been filed.
        if (!i.account && i.status !== 'inbox') i.account = d.accounts[0]?.name || 'Personal';
        if (i.type === undefined) i.type = i.category || '';
        if (i._done === undefined) i._done = false;
        if (i._tct === undefined) i._tct = i._urgent || false;
        if (i.dueDate === undefined) i.dueDate = null;
        if (i.completedAt === undefined) i.completedAt = null;
      });
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      d.items = d.items.filter(i => {
        if (!i._deleted) return true;
        if (!i._deletedAt) return false;
        return new Date(i._deletedAt).getTime() > cutoff;
      });
      d = migrateV2toV3(d);
      return d;
    }
  } catch (e) { console.error('Load error:', e); }
  return { items: [], accounts: DEFAULT_ACCOUNTS, types: DEFAULT_TYPES };
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  scheduleSync();
}

// ═══ SYNC ═══
let cloudUrl  = localStorage.getItem(CLOUD_URL_KEY) || '';
let cloudKey  = localStorage.getItem(CLOUD_KEY_KEY) || '';
let syncTimeout = null;
let isSyncing = false;

function setSyncStatus(status) {
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  if (!dot || !label) return;
  dot.className = 'sync-dot';
  if (status === 'syncing') { dot.classList.add('syncing'); label.textContent = 'Syncing…'; }
  else if (status === 'online') { dot.classList.add('online'); label.textContent = 'Synced'; }
  else if (status === 'error')  { dot.classList.add('error');  label.textContent = 'Sync error'; }
  else { label.textContent = cloudUrl ? 'Connected' : 'Offline (no cloud)'; }
}

function scheduleSync() {
  if (!cloudUrl) return;
  clearTimeout(syncTimeout);
  syncTimeout = setTimeout(() => pushToCloud(), 1500);
}

async function pullFromCloud() {
  if (!cloudUrl || isSyncing) return;
  isSyncing = true; setSyncStatus('syncing');
  try {
    const url = cloudUrl + (cloudUrl.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(cloudKey);
    const res  = await fetch(url, { method: 'GET', redirect: 'follow' });
    const text = await res.text();
    const cloud = JSON.parse(text);
    if (!cloud.success) throw new Error(cloud.error || 'Sync failed');

    const cloudMap = new Map((cloud.items || []).map(i => [i.id, i]));
    const localMap = new Map(data.items.map(i => [i.id, i]));
    const merged   = new Map();
    for (const [id, item] of cloudMap) {
      const local = localMap.get(id);
      merged.set(id, !local ? item : (new Date(local.updatedAt || local.createdAt) > new Date(item.updatedAt || item.createdAt) ? local : item));
    }
    for (const [id, item] of localMap) { if (!merged.has(id)) merged.set(id, item); }
    data.items = Array.from(merged.values());
    data.items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    if (Array.isArray(cloud.accounts)) {
      cloud.accounts.forEach(acc => {
        const name = typeof acc === 'string' ? acc : acc.name;
        if (!data.accounts.find(a => a.name === name))
          data.accounts.push(typeof acc === 'string' ? { name: acc, color: '#888' } : acc);
      });
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    renderAll(); setSyncStatus('online');
    await pushToCloud();
  } catch (e) { console.error('Pull error:', e); setSyncStatus('error'); }
  finally { isSyncing = false; }
}

async function pushToCloud() {
  if (!cloudUrl || isSyncing) return;
  try {
    setSyncStatus('syncing');
    const payload = { key: cloudKey, items: data.items, accounts: data.accounts.map(a => a.name), types: data.types };
    const res  = await fetch(cloudUrl, { method: 'POST', redirect: 'follow', body: JSON.stringify(payload) });
    const text = await res.text();
    const result = JSON.parse(text);
    if (!result.success) throw new Error(result.error || 'Push failed');
    setSyncStatus('online');
  } catch (e) { console.error('Push error:', e); setSyncStatus('error'); }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && cloudUrl) pullFromCloud(); });
if (cloudUrl) { setTimeout(pullFromCloud, 500); } else { setTimeout(() => setSyncStatus('offline'), 0); }

// ═══ ITEM OPERATIONS ═══
function addItem(text) {
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: text.trim(), account: '', type: '', status: 'inbox',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    _tct: false, _deleted: false, _done: false,
    dueDate: null, completedAt: null
  };
  data.items.unshift(item);
  saveData(); return item;
}

function updateItem(id, updates) {
  const item = data.items.find(i => i.id === id);
  if (item) { Object.assign(item, updates, { updatedAt: new Date().toISOString() }); saveData(); }
}

function deleteItem(id) {
  const item = data.items.find(i => i.id === id);
  if (item) {
    item._deleted = true; item._deletedAt = new Date().toISOString();
    saveData(); return { ...item, _deleted: false, _deletedAt: null };
  }
  return null;
}

function markDone(id) {
  const item = data.items.find(i => i.id === id);
  if (item) {
    item._done = true; item._tct = false;
    item.completedAt = new Date().toISOString();
    item.updatedAt = new Date().toISOString();
    saveData();
    return { ...item, _done: false, completedAt: null };
  }
  return null;
}

function undoDone(item) {
  const existing = data.items.find(i => i.id === item.id);
  if (existing) { existing._done = false; existing.completedAt = null; existing.updatedAt = new Date().toISOString(); }
  saveData();
}

function restoreItem(item) {
  const existing = data.items.find(i => i.id === item.id);
  if (existing) { existing._deleted = false; existing._deletedAt = null; }
  else { item._deleted = false; item._deletedAt = null; data.items.push(item); data.items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
  saveData();
}

// Global inbox: capture no longer assigns an account, so review/badge/dropdown
// must all read from this one place rather than filtering by activeAccount.
function getInboxItems() {
  return data.items.filter(i => i.status === 'inbox' && !i.type && !i._deleted && !i._done);
}

function getAllInboxCount() {
  return getInboxItems().length;
}

function getActiveItems() {
  return data.items.filter(i => !i._deleted && !i._done);
}

function getTCTCount() {
  return getActiveItems().filter(i => i._tct).length;
}

function toggleTCT(id) {
  const item = data.items.find(i => i.id === id);
  if (!item) return false;
  if (item._tct) { item._tct = false; saveData(); return true; }
  if (getTCTCount() >= 3) return false;
  if (item.type === 'note' || item.type === 'someday') return false;
  item._tct = true; saveData(); return true;
}

// ═══ AGE HELPERS ═══
function getAgeDays(createdAt) {
  const now = new Date();
  const created = new Date(createdAt);
  return Math.floor((now - created) / 86400000);
}

function getAgeLabel(days) {
  if (days === 0) return 'today';
  if (days === 1) return '1d';
  return days + 'd';
}

function getAgeClass(item) {
  if (item.type === 'note' || item.type === 'someday') return '';
  const days = getAgeDays(item.createdAt);
  if (item.dueDate) {
    const due = new Date(item.dueDate + 'T23:59:59');
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (due < today) return 'overdue';
    const diff = Math.floor((due - today) / 86400000);
    if (diff <= 3) return 'due-soon';
    return '';
  }
  if (days >= 28) return 'stale-red';
  if (days >= 14) return 'stale-amber';
  return '';
}

function searchItems(query, typeFilter, sort) {
  let results = getActiveItems();
  if (!allAccounts) results = results.filter(i => i.account === activeAccount || i.account === '');
  if (typeFilter === 'inbox') results = results.filter(i => !i.type);
  else if (typeFilter && typeFilter !== 'all') results = results.filter(i => i.type === typeFilter);
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(i =>
      i.text.toLowerCase().includes(q) ||
      (i.account && i.account.toLowerCase().includes(q)) ||
      (i.type && i.type.toLowerCase().includes(q))
    );
  }
  if (sort === 'due') {
    results.sort((a, b) => {
      if (a.dueDate && b.dueDate) return new Date(a.dueDate) - new Date(b.dueDate);
      if (a.dueDate) return -1;
      if (b.dueDate) return 1;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
  } else if (sort === 'age') {
    results.sort((a, b) => {
      if (a._tct && !b._tct) return -1;
      if (!a._tct && b._tct) return 1;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
  } else {
    results.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }
  return results;
}

// ═══ THEME ═══
let currentTheme = localStorage.getItem(THEME_KEY) || 'light';
applyTheme(currentTheme);

function applyTheme(t) {
  currentTheme = t;
  document.body.setAttribute('data-theme', t);
  document.getElementById('theme-toggle').textContent = t === 'dark' ? '☾' : '☀';
  localStorage.setItem(THEME_KEY, t);
}

document.getElementById('theme-toggle').addEventListener('click', () => applyTheme(currentTheme === 'dark' ? 'light' : 'dark'));

// ═══ ACCOUNT SELECTOR ═══
function renderAccountDropdown() {
  const dropdown = document.getElementById('account-dropdown');
  if (!dropdown) return;
  const current  = data.accounts.find(a => a.name === activeAccount) || data.accounts[0];
  const colour   = (current?.color && current.color !== '#888' && current.color !== '#888888') ? current.color : '#0033CC';

  const lozengeName = document.getElementById('account-name');
  const lozengeDot   = document.getElementById('account-dot');
  const accountLabel = current?.name || activeAccount;
  if (lozengeName) { lozengeName.textContent = accountLabel; lozengeName.title = accountLabel; }
  if (lozengeDot)  { lozengeDot.style.background = colour; lozengeDot.style.backgroundColor = colour; }

  dropdown.innerHTML = data.accounts.map(acc => {
    const totalCount = data.items.filter(i => i.account === acc.name && !i._deleted && !i._done).length;
    const countLabel = totalCount > 0
      ? `<span class="account-option-count">${totalCount}</span>`
      : '';
    return `
      <div class="account-option ${acc.name === activeAccount ? 'active' : ''}" data-name="${esc(acc.name)}">
        <span class="account-option-left">
          <span class="account-dot" style="background:${acc.color}"></span>
          <span class="account-option-name">${escHtml(acc.name)}</span>
          ${countLabel}
        </span>
        ${data.accounts.length > 1 ? `<span class="account-remove" data-name="${esc(acc.name)}">×</span>` : ''}
      </div>`;
  }).join('') + '<div class="account-add" id="account-add">+ Add Account</div>';

  dropdown.querySelectorAll('.account-option').forEach(opt => {
    opt.addEventListener('click', e => {
      if (e.target.classList.contains('account-remove')) return;
      setActiveAccount(opt.dataset.name);
      dropdown.classList.remove('open');
    });
  });

  dropdown.querySelectorAll('.account-remove').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const name = btn.dataset.name;
      openModal('Remove Account?', `Delete "${name}" and all its items?`, null, () => {
        data.accounts = data.accounts.filter(a => a.name !== name);
        data.items.forEach(i => { if (i.account === name) { i._deleted = true; i._deletedAt = new Date().toISOString(); } });
        saveData();
        if (activeAccount === name) setActiveAccount(data.accounts[0]?.name || 'Personal');
        renderAccountDropdown();
      }, 'Remove', true);
    });
  });

  document.getElementById('account-add').addEventListener('click', () => {
    dropdown.classList.remove('open');
    openModal('Add Account', 'Enter account name:', ct => {
      const inp = document.createElement('input');
      inp.className = 'modal-input'; inp.placeholder = 'Account name'; inp.id = 'new-account-name';
      ct.appendChild(inp); setTimeout(() => inp.focus(), 100);
    }, () => {
      const name = document.getElementById('new-account-name').value.trim();
      if (!name) return;
      if (data.accounts.find(a => a.name.toLowerCase() === name.toLowerCase())) { toast('Account exists'); return; }
      const colors = ['#0033CC','#00875A','#6554C0','#FF8B00','#DE350B','#00A3BF'];
      data.accounts.push({ name, color: colors[data.accounts.length % colors.length] });
      saveData(); setActiveAccount(name);
    }, 'Add');
  });
}

function setActiveAccount(name) {
  activeAccount = name;
  localStorage.setItem(ACTIVE_ACCOUNT_KEY, name);
  renderAccountDropdown();
  renderAll();
}

// ═══ TRASH VIEW ═══
function openTrashView() {
  const deleted = data.items.filter(i => i._deleted);
  function purgeAll() {
    data.items = data.items.filter(i => !i._deleted);
    saveData(); renderAll(); closeModal(); toast('Trash purged');
  }
  openModal('Trash', `${deleted.length} deleted item${deleted.length !== 1 ? 's' : ''}`, ct => {
    function renderTrash() {
      if (!deleted.length) {
        ct.innerHTML = '<p style="text-align:center;color:var(--text-muted);padding:20px 0;">Trash is empty</p>';
        const confirmBtn = document.getElementById('modal-confirm');
        if (confirmBtn) confirmBtn.classList.add('hidden');
        return;
      }
      ct.innerHTML = `<div style="max-height:45vh;overflow-y:auto;margin-bottom:8px;">
        ${deleted.map(item => {
          const acc = data.accounts.find(a => a.name === item.account);
          const colour = acc ? acc.color : '#888';
          const date = new Date(item._deletedAt || item.createdAt).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
          return `<div style="padding:10px;border:1px solid var(--border-subtle);border-radius:6px;margin-bottom:8px;background:var(--bg-surface);">
            <div style="font-size:14px;line-height:1.5;margin-bottom:8px;color:var(--text-secondary);">${escHtml(item.text)}</div>
            <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
              <span style="font-size:11px;color:${colour};font-weight:600;">${escHtml(item.account || 'Unassigned')}</span>
              <span style="font-size:11px;color:var(--text-muted);">Deleted ${date}</span>
              <div style="display:flex;gap:6px;margin-left:auto;">
                <button class="subtle-btn trash-restore" data-id="${esc(item.id)}" style="font-size:11px;padding:4px 10px;">Restore</button>
                <button class="subtle-btn danger trash-purge-one" data-id="${esc(item.id)}" style="font-size:11px;padding:4px 10px;">Delete</button>
              </div>
            </div>
          </div>`;
        }).join('')}
      </div>`;
      ct.querySelectorAll('.trash-restore').forEach(btn => {
        btn.addEventListener('click', () => {
          const item = data.items.find(i => i.id === btn.dataset.id);
          if (item) { item._deleted = false; item._deletedAt = null; saveData(); renderAll(); }
          const idx = deleted.findIndex(i => i.id === btn.dataset.id);
          if (idx > -1) deleted.splice(idx, 1);
          renderTrash();
          document.getElementById('modal-title').textContent = `Trash · ${deleted.length} item${deleted.length !== 1 ? 's' : ''}`;
          toast('Restored');
        });
      });
      ct.querySelectorAll('.trash-purge-one').forEach(btn => {
        btn.addEventListener('click', () => {
          data.items = data.items.filter(i => i.id !== btn.dataset.id);
          saveData(); renderAll();
          const idx = deleted.findIndex(i => i.id === btn.dataset.id);
          if (idx > -1) deleted.splice(idx, 1);
          renderTrash();
          document.getElementById('modal-title').textContent = `Trash · ${deleted.length} item${deleted.length !== 1 ? 's' : ''}`;
        });
      });
    }
    renderTrash();
  }, deleted.length ? purgeAll : null, deleted.length ? 'Purge All' : 'Close', deleted.length > 0);
}

document.getElementById('account-btn').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('account-dropdown').classList.toggle('open');
});
document.addEventListener('click', e => {
  if (!e.target.closest('.account-selector')) document.getElementById('account-dropdown').classList.remove('open');
});

// ═══ VIEW SWITCHING ═══
function updateAccountSelectorVisibility() {
  const sel = document.getElementById('account-selector');
  if (sel) sel.classList.toggle('hidden', currentView === 'capture');
}

function switchView(view) {
  currentView = view;
  if (view !== 'browse') allAccounts = false;
  ['capture', 'review', 'browse', 'weekly-review'].forEach(v => {
    const el = document.getElementById('view-' + v);
    if (el) el.classList.toggle('hidden', v !== view);
  });
  document.querySelectorAll('#nav-desktop button, #nav-mobile button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
  updateAccountSelectorVisibility();
  if (view === 'capture') document.getElementById('capture-input').focus();
  renderAll();
}

document.querySelectorAll('#nav-desktop button, #nav-mobile button').forEach(b => {
  b.addEventListener('click', () => switchView(b.dataset.view));
});

// ═══ CAPTURE ═══
const captureInput = document.getElementById('capture-input');
const captureBtn   = document.getElementById('capture-btn');

function doCapture() {
  const text = captureInput.value.trim();
  if (!text) { captureInput.focus(); return; }
  addItem(text);
  captureInput.value = '';
  toast('Saved to Inbox');
  updateBadge(); updateStats();
}

captureBtn.addEventListener('click', doCapture);
captureInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doCapture(); }
});

// ═══ REVIEW RENDERING (inbox triage) ═══
function renderReview() {
  const list  = document.getElementById('review-list');
  const items = getInboxItems();

  document.getElementById('review-count').textContent = items.length + ' items';

  if (!items.length) {
    list.innerHTML = `<div class="empty-state">
      <div class="empty-icon">✓</div>
      <div class="empty-title">Inbox Clear</div>
      <p>No items to review</p>
    </div>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const noAccountYet = !item.account;
    const accOptions = `<option value="" disabled ${noAccountYet ? 'selected' : ''}>Assign account…</option>` +
      data.accounts.map(a =>
        `<option value="${esc(a.name)}" ${a.name === item.account ? 'selected' : ''}>${escHtml(a.name)}</option>`
      ).join('');
    return `
    <div class="card" data-id="${esc(item.id)}">
      <div class="card-swipe-delete">${trashSVG()}<span>Delete</span></div>
      <div class="card-inner">
        <textarea class="card-text-edit" data-id="${esc(item.id)}">${escTextarea(item.text)}</textarea>
        <div class="type-buttons">
          ${TYPE_CONFIG.map(t => {
            const s = getTypeStyle(t.key);
            const selected = item.type === t.key;
            const style = selected ? `background:${s.bg};color:${s.color};border-color:transparent;` : '';
            return `<button class="type-btn ${selected ? 'selected' : ''}" style="${style}" data-type="${t.key}" data-id="${esc(item.id)}">${t.label}</button>`;
          }).join('')}
        </div>
        <div class="file-confirm-row ${item.type ? 'visible' : ''}" id="confirm-row-${esc(item.id)}">
          <select class="reassign-select file-account-select" id="file-account-${esc(item.id)}">${accOptions}</select>
          <button class="file-confirm-btn" data-id="${esc(item.id)}" data-type="${item.type || ''}">
            File as ${item.type ? getTypeStyle(item.type).label : ''} →
          </button>
          <button class="file-cancel-btn" data-id="${esc(item.id)}">Cancel</button>
        </div>
        <div class="card-footer">
          <span class="card-meta">${formatTime(item.createdAt)}</span>
          <div class="card-actions">
            <button class="action-btn done-btn" data-id="${esc(item.id)}" title="Mark done">${doneSVG()}</button>
            <button class="action-btn delete" data-action="delete" data-id="${esc(item.id)}" title="Delete">${trashSVG()}</button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');

  list.querySelectorAll('.type-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const itemId = btn.dataset.id;
      const type = btn.dataset.type;
      const card = list.querySelector(`.card[data-id="${itemId}"]`);
      if (!card) return;
      card.querySelectorAll('.type-btn').forEach(b => { b.classList.remove('selected'); b.removeAttribute('style'); });
      const s = getTypeStyle(type);
      btn.classList.add('selected');
      btn.style.cssText = `background:${s.bg};color:${s.color};border-color:transparent;`;
      const confirmRow = document.getElementById('confirm-row-' + itemId);
      if (confirmRow) {
        confirmRow.classList.add('visible');
        const confirmBtn = confirmRow.querySelector('.file-confirm-btn');
        if (confirmBtn) { confirmBtn.textContent = `File as ${s.label} →`; confirmBtn.dataset.type = type; }
      }
    });
  });

  list.querySelectorAll('.file-confirm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.type;
      const id = btn.dataset.id;
      const sel = document.getElementById('file-account-' + id);
      const account = sel ? sel.value : '';
      if (!account) { toast('Choose an account first'); return; }
      updateItem(id, { type, account, status: 'stored' });
      renderReview(); updateBadge(); updateStats();
      toast('Filed as ' + getTypeStyle(type).label + ' → ' + account);
    });
  });

  list.querySelectorAll('.file-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const itemId = btn.dataset.id;
      const card = list.querySelector(`.card[data-id="${itemId}"]`);
      if (!card) return;
      card.querySelectorAll('.type-btn').forEach(b => { b.classList.remove('selected'); b.removeAttribute('style'); });
      const confirmRow = document.getElementById('confirm-row-' + itemId);
      if (confirmRow) confirmRow.classList.remove('visible');
    });
  });

  wireCardActions(list, () => { renderReview(); updateBadge(); updateStats(); });

  list.querySelectorAll('.card').forEach(card => initSwipe(card, id => {
    const removed = deleteItem(id);
    if (removed) showUndo('Deleted', removed);
    renderReview(); updateBadge(); updateStats();
  }));
}

function wireCardActions(container, onUpdate) {
  container.querySelectorAll('.action-btn.done-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const undoData = markDone(btn.dataset.id);
      if (undoData) showUndoDone('Marked done ✓', undoData);
      onUpdate();
    });
  });
  container.querySelectorAll('.action-btn.delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const removed = deleteItem(btn.dataset.id);
      if (removed) showUndo('Deleted', removed);
      onUpdate();
    });
  });
  container.querySelectorAll('.action-btn.move').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById('reassign-' + btn.dataset.id);
      if (panel) { panel.classList.toggle('open'); btn.classList.toggle('open'); }
    });
  });
  container.querySelectorAll('.reassign-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const sel = document.getElementById('reassign-sel-' + btn.dataset.id);
      if (!sel) return;
      updateItem(btn.dataset.id, { account: sel.value });
      onUpdate(); toast('Moved to ' + sel.value);
    });
  });
  container.querySelectorAll('textarea.card-text-edit').forEach(el => {
    autosize(el);
    el.addEventListener('input', () => autosize(el));
    el.addEventListener('blur', () => {
      const item = data.items.find(i => i.id === el.dataset.id);
      if (item && item.text !== el.value.trim()) { updateItem(el.dataset.id, { text: el.value.trim() }); toast('Updated'); }
    });
  });
  container.querySelectorAll('.action-btn.tct-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const ok = toggleTCT(btn.dataset.id);
      if (!ok) { toast('Max 3 TCT — remove one first'); return; }
      const item = data.items.find(i => i.id === btn.dataset.id);
      toast(item?._tct ? 'Added to today\'s 3' : 'Removed from TCT');
      onUpdate();
    });
  });
}

function autosize(el) { el.style.height = 'auto'; el.style.height = el.scrollHeight + 'px'; }

// ═══ BROWSE RENDERING ═══
function renderFilterBar() {
  const bar = document.getElementById('filter-bar');
  bar.innerHTML = `<button class="filter-btn ${activeFilter === 'all' ? 'active' : ''}" data-type="all">All</button>`
    + TYPE_CONFIG.map(t => {
        const s = getTypeStyle(t.key);
        const active = activeFilter === t.key;
        const style = active ? `background:${s.bg};color:${s.color};border-color:transparent;` : '';
        return `<button class="filter-btn ${active ? 'active' : ''}" style="${style}" data-type="${t.key}">${t.label}</button>`;
      }).join('')
    + `<button class="filter-btn ${activeFilter === 'inbox' ? 'active' : ''}" data-type="inbox">Inbox</button>`;
}

function renderBrowse() {
  const toggle = document.getElementById('all-accounts-toggle');
  const label  = document.getElementById('all-accounts-label');
  document.getElementById('all-accounts-bar').classList.add('visible');
  toggle.classList.toggle('active', allAccounts);
  label.textContent = allAccounts ? 'Showing all accounts' : '';

  renderFilterBar();

  const query   = document.getElementById('search-input').value;
  const sort    = document.getElementById('sort-select').value;
  const results = searchItems(query, activeFilter, sort);
  const list    = document.getElementById('browse-list');

  if (!results.length) {
    list.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><div class="empty-title">No results</div><p>Try a different search or filter</p></div>`;
    return;
  }

  const tctItems = results.filter(i => i._tct);
  const otherItems = results.filter(i => !i._tct);

  let html = '';

  if (tctItems.length) {
    html += `<div class="tct-section">
      <div class="tct-section-header">
        <span class="tct-star">★</span> Today's Focus
        <span class="tct-count">${tctItems.length}/3</span>
      </div>
      ${tctItems.map(item => renderBrowseCard(item)).join('')}
    </div>`;
  }

  if (allAccounts) {
    const groups = new Map();
    otherItems.forEach(item => {
      if (!groups.has(item.account)) groups.set(item.account, []);
      groups.get(item.account).push(item);
    });
    const unassignedItems = groups.get('') || null;
    if (unassignedItems) groups.delete('');
    for (const [accName, items] of groups) {
      const acc = data.accounts.find(a => a.name === accName);
      const colour = acc ? acc.color : '#888';
      html += `<div class="account-group-header" style="color:${colour}">
        <span class="account-group-dot"></span>
        <span class="account-group-name">${escHtml(accName)}</span>
        <span class="account-group-count">${items.length}</span>
      </div>`;
      html += items.map(item => renderBrowseCard(item)).join('');
    }
    if (unassignedItems) {
      html += `<div class="account-group-header" style="color:var(--text-muted)">
        <span class="account-group-dot"></span>
        <span class="account-group-name">Unassigned</span>
        <span class="account-group-count">${unassignedItems.length}</span>
      </div>`;
      html += unassignedItems.map(item => renderBrowseCard(item)).join('');
    }
  } else {
    html += otherItems.map(item => renderBrowseCard(item)).join('');
  }

  list.innerHTML = html;

  wireCardActions(list, () => { renderBrowse(); updateBadge(); updateStats(); });

  list.querySelectorAll('.card').forEach(card => initSwipe(card, id => {
    const removed = deleteItem(id);
    if (removed) showUndo('Deleted', removed);
    renderBrowse(); updateStats();
  }));
}

function renderBrowseCard(item) {
  const typeStyle = getTypeStyle(item.type);
  const ageDays = getAgeDays(item.createdAt);
  const ageClass = getAgeClass(item);
  const accOptions = data.accounts.map(a =>
    `<option value="${esc(a.name)}" ${a.name === item.account ? 'selected' : ''}>${escHtml(a.name)}</option>`
  ).join('');

  let ageBadge = '';
  if (item.dueDate) {
    ageBadge = formatDueDate(item.dueDate);
  } else {
    const ageLabel = getAgeLabel(ageDays);
    const cls = ageClass === 'stale-red' ? 'age-badge stale-red' : ageClass === 'stale-amber' ? 'age-badge stale-amber' : 'age-badge';
    ageBadge = `<span class="${cls}">${ageLabel}</span>`;
  }

  const tctActive = item._tct;
  const canTCT = item.type !== 'note' && item.type !== 'someday';

  return `
    <div class="card ${tctActive ? 'tct' : ''} ${ageClass}" data-id="${esc(item.id)}">
      <div class="card-swipe-delete">${trashSVG()}<span>Delete</span></div>
      <div class="card-inner">
        <div class="card-text-header">
          <span class="type-badge" style="background:${typeStyle.bg};color:${typeStyle.color};">${typeStyle.label}</span>
          ${ageBadge}
          ${tctActive ? '<span class="tct-badge">★ TCT</span>' : ''}
        </div>
        <textarea class="card-text-edit" data-id="${esc(item.id)}">${escTextarea(item.text)}</textarea>
        <div class="card-footer">
          <span class="card-meta">${formatTime(item.createdAt)}</span>
          <div class="card-actions">
            <button class="action-btn done-btn" data-id="${esc(item.id)}" title="Mark done">${doneSVG()}</button>
            ${canTCT ? `<button class="action-btn tct-btn ${tctActive ? 'active' : ''}" data-id="${esc(item.id)}" title="${tctActive ? 'Remove TCT' : 'Add to today\'s 3'}">★</button>` : ''}
            <button class="action-btn move" data-id="${esc(item.id)}" title="Move to account">${moveSVG()}</button>
            <button class="action-btn delete" data-id="${esc(item.id)}" title="Delete">${trashSVG()}</button>
          </div>
        </div>
        <div class="reassign-panel" id="reassign-${esc(item.id)}">
          <span class="reassign-label">Move to:</span>
          <select class="reassign-select" id="reassign-sel-${esc(item.id)}">${accOptions}</select>
          <button class="reassign-save" data-id="${esc(item.id)}">Save</button>
        </div>
      </div>
    </div>`;
}

function formatDueDate(dateStr) {
  if (!dateStr) return '';
  const due = new Date(dateStr + 'T00:00:00');
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const diff = Math.floor((due - today) / 86400000);
  if (diff < 0) return `<span class="due-tag overdue">Overdue ${Math.abs(diff)}d</span>`;
  if (diff === 0) return `<span class="due-tag due-today">Due today</span>`;
  if (diff === 1) return `<span class="due-tag due-soon">Tomorrow</span>`;
  if (diff <= 7) return `<span class="due-tag due-soon">${diff}d</span>`;
  return `<span class="due-tag">${due.toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</span>`;
}

document.getElementById('filter-bar').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  activeFilter = btn.dataset.type;
  renderBrowse();
});

document.getElementById('all-accounts-toggle').addEventListener('click', () => { allAccounts = !allAccounts; renderBrowse(); });
document.getElementById('search-input').addEventListener('input', function() {
  document.getElementById('search-wrap').classList.toggle('has-value', !!this.value);
  renderBrowse();
});
document.getElementById('search-clear').addEventListener('click', () => {
  document.getElementById('search-input').value = '';
  document.getElementById('search-wrap').classList.remove('has-value');
  renderBrowse();
});
document.getElementById('sort-select').addEventListener('change', renderBrowse);

// ═══ WEEKLY REVIEW ═══
let wrItems = [];
let wrIndex = 0;
let wrStats = { kept: 0, done: 0, killed: 0, edited: 0, tct: 0 };
let wrLastAction = null;

function wrCaptureState(item) {
  return { id: item.id, text: item.text, type: item.type, _tct: item._tct, _done: item._done,
    completedAt: item.completedAt, _deleted: item._deleted, _deletedAt: item._deletedAt, updatedAt: item.updatedAt };
}

function wrRestoreState(snapshot) {
  const item = data.items.find(i => i.id === snapshot.id);
  if (item) Object.assign(item, snapshot);
}

function wrUndoLast() {
  if (!wrLastAction) return;
  wrRestoreState(wrLastAction.itemBefore);
  saveData();
  wrStats = wrLastAction.statsBefore;
  wrIndex = wrLastAction.index;
  wrLastAction = null;
  renderWRCard();
}

function startWeeklyReview() {
  document.getElementById('settings-panel-overlay').classList.remove('open');
  document.getElementById('review-banner').classList.add('hidden');

  const active = getActiveItems();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const overdue = active.filter(i => i.dueDate && new Date(i.dueDate + 'T23:59:59') < today && i.type !== 'note' && i.type !== 'someday');
  const stale = active.filter(i => !i.dueDate && getAgeDays(i.createdAt) >= 14 && i.type !== 'note' && i.type !== 'someday' && !overdue.includes(i));
  const healthy = active.filter(i => i.type !== 'note' && i.type !== 'someday' && !overdue.includes(i) && !stale.includes(i));
  const notesSomeday = active.filter(i => i.type === 'note' || i.type === 'someday');

  overdue.sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
  stale.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  healthy.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  wrItems = [...overdue, ...stale, ...healthy, ...notesSomeday];
  wrIndex = 0;
  wrStats = { kept: 0, done: 0, killed: 0, edited: 0, tct: 0, startCount: active.length };
  wrLastAction = null;

  switchView('weekly-review');

  if (wrItems.length === 0) {
    renderWRSummary();
  } else {
    renderWROverview(active, overdue, stale);
  }
}

function renderWROverview(active, overdue, stale) {
  const container = document.getElementById('wr-content');
  const lastReview = localStorage.getItem(LAST_REVIEW_KEY);
  const daysSince = lastReview ? Math.floor((Date.now() - new Date(lastReview).getTime()) / 86400000) : null;

  const byCounts = {};
  active.forEach(i => { byCounts[i.account] = (byCounts[i.account] || 0) + 1; });

  container.innerHTML = `
    <div class="wr-overview">
      <h2 class="wr-title">Weekly Review</h2>
      <p class="wr-subtitle">${daysSince !== null ? `Last review: ${daysSince} day${daysSince !== 1 ? 's' : ''} ago` : 'First review'}</p>
      <div class="wr-stats-row">
        <div class="wr-stat"><span class="wr-stat-num wr-danger">${overdue.length}</span><span class="wr-stat-label">Overdue</span></div>
        <div class="wr-stat"><span class="wr-stat-num wr-amber">${stale.length}</span><span class="wr-stat-label">Stale</span></div>
        <div class="wr-stat"><span class="wr-stat-num">${active.length}</span><span class="wr-stat-label">Total</span></div>
      </div>
      <div class="wr-accounts">
        ${Object.entries(byCounts).sort((a,b) => b[1] - a[1]).map(([acc, count]) => {
          const accObj = data.accounts.find(a => a.name === acc);
          const color = accObj ? accObj.color : '#888';
          return `<div class="wr-acc-row"><span class="account-dot" style="background:${color}"></span><span>${escHtml(acc || 'Unassigned')}</span><span class="wr-acc-count">${count}</span></div>`;
        }).join('')}
      </div>
      <button class="capture-btn" id="wr-start-btn" style="margin-top:20px;">Let's go — ${wrItems.length} items</button>
      <button class="subtle-btn" id="wr-cancel-btn" style="margin-top:10px;width:100%;">Cancel</button>
    </div>`;

  document.getElementById('wr-start-btn').addEventListener('click', () => renderWRCard());
  document.getElementById('wr-cancel-btn').addEventListener('click', () => switchView('capture'));
}

function renderWRCard() {
  if (wrIndex >= wrItems.length) { renderWRSummary(); return; }

  const container = document.getElementById('wr-content');
  const item = wrItems[wrIndex];
  const acc = data.accounts.find(a => a.name === item.account);
  const accColor = acc ? acc.color : '#888';
  const typeStyle = getTypeStyle(item.type);
  const ageDays = getAgeDays(item.createdAt);
  const ageClass = getAgeClass(item);
  const canTCT = item.type !== 'note' && item.type !== 'someday' && getTCTCount() < 3 && !item._tct;

  let statusLine = '';
  if (item.dueDate) {
    const due = new Date(item.dueDate + 'T23:59:59');
    const today = new Date(); today.setHours(0,0,0,0);
    if (due < today) statusLine = `<span class="wr-status overdue">Overdue by ${Math.abs(Math.floor((due - today) / 86400000))} days</span>`;
    else statusLine = `<span class="wr-status">Due ${new Date(item.dueDate + 'T00:00:00').toLocaleDateString('en-GB', { day:'numeric', month:'short' })}</span>`;
  } else if (ageDays >= 14 && item.type !== 'note' && item.type !== 'someday') {
    statusLine = `<span class="wr-status stale">Stale — ${ageDays} days old</span>`;
  }

  let prompt = '';
  if (item.type === 'waiting') prompt = '<div class="wr-prompt">Still waiting? Chase or kill?</div>';
  else if (item.type === 'project') prompt = '<div class="wr-prompt">What\'s the actual next action here?</div>';

  container.innerHTML = `
    <div class="wr-card-view">
      <div class="wr-progress">
        <div class="wr-progress-bar" style="width:${((wrIndex + 1) / wrItems.length * 100)}%"></div>
      </div>
      <div class="wr-progress-label">${wrIndex + 1} of ${wrItems.length}${wrLastAction ? ' &nbsp;·&nbsp; <button class="wr-undo-link" id="wr-undo">Undo last</button>' : ''}</div>

      <div class="wr-card ${ageClass}">
        <div class="wr-card-header">
          <span class="account-dot" style="background:${accColor}"></span>
          <span class="wr-card-account">${escHtml(item.account || 'Unassigned')}</span>
          <span class="type-badge" style="background:${typeStyle.bg};color:${typeStyle.color};">${typeStyle.label}</span>
          <span class="age-badge ${ageClass}">${getAgeLabel(ageDays)}</span>
        </div>
        ${statusLine}
        ${prompt}
        <textarea class="wr-card-text" id="wr-text">${escTextarea(item.text)}</textarea>
        <div class="wr-type-row">
          <span class="wr-type-label">Type:</span>
          <select class="wr-type-select" id="wr-type-select">
            ${TYPE_CONFIG.map(t => `<option value="${t.key}" ${item.type === t.key ? 'selected' : ''}>${t.label}</option>`).join('')}
          </select>
        </div>
      </div>

      <div class="wr-actions">
        <button class="wr-action-btn wr-keep" id="wr-keep">Keep</button>
        <button class="wr-action-btn wr-done" id="wr-done">Done ✓</button>
        <button class="wr-action-btn wr-kill" id="wr-kill">Kill</button>
        ${canTCT ? '<button class="wr-action-btn wr-tct" id="wr-tct">★ TCT</button>' : ''}
      </div>
    </div>`;

  document.getElementById('wr-keep').addEventListener('click', () => {
    const itemBefore = wrCaptureState(item), statsBefore = { ...wrStats };
    applyWREdits(item); wrStats.kept++;
    wrLastAction = { itemBefore, statsBefore, index: wrIndex };
    wrIndex++; renderWRCard();
  });
  document.getElementById('wr-done').addEventListener('click', () => {
    const itemBefore = wrCaptureState(item), statsBefore = { ...wrStats };
    applyWREdits(item); markDone(item.id); wrStats.done++;
    wrLastAction = { itemBefore, statsBefore, index: wrIndex };
    wrIndex++; renderWRCard();
  });
  document.getElementById('wr-kill').addEventListener('click', () => {
    const itemBefore = wrCaptureState(item), statsBefore = { ...wrStats };
    deleteItem(item.id); wrStats.killed++;
    wrLastAction = { itemBefore, statsBefore, index: wrIndex };
    wrIndex++; renderWRCard();
  });

  const tctBtn = document.getElementById('wr-tct');
  if (tctBtn) {
    tctBtn.addEventListener('click', () => {
      const itemBefore = wrCaptureState(item), statsBefore = { ...wrStats };
      applyWREdits(item); toggleTCT(item.id);
      wrStats.tct++; wrStats.kept++;
      wrLastAction = { itemBefore, statsBefore, index: wrIndex };
      wrIndex++; renderWRCard();
    });
  }

  const undoBtnEl = document.getElementById('wr-undo');
  if (undoBtnEl) undoBtnEl.addEventListener('click', wrUndoLast);
}

function applyWREdits(item) {
  const textEl = document.getElementById('wr-text');
  const typeEl = document.getElementById('wr-type-select');
  const updates = {};
  if (textEl && textEl.value.trim() !== item.text) { updates.text = textEl.value.trim(); wrStats.edited++; }
  if (typeEl && typeEl.value !== item.type) { updates.type = typeEl.value; wrStats.edited++; }
  if (Object.keys(updates).length) updateItem(item.id, updates);
}

function renderWRSummary() {
  const container = document.getElementById('wr-content');
  const newActive = getActiveItems().length;

  localStorage.setItem(LAST_REVIEW_KEY, new Date().toISOString());

  container.innerHTML = `
    <div class="wr-summary">
      <div class="wr-summary-icon">✓</div>
      <h2 class="wr-title">Review Complete</h2>
      <div class="wr-stats-row">
        <div class="wr-stat"><span class="wr-stat-num">${wrStats.kept}</span><span class="wr-stat-label">Kept</span></div>
        <div class="wr-stat"><span class="wr-stat-num wr-success">${wrStats.done}</span><span class="wr-stat-label">Done</span></div>
        <div class="wr-stat"><span class="wr-stat-num wr-danger">${wrStats.killed}</span><span class="wr-stat-label">Killed</span></div>
        <div class="wr-stat"><span class="wr-stat-num">${wrStats.edited}</span><span class="wr-stat-label">Edited</span></div>
        ${wrStats.tct ? `<div class="wr-stat"><span class="wr-stat-num wr-accent">★ ${wrStats.tct}</span><span class="wr-stat-label">TCT</span></div>` : ''}
      </div>
      <div class="wr-summary-total">
        <span>Active items: <strong>${newActive}</strong></span>
        <span class="wr-summary-change">${wrStats.startCount ? `(was ${wrStats.startCount})` : ''}</span>
      </div>
      <button class="capture-btn" id="wr-finish-btn" style="margin-top:24px;">Done</button>
      ${wrLastAction ? '<button class="subtle-btn" id="wr-undo-summary" style="margin-top:10px;width:100%;">Undo last action</button>' : ''}
    </div>`;

  document.getElementById('wr-finish-btn').addEventListener('click', () => {
    renderAll(); switchView('browse');
  });
  const undoSummaryBtn = document.getElementById('wr-undo-summary');
  if (undoSummaryBtn) undoSummaryBtn.addEventListener('click', wrUndoLast);
}

function checkReviewBanner() {
  const banner = document.getElementById('review-banner');
  if (!banner) return;

  const lastReview = localStorage.getItem(LAST_REVIEW_KEY);
  const snoozedUntil = localStorage.getItem(REVIEW_SNOOZE_KEY);

  if (snoozedUntil && Date.now() < parseInt(snoozedUntil)) { banner.classList.add('hidden'); return; }

  if (!lastReview) {
    banner.classList.remove('hidden');
    document.getElementById('review-banner-text').textContent = 'You haven\'t done a weekly review yet';
    return;
  }

  const daysSince = Math.floor((Date.now() - new Date(lastReview).getTime()) / 86400000);
  if (daysSince >= 7) {
    banner.classList.remove('hidden');
    document.getElementById('review-banner-text').textContent = `${daysSince} days since your last review`;
  } else {
    banner.classList.add('hidden');
  }
}

document.getElementById('review-banner-start')?.addEventListener('click', startWeeklyReview);
document.getElementById('review-banner-snooze')?.addEventListener('click', () => {
  localStorage.setItem(REVIEW_SNOOZE_KEY, (Date.now() + 86400000).toString());
  document.getElementById('review-banner').classList.add('hidden');
});
document.getElementById('start-weekly-review-btn')?.addEventListener('click', startWeeklyReview);

function updateReviewMeta() {
  const el = document.getElementById('settings-review-meta');
  if (!el) return;
  const lastReview = localStorage.getItem(LAST_REVIEW_KEY);
  if (!lastReview) { el.textContent = 'Never reviewed'; return; }
  const daysSince = Math.floor((Date.now() - new Date(lastReview).getTime()) / 86400000);
  el.textContent = daysSince === 0 ? 'Reviewed today' : `${daysSince}d ago`;
}

// ═══ SWIPE TO DELETE ═══
function initSwipe(card, onDelete) {
  const inner = card.querySelector('.card-inner');
  if (!inner) return;
  let startX = 0, currentX = 0, isDragging = false;
  const THRESHOLD = 80;
  card.addEventListener('touchstart', e => {
    if (e.target.closest('textarea, select, button, input')) return;
    startX = e.touches[0].clientX; isDragging = true;
    inner.style.transition = 'none';
  }, { passive: true });
  card.addEventListener('touchmove', e => {
    if (!isDragging) return;
    currentX = e.touches[0].clientX - startX;
    if (currentX > 0) currentX = 0;
    inner.style.transform = `translateX(${currentX}px)`;
    if (currentX < -10) card.classList.add('swiping');
  }, { passive: true });
  card.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;
    inner.style.transition = 'transform 0.2s ease';
    if (currentX < -THRESHOLD) {
      inner.style.transform = `translateX(-100%)`;
      card.style.opacity = '0'; card.style.transition = 'opacity 0.2s ease';
      const id = card.dataset.id;
      setTimeout(() => onDelete(id), 200);
    } else {
      inner.style.transform = 'translateX(0)';
      card.classList.remove('swiping');
    }
    currentX = 0;
  });
}

// ═══ UNDO / TOAST ═══
const toastEl   = document.getElementById('toast');
const toastText = document.getElementById('toast-text');
const undoBtn   = document.getElementById('undo-btn');

function toast(msg) {
  toastText.textContent = msg; undoBtn.classList.add('hidden');
  toastEl.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => toastEl.classList.remove('show'), 3000);
}

function showUndo(msg, item) {
  undoItem = item; toastText.textContent = msg; undoBtn.classList.remove('hidden');
  toastEl.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { toastEl.classList.remove('show'); undoItem = null; }, 6000);
}

let undoDoneItem = null;
function showUndoDone(msg, item) {
  undoDoneItem = item; toastText.textContent = msg; undoBtn.classList.remove('hidden');
  toastEl.classList.add('show');
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { toastEl.classList.remove('show'); undoDoneItem = null; }, 6000);
}

undoBtn.addEventListener('click', () => {
  if (undoDoneItem) { undoDone(undoDoneItem); undoDoneItem = null; toastEl.classList.remove('show'); renderAll(); toast('Restored'); return; }
  if (undoItem) { restoreItem(undoItem); undoItem = null; toastEl.classList.remove('show'); renderAll(); toast('Restored'); }
});

// ═══ MODAL ═══
let modalCallback = null;
const modalOverlay = document.getElementById('modal-overlay');

function openModal(title, body, contentFn, onConfirm, confirmText, danger) {
  document.getElementById('modal-title').textContent = title;
  document.getElementById('modal-body').textContent  = body;
  document.getElementById('modal-content').innerHTML = '';
  if (contentFn) contentFn(document.getElementById('modal-content'));
  document.getElementById('modal-confirm').textContent = confirmText || 'Confirm';
  document.getElementById('modal-confirm').className   = danger ? 'modal-btn danger' : 'modal-btn primary';
  modalCallback = onConfirm;
  modalOverlay.classList.add('open');
}

function closeModal() { modalOverlay.classList.remove('open'); modalCallback = null; }
document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.getElementById('modal-confirm').addEventListener('click', () => { if (modalCallback) modalCallback(); closeModal(); });
modalOverlay.addEventListener('click', e => { if (e.target === modalOverlay) closeModal(); });

// ═══ SETTINGS PANEL ═══
const settingsPanelOverlay = document.getElementById('settings-panel-overlay');

document.getElementById('settings-btn').addEventListener('click', () => {
  updateStatsLabel(); updateReviewMeta();
  settingsPanelOverlay.classList.add('open');
});
document.getElementById('settings-panel-close').addEventListener('click', () => settingsPanelOverlay.classList.remove('open'));
settingsPanelOverlay.addEventListener('click', e => { if (e.target === settingsPanelOverlay) settingsPanelOverlay.classList.remove('open'); });

function updateStatsLabel() {
  const active  = data.items.filter(i => !i._deleted && !i._done).length;
  const done    = data.items.filter(i => i._done && !i._deleted).length;
  const deleted = data.items.filter(i => i._deleted).length;
  let text = active + ' active';
  if (done > 0) text += ' · ' + done + ' done';
  if (deleted > 0) text += ' · ' + deleted + ' in trash';
  const el = document.getElementById('stats-text');
  if (el) el.textContent = text;
  const purgeBtn = document.getElementById('purge-btn');
  if (purgeBtn) purgeBtn.classList.toggle('hidden', deleted === 0);
}

document.getElementById('sync-btn').addEventListener('click', () => {
  if (cloudUrl) pullFromCloud();
  else document.getElementById('cloud-btn').click();
});

document.getElementById('cloud-btn').addEventListener('click', () => {
  openModal('Cloud Sync', 'Enter your Google Apps Script details:', ct => {
    ct.innerHTML = `
      <label class="modal-label">Script URL</label>
      <input type="text" class="modal-input" id="cloud-url-input" value="${esc(cloudUrl)}" placeholder="https://script.google.com/...">
      <label class="modal-label">API Key</label>
      <input type="password" class="modal-input" id="cloud-key-input" value="${esc(cloudKey)}" placeholder="Your API key">`;
  }, () => {
    const url = document.getElementById('cloud-url-input').value.trim();
    const key = document.getElementById('cloud-key-input').value.trim();
    if (url) {
      localStorage.setItem(CLOUD_URL_KEY, url); localStorage.setItem(CLOUD_KEY_KEY, key);
      cloudUrl = url; cloudKey = key;
      setTimeout(() => pullFromCloud(), 500);
    } else {
      localStorage.removeItem(CLOUD_URL_KEY); localStorage.removeItem(CLOUD_KEY_KEY);
      cloudUrl = ''; cloudKey = ''; setSyncStatus('offline');
    }
  }, 'Save');
});

document.getElementById('export-btn').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = 'trigpoint-backup-' + new Date().toISOString().slice(0, 10) + '.json';
  a.click(); URL.revokeObjectURL(url);
  toast('Backup downloaded');
});

document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const imported = JSON.parse(reader.result);
      if (!Array.isArray(imported.items)) throw new Error('Invalid format');
      const existingIds = new Set(data.items.map(i => i.id));
      let count = 0;
      imported.items.forEach(item => { if (!existingIds.has(item.id)) { data.items.push(item); count++; } });
      if (Array.isArray(imported.accounts)) {
        imported.accounts.forEach(acc => {
          const name = typeof acc === 'string' ? acc : acc.name;
          if (!data.accounts.find(a => a.name === name))
            data.accounts.push(typeof acc === 'string' ? { name: acc, color: '#888' } : acc);
        });
      }
      data.items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
      localStorage.removeItem(MIGRATED_KEY);
      data = migrateV2toV3(data);
      saveData(); renderAll();
      toast('Imported ' + count + ' items');
    } catch (err) { console.error(err); toast('Invalid backup file'); }
  };
  reader.readAsText(file); e.target.value = '';
});

document.getElementById('trash-btn').addEventListener('click', () => { settingsPanelOverlay.classList.remove('open'); openTrashView(); });
document.getElementById('purge-btn').addEventListener('click', () => { settingsPanelOverlay.classList.remove('open'); openTrashView(); });

document.getElementById('reset-btn').addEventListener('click', () => {
  openModal('Reset App?', 'This deletes ALL local data. Cloud data is kept.', ct => {
    ct.innerHTML = '<input type="text" class="modal-input" id="reset-confirm" placeholder="Type DELETE to confirm">';
    setTimeout(() => {
      const inp = document.getElementById('reset-confirm');
      inp.addEventListener('input', () => {
        document.getElementById('modal-confirm').disabled = inp.value !== 'DELETE';
        document.getElementById('modal-confirm').style.opacity = inp.value === 'DELETE' ? '1' : '0.4';
      });
    }, 50);
  }, () => {
    data = { items: [], accounts: DEFAULT_ACCOUNTS, types: DEFAULT_TYPES };
    localStorage.removeItem(MIGRATED_KEY);
    saveData(); setActiveAccount('Personal'); toast('App reset');
  }, 'Reset', true);
  setTimeout(() => { document.getElementById('modal-confirm').disabled = true; document.getElementById('modal-confirm').style.opacity = '0.4'; }, 50);
});

document.getElementById('colours-btn').addEventListener('click', () => {
  settingsPanelOverlay.classList.remove('open');
  openModal('Account Colours', 'Tap the colour swatch to change any account colour.', ct => {
    ct.innerHTML = data.accounts.map((acc, idx) => `
      <div class="settings-list-item">
        <div class="settings-list-left">
          <div class="settings-color-swatch" style="background:${acc.color}">
            <input type="color" value="${acc.color}" data-idx="${idx}" title="Change colour">
          </div>
          <span style="font-weight:600;">${escHtml(acc.name)}</span>
        </div>
      </div>`).join('');
    ct.querySelectorAll('input[type="color"]').forEach(inp => {
      inp.addEventListener('change', () => {
        const idx = parseInt(inp.dataset.idx);
        data.accounts[idx].color = inp.value;
        inp.closest('.settings-color-swatch').style.background = inp.value;
        saveData(); renderAccountDropdown();
      });
    });
  }, () => renderAll(), 'Done');
});

// ═══ COLOUR PROMPT ═══
function checkColourPrompt() {
  const grey = data.accounts.filter(a => !a.color || a.color === '#888' || a.color === '#888888');
  if (!grey.length) return;
  const list = document.getElementById('colour-prompt-list');
  list.innerHTML = grey.map(acc => `
    <div class="colour-prompt-item">
      <span class="colour-prompt-name">${escHtml(acc.name)}</span>
      <div class="colour-prompt-pick">
        <div class="colour-swatch-lg" id="swatch-${esc(acc.name)}" style="background:#0033CC">
          <input type="color" value="#0033CC" data-acc="${esc(acc.name)}">
        </div>
      </div>
    </div>`).join('');
  list.querySelectorAll('input[type="color"]').forEach(inp => {
    inp.addEventListener('input', () => { document.getElementById('swatch-' + inp.dataset.acc).style.background = inp.value; });
  });
  document.getElementById('colour-prompt-overlay').classList.add('open');
}

document.getElementById('colour-prompt-save').addEventListener('click', () => {
  document.querySelectorAll('#colour-prompt-list input[type="color"]').forEach(inp => {
    const acc = data.accounts.find(a => a.name === inp.dataset.acc);
    if (acc) acc.color = inp.value;
  });
  saveData(); renderAccountDropdown();
  document.getElementById('colour-prompt-overlay').classList.remove('open');
  toast('Account colours saved');
});

// ═══ DIGEST ═══
document.getElementById('digest-btn').addEventListener('click', () => {
  const active = getActiveItems();
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const overdueCount = active.filter(i => i.dueDate && new Date(i.dueDate + 'T23:59:59') < today).length;
  const staleCount = active.filter(i => !i.dueDate && getAgeDays(i.createdAt) >= 14 && i.type !== 'note' && i.type !== 'someday').length;
  openModal(
    'Send Digest',
    `${active.length} active items${overdueCount ? ` · ${overdueCount} overdue` : ''}${staleCount ? ` · ${staleCount} stale` : ''}`,
    null, sendDigest, 'Send'
  );
});

async function sendDigest() {
  if (!cloudUrl) { toast('No cloud URL configured'); return; }
  toast('Sending digest…');
  try {
    const active = getActiveItems();
    const res = await fetch(cloudUrl, {
      method: 'POST', redirect: 'follow',
      body: JSON.stringify({
        key: cloudKey, action: 'digest', digestHtml: '<p>Digest v3 — use app for full review</p>',
        itemCount: active.length, overdueCount: 0,
        generatedAt: new Date().toISOString()
      })
    });
    const result = JSON.parse(await res.text());
    toast(result.success ? 'Digest sent ✓' : 'Digest failed');
  } catch (e) { console.error(e); toast('Digest send failed'); }
}

// ═══ BADGE / STATS ═══
function updateBadge() {
  const count = getInboxItems().length;
  ['badge-desk', 'badge-mob'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = count;
    el.classList.toggle('hidden', count === 0);
  });
}

function updateStats() {
  const active  = data.items.filter(i => !i._deleted && !i._done).length;
  const done    = data.items.filter(i => i._done && !i._deleted).length;
  const deleted = data.items.filter(i => i._deleted).length;
  let text = active + ' active';
  if (done > 0) text += ' · ' + done + ' done';
  if (deleted > 0) text += ' · ' + deleted + ' in trash';
  const el = document.getElementById('stats-text');
  if (el) el.textContent = text;
  const trashCount = document.getElementById('trash-count');
  if (trashCount) {
    if (deleted > 0) { trashCount.textContent = deleted; trashCount.classList.remove('hidden'); }
    else { trashCount.classList.add('hidden'); }
  }
  const purgeBtn = document.getElementById('purge-btn');
  if (purgeBtn) purgeBtn.classList.toggle('hidden', deleted === 0);
}

function formatTime(iso) {
  const d = new Date(iso); const now = new Date(); const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 172800000) return 'yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function escHtml(s) { if (typeof s !== 'string') return ''; const div = document.createElement('div'); div.textContent = s; return div.innerHTML; }
function esc(s) { if (typeof s !== 'string') return ''; return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function escTextarea(s) { if (typeof s !== 'string') return ''; return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ═══ SVG ICONS ═══
function trashSVG() { return `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`; }
function moveSVG() { return `<svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 10l-4-4 4-4v3h4v2h-4v3z"/></svg>`; }
function doneSVG() { return `<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>`; }

function renderAll() {
  if (currentView === 'review')  renderReview();
  if (currentView === 'browse')  renderBrowse();
  updateBadge(); updateStats();
  checkReviewBanner();
}

// ═══ INIT ═══
renderAccountDropdown();
updateAccountSelectorVisibility();
renderAll();
if (window.innerWidth > 600) captureInput.focus();
setTimeout(checkColourPrompt, 500);


// ═══════════════════════════════════════════════════════════
// QUICK CAPTURE WIDGET
// ═══════════════════════════════════════════════════════════

let _widgetWindow = null;

function openCaptureWidget() {
  // If already open, just bring it to the front
  if (_widgetWindow && !_widgetWindow.closed) {
    _widgetWindow.focus();
    return;
  }

  const W = 400, H = 280;
  const screenW = window.screen.availWidth  || window.screen.width;
  const screenH = window.screen.availHeight || window.screen.height;
  const left = Math.max(0, screenW - W - 24);
  const top  = Math.max(0, screenH - H - 60);

  _widgetWindow = window.open(
    '/widget.html',
    'tp_capture_widget',
    `width=${W},height=${H},left=${left},top=${top},resizable=yes,scrollbars=no,toolbar=no,menubar=no,location=no,status=no`
  );

  if (!_widgetWindow) {
    alert('Popup blocked.\n\nPlease allow popups for this site in your browser settings, then click + again.\n\nIn Chrome: click the blocked popup icon in the address bar → "Always allow".');
    return;
  }

  _widgetWindow.focus();
}

// Refresh main app live when widget writes an item
window.addEventListener('storage', e => {
  if (e.key !== STORAGE_KEY) return;
  try {
    const updated = JSON.parse(e.newValue || '{}');
    if (Array.isArray(updated.items)) {
      data.items    = updated.items;
      data.accounts = updated.accounts || data.accounts;
    }
  } catch(err) {}
  renderAll(); updateBadge(); updateStats();
});

document.getElementById('open-widget').addEventListener('click', openCaptureWidget);
