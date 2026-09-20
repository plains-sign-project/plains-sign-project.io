// dictionary/script.js
// Full implementation (IDB cache, Fuse fuzzy, filters, search-in selector, keyboard nav)

(() => {
  'use strict';

  const DICTIONARY_FILES = [
    { path: 'dictionary - Clark.json', author: 'Clark' },
    { path: 'dictionary - Hadley.json', author: 'Hadley' },
    { path: 'dictionary - Seton.json', author: 'Seton' },
    { path: 'dictionary - Tomkins.json', author: 'Tomkins' }
  ];

  const DICTIONARY_BASE_URL = '/dictionary/';
  const RAW_DICTIONARY_BASE_URL = 'https://raw.githubusercontent.com/plains-sign-project/plains-sign-project.io/main/dictionary/';
  const IDB_NAME = 'plains-sign-dictionary';
  const IDB_STORE = 'kv';
  const CACHE_KEY = 'dictionary-v2';

  const searchEl = document.getElementById('search');
  const clearBtn = document.getElementById('clear');
  const fuzzyEl = document.getElementById('fuzzy');
  const exactEl = document.getElementById('exact');
  const fieldSelect = document.getElementById('fieldSelect');
  const firstLetterEl = document.getElementById('firstLetter');
  const tagFilterEl = document.getElementById('tagFilter');
  const refreshBtn = document.getElementById('refresh');
  const resultsEl = document.getElementById('results');
  const statusEl = document.getElementById('status');

  let entries = [];
  let fuse = null;
  let displayed = [];
  let focusedIndex = -1;
  let dictAuthor = '';

  function openDb(){
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        const timer = setTimeout(() => reject(new Error('IndexedDB open timeout')), 3000);
        req.onupgradeneeded = () => {
          const db = req.result;
          if(!db.objectStoreNames.contains(IDB_STORE)){
            db.createObjectStore(IDB_STORE, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
        req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('IDB open error')); };
      } catch (e) {
        reject(e);
      }
    });
  }

  async function idbGet(key){
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readonly');
        const store = tx.objectStore(IDB_STORE);
        const rq = store.get(key);
        rq.onsuccess = () => resolve(rq.result ? rq.result.value : undefined);
        rq.onerror = () => reject(rq.error);
      });
    } catch (e) {
      console.warn('idbGet failed', e);
      return undefined;
    }
  }

  async function idbPut(key, value){
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(IDB_STORE, 'readwrite');
        const store = tx.objectStore(IDB_STORE);
        const rq = store.put({ key, value });
        rq.onsuccess = () => resolve();
        rq.onerror = () => reject(rq.error);
      });
    } catch (e) {
      console.warn('idbPut failed', e);
    }
  }

  function escapeRegex(str){ return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  function highlight(text, query){
    if(!query) return text;
    const q = escapeRegex(query.trim());
    if(!q) return text;
    try {
      const re = new RegExp(q, 'ig');
      return String(text).replace(re, m => `<mark>${m}</mark>`);
    } catch (e) {
      return text;
    }
  }

  function mkHeadwordsString(hws){ return Array.isArray(hws) ? hws.join(' • ') : (hws || ''); }

  function imageSrcFor(entry){
    if(!entry || !entry.image) return null;
    const authorName = (entry.author && String(entry.author).trim()) || dictAuthor || '';
    if(!authorName) return null;
    const folder = `${authorName} Images`;
    return ['images', folder, entry.image].map(encodeURIComponent).join('/');
  }

  async function tryFetchJson(url){
    const res = await fetch(url, { cache: 'no-cache' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Response was not valid JSON');
    }
  }

  async function fetchDictionaryFile(file){
    const relativeUrl = `${DICTIONARY_BASE_URL}${encodeURIComponent(file.path)}`;
    const rawUrl = `${RAW_DICTIONARY_BASE_URL}${encodeURIComponent(file.path)}`;
    const onGitHubUI = location.hostname.includes('github.com') || location.protocol === 'file:';

    if(onGitHubUI){
      try {
        return await tryFetchJson(rawUrl);
      } catch (err) {
        console.warn(`Raw fetch failed for ${file.path}; trying relative URL`, err);
        return await tryFetchJson(relativeUrl);
      }
    }

    try {
      return await tryFetchJson(relativeUrl);
    } catch (err) {
      console.warn(`Relative fetch failed for ${file.path}; trying raw URL`, err);
      return await tryFetchJson(rawUrl);
    }
  }

  async function fetchDictionaries(){
    return await Promise.all(
      DICTIONARY_FILES.map(async file => {
        const data = await fetchDictionaryFile(file);
        if(!data || !Array.isArray(data.entries)){
          throw new Error(`${file.path} is missing an entries array`);
        }
        return { file, data };
      })
    );
  }

  function normalizeEntry(e, fallbackAuthor = ''){
    return {
      headword: Array.isArray(e.headword) ? e.headword : [e.headword || ''],
      sign: e.sign || '',
      note: e.note || '',
      notes: e.notes || '',
      tags: Array.isArray(e.tags) ? e.tags.slice() : (e.tags ? [e.tags] : []),
      author: (e.author && String(e.author)) || fallbackAuthor || dictAuthor || '',
      image: e.image || null
    };
  }

  async function loadDictionary(){
    if(statusEl) statusEl.textContent = 'Loading dictionary (from cache)…';
    const cached = await idbGet(CACHE_KEY);
    if(cached && Array.isArray(cached.entries)){
      entries = cached.entries.map(e => normalizeEntry(e, e.author || ''));
      initAfterLoad();
      if(statusEl) statusEl.textContent = `Loaded ${entries.length} cached entries. Updating from network…`;
    } else if(statusEl) {
      statusEl.textContent = 'No cached dictionary found. Loading from network…';
    }

    try {
      const dictionaries = await fetchDictionaries();
      const loaded = dictionaries.flatMap(({ file, data }) => {
        const fileAuthor = data.author ? String(data.author) : file.author;
        return data.entries.map(entry => normalizeEntry(entry, fileAuthor));
      });

      const needUpdate = !cached || cached.entries.length !== loaded.length;
      entries = loaded;
      try { await idbPut(CACHE_KEY, { timestamp: Date.now(), entries: loaded }); } catch (_) {}
      initAfterLoad();
      if(statusEl) statusEl.textContent = `Loaded ${entries.length} entries.` + (needUpdate && cached ? ' (cache updated)' : '');
    } catch (err) {
      console.error('Failed to load dictionary:', err);
      if(!entries.length){
        if(statusEl) statusEl.textContent = `Failed to load dictionary: ${err.message}`;
        if(resultsEl) resultsEl.innerHTML = '';
      } else if(statusEl) {
        statusEl.textContent = 'Using cached dictionary (network failed).';
      }
    }
  }

  function initAfterLoad(){
    buildFirstLetterOptions();
    buildTagOptions();
    setupFuse();
    renderResults('');
  }

  function buildFirstLetterOptions(){
    if(!firstLetterEl) return;
    const letters = new Set();
    for(const e of entries){
      for(const hw of e.headword){
        if(hw && hw.length) letters.add(hw[0].toUpperCase());
      }
    }
    const sorted = Array.from(letters).sort();
    firstLetterEl.innerHTML = '<option value="">All</option>';
    for(const L of sorted){
      const opt = document.createElement('option');
      opt.value = L;
      opt.textContent = L;
      firstLetterEl.appendChild(opt);
    }
  }

  function buildTagOptions(){
    if(!tagFilterEl) return;
    const tags = new Set();
    for(const e of entries){
      if(Array.isArray(e.tags)){
        for(const t of e.tags) if(t) tags.add(t);
      }
    }
    tagFilterEl.innerHTML = '<option value="">All</option>';
    Array.from(tags).sort().forEach(t => {
      const opt = document.createElement('option');
      opt.value = t;
      opt.textContent = t;
      tagFilterEl.appendChild(opt);
    });
  }

  function getFuseKeysForSelection(sel){
    if(!sel) sel = 'all';
    switch(sel){
      case 'headword':
        return [{ name: 'headword', weight: 1 }];
      case 'definition':
        return [{ name: 'sign', weight: 1 }];
      case 'note':
        return [
          { name: 'note', weight: 1 },
          { name: 'notes', weight: 1 }
        ];
      case 'author':
        return [{ name: 'author', weight: 1 }];
      case 'all':
      default:
        return [
          { name: 'headword', weight: 0.6 },
          { name: 'sign', weight: 0.2 },
          { name: 'note', weight: 0.08 },
          { name: 'notes', weight: 0.08 },
          { name: 'author', weight: 0.04 }
        ];
    }
  }

  function setupFuse(){
    if(typeof Fuse === 'undefined'){ fuse = null; return; }
    try {
      const sel = fieldSelect ? fieldSelect.value : 'all';
      const options = {
        keys: getFuseKeysForSelection(sel),
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true
      };
      fuse = new Fuse(entries, options);
    } catch (e) {
      console.warn('Fuse init failed', e);
      fuse = null;
    }
  }

  function filterByFirstLetter(list, letter){
    if(!letter) return list;
    return list.filter(e => e.headword.some(hw => (hw || '').charAt(0).toUpperCase() === letter.toUpperCase()));
  }

  function filterByTag(list, tag){
    if(!tag) return list;
    return list.filter(e => Array.isArray(e.tags) && e.tags.includes(tag));
  }

  function exactHeadwordFilter(list, query){
    if(!query) return list;
    const q = query.trim().toLowerCase();
    return list.filter(e => e.headword.some(hw => (hw || '').toLowerCase() === q));
  }

  function substringMatchFields(list, query, sel){
    if(!query) return list.slice();
    const q = query.trim().toLowerCase();
    const only = sel || (fieldSelect ? fieldSelect.value : 'all');
    return list.filter(e => {
      if(only === 'headword'){
        return e.headword.some(hw => (hw || '').toLowerCase().includes(q));
      } else if(only === 'definition'){
        return (e.sign || '').toLowerCase().includes(q);
      } else if(only === 'note'){
        return (e.note || '').toLowerCase().includes(q) || (e.notes || '').toLowerCase().includes(q);
      } else if(only === 'author'){
        return (e.author || '').toLowerCase().includes(q);
      } else {
        if(e.headword.some(hw => (hw || '').toLowerCase().includes(q))) return true;
        if((e.sign || '').toLowerCase().includes(q)) return true;
        if((e.note || '').toLowerCase().includes(q)) return true;
        if((e.notes || '').toLowerCase().includes(q)) return true;
        if((e.author || '').toLowerCase().includes(q)) return true;
        return false;
      }
    });
  }

  function searchEntries(query){
    const useExact = exactEl && exactEl.checked;
    const useFuzzy = fuzzyEl && fuzzyEl.checked && !!fuse && !!query;
    const firstLetter = firstLetterEl ? firstLetterEl.value : '';
    const tag = tagFilterEl ? tagFilterEl.value : '';

    let result = [];

    if(useExact && query) {
      result = exactHeadwordFilter(entries, query);
    } else if(useFuzzy && query) {
      try {
        const fuseRes = fuse.search(query);
        result = fuseRes.map(r => r.item);
      } catch (e) {
        console.warn('Fuse search error', e);
        result = substringMatchFields(entries, query, fieldSelect ? fieldSelect.value : 'all');
      }
    } else {
      result = substringMatchFields(entries, query, fieldSelect ? fieldSelect.value : 'all');
    }

    result = filterByFirstLetter(result, firstLetter);
    result = filterByTag(result, tag);
    return result;
  }

  function renderResults(query){
    if(!resultsEl) return;
    const q = (query || '').trim();
    displayed = searchEntries(q);
    resultsEl.innerHTML = '';

    const count = document.createElement('div');
    count.className = 'count';
    count.textContent = q ? `${displayed.length} result${displayed.length !== 1 ? 's' : ''} for "${q}"` : `${displayed.length} total entries`;
    resultsEl.appendChild(count);

    if(displayed.length === 0){
      const empty = document.createElement('div');
      empty.className = 'muted';
      empty.textContent = 'No entries found.';
      resultsEl.appendChild(empty);
      return;
    }

    const list = document.createElement('div');
    list.setAttribute('role', 'list');
    list.className = 'results-list';

    displayed.forEach((e, i) => {
      const card = document.createElement('article');
      card.className = 'card';
      card.setAttribute('role', 'listitem');
      card.tabIndex = 0;
      card.dataset.index = i;

      const src = imageSrcFor(e);
      if(src){
        const img = document.createElement('img');
        img.src = src;
        img.alt = (Array.isArray(e.headword) ? e.headword[0] : e.headword) || 'dictionary image';
        img.className = 'dict-image';
        img.onerror = () => { img.style.display = 'none'; };
        card.appendChild(img);
      }

      const hw = document.createElement('div');
      hw.className = 'headwords';
      hw.innerHTML = highlight(mkHeadwordsString(e.headword), q);
      card.appendChild(hw);

      const sign = document.createElement('p');
      sign.className = 'sign';
      sign.innerHTML = highlight(e.sign || '', q);
      card.appendChild(sign);

      if((e.note || '').trim()){
        const note = document.createElement('div');
        note.className = 'note';
        note.innerHTML = highlight(e.note, q);
        card.appendChild(note);
      }

      const notesText = String(e.notes || '').trim();
      if(notesText){
        const notes = document.createElement('div');
        notes.className = 'note';
        notes.innerHTML = highlight(notesText, q);
        card.appendChild(notes);
      }

      if(e.author){
        const book = document.createElement('div');
        book.className = 'book';
        book.textContent = `Book: ${e.author}`;
        card.appendChild(book);
      }

      if(Array.isArray(e.tags) && e.tags.length){
        const tagLine = document.createElement('div');
        tagLine.className = 'tags';
        tagLine.textContent = e.tags.join(', ');
        card.appendChild(tagLine);
      }

      list.appendChild(card);
    });

    resultsEl.appendChild(list);
    focusedIndex = -1;
  }

  function focusResult(index){
    if(!resultsEl) return;
    const list = resultsEl.querySelectorAll('.card');
    if(!list || list.length === 0) return;
    if(index < 0) index = 0;
    if(index >= list.length) index = list.length - 1;
    if(focusedIndex >= 0 && list[focusedIndex]) list[focusedIndex].classList.remove('focused');
    focusedIndex = index;
    const el = list[focusedIndex];
    if(el){
      el.classList.add('focused');
      el.focus({ preventScroll: false });
    }
  }

  document.addEventListener('keydown', (ev) => {
    const active = document.activeElement;
    const inSearch = active === searchEl;
    const listEls = resultsEl ? resultsEl.querySelectorAll('.card') : [];
    if(ev.key === 'ArrowDown'){
      ev.preventDefault();
      if(!listEls || listEls.length === 0) return;
      if(!inSearch && focusedIndex >= 0) focusResult(focusedIndex + 1);
      else focusResult(0);
    } else if(ev.key === 'ArrowUp'){
      ev.preventDefault();
      if(!listEls || listEls.length === 0) return;
      if(!inSearch && focusedIndex >= 0) focusResult(focusedIndex - 1);
      else focusResult(listEls.length - 1);
    }
  });

  function debounce(fn, wait = 160){
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), wait);
    };
  }

  const onInput = debounce((ev) => { renderResults(ev.target.value); }, 120);

  if(searchEl) searchEl.addEventListener('input', onInput);
  if(clearBtn) clearBtn.addEventListener('click', () => {
    if(searchEl) searchEl.value = '';
    if(searchEl) searchEl.focus();
    renderResults('');
  });

  if(refreshBtn){
    refreshBtn.addEventListener('click', async () => {
      try { indexedDB.deleteDatabase(IDB_NAME); } catch (e) { console.warn('delete DB failed', e); }
      if(statusEl) statusEl.textContent = 'Refreshing dictionary…';
      await loadDictionary();
    });
  }

  if(fieldSelect) {
    fieldSelect.addEventListener('change', () => {
      setupFuse();
      renderResults(searchEl ? searchEl.value : '');
    });
  }

  [fuzzyEl, exactEl, firstLetterEl, tagFilterEl].forEach(el => {
    if(!el) return;
    el.addEventListener('change', () => {
      if(el === fuzzyEl && fieldSelect) setupFuse();
      renderResults(searchEl ? searchEl.value : '');
    });
  });

  loadDictionary().catch(err => {
    console.error('Unexpected loadDictionary error', err);
    if(statusEl) statusEl.textContent = 'Error initializing dictionary.';
  });
})();
