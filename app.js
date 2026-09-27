(() => {
  'use strict';

  /* The data file sits next to this script on GitHub Pages. publish-github.mjs rebuilds it after
     every work session and seals the private sections into privateVault before committing,
     because the repository is public. */
  const DATA_URL = './worklog.json';

  /* Access log endpoint: a Google Apps Script web app in front of a Sheet in TASHA's Drive,
     deliberately not anything on noah@dragonauto.net's GCP project, where the dashboard's data
     used to be served and where he could read or delete the record of his own visits.

     Writes are unauthenticated because his browser has to be able to post a row without
     holding a credential worth stealing. Reading needs `auditKey`, which travels only inside
     the encrypted privateVault, so knowing this URL tells him nothing.

     The dashboard only writes here; Tasha reads the rows in the Sheet itself. Empty string
     means "not connected": every beacon becomes a no-op. Paste the /exec URL from
     Deploy -> New deployment -> Web app. */
  const AUDIT_URL = 'https://script.google.com/macros/s/AKfycbxSKl6dpE5Oxv1Fe-iE-TsJz4ch1RtAPhqjIrZaHqMDiTNxv9f4g41g2rUw5Kxz_-Ff/exec';
  const CACHE_KEY = 'wvd-lastgood-v1';
  const $ = (id) => document.getElementById(id);
  const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icons = {
    shipped: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>',
    fixed: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m14.7 6.3 3-3a5 5 0 0 1-6.4 6.4l-6.6 6.6a2.1 2.1 0 0 0 3 3l6.6-6.6a5 5 0 0 0 6.4-6.4l-3 3-3-3Z"/></svg>',
    note: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3h8l4 4v13a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z"/><path d="M9 12h6M9 16h6M9 8h3"/></svg>',
    info: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/></svg>'
  };

  function lsGet(key) { try { return window.localStorage.getItem(key); } catch (error) { return null; } }
  function lsSet(key, value) { try { window.localStorage.setItem(key, value); } catch (error) { /* Private mode can block storage. */ } }
  function fmtDate(value) {
    if (!value) return '';
    const date = new Date(value.length === 10 ? value + 'T12:00:00' : value);
    if (isNaN(date)) return esc(value);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmtWeekday(value) {
    if (!value) return '';
    const date = new Date(value.length === 10 ? value + 'T12:00:00' : value);
    if (isNaN(date)) return '';
    return date.toLocaleDateString('en-US', { weekday: 'short' });
  }
  function fmtDateTime(value) {
    const date = new Date(value);
    if (isNaN(date)) return esc(value);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ', ' + date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }
  function daysSince(value) {
    if (!value) return null;
    const date = new Date(value.length === 10 ? value + 'T12:00:00' : value);
    if (isNaN(date)) return null;
    return Math.max(0, Math.floor((Date.now() - date.getTime()) / 86400000));
  }
  function agoLabel(value) {
    const days = daysSince(value);
    if (days === null) return '';
    if (days === 0) return 'today';
    if (days === 1) return '1 day ago';
    return days + ' days ago';
  }
  function toast(message, kind) {
    const element = document.createElement('div');
    element.className = 'wvd-toast' + (kind ? ' wvd-' + kind : '');
    element.textContent = message;
    $('wvdToastWrap').appendChild(element);
    setTimeout(() => element.remove(), 5000);
  }
  /* A waiting card's `commands` is meant to be [{label, code}], but a hand-written entry can
     arrive as a bare command string or a list of strings. The old renderer took the strict
     Array.isArray path and dropped anything else to [], so on 2026-07-29 a card whose step read
     "run the block below" showed no block at all — the one failure mode a paste-block handoff
     cannot survive. Normalise instead of discarding; a wrong shape now renders, it never vanishes. */
  function normaliseCommands(value) {
    if (!value) return [];
    const list = Array.isArray(value) ? value : [value];
    return list.map((entry) => {
      if (typeof entry === 'string') return { label: 'Copy and paste', code: entry };
      if (entry && typeof entry === 'object') return { label: entry.label || 'Copy and paste', code: String(entry.code || '') };
      return null;
    }).filter((entry) => entry && entry.code);
  }

  let data = null;
  let projectFilter = 'all';
  /* The page every visit opens on, and where a sign-out lands. */
  const HOME_PAGE = 'latest';
  let currentPage = HOME_PAGE;
  let sessionsPage = 1;
  let nlogDayMode = 'default';
  const SESSIONS_PER_PAGE = 10;
  const commandRegistry = [];
  /* ==================== SIGN-IN + PRIVATE VAULT ====================
     Growth Path and Noah's Log never travel as plaintext. They ride inside `privateVault`,
     AES-256-GCM ciphertext whose key is derived from Tasha's passphrase, because the file
     serving this data lives in a public GitHub repository (before 2026-09-27 it was a Cloud
     Function on noah@dragonauto.net's GCP project). Hiding the pages in the UI alone would
     leave the content readable in the raw file.

     Noah's password guards no secret (his view has nothing private in it), so a SHA-256
     compare is enough. Set permanently by Tasha on 2026-07-26. To rotate it, replace the
     constant below with the output of:
       node -e "console.log(require('crypto').createHash('sha256').update('NEWPASS').digest('hex'))" */
  const NOAH_PASS_HASH = 'b9851f7d66b13dfed3662eb555c2afe78c99131bcf2932be7e7d9dfd7cce9932';

  const ROLE_SESSION = 'wvd-role';
  const VAULT_KEY_SESSION = 'wvd-vault-key';
  const VAULT_SALT_SESSION = 'wvd-vault-salt';
  const PRIVATE_FIELDS = ['growthPath', 'noahLog', 'auditKey'];
  const TASHA_ONLY_PAGES = { noahlog: true };

  let role = null;          // 'noah' | 'tasha' | null before sign-in
  let vaultRawKey = null;   // Uint8Array, only ever set for Tasha
  let privateData = null;   // decrypted { growthPath, noahLog }
  let pendingRole = null;   // which tile is selected on the sign-in screen
  let createMode = false;   // first-time (or start-fresh) passphrase creation
  let vaultSalt = null;     // b64 salt matching vaultRawKey

  let dataReadyResolve = null;
  const dataReady = new Promise((resolve) => { dataReadyResolve = resolve; });

/* VAULT-CRYPTO-BEGIN
   Mirrored from scripts/lib/vault-crypto.mjs. Both copies must agree or Tasha's passphrase
   stops opening her own data. scripts/verify-vault-roundtrip.mjs extracts this exact block
   and round-trips it against the Node library to prove they still match. */
  function bytesToB64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }
  function b64ToBytes(text) {
    const binary = atob(String(text));
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  }
  function normalizePassphrase(passphrase) {
    return String(passphrase == null ? '' : passphrase).normalize('NFKC').trim();
  }
  async function vaultDeriveRawKey(passphrase, saltBytes, iterations) {
    const encoded = new TextEncoder().encode(normalizePassphrase(passphrase));
    const base = await crypto.subtle.importKey('raw', encoded, 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: saltBytes, iterations: iterations, hash: 'SHA-256' }, base, 256);
    return new Uint8Array(bits);
  }
  async function vaultImportKey(rawKeyBytes) {
    return crypto.subtle.importKey('raw', rawKeyBytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }
  async function vaultDecrypt(rawKeyBytes, vault) {
    if (!vault || typeof vault !== 'object') throw new Error('no vault');
    if (vault.v !== 1) throw new Error('unsupported vault version');
    const key = await vaultImportKey(rawKeyBytes);
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(vault.iv) }, key, b64ToBytes(vault.data));
    return JSON.parse(new TextDecoder().decode(plaintext));
  }
  async function vaultDecryptWithPassphrase(passphrase, vault) {
    const rawKey = await vaultDeriveRawKey(passphrase, b64ToBytes(vault.salt), vault.iter || 600000);
    return vaultDecrypt(rawKey, vault);
  }
  async function vaultEncrypt(rawKeyBytes, saltB64, iterations, plainObject) {
    const key = await vaultImportKey(rawKeyBytes);
    const iv = new Uint8Array(12);
    crypto.getRandomValues(iv);
    const plaintext = new TextEncoder().encode(JSON.stringify(plainObject));
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plaintext);
    return { v: 1, kdf: 'PBKDF2-SHA256', iter: iterations, salt: saltB64, iv: bytesToB64(iv), data: bytesToB64(new Uint8Array(ciphertext)) };
  }
