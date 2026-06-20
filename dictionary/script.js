// dictionary/script.js (replacement)
// - Tries relative JSON path, falls back to raw.githubusercontent content
// - More robust IndexedDB handling and clearer status / console logging
// - Rest of features (Fuse, filtering, modal) unchanged

const JSON_URL = '/dictionary/dictionary.json'; // relative path (GitHub Pages / local)
const RAW_FALLBACK = 'https://raw.githubusercontent.com/plains-sign-project/plains-sign-project.io/main/dictionary/dictionary.json';
const IDB_NAME = 'plains-sign-dictionary';
const IDB_STORE = 'kv';
const CACHE_KEY = 'dictionary-v1';

const searchEl = document.getElementById('search');
const clearBtn = document.getElementById('clear');
const fuzzyEl = document.getElementById('fuzzy');
const exactEl = document.getElementById('exact');
const firstLetterEl = document.getElementById('firstLetter');
const tagFilterEl = document.getElementById('tagFilter');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');

const detailModal = document.getElementById('detailModal');
const detailContent = document.getElementById('detailContent');
const closeDetail = document.getElementById('closeDetail');

let entries = [];
let fuse = null;
let displayed = [];
let focusedIndex = -1;

// ----------------- IndexedDB minimal wrapper (with timeouts) -----------------
function openDb(){
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      const timeout = setTimeout(() => {
        // If IDB is blocked or slow (Safari private mode can behave oddly), bail
        req.onerror && req.onerror();
        reject(new Error('IndexedDB open timeout'));
      }, 3000);
      req.onupgradeneeded = () => {
        const db = req.result;
        if(!db.objectStoreNames.contains(IDB_STORE)){
          db.createObjectStore(IDB_STORE, { keyPath: 'key' });
        }
      };
      req.onsuccess = () => { clearTimeout(timeout); resolve(req.result); };
      req.onerror = () => { clearTimeout(timeout); reject(req.error || new Error('IDB open error')); };
    } catch (e) {
      return reject(e);
    }
  });
}
async function idbGet(key){
  try{
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const rq = store.get(key);
      rq.onsuccess = () => resolve(rq.result ? rq.result.value : undefined);
      rq.onerror = () => reject(rq.error);
    });
  }catch(e){
    console.warn('idbGet failed:', e);
    return undefined;
  }
}
async function idbPut(key, value){
  try{
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const rq = store.put({ key, value });
      rq.onsuccess = () => resolve();
      rq.onerror = () => reject(rq.error);
    });
  }catch(e){
    console.warn('idbPut failed:', e);
  }
}

