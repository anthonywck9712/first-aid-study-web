/* Account UI and isolated practice synchronisation. Loaded after app.js and exam.js. */
(() => {
  'use strict';
  const AUTH_KEY = 'firstaid-account-session-v1';
  const GUEST_KEY = 'firstaid-progress-v1';
  const PRIVATE_PREFIX = 'firstaid-account-progress-v1:';
  const USERNAME = /^[a-z0-9_.-]{3,40}$/;
  let epoch = 0, screenGeneration = 0, syncTimer = null, syncingPromise = null;
  let revision = 0, dirty = false, authBusy = false, formMode = 'login';
  let guestProgress = cleanProgress(readJSON(localStorage, GUEST_KEY, {}));
  let historyRows = [], historyOffset = 0, historyNext = null, historyBusy = false;
  let historyGeneration = 0, readyEpoch = -1;

  const state = window.ACCOUNT = {
    user: null, token: null, expiresAt: null, ready: false,
    syncing: false, syncStatus: '正在確認登入狀態⋯', lastSyncAt: null,
    error: '', notice: '',
  };

  function readJSON(storage, key, fallback) {
    try { return JSON.parse(storage.getItem(key) || 'null') ?? fallback; } catch { return fallback; }
  }
  function writeJSON(storage, key, value) {
    try { storage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  }
  function remove(storage, key) { try { storage.removeItem(key); } catch {} }
  function cleanProgress(raw) {
    const clean = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return clean;
    for (const [id, record] of Object.entries(raw)) {
      if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) continue;
      if (!record || typeof record !== 'object' || typeof record.correct !== 'boolean') continue;
      let value = record.value;
      if (typeof value === 'string') value = value.slice(0, 500);
      else if (typeof value === 'number') { if (!Number.isFinite(value)) continue; }
      else if (Array.isArray(value)) {
        if (value.length > 15 || value.some(item => typeof item !== 'string')) continue;
        value = value.map(item => item.slice(0, 500));
      } else if (value !== undefined && value !== null) continue;
      const at = typeof record.at === 'string' && Number.isFinite(Date.parse(record.at)) && Date.parse(record.at) >= 0
        ? new Date(record.at).toISOString() : '1970-01-01T00:00:00.000Z';
      clean[id] = { correct: record.correct, value: value ?? null, at };
    }
    return clean;
  }
  function mergeProgress(first, second) {
    const merged = cleanProgress(first);
    for (const [id, record] of Object.entries(cleanProgress(second))) {
      if (!merged[id] || Date.parse(record.at) >= Date.parse(merged[id].at)) merged[id] = record;
    }
    return merged;
  }
  function validUser(user) {
    return !!user && typeof user === 'object'
      && (typeof user.id === 'string' || typeof user.id === 'number')
      && String(user.id).length > 0 && String(user.id).length <= 160
      && typeof user.username === 'string' && USERNAME.test(user.username)
      && typeof user.displayName === 'string' && user.displayName.trim().length >= 1
      && user.displayName.length <= 60;
  }
  function privateKey(user) { return PRIVATE_PREFIX + encodeURIComponent(String(user.id)); }
  function currentProgress() { return cleanProgress(progress); }
  function setProgress(value) { progress = cleanProgress(value); }
  function restoreGuestKey() { writeJSON(localStorage, GUEST_KEY, guestProgress); }
  function cachePrivateProgress() {
    if (state.user) writeJSON(sessionStorage, privateKey(state.user), {
      progress: currentProgress(), dirty, lastSyncAt: state.lastSyncAt,
    });
  }
  function persistAuth() {
    if (state.user && state.token) return writeJSON(sessionStorage, AUTH_KEY, {
      user: state.user, token: state.token, expiresAt: state.expiresAt,
    });
    remove(sessionStorage, AUTH_KEY);
    return true;
  }
  function sameIdentity(generation, id) {
    return epoch === generation && state.user && String(state.user.id) === String(id);
  }
  function isAccountView() { return typeof mode !== 'undefined' && mode === 'account'; }
  function text(id, value) { const target = document.getElementById(id); if (target) target.textContent = value; }
  function dateText(value) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-HK') : '尚未同步';
  }
  function serverTime(value) {
    const date = new Date(value);
    return (typeof value === 'string' || typeof value === 'number') && Number.isFinite(date.getTime()) ? date.toISOString() : new Date().toISOString();
  }
  function durationText(value) {
    const seconds = Math.max(0, Math.floor(Number(value) / 1000));
    return Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : '—';
  }
  function headerStatus() {
    const tab = document.getElementById('accountTab');
    if (!tab) return;
    tab.textContent = state.user ? '我的帳戶' : '登入／註冊';
    tab.setAttribute('title', state.user ? `${state.user.displayName}：${state.syncStatus}` : '登入以同步練習進度與個人測驗紀錄');
    tab.onclick = () => switchMode('account');
    let badge = document.getElementById('accountSyncStatus');
    if (!badge) {
      badge = document.createElement('span'); badge.id = 'accountSyncStatus';
      badge.className = 'caption'; badge.setAttribute('role', 'status'); badge.setAttribute('aria-live', 'polite');
      badge.style.alignSelf = 'center'; tab.insertAdjacentElement('afterend', badge);
    }
    badge.textContent = state.user ? state.syncStatus : (state.ready ? '請先登入' : '正在確認登入⋯');
    text('accountSyncMessage', state.syncStatus);
    text('accountLastSync', state.lastSyncAt ? dateText(state.lastSyncAt) : '尚未同步');
    const count = Object.values(currentProgress());
    text('accountAnsweredCount', count.length);
    text('accountCorrectCount', count.filter(item => item.correct).length);
    text('accountWrongCount', count.filter(item => !item.correct).length);
    const retry = document.getElementById('accountSyncNow');
    if (retry) retry.disabled = state.syncing || authBusy;
  }
  function notifyIdentity(previous) {
    window.dispatchEvent(new CustomEvent('account:change', { detail: {
      user: state.user, previousUserId: previous ? String(previous.id) : null,
    } }));
  }
  function emitReady() {
    if (!state.ready || !state.user || readyEpoch === epoch) return;
    readyEpoch = epoch;
    window.dispatchEvent(new CustomEvent('account:ready', { detail: { user: state.user } }));
  }
  function errorText(error) {
    if (error?.name === 'AbortError') return '帳戶服務回應逾時，請稍後再試。';
    if (error instanceof TypeError || !error?.message) return '未能連接帳戶服務。請確認網路連線及網站的帳戶服務設定。';
    return String(error.message).slice(0, 500);
  }
  async function request(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), window.PRIVATE_RELAY ? 75000 : 15000);
    try { return await api('/api/account' + path, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timeout); }
  }
  function clearIdentity(message) {
    const previous = state.user;
    epoch++; clearTimeout(syncTimer); syncTimer = null; syncingPromise = null;
    cachePrivateProgress();
    state.user = null; state.token = null; state.expiresAt = null; state.ready = true;
    state.syncing = false; state.syncStatus = '請先登入'; state.lastSyncAt = null;
    state.error = ''; state.notice = message || '';
    dirty = false; revision = 0; authBusy = false;
    historyRows = []; historyNext = null; historyBusy = false; historyGeneration++;
    remove(sessionStorage, AUTH_KEY);
    setProgress(guestProgress); restoreGuestKey();
    notifyIdentity(previous); headerStatus();
    if (isAccountView()) renderAccountHome();
  }
  function handleExpired(error) {
    if (Number(error?.status) !== 401 || !state.user || !state.token) return false;
    clearIdentity('登入已到期。請重新登入以讀取教材及繼續同步帳戶紀錄。');
    return true;
  }

  window.handleAccountExpired = handleExpired;

  window.queueProgressSync = function queueProgressSync() {
    if (!state.user || !state.token) {
      guestProgress = currentProgress(); restoreGuestKey(); return;
    }
    // The original practice save() must not leave private progress in the guest key.
    restoreGuestKey();
    revision++; dirty = true; cachePrivateProgress();
    state.syncStatus = navigator.onLine === false ? '離線，等待同步' : '等待同步';
    headerStatus(); clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, 500);
  };

  async function syncNow() {
    if (!state.user || !state.token || !state.ready) return false;
    if (syncingPromise) return syncingPromise;
    const generation = epoch, userId = state.user.id, sentRevision = revision;
    const snapshot = currentProgress();
    state.syncing = true; state.syncStatus = '正在同步⋯'; state.error = ''; headerStatus();
    syncingPromise = (async () => {
      try {
        const data = await request('/progress', { method: 'PUT', body: JSON.stringify({ progress: snapshot }) });
        if (!sameIdentity(generation, userId)) return false;
        if (!data || !data.progress || typeof data.progress !== 'object' || Array.isArray(data.progress)) {
          throw new Error('帳戶服務傳回的進度格式不正確，請稍後重試。');
        }
        const latest = currentProgress(), changed = {};
        for (const [id, record] of Object.entries(latest)) {
          if (JSON.stringify(record) !== JSON.stringify(snapshot[id])) changed[id] = record;
        }
        // The merged server response is authoritative for sent records, including
        // clock correction and timestamp ties. Keep only answers changed in flight.
        setProgress(sentRevision === revision ? data.progress : mergeProgress(data.progress, changed));
        dirty = sentRevision !== revision;
        state.lastSyncAt = serverTime(data.serverTime);
        state.syncStatus = dirty ? '等待同步' : '已同步'; state.error = '';
        cachePrivateProgress(); restoreGuestKey(); return true;
      } catch (error) {
        if (!sameIdentity(generation, userId)) return false;
        if (handleExpired(error)) return false;
        dirty = true; state.error = errorText(error);
        state.syncStatus = navigator.onLine === false ? '離線，等待同步' : '未同步，請重試';
        cachePrivateProgress(); return false;
      } finally {
        if (sameIdentity(generation, userId)) {
          state.syncing = false; syncingPromise = null; headerStatus();
          text('accountRequestError', state.error);
          if (dirty && sentRevision !== revision) {
            clearTimeout(syncTimer); syncTimer = setTimeout(() => { syncTimer = null; syncNow(); }, 500);
          }
        }
      }
    })();
    return syncingPromise;
  }
  window.syncAccountProgress = syncNow;

  async function loadPrivateProgress(generation, userId) {
    const data = await request('/progress');
    if (!sameIdentity(generation, userId)) return;
    if (!data?.progress || typeof data.progress !== 'object' || Array.isArray(data.progress)) {
      throw new Error('帳戶服務傳回的進度格式不正確。');
    }
    setProgress(dirty ? mergeProgress(data.progress, currentProgress()) : data.progress);
    state.lastSyncAt = serverTime(data.serverTime);
    state.syncStatus = dirty ? '等待同步' : '已同步'; state.error = '';
    state.ready = true; cachePrivateProgress(); restoreGuestKey(); headerStatus(); emitReady();
    if (dirty) syncNow();
  }
  function adoptUser(user, token, expiresAt) {
    const previous = state.user;
    // Save only guest work here; account-to-account changes never copy progress.
    if (!previous) { guestProgress = currentProgress(); restoreGuestKey(); }
    epoch++; clearTimeout(syncTimer); syncingPromise = null;
    state.user = { id: user.id, username: user.username, displayName: user.displayName };
    state.token = token; state.expiresAt = expiresAt || null; state.ready = false;
    state.error = ''; state.notice = ''; state.syncing = false; state.syncStatus = '正在讀取帳戶進度⋯';
    const cached = readJSON(sessionStorage, privateKey(user), {});
    setProgress(cached.progress); dirty = cached.dirty === true; revision = 0;
    state.lastSyncAt = typeof cached.lastSyncAt === 'string' ? cached.lastSyncAt : null;
    persistAuth(); historyRows = []; historyNext = null; historyGeneration++;
    notifyIdentity(previous); headerStatus();
    return epoch;
  }
  async function authenticate(form, registering) {
    if (authBusy) return;
    const username = form.elements.username.value.trim().toLowerCase();
    const password = form.elements.password.value;
    const displayName = registering ? form.elements.displayName.value.trim() : '';
    const registrationCode = registering ? form.elements.registrationCode.value : '';
    if (registering && !registrationCode) { text('accountFormStatus', '請輸入註冊存取碼。'); return; }
    if (!USERNAME.test(username)) { text('accountFormStatus', '用戶名稱須為 3–40 個小寫英文字母、數字、底線、句點或連字號。'); return; }
    if (password.length < 12 || password.length > 128) { text('accountFormStatus', '密碼須為 12–128 個字元。'); return; }
    if (registering && (!displayName || displayName.length > 60)) { text('accountFormStatus', '顯示名稱須為 1–60 個字元。'); return; }
    authBusy = true;
    form.querySelectorAll('button,input').forEach(input => input.disabled = true);
    text('accountFormStatus', registering ? '正在建立帳戶⋯' : '正在登入⋯');
    const generation = epoch;
    try {
      const data = await request(registering ? '/register' : '/login', {
        method: 'POST', body: JSON.stringify(registering ? { username, password, displayName, registrationCode } : { username, password }),
      });
      if (generation !== epoch) return;
      if (!validUser(data?.user) || typeof data.token !== 'string' || !data.token || data.token.length > 8192) {
        throw new Error('帳戶服務傳回的登入資料不正確。');
      }
      form.elements.password.value = '';
      if (form.elements.registrationCode) form.elements.registrationCode.value = '';
      const activeGeneration = adoptUser(data.user, data.token, data.expiresAt);
      try { await loadPrivateProgress(activeGeneration, data.user.id); }
      catch (error) {
        if (!sameIdentity(activeGeneration, data.user.id)) return;
        if (handleExpired(error)) return;
        state.ready = true; state.error = errorText(error); state.syncStatus = '進度未讀取，請重試'; emitReady();
      }
      if (sameIdentity(activeGeneration, data.user.id)) {
        state.notice = registering ? '帳戶已建立，可以開始閱讀教材及練習。' : '已登入。此處顯示帳戶的個人紀錄。';
        if (isAccountView()) renderAccountHome();
      }
    } catch (error) {
      if (generation === epoch) {
        text('accountFormStatus', errorText(error));
        form.querySelectorAll('button,input').forEach(input => input.disabled = false);
      }
    } finally { authBusy = false; headerStatus(); }
  }
  async function logout() {
    if (!state.user || authBusy) return;
    authBusy = true; headerStatus();
    const generation = epoch;
    text('accountRequestError', '正在儲存及登出⋯');
    if (dirty) await syncNow();
    if (epoch !== generation || !state.user) { authBusy = false; return; }
    let remoteError = '';
    try { await request('/logout', { method: 'POST', body: '{}' }); }
    catch (error) { remoteError = errorText(error); }
    if (epoch !== generation) return;
    const unsynced = dirty;
    clearIdentity(unsynced
      ? '已在此瀏覽器登出。尚未同步的帳戶進度保留在此分頁，重新登入同一帳戶後可再試。'
      : '已登出。重新登入後可繼續閱讀教材及研習。');
    if (remoteError) { state.notice += ' 線上登出未獲確認；此瀏覽器的登入憑證已清除。'; if (isAccountView()) renderAccountHome(); }
  }
  function importGuest() {
    if (!state.user || !state.ready || authBusy) return;
    const imported = cleanProgress(guestProgress);
    if (!Object.keys(imported).length) return;
    setProgress(mergeProgress(currentProgress(), imported));
    state.notice = '已合併訪客練習紀錄，正準備同步；同一題保留較新的答案。';
    window.queueProgressSync();
    if (isAccountView()) renderAccountHome();
  }

  window.renderAccountHome = function renderAccountHome() {
    const generation = ++screenGeneration;
    const app = document.getElementById('app');
    if (!app) return;
    headerStatus();
    if (!state.ready && !state.user) {
      app.innerHTML = '<div class="quiz-layout"><h1>正在確認登入狀態。</h1><p role="status">請稍候⋯</p></div>';
      return;
    }
    if (!state.user) {
      const registering = formMode === 'register';
      app.innerHTML = `<div class="quiz-layout"><h1>${registering ? '建立你的研習帳戶。' : '登入，接續你的研習。'}</h1><p class="lead">在不同裝置登入同一帳戶，即可同步練習進度及查看自己的測驗紀錄。</p>${state.notice ? `<p class="missing-note" role="status">${esc(state.notice)}</p>` : ''}<div class="question"><div class="toolbar"><button id="accountLoginMode" class="${registering ? '' : 'primary'}">登入</button><button id="accountRegisterMode" class="${registering ? 'primary' : ''}">註冊</button></div><form id="accountForm"><p><label for="accountUsername">用戶名稱（3–40 個字元）</label><input class="fill" id="accountUsername" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" minlength="3" maxlength="40" required aria-describedby="usernameHelp"></p><p class="caption" id="usernameHelp">使用英文字母、數字、底線 _、句點 . 或連字號 -；英文字母會轉為小寫。</p>${registering ? '<p><label for="accountRegistrationCode">註冊存取碼</label><input class="fill" id="accountRegistrationCode" name="registrationCode" type="password" autocomplete="off" maxlength="128" required></p><p><label for="accountDisplayName">顯示名稱</label><input class="fill" id="accountDisplayName" name="displayName" autocomplete="nickname" maxlength="60" required></p>' : ''}<p><label for="accountPassword">密碼（12–128 個字元）</label><input class="fill" id="accountPassword" name="password" type="password" autocomplete="${registering ? 'new-password' : 'current-password'}" minlength="12" maxlength="128" required></p><button class="primary" type="submit">${registering ? '建立帳戶' : '登入'}</button><p id="accountFormStatus" role="status" aria-live="polite"></p></form><p class="caption">登入憑證只保存在此瀏覽器分頁的工作階段；登出會清除憑證並關閉教材。舊有裝置練習紀錄如需匯入，可在登入後選擇。</p></div><p class="caption">教材、練習、測驗及成績均須登入後使用。註冊需要由管理員提供的存取碼。</p></div>`;
      document.getElementById('accountLoginMode').onclick = () => { formMode = 'login'; renderAccountHome(); };
      document.getElementById('accountRegisterMode').onclick = () => { formMode = 'register'; renderAccountHome(); };
      document.getElementById('accountForm').onsubmit = event => { event.preventDefault(); authenticate(event.currentTarget, registering); };
      return;
    }
    const count = Object.values(currentProgress());
    const guestCount = Object.keys(guestProgress).length;
    app.innerHTML = `<div class="quiz-layout"><h1>${esc(state.user.displayName)}的研習紀錄</h1><p class="lead">用戶名稱：${esc(state.user.username)}。帳戶進度與訪客紀錄獨立儲存。</p>${state.notice ? `<p class="missing-note" role="status">${esc(state.notice)}</p>` : ''}<div class="stats"><div><strong id="accountAnsweredCount">${count.length}</strong>已練習</div><div><strong id="accountCorrectCount">${count.filter(item => item.correct).length}</strong>最近答對</div><div><strong id="accountWrongCount">${count.filter(item => !item.correct).length}</strong>待重溫</div></div><div class="question"><h2>練習進度同步</h2><p id="accountSyncMessage" role="status" aria-live="polite">${esc(state.syncStatus)}</p><p class="caption">最近同步：<span id="accountLastSync">${state.lastSyncAt ? esc(dateText(state.lastSyncAt)) : '尚未同步'}</span></p><p id="accountRequestError" role="status">${esc(state.error)}</p><div class="toolbar"><button id="accountSyncNow" class="primary" ${state.syncing ? 'disabled' : ''}>立即同步</button><button id="accountPractice">繼續練習</button><button id="accountSignOut">登出</button></div><details><summary>匯入此裝置的訪客練習（${guestCount} 題）</summary><p>只有按下以下按鈕，才會把本裝置的訪客練習合併到目前帳戶。同一題會保留時間較新的答案；訪客原有紀錄仍然保留。</p><button id="accountImportGuest" ${guestCount && state.ready ? '' : 'disabled'}>將 ${guestCount} 題訪客紀錄合併到 ${esc(state.user.displayName)}的帳戶</button></details></div><h2>我的測驗紀錄</h2><p class="caption">此處只顯示目前帳戶的個人成績。</p><div class="toolbar"><button id="accountHistoryRefresh">重新載入紀錄</button><button id="accountExam">開始 30 題測驗</button></div><div class="table-wrap"><table><thead><tr><th>姓名</th><th>分數</th><th>總用時</th><th>平均秒／題</th><th>完成時間</th></tr></thead><tbody id="accountHistoryBody"></tbody></table></div><p id="accountHistoryStatus" role="status"></p><button id="accountHistoryMore" class="hidden">載入更多</button></div>`;
    document.getElementById('accountSyncNow').onclick = async () => {
      const activeGeneration = epoch, id = state.user.id;
      if (!state.ready) state.ready = true;
      if (dirty) await syncNow();
      else {
        state.syncStatus = '正在讀取最新進度⋯'; headerStatus();
        try { await loadPrivateProgress(activeGeneration, id); }
        catch (error) { if (sameIdentity(activeGeneration, id) && !handleExpired(error)) { state.error = errorText(error); state.syncStatus = '未同步，請重試'; headerStatus(); text('accountRequestError', state.error); } }
      }
    };
    document.getElementById('accountSignOut').onclick = logout;
    document.getElementById('accountPractice').onclick = () => switchMode('quiz');
    document.getElementById('accountExam').onclick = () => switchMode('exam');
    document.getElementById('accountImportGuest').onclick = importGuest;
    document.getElementById('accountHistoryRefresh').onclick = () => refreshHistory();
    document.getElementById('accountHistoryMore').onclick = () => loadHistory();
    paintHistory(); refreshHistory(generation);
  };

  function paintHistory() {
    const body = document.getElementById('accountHistoryBody');
    if (!body) return;
    body.innerHTML = historyRows.map(row => {
      const total = Number(row.total), score = Number(row.score);
      const elapsed = Number(row.elapsed_ms ?? row.elapsedMs);
      const completed = row.completed_at ?? row.completedAt;
      return `<tr><td>${esc(row.name || state.user?.displayName || '')}</td><td>${Number.isFinite(score) ? esc(score) : '—'} / ${total > 0 ? esc(total) : '—'}</td><td>${durationText(elapsed)}</td><td>${Number.isFinite(elapsed) && total > 0 ? (elapsed / 1000 / total).toFixed(1) : '—'}</td><td>${esc(dateText(completed))}</td></tr>`;
    }).join('');
    const more = document.getElementById('accountHistoryMore');
    if (more) { more.classList.toggle('hidden', historyNext === null); more.disabled = historyBusy; }
  }
  function refreshHistory() {
    historyGeneration++; historyRows = []; historyOffset = 0; historyNext = null; historyBusy = false;
    paintHistory(); return loadHistory();
  }
  async function loadHistory() {
    if (!state.user || historyBusy) return;
    const generation = epoch, userId = state.user.id, listGeneration = historyGeneration;
    const offset = historyOffset;
    historyBusy = true; text('accountHistoryStatus', '正在讀取個人成績⋯'); paintHistory();
    try {
      const data = await request('/history?offset=' + encodeURIComponent(offset));
      if (!sameIdentity(generation, userId) || historyGeneration !== listGeneration || !isAccountView()) return;
      const rows = Array.isArray(data?.results) ? data.results : Array.isArray(data?.history) ? data.history : null;
      if (!rows) throw new Error('帳戶服務傳回的測驗紀錄格式不正確。');
      const seen = new Set(historyRows.map(row => String(row.id ?? JSON.stringify(row))));
      for (const row of rows) {
        if (!row || typeof row !== 'object') continue;
        const key = String(row.id ?? JSON.stringify(row));
        if (!seen.has(key)) { historyRows.push(row); seen.add(key); }
      }
      historyNext = Number.isInteger(data.nextOffset) && data.nextOffset > offset ? data.nextOffset : null;
      historyOffset = historyNext;
      text('accountHistoryStatus', historyRows.length ? `已載入 ${historyRows.length} 筆個人紀錄。` : '尚未有已完成的個人測驗。');
    } catch (error) {
      if (!sameIdentity(generation, userId) || historyGeneration !== listGeneration) return;
      if (!handleExpired(error)) text('accountHistoryStatus', errorText(error));
    } finally {
      if (sameIdentity(generation, userId) && historyGeneration === listGeneration) { historyBusy = false; paintHistory(); }
    }
  }

  async function initialize() {
    if (window.BACKEND_PRIVATE) { state.ready = true; state.syncStatus = '請前往私人學習空間'; headerStatus(); return; }
    if (window.PRIVATE_RELAY && !window.PRIVATE_CONNECTION?.connected) {
      state.ready = true; state.notice = '請先連接私人服務，再登入研習帳戶。';
      headerStatus(); if (isAccountView()) renderAccountHome(); return;
    }
    const saved = readJSON(sessionStorage, AUTH_KEY, null);
    if (!saved || typeof saved.token !== 'string' || !saved.token || saved.token.length > 8192) {
      state.ready = true; headerStatus(); if (isAccountView()) renderAccountHome(); return;
    }
    // A stored token is verified before any cached private practice is displayed.
    state.token = saved.token; state.expiresAt = saved.expiresAt || null;
    const generation = epoch;
    try {
      const data = await request('/me');
      if (generation !== epoch) return;
      if (!validUser(data?.user)) throw new Error('帳戶服務傳回的使用者資料不正確。');
      const activeGeneration = adoptUser(data.user, saved.token, saved.expiresAt);
      try { await loadPrivateProgress(activeGeneration, data.user.id); }
      catch (error) {
        if (!sameIdentity(activeGeneration, data.user.id)) return;
        if (handleExpired(error)) return;
        state.ready = true; state.error = errorText(error); state.syncStatus = '進度未讀取，請重試'; emitReady();
      }
    } catch (error) {
      if (generation !== epoch) return;
      clearIdentity(Number(error?.status) === 401 ? '登入已到期，請重新登入。' : '未能確認登入。請重新登入以讀取教材及使用帳戶服務。');
    } finally {
      state.ready = true; headerStatus(); if (isAccountView()) renderAccountHome();
    }
  }
  window.addEventListener('private-connection:ready', () => {
    if (!authBusy && !state.user) initialize();
    else if (state.user && dirty) syncNow();
    if (state.user && state.ready && !window.CONTENT_READY) window.loadStudyContent?.();
  });
  window.addEventListener('online', () => { if (state.user && dirty) syncNow(); });
  window.addEventListener('pagehide', () => { if (state.user) cachePrivateProgress(); });
  headerStatus();
  initialize();
})();
