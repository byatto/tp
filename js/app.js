// ═══════════════════════════════════════════════════════════
// TRIGPOINT v2.1 — app.js
// Improvements: settings panel, capture indicator, cross-account
// badge, move icon fix, item counts in dropdown, swipe-to-delete
// ═══════════════════════════════════════════════════════════

const STORAGE_KEY      = 'trigpoint_v2_data';
const CLOUD_URL_KEY    = 'trigpoint_v2_cloud_url';
const CLOUD_KEY_KEY    = 'trigpoint_v2_cloud_key';
const THEME_KEY        = 'trigpoint_v2_theme';
const ACTIVE_ACCOUNT_KEY = 'trigpoint_v2_account';

const DEFAULT_ACCOUNTS   = [{ name: 'Personal', color: '#0033CC' }, { name: 'Work', color: '#00875A' }];
const DEFAULT_CATEGORIES = ['note', 'task', 'news', 'opp'];

const CAT_PALETTE = [
  { color: '#0033CC', bg: 'rgba(0,51,204,0.08)' },
  { color: '#00875A', bg: 'rgba(0,135,90,0.08)' },
  { color: '#6554C0', bg: 'rgba(101,84,192,0.08)' },
  { color: '#FF8B00', bg: 'rgba(255,139,0,0.08)' },
  { color: '#DE350B', bg: 'rgba(222,53,11,0.08)' },
  { color: '#00A3BF', bg: 'rgba(0,163,191,0.08)' },
];
const CAT_PALETTE_DARK = [
  { color: '#4D7CFF', bg: 'rgba(77,124,255,0.12)' },
  { color: '#36B37E', bg: 'rgba(54,179,126,0.12)' },
  { color: '#998DD9', bg: 'rgba(153,141,217,0.12)' },
  { color: '#FFAB00', bg: 'rgba(255,171,0,0.12)' },
  { color: '#FF5630', bg: 'rgba(255,86,48,0.12)' },
  { color: '#00B8D9', bg: 'rgba(0,184,217,0.12)' },
];

function getCatStyle(cat) {
  if (!cat) return { color: 'var(--text-muted)', bg: 'var(--bg-hover)' };
  const idx = data.categories.indexOf(cat);
  const i = idx >= 0 ? idx : 0;
  const isDark = document.body.getAttribute('data-theme') === 'dark';
  return (isDark ? CAT_PALETTE_DARK : CAT_PALETTE)[i % CAT_PALETTE.length];
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
      const d = JSON.parse(raw);
      if (!Array.isArray(d.items))      d.items      = [];
      if (!Array.isArray(d.accounts))   d.accounts   = DEFAULT_ACCOUNTS;
      if (!Array.isArray(d.categories)) d.categories = DEFAULT_CATEGORIES;
      d.items = d.items.filter(i => i && typeof i.id === 'string' && typeof i.text === 'string');
      d.items.forEach(i => {
        if (!i.createdAt) i.createdAt = new Date().toISOString();
        if (!i.account)   i.account   = d.accounts[0]?.name || 'Personal';
        if (!i.category)  i.category  = '';
        if (!i.status)    i.status    = 'inbox';
      });
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      d.items = d.items.filter(i => {
        if (!i._deleted) return true;
        if (!i._deletedAt) return false;
        return new Date(i._deletedAt).getTime() > cutoff;
      });
      return d;
    }
  } catch (e) { console.error('Load error:', e); }
  return { items: [], accounts: DEFAULT_ACCOUNTS, categories: DEFAULT_CATEGORIES };
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
const DEBUG_SYNC = false;

function debugLog(msg, d) { if (DEBUG_SYNC) console.log('[TrigPoint]', msg, d || ''); }
function showDebugToast(msg) {
  if (!DEBUG_SYNC) return;
  const existing = document.getElementById('debug-toast');
  if (existing) existing.remove();
  const div = document.createElement('div');
  div.id = 'debug-toast';
  div.style.cssText = 'position:fixed;top:10px;left:10px;right:10px;background:#333;color:#fff;padding:12px;border-radius:8px;font-size:12px;z-index:9999;font-family:monospace;white-space:pre-wrap;max-height:40vh;overflow:auto;';
  div.textContent = msg;
  div.onclick = () => div.remove();
  document.body.appendChild(div);
}

