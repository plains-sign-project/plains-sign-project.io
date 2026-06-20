// dictionary/script.js
// Features:
// - IDB caching for offline use
// - Fuse.js fuzzy search (toggleable)
// - Exact headword / first-letter / tag filters
// - Keyboard navigation and entry detail view

const JSON_URL = '/dictionary/dictionary.json'; // relative path (works on GitHub Pages)
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
let displayed = []; // current displayed entries (after filters/search)
let focusedIndex = -1;

// ----------------- IndexedDB minimal wrapper -----------------
function openDb(){
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(IDB_STORE)){
        db.createObjectStore(IDB_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key){
  try{
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const rq = store.get(key);
      rq.onsuccess = () => resolve(rq.result ? rq.result.value : undefined);
      rq.onerror = () => reject(rq.error);
    });
  }catch(e){ return undefined; }
}
async function idbPut(key, value){
  try{
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const rq = store.put({ key, value });
      rq.onsuccess = () => resolve();
      rq.onerror = () => reject(rq.error);
    });
  }catch(e){ /* ignore */ }
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

  // Fetch remote and update cache if successful
  try{
    const res = await fetch(JSON_URL, { cache: 'no-cache' });
    if(!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const data = await res.json();
    const loaded = (data.entries || []).map(e => ({
      headword: Array.isArray(e.headword) ? e.headword : [e.headword || ''],
      sign: e.sign || '',
      note: e.note || '',
      tags: Array.isArray(e.tags) ? e.tags.slice() : (e.tags ? [e.tags] : [])
    }));
    // Only update if different length or if entries differ (simple check)
    const needUpdate = !cached || cached.entries.length !== loaded.length;
    entries = loaded;
    await idbPut(CACHE_KEY, { timestamp: Date.now(), entries: loaded });
    initAfterLoad();
    statusEl.textContent = `Loaded ${entries.length} entries.`;
    if(needUpdate && cached) statusEl.textContent += ' (cache updated)';
  }catch(err){
    if(!entries.length){
      statusEl.textContent = `Failed to load dictionary: ${err.message}`;
      resultsEl.innerHTML = '';
    } else {
      statusEl.textContent = `Using cached dictionary (offline or fetch failed).`;
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
  if(typeof Fuse === 'undefined') return;
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

// Exact headword match (case-insensitive)
function exactHeadwordFilter(list, query){
  if(!query) return list;
  const q = query.trim().toLowerCase();
  return list.filter(e => e.headword.some(hw => (hw||'').toLowerCase() === q));
}

// Basic substring matching across headword/sign/note
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

// Combined search entry point
function searchEntries(query){
  let result = [];
  const useExact = exactEl.checked;
  const useFuzzy = fuzzyEl.checked && !!fuse && !!query;
  const firstLetter = firstLetterEl.value;
  const tag = tagFilterEl.value;

  if(useExact && query){
    result = exactHeadwordFilter(entries, query);
  } else if(useFuzzy && query){
    const fuseRes = fuse.search(query);
    result = fuseRes.map(r => r.item);
  } else {
    result = substringMatch(entries, query);
  }

  // apply other filters
  result = filterByFirstLetter(result, firstLetter);
  result = filterByTag(result, tag);
  return result;
}

// ----------------- Rendering -----------------
function renderResults(query){
  const q = (query || '').trim();
  displayed = searchEntries(q);
  resultsEl.innerHTML = '';

  const count = document.createElement('div');
  count.className = 'count';
  count.textContent = q ? `${displayed.length} result${displayed.length !== 1 ? 's' : ''} for \"${q}\"` : `${displayed.length} total entries`;
  resultsEl.appendChild(count);

  if(displayed.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No entries found.';
    resultsEl.appendChild(empty);
    return;
  }

  const list = document.createElement('div');
  list.setAttribute('role','list');
  list.className = 'results-list';

  displayed.forEach((e, i) => {
    const card = document.createElement('article');
    card.className = 'card';
    card.setAttribute('role','listitem');
    card.tabIndex = 0;
    card.dataset.index = i;

    // Headwords (bold, hanging indent handled by CSS)
    const hw = document.createElement('div');
    hw.className = 'headwords';
    hw.innerHTML = highlight(mkHeadwordsString(e.headword), q);
    card.appendChild(hw);

    // sign
    const sign = document.createElement('p');
    sign.className = 'sign';
    sign.innerHTML = highlight(e.sign || '', q);
    card.appendChild(sign);

    // note
    if(e.note){
      const note = document.createElement('div');
      note.className = 'note';
      note.innerHTML = highlight(e.note, q);
      card.appendChild(note);
    }

    // small tags line
    if(Array.isArray(e.tags) && e.tags.length){
      const tline = document.createElement('div');
      tline.className = 'tags';
      tline.textContent = e.tags.join(', ');
      card.appendChild(tline);
    }

    // click / keyboard to open detail
    card.addEventListener('click', () => openDetail(i));
    card.addEventListener('keydown', (ev) => {
      if(ev.key === 'Enter'){ openDetail(i); ev.preventDefault(); }
    });

    list.appendChild(card);
  });

  resultsEl.appendChild(list);
  focusedIndex = -1;
}

// ----------------- Keyboard navigation -----------------
function focusResult(index){
  const list = resultsEl.querySelectorAll('.card');
  if(!list || list.length === 0) return;
  if(index < 0) index = 0;
  if(index >= list.length) index = list.length - 1;
  // blur previous
  if(focusedIndex >= 0 && list[focusedIndex]) list[focusedIndex].classList.remove('focused');
  focusedIndex = index;
  const el = list[focusedIndex];
  if(el){
    el.classList.add('focused');
    el.focus({ preventScroll: false });
  }
}

document.addEventListener('keydown', (ev)=>{
  // when the search input has focus:
  const active = document.activeElement;
  const inSearch = active === searchEl;
  const listEls = resultsEl.querySelectorAll('.card');
  if(ev.key === 'ArrowDown'){
    ev.preventDefault();
    if(listEls.length === 0) return;
    if(!inSearch && focusedIndex >=0){
      focusResult(focusedIndex + 1);
    } else {
      focusResult(0);
    }
  } else if(ev.key === 'ArrowUp'){
    ev.preventDefault();
    if(listEls.length === 0) return;
    if(!inSearch && focusedIndex >= 0){
      focusResult(focusedIndex - 1);
    } else {
      // move focus to last result
      focusResult(listEls.length - 1);
    }
  } else if(ev.key === 'Escape'){
    // close detail if open
    if(detailModal.getAttribute('aria-hidden') === 'false') closeDetailModal();
  }
});

// ----------------- Detail view -----------------
function openDetail(displayIndex){
  const entry = displayed[displayIndex];
  if(!entry) return;
  detailContent.innerHTML = '';
  const title = document.createElement('h2');
  title.textContent = mkHeadwordsString(entry.headword);
  detailContent.appendChild(title);

  const sign = document.createElement('p');
  sign.className = 'sign';
  sign.textContent = entry.sign || '';
  detailContent.appendChild(sign);

  if(entry.note){
    const note = document.createElement('div');
    note.className = 'note';
    note.textContent = entry.note;
    detailContent.appendChild(note);
  }

  if(Array.isArray(entry.tags) && entry.tags.length){
    const tags = document.createElement('div');
    tags.className = 'tags';
    tags.textContent = 'Tags: ' + entry.tags.join(', ');
    detailContent.appendChild(tags);
  }

  detailModal.setAttribute('aria-hidden','false');
  detailModal.classList.add('open');
  // set focus to close button for accessibility
  closeDetail.focus();
}
function closeDetailModal(){
  detailModal.setAttribute('aria-hidden','true');
  detailModal.classList.remove('open');
  // return focus to search
  searchEl.focus();
}

closeDetail.addEventListener('click', closeDetailModal);
detailModal.addEventListener('click', (ev)=>{
  // clicking outside the panel closes
  if(ev.target === detailModal || ev.target.classList.contains('detail-backdrop')) closeDetailModal();
});
document.addEventListener('keydown', (ev)=>{
  if(ev.key === 'Escape' && detailModal.getAttribute('aria-hidden') === 'false'){
    closeDetailModal();
  }
});

// ----------------- Event wiring -----------------
function debounce(fn, wait=160){
  let t;
  return (...args)=>{
    clearTimeout(t);
    t = setTimeout(()=>fn(...args), wait);
  };
}

const onInput = debounce((ev)=>{
  renderResults(ev.target.value);
}, 120);

searchEl.addEventListener('input', onInput);

clearBtn.addEventListener('click', ()=>{
  searchEl.value = '';
  searchEl.focus();
  renderResults('');
});

// filter changes re-render
[fuzzyEl, exactEl, firstLetterEl, tagFilterEl].forEach(el=>{
  if(!el) return;
  el.addEventListener('change', ()=> renderResults(searchEl.value));
});

// initial load
loadDictionary();