// ----------------- Utilities -----------------
function escapeRegex(str){
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function highlight(text, query){
  if(!query) return text;
  const q = escapeRegex(query.trim());
  if(!q) return text;
  try{
    const re = new RegExp(q, 'ig');
    return text.replace(re, m => `<mark>${m}</mark>`);
  }catch(e){
    return text;
  }
}
function mkHeadwordsString(hws){
  return Array.isArray(hws) ? hws.join(' • ') : (hws || '');
}

// ----------------- Robust JSON fetch with fallback -----------------
async function tryFetchJson(url){
  try {
    const res = await fetch(url, { cache: 'no-cache' });
    if(!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // ensure it's JSON; try JSON.parse to detect HTML responses
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error('Response was not valid JSON');
    }
  } catch (err) {
    console.warn(`fetch ${url} failed:`, err);
    throw err;
  }
}

async function fetchWithFallback(){
  // Try relative JSON_URL first (works on GitHub Pages / local)
  try {
    return await tryFetchJson(JSON_URL);
  } catch (err1) {
    // If that fails, try the raw.githubusercontent fallback (works when page opened from github.com file view)
    try {
      statusEl.textContent = 'Retrying with raw.githubusercontent fallback…';
      return await tryFetchJson(RAW_FALLBACK);
    } catch (err2) {
      // both failed
      console.error('Both primary and fallback JSON fetch failed', err1, err2);
      throw new Error('Failed to fetch dictionary JSON');
    }
  }
}

// ----------------- Load dictionary (cache-first then network) -----------------
async function loadDictionary(){
  statusEl.textContent = 'Loading dictionary (from cache)…';

  // show cached immediately if present
  const cached = await idbGet(CACHE_KEY);
  if(cached && Array.isArray(cached.entries)){
    entries = cached.entries;
    initAfterLoad();
    statusEl.textContent = `Loaded ${entries.length} cached entries. Updating from network…`;
  } else {
    statusEl.textContent = 'No cached dictionary found. Loading from network…';
  }

  // Fetch remote and update cache if successful, with fallback
  try{
    const data = await fetchWithFallback();
    if(!data || !Array.isArray(data.entries)) throw new Error('No entries field in JSON');
    const loaded = (data.entries || []).map(e => ({
      headword: Array.isArray(e.headword) ? e.headword : [e.headword || ''],
      sign: e.sign || '',
      note: e.note || '',
      tags: Array.isArray(e.tags) ? e.tags.slice() : (e.tags ? [e.tags] : [])
    }));
    const needUpdate = !cached || cached.entries.length !== loaded.length;
    entries = loaded;
    try { await idbPut(CACHE_KEY, { timestamp: Date.now(), entries: loaded }); } catch(e){ /* ignore put errors */ }
    initAfterLoad();
    statusEl.textContent = `Loaded ${entries.length} entries.`;
    if(needUpdate && cached) statusEl.textContent += ' (cache updated)';
  }catch(err){
    console.error('Failed to load dictionary from network:', err);
    if(!entries.length){
      statusEl.textContent = `Failed to load dictionary: ${err.message}`;
      resultsEl.innerHTML = '';
    } else {
      statusEl.textContent = `Using cached dictionary (network failed).`;
    }
  }
}

// ----------------- After entries are available -----------------
function initAfterLoad(){
  buildFirstLetterOptions();
  buildTagOptions();
  setupFuse();
  renderResults('');
}

// Build first-letter select options from headwords
function buildFirstLetterOptions(){
  if(!firstLetterEl) return;
  const letters = new Set();
  for(const e of entries){
    for(const hw of e.headword){
      if(hw && hw.length){
        letters.add(hw[0].toUpperCase());
      }
    }
  }
  const sorted = Array.from(letters).sort();
  firstLetterEl.innerHTML = '<option value=\"\">All</option>';
  for(const L of sorted){
    const opt = document.createElement('option');
    opt.value = L;
    opt.textContent = L;
    firstLetterEl.appendChild(opt);
  }
}

// Build tag options (entries may have tags array)
function buildTagOptions(){
  if(!tagFilterEl) return;
  const tags = new Set();
  for(const e of entries){
    if(Array.isArray(e.tags)){
      for(const t of e.tags) if(t) tags.add(t);
    }
  }
  tagFilterEl.innerHTML = '<option value=\"\">All</option>';
  Array.from(tags).sort().forEach(t=>{
    const opt = document.createElement('option');
    opt.value = t;
    opt.textContent = t;
    tagFilterEl.appendChild(opt);
  });
}

// Initialize Fuse.js
function setupFuse(){
  if(typeof Fuse === 'undefined') { fuse = null; return; }
  try {
    const options = {
      keys: [
        { name: 'headword', weight: 0.7 },
        { name: 'sign', weight: 0.2 },
        { name: 'note', weight: 0.1 }
      ],
      includeScore: true,
      threshold: 0.4,
      ignoreLocation: true
    };
    fuse = new Fuse(entries, options);
  } catch (e) {
    console.warn('failed to initialize Fuse:', e);
    fuse = null;
  }
}

// ----------------- Matching logic -----------------
function filterByFirstLetter(list, letter){
  if(!letter) return list;
  return list.filter(e => e.headword.some(hw => (hw||'').charAt(0).toUpperCase() === letter.toUpperCase()));
}
function filterByTag(list, tag){
  if(!tag) return list;
  return list.filter(e => Array.isArray(e.tags) && e.tags.includes(tag));
}
function exactHeadwordFilter(list, query){
  if(!query) return list;
  const q = query.trim().toLowerCase();
  return list.filter(e => e.headword.some(hw => (hw||'').toLowerCase() === q));
}
function substringMatch(list, query){
  if(!query) return list.slice();
  const q = query.trim().toLowerCase();
  return list.filter(e => {
    if(e.headword.some(hw => (hw||'').toLowerCase().includes(q))) return true;
    if((e.sign||'').toLowerCase().includes(q)) return true;
    if((e.note||'').toLowerCase().includes(q)) return true;
    return false;
  });
}
function searchEntries(query){
  let result = [];
  const useExact = exactEl && exactEl.checked;
  const useFuzzy = fuzzyEl && fuzzyEl.checked && !!fuse && !!query;
  const firstLetter = firstLetterEl ? firstLetterEl.value : '';
  const tag = tagFilterEl ? tagFilterEl.value : '';

  if(useExact && query){
    result = exactHeadwordFilter(entries, query);
  } else if(useFuzzy && query){
    try {
      const fuseRes = fuse.search(query);
      result = fuseRes.map(r => r.item);
    } catch (e) {
      console.warn('Fuse search failed:', e);
      result = substringMatch(entries, query);
    }
  } else {
    result = substringMatch(entries, query);
  }

  result = filterByFirstLetter(result, firstLetter);
  result = filterByTag(result, tag);
  return result;
}

// ----------------*

