# CLAUDE.md — TrigPoint Code Review Fixes

## Project context

TrigPoint is a single-file vanilla JS app (`index.html`) — a personal capture/review/retrieve tool, hosted as a static page (GitHub Pages, custom domain). Data lives in localStorage. Optional one-way sync POSTs the item list to a cloud endpoint (assumed to be a Google Apps Script web app) authenticated by a shared API key stored in config.

## Hard constraints — do not violate

- Keep it a **single HTML file**. No frameworks, no build step, no external JS dependencies.
- **Preserve localStorage compatibility.** Keys `trigpoint_db_v2`, `trigpoint_conf_v2`, `trigpoint_theme` and their existing data shapes must continue to load. If you must extend the conf shape, merge with `DEFAULT_CONF` defensively (this pattern already exists in `loadConf`).
- Do not redesign the UI, rename functions wholesale, or restructure the file. Make targeted fixes.
- Do not add analytics, CDN scripts, or any new network calls beyond the existing sync endpoint.

---

## Phase 1 — Security and data integrity (do this first, verify, then stop for review)

### 1.1 Escape all user-controlled values in rendered HTML
Currently only `item.text` is escaped. Apply the existing `escape()` helper to **every** interpolated value in `renderHeader`, `renderCard`, and `renderSettingsAccounts`: account names, categories, and any other string originating from user input or imported data.

### 1.2 Remove inline `onclick` string handlers
`onclick="setAccount('${acc.name}')"`, `setStatus('${item.id}',…)`, `delItem('${item.id}')`, and `removeAccount(${idx})` are injection points and break on quotes in names. Replace with:
- `data-` attributes on the elements (e.g. `data-account="…"`, `data-id="…"`, `data-action="file|delete"`), values escaped.
- Delegated `click` listeners on the stable parent containers (`#account-pills`, `#review-stack`, `#retrieve-stack`, `#settings-account-list`).
- Remove the corresponding `window.setAccount` / `window.setStatus` / `window.delItem` / `window.removeAccount` globals once nothing references them.

### 1.3 Stop exporting credentials
In the export handler, build a sanitised payload: `{ items: state.items, conf: { accounts: state.conf.accounts } }` — explicitly **excluding** `cloudUrl` and `apiKey`. On import, **preserve the device's existing `cloudUrl` and `apiKey`** regardless of what the file contains (ignore credentials in the file entirely).