function setSyncStatus(status) {
  const dot = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
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
    if (Array.isArray(cloud.categories)) {
      cloud.categories.forEach(cat => { if (!data.categories.includes(cat)) data.categories.push(cat); });
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
    const payload = { key: cloudKey, items: data.items, accounts: data.accounts.map(a => a.name), categories: data.categories };
    const res  = await fetch(cloudUrl, { method: 'POST', redirect: 'follow', body: JSON.stringify(payload) });
    const text = await res.text();
    const result = JSON.parse(text);
    if (!result.success) throw new Error(result.error || 'Push failed');
    setSyncStatus('online');
  } catch (e) { console.error('Push error:', e); setSyncStatus('error'); }
}

document.addEventListener('visibilitychange', () => { if (!document.hidden && cloudUrl) pullFromCloud(); });
if (cloudUrl) { setTimeout(pullFromCloud, 500); } else { setSyncStatus('offline'); }

// ═══ ITEM OPERATIONS ═══
function addItem(text) {
  const item = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    text: text.trim(), account: activeAccount, category: '', status: 'inbox',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    _urgent: false, _deleted: false
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

function restoreItem(item) {
  const existing = data.items.find(i => i.id === item.id);
  if (existing) { existing._deleted = false; existing._deletedAt = null; }
  else { item._deleted = false; item._deletedAt = null; data.items.push(item); data.items.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)); }
  saveData();
}

function getInboxItems(account) {
  const acc = account || activeAccount;
  return data.items.filter(i => i.account === acc && i.status === 'inbox' && !i.category && !i._deleted);
}

function getAllInboxCount() {
  return data.items.filter(i => i.status === 'inbox' && !i.category && !i._deleted).length;
}