/* VAULT-CRYPTO-END */

  function sessionGet(key) {
    try { return window.sessionStorage.getItem(key); } catch (error) { return null; }
  }
  function sessionSet(key, value) {
    try { window.sessionStorage.setItem(key, value); } catch (error) { /* Private mode can block storage. */ }
  }
  function sessionDrop(key) {
    try { window.sessionStorage.removeItem(key); } catch (error) { /* Private mode can block storage. */ }
  }
  function isTasha() { return role === 'tasha'; }

  // Any browser that opened this dashboard before the sections were encrypted still holds a
  // plaintext copy in localStorage. Drop it on sight so old data cannot outlive the change.
  function purgeLegacyPlaintextCache() {
    const cached = lsGet(CACHE_KEY);
    if (!cached) return;
    try {
      const parsed = JSON.parse(cached);
      if (PRIVATE_FIELDS.some((field) => parsed && parsed[field] !== undefined)) {
        try { window.localStorage.removeItem(CACHE_KEY); } catch (error) { /* nothing else to do */ }
      }
    } catch (error) { /* an unparseable cache gets replaced by the next load anyway */ }
  }

  // Called after every fetch: the vault may have been republished since sign-in, so Noah's
  // Log stays current for Tasha without her retyping anything.
  async function refreshPrivateData() {
    if (!isTasha() || !vaultRawKey || !data || !data.privateVault) return;
    try {
      privateData = await vaultDecrypt(vaultRawKey, data.privateVault);
    } catch (error) {
      privateData = null;
      toast('Your private sections could not be opened. The passphrase may have changed since they were published.', 'err');
    }
  }

  // Single place that decides whether `data` carries the private sections. Deleting first
  // means a stale section can never survive a sign-out or a role switch.
  function mergePrivateIntoData() {
    if (!data) return;
    PRIVATE_FIELDS.forEach((field) => { delete data[field]; });
    if (!isTasha() || !privateData) return;
    PRIVATE_FIELDS.forEach((field) => {
      if (privateData[field] !== undefined) data[field] = privateData[field];
    });
  }

  function applyRoleVisibility() {
    const tasha = isTasha();
    document.querySelectorAll('[data-wvd-tasha-only]').forEach((element) => {
      element.style.display = tasha ? '' : 'none';
    });

    const chip = $('wvdUserChip');
    if (chip) {
      const nameEl = $('wvdUserName');
      const roleEl = $('wvdUserRole');
      const avatarEl = $('wvdUserAvatar');
      if (nameEl) nameEl.textContent = tasha ? 'Tasha' : 'Noah';
      // Noah's chip carries his name only: Tasha cut the role line under it, same call she
      // made on the sign-in tiles. Hidden as well as blanked so the chip keeps its vertical
      // centre instead of leaving an empty 12.5px row.
      if (roleEl) {
        roleEl.textContent = tasha ? 'Operations' : '';
        roleEl.style.display = tasha ? '' : 'none';
      }
      if (avatarEl) avatarEl.textContent = tasha ? 'TN' : 'NS';
      chip.setAttribute('aria-label', 'Signed in as ' + (tasha ? 'Tasha' : 'Noah'));
    }

    const signOutBtn = $('wvdSignOut');
    if (signOutBtn) signOutBtn.hidden = !role;

    if (!tasha && TASHA_ONLY_PAGES[currentPage]) goToPage(HOME_PAGE);
  }

  function showLoginOverlay() {
    const overlay = $('wvdLoginOverlay');
    if (!overlay) return;
    pendingRole = null;
    createMode = false;
    const resetLink = $('wvdLoginReset');
    if (resetLink) resetLink.hidden = true;
    const copyEl = document.querySelector('.wvd-login-copy');
    if (copyEl) copyEl.textContent = 'Pick your name, then enter your password.';
    ['wvdLoginAsNoah', 'wvdLoginAsTasha'].forEach((id) => {
      const button = $(id);
      if (button) button.setAttribute('aria-pressed', 'false');
    });
    const passInput = $('wvdLoginPass');
    if (passInput) { passInput.value = ''; passInput.disabled = true; passInput.placeholder = 'Pick a name first'; }
    const submit = $('wvdLoginSubmit');
    if (submit) { submit.disabled = true; submit.textContent = 'Sign in'; }
    const errorEl = $('wvdLoginError');
    if (errorEl) errorEl.textContent = '';
    overlay.hidden = false;
    setLock(true);
  }

  function hideLoginOverlay() {
    const overlay = $('wvdLoginOverlay');
    if (overlay) overlay.hidden = true;
    setLock(false);
  }

  // First time in (no vault published yet, or after "start fresh"), picking Tasha becomes
  // creating the passphrase rather than entering one. Everything else stays one field.
  function enterCreateMode(isRestart) {
    createMode = true;
    const copyEl = document.querySelector('.wvd-login-copy');
    if (copyEl) {
      copyEl.textContent = isRestart
        ? 'This replaces your passphrase in this browser only. Noah’s Log stays empty until the vault is sealed again with it (npm run vault:setup on your Mac).'
        : 'First time set-up: create your passphrase. It becomes the key to your private pages, so make it long. Four unrelated words work well.';
    }
    const submit = $('wvdLoginSubmit');
    if (submit) submit.textContent = 'Create and sign in';
    const resetLink = $('wvdLoginReset');
    if (resetLink) resetLink.hidden = true;
    const passInput = $('wvdLoginPass');
    if (passInput) { passInput.placeholder = 'New passphrase'; passInput.focus(); }
  }

  function setLoginRole(next) {
    pendingRole = next;
    createMode = false;
    const noahBtn = $('wvdLoginAsNoah');
    const tashaBtn = $('wvdLoginAsTasha');
    if (noahBtn) noahBtn.setAttribute('aria-pressed', String(next === 'noah'));
    if (tashaBtn) tashaBtn.setAttribute('aria-pressed', String(next === 'tasha'));
    const errorEl = $('wvdLoginError');
    if (errorEl) errorEl.textContent = '';
    const copyEl = document.querySelector('.wvd-login-copy');
    if (copyEl) copyEl.textContent = 'Pick your name, then enter your password.';
    const submit = $('wvdLoginSubmit');
    if (submit) { submit.disabled = false; submit.textContent = 'Sign in'; }
    const resetLink = $('wvdLoginReset');
    if (resetLink) resetLink.hidden = !(next === 'tasha' && data && data.privateVault);
    const passInput = $('wvdLoginPass');
    if (passInput) {
      passInput.disabled = false;
      passInput.value = '';
      passInput.placeholder = next === 'tasha' ? 'Your passphrase' : 'Password';
      passInput.focus();
    }
    if (next === 'tasha' && data && !data.privateVault) enterCreateMode(false);
  }

  async function finishLogin(nextRole, rawKey, decrypted) {
    role = nextRole;
    vaultRawKey = rawKey;
    privateData = decrypted;
    sessionSet(ROLE_SESSION, nextRole);
    if (rawKey) sessionSet(VAULT_KEY_SESSION, bytesToB64(rawKey));
    else sessionDrop(VAULT_KEY_SESSION);
    if (vaultSalt) sessionSet(VAULT_SALT_SESSION, vaultSalt);
    else sessionDrop(VAULT_SALT_SESSION);
    const passInput = $('wvdLoginPass');
    if (passInput) passInput.value = '';
    hideLoginOverlay();
    applyRoleVisibility();
    mergePrivateIntoData();
    logAccess('signin');
    if (data) render();
  }

  async function handleLoginSubmit() {
    const errorEl = $('wvdLoginError');
    const submit = $('wvdLoginSubmit');
    const passInput = $('wvdLoginPass');
    if (!errorEl || !submit || !passInput) return;
    errorEl.textContent = '';
    if (!pendingRole) { errorEl.textContent = 'Pick Noah or Tasha first.'; return; }
    const entered = passInput.value;
    if (!entered) { errorEl.textContent = 'Enter your password.'; return; }

    submit.disabled = true;
    try {
      if (pendingRole === 'noah') {
        if (!NOAH_PASS_HASH) {
          errorEl.textContent = 'This sign-in is not finished being set up yet. Ask Tasha to run the setup step.';
          return;
        }
        submit.textContent = 'Checking';
        const hash = await sha256Hex(normalizePassphrase(entered));
        if (hash !== NOAH_PASS_HASH) {
          logAccess('wrong-password', { role: 'noah' });
          errorEl.textContent = 'That password does not match. Try again.';
          return;
        }
        await finishLogin('noah', null, null);
        return;
      }

      // Tasha's passphrase IS the decryption key, so a correct password and a successful
      // decrypt are the same event. That needs the payload, which may still be in flight.
      submit.textContent = 'Unlocking';
      if (!data) {
        errorEl.textContent = 'Connecting to the work record, one moment.';
        await Promise.race([dataReady, new Promise((resolve) => setTimeout(resolve, 15000))]);
        errorEl.textContent = '';
      }
      if (!data) {
        errorEl.textContent = 'Could not reach the work record. Check the connection and try again.';
        return;
      }
      if (!data.privateVault && !createMode) { enterCreateMode(false); return; }

      if (createMode) {
        // Creating, not unlocking: mint a fresh salt + key in memory. Nothing is stored
        // anywhere; a vault sealed under it goes live once vault:setup stores the matching key on her Mac.
        const normalized = normalizePassphrase(entered);
        if (normalized.length < 6) {
          errorEl.textContent = 'Use at least 6 characters.';
          return;
        }
        submit.textContent = 'Creating';
        await new Promise((resolve) => setTimeout(resolve, 20));
        const saltBytes = new Uint8Array(16);
        crypto.getRandomValues(saltBytes);
        const rawKey = await vaultDeriveRawKey(normalized, saltBytes, 600000);
        vaultSalt = bytesToB64(saltBytes);
        await finishLogin('tasha', rawKey, null);
        return;
      }

      // Let the "Unlocking" label paint before the key derivation blocks the main thread.
      await new Promise((resolve) => setTimeout(resolve, 20));
      let rawKey = null;
      let decrypted = null;
      try {
        rawKey = await vaultDeriveRawKey(entered, b64ToBytes(data.privateVault.salt), data.privateVault.iter || 600000);
        decrypted = await vaultDecrypt(rawKey, data.privateVault);
      } catch (error) {
        logAccess('wrong-password', { role: 'tasha' });
        errorEl.textContent = 'That passphrase did not open your private sections. Check it and try again.';
        return;
      }
      vaultSalt = data.privateVault.salt;
      await finishLogin('tasha', rawKey, decrypted);
    } finally {
      if (!createMode) submit.textContent = 'Sign in';
      submit.disabled = false;
    }
  }

  function signOut() {
    logAccess('signout');
    role = null;
    vaultRawKey = null;
    privateData = null;
    vaultSalt = null;
    sessionDrop(ROLE_SESSION);
    sessionDrop(VAULT_KEY_SESSION);
    sessionDrop(VAULT_SALT_SESSION);
    mergePrivateIntoData();
    const noahLogTarget = $('wvdNoahLogBody');
    if (noahLogTarget) noahLogTarget.innerHTML = '';
    /* The visit identity has to end with the visit. Left in place, the next sign-in in this tab
       reused the same session id, so the log folded two people into one visit and kept the
       FIRST one's role: Tasha signs out, Noah signs in, and the log calls his visit hers. The
       page-seen map has to go too, or his page opens are silently dropped as already-logged. */
    auditSessionId = '';
    sessionDrop(AUDIT_SESSION_KEY);
    Object.keys(auditPagesSeen).forEach((key) => { delete auditPagesSeen[key]; });
    // Reset to the home page directly: showPage() would early-return when already there.
    currentPage = HOME_PAGE;
    Object.keys(PAGE_IDS).forEach((key) => {
      const page = $(PAGE_IDS[key]);
      if (page) page.hidden = key !== HOME_PAGE;
    });
    markNavActive(HOME_PAGE);
    applyRoleVisibility();
    showLoginOverlay();
  }

  // Synchronous on purpose: the role must be known before load() decides whether to decrypt.
  function initAuth() {
    const storedRole = sessionGet(ROLE_SESSION);
    if (storedRole === 'noah') {
      role = 'noah';
      applyRoleVisibility();
      hideLoginOverlay();
      logAccess('resume');
      return;
    }
    if (storedRole === 'tasha') {
      const storedKey = sessionGet(VAULT_KEY_SESSION);
      if (storedKey) {
        try {
          vaultRawKey = b64ToBytes(storedKey);
          vaultSalt = sessionGet(VAULT_SALT_SESSION);
          role = 'tasha';
          applyRoleVisibility();
          hideLoginOverlay();
          logAccess('resume');
          return;
        } catch (error) { /* a corrupt stored key just means signing in again */ }
      }
    }
    applyRoleVisibility();
    showLoginOverlay();
  }

  const PAGE_IDS = {
    latest: 'wvdLatestPage',
    waiting: 'wvdWaitingPage',
    systems: 'wvdSystemsPage',
    pipeline: 'wvdPipelinePage',
    sessions: 'wvdSessionsPage',
    noahlog: 'wvdNoahLogPage'
  };

  function showPage(name) {
    if (!(name in PAGE_IDS) || name === currentPage) return;
    // Hard stop: a private page must never open for Noah, whatever calls this.
    if (TASHA_ONLY_PAGES[name] && !isTasha()) return;
    currentPage = name;
    if (!auditPagesSeen[name]) {
      auditPagesSeen[name] = true;
      logAccess('page', { page: name });
    }
    Object.keys(PAGE_IDS).forEach((key) => {
      const page = $(PAGE_IDS[key]);
      if (page) page.hidden = key !== name;
    });
    window.scrollTo(0, 0);
    const contentEl = $('wvdContent');
    if (contentEl) contentEl.scrollTop = 0;
  }

  function copyCommand(button) {
    const code = commandRegistry[Number(button.getAttribute('data-wvd-copy'))];
    if (code == null) return;
    const done = () => {
      button.classList.add('wvd-copied');
      button.textContent = 'Copied';
      setTimeout(() => { button.classList.remove('wvd-copied'); button.textContent = 'Copy'; }, 2000);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => fallbackCopy(code, done));
    } else {
      fallbackCopy(code, done);
    }
  }
  function fallbackCopy(text, done) {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'absolute';
    area.style.left = '-9999px';
    document.getElementById('wvd-root').appendChild(area);
    area.select();
    try { document.execCommand('copy'); done(); } catch (error) { toast('Copy failed. Select the text manually.', 'err'); }
    area.remove();
  }

  function latestGroup(className, label, items) {
    const list = items && items.length ? '<ul>' + items.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>' : '<p class="wvd-none">Nothing logged in this category.</p>';
    return '<div class="wvd-latest-group ' + className + '"><div class="wvd-group-label">' + label + '</div>' + list + '</div>';
  }
  function sessionCount(session) {
    return (session.shipped || []).length + (session.fixed || []).length;
  }
  function groupSessionsByDate(sessionList) {
    const groups = [];
    const byDate = new Map();
    sessionList.forEach((session) => {
      const key = String(session.date);
      if (!byDate.has(key)) {
        const group = { date: key, sessions: [] };
        byDate.set(key, group);
        groups.push(group);
      }
      byDate.get(key).sessions.push(session);
    });
    return groups;
  }
  function outcomeCards(className, iconSvg, items) {
    if (!items || !items.length) return '';
    return items.map((item) => '<div class="wvd-outcome-card ' + className + '"><span class="wvd-outcome-icon">' + iconSvg + '</span><p class="wvd-outcome-text">' + esc(item) + '</p></div>').join('');
  }
  function dayEntryHtml(session) {
    const shippedItems = session.shipped || [];
    const fixedItems = session.fixed || [];
    const progressItems = session.inProgress || [];
    const hasNotes = Boolean(session.notes);
    const completedCount = shippedItems.length + fixedItems.length;

    const chips = [];
    if (shippedItems.length) chips.push('<span class="wvd-breakdown-chip"><span class="wvd-chip-dot wvd-shipped-dot"></span>' + shippedItems.length + ' shipped</span>');
    if (fixedItems.length) chips.push('<span class="wvd-breakdown-chip"><span class="wvd-chip-dot wvd-fixed-dot"></span>' + fixedItems.length + ' fixed</span>');
    if (progressItems.length) chips.push('<span class="wvd-breakdown-chip"><span class="wvd-chip-dot wvd-progress-dot"></span>' + progressItems.length + ' in progress</span>');
    if (hasNotes) chips.push('<span class="wvd-breakdown-chip wvd-context-chip">' + icons.note + 'Context</span>');

    let completedLabel = '';
    if (shippedItems.length && fixedItems.length) completedLabel = 'Shipped &amp; fixed (' + completedCount + ')';
    else if (fixedItems.length) completedLabel = 'Fixed (' + fixedItems.length + ')';
    else if (shippedItems.length) completedLabel = 'Shipped (' + shippedItems.length + ')';

    const rightHeaderLabel = progressItems.length ? 'In progress (' + progressItems.length + ')' : (hasNotes ? 'Context' : '');
    const leftHtml = outcomeCards('wvd-shipped', icons.shipped, shippedItems) + outcomeCards('wvd-fixed', icons.fixed, fixedItems);
    const rightHtml = outcomeCards('wvd-progress', '<span class="wvd-outcome-dot"></span>', progressItems) +
      (hasNotes ? '<div class="wvd-context-card"><div class="wvd-context-label">' + icons.note + 'Context</div><p class="wvd-context-text">' + esc(session.notes) + '</p></div>' : '');

    const hasLeft = Boolean(completedLabel);
    const hasRight = Boolean(rightHeaderLabel);
    const soloColumn = (hasLeft && !hasRight) || (hasRight && !hasLeft) ? ' wvd-breakdown-col-full' : '';

    return '<article class="wvd-day-entry"><h4 class="wvd-day-entry-title">' + esc(session.title) + '</h4>' +
      (chips.length ? '<div class="wvd-breakdown-head"><span class="wvd-breakdown-label">Session breakdown</span><div class="wvd-breakdown-chips">' + chips.join('') + '</div></div>' : '') +
      (hasLeft || hasRight
        ? '<div class="wvd-breakdown-grid">' +
          (hasLeft ? '<div class="wvd-breakdown-col' + soloColumn + '"><div class="wvd-breakdown-col-head wvd-t-green">' + completedLabel + '</div>' + leftHtml + '</div>' : '') +
          (hasRight ? '<div class="wvd-breakdown-col' + soloColumn + '"><div class="wvd-breakdown-col-head wvd-t-blue">' + rightHeaderLabel + '</div>' + rightHtml + '</div>' : '') +
          '</div>'
        : '<p class="wvd-none" style="padding:0 16px 16px;">Nothing logged in this session.</p>') +
      '</article>';
  }

  function paginationHtml(current, total) {
    if (total <= 1) return '';
    const numbers = [];
    for (let p = 1; p <= total; p += 1) {
      numbers.push('<button type="button" class="wvd-page-btn' + (p === current ? ' wvd-active' : '') + '" data-wvd-page-num="' + p + '"' + (p === current ? ' aria-current="page"' : '') + '>' + p + '</button>');
    }
    return '<div class="wvd-pagination">' +
      '<button type="button" class="wvd-page-nav" data-wvd-page-nav="prev"' + (current <= 1 ? ' disabled' : '') + '>Previous</button>' +
      '<div class="wvd-page-numbers">' + numbers.join('') + '</div>' +
      '<button type="button" class="wvd-page-nav" data-wvd-page-nav="next"' + (current >= total ? ' disabled' : '') + '>Next</button>' +
      '</div>';
  }

  // ---- Noah's Log page (mockup redesign 2026-07-21) ----
  // The Recent Highlights card grid was removed 2026-08-04 per Tasha: the Full
  // Daily Log timeline is the whole page now. noahLog.highlights still travels
  // in the worklog (the builder preserves it verbatim) but nothing renders it.
  // Renders from real data only: days [{date,count,entries:[{title,headline}]}]
  // pulled from Noah's Obsidian notes. No fabricated per-line timestamps or tags.
  // The feed carries a rolling 3-day window (build-noah-log.mjs DEFAULT_MAX_DAYS), so there is
  // no range control: every filter it could offer would return the same three days.

  // Display-only cleanup of Noah's verbatim markdown (escape first, then de-noise links/bold/code).
  function nlogPretty(raw) {
    return esc(String(raw == null ? '' : raw))
      .replace(/\[\[[^\]|]*\|([^\]]+)\]\]/g, '$1')
      .replace(/\[\[([^\]]+)\]\]/g, function (m, p) { return String(p).split('/').pop(); })
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1');
  }
  function nlogNum(n) { return Number(n || 0).toLocaleString('en-US'); }
  function nlogEntryCount(day) { return typeof day.count === 'number' ? day.count : (Array.isArray(day.entries) ? day.entries.length : 0); }
  function nlogDate(dateStr) {
    if (!dateStr) return null;
    const d = new Date(String(dateStr).length === 10 ? dateStr + 'T12:00:00' : dateStr);
    return isNaN(d) ? null : d;
  }
  function nlogInThisMonth(dateStr) {
    const d = nlogDate(dateStr);
    if (!d) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }

  /* note.kind -> the pill it earns. The kinds come from Noah's own callout rule, which
     build-noah-log.mjs maps in CALLOUT_KIND: important = decision, tip/success = win,
     warning/danger/bug = blocker, question = open item, todo = next. Anything unrecognised
     renders as a plain note rather than disappearing. */
  const NLOG_KINDS = {
    blocker: 'Blocker', open: 'Needs a call', decision: 'Decision',
    win: 'Shipped', next: 'Next', note: 'Note'
  };
  function nlogNoteHtml(note) {
    const n = note && typeof note === 'object' ? note : {};
    const label = String(n.label == null ? '' : n.label).trim();
    const text = String(n.text == null ? '' : n.text).trim();
    if (!label && !text) return '';
    const kind = NLOG_KINDS[n.kind] ? n.kind : 'note';
    return '<li class="wvd-nlog-note wvd-nlog-note-' + kind + '">' +
      '<span class="wvd-nlog-pill">' + esc(NLOG_KINDS[kind]) + '</span>' +
      '<span class="wvd-nlog-note-body">' +
      (label ? '<strong class="wvd-nlog-note-label">' + nlogPretty(label) + '</strong>' : '') +
      (text ? '<span class="wvd-nlog-note-text">' + nlogPretty(text) + '</span>' : '') +
      '</span></li>';
  }
  /* One session. Renders everything the builder extracted, not just the title: a title-only
     render is how a whole day of Noah's writing came out as the single word "Work log" for six
     days running (2026-08-20 to 2026-08-26). If the feed ever collapses again, the headline,
     the callout items, and the sub-titles are all still on screen to say so. */
  function nlogLineHtml(entry) {
    const e = typeof entry === 'string' ? { title: entry } : (entry && typeof entry === 'object' ? entry : {});
    if (!e.title) return '';
    const notes = (Array.isArray(e.notes) ? e.notes.map(nlogNoteHtml).join('') : '');
    const subs = (Array.isArray(e.subsections) ? e.subsections : [])
      .map(function (sub) { return nlogPretty(typeof sub === 'string' ? sub : (sub && sub.title) || ''); })
      .filter(function (sub) { return !!sub; });
    // The builder caps notes per session and counts what it dropped; say the number rather
    // than letting a trimmed session read as a complete one.
    const more = Number(e.notesMore || 0);
    return '<div class="wvd-nlog-line wvd-nlog-sess">' +
      '<span class="wvd-nlog-line-dot"></span>' +
      '<div class="wvd-nlog-line-text">' +
      '<div class="wvd-nlog-sess-title">' + nlogPretty(e.title) + '</div>' +
      (e.headline ? '<p class="wvd-nlog-sess-headline">' + nlogPretty(e.headline) + '</p>' : '') +
      (notes ? '<ul class="wvd-nlog-notes">' + notes + '</ul>' : '') +
      (more > 0 ? '<p class="wvd-nlog-more">+' + more + ' more ' + (more === 1 ? 'item' : 'items') + ' in Noah\'s note</p>' : '') +
      (subs.length ? '<div class="wvd-nlog-subs"><span class="wvd-nlog-subs-label">Also under this</span><ul><li>' +
        subs.join('</li><li>') + '</li></ul></div>' : '') +
      '</div></div>';
  }
  function nlogReflectionHtml(reflection) {
    const r = reflection && typeof reflection === 'object' ? reflection : null;
    if (!r) return '';
    const sections = (Array.isArray(r.sections) ? r.sections : []).filter(function (sec) {
      return sec && (sec.heading || sec.text);
    });
    const hasEnergy = typeof r.energy === 'number';
    if (!sections.length && !hasEnergy) return '';
    return '<div class="wvd-nlog-refl">' +
      '<div class="wvd-nlog-refl-top">' + icons.note +
      '<span class="wvd-nlog-refl-title">Evening reflection</span>' +
      (hasEnergy ? '<span class="wvd-nlog-refl-energy">Energy ' + r.energy + ' / 10</span>' : '') +
      '</div>' +
      sections.map(function (sec) {
        return '<div class="wvd-nlog-refl-sec">' +
          (sec.heading ? '<div class="wvd-nlog-refl-head">' + nlogPretty(sec.heading) + '</div>' : '') +
          (sec.text ? '<div class="wvd-nlog-refl-text">' + nlogPretty(sec.text) + '</div>' : '') +
          '</div>';
      }).join('') +
      '</div>';
  }
  function nlogTimelineDay(day, isOpen) {
    const entries = Array.isArray(day.entries) ? day.entries : [];
    const count = nlogEntryCount(day);
    const isToday = daysSince(day.date) === 0;
    const first = entries.length ? entries[0] : null;
    const teaser = first ? (typeof first === 'string' ? first : (first.title || '')) : '';
    const badge = isToday ? '<span class="wvd-nlog-today-badge">Today</span>' : '';
    const lines = entries.map(nlogLineHtml).join('') + nlogReflectionHtml(day.reflection);
    return '<details class="wvd-session"' + (isOpen ? ' open' : '') + '><summary>' +
      '<span class="wvd-session-node' + (isToday ? ' wvd-today' : '') + '"></span>' +
      '<span class="wvd-session-date"><span class="wvd-session-weekday">' + esc(fmtWeekday(day.date)) + '</span>' + esc(fmtDate(day.date)) + '</span>' +
      '<span class="wvd-session-title">' + nlogPretty(teaser) + '</span>' +
      '<span class="wvd-session-meta">' + badge + '<span class="wvd-outcomes">' + count + ' ' + (count === 1 ? 'outcome' : 'outcomes') + '</span><span class="wvd-when">' + esc(agoLabel(day.date)) + '</span></span>' +
      '<svg class="wvd-session-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>' +
      '</summary><div class="wvd-session-day-body"><div class="wvd-nlog-day-lines">' + lines + '</div></div></details>';
  }
  function buildNoahLogHtml(noahLog) {
    const nl = noahLog && typeof noahLog === 'object' ? noahLog : {};
    const allDays = Array.isArray(nl.days) ? nl.days.filter(function (d) { return d && d.date && Array.isArray(d.entries) && d.entries.length; }) : [];
    const caption = nl.caption || "Data is pulled from Noah's daily docs.";

    if (!allDays.length) {
      return '<section class="wvd-section wvd-anchor" id="wvd-noahlog-panel"><p class="wvd-none" style="padding:22px 2px;">No daily-note activity has been published yet. Run <strong>node scripts/build-noah-log.mjs</strong>, then publish the worklog.</p></section>';
    }

    const daysSorted = allDays.slice().sort(function (a, b) { return String(b.date || '').localeCompare(String(a.date || '')); });
    const openFor = function (i) { return nlogDayMode === 'expanded' ? true : (nlogDayMode === 'collapsed' ? false : i === 0); };
    const collapseLabel = nlogDayMode === 'collapsed' ? 'Expand all' : 'Collapse all';
    const feedAction = daysSorted.length
      ? '<button type="button" class="wvd-nlog-sec-action" data-nlog="collapse">' + esc(collapseLabel) + '</button>'
      : '';
    const feed = '<div class="wvd-nlog-sec"><div class="wvd-nlog-sec-titles"><div class="wvd-nlog-sec-title">Full Daily Log</div><div class="wvd-nlog-sec-sub">Chronological record of daily work and outcomes.</div></div>' + feedAction + '</div>' +
      '<div class="wvd-session-list wvd-nlog-timeline">' + daysSorted.map(function (d, i) { return nlogTimelineDay(d, openFor(i)); }).join('') + '</div>';

    return '<section class="wvd-section wvd-anchor" id="wvd-noahlog-panel">' +
      feed +
      '<p class="wvd-kpi-caption">' + icons.info + '<span>' + esc(caption) + '</span></p></section>';
  }
  /* ==================== ACCESS LOG (write-only) ====================
     One row per visit, posted to Tasha's endpoint. The write is fire-and-forget in `no-cors`
     mode: Apps Script answers a POST with a redirect a cross-origin reader cannot follow, and
     more importantly a sign-in must never wait on, or fail because of, a logging call. */
  let auditSessionId = '';
  const auditPagesSeen = {};

  /* One id per TAB, which has to mean surviving a reload: the id lives in sessionStorage, not
     just in this closure. Held only in a module variable it was reborn on every page load, so a
     refresh became a separate visit and inflated the count the page exists to report. Cleared on
     sign-out, so the next person in the same tab is never folded into the previous visit. */
  const AUDIT_SESSION_KEY = 'wvd-audit-session';
  function auditSession() {
    if (!auditSessionId) auditSessionId = sessionGet(AUDIT_SESSION_KEY) || '';
    if (!auditSessionId) {
      try {
        const bytes = new Uint8Array(6);
        crypto.getRandomValues(bytes);
        auditSessionId = Array.prototype.map.call(bytes, (byte) => ('0' + byte.toString(16)).slice(-2)).join('');
      } catch (error) {
        // No WebCrypto is not a reason to stop logging; uniqueness per tab is all this needs.
        auditSessionId = 'x' + Date.now().toString(16) + Math.floor(Math.random() * 1e6).toString(16);
      }
      sessionSet(AUDIT_SESSION_KEY, auditSessionId);
    }
    return auditSessionId;
  }

  function auditDevice() {
    const ua = (navigator && navigator.userAgent) || '';
    let name = 'Computer';
    if (/iPhone/i.test(ua)) name = 'iPhone';
    else if (/iPad/i.test(ua)) name = 'iPad';
    else if (/Android/i.test(ua)) name = /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
    else if (/Macintosh|Mac OS X/i.test(ua)) name = 'Mac';
    else if (/Windows/i.test(ua)) name = 'Windows PC';
    const screenSize = (window.screen && window.screen.width) ? window.screen.width + 'x' + window.screen.height : '';
    return screenSize ? name + ' ' + screenSize : name;
  }

  function auditBrowser() {
    const ua = (navigator && navigator.userAgent) || '';
    if (/Edg\//.test(ua)) return 'Edge';
    if (/OPR\//.test(ua)) return 'Opera';
    if (/Chrome\//.test(ua)) return 'Chrome';
    if (/Firefox\//.test(ua)) return 'Firefox';
    if (/Safari\//.test(ua)) return 'Safari';
    return 'Browser';
  }

  // Never throws, never awaited. A logging failure must not change anything the user sees.
  function logAccess(event, opts) {
    try {
      if (!AUDIT_URL) return;
      const options = opts || {};
      const who = options.role || role || 'unknown';
      /* Tasha's own activity is never recorded (her call, 2026-08-02). This page exists to answer
         one question, whether NOAH opens the dashboard, and her own sign-ins were most of the rows
         and none of the answer. The suppression sits at the WRITE, not at the render: a row that is
         only filtered out of the view still exists in the Sheet, and "I don't need logs of mine"
         means the row is never created. It also drops a wrong-passphrase attempt on her own login,
         chosen knowingly over labelling those rows as an unidentified guess. */
      if (who === 'tasha') return;
      let zone = '';
      try { zone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (error) { zone = ''; }
      const payload = {
        role: who,
        event: event,
        page: options.page || '',
        device: auditDevice(),
        browser: auditBrowser(),
        session: auditSession(),
        tz: zone
      };
      fetch(AUDIT_URL, {
        method: 'POST',
        mode: 'no-cors',
        cache: 'no-store',
        keepalive: true,
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload)
      }).catch(() => { /* a dropped beacon is a missing row, never a broken page */ });
    } catch (error) { /* same */ }
  }

  function renderNoahLog() {
    const el = $('wvdNoahLogBody');
    if (!el) return;
    // Noah never gets this markup in his DOM at all, not merely hidden by CSS.
    if (!isTasha()) { el.innerHTML = ''; return; }
    if (data) el.innerHTML = buildNoahLogHtml(data.noahLog);
  }

  function healthMeta(band) {
    const map = {
      healthy: { label: 'HEALTHY', cls: 'wvd-good', filled: 3, meaning: 'Working and fully verified. No known issue needs attention.' },
      watch: { label: 'WATCH', cls: 'wvd-watch', filled: 2, meaning: 'Working now. A known limitation, verification step, or follow-up is being monitored. This is a heads-up, not a failure.' },
      'at-risk': { label: 'AT RISK', cls: 'wvd-bad', filled: 1, meaning: 'An active failure or high-risk condition needs action.' }
    };
    return map[band] || null;
  }
  function stageMeta(stage) {
    const map = {
      early: { label: 'EARLY', cls: 'wvd-early', filled: 1 },
      underway: { label: 'UNDERWAY', cls: 'wvd-watch', filled: 2 },
      'nearly-done': { label: 'NEARLY DONE', cls: 'wvd-good', filled: 3 }
    };
    return map[stage] || null;
  }
  function scoreRow(meta, reason) {
    if (!meta) return '';
    const steps = [1, 2, 3].map((n) => '<span class="wvd-step' + (n <= meta.filled ? ' wvd-filled ' + meta.cls : '') + '"></span>').join('');
    return '<div class="wvd-score-row"><span class="wvd-score-badge ' + meta.cls + '">' + meta.label + '</span><span class="wvd-step-bar">' + steps + '</span></div>' +
      (reason ? '<p class="wvd-score-reason">' + esc(reason) + '</p>' : '') +
      (meta.meaning ? '<p class="wvd-score-meaning"><strong>What this means:</strong> ' + esc(meta.meaning) + '</p>' : '');
  }
  function healthLegendHtml() {
    const bands = ['healthy', 'watch', 'at-risk'];
    return '<div class="wvd-health-key" aria-label="Health label meanings"><span class="wvd-health-key-title">Health key</span>' +
      bands.map((band) => {
        const meta = healthMeta(band);
        return '<div class="wvd-health-key-item"><span class="wvd-score-badge ' + meta.cls + '">' + meta.label + '</span><span class="wvd-health-key-copy">' + esc(meta.meaning) + '</span></div>';
      }).join('') + '</div>';
  }

  // ---- Systems page card helpers (redesigned card face) ----
  const SYS_ICONS = {
    'call-sheet': '<path d="M9 5h6M9 9h6M9 13h4"/><path d="M7 3h10a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"/>',
    'health-watchdog': '<path d="M3 12h4l2-7 4 14 2-7h6"/>',
    'kpi-report': '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>',
    'drafter': '<path d="M21 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h13a2 2 0 0 1 2 2Z"/>',
    'vehicle-lookup': '<path d="M5 13l1.5-4.5A2 2 0 0 1 8.4 7h7.2a2 2 0 0 1 1.9 1.5L19 13m-14 0h14m-14 0v4h2v-2m10 2h2v-4m-2 4v-2m-8 2v-2"/><circle cx="7.5" cy="15" r="0.6"/><circle cx="16.5" cy="15" r="0.6"/>',
    'orchestrator': '<rect x="3" y="3" width="6" height="6" rx="1.5"/><rect x="15" y="15" width="6" height="6" rx="1.5"/><rect x="15" y="3" width="6" height="6" rx="1.5"/><path d="M6 9v6a3 3 0 0 0 3 3h6M18 9v3"/>',
    'coverage-ledger': '<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3Z"/>',
    'reengage': '<path d="M20 11a8 8 0 1 0-2.3 5.6M20 4v7h-7"/>',
    'work-dashboard': '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 9h18M8 13h5"/>'
  };
  function sysIcon(id) {
    const inner = SYS_ICONS[id] || '<rect x="4" y="4" width="16" height="16" rx="3"/>';
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + inner + '</svg>';
  }
  function sysStatus(project) {
    const status = String(project.status || '').toLowerCase();
    if (status === 'live' && project.health && project.health.band === 'at-risk') return { label: 'AT RISK', tone: 'red', atrisk: true };
    if (status === 'live') return { label: 'LIVE', tone: 'green' };
    if (status === 'in_progress') return { label: 'IN PROGRESS', tone: 'gold' };
    if (status === 'observation') return { label: 'OBSERVATION', tone: 'blue' };
    if (status === 'blocked') return { label: 'BLOCKED', tone: 'red' };
    return { label: String(project.status || '').toUpperCase(), tone: 'green' };
  }
  // Distinct background motif per system, keyed by id -- the "css design at the back".
  // Each is a different shape so the grid never reads as one template stamped nine times.
  function decoDots(cols, rows, sx, sy, gapX, gapY, r) {
    let out = '';
    for (let y = 0; y < rows; y += 1) for (let x = 0; x < cols; x += 1) out += '<circle cx="' + (sx + x * gapX) + '" cy="' + (sy + y * gapY) + '" r="' + r + '"/>';
    return out;
  }
  function decoWave() {
    let out = '';
    for (let x = 0; x < 18; x += 1) {
      const px = 5 + x * 9;
      const h = 1 + Math.round((x / 17) * 5);
      for (let y = 0; y < h; y += 1) out += '<circle cx="' + px + '" cy="' + (78 - y * 11) + '" r="1.5"/>';
    }
    return out;
  }
  const SYS_DECO = {
    'call-sheet': '<svg viewBox="0 0 188 84" fill="none" stroke="currentColor" stroke-width="1.4" preserveAspectRatio="xMidYMax meet"><path d="M0 50q24-26 47 0t47 0 47 0 47 0"/></svg>',
    'health-watchdog': '<svg viewBox="0 0 188 84" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round" preserveAspectRatio="xMidYMax meet"><path d="M0 54h46l9-34 11 50 9-58 9 44 7-14h82"/></svg>',
    'kpi-report': '<svg viewBox="0 0 150 68" fill="currentColor" preserveAspectRatio="xMaxYMax meet">' + decoDots(9, 4, 6, 8, 16, 15, 1.5) + '</svg>',
    'drafter': '<svg viewBox="0 0 118 100" fill="none" stroke="currentColor" stroke-width="1.2" preserveAspectRatio="xMaxYMax meet"><path d="M12 12h78a10 10 0 0 1 10 10v34a10 10 0 0 1-10 10H48L28 82V76h-6a10 10 0 0 1-10-10V22a10 10 0 0 1 10-10Z"/></svg>',
    'vehicle-lookup': '<svg viewBox="0 0 130 74" fill="currentColor" preserveAspectRatio="xMaxYMax meet">' + decoDots(7, 5, 12, 8, 16, 14, 1.5) + '</svg>',
    'orchestrator': '<svg viewBox="0 0 132 96" fill="none" stroke="currentColor" stroke-width="1.2" preserveAspectRatio="xMaxYMax meet"><circle cx="140" cy="100" r="34"/><circle cx="140" cy="100" r="58"/><circle cx="140" cy="100" r="82"/></svg>',
    'coverage-ledger': '<svg viewBox="0 0 190 84" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" preserveAspectRatio="none"><path d="M2 74 20 66 36 70 54 54 72 60 90 40 108 48 128 24 148 32 168 12 188 20"/><circle cx="188" cy="20" r="3.4" fill="currentColor" stroke="none"/></svg>',
    'work-dashboard': '<svg viewBox="0 0 172 84" fill="currentColor" preserveAspectRatio="xMaxYMax meet">' + decoWave() + '</svg>',
    'reengage': ''
  };
  function sysDeco(id) {
    const svg = SYS_DECO[id];
    if (!svg) return '';
    return '<span class="wvd-sys-deco wvd-deco-' + esc(id) + '" aria-hidden="true">' + svg + '</span>';
  }
  function sysInitials(name) {
    const parts = String(name || '').trim().split(/[\s.]+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  function sysWatchers(project) {
    const watchers = Array.isArray(project.watchers) ? project.watchers : [];
    if (!watchers.length) return '';
    const shown = watchers.slice(0, 3);
    const extra = watchers.length - shown.length;
    const chips = shown.map((watcher) => '<span class="wvd-sys-chip" title="' + esc(watcher) + '">' + esc(sysInitials(watcher)) + '</span>').join('') +
      (extra > 0 ? '<span class="wvd-sys-chip wvd-sys-more">+' + extra + '</span>' : '');
    return '<div class="wvd-sys-watch"><span class="wvd-sys-watch-label">Watching</span><span class="wvd-sys-chips">' + chips + '</span></div>';
  }
  function agoShort(value) {
    if (!value) return '';
    const then = new Date(value).getTime();
    if (isNaN(then)) return '';
    const mins = Math.max(0, Math.floor((Date.now() - then) / 60000));
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + 'h ago';
    const days = Math.floor(hours / 24);
    return days === 1 ? '1 day ago' : days + ' days ago';
  }
  function sysFooter(updated) {
    const time = agoShort(updated);
    return '<div class="wvd-sys-foot"><span class="wvd-sys-foot-label"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 12 2 2 4-4"/></svg>Last update</span>' +
      (time ? '<span class="wvd-sys-foot-time">' + esc(time) + '</span>' : '') + '</div>';
  }

  function checklistPercent(done, left) {
    const doneCount = Array.isArray(done) ? done.length : 0;
    const leftCount = Array.isArray(left) ? left.length : 0;
    if (!leftCount) return null;
    return Math.round((doneCount / (doneCount + leftCount)) * 100);
  }
  function miniProgressHtml(percent, opts) {
    if (percent === null) return '';
    opts = opts || {};
    return '<div class="wvd-mini-progress"><div class="wvd-mini-progress-label"><span>' + esc(opts.label || 'Progress') + '</span><strong>' + percent + '%</strong></div>' +
      '<div class="wvd-mini-progress-track"><div class="wvd-mini-progress-fill" style="width:' + percent + '%"></div></div>' +
      (opts.caption ? '<p class="wvd-mini-progress-caption">' + esc(opts.caption) + '</p>' : '') +
      '</div>';
  }
  function detailList(items, emptyText) {
    if (items && items.length) return '<ul class="wvd-modal-list">' + items.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul>';
    return '<p class="wvd-modal-empty-line">' + esc(emptyText) + '</p>';
  }
  function buildProjectModalHtml(project) {
    const status = String(project.status || '').toLowerCase();
    const label = { live: 'LIVE', in_progress: 'IN PROGRESS', observation: 'OBSERVATION', blocked: 'BLOCKED' }[status] || project.status;
    const detail = project.detail || {};
    const percent = status !== 'live' ? checklistPercent(detail.whatWasDone, detail.whatsLeft) : null;
    const scoreHtml = status === 'live'
      ? (project.health ? scoreRow(healthMeta(project.health.band), project.health.reason) : '')
      : (percent !== null
        ? miniProgressHtml(percent, { label: 'Progress', caption: 'Based on checklist items done vs. left, not effort-weighted.' })
        : (project.progress ? scoreRow(stageMeta(project.progress.stage), project.progress.reason) : ''));
    const isUrgent = status === 'live' && project.health && project.health.band === 'at-risk';
    return '<div class="wvd-modal-top"><h2 id="wvdProjectModalTitle">' + esc(project.name) + '</h2><span class="wvd-status-pill">' + esc(label) + '</span></div>' +
      '<p class="wvd-modal-summary">' + esc(project.summary || '') + '</p>' +
      scoreHtml +
      (detail.goal ? '<div class="wvd-modal-section"><div class="wvd-body-label">Goal</div><p class="wvd-modal-text">' + esc(detail.goal) + '</p></div>' : '') +
      '<div class="wvd-modal-section"><div class="wvd-body-label">What was done</div>' + detailList(detail.whatWasDone, 'Nothing logged yet.') + '</div>' +
      (detail.whatsLeft && detail.whatsLeft.length ? '<div class="wvd-modal-section"><div class="wvd-body-label">What\'s left</div>' + detailList(detail.whatsLeft, '') + '</div>' : '') +
      '<div class="wvd-modal-section' + (isUrgent ? ' wvd-urgent' : '') + '"><div class="wvd-body-label">Needs improvement</div>' + detailList(detail.needsImprovement, 'Nothing outstanding right now.') + '</div>' +
      '<div class="wvd-modal-section"><div class="wvd-body-label">Watch for</div>' + detailList(detail.watchFor, 'Nothing to flag right now.') + '</div>' +
      (project.blockedOn ? '<div class="wvd-modal-section"><div class="wvd-body-label" style="color:var(--wvd-red)">Blocked on</div><p class="wvd-modal-text">' + esc(project.blockedOn) + '</p></div>' : '') +
      (detail.sources && detail.sources.length ? '<div class="wvd-modal-section"><div class="wvd-body-label" style="color:var(--wvd-faint)">Source</div><p class="wvd-modal-text" style="color:var(--wvd-faint)">' + esc(detail.sources.join('; ')) + '</p></div>' : '');
  }
  let currentProjects = [];
  let lastFocusedProjectEl = null;
  function openDetailModal(bodyHtml) {
    if ($('wvdProjectModalOverlay').hidden) lastFocusedProjectEl = document.activeElement;
    $('wvdProjectModalBody').innerHTML = bodyHtml;
    $('wvdProjectModalOverlay').hidden = false;
    document.body.style.overflow = 'hidden';
    $('wvdProjectModalClose').focus();
  }
  function openProjectModal(index) {
    const project = currentProjects[index];
    if (!project) return;
    openDetailModal(buildProjectModalHtml(project));
  }
  function closeProjectModal() {
    $('wvdProjectModalOverlay').hidden = true;
    $('wvdProjectModalBody').innerHTML = '';
    document.body.style.overflow = '';
    if (lastFocusedProjectEl && typeof lastFocusedProjectEl.focus === 'function') lastFocusedProjectEl.focus();
  }

  async function sha256Hex(text) {
    const encoded = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  /* ================= PIPELINE MAP DATA (edit content here only) ================= */
  const PIPELINE_MAP = Object.freeze({
    updated: '2026-08-01',
    pipeline: { name: 'Rockclear', id: 'bEtSvpuuB3FhtFjy0nDu', locationId: 'MGy43UHp6mBXZnHNjOSw' },
    courts: {
      ours:   { label: 'OUR MOVE, NO CLOCK',  color: 'var(--wvd-blue)',  legend: 'Blue: we owe the lead something. Nothing ages out here.' },
      theirs: { label: 'THEIR MOVE, CLOCK ON', color: 'var(--wvd-gold)',  legend: 'Gold: they owe us a reply. Follow-up ladders fire on a schedule.' },
      parked: { label: 'PARKED',               color: 'var(--wvd-text-soft)', legend: 'Soft white: parked on purpose. No sales clock runs here.' },
      won:    { label: 'CLOSED, WON',          color: 'var(--wvd-green)', legend: 'Green: money in.' },
      lost:   { label: 'CLOSED',               color: 'var(--wvd-red)',   legend: 'Red: closed out. Reactivation waves can still revive them.' },
      dead:   { label: 'NOT ON BOARD',         color: 'var(--wvd-faint)', legend: '' }
    },
    stages: [
      {
        key: 'new-lead', name: 'New Lead', lane: 'main', col: 1, court: 'ours',
        hint: 'Fresh inquiry. The auto-quoter should price it within minutes.',
        clock: 'No sales clock, but the watchdog alarms if anyone sits here over 60 minutes. Target is under 5.',
        plain: 'A brand new inquiry from the website form, a Meta ad, or a walk-in. The auto-quoter prices the car and moves the lead on within minutes. Leads only sit here when something failed.',
        entry: [
          { text: 'Form, ad, or walk-in creates the card (GHL intake router)', robot: 'receiver' },
          { text: 'Hidden: the broken paid-tag workflow in Noah’s old folder can bounce a PAYING customer back here as a fresh inquiry', kind: 'hidden', robot: 'paid-newlead-defect' }
        ],
        exit: [
          { text: 'Quote sent automatically: moves to Awaiting Engagement', kind: 'auto', robot: 'receiver' },
          { text: 'They open the quote: jumps to Proposal Sent Hot', kind: 'auto', robot: 'cadence-orchestrator' },
          { text: 'They reply: jumps to Proposal Sent Engaged', kind: 'auto', robot: 'cadence-orchestrator' },
          { text: 'Car cannot be auto-priced: routed to Manual Quote Required within seconds', kind: 'auto', robot: 'mqr-router' }
        ],
        human: {
          do: ['If a lead sits here more than an hour, check the 6:15 AM watchdog report before touching anything.'],
          dont: ['Never manually move a lead tagged proposal-sent-auto out of New Lead. The robot seeds its follow-up memory during the move; a hand-move skips that and the lead falls out of every ladder.']
        },
        flags: [],
        tech: { stageId: 'b2e40c8b-622b-4172-a966-226fb48e21f1', signals: ['tag: proposal-sent-auto', 'tag: needs-manual-classification-rocklear'], automations: ['ghl-lead-receiver', 'orchestrator AFC-rescue and hot-flip', 'MQR tag-triggered workflow (live 2026-07-16)', 'DEFECT: workflow 2860a241 sets stage back to New Lead on the paid tag (move-to-previous ON, error-flagged in Needs Review)'] }
      },
      {
        key: 'awaiting-engagement', name: 'Awaiting Engagement', lane: 'main', col: 2, court: 'theirs',
        hint: 'Quote is out. Waiting for an open or a reply.',
        clock: 'Text at 4h (approval queue) and 24h. After that the cold ladder continues: calls, a channel-shift email, and a final text, ending at 14 days.',
        plain: 'The quote went out: a branded email plus a text naming their exact car. Now the ball is in their court and the cold follow-up ladder runs.',
        entry: [
          { text: 'Auto-quote fires and the robot moves them in', robot: 'receiver' },
          { text: 'A manual quote finally goes out from Manual Quote Required (requote tag)', robot: 'receiver' }
        ],
        exit: [
          { text: 'They open the proposal: Proposal Sent Hot', kind: 'auto', robot: 'urable-open-poller' },
          { text: 'They reply: Proposal Sent Engaged', kind: 'auto', robot: 'cadence-orchestrator' },
          { text: '14 days of full silence: tagged for Lost Ghost', kind: 'timer', robot: 'auto-ghost' }
        ],
        human: {
          do: ['Any reply pauses the robots for 4 hours automatically so a human can take over the thread.'],
          dont: ['Do not re-send the quote by hand; the ladder already does it on schedule.']
        },
        flags: [],
        tech: { stageId: '6537e719-94f1-4ac5-9b28-34a6eb9983b5', signals: ['cold path anchor: day-0 send', 'strict-silence: 4h pause on any inbound'], automations: ['cadence engine COLD path rows 0-1', 'legacy rows 2-7 still name the retired No Answer stage in code'] }
      },
      {
        key: 'proposal-sent-hot', name: 'Proposal Sent Hot (Opened)', lane: 'main', col: 3, court: 'theirs',
        hint: 'They opened the quote. Hottest bucket on the board.',
        clock: 'Texts at 4h, 24h, and 72h after the open, a value email at day 7, and a final text at day 10. At 14 days of total silence the lead moves to Lost Ghost.',
        plain: 'They opened the quote in Urable. The warmest signal short of a reply, and the biggest pile of at-risk money: 108 of the 124 uncovered leads found on 07-16 live here.',
        entry: [ { text: 'Open-poller spots the proposal being opened within 5 minutes and tags it hot', robot: 'urable-open-poller' } ],
        exit: [
          { text: 'They reply: Proposal Sent Engaged', kind: 'auto', robot: 'cadence-orchestrator' },
          { text: 'They book and pay a deposit: the Urable job lands and Noah’s workflow moves them to Booked', kind: 'auto', robot: 'noah-status-mover' },
          { text: '14 days of total silence: tagged for Lost Ghost', kind: 'timer', robot: 'auto-ghost' }
        ],
        human: {
          do: ['Call these first. The 6 AM call sheet already ranks them near the top.', 'Every hot lead needs a next action; the coverage ledger fails loudly on any that have none.'],
          dont: ['Never drag leads out of this stage by hand. The robots own every move in and out.']
        },
        flags: [],
        tech: { stageId: 'd893dabe-0979-4892-8d3f-7646f64a8142', signals: ['Urable opened flag', 'tags: urgency:hot, urable-opened:{id}'], automations: ['HOT path, anchor frozen at open time', 'hot and engaged sends stay in the approval queue, never live-auto'] }
      },
      {
        key: 'proposal-sent-engaged', name: 'Proposal Sent Engaged', lane: 'main', col: 4, court: 'theirs',
        hint: 'They replied. Every new reply resets the clock.',
        clock: 'Touches at 4h, 48h, and 120h from their last reply. At 7 days of silence the lead is tagged for Lost Ghost.',
        plain: 'They replied or asked a question: the highest-intent group in the funnel. The tone here is answer-first, never a restarted pitch, and every fresh reply resets the follow-up clock.',
        entry: [ { text: 'A real inbound message flips them in (system events are filtered out)', robot: 'cadence-orchestrator' } ],
        exit: [
          { text: 'They book: the Urable job lands and Noah’s workflow moves them to Booked', kind: 'auto', robot: 'noah-status-mover' },
          { text: '7 days of silence: tagged for Lost Ghost', kind: 'timer', robot: 'auto-ghost' }
        ],
        human: {
          do: ['Read the actual thread before acting; the real signal for these leads often lives in call recordings, not texts.'],
          dont: ['Do not trust the stage as proof of a reply. System events like email unsubscribes once faked two dozen Engaged leads before the filter was added.']
        },
        flags: [],
        tech: { stageId: '6e29acc7-53b3-427c-b10a-3520767c3f9a', signals: ['anchor: last_inbound_ms', 'is_real_message() filters TYPE_ACTIVITY_* events'], automations: ['ENGAGED path, checked first by the engine', 'min gap 8h between touches'] }
      },
      {
        key: 'booked', name: 'Booked', lane: 'main', col: 5, court: 'parked',
        hint: 'Appointment set. Customer now, not a lead.',
        clock: 'No sales clock. A deposit-chaser (approved, currently switched off) texts at day 2, 4, and 7 only while a deposit is unpaid.',
        plain: 'Appointment on the calendar, deposit paid or pending. These people already said yes; the only robot allowed to text them is the unpaid-deposit chaser.',
        entry: [
          { text: 'A human books the job in Urable after the customer commits; the card move that follows is the robot’s, never a hand-drag', kind: 'manual' },
          { text: 'Urable job lands: the Zapier bridge stamps the contact, then Noah’s workflow moves the card in', kind: 'auto', robot: 'noah-status-mover' }
        ],
        exit: [
          { text: 'Job completed in Urable: the job-completed tag lands and Noah’s workflow moves them to Won', kind: 'auto', robot: 'noah-status-mover' },
          { text: 'Deposit ghost: human review, never auto-Lost', kind: 'manual' }
        ],
        human: {
          do: ['First payment on a future booking triggers the one-time welcome email and text.'],
          dont: ['Never let a marketing or cadence text reach someone who already paid. The 5:30 PM sweep pulls them out of the email drip; do not re-enroll them.']
        },
        flags: [],
        tech: { stageId: '3b730155-2478-4093-8b1b-1eefe30dfa44', signals: ['booked_deposit_unpaid flag, verified against live Urable each poll'], automations: ['BOOKED_DEPOSIT_PATH: +48h/+96h/+168h, then human review', 'welcome_send once ever', 'Booked mover: Noah’s workflow 337fee95, Service change → Booked (501 enrolled)'] }
      },
      {
        key: 'won', name: 'Won', lane: 'main', col: 6, court: 'won',
        hint: 'Job delivered and paid.',
        clock: 'No clock. Post-sale lifecycle (30d check-in, 90d review ask, anniversary) is designed but mostly unbuilt.',
        plain: 'Service delivered, money in. The aftercare email fires on arrival (Noah’s Won mover sends it, verified in the July audit). The rest of the post-sale lifecycle, including the 90-day review ask, is designed but not verified built.',
        entry: [ { text: 'Job completed in Urable: the job-completed tag lands and Noah’s workflow moves the card here and sends the aftercare email', kind: 'auto', robot: 'noah-status-mover' } ],
        exit: [ { text: 'None. Future re-marketing pulls from here by tag, not by stage move', kind: 'manual' } ],
        human: { do: ['Past customers are never Lost, whatever they say. Tag past-customer; they get their own campaign.'], dont: [] },
        flags: [],
        tech: { stageId: 'd06d27dc-d04f-423f-ae34-a0365fbdfc6f', signals: [], automations: ['90d review ask: designed, existence UNVERIFIED (July audit hit a 401 reading native workflows; no build record since)', 'Won mover: Noah’s workflow 809727e2, job-completed tag → Won stage + status + aftercare email (197 enrolled)'] }
      },
      {
        key: 'no-answer-vm', name: 'No Answer / VM', lane: 'exceptions', col: 2, court: 'dead',
        hint: 'Retired stage, removed from the live board.',
        clock: 'None. Historical.',
        plain: 'Retired. It used to hold mid-ladder leads who did not pick up. It was emptied on 06-30 and no longer exists on the live board, but the cold-ladder code still names it, so it stays on the map as history until the engine is re-keyed.',
        entry: [], exit: [],
        human: { do: [], dont: ['If leads ever reappear in a stage by this name, treat it as a config regression and check the watchdog C6 finding first.'] },
        flags: ['retired'],
        tech: { stageId: '473c5356-2381-47a8-9d1e-d75ecbd9e5e9 (historical)', signals: [], automations: ['cadence COLD path rows 2-7 still reference this slug in code'] }
      },
      {
        key: 'manual-quote-required', name: 'Manual Quote Required', lane: 'exceptions', col: 3, court: 'ours',
        hint: 'We owe them a quote. Nothing ages out here.',
        clock: 'No clock ever. These leads are waiting on us, not the customer. The watchdog flags any left untouched for 48h.',
        plain: 'A real prospect whose car the auto-quoter could not price: odd model, typo, classic car, motorcycle, or a multi-vehicle ask. A human owes them a quote. Silence never counts against these leads.',
        entry: [ { text: 'Auto-price fails, the tag workflow routes them here within seconds (live since 07-16)', robot: 'mqr-router' } ],
        exit: [
          { text: 'Rep tags requote-rocklear: the quote flow re-fires and moves them to Awaiting Engagement', kind: 'auto', robot: 'receiver' },
          { text: 'Genuinely unquotable (no model, garbled text): stays for a qualifying call', kind: 'manual' }
        ],
        human: {
          do: ['Every lead here needs an owner and an open dated task within 24h, or the coverage ledger fails it.'],
          dont: ['Never drag a lead out of this stage. They have not been quoted; moving them buries our own dropped ball. This is exactly what happened to M.Rod.']
        },
        flags: [],
        tech: { stageId: 'fc94b6e7-08b8-4b18-a35d-1eff5a11eb73', signals: ['tag: needs-manual-classification-rocklear', 'tag: requote-rocklear to exit'], automations: ['MQR tag-triggered GHL workflow', 'call sheet p2 tier', 'watchdog C7', '07-24 reactivation campaign is emailing the old Feb/Mar cohort parked here (attribution and intent open with Noah/Sean)'] }
      },
      {
        key: 'proposal-sent-cold', name: 'Proposal Sent Cold', lane: 'exceptions', col: 4, court: 'dead',
        hint: 'Config-only. Never on the live board.',
        clock: 'None.',
        plain: 'Exists only in old config files and the original spec; it was never on the live board. Kept on the map so nobody wonders where Cold went: unopened quotes simply live in Awaiting Engagement.',
        entry: [], exit: [],
        human: { do: [], dont: [] },
        flags: ['dead'],
        tech: { stageId: '927903d7-f2fe-46f7-a7f1-9d462d0c17f8 (config-only)', signals: [], automations: [] }
      },
      {
        key: 'long-term-nurture', name: 'Long Term Nurture (archive)', lane: 'parked', col: 3, court: 'dead',
        hint: 'Archive pool, ~412 leads, migrating to Re-Engage.',
        clock: 'Entering it starts a 6-text drip over roughly 92 days.',
        plain: 'An archived stage holding roughly 412 old leads, being migrated into Re-Engage. Entering it triggers the Long Term Nurture text drip: 6 texts over about 92 days. Not the same robot as the 6-email Nurture Sequence, an easy mix-up.',
        entry: [ { text: 'Archive migrations only', kind: 'manual' } ],
        exit: [ { text: 'Migration to Re-Engage (in progress)', kind: 'manual' } ],
        human: { do: [], dont: [] },
        flags: ['archive'],
        tech: { stageId: 'archived, not on the live 11-stage board', signals: ['stage change triggers the LTN SMS workflow'], automations: ['GHL workflow cb37cb03, 6 SMS over ~92 days, ~341 active'] }
      },
      {
        key: 're-engage', name: 'Re-Engage', lane: 'parked', col: 4, court: 'parked',
        hint: 'Parked with hope: real interest, then went quiet.',
        clock: 'No automatic ladder. Scheduled callbacks surface on the call sheet on their date; the cold pool waits for reactivation waves.',
        plain: 'Noah defined it: a lead who showed real interest and gave real hope, then went quiet, is still thinking, or is waiting on something like payday or a spouse. Not a dump for dead leads, and never where an actively worked hot lead lives.',
        entry: [
          { text: 'Lead asks for a future callback: parked here with a tag and a dated task. The only robot allowed to write this stage', robot: 'deferred-callback' },
          { text: 'Hand-drags land here too. This is the confirmed leak: audit logs named Sean on every checked entrant (reconfirmed 07-31, after the written rule), and it buried Tauqueer (open invoice) and M.Rod (never quoted). Since 07-30 the entry guard flags every anomalous entrant within minutes', kind: 'hidden', robot: 'reengage-entry-guard' }
        ],
        exit: [
          { text: 'Callback day arrives: surfaces at the top of the call sheet', kind: 'auto', robot: 'daily-call-sheet' },
          { text: 'Monday 7 AM triage re-checks everyone parked here and posts a rescue plan to Discord; approved moves run from that plan', kind: 'auto', robot: 'reengage-auto-triage' },
          { text: 'Reactivation wave revives them into the active funnel', kind: 'manual' }
        ],
        human: {
          do: ['Every entrant needs the scheduled-callback tag and a dated task, or the watchdog flags it within 24h.'],
          dont: ['Never drag a card here after a final text; the overnight robots own stage moves.', 'Never park an actively worked Hot or Engaged lead here.', 'Never set status to lost: a hidden automation bounces the card to Disqualified.']
        },
        flags: [],
        tech: { stageId: '5c135b3c-784e-4c79-82e9-12ffe7082d19', signals: ['tag: scheduled-callback + dated rep task', 'tag: reengage-entry-review on anomalous entrants (guard live 07-30, ~6 min latency)'], automations: ['deferred_callback.schedule_callback() is the one sanctioned automatic writer', 'weekly reengage-auto-triage (Mon 7 AM PT), proposes only, approval-gated executor', 'entry guard workflow live 07-30; watchdog C15 escalates if it is off or bypassed, C16 task hygiene', 'mover attribution: GHL Settings → Audit Logs, search the OPPORTUNITY id, hand the reader a UTC timestamp (panel rendered JST once)'] }
      },
      {
        key: 'lost-ghost', name: 'Lost Ghost', lane: 'parked', col: 5, court: 'lost',
        hint: 'Quoted, chased 14 days, total silence.',
        clock: 'Design: 90-day cooldown then a reactivation look. Mostly unbuilt.',
        plain: 'Quoted and chased through the entire ladder, then 14 days of zero response on every channel. The robot tags them and a guarded GHL workflow makes the move.',
        entry: [ { text: '14-day silence tag lands, the auto-ghost workflow moves the card (skips anyone already booked, won, or closed)', robot: 'auto-ghost' } ],
        exit: [
          { text: 'They text back ready to book: the inbound reader pings Discord, then a HUMAN moves the card. No robot moves it', kind: 'manual', robot: 'inbound-detector' },
          { text: 'Hidden gap: a ghost who replies with a question gets a quiet tag only. No Discord ping, no auto-reply, and the card stays buried here', kind: 'hidden', robot: 'inbound-detector' }
        ],
        human: {
          do: ['Leave the transition tag on the contact; it is the historical marker.', 'A replying ghost re-enters the funnel only if a human moves the card. Check for inbound:question tags on ghosts when working the inbox.'],
          dont: ['Never set Status to Lost. A hidden automation bounces the card into Disqualified; this once cost a re-do of 24 ghosts. Stage move only.', 'Never assume a replying ghost was picked up automatically. The follow-up engine does not walk this stage.']
        },
        flags: [],
        tech: { stageId: '9993208f-664f-4569-8c01-3a19ca6c4b34', signals: ['tag: cadence:transition-lost-ghost', 'status stays abandoned, never lost'], automations: ['GHL auto-ghost workflow with If/Else safety guard'] }
      },
      {
        key: 'lost-declined', name: 'Lost Declined', lane: 'parked', col: 5, court: 'lost',
        hint: 'They said no in their own words.',
        clock: 'Cadence permanently stopped.',
        plain: 'The lead strongly said no in their own words: not interested, went elsewhere, sold the car, stop texting. All robots stop permanently.',
        entry: [ { text: 'The inbound reader classifies a real decline and tags it', robot: 'inbound-detector' } ],
        exit: [ { text: 'Design: 90-day cooldown then Re-Engage review', kind: 'manual' } ],
        human: {
          do: [],
          dont: ['A price objection is not a decline. Someone saying 850 is my max is a conditional yes. Only an explicit refusal belongs here.']
        },
        flags: [],
        tech: { stageId: '962f9a8c-ae15-474d-82ae-e2460314af77', signals: ['tag: cadence:transition-lost-declined'], automations: ['permanent cadence stop'] }
      },
      {
        key: 'disqualified', name: 'Disqualified', lane: 'parked', col: 6, court: 'lost',
        hint: 'Junk: spam, wrong number, out of area.',
        clock: 'None.',
        plain: 'Never a real prospect: spam, wrong numbers, out of service area, do-not-contact. Also the bucket Noah’s old Abandoned Automation workflow bounces anything into when its status is set to lost, marking the contact Do Not Contact on the way. The July audit finally unmasked it, and it is why status is never touched anywhere on this board.',
        entry: [
          { text: 'Human or audit routing for genuine junk', kind: 'manual' },
          { text: 'Hidden: status set to lost or abandoned makes the Abandoned Automation workflow bounce the card here and DND the contact', kind: 'hidden', robot: 'abandoned-automation' }
        ],
        exit: [],
        human: { do: ['Suppression tags carry regardless of stage.'], dont: [] },
        flags: [],
        tech: { stageId: '9ea6fac0-cc2d-4421-877b-a15773169373', signals: [], automations: ['Abandoned Automation, workflow 64425ced published at root (1,125 enrolled): status lost/abandoned → DND + remove from all workflows + force Rockclear → Disqualified'] }
      }
    ],
    robots: [
      { key: 'receiver', name: 'Auto-quoter (receiver)', group: 'Core', cadence: 'every new lead, instantly', plain: 'Prices the car from a 1,800-line vehicle database, builds the 3-tier Urable proposal, emails it and texts within seconds.', reads: ['new-lead'], writes: ['awaiting-engagement'] },
      { key: 'urable-open-poller', name: 'Proposal open-poller', group: 'Core', cadence: 'every 5 minutes', plain: 'Watches Urable for the moment a customer opens their proposal, then tags them hot so the orchestrator promotes them.', reads: ['awaiting-engagement'], writes: ['proposal-sent-hot'] },
      { key: 'cadence-orchestrator', name: 'Cadence orchestrator', group: 'Core', cadence: '30-minute heartbeat', plain: 'The metronome. Every 30 minutes it checks every active lead against the follow-up ladders and fires whatever is due. Owns the promotion moves between stages.', reads: ['new-lead', 'awaiting-engagement', 'proposal-sent-hot', 'proposal-sent-engaged', 'booked', 'no-answer-vm'], writes: ['awaiting-engagement', 'proposal-sent-hot', 'proposal-sent-engaged'] },
      { key: 'reply-drafter', name: 'Reply drafter', group: 'Core', cadence: 'on demand', plain: 'Writes every follow-up text in Noah’s voice with Claude. Everything for warm leads lands in an approval queue first, never auto-sent.', reads: ['awaiting-engagement', 'proposal-sent-hot', 'proposal-sent-engaged'], writes: [] },
      { key: 'inbound-detector', name: 'Inbound reader', group: 'Core', cadence: 'instant, on every message', plain: 'Reads every incoming text. Pauses the robots for 4 hours so a human can reply, sorts intent, escalates complaints to Discord, tags real declines.', reads: ['awaiting-engagement', 'proposal-sent-hot', 'proposal-sent-engaged'], writes: ['lost-declined'] },
      { key: 'deferred-callback', name: 'Callback parker', group: 'Core', cadence: 'when a lead asks', plain: 'When a lead says call me next month, parks them in Re-Engage with a tag and a dated task. The only robot allowed to write Re-Engage.', reads: [], writes: ['re-engage'] },
      { key: 'mqr-router', name: 'Manual-quote router', group: 'Core', cadence: 'instant, on tag', plain: 'When the auto-quoter cannot price a car, this GHL workflow moves the lead to the human quote queue within seconds. Built 07-16.', reads: ['new-lead'], writes: ['manual-quote-required'] },
      { key: 'daily-call-sheet', name: 'Daily call sheet', group: 'Daily reports', cadence: '6:00 AM PT daily', plain: 'Sean’s ranked morning list: 50 leads ordered by real buying intent, scheduled callbacks pinned on top, quality gates before every post.', reads: ['awaiting-engagement', 'proposal-sent-hot', 'proposal-sent-engaged', 'manual-quote-required', 're-engage'], writes: [] },
      { key: 'watchdog', name: 'Pipeline watchdog', group: 'Daily reports', cadence: '6:15 AM PT daily', plain: '16 automatic checks (numbered up to C18; C11-C13 do not exist): stuck leads, config drift, broken stages, orphaned callbacks, the Re-Engage entry guard’s health. Posts to Discord before anyone starts working.', reads: ['new-lead', 'awaiting-engagement', 'proposal-sent-hot', 'proposal-sent-engaged', 'manual-quote-required', 're-engage'], writes: [] },
      { key: 'coverage-ledger', name: 'Coverage ledger (C17)', group: 'Daily reports', cadence: 'daily, with the watchdog', plain: 'The safety net. Every active lead must resolve to one valid next action (acted, deferred, excluded, or failed) or the report fails loudly. This is what found the 124.', reads: ['new-lead', 'awaiting-engagement', 'proposal-sent-hot', 'proposal-sent-engaged', 'manual-quote-required'], writes: [] },
      { key: 'nurture-exit-sweep', name: 'Nurture exit sweep', group: 'Daily reports', cadence: '5:30 PM PT daily', plain: 'Pulls booked, paid, and actively replying customers out of the email drip so nobody gets marketing after giving us money.', reads: ['booked', 'won'], writes: [] },
      { key: 'deposit-chaser', name: 'Deposit chaser', group: 'Pending deploy', cadence: 'approved, not yet live', plain: 'Chases unpaid deposits on booked jobs at day 2, 4, and 7, then hands off to a human. Verified against live Urable so it can never text a paid customer.', reads: ['booked'], writes: [] },
      { key: 'missed-call-responder', name: 'Missed-call responder', group: 'Pending deploy', cadence: 'every 5 minutes, draft-only since 07-30', plain: 'Texts back missed callers with a personalized message instead of the canned one. Running since 07-30 (its first clean runs ever) but in draft-only mode: it writes the texts and sends nothing until Noah flips it live. Guard-railed: one per 24h, send-window enforced.', reads: [], writes: [] },
      { key: 'nurture-sequence', name: 'Nurture Sequence (emails)', group: 'GHL native', cadence: 'on enrollment', plain: '6 emails over about 9 days, then a completion tag. No texts and no stage moves: verified on the canvas 07-17, it cannot move anyone. Known gap: no exit condition of its own; the 5:30 PM sweep covers that.', reads: [], writes: [] },
      { key: 'ltn-workflow', name: 'Long Term Nurture (texts)', group: 'GHL native', cadence: 'on entering the archive stage', plain: '6 texts over about 92 days for the deep-freeze pool. A different robot from the email Nurture Sequence, despite the similar name.', reads: ['long-term-nurture'], writes: [] },
      { key: 'auto-ghost', name: 'Auto-ghost mover', group: 'GHL native', cadence: 'instant, on tag', plain: 'When the 14-day silence tag lands, moves the card to Lost Ghost. Has a safety guard that skips anyone already booked, won, or closed.', reads: [], writes: ['lost-ghost'] },
      { key: 'urable-zapier', name: 'Urable-Zapier bridge', group: 'GHL native', cadence: 'event-driven', plain: 'Urable to GHL bridges: job events stamp the contact (Service field, job-completed and paid tags) and new customers get GHL contacts. The stamps are what Noah’s workflows react to; the July audit proved the Zaps themselves never move a card. Listen-only; Zapier cannot create or schedule jobs.', reads: ['booked', 'won'], writes: [] },
      { key: 'noah-status-mover', name: 'Noah’s Booked/Won mover', group: 'GHL native', cadence: 'instant, on Urable job signals', plain: 'Noah’s original GHL workflows in the PAID>BOOKED>COMPLETED>VIP folder. When a Urable job stamps the contact, they move the card: a Service change lands it in Booked (501 enrolled), and the job-completed tag lands it in Won and sends the aftercare email (197 enrolled). The July audit proved these workflows, not humans, make every Booked and Won move on the board.', reads: [], writes: ['booked', 'won'] },
      { key: 'paid-newlead-defect', name: 'Paid-tag defect (Noah’s folder)', group: 'GHL native', cadence: 'instant, on the paid tag', plain: 'The broken sibling in the same folder: when the paid tag lands it sets the stage BACK to New Lead, so a paying customer can resurface at the top of the board as a fresh inquiry. GHL itself flags it in the Needs Review tab. Retire-or-fix decision sits with Noah.', reads: [], writes: ['new-lead'] },
      { key: 'abandoned-automation', name: 'Status-bounce (Abandoned Automation)', group: 'GHL native', cadence: 'instant, on status change', plain: 'The hidden bounce, unmasked by the July audit: a published workflow named Abandoned Automation, 1,125 enrolled. The moment any card’s status is set to lost or abandoned, it forces the card into Rockclear’s Disqualified, marks the contact Do Not Contact, and pulls them from every workflow, whatever pipeline they came from. Losing a deal is not a do-not-contact request, so the DND is up for Noah’s edit-or-retire call.', reads: [], writes: ['disqualified'] },
      { key: 'reactivation-0724', name: 'Reactivation campaign (07-24)', group: 'GHL native', cadence: 'running since 07-24', plain: 'An email campaign reviving old cohorts, live since 07-24 and currently messaging at least the 9 old Feb/Mar leads parked in Manual Quote Required. The 07-25 audit flagged its copy: it claims pricing was sent back in November that the threads never received. Who launched it and whether it is the intended play for that cohort are open questions with Noah and Sean.', reads: ['manual-quote-required'], writes: [] },
      { key: 'never50-reply-router', name: 'Never-Got-50% reply router', group: 'GHL native', cadence: 'instant, on campaign replies', plain: 'Reply handling for the Never-Got-50% reactivation campaign (103 old leads who never got a price or had one drop). The moment one replies, the team gets a branded alert with the reply quoted and a one-tap link to the thread, and quote-ready replies route into the quote flow. Tasha built all three workflows in GHL on 07-25; the campaign sends themselves still wait on Noah’s go.', reads: [], writes: [] },
      { key: 'reengage-auto-triage', name: 'Monday Re-Engage triage', group: 'Daily reports', cadence: 'Mondays 7:00 AM PT', plain: 'Weekly sweep of everyone parked in Re-Engage: re-checks every lead, drafts the rescue plan, and posts the approval package to Discord. It only proposes; a human approves the plan before its executor moves a single card. Live since 07-19.', reads: ['re-engage'], writes: [] },
      { key: 'payment-sync', name: 'Urable payment sync', group: 'Pending deploy', cadence: 'deployed watch-only, off behind a flag', plain: 'Reads every Urable payment and writes it into GHL: payment status, exact amount paid, and balance due on the contact, then advances the card to Booked on a deposit or a paid-in-full. Forward-only, so it can never drag a Won or Lost card backward. Already deployed with watch-only flags pre-set; going live is one toggle plus one command, waiting on Noah.', reads: [], writes: ['booked'] },
      { key: 'reengage-entry-guard', name: 'Re-Engage entry guard', group: 'GHL native', cadence: 'instant, on stage entry (live 07-30)', plain: 'Any lead landing in Re-Engage without a scheduled callback tags itself reengage-entry-review and opens a same-day review task within about six minutes, whether a human or software made the move. Proven on a test lead 07-30; the 6:15 AM watchdog escalates if the guard is ever off or bypassed.', reads: ['re-engage'], writes: [] },
      { key: 'weekday-kpi', name: 'Weekday KPI report', group: 'Daily reports', cadence: '6:45 AM PT weekdays', plain: 'Scores yesterday’s numbers and posts the scoreboard to Discord. Read-only: it counts the board, it never touches a card.', reads: [], writes: [] }
    ],
    edges: [
      { from: 'new-lead', to: 'awaiting-engagement' },
      { from: 'awaiting-engagement', to: 'proposal-sent-hot' },
      { from: 'proposal-sent-hot', to: 'proposal-sent-engaged' },
      { from: 'proposal-sent-engaged', to: 'booked' },
      { from: 'booked', to: 'won' }
    ]
  });
  /* =============== END PIPELINE MAP DATA =============== */

  /* Derived per-stage robot rosters. Computed from each robot's reads/writes plus
     the robots named in a stage's entry/exit rows, so the stage cards and the robot
     cards can never disagree. Never hand-edit a stage roster: edit the robot's
     reads/writes (or the entry/exit rows) and this recomputes. */
  const PM_STAGE_ROBOTS = (() => {
    const rosters = {};
    PIPELINE_MAP.stages.forEach((stage) => {
      const present = {};
      (stage.entry || []).concat(stage.exit || []).forEach((row) => { if (row.robot) present[row.robot] = true; });
      PIPELINE_MAP.robots.forEach((robot) => {
        if (robot.reads.indexOf(stage.key) !== -1 || robot.writes.indexOf(stage.key) !== -1) present[robot.key] = true;
      });
      rosters[stage.key] = PIPELINE_MAP.robots.filter((robot) => present[robot.key]).map((robot) => robot.key);
    });
    return rosters;
  })();
  function pmStageRobots(stage) { return PM_STAGE_ROBOTS[stage.key] || []; }

  /* ===== PIPELINE MAP PRESENTATION (icons + labels — edit here) ===== */
  const PM_ICO = {
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8Z"/></svg>',
    stack: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/></svg>',
    robot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="8" width="16" height="11" rx="2.5"/><path d="M12 8V4.5M9 4.5h6"/><path d="M9.5 13h.01M14.5 13h.01"/><path d="M2 12.5v2.5M22 12.5v2.5"/></svg>',
    user: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c0-4 3.4-6.5 7.5-6.5s7.5 2.5 7.5 6.5"/></svg>',
    chat: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 4H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h4v3.5l4-3.5h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3.5 7 8.5 6 8.5-6"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="16.5" rx="2.5"/><path d="M8 2.5v4M16 2.5v4M3 10h18"/></svg>',
    dollar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v10"/><path d="M14.6 9.3c0-1-1.2-1.8-2.6-1.8s-2.6.8-2.6 1.8 1.2 1.5 2.6 1.8 2.6.8 2.6 1.9-1.2 1.8-2.6 1.8-2.6-.8-2.6-1.8"/></svg>',
    file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5Z"/><path d="M14 3v5h5M9 13h6M9 17h4"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3.5V9h-5.5"/></svg>',
    ghost: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 21V10.5a7 7 0 0 1 14 0V21l-2.3-1.8-2.3 1.8-2.1-1.8L10 21l-2.3-1.8L5 21Z"/><path d="M9.5 10.5h.01M14.5 10.5h.01"/></svg>',
    ban: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path d="M6.5 7 7.5 20a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1L17.5 7"/></svg>'
  };

  const PM_UI = Object.freeze({
    legendOrder: ['ours', 'theirs', 'parked', 'won', 'lost'],
    courtShort: {
      ours: 'Blue = we owe the lead something.',
      theirs: 'Gold = they owe us a reply.',
      parked: 'Soft white = parked on purpose, no clock.',
      won: 'Green = money in.',
      lost: 'Red = closed out, but some can still be revived.'
    },
    stageIcon: {
      'new-lead': 'user', 'awaiting-engagement': 'chat', 'proposal-sent-hot': 'mail',
      'proposal-sent-engaged': 'eye', 'booked': 'calendar', 'won': 'dollar',
      'manual-quote-required': 'file', 're-engage': 'refresh', 'lost-ghost': 'ghost',
      'lost-declined': 'ban', 'disqualified': 'trash'
    },
    stageBadge: {
      'new-lead': 'No clock', 'awaiting-engagement': 'Clock on', 'proposal-sent-hot': 'Clock on',
      'proposal-sent-engaged': 'Clock on', 'booked': 'Parked', 'won': 'Closed won'
    },
    columns: [
      { group: 'Core', label: 'Core robots', sub: 'Event-driven', color: 'var(--wvd-green)', wide: true, marks: 'badges' },
      { group: 'Daily reports', label: 'Scheduled cron', sub: 'Daily reports', color: 'var(--wvd-gold)', marks: 'clock' },
      { group: 'Pending deploy', label: 'Pending deploy', sub: 'Coming soon', color: 'var(--wvd-red)', marks: 'stack' },
      { group: 'GHL native', label: 'GHL native', sub: 'Native / Pending', color: 'var(--wvd-blue)', marks: 'stack' }
    ]
  });

  function pmIcon(name) { return PM_ICO[name] || ''; }

  function pmRobotMarks(robot, column) {
    if (column.marks === 'clock') return '<span class="wvd-pm-mark-ico">' + pmIcon('clock') + '</span>';
    if (column.marks === 'stack') return '<span class="wvd-pm-mark-ico">' + pmIcon('stack') + '</span>';
    const touched = {};
    robot.reads.concat(robot.writes).forEach((key) => { touched[key] = true; });
    const marks = PIPELINE_MAP.stages
      .filter((stage) => stage.lane === 'main' && touched[stage.key])
      .map((stage) => '<span class="wvd-pm-mark' + (robot.writes.indexOf(stage.key) !== -1 ? ' wvd-pm-mark-w' : '') + '">' + stage.col + '</span>')
      .join('');
    return marks || '<span class="wvd-pm-mark wvd-pm-mark-star" title="Works an off-board stage">★</span>';
  }


  let activePipelineRobot = null;

  function pmStage(key) {
    return PIPELINE_MAP.stages.find((stage) => stage.key === key) || null;
  }

  function pmCourt(stage) {
    return PIPELINE_MAP.courts[stage.court] || PIPELINE_MAP.courts.dead;
  }

  function pmIsGhost(stage) {
    return stage.flags.indexOf('dead') !== -1 || stage.flags.indexOf('retired') !== -1 || stage.flags.indexOf('archive') !== -1;
  }

  function renderPipelineMap() {
    const body = $('wvdPipelineBody');
    if (!body || typeof PIPELINE_MAP === 'undefined') return;

    const mainStages = PIPELINE_MAP.stages.filter((stage) => stage.lane === 'main');
    const ghostStages = PIPELINE_MAP.stages.filter(pmIsGhost);
    const waitingOnUs = PIPELINE_MAP.stages.filter((stage) => !pmIsGhost(stage) && stage.lane !== 'main' && stage.court === 'ours');
    const parked = PIPELINE_MAP.stages.filter((stage) => !pmIsGhost(stage) && stage.lane !== 'main' && stage.court !== 'ours');
    const rowTags = { 're-engage': 'Known leak', 'disqualified': 'Hidden bounce' };

    const legend =
      '<div class="wvd-pm-legend">' +
        '<div class="wvd-pm-legend-lead"><span class="wvd-pm-legend-clock">' + pmIcon('clock') + '</span>' +
          '<span class="wvd-pm-legend-title">The clock only runs when the ball is in the customer’s court.</span></div>' +
        '<div class="wvd-pm-legend-keys">' +
          PM_UI.legendOrder.map((key) => {
            const court = PIPELINE_MAP.courts[key];
            return '<span class="wvd-pm-key" style="--k:' + court.color + '"><i></i>' + esc(PM_UI.courtShort[key]) + '</span>';
          }).join('') +
        '</div>' +
      '</div>';

    const nodes = mainStages.map((stage, index) => {
      const court = pmCourt(stage);
      return '<div class="wvd-pm-node" style="--c:' + court.color + '" data-wvd-stage="' + esc(stage.key) + '" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Open details for ' + esc(stage.name) + '">' +
        '<span class="wvd-pm-num">' + (index + 1) + '</span>' +
        '<span class="wvd-pm-node-ico">' + pmIcon(PM_UI.stageIcon[stage.key]) + '</span>' +
        '<h3>' + esc(stage.name) + '</h3>' +
        '<p class="wvd-pm-node-hint">' + esc(stage.hint) + '</p>' +
        '<span class="wvd-pm-badge">' + esc(PM_UI.stageBadge[stage.key] || pmCourt(stage).label) + '</span>' +
        '<span class="wvd-pm-robotcount">' + pmIcon('robot') + '<b>' + pmStageRobots(stage).length + '</b> robots</span>' +
      '</div>';
    }).join('');

    const flow =
      '<div class="wvd-pm-section"><div class="wvd-pm-overline">The path of a lead</div>' +
        '<div class="wvd-pm-track">' + nodes + '</div></div>';

    const exceptionRows = waitingOnUs.map((stage) => {
      const court = pmCourt(stage);
      return '<div class="wvd-pm-exrow" style="--c:' + court.color + '" data-wvd-stage="' + esc(stage.key) + '" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Open details for ' + esc(stage.name) + '">' +
        '<span class="wvd-pm-exico">' + pmIcon(PM_UI.stageIcon[stage.key]) + '</span>' +
        '<div class="wvd-pm-exrow-copy"><h3>' + esc(stage.name) + '</h3><p>' + esc(stage.hint) + '</p></div></div>';
    }).join('');

    const closedRows = parked.map((stage) => {
      const court = pmCourt(stage);
      const tag = rowTags[stage.key];
      return '<div class="wvd-pm-clrow" style="--c:' + court.color + '" data-wvd-stage="' + esc(stage.key) + '" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Open details for ' + esc(stage.name) + '">' +
        '<span class="wvd-pm-clico">' + pmIcon(PM_UI.stageIcon[stage.key]) + '</span>' +
        '<div class="wvd-pm-clrow-copy"><h3>' + esc(stage.name) + '</h3><p>' + esc(stage.hint) + '</p></div>' +
        (tag ? '<span class="wvd-pm-flag">' + esc(tag) + '</span>' : '') + '</div>';
    }).join('');

    const grid =
      '<div class="wvd-pm-grid">' +
        '<div class="wvd-pm-panel"><div class="wvd-pm-panel-head wvd-pm-tone-blue">Exception stage <span>(Waiting on us)</span></div>' + exceptionRows + '</div>' +
        '<div class="wvd-pm-panel"><div class="wvd-pm-panel-head">Parked and closed</div>' + closedRows + '</div>' +
      '</div>';

    const total = PIPELINE_MAP.robots.length;
    const cron = PIPELINE_MAP.robots.filter((robot) => robot.group === 'Daily reports').length;
    const nativeCount = PIPELINE_MAP.robots.filter((robot) => robot.group === 'GHL native').length;
    const eventDriven = total - cron - nativeCount;

    const columns = PM_UI.columns.map((column) => {
      const items = PIPELINE_MAP.robots
        .filter((robot) => robot.group === column.group)
        .map((robot) =>
          '<button type="button" class="wvd-pm-robot-chip" data-wvd-robot="' + esc(robot.key) + '" aria-pressed="false">' +
            '<span class="wvd-pm-robot-ico">' + pmIcon('robot') + '</span>' +
            '<span class="wvd-pm-robot-name">' + esc(robot.name) + '</span>' +
            '<span class="wvd-pm-robot-marks">' + pmRobotMarks(robot, column) + '</span>' +
          '</button>'
        ).join('');
      return '<div class="wvd-pm-col' + (column.wide ? ' wvd-pm-col-wide' : '') + '">' +
        '<div class="wvd-pm-col-head" style="--c:' + column.color + '">' + esc(column.label) + ' <span>(' + esc(column.sub) + ')</span></div>' +
        '<div class="wvd-pm-col-list">' + items + '</div></div>';
    }).join('');

    const auto =
      '<div class="wvd-pm-auto">' +
        '<div class="wvd-pm-auto-head">' +
          '<span class="wvd-pm-auto-title"><span class="wvd-pm-auto-bot">' + pmIcon('robot') + '</span>Automation layer</span>' +
          '<div class="wvd-pm-auto-stats">' +
            '<span class="wvd-pm-stat"><i class="wvd-pm-stat-dot"></i><b>' + total + '</b> robots total</span>' +
            '<span class="wvd-pm-stat">' + pmIcon('clock') + '<b>' + cron + '</b> scheduled cron</span>' +
            '<span class="wvd-pm-stat">' + pmIcon('bolt') + '<b>' + eventDriven + '</b> event-driven</span>' +
            '<span class="wvd-pm-stat">' + pmIcon('stack') + '<b>' + nativeCount + '</b> native / pending</span>' +
          '</div>' +
        '</div>' +
        '<div class="wvd-pm-robot-summary" id="wvdPmRobotSummary" aria-live="polite"></div>' +
        '<div class="wvd-pm-auto-grid">' + columns + '</div>' +
        '<p class="wvd-pm-note">Peelclear runs as its own separate pipeline on a deliberately slower clock: those buyers wait for finished-project photos, so weeks of quiet there is normal, not a leak. Map data updated ' + esc(PIPELINE_MAP.updated) + '. Click any stage for the full rules; tap a robot for its card: what it does and where it works on the board.</p>' +
      '</div>';

    const foot =
      '<div class="wvd-pm-foot"><span>Not on the board:</span>' +
        ghostStages.map((stage) => '<button type="button" class="wvd-pm-ghost-chip" data-wvd-stage="' + esc(stage.key) + '">' + esc(stage.name) + '</button>').join('') +
      '</div>';

    body.className = 'wvd-pm';
    body.innerHTML = legend + flow + grid + auto + foot;
  }

  function buildStageModalHtml(stage) {
    const court = pmCourt(stage);
    const listItems = (items) => items.map((item) => {
      const badge = item.kind === 'hidden' ? ' (hidden trap)' : item.kind === 'timer' ? ' (timer)' : '';
      return '<li>' + esc(item.text + badge) + '</li>';
    }).join('');
    const robotChips = pmStageRobots(stage)
      .map((key) => { const robot = PIPELINE_MAP.robots.find((entry) => entry.key === key); return pmJumpChip('robot', key, robot ? robot.name : key, ''); })
      .join('');
    const hasHiddenTrap = stage.exit.concat(stage.entry).some((item) => item.kind === 'hidden');
    return '<div class="wvd-modal-top"><h2 id="wvdProjectModalTitle">' + esc(stage.name) + '</h2>' +
      '<span class="wvd-status-pill" style="color:' + court.color + '">' + esc(court.label) + '</span></div>' +
      '<div class="wvd-modal-section"><div class="wvd-body-label">What this stage means</div><p class="wvd-modal-text">' + esc(stage.plain) + '</p></div>' +
      '<div class="wvd-modal-section"><div class="wvd-body-label">The clock</div><p class="wvd-modal-text">' + esc(stage.clock) + '</p></div>' +
      (stage.entry.length ? '<div class="wvd-modal-section"><div class="wvd-body-label">How leads get here</div><ul class="wvd-modal-list">' + listItems(stage.entry) + '</ul></div>' : '') +
      (stage.exit.length ? '<div class="wvd-modal-section' + (hasHiddenTrap ? ' wvd-urgent' : '') + '"><div class="wvd-body-label">How leads leave</div><ul class="wvd-modal-list">' + listItems(stage.exit) + '</ul></div>' : '') +
      (robotChips ? '<div class="wvd-modal-section"><div class="wvd-body-label">Robots touching this stage (tap one for its card)</div><div class="wvd-pm-jump-chips">' + robotChips + '</div></div>' : '') +
      (stage.human.do.length ? '<div class="wvd-modal-section"><div class="wvd-body-label">Do</div><ul class="wvd-modal-list">' + stage.human.do.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul></div>' : '') +
      (stage.human.dont.length ? '<div class="wvd-modal-section wvd-urgent"><div class="wvd-body-label">Never</div><ul class="wvd-modal-list">' + stage.human.dont.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul></div>' : '') +
      '<div class="wvd-modal-section"><div class="wvd-body-label">Technical</div><p class="wvd-modal-text" style="color:var(--wvd-faint);font-size:12px;">' +
        'Stage ID: ' + esc(stage.tech.stageId) +
        (stage.tech.signals.length ? '<br>Signals: ' + esc(stage.tech.signals.join(' · ')) : '') +
        (stage.tech.automations.length ? '<br>Automation notes: ' + esc(stage.tech.automations.join(' · ')) : '') +
      '</p></div>';
  }

  function openStageModal(key) {
    const stage = pmStage(key);
    if (!stage) return;
    openDetailModal(buildStageModalHtml(stage));
  }

  function pmJumpChip(kind, key, label, cls) {
    return '<button type="button" class="wvd-pm-jump' + (cls ? ' ' + cls : '') + '" data-wvd-' + kind + '-jump="' + esc(key) + '">' + esc(label) + '</button>';
  }

  function buildRobotModalHtml(robot) {
    const column = PM_UI.columns.find((col) => col.group === robot.group);
    const stageJump = (key, cls) => { const stage = pmStage(key); return pmJumpChip('stage', key, stage ? stage.name : key, cls); };
    const writes = robot.writes.map((key) => stageJump(key, 'wvd-pm-jump-w')).join('');
    const reads = robot.reads.filter((key) => robot.writes.indexOf(key) === -1).map((key) => stageJump(key, 'wvd-pm-jump-r')).join('');
    const alsoOn = PIPELINE_MAP.stages
      .filter((stage) => pmStageRobots(stage).indexOf(robot.key) !== -1 && robot.writes.indexOf(stage.key) === -1 && robot.reads.indexOf(stage.key) === -1)
      .map((stage) => stageJump(stage.key, '')).join('');
    const whereRows =
      (writes ? '<div class="wvd-pm-jump-row"><span class="wvd-pm-jump-label">Moves leads into</span><span class="wvd-pm-jump-chips">' + writes + '</span></div>' : '') +
      (reads ? '<div class="wvd-pm-jump-row"><span class="wvd-pm-jump-label">Reads</span><span class="wvd-pm-jump-chips">' + reads + '</span></div>' : '') +
      (alsoOn ? '<div class="wvd-pm-jump-row"><span class="wvd-pm-jump-label">Also on duty in</span><span class="wvd-pm-jump-chips">' + alsoOn + '</span></div>' : '');
    return '<div class="wvd-modal-top"><h2 id="wvdProjectModalTitle">' + esc(robot.name) + '</h2>' +
      '<span class="wvd-status-pill" style="color:' + (column ? column.color : 'var(--wvd-muted)') + '">' + esc(column ? column.label : robot.group) + '</span></div>' +
      '<div class="wvd-modal-section"><div class="wvd-body-label">What this robot does</div><p class="wvd-modal-text">' + esc(robot.plain) + '</p></div>' +
      '<div class="wvd-modal-section"><div class="wvd-body-label">When it runs</div><p class="wvd-modal-text">' + esc(robot.cadence) + '</p></div>' +
      '<div class="wvd-modal-section"><div class="wvd-body-label">Where it works on the board</div>' +
        (whereRows || '<p class="wvd-modal-text" style="color:var(--wvd-faint)">Not pinned to one stage: it works messages and contacts rather than board positions. The role above says where it acts.</p>') +
      '</div>';
  }

  function openRobotModal(key) {
    const robot = PIPELINE_MAP.robots.find((entry) => entry.key === key);
    if (!robot) return;
    if (activePipelineRobot !== key) setActiveRobot(key);
    openDetailModal(buildRobotModalHtml(robot));
  }

  function setActiveRobot(key) {
    const next = activePipelineRobot === key ? null : key;
    activePipelineRobot = next;
    const robot = next ? PIPELINE_MAP.robots.find((entry) => entry.key === next) : null;
    document.querySelectorAll('#wvdPipelineBody .wvd-pm-robot-chip').forEach((chip) => {
      chip.setAttribute('aria-pressed', chip.getAttribute('data-wvd-robot') === next ? 'true' : 'false');
    });
    document.querySelectorAll('#wvdPipelineBody [data-wvd-stage]').forEach((node) => {
      const stageKey = node.getAttribute('data-wvd-stage');
      node.classList.remove('wvd-pm-write', 'wvd-pm-read', 'wvd-pm-dimmed');
      if (!robot) return;
      if (robot.writes.indexOf(stageKey) !== -1) node.classList.add('wvd-pm-write');
      else if (robot.reads.indexOf(stageKey) !== -1) node.classList.add('wvd-pm-read');
      else node.classList.add('wvd-pm-dimmed');
    });
    const summary = $('wvdPmRobotSummary');
    if (summary) {
      if (robot) {
        summary.className = 'wvd-pm-robot-summary wvd-pm-on';
        summary.innerHTML = '<button type="button" class="wvd-pm-summary-clear" data-wvd-pm-clear aria-label="Clear the robot highlight"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg></button>' +
          '<strong>' + esc(robot.name) + '</strong> · ' + esc(robot.cadence) + ' · ' + esc(robot.plain) +
          '<span class="wvd-pm-rw">Green ring: stages it moves leads into. Blue ring: stages it reads. Faded: untouched. Clear with the ✕, the Esc key, or a click on any empty space.</span>';
      } else {
        summary.className = 'wvd-pm-robot-summary';
        summary.innerHTML = '';
      }
    }
  }

  function clearActiveRobot() {
    if (activePipelineRobot) setActiveRobot(activePipelineRobot);
  }

  function render() {
    if (!data) return;
    const allSessions = data.sessions || [];
    const waitingItems = data.waitingOnNoah || [];
    const waiting = waitingItems.length;
    const sessions = allSessions.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
    const latestDay = groupSessionsByDate(sessions)[0] || null;

    let latestHtml = '';
    if (latestDay) {
      const daySessions = latestDay.sessions;
      const dayIsToday = daysSince(latestDay.date) === 0;
      const dayOutcomes = daySessions.reduce((total, session) => total + sessionCount(session), 0);
      const dayDate = new Date(latestDay.date.length === 10 ? latestDay.date + 'T12:00:00' : latestDay.date);
      const dayTitle = isNaN(dayDate) ? esc(latestDay.date) : dayDate.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
      const dayCountLabel = daySessions.length + ' ' + (daySessions.length === 1 ? 'session' : 'sessions') + ' · ' + dayOutcomes + ' ' + (dayOutcomes === 1 ? 'outcome' : 'outcomes');

      const sessionBlocks = daySessions.map((session, index) => {
        const head = daySessions.length > 1
          ? '<div class="wvd-latest-session-head"><span class="wvd-latest-session-num">' + (index + 1) + '</span><h3>' + esc(session.title) + '</h3></div>'
          : '<h3 class="wvd-latest-session-solo">' + esc(session.title) + '</h3>';
        return '<article class="wvd-latest-session">' + head +
          '<div class="wvd-latest-groups">' +
            latestGroup('wvd-shipped', 'Shipped', session.shipped) +
            latestGroup('wvd-fixed', 'Fixed', session.fixed) +
            latestGroup('wvd-progress', 'In progress', session.inProgress) +
          '</div>' +
          (session.notes ? '<div class="wvd-latest-notes">Context: ' + esc(session.notes) + '</div>' : '') +
          '</article>';
      }).join('');

      latestHtml = '<section class="wvd-section wvd-panel wvd-latest wvd-anchor" id="wvd-latest-panel">' +
        '<div class="wvd-latest-head"><div class="wvd-latest-icon">' + icons.shipped + '</div>' +
        '<div class="wvd-latest-title"><span class="wvd-panel-title wvd-t-green">' + (dayIsToday ? 'Today’s work' : 'Most recent day') + '</span><h2>' + dayTitle + '</h2></div>' +
        '<span class="wvd-date-badge">' + dayCountLabel + '</span></div>' +
        sessionBlocks +
        '</section>';
    } else {
      latestHtml = '<div class="wvd-empty">No work sessions have been logged yet.</div>';
    }

    let waitingHtml = '<section class="wvd-section wvd-panel wvd-anchor" id="wvd-waiting-panel"><div class="wvd-panel-heading"><div><p class="wvd-eyebrow">Action queue</p><h2>Waiting on Noah</h2></div><span class="wvd-panel-meta">' + waiting + ' open ' + (waiting === 1 ? 'item' : 'items') + '</span></div>';
    if (waiting) {
      commandRegistry.length = 0;
      waitingHtml += '<div class="wvd-waiting-list">' + waitingItems.map((item) => {
        const age = daysSince(item.since);
        const steps = Array.isArray(item.whatToDo) ? item.whatToDo : [];
        const commands = normaliseCommands(item.commands);
        const hasBody = Boolean(item.impact) || steps.length > 0 || commands.length > 0;
        let card = '<details class="wvd-waiting-card"><summary><div class="wvd-waiting-copy"><h3>' + esc(item.item) + '</h3>' +
          (item.project ? '<div class="wvd-project-tag">' + esc(item.project) + '</div>' : '') +
          '</div><div class="wvd-waiting-side">' + (age !== null ? '<span class="wvd-age">' + age + 'd waiting</span>' : '') +
          (hasBody ? '<span class="wvd-open-hint">What to do</span>' : '') +
          '<svg class="wvd-waiting-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></div></summary>';
        if (hasBody) {
          card += '<div class="wvd-waiting-body">';
          if (item.impact) card += '<p class="wvd-impact">Why it matters: ' + esc(item.impact) + '</p>';
          if (steps.length) card += '<div><div class="wvd-body-label">What to do</div><ol class="wvd-steps">' + steps.map((step) => '<li>' + esc(step) + '</li>').join('') + '</ol></div>';
          card += commands.map((command) => {
            const registryIndex = commandRegistry.push(String(command.code || '')) - 1;
            return '<div class="wvd-cmd"><div class="wvd-cmd-head"><span>' + esc(command.label || 'Copy and paste') + '</span><button type="button" class="wvd-copy" data-wvd-copy="' + registryIndex + '">Copy</button></div><pre>' + esc(command.code || '') + '</pre></div>';
          }).join('');
          card += '</div>';
        }
        return card + '</details>';
      }).join('') + '</div>';
    } else {
      waitingHtml += '<div class="wvd-waiting-list"><div class="wvd-none">Nothing is waiting on Noah right now.</div></div>';
    }
    waitingHtml += '</section>';

    const systemFilters = [
      { key: 'all', label: 'All' },
      { key: 'live', label: 'Live' },
      { key: 'active', label: 'In flight', dot: 'var(--wvd-gold)' },
      { key: 'blocked', label: 'Blocked', dot: 'var(--wvd-red)' }
    ];
    let systemsHtml = '<section class="wvd-section wvd-panel wvd-anchor" id="wvd-systems-panel"><div class="wvd-panel-heading"><div><p class="wvd-eyebrow">Operating layer</p><h2>The automations</h2></div><div class="wvd-filter-tabs" aria-label="Filter systems">' +
      systemFilters.map((filter) => '<button type="button" data-wvd-filter="' + filter.key + '" class="' + (projectFilter === filter.key ? 'wvd-selected' : '') + '">' + (filter.dot ? '<span class="wvd-filter-dot" style="--wvd-filter-dot-color:' + filter.dot + '"></span>' : '') + filter.label + '</button>').join('') +
      '</div></div>' + healthLegendHtml() + '<div class="wvd-projects">';
    currentProjects = data.projects || [];
    systemsHtml += currentProjects.map((project, index) => {
      const status = String(project.status || '').toLowerCase();
      const filterGroup = status === 'live' ? 'live' : status === 'blocked' ? 'blocked' : 'active';
      const hidden = projectFilter !== 'all' && projectFilter !== filterGroup;
      const st = sysStatus(project);
      const projectDetail = project.detail || {};
      const percent = status !== 'live' ? checklistPercent(projectDetail.whatWasDone, projectDetail.whatsLeft) : null;
      const whatsLeft = Array.isArray(projectDetail.whatsLeft) ? projectDetail.whatsLeft : [];
      const whatWasDone = Array.isArray(projectDetail.whatWasDone) ? projectDetail.whatWasDone : [];

      let bodyHtml = '';
      if (st.atrisk && project.health && project.health.reason) {
        bodyHtml = '<div class="wvd-sys-block"><div class="wvd-sys-block-label">Risk</div><p class="wvd-sys-block-text">' + esc(project.health.reason) + '</p></div>';
      } else if (status !== 'live' && percent !== null) {
        const next = project.blockedOn || whatsLeft[0] || '';
        bodyHtml = miniProgressHtml(percent, { label: 'Progress' }) +
          (next ? '<div class="wvd-sys-block"><div class="wvd-sys-block-label">Next up</div><p class="wvd-sys-block-text">' + esc(next) + '</p></div>' : '');
      } else if (status !== 'live' && project.progress) {
        const stageLabel = { early: 'EARLY', underway: 'UNDERWAY', 'nearly-done': 'NEARLY DONE' }[project.progress.stage] || 'IN PROGRESS';
        const latest = whatWasDone[whatWasDone.length - 1] || '';
        bodyHtml = '<span class="wvd-sys-stage">' + esc(stageLabel) + '</span>' +
          (latest ? '<div class="wvd-sys-block"><div class="wvd-sys-block-label">Latest</div><p class="wvd-sys-block-text">' + esc(latest) + '</p></div>' : '');
      }

      const cardClass = 'wvd-project wvd-' + status + (st.atrisk ? ' wvd-atrisk' : '') + (hidden ? ' wvd-hidden' : '');
      return '<article class="' + cardClass + '" data-wvd-project-group="' + filterGroup + '" data-wvd-project-index="' + index + '" role="button" tabindex="0" aria-haspopup="dialog" aria-label="Open details for ' + esc(project.name) + '">' +
        '<div class="wvd-sys-head"><span class="wvd-sys-icon">' + sysIcon(project.id) + '</span><div class="wvd-sys-headtext"><span class="wvd-sys-pill"><span class="wvd-sys-dot"></span>' + esc(st.label) + '</span><h3 class="wvd-sys-title">' + esc(project.name) + '</h3></div></div>' +
        '<p class="wvd-project-summary">' + esc(project.summary || '') + '</p>' +
        bodyHtml +
        sysWatchers(project) +
        '<div class="wvd-sys-decoband">' + sysDeco(project.id) + '</div>' +
        sysFooter(data.updated) +
        '</article>';
    }).join('');
    systemsHtml += '</div></section>';

    let sessionsHtml = '<section class="wvd-section wvd-panel wvd-anchor"><div class="wvd-panel-heading"><span class="wvd-panel-title wvd-t-green">Tasha\'s Log</span><span class="wvd-panel-meta">Newest first · JST</span></div><div class="wvd-session-list">';
    if (!sessions.length) {
      sessionsHtml += '<div class="wvd-log-watermark"><strong>Fix in progress</strong>' +
        '<p>The log was cleared to free up storage space. The update has a problem and Tasha is fixing it now. ' +
        'Every past session is backed up, and new ones land here again once it is sorted.</p></div>';
      sessionsHtml += '</div></section>';
    } else {
      const dayGroups = groupSessionsByDate(sessions);
      const totalSessionPages = Math.max(1, Math.ceil(dayGroups.length / SESSIONS_PER_PAGE));
      if (sessionsPage > totalSessionPages) sessionsPage = totalSessionPages;
      const pageStart = (sessionsPage - 1) * SESSIONS_PER_PAGE;
      const pageGroups = dayGroups.slice(pageStart, pageStart + SESSIONS_PER_PAGE);
      sessionsHtml += pageGroups.map((group, index) => {
        const totalOutcomes = group.sessions.reduce((total, session) => total + sessionCount(session), 0);
        const count = group.sessions.length;
        const label = count === 1 ? esc(group.sessions[0].title) : count + ' sessions logged';
        return '<details class="wvd-session"' + (index < 1 && sessionsPage === 1 ? ' open' : '') + '><summary><span class="wvd-session-dot"></span><span class="wvd-session-date"><span class="wvd-session-weekday">' + esc(fmtWeekday(group.date)) + '</span>' + fmtDate(group.date) + '</span><span class="wvd-session-title">' + label + '</span><span class="wvd-session-meta"><span class="wvd-outcomes">' + totalOutcomes + ' ' + (totalOutcomes === 1 ? 'outcome' : 'outcomes') + '</span><span class="wvd-when">' + agoLabel(group.date) + '</span></span><svg class="wvd-session-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg></summary><div class="wvd-session-day-body">' +
          group.sessions.map(dayEntryHtml).join('') +
          '</div></details>';
      }).join('');
      sessionsHtml += '</div>' + paginationHtml(sessionsPage, totalSessionPages) + '</section>';
    }

    $('wvdLatestBody').innerHTML = latestHtml;
    $('wvdWaitingBody').innerHTML = waitingHtml;
    $('wvdSessionsBody').innerHTML = sessionsHtml;
    $('wvdSystemsBody').innerHTML = systemsHtml;
    renderNoahLog();
    /* Relative first, exact time in the tooltip. "Updated 6:20 PM" cannot tell you whether that is
       ten minutes or ten hours old without doing the arithmetic yourself, which is exactly how a
       two-hour-stale stamp went unnoticed. "Updated 2h ago" answers the only question this line is
       here to answer. The absolute time stays one hover away. */
    const updatedEl = $('wvdUpdated');
    if (updatedEl) {
      const ago = agoShort(data.updated);
      updatedEl.innerHTML = 'Updated <strong>' + esc(ago || fmtDateTime(data.updated)) + '</strong>';
      updatedEl.title = 'Published ' + fmtDateTime(data.updated);
    }
    $('wvdSourceCount').textContent = (data.projects || []).length + ' systems tracked';
    $('wvdFooter').innerHTML = '<span>' + icons.shipped + ' Dragon Auto internal record, maintained by Tasha</span><span>Published automatically at the end of each work session</span>';
  }

  async function load(manual, silent) {
    const refresh = $('wvdRefresh');
    const banner = $('wvdBanner');
    refresh.classList.add('wvd-spin');
    try {
      const response = await fetch(DATA_URL + '?t=' + Date.now(), { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const nextData = await response.json();
      if (!nextData || nextData.version !== 1) throw new Error('unexpected data version');
      data = nextData;
      lsSet(CACHE_KEY, JSON.stringify(nextData));
      await refreshPrivateData();
      mergePrivateIntoData();
      banner.classList.remove('wvd-show');
      render();
      if (manual) toast('Work record refreshed.', 'ok');
    } catch (error) {
      const cached = lsGet(CACHE_KEY);
      if (cached && !data) {
        try {
          data = JSON.parse(cached);
          await refreshPrivateData();
          mergePrivateIntoData();
          render();
          banner.textContent = 'Live data is unreachable. Showing the last copy from ' + fmtDateTime(data.updated) + '.';
          banner.classList.add('wvd-show');
        } catch (cacheError) { showLoadError(); }
      } else if (!data) {
        showLoadError();
      } else if (!silent) {
        toast('Could not refresh. The current screen still shows ' + fmtDateTime(data.updated) + '.', 'err');
      }
    } finally {
      refresh.classList.remove('wvd-spin');
      // Release anyone waiting to sign in, whether the fetch succeeded or failed.
      if (dataReadyResolve) { dataReadyResolve(); dataReadyResolve = null; }
    }
  }

  function showLoadError() {
    $('wvdLatestBody').innerHTML = '<div class="wvd-empty"><div>The work record could not be loaded.<br><button type="button" id="wvdRetry">Try again</button></div></div>';
    $('wvdUpdated').textContent = 'Offline';
    const retry = $('wvdRetry');
    if (retry) retry.addEventListener('click', () => load(true));
  }

  function setSidebar(open) {
    $('wvdSidebar').classList.toggle('wvd-sidebar-open', open);
    $('wvdScrim').classList.toggle('wvd-show', open);
  }

  function setLock(on) {
    [document.documentElement, document.body].forEach((node) => {
      if (!node) return;
      node.style.setProperty('height', on ? '100vh' : 'auto', 'important');
      if (on && window.CSS && CSS.supports && CSS.supports('height', '100dvh')) node.style.setProperty('height', '100dvh', 'important');
      node.style.setProperty('overflow', on ? 'hidden' : 'visible', 'important');
    });
  }

  function handleGridClick(event) {
    const copyButton = event.target.closest('[data-wvd-copy]');
    if (copyButton) { copyCommand(copyButton); return; }
    const filterButton = event.target.closest('[data-wvd-filter]');
    if (filterButton) {
      projectFilter = filterButton.getAttribute('data-wvd-filter') || 'all';
      render();
      return;
    }
    const projectCard = event.target.closest('[data-wvd-project-index]');
    if (projectCard) openProjectModal(Number(projectCard.getAttribute('data-wvd-project-index')));
  }
  function handleGridKeydown(event) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const projectCard = event.target.closest('[data-wvd-project-index]');
    if (projectCard) { event.preventDefault(); openProjectModal(Number(projectCard.getAttribute('data-wvd-project-index'))); }
  }
  function handleSessionsPageClick(event) {
    const navButton = event.target.closest('[data-wvd-page-nav]');
    if (navButton) {
      if (navButton.disabled) return;
      sessionsPage += navButton.getAttribute('data-wvd-page-nav') === 'prev' ? -1 : 1;
      render();
      return;
    }
    const numButton = event.target.closest('[data-wvd-page-num]');
    if (numButton) {
      sessionsPage = Number(numButton.getAttribute('data-wvd-page-num'));
      render();
    }
  }
  const sessionsBodyEl = $('wvdSessionsBody');
  if (sessionsBodyEl) sessionsBodyEl.addEventListener('click', handleSessionsPageClick);
  const waitingBodyEl = $('wvdWaitingBody');
  if (waitingBodyEl) waitingBodyEl.addEventListener('click', handleGridClick);
  const systemsBodyEl = $('wvdSystemsBody');
  if (systemsBodyEl) {
    systemsBodyEl.addEventListener('click', handleGridClick);
    systemsBodyEl.addEventListener('keydown', handleGridKeydown);
  }
  const projectModalOverlay = $('wvdProjectModalOverlay');
  const projectModalClose = $('wvdProjectModalClose');
  if (projectModalClose) projectModalClose.addEventListener('click', closeProjectModal);
  if (projectModalOverlay) {
    projectModalOverlay.addEventListener('click', (event) => {
      if (event.target === projectModalOverlay) closeProjectModal();
    });
  }

  function markNavActive(name) {
    document.querySelectorAll('[data-wvd-nav]').forEach((item) => {
      item.classList.toggle('wvd-active', item.getAttribute('data-wvd-page') === name);
    });
  }
  function goToPage(name) {
    markNavActive(name);
    showPage(name);
  }

  document.querySelectorAll('[data-wvd-nav]').forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      goToPage(link.getAttribute('data-wvd-page'));
      setSidebar(false);
    });
  });
  const menuSessions = $('wvdMenuSessions');
  if (menuSessions) menuSessions.addEventListener('click', () => setSidebar(true));
  const menuSystems = $('wvdMenuSystems');
  if (menuSystems) menuSystems.addEventListener('click', () => setSidebar(true));
  const menuLatest = $('wvdMenuLatest');
  if (menuLatest) menuLatest.addEventListener('click', () => setSidebar(true));
  const menuWaiting = $('wvdMenuWaiting');
  if (menuWaiting) menuWaiting.addEventListener('click', () => setSidebar(true));
  const menuNoahLog = $('wvdMenuNoahLog');
  if (menuNoahLog) menuNoahLog.addEventListener('click', () => setSidebar(true));
  const noahLogBodyEl = $('wvdNoahLogBody');
  if (noahLogBodyEl) {
    noahLogBodyEl.addEventListener('click', function (event) {
      if (!event.target.closest) return;
      if (event.target.closest('[data-nlog="collapse"]')) { nlogDayMode = nlogDayMode === 'collapsed' ? 'expanded' : (nlogDayMode === 'expanded' ? 'collapsed' : 'collapsed'); renderNoahLog(); return; }
    });
  }

  const menuPipeline = $('wvdMenuPipeline');
  if (menuPipeline) menuPipeline.addEventListener('click', () => setSidebar(true));
  const pipelineBodyEl = $('wvdPipelineBody');
  if (pipelineBodyEl) {
    pipelineBodyEl.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-wvd-robot]');
      if (chip) { openRobotModal(chip.getAttribute('data-wvd-robot')); return; }
      const node = event.target.closest('[data-wvd-stage]');
      if (node) { openStageModal(node.getAttribute('data-wvd-stage')); return; }
      if (event.target.closest('[data-wvd-pm-clear]')) { clearActiveRobot(); return; }
      if (event.target.closest('#wvdPmRobotSummary')) return;
      clearActiveRobot();
    });
    pipelineBodyEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const node = event.target.closest('[data-wvd-stage]');
      if (node) { event.preventDefault(); openStageModal(node.getAttribute('data-wvd-stage')); }
    });
  }

  const projectModalBodyEl = $('wvdProjectModalBody');
  if (projectModalBodyEl) {
    projectModalBodyEl.addEventListener('click', (event) => {
      const stageJump = event.target.closest('[data-wvd-stage-jump]');
      if (stageJump) { openStageModal(stageJump.getAttribute('data-wvd-stage-jump')); return; }
      const robotJump = event.target.closest('[data-wvd-robot-jump]');
      if (robotJump) openRobotModal(robotJump.getAttribute('data-wvd-robot-jump'));
    });
  }

  // Sign-in wiring. Enter must never bubble as an implicit submit: inside GHL this markup
  // sits inside GHL's own <form>, and a stray submit reloads the page mid-sign-in.
  const loginNoahBtn = $('wvdLoginAsNoah');
  if (loginNoahBtn) loginNoahBtn.addEventListener('click', () => setLoginRole('noah'));
  const loginTashaBtn = $('wvdLoginAsTasha');
  if (loginTashaBtn) loginTashaBtn.addEventListener('click', () => setLoginRole('tasha'));
  const loginSubmitBtn = $('wvdLoginSubmit');
  if (loginSubmitBtn) loginSubmitBtn.addEventListener('click', handleLoginSubmit);
  const loginPassInput = $('wvdLoginPass');
  if (loginPassInput) {
    loginPassInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); handleLoginSubmit(); }
    });
  }
  const loginResetLink = $('wvdLoginReset');
  if (loginResetLink) loginResetLink.addEventListener('click', () => enterCreateMode(true));
  const signOutControl = $('wvdSignOut');
  if (signOutControl) signOutControl.addEventListener('click', signOut);
  $('wvdSidebarClose').addEventListener('click', () => setSidebar(false));
  $('wvdScrim').addEventListener('click', () => setSidebar(false));
  $('wvdRefresh').addEventListener('click', () => load(true));
  window.addEventListener('beforeprint', () => setLock(false));
  window.addEventListener('afterprint', () => setLock(false));

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setSidebar(false);
      const overlay = $('wvdProjectModalOverlay');
      if (overlay && !overlay.hidden) closeProjectModal();
      else clearActiveRobot();
    }
  });

  // Casual deterrent only: stops the right-click menu and the common DevTools/
  // view-source shortcuts. Anyone using the browser's own menu (⋮ > More tools >
  // Developer tools) still gets in -- there is no way to block that from the page.
  document.addEventListener('contextmenu', (event) => event.preventDefault());
  document.addEventListener('keydown', (event) => {
    const combo = event.metaKey || event.ctrlKey;
    if (event.key === 'F12') { event.preventDefault(); return; }
    if (combo && event.shiftKey && ['i', 'j', 'c'].includes(event.key.toLowerCase())) { event.preventDefault(); return; }
    if (combo && event.key.toLowerCase() === 'u') { event.preventDefault(); return; }
  });

  // Fully responsive: the layout reflows via CSS breakpoints, so there is no zoom
  // scaling to apply here anymore.
  renderPipelineMap();
  purgeLegacyPlaintextCache();
  initAuth();
  load(false);
})();