### 1.4 Validate imports and fix import bugs
In the file-import handler:
- Guard against a cancelled picker: if `e.target.files[0]` is falsy, return.
- Reset `e.target.value = ''` after reading so the same file can be re-imported.
- Validate structure before applying: `Array.isArray(d.items)`; each item must have string `id`, string `text`, string `account`, string `category`, `status` in `['inbox','stored']`, numeric `created`. Coerce `_deleted` to boolean. Drop (don't crash on) malformed items; if everything is malformed, show an error toast and apply nothing.
- Validate `d.conf.accounts` is an array of `{name: string, color: string}`; sanitise `color` to match `/^#[0-9a-fA-F]{6}$/`, falling back to `#0033CC`.
- After a successful import, set `ui.activeAccount` to the first account in the imported config (or handle the empty case per 1.6).
- Replace the bare `alert("Invalid File")` with the existing toast mechanism.

### 1.5 Enforce HTTPS on the cloud URL
In the save-settings handler: if a non-empty `cloudUrl` is provided and it does not start with `https://`, reject the save with a toast explaining why, and do not persist. (Empty string remains valid — sync disabled.)

### 1.6 Make account management safe
- Prevent removing the **last** account (toast: at least one account required), OR handle the zero-account state gracefully throughout — pick the first option; it's simpler and matches `capture()`'s assumption.
- When the removed account is `ui.activeAccount`, reassign `ui.activeAccount` to the first remaining account and re-render header + lists.
- Fix the staged-vs-persisted inconsistency: account add/remove currently mutates `state.conf` immediately but only persists on Save. Change to **stage changes in a working copy** (clone `state.conf.accounts` when the modal opens), render the settings list from the working copy, and apply + `saveConf()` only when Save is clicked. Close without Save discards staged changes.
- Note: items belonging to a removed account remain in the DB (intentional — they're still in backups and reachable if the account is re-added with the same name). Do not delete items on account removal.

### 1.7 Make "Reset App" honest and complete
The confirm says "Delete ALL data" but only items are cleared. Change the handler to remove `trigpoint_db_v2` **and** `trigpoint_conf_v2` from localStorage (leave the theme), then `location.reload()`. Update the confirm message to: "Delete all items, accounts, and cloud settings. Cannot be undone."

### Phase 1 verification checklist
- Create an account named `O'Brien "Test" <b>` — header pill, cards, and settings list render the literal text; clicking the pill switches accounts; no console errors.
- Export a backup, open the JSON in a text editor: no `apiKey`, no `cloudUrl`.
- Import that backup on a "device" (fresh browser profile) that already has credentials configured: credentials survive.
- Import a deliberately mangled JSON file: app shows an error toast and state is unchanged.
- Cancel the file picker: no console error. Import the same file twice in a row: second import works.
- Try saving an `http://` cloud URL: rejected with explanation.
- Remove all accounts: blocked at the last one. Remove the active account: UI switches to a remaining account cleanly. Add an account then Close without Save: it's gone on reopen.
- Reset App, reload: accounts back to defaults, no stale API key in localStorage (check DevTools → Application → Local Storage).

**Stop after Phase 1 and report what was changed before proceeding.**

---

## Phase 2 — Correctness and robustness

### 2.1 Consistent inbox counting
`render()` skips the account filter for the inbox when `ui.currentView === 'capture'`, so the nav badge shows a different number depending on the active tab. Decide on one behaviour and apply it everywhere: **filter the Review list by active account, but make the nav badge always show the all-accounts inbox total** (so nothing gets forgotten in an inactive account). Add the per-account count to `#review-count` as e.g. `3 items (7 total)` when they differ.

### 2.2 Sync honesty and hardening
- Keep `mode: 'no-cors'` (required for Apps Script without CORS setup) but **remove the `Content-Type: application/json` header** — browsers drop or downgrade it in no-cors mode anyway. Send the body as-is; Apps Script reads `e.postData.contents` regardless. Add a one-line code comment explaining the no-cors opacity trade-off.
- Change the Force Sync toast to "Sync requested" — the response is opaque, success cannot be confirmed; do not imply it.
- Skip sync attempts when `navigator.onLine === false` (toast: "Offline — sync skipped").
- Continue sending soft-deleted items (they act as tombstones server-side) — add a comment stating this is intentional.

### 2.3 Storage error handling
Wrap the `localStorage.setItem` calls in `save()` and `saveConf()` in try/catch. On failure (quota), show a persistent-feeling toast like "Storage full — changes not saved" so data loss is never silent.

### 2.4 Retrieve truncation indicator
When the filtered DB result exceeds 50, append a footer element after the cards: "Showing 50 of N — refine your search."

### 2.5 Collision-resistant IDs
Change ID generation to `Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)`. Existing IDs remain valid; no migration needed.

### 2.6 Settings field types
Change `#conf-url` from `type="password"` to `type="url"` (it's not a secret and masking makes verification error-prone). Keep `#conf-key` as `type="password"`.

### Phase 2 verification checklist
- Badge count identical across all three tabs; Review header shows per-account vs total when they differ.
- With DevTools network throttled to Offline, Force Sync shows the offline toast and makes no request.
- Add 60+ stored items to one account: Retrieve shows the truncation footer with correct N.
- Capture two items rapidly: distinct IDs.

---

## Known limitations to leave alone (documented, not fixed)

- The API key necessarily lives in plaintext in localStorage — unavoidable in a static client-only app. Mitigation is server-side: the Apps Script endpoint should treat the key as low-privilege and validate it on every request.
- Sync is one-way (push only) with no pull/merge. Out of scope for this pass.
- No-cors means delivery is unconfirmed by design; the honest toast (2.2) is the accepted trade-off.