function searchItems(query, category, sort) {
  let results = data.items.filter(i => !i._deleted);
  if (!allAccounts) results = results.filter(i => i.account === activeAccount);
  if (category === 'inbox') results = results.filter(i => !i.category);
  else if (category && category !== 'all') results = results.filter(i => i.category === category);
  if (query) {
    const q = query.toLowerCase();
    results = results.filter(i =>
      i.text.toLowerCase().includes(q) ||
      (i.account && i.account.toLowerCase().includes(q)) ||
      (i.category && i.category.toLowerCase().includes(q))
    );
  }
  results.sort((a, b) => sort === 'oldest' ? new Date(a.createdAt) - new Date(b.createdAt) : new Date(b.createdAt) - new Date(a.createdAt));
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
  const current  = data.accounts.find(a => a.name === activeAccount) || data.accounts[0];

  document.getElementById('account-name').textContent = activeAccount;
  document.getElementById('account-dot').style.background = current?.color || '#888';

  dropdown.innerHTML = data.accounts.map(acc => {
    const inboxCount = getInboxItems(acc.name).length;
    const totalCount = data.items.filter(i => i.account === acc.name && !i._deleted).length;
    const countLabel = inboxCount > 0
      ? `<span class="account-option-count" style="background:var(--accent-glow);color:var(--accent)">${inboxCount} inbox</span>`
      : totalCount > 0
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
  updateCaptureIndicator();
  renderAll();
}

document.getElementById('account-btn').addEventListener('click', e => {
  e.stopPropagation();
  document.getElementById('account-dropdown').classList.toggle('open');
});

document.addEventListener('click', e => {
  if (!e.target.closest('.account-selector')) document.getElementById('account-dropdown').classList.remove('open');
});

// ═══ CAPTURE ACCOUNT INDICATOR ═══
function updateCaptureIndicator() {
  const acc = data.accounts.find(a => a.name === activeAccount);
  const dot = document.getElementById('indicator-dot');
  const label = document.getElementById('indicator-label');
  if (dot) dot.style.background = acc?.color || '#888';
  if (label) label.textContent = activeAccount;
  // Update capture indicator border colour to match account
  const indicator = document.getElementById('capture-account-indicator');
  if (indicator && acc) indicator.style.borderColor = acc.color + '44';
}

// ═══ VIEW SWITCHING ═══
function switchView(view) {
  currentView = view;
  if (view !== 'browse') allAccounts = false;
  ['capture', 'review', 'browse'].forEach(v => {
    document.getElementById('view-' + v).classList.toggle('hidden', v !== view);
  });
  document.querySelectorAll('#nav-desktop button, #nav-mobile button').forEach(b => {
    b.classList.toggle('active', b.dataset.view === view);
  });
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

// ═══ REVIEW RENDERING ═══
function renderReview() {
  const list  = document.getElementById('review-list');
  const items = getInboxItems();

  document.getElementById('review-count').textContent = items.length + ' items';

  // Cross-account notice
  const crossNotice = document.getElementById('cross-account-notice');
  const allInbox = getAllInboxCount();
  const otherInbox = allInbox - getInboxItems().length;
  if (crossNotice) {
    if (otherInbox > 0) {
      crossNotice.classList.remove('hidden');
      crossNotice.querySelector('.cross-account-text').textContent =
        `${otherInbox} item${otherInbox !== 1 ? 's' : ''} waiting in other accounts`;
    } else {
      crossNotice.classList.add('hidden');
    }
  }

  if (!items.length) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">✓</div>
        <div class="empty-title">Inbox Clear</div>
        <p>No items to review for ${escHtml(activeAccount)}</p>
      </div>`;
    return;
  }

  list.innerHTML = items.map(item => {
    const accOptions = data.accounts.map(a =>
      `<option value="${esc(a.name)}" ${a.name === item.account ? 'selected' : ''}>${escHtml(a.name)}</option>`
    ).join('');

    return `
    <div class="card" data-id="${esc(item.id)}">
      <div class="card-inner">
        <textarea class="card-text-edit" data-id="${esc(item.id)}">${escTextarea(item.text)}</textarea>
        <div class="cat-buttons">
          ${data.categories.map(cat => {
            const s = getCatStyle(cat);
            const selected = item.category === cat;
            const style = selected ? `background:${s.bg};color:${s.color};border-color:transparent;` : '';
            return `<button class="cat-btn ${selected ? 'selected' : ''}" style="${style}" data-cat="${cat}" data-id="${esc(item.id)}">
              ${cat.charAt(0).toUpperCase() + cat.slice(1)}
            </button>`;
          }).join('')}
        </div>
        <div class="file-confirm-row ${item.category ? 'visible' : ''}" id="confirm-row-${esc(item.id)}">
          <button class="file-confirm-btn" data-id="${esc(item.id)}">
            File as ${item.category ? item.category.charAt(0).toUpperCase() + item.category.slice(1) : ''} →
          </button>
          <button class="file-cancel-btn" data-id="${esc(item.id)}">Cancel</button>
        </div>
        <div class="card-footer">
          <span class="card-meta">${formatTime(item.createdAt)}</span>
          <div class="card-actions">
            <button class="action-btn urgent-btn ${item._urgent ? 'active' : ''}" data-id="${esc(item.id)}" title="${item._urgent ? 'Remove urgent' : 'Mark urgent'}">
              <span style="font-size:15px;font-weight:800;line-height:1;">!</span>
            </button>
            <button class="action-btn move" data-id="${esc(item.id)}" title="Move to account">
              ${moveSVG()}
            </button>
            <button class="action-btn delete" data-action="delete" data-id="${esc(item.id)}" title="Delete">
              ${trashSVG()}
            </button>
          </div>
        </div>
        <div class="reassign-panel" id="reassign-${esc(item.id)}">
          <span class="reassign-label">Move to:</span>
          <select class="reassign-select" id="reassign-sel-${esc(item.id)}">${accOptions}</select>
          <button class="reassign-save" data-id="${esc(item.id)}">Save</button>
        </div>
      </div>
    </div>`;
  }).join('');

  // Category select — sets pending category, shows confirm row
  list.querySelectorAll('.cat-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const itemId = btn.dataset.id;
      const cat = btn.dataset.cat;
      const card = list.querySelector(`.card[data-id="${itemId}"]`);
      if (!card) return;

      // Toggle selection on buttons
      card.querySelectorAll('.cat-btn').forEach(b => {
        b.classList.remove('selected');
        b.removeAttribute('style');
      });
      const s = getCatStyle(cat);
      btn.classList.add('selected');
      btn.style.cssText = `background:${s.bg};color:${s.color};border-color:transparent;`;

      // Show/update confirm row
      const confirmRow = document.getElementById('confirm-row-' + itemId);
      if (confirmRow) {
        confirmRow.classList.add('visible');
        const confirmBtn = confirmRow.querySelector('.file-confirm-btn');
        if (confirmBtn) {
          confirmBtn.textContent = `File as ${cat.charAt(0).toUpperCase() + cat.slice(1)} →`;
          confirmBtn.dataset.cat = cat;
        }
      }
    });
  });

  // Confirm filing
  list.querySelectorAll('.file-confirm-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cat = btn.dataset.cat;
      const itemId = btn.dataset.id;
      updateItem(itemId, { category: cat, status: 'stored' });
      renderReview(); updateBadge(); updateStats();
      toast('Filed as ' + cat.charAt(0).toUpperCase() + cat.slice(1));
    });
  });

  // Cancel filing
  list.querySelectorAll('.file-cancel-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const itemId = btn.dataset.id;
      const card = list.querySelector(`.card[data-id="${itemId}"]`);
      if (!card) return;
      card.querySelectorAll('.cat-btn').forEach(b => { b.classList.remove('selected'); b.removeAttribute('style'); });
      const confirmRow = document.getElementById('confirm-row-' + itemId);
      if (confirmRow) confirmRow.classList.remove('visible');
    });
  });

  list.querySelectorAll('.action-btn.urgent-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = data.items.find(i => i.id === btn.dataset.id);
      if (!item) return;
      updateItem(btn.dataset.id, { _urgent: !item._urgent });
      renderReview();
      toast(item._urgent ? 'Urgent removed' : 'Marked urgent');
    });
  });

  list.querySelectorAll('.action-btn.delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const removed = deleteItem(btn.dataset.id);
      if (removed) showUndo('Deleted', removed);
      renderReview(); updateBadge(); updateStats();
    });
  });

  list.querySelectorAll('.action-btn.move').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById('reassign-' + btn.dataset.id);
      if (panel) { panel.classList.toggle('open'); btn.classList.toggle('open'); }
    });
  });

  list.querySelectorAll('.reassign-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const sel = document.getElementById('reassign-sel-' + btn.dataset.id);
      if (!sel) return;
      updateItem(btn.dataset.id, { account: sel.value });
      renderReview(); updateBadge();
      toast('Moved to ' + sel.value);
    });
  });

  list.querySelectorAll('textarea.card-text-edit').forEach(el => {
    autosize(el);
    el.addEventListener('input', () => autosize(el));
    el.addEventListener('blur', () => {
      const item = data.items.find(i => i.id === el.dataset.id);
      if (item && item.text !== el.value.trim()) updateItem(el.dataset.id, { text: el.value.trim() });
    });
  });

  // Swipe-to-delete for review cards
  list.querySelectorAll('.card').forEach(card => initSwipe(card, id => {
    const removed = deleteItem(id);
    if (removed) showUndo('Deleted', removed);
    renderReview(); updateBadge(); updateStats();
  }));
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

// ═══ BROWSE (formerly Retrieve) RENDERING ═══
function renderFilterBar() {
  const bar = document.getElementById('filter-bar');
  bar.innerHTML = `<button class="filter-btn ${activeFilter === 'all' ? 'active' : ''}" data-cat="all">All</button>`
    + data.categories.map(cat => {
        const s = getCatStyle(cat);
        const active = activeFilter === cat;
        const style = active ? `background:${s.bg};color:${s.color};border-color:transparent;` : '';
        return `<button class="filter-btn ${active ? 'active' : ''}" style="${style}" data-cat="${cat}">${cat.charAt(0).toUpperCase() + cat.slice(1)}</button>`;
      }).join('')
    + `<button class="filter-btn ${activeFilter === 'inbox' ? 'active' : ''}" data-cat="inbox">Inbox</button>`;
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
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No results</div>
        <p>Try a different search or filter</p>
      </div>`;
    return;
  }

  if (allAccounts) {
    const groups = new Map();
    results.forEach(item => {
      if (!groups.has(item.account)) groups.set(item.account, []);
      groups.get(item.account).push(item);
    });
    let html = '';
    for (const [accName, items] of groups) {
      const acc = data.accounts.find(a => a.name === accName);
      const colour = acc ? acc.color : '#888';
      html += `<div class="account-group-header" style="color:${colour}">
        <span class="account-group-dot"></span>
        <span class="account-group-name">${escHtml(accName)}</span>
        <span class="account-group-count">${items.length} item${items.length !== 1 ? 's' : ''}</span>
      </div>`;
      html += items.map(item => renderBrowseCard(item)).join('');
    }
    list.innerHTML = html;
  } else {
    const urgent = results.filter(i => i._urgent);
    const normal = results.filter(i => !i._urgent);
    let html = '';
    if (urgent.length) {
      html += `<div class="urgent-section-label">Urgent · ${urgent.length} item${urgent.length !== 1 ? 's' : ''}</div>`;
      html += urgent.map(item => renderBrowseCard(item)).join('');
    }
    const groups = groupByDate(normal);
    for (const [label, items] of groups) {
      html += `<div class="date-label">${escHtml(label)}</div>`;
      html += items.map(item => renderBrowseCard(item)).join('');
    }
    list.innerHTML = html;
  }

  list.querySelectorAll('.action-btn.urgent-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const item = data.items.find(i => i.id === btn.dataset.id);
      if (!item) return;
      updateItem(btn.dataset.id, { _urgent: !item._urgent });
      renderBrowse();
      toast(item._urgent ? 'Urgent removed' : 'Marked urgent');
    });
  });

  list.querySelectorAll('.action-btn.delete').forEach(btn => {
    btn.addEventListener('click', () => {
      const removed = deleteItem(btn.dataset.id);
      if (removed) showUndo('Deleted', removed);
      renderBrowse(); updateStats();
    });
  });

  list.querySelectorAll('.action-btn.move').forEach(btn => {
    btn.addEventListener('click', () => {
      const panel = document.getElementById('reassign-' + btn.dataset.id);
      if (panel) { panel.classList.toggle('open'); btn.classList.toggle('open'); }
    });
  });

  list.querySelectorAll('.reassign-save').forEach(btn => {
    btn.addEventListener('click', () => {
      const sel = document.getElementById('reassign-sel-' + btn.dataset.id);
      if (!sel) return;
      updateItem(btn.dataset.id, { account: sel.value });
      renderBrowse();
      toast('Moved to ' + sel.value);
    });
  });

  // Swipe to delete on browse cards
  list.querySelectorAll('.card').forEach(card => initSwipe(card, id => {
    const removed = deleteItem(id);
    if (removed) showUndo('Deleted', removed);
    renderBrowse(); updateStats();
  }));
}

