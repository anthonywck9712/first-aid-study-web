/* GitHub hosts the interface; an approved private window makes same-origin API requests. */
(() => {
  'use strict';
  const nativeFetch = window.fetch.bind(window);
  window.studyFetch = (input, options = {}) => nativeFetch(input, { ...options, credentials: 'same-origin' });
  if (!window.PRIVATE_RELAY) return;

  const backend = new URL(window.API_BASE);
  const allowedBackend = backend.origin === 'https://first-aid-study-lab.paperman1913.chatgpt.site'
    || (location.origin === 'http://127.0.0.1:8888' && backend.origin === 'http://127.0.0.1:8787');
  if (!allowedBackend) throw new Error('私人服務網址不正確。');
  let popup = null, channel = null, connected = false, connectionPromise = null;
  let resolveConnection = null, rejectConnection = null, connectionTimer = null;
  const pending = new Map();
  const bar = document.createElement('section');
  bar.id = 'privateConnection';
  bar.setAttribute('aria-label', '私人服務連線');
  bar.style.cssText = 'margin:16px auto;padding:16px 20px;border:1px solid #cbd5d6;border-radius:10px;background:#fff;max-width:1280px;display:flex;gap:12px;align-items:center;flex-wrap:wrap';
  const text = document.createElement('p'); text.style.cssText = 'margin:0;flex:1;min-width:220px';
  text.setAttribute('role', 'status'); text.setAttribute('aria-live', 'polite');
  const button = document.createElement('button'); button.type = 'button'; button.className = 'primary';
  const help = document.createElement('p'); help.className = 'caption'; help.style.cssText = 'width:100%;margin:0';
  help.textContent = '此頁由 GitHub 託管。先在私人連線視窗完成 ChatGPT 存取驗證，再在本頁使用研習帳戶登入；請保持連線視窗開啟。';
  bar.append(text, button, help);
  const anchor = document.querySelector('.notice') || document.querySelector('header');
  if (anchor) anchor.after(bar); else document.body.prepend(bar);

  const abortError = () => new DOMException('已取消要求。', 'AbortError');
  function paint(message) {
    text.textContent = message || (connected ? '私人服務已連接；本頁可讀取及同步已授權的內容。' : '請先連接私人服務，再登入或建立研習帳戶。');
    button.textContent = connected ? '顯示連線視窗' : '連接私人服務';
    button.disabled = false;
  }
  function settleConnection(error) {
    clearTimeout(connectionTimer); connectionTimer = null;
    const resolve = resolveConnection, reject = rejectConnection;
    resolveConnection = rejectConnection = null; connectionPromise = null;
    if (error) reject?.(error); else resolve?.();
  }
  function rejectPending(error) {
    for (const item of pending.values()) item.reject(error);
    pending.clear();
  }
  function disconnect(message) {
    connected = false;
    const error = new Error(message || '私人連線視窗已關閉。請按「連接私人服務」重新連接。');
    settleConnection(error); rejectPending(error); paint(error.message);
  }
  function connect() {
    if (connected && popup && !popup.closed) { try { popup.focus(); } catch {} return Promise.resolve(); }
    if (popup && !popup.closed && connectionPromise) { try { popup.focus(); } catch {} return connectionPromise; }
    if (popup && !popup.closed) { try { popup.close(); } catch {} }
    connected = false; channel = crypto.randomUUID();
    const url = new URL('/study/relay.html', backend.origin);
    url.searchParams.set('channel', channel); url.searchParams.set('parentOrigin', location.origin);
    connectionPromise = new Promise((resolve, reject) => { resolveConnection = resolve; rejectConnection = reject; });
    const promise = connectionPromise;
    popup = window.open(url.href, 'firstaid-private-' + channel, 'popup,width=640,height=640');
    if (!popup) {
      settleConnection(new Error('瀏覽器已阻擋連線視窗。請允許此網站開啟彈出式視窗，然後再按「連接私人服務」。'));
      paint('請允許此網站開啟彈出式視窗，再重新連接。');
      return promise;
    }
    paint('請在連線視窗完成私人網站的存取驗證。完成後回到本頁登入。');
    connectionTimer = setTimeout(() => {
      const message = '尚未完成連接。如已完成 ChatGPT 驗證，請關閉該視窗，再按「連接私人服務」。';
      settleConnection(new Error(message)); paint(message);
    }, 45000);
    return promise;
  }
  function withAbort(promise, signal) {
    if (!signal) return promise;
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const abort = () => { cleanup(); reject(abortError()); };
      const cleanup = () => signal.removeEventListener('abort', abort);
      signal.addEventListener('abort', abort, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    });
  }
  async function ensureConnected(signal) {
    if (connected && popup && !popup.closed) return;
    if (connected) disconnect();
    // Initial token checks must not launch a popup without a user gesture.
    if (!connectionPromise && !navigator.userActivation?.isActive) {
      paint();
      const error = new Error('請先按頁面上方的「連接私人服務」，完成存取驗證後再試。');
      error.code = 'PRIVATE_CONNECTION_REQUIRED'; throw error;
    }
    await withAbort(connectionPromise || connect(), signal);
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (!popup || popup.closed || event.source !== popup || event.origin !== backend.origin || !message || message.channel !== channel) return;
    if (message.type === 'firstaid:ready') {
      if (!connected) {
        connected = true; settleConnection(); paint();
        popup.postMessage({ type: 'firstaid:ping', channel }, backend.origin);
        window.dispatchEvent(new CustomEvent('private-connection:ready'));
      }
      return;
    }
    if (typeof message.id !== 'string') return;
    const item = pending.get(message.id);
    if (!item) return;
    if (message.type === 'firstaid:error') { item.reject(new Error(String(message.message || '私人服務未能完成要求。').slice(0, 500))); return; }
    if (message.type !== 'firstaid:response') return;
    if (!Number.isInteger(message.status) || message.status < 200 || message.status > 599 || !(message.body instanceof ArrayBuffer) || message.body.byteLength > 5242880) {
      item.reject(new Error('私人服務傳回的資料格式不正確。')); return;
    }
    try {
      const headers = new Headers();
      for (const key of ['Content-Type', 'Cache-Control']) {
        const value = message.headers?.[key] ?? message.headers?.[key.toLowerCase()];
        if (typeof value === 'string') headers.set(key, value);
      }
      item.resolve(new Response([204, 205, 304].includes(message.status) ? null : message.body, { status: message.status, headers }));
    } catch { item.reject(new Error('私人服務傳回的回應不正確。')); }
  });
  button.onclick = () => { connect().catch(error => paint(error.message)); };
  setInterval(() => { if (popup && popup.closed && (connected || connectionPromise)) disconnect(); }, 1500);
  window.PRIVATE_CONNECTION = { get connected() { return connected && !!popup && !popup.closed; }, connect };
  window.studyFetch = async (input, options = {}) => {
    const url = new URL(String(input), location.href);
    if (url.origin !== backend.origin || !url.pathname.startsWith('/api/')) throw new Error('不支援的私人服務要求。');
    if (options.signal?.aborted) throw abortError();
    await ensureConnected(options.signal);
    if (options.signal?.aborted) throw abortError();
    const method = String(options.method || 'GET').toUpperCase();
    if (!['GET', 'POST', 'PUT'].includes(method)) throw new Error('不支援的要求方法。');
    const headers = {};
    const sourceHeaders = new Headers(options.headers || {});
    for (const key of ['Authorization', 'Content-Type']) if (sourceHeaders.has(key)) headers[key] = sourceHeaders.get(key);
    const body = options.body == null ? null : options.body;
    if (body !== null && (typeof body !== 'string' || body.length > 1048576)) throw new Error('要求資料過大或格式不正確。');
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); pending.delete(id); options.signal?.removeEventListener('abort', abort); };
      const abort = () => {
        try { popup?.postMessage({ type: 'firstaid:abort', channel, id }, backend.origin); } catch {}
        cleanup(); reject(abortError());
      };
      pending.set(id, { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } });
      options.signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { abort(); paint('私人服務回應逾時，請確認連線視窗仍然開啟。'); }, 60000);
      try { popup.postMessage({ type: 'firstaid:request', channel, id, path: url.pathname + url.search, method, headers, body }, backend.origin); }
      catch { pending.get(id)?.reject(new Error('私人連線已中斷，請重新連接。')); }
    });
  };
  paint();
})();
