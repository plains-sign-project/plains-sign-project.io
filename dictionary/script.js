// dictionary/script.js
// Full implementation (IDB cache, Fuse fuzzy, filters, search-in selector, keyboard nav)

(() => {
  'use strict';

  const JSON_URL = '/dictionary/dictionary.json';
  const RAW_FALLBACK = 'https://raw.githubusercontent.com/plains-sign-project/plains-sign-project.io/main/dictionary/dictionary.json';
  const IDB_NAME = 'plains-sign-dictionary';
  const IDB_STORE = 'kv';
  const CACHE_KEY = 'dictionary-v1';

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

  // IndexedDB helpers (defensive)
  function openDb(){
    return new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        const timer = setTimeout(() => reject(new Error('IndexedDB open timeout')), 3000);
        req.onupgradeneeded = () => {
          const db = req.result;
          if(!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => { clearTimeout(timer); resolve(req.result); };
        req.onerror = () => { clearTimeout(timer); reject(req.error || new Error('IDB open error')); };
      } catch (e) { reject(e); }
    });
  }

  async function idbGet(key){
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const rq = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
        rq.onsuccess = () => resolve(rq.result ? rq.result.value : undefined);
        rq.onerror = () => reject(rq.error);
      });
    } catch (e) { console.warn('idbGet failed', e); return undefined; }
  }

  async function idbPut(key, value){
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const rq = db.transaction(IDB_STORE, 'readwrite').objectStore(IDB_STORE).put({ key, value });
        rq.onsuccess = () => resolve();
        rq.onerror = () => reject(rq.error);
      });
    } catch (e) { console.warn('idbPut failed', e); }
  }

  // Utilities
  function escapeRegex(str){ return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function highlight(text, query){
    if(!query) return text;
    const q = escapeRegex(query.trim());
    if(!q) return text;
    try { return String(text).replace(new RegExp(q, 'ig'), m => `<mark>${m}</mark>`); }
    catch (e) { return text; }
  }
  function mkHeadwordsString(hws){ return Array.isArray(hws) ? hws.join(' • ') : (hws || ''); }

  function imageSrcFor(entry){
    if(!entry || !entry.image) return null;
    const authorName = (entry.author && String(entry.author).trim()) || dictAuthor || '';
    if(!authorName) return null;
    return ['images', `${authorName} Images`, entry.image].map(encodeURIComponent).join('/');
  }

  async function tryFetchJson(url){
    const res = await fetch(url, { cache: 'no-cache' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); }
    catch (e) { throw new Error('Response was not valid JSON'); }
  }

  async function fetchWithFallback(){
    const onGitHubUI = location.hostname.includes('github.com') || location.protocol === 'file:';
    if(onGitHubUI){
      try { return await tryFetchJson(RAW_FALLBACK); }
      catch (e) { console.warn('raw first failed, trying relative', e); return await tryFetchJson(JSON_URL); }
    }
    try { return await tryFetchJson(JSON_URL); }
    catch (e) {
      console.warn('Primary fetch failed:', e);
      if(statusEl) statusEl.textContent = 'Retrying with fallback…';
      return await tryFetchJson(RAW_FALLBACK);
    }
  }

  function normalizeEntry(e){
    return {
      headword: Array.isArray(e.headword) ? e.headword : [e.headword || ''],
      sign: e.sign || '',
      note: e.note || '',
      notes: e.notes || '',
      tags: Array.isArray(e.tags) ? e.tags.slice() : (e.tags ? [e.tags] : []),
      author: (e.author && String(e.author)) || dictAuthor || '',
      image: e.image || null
    };
  }

  async function loadDictionary(){
    if(statusEl) statusEl.textContent = 'Loading dictionary (from cache)…';
    const cached = await idbGet(CACHE_KEY);
    if(cached && Array.isArray(cached.entries)){
      entries = cached.entries.map(normalizeEntry);
      initAfterLoad();
      if(statusEl) statusEl.textContent = `Loaded ${entries.length} cached entries. Updating from network…`;
    } else if(statusEl) statusEl.textContent = 'No cached dictionary found. Loading from network…';

    try {
      const data = await fetchWithFallback();
      if(!data || !Array.isArray(data.entries)) throw new Error('Invalid JSON: missing entries');
      dictAuthor = data.author ? String(data.author) : '';
      const loaded = data.entries.map(normalizeEntry);
      const needUpdate = !cached || cached.entries.length !== loaded.length;
      entries = loaded;
      await idbPut(CACHE_KEY, { timestamp: Date.now(), entries: loaded });
      initAfterLoad();
      if(statusEl) statusEl.textContent = `Loaded ${entries.length} entries.` + (needUpdate && cached ? ' (cache updated)' : '');
    } catch (err) {
      console.error('Failed to load dictionary:', err);
      if(!entries.length){
        if(statusEl) statusEl.textContent = `Failed to load dictionary: ${err.message}`;
        if(resultsEl) resultsEl.innerHTML = '';
      } else if(statusEl) statusEl.textContent = 'Using cached dictionary (network failed).';
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
    for(const e of entries) for(const hw of e.headword) if(hw && hw.length) letters.add(hw[0].toUpperCase());
    firstLetterEl.innerHTML = '<option value="">All</option>';
    Array.from(letters).sort().forEach(L => {
      const opt = document.createElement('option'); opt.value = L; opt.textContent = L; firstLetterEl.appendChild(opt);
    });
  }

  function buildTagOptions(){
    if(!tagFilterEl) return;
    const tags = new Set();
    for(const e of entries) if(Array.isArray(e.tags)) for(const t of e.tags) if(t) tags.add(t);
    tagFilterEl.innerHTML = '<option value="">All</option>';
    Array.from(tags).sort().forEach(t => {
      const opt = document.createElement('option'); opt.value = t; opt.textContent = t; tagFilterEl.appendChild(opt);
    });
  }

  function getFuseKeysForSelection(sel){
    if(!sel) sel = 'all';
    switch(sel){
      case 'headword': return [{ name: 'headword', weight: 1 }];
      case 'definition': return [{ name: 'sign', weight: 1 }];
      case 'note': return [{ name: 'note', weight: 1 }, { name: 'notes', weight: 1 }];
      case 'author': return [{ name: 'author', weight: 1 }];
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
      const options = {
        keys: getFuseKeysForSelection(fieldSelect ? fieldSelect.value : 'all'),
        includeScore: true,
        threshold: 0.4,
        ignoreLocation: true
      };
      fuse = new Fuse(entries, options);
    } catch (e) { console.warn('Fuse init failed', e); fuse = null; }
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
      if(only === 'headword') return e.headword.some(hw => (hw || '').toLowerCase().includes(q));
      if(only === 'definition') return (e.sign || '').toLowerCase().includes(q);
      if(only === 'note') return (e.note || '').toLowerCase().includes(q) || (e.notes || '').toLowerCase().includes(q);
      if(only === 'author') return (e.author || '').toLowerCase().includes(q);
      return e.headword.some(hw => (hw || '').toLowerCase().includes(q)) ||
        (e.sign || '').toLowerCase().includes(q) ||
        (e.note || '').toLowerCase().includes(q) ||
        (e.notes || '').toLowerCase().includes(q) ||
        (e.author || '').toLowerCase().includes(q);
    });
  }

  function searchEntries(query){
    const useExact = exactEl && exactEl.checked;
    const useFuzzy = fuzzyEl && fuzzyEl.checked && !!fuse && !!query;
    let result;
    if(useExact && query) result = exactHeadwordFilter(entries, query);
    else if(useFuzzy) {
      try { result = fuse.search(query).map(r => r.item); }
      catch (e) { console.warn('Fuse search error', e); result = substringMatchFields(entries, query, fieldSelect ? fieldSelect.value : 'all'); }
    } else result = substringMatchFields(entries, query, fieldSelect ? fieldSelect.value : 'all');
    return filterByTag(filterByFirstLetter(result, firstLetterEl ? firstLetterEl.value : ''), tagFilterEl ? tagFilterEl.value : '');
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
      const empty = document.createElement('div'); empty.className = 'muted'; empty.textContent = 'No entries found.';
      resultsEl.appendChild(empty); return;
    }

    const list = document.createElement('div');
    list.setAttribute('role', 'list'); list.className = 'results-list';

    displayed.forEach((e, i) => {
      const card = document.createElement('article');
      card.className = 'card'; card.setAttribute('role', 'listitem'); card.tabIndex = 0; card.dataset.index = i;
      const imageSrc = imageSrcFor(e);
      if(imageSrc){
        const img = document.createElement('img');
        img.src = imageSrc;
        img.alt = (Array.isArray(e.headword) ? e.headword[0] : e.headword) || 'dictionary image';
        img.className = 'dict-image';
        img.onerror = () => { img.style.display = 'none'; };
        card.appendChild(img);
      }

      const hw = document.createElement('div'); hw.className = 'headwords'; hw.innerHTML = highlight(mkHeadwordsString(e.headword), q); card.appendChild(hw);
      const sign = document.createElement('p'); sign.className = 'sign'; sign.innerHTML = highlight(e.sign || '', q); card.appendChild(sign);

      if((e.note || '').trim()){
        const note = document.createElement('div'); note.className = 'note'; note.innerHTML = highlight(e.note, q); card.appendChild(note);
      }
      if(String(e.notes || '').trim()){
        const notes = document.createElement('div'); notes.className = 'note'; notes.innerHTML = highlight(String(e.notes).trim(), q); card.appendChild(notes);
      }

      if(e.author){
        const source = document.createElement('div'); source.className = 'book'; source.textContent = `Book: ${e.author}`; card.appendChild(source);
      }
      if(Array.isArray(e.tags) && e.tags.length){
        const tags = document.createElement('div'); tags.className = 'tags'; tags.textContent = e.tags.join(', '); card.appendChild(tags);
      }
      list.appendChild(card);
    });

    resultsEl.appendChild(list); focusedIndex = -1;
  }

  function focusResult(index){
    if(!resultsEl) return;
    const list = resultsEl.querySelectorAll('.card');
    if(!list.length) return;
    index = Math.max(0, Math.min(index, list.length - 1));
    if(focusedIndex >= 0 && list[focusedIndex]) list[focusedIndex].classList.remove('focused');
    focusedIndex = index;
    list[focusedIndex].classList.add('focused');
    list[focusedIndex].focus({ preventScroll: false });
  }

  document.addEventListener('keydown', ev => {
    const inSearch = document.activeElement === searchEl;
    const list = resultsEl ? resultsEl.querySelectorAll('.card') : [];
    if(ev.key === 'ArrowDown'){
      ev.preventDefault(); if(list.length) focusResult(!inSearch && focusedIndex >= 0 ? focusedIndex + 1 : 0);
    } else if(ev.key === 'ArrowUp'){
      ev.preventDefault(); if(list.length) focusResult(!inSearch && focusedIndex >= 0 ? focusedIndex - 1 : list.length - 1);
    }
  });

  function debounce(fn, wait = 160){ let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); }; }
  const onInput = debounce(ev => renderResults(ev.target.value), 120);
  if(searchEl) searchEl.addEventListener('input', onInput);
  if(clearBtn) clearBtn.addEventListener('click', () => { if(searchEl) { searchEl.value = ''; searchEl.focus(); } renderResults(''); });
  if(refreshBtn) refreshBtn.addEventListener('click', async () => {
    try { indexedDB.deleteDatabase(IDB_NAME); } catch(e) { console.warn('delete DB failed', e); }
    if(statusEl) statusEl.textContent = 'Refreshing dictionary…';
    await loadDictionary();
  });
  if(fieldSelect) fieldSelect.addEventListener('change', () => { setupFuse(); renderResults(searchEl ? searchEl.value : ''); });
  [fuzzyEl, exactEl, firstLetterEl, tagFilterEl].forEach(el => {
    if(el) el.addEventListener('change', () => { if(el === fuzzyEl) setupFuse(); renderResults(searchEl ? searchEl.value : ''); });
  });

  loadDictionary().catch(err => {
    console.error('Unexpected loadDictionary error', err);
    if(statusEl) statusEl.textContent = 'Error initializing dictionary.';
  });
})();