function renderBrowseCard(item) {
  const catStyle = getCatStyle(item.category);
  const catLabel = item.category ? item.category.charAt(0).toUpperCase() + item.category.slice(1) : 'Inbox';
  const badgeStyle = `background:${catStyle.bg};color:${catStyle.color};`;
  const accOptions = data.accounts.map(a =>
    `<option value="${esc(a.name)}" ${a.name === item.account ? 'selected' : ''}>${escHtml(a.name)}</option>`
  ).join('');

  return `
    <div class="card ${item._urgent ? 'urgent' : ''}" data-id="${esc(item.id)}">
      <div class="card-swipe-delete">${trashSVG()}<span>Delete</span></div>
      <div class="card-inner">
        <div class="card-text">
          <span class="cat-badge" style="${badgeStyle}">${catLabel}</span>${escHtml(item.text)}
        </div>
        <div class="card-footer">
          <span class="card-meta">${formatTime(item.createdAt)}</span>
          <div class="card-actions">
            <button class="action-btn urgent-btn ${item._urgent ? 'active' : ''}" data-id="${esc(item.id)}" title="${item._urgent ? 'Remove urgent' : 'Mark urgent'}">
              <span style="font-size:15px;font-weight:800;line-height:1;">!</span>
            </button>
            <button class="action-btn move" data-id="${esc(item.id)}" title="Move to account">
              ${moveSVG()}
            </button>
            <button class="action-btn delete" data-id="${esc(item.id)}" title="Delete">
              ${trashSVG()}
            </button>
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

function groupByDate(items) {
  const groups = new Map();
  const now       = new Date();
  const today     = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  const weekAgo   = new Date(today); weekAgo.setDate(today.getDate() - 7);

  items.forEach(item => {
    const d = new Date(item.createdAt);
    let label;
    if (d >= today)     label = 'Today';
    else if (d >= yesterday) label = 'Yesterday';
    else if (d >= weekAgo)   label = 'This Week';
    else label = d.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(item);
  });
  return groups;
}

document.getElementById('filter-bar').addEventListener('click', e => {
  const btn = e.target.closest('.filter-btn');
  if (!btn) return;
  activeFilter = btn.dataset.cat;
  renderBrowse();
});

document.getElementById('all-accounts-toggle').addEventListener('click', () => {
  allAccounts = !allAccounts; renderBrowse();
});

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

// Cross-account notice: click to cycle to account with most inbox items
document.getElementById('cross-account-notice')?.addEventListener('click', () => {
  const otherAccounts = data.accounts.filter(a => a.name !== activeAccount);
  let best = null, bestCount = 0;
  otherAccounts.forEach(a => {
    const c = getInboxItems(a.name).length;
    if (c > bestCount) { best = a.name; bestCount = c; }
  });
  if (best) { setActiveAccount(best); switchView('review'); }
});

// ═══ SWIPE TO DELETE ═══
function initSwipe(card, onDelete) {
  const inner = card.querySelector('.card-inner');
  if (!inner) return;

  let startX = 0, currentX = 0, isDragging = false;
  const THRESHOLD = 80;

  card.addEventListener('touchstart', e => {
    startX = e.touches[0].clientX;
    isDragging = true;
    inner.style.transition = 'none';
  }, { passive: true });

  card.addEventListener('touchmove', e => {
    if (!isDragging) return;
    currentX = e.touches[0].clientX - startX;
    if (currentX < 0) {
      const offset = Math.max(currentX, -THRESHOLD - 20);
      inner.style.transform = `translateX(${offset}px)`;
      card.classList.add('swiping');
    }
  }, { passive: true });

  card.addEventListener('touchend', () => {
    if (!isDragging) return;
    isDragging = false;
    inner.style.transition = 'transform 0.2s ease';

    if (currentX < -THRESHOLD) {
      inner.style.transform = `translateX(-100%)`;
      card.style.opacity = '0';
      card.style.transition = 'opacity 0.2s ease';
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

undoBtn.addEventListener('click', () => {
  if (undoItem) {
    restoreItem(undoItem); undoItem = null;
    toastEl.classList.remove('show');
    renderAll(); toast('Restored');
  }
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
  updateStatsLabel();
  settingsPanelOverlay.classList.add('open');
});

document.getElementById('settings-panel-close').addEventListener('click', () => {
  settingsPanelOverlay.classList.remove('open');
});

settingsPanelOverlay.addEventListener('click', e => {
  if (e.target === settingsPanelOverlay) settingsPanelOverlay.classList.remove('open');
});

function updateStatsLabel() {
  const active  = data.items.filter(i => !i._deleted).length;
  const deleted = data.items.filter(i => i._deleted).length;
  let text = active + ' items';
  if (deleted > 0) text += ' · ' + deleted + ' in trash';
  const el = document.getElementById('stats-text');
  if (el) el.textContent = text;
  const purgeBtn = document.getElementById('purge-btn');
  if (purgeBtn) purgeBtn.classList.toggle('hidden', deleted === 0);
}

// Settings actions
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
      localStorage.setItem(CLOUD_URL_KEY, url);
      localStorage.setItem(CLOUD_KEY_KEY, key);
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
      saveData(); renderAll();
      toast('Imported ' + count + ' items');
    } catch (err) { console.error(err); toast('Invalid backup file'); }
  };
  reader.readAsText(file); e.target.value = '';
});

document.getElementById('purge-btn').addEventListener('click', () => {
  const count = data.items.filter(i => i._deleted).length;
  openModal('Purge Trash?', `Permanently delete ${count} items?`, null, () => {
    data.items = data.items.filter(i => !i._deleted);
    saveData(); renderAll(); toast('Trash purged');
  }, 'Purge', true);
});

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
    data = { items: [], accounts: DEFAULT_ACCOUNTS, categories: DEFAULT_CATEGORIES };
    saveData(); setActiveAccount('Personal'); toast('App reset');
  }, 'Reset', true);
  setTimeout(() => {
    document.getElementById('modal-confirm').disabled = true;
    document.getElementById('modal-confirm').style.opacity = '0.4';
  }, 50);
});

document.getElementById('categories-btn').addEventListener('click', openCategorySettings);
document.getElementById('colours-btn').addEventListener('click', openAccountColourSettings);

// ═══ CATEGORY MANAGEMENT ═══
function openCategorySettings() {
  settingsPanelOverlay.classList.remove('open');
  openModal('Manage Categories', 'Add or remove global categories used for filing items.', ct => {
    function renderCatList() {
      ct.innerHTML = `
        <div id="cat-list-inner">
          ${data.categories.map((cat, idx) => {
            const s = getCatStyle(cat);
            return `<div class="settings-list-item">
              <div class="settings-list-left">
                <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${s.color};"></span>
                <span style="font-weight:600;">${escHtml(cat.charAt(0).toUpperCase() + cat.slice(1))}</span>
              </div>
              <span class="settings-rm" data-idx="${idx}">×</span>
            </div>`;
          }).join('')}
        </div>
        <div class="settings-add-row">
          <input class="settings-add-input" id="new-cat-input" placeholder="New category name" maxlength="30">
          <button class="settings-add-btn" id="add-cat-btn">+ Add</button>
        </div>`;
      ct.querySelectorAll('.settings-rm').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx);
          if (data.categories.length <= 1) { toast('Keep at least one category'); return; }
          data.categories.splice(idx, 1); saveData(); renderCatList();
        });
      });
      ct.querySelector('#add-cat-btn').addEventListener('click', () => {
        const val = ct.querySelector('#new-cat-input').value.trim().toLowerCase();
        if (!val) return;
        if (data.categories.includes(val)) { toast('Category already exists'); return; }
        data.categories.push(val); saveData(); renderCatList(); toast('Category added');
      });
      ct.querySelector('#new-cat-input').addEventListener('keydown', e => {
        if (e.key === 'Enter') ct.querySelector('#add-cat-btn').click();
      });
    }
    renderCatList();
  }, () => renderAll(), 'Done');
}

// ═══ ACCOUNT COLOUR MANAGEMENT ═══
function openAccountColourSettings() {
  settingsPanelOverlay.classList.remove('open');
  openModal('Account Colours', 'Tap the colour swatch to change any account colour.', ct => {
    function renderAccColours() {
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
          saveData(); renderAccountDropdown(); updateCaptureIndicator();
        });
      });
    }
    renderAccColours();
  }, () => renderAll(), 'Done');
}

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
    inp.addEventListener('input', () => {
      document.getElementById('swatch-' + inp.dataset.acc).style.background = inp.value;
    });
  });
  document.getElementById('colour-prompt-overlay').classList.add('open');
}

document.getElementById('colour-prompt-save').addEventListener('click', () => {
  document.querySelectorAll('#colour-prompt-list input[type="color"]').forEach(inp => {
    const acc = data.accounts.find(a => a.name === inp.dataset.acc);
    if (acc) acc.color = inp.value;
  });
  saveData(); renderAccountDropdown(); updateCaptureIndicator();
  document.getElementById('colour-prompt-overlay').classList.remove('open');
  toast('Account colours saved');
});

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
  const active  = data.items.filter(i => !i._deleted).length;
  const deleted = data.items.filter(i => i._deleted).length;
  let text = active + ' items';
  if (deleted > 0) text += ' · ' + deleted + ' in trash';
  const el = document.getElementById('stats-text');
  if (el) el.textContent = text;
  const purgeBtn = document.getElementById('purge-btn');
  if (purgeBtn) purgeBtn.classList.toggle('hidden', deleted === 0);
}

function formatTime(iso) {
  const d    = new Date(iso);
  const now  = new Date();
  const diff = now - d;
  if (diff < 60000)    return 'just now';
  if (diff < 3600000)  return Math.floor(diff / 60000) + 'm ago';
  if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
  if (diff < 172800000) return 'yesterday';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

function escHtml(s) {
  if (typeof s !== 'string') return '';
  const div = document.createElement('div'); div.textContent = s; return div.innerHTML;
}
function esc(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
function escTextarea(s) {
  if (typeof s !== 'string') return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ═══ SVG ICONS ═══
function trashSVG() {
  return `<svg viewBox="0 0 24 24"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>`;
}
function moveSVG() {
  // Folder with arrow — clearly indicates "move to account"
  return `<svg viewBox="0 0 24 24"><path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 10l-4-4 4-4v3h4v2h-4v3z"/></svg>`;
}

