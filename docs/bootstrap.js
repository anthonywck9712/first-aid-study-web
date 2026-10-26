/* Protected study content is fetched only after a verified account is ready. */
(() => {
  'use strict';
  let generation = 0, loading = null, contentController = null, expiryTimer = null;
  const imageUrls = new Set(), imageControllers = new Set();
  window.REFERENCE = [];
  window.REVISIONS = [];

  function navigation(visible) {
    document.querySelectorAll('.auth-only').forEach(element => {
      element.hidden = !visible;
      element.classList.toggle('hidden', !visible);
    });
  }
  function clearImages() {
    imageControllers.forEach(controller => controller.abort());
    imageControllers.clear();
    imageUrls.forEach(url => URL.revokeObjectURL(url));
    imageUrls.clear();
    document.querySelectorAll('[data-private-image]').forEach(image => { image.removeAttribute('src'); image.hidden = true; });
  }
  function clearContent() {
    generation++;
    contentController?.abort(); contentController = null; loading = null;
    clearTimeout(expiryTimer); expiryTimer = null;
    clearImages();
    window.CONTENT_READY = false;
    B = { pages: [], chapters: [], missing: [], restoredPages: [] };
    Q = []; window.BOOK = B; window.QUESTIONS = Q;
    window.REFERENCE = []; window.REVISIONS = [];
    session = []; qi = 0; order = []; answer = null; checked = false;
    resultsRows = []; nextResultsOffset = null; resultsGeneration++; appliedResultsName = ''; lastExamResult = null;
    clearInterval(examInterval);
    term = ''; revisionChapter = 'all';
    navigation(false);
    switchMode('account');
  }
  window.clearStudyContent = clearContent;

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const raw = window.ACCOUNT?.expiresAt;
    const expires = typeof raw === 'number' ? raw : Date.parse(raw);
    if (!Number.isFinite(expires)) return;
    const remaining = expires - Date.now();
    if (remaining <= 0) { window.handleAccountExpired?.({ status: 401 }); return; }
    expiryTimer = setTimeout(scheduleExpiry, Math.min(remaining + 20, 2147483647));
  }
  function sameUser(id, token, currentGeneration) {
    return generation === currentGeneration && window.ACCOUNT?.user?.id === id && window.ACCOUNT?.token === token;
  }
  async function loadContent() {
    if (window.BACKEND_PRIVATE || !window.ACCOUNT?.user || !window.ACCOUNT?.token || !window.ACCOUNT.ready) return;
    if (loading) return loading;
    const userId = window.ACCOUNT.user.id, token = window.ACCOUNT.token, currentGeneration = generation;
    contentController = new AbortController();
    const options = { signal: contentController.signal, headers: { Authorization: 'Bearer ' + token } };
    loading = (async () => {
      try {
        const [book, reference, questions, revisions] = await Promise.all([
          api('/api/content/book', options), api('/api/content/reference', options),
          api('/api/content/questions', options), api('/api/content/revisions', options),
        ]);
        if (!sameUser(userId, token, currentGeneration)) return;
        if (!book || !Array.isArray(book.pages) || !Array.isArray(book.chapters)
            || !Array.isArray(reference) || !Array.isArray(questions) || !Array.isArray(revisions)) {
          throw new Error('教材資料格式不正確，請稍後重試。');
        }
        B = book; Q = questions; window.BOOK = B; window.QUESTIONS = Q;
        window.REFERENCE = reference; window.REVISIONS = revisions;
        window.CONTENT_READY = true;
        navigation(true); scheduleExpiry();
        if (!hasStudyAccess()) return;
        const initialPage = Number(window.STUDY_INITIAL_PAGE);
        page = Number.isInteger(initialPage) && B.pages.some(p => p.pdf === initialPage) ? initialPage : 10;
        chapter = B.pages.find(p => p.pdf === page)?.chapter ?? -1;
        const view = new URLSearchParams(location.search).get('view');
        if (mode === 'account') switchMode(view === 'updates' ? 'updates' : view === 'account' ? 'account' : 'ref');
        window.dispatchEvent(new CustomEvent('study:ready'));
      } catch (error) {
        if (!sameUser(userId, token, currentGeneration) || error?.name === 'AbortError') return;
        window.CONTENT_READY = false; navigation(false); switchMode('account');
        const box = document.createElement('div'); box.className = 'question';
        const status = document.createElement('p'); status.setAttribute('role', 'alert');
        status.textContent = error?.message || '未能讀取教材，請稍後重試。';
        const retry = document.createElement('button'); retry.textContent = '重新讀取教材';
        retry.className = 'primary'; retry.onclick = () => { loading = null; box.remove(); loadContent(); };
        box.append(status, retry); document.getElementById('app').append(box);
      } finally {
        if (generation === currentGeneration) { loading = null; contentController = null; }
      }
    })();
    return loading;
  }
  window.loadStudyContent = loadContent;

  window.protectedImageMarkup = (source, page, alt) =>
    `<p class="caption private-image-status" role="status">展開後載入已授權原圖。</p><img class="page-image" hidden data-private-image data-source="${esc(source)}" data-page="${Number(page)}" alt="${esc(alt)}">`;
  window.bindProtectedImages = () => {
    document.querySelectorAll('details.source-image').forEach(details => {
      if (details.dataset.protectedBound) return;
      details.dataset.protectedBound = 'true';
      details.addEventListener('toggle', async () => {
        const image = details.querySelector('[data-private-image]');
        if (!details.open || !image || image.src || image.dataset.loading) return;
        if (!hasStudyAccess()) { switchMode('account'); return; }
        const status = details.querySelector('.private-image-status');
        const userId = window.ACCOUNT.user.id, token = window.ACCOUNT.token, currentGeneration = generation;
        const controller = new AbortController(); imageControllers.add(controller);
        image.dataset.loading = 'true'; status.textContent = '正在載入原圖⋯';
        try {
          const source = image.dataset.source, page = Number(image.dataset.page);
          if (!['pages', 'revision-slides'].includes(source) || !Number.isInteger(page) || page < 1) throw new Error('圖片來源不正確。');
          const response = await (window.studyFetch || fetch)((window.API_BASE || '') + '/api/content/image?source=' + encodeURIComponent(source) + '&page=' + page, {
            headers: { Authorization: 'Bearer ' + token }, credentials: 'same-origin', signal: controller.signal,
          });
          if (!response.ok) {
            if (response.status === 401 && sameUser(userId, token, currentGeneration)) window.handleAccountExpired?.({ status: 401 });
            throw new Error('未能載入原圖，請重新展開以重試。');
          }
          const blob = await response.blob();
          if (!sameUser(userId, token, currentGeneration) || !hasStudyAccess() || !image.isConnected) return;
          if (!blob.type.startsWith('image/')) throw new Error('圖片資料格式不正確。');
          const url = URL.createObjectURL(blob); imageUrls.add(url);
          image.src = url; image.hidden = false; status.textContent = '';
        } catch (error) {
          if (sameUser(userId, token, currentGeneration) && image.isConnected && error?.name !== 'AbortError') status.textContent = error.message;
        } finally { delete image.dataset.loading; imageControllers.delete(controller); }
      });
    });
  };

  window.addEventListener('account:change', () => clearContent());
  window.addEventListener('account:ready', () => { scheduleExpiry(); loadContent(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && window.ACCOUNT?.user) scheduleExpiry(); });
  navigation(false);
  if (window.ACCOUNT?.user && window.ACCOUNT.ready) loadContent();
  else switchMode('account');
})();