function renderAll() {
  if (currentView === 'review')  renderReview();
  if (currentView === 'browse')  renderBrowse();
  updateBadge(); updateStats();
}

// ═══ EMAIL DIGEST ═══
function buildDigestHtml() {
  const live = data.items.filter(i => !i._deleted);
  const accounts = data.accounts.filter(a => live.some(i => i.account === a.name));
  const styles = `body{font-family:Arial,sans-serif;font-size:14px;color:#111;background:#f5f5f5;padding:20px;}h1{font-size:20px;font-weight:700;margin-bottom:4px;color:#0033CC;}.meta{font-size:12px;color:#888;margin-bottom:24px;}h2{font-size:15px;font-weight:700;margin:24px 0 8px;padding-bottom:6px;border-bottom:2px solid currentColor;}h3{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:#888;margin:16px 0 6px;}table{width:100%;border-collapse:collapse;margin-bottom:12px;}th{text-align:left;font-size:11px;font-weight:700;text-transform:uppercase;color:#888;padding:6px 8px;border-bottom:1px solid #ddd;}td{padding:8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top;}tr:last-child td{border-bottom:none;}.badge{display:inline-block;padding:2px 6px;border-radius:3px;font-size:10px;font-weight:700;text-transform:uppercase;background:#eee;color:#555;margin-right:4px;}.urgent{color:#CC2200;font-weight:700;}.tag-urgent{background:#fde8e4;color:#CC2200;}.tag-inbox{background:#e8f0fe;color:#0033CC;}`;
  let html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>${styles}</style></head><body>`;
  html += `<h1>TrigPoint Digest</h1><p class="meta">Generated ${new Date().toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' })} · ${live.length} active item${live.length !== 1 ? 's' : ''}</p>`;
  accounts.forEach(acc => {
    const accItems = live.filter(i => i.account === acc.name);
    if (!accItems.length) return;
    const urgent = accItems.filter(i => i._urgent);
    const inbox  = accItems.filter(i => !i._urgent && i.status === 'inbox');
    const stored = accItems.filter(i => !i._urgent && i.status !== 'inbox');
    html += `<h2 style="color:${acc.color}">${acc.name} <span style="font-size:12px;font-weight:400;color:#888;">(${accItems.length})</span></h2>`;
    const renderTable = items => {
      if (!items.length) return '';
      return `<table><thead><tr><th>Item</th><th>Category</th><th>Added</th></tr></thead><tbody>` +
        items.map(i => {
          const cat = i.category ? i.category.charAt(0).toUpperCase() + i.category.slice(1) : '—';
          const date = new Date(i.createdAt).toLocaleDateString('en-GB', { day:'numeric', month:'short' });
          const urgentMark = i._urgent ? ' <span class="badge tag-urgent">Urgent</span>' : '';
          const inboxMark  = i.status === 'inbox' ? ' <span class="badge tag-inbox">Inbox</span>' : '';
          return `<tr><td class="${i._urgent ? 'urgent' : ''}">${i.text}${urgentMark}${inboxMark}</td><td><span class="badge">${cat}</span></td><td style="white-space:nowrap;color:#888;">${date}</td></tr>`;
        }).join('') + `</tbody></table>`;
    };
    if (urgent.length) html += `<h3>⚠ Urgent (${urgent.length})</h3>` + renderTable(urgent);
    if (inbox.length)  html += `<h3>Inbox — needs filing (${inbox.length})</h3>` + renderTable(inbox);
    if (stored.length) html += `<h3>Active items (${stored.length})</h3>` + renderTable(stored);
  });
  html += `</body></html>`;
  return html;
}

async function sendDigest() {
  if (!cloudUrl) { toast('No cloud URL configured — set it in Cloud settings'); return; }
  const html = buildDigestHtml();
  const live  = data.items.filter(i => !i._deleted);
  toast('Sending digest…');
  try {
    const res = await fetch(cloudUrl, {
      method: 'POST', redirect: 'follow',
      body: JSON.stringify({ key: cloudKey, action: 'digest', digestHtml: html, itemCount: live.length, generatedAt: new Date().toISOString() })
    });
    const result = JSON.parse(await res.text());
    toast(result.success ? 'Digest sent ✓' : 'Digest failed — check Apps Script');
  } catch (e) { console.error(e); toast('Digest send failed'); }
}

document.getElementById('digest-btn').addEventListener('click', () => {
  const live = data.items.filter(i => !i._deleted);
  const urgentCount = live.filter(i => i._urgent).length;
  openModal(
    'Send Digest Email',
    `Send a digest of all ${live.length} active item${live.length !== 1 ? 's' : ''} across all accounts${urgentCount ? ` (${urgentCount} urgent)` : ''}?`,
    null, sendDigest, 'Send'
  );
});

// ═══ INIT ═══
renderAccountDropdown();
updateCaptureIndicator();
renderAll();
if (window.innerWidth > 600) captureInput.focus();
setTimeout(checkColourPrompt, 500);
