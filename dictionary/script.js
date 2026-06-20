// URL to your dictionary JSON (raw GitHub file)
const JSON_URL = 'https://raw.githubusercontent.com/plains-sign-project/plains-sign-project.io/main/dictionary/dictionary.json';

const searchEl = document.getElementById('search');
const clearBtn = document.getElementById('clear');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');

let entries = [];

// utility: escape regex special chars
function escapeRegex(str){
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// highlight matches in text (wrap in <mark>)
function highlight(text, query){
  if(!query) return text;
  const q = escapeRegex(query.trim());
  if(!q) return text;
  try {
    const re = new RegExp(q, 'ig');
    return text.replace(re, m => `<mark>${m}</mark>`);
  } catch (e) {
    return text;
  }
}

async function loadDictionary(){
  statusEl.textContent = 'Loading dictionary…';
  try {
    const r = await fetch(JSON_URL, {cache: 'no-cache'});
    if(!r.ok) throw new Error(`${r.status} ${r.statusText}`);
    const data = await r.json();
    entries = (data.entries || []).map(e => ({
      headword: Array.isArray(e.headword) ? e.headword : [e.headword || ''],
      sign: e.sign || '',
      note: e.note || ''
    }));
    statusEl.textContent = `Loaded ${entries.length} entries.`;
    renderResults('');
  } catch (err){
    statusEl.textContent = `Failed to load dictionary: ${err.message}`;
    resultsEl.innerHTML = '';
  }
}

function matchEntry(entry, q){
  if(!q) return true;
  const query = q.trim().toLowerCase();
  if(!query) return true;
  // match if any headword contains query OR sign/note contains query
  for(const hw of entry.headword){
    if(hw.toLowerCase().includes(query)) return true;
  }
  if(entry.sign.toLowerCase().includes(query)) return true;
  if(entry.note.toLowerCase().includes(query)) return true;
  return false;
}

function renderResults(query){
  const q = query.trim();
  const matched = entries.filter(e => matchEntry(e, q));
  resultsEl.innerHTML = '';

  const count = document.createElement('div');
  count.className = 'count';
  count.textContent = q ? `${matched.length} result${matched.length !== 1 ? 's' : ''} for "${q}"` : `${matched.length} total entries`;
  resultsEl.appendChild(count);

  if(matched.length === 0){
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.textContent = 'No entries found.';
    resultsEl.appendChild(empty);
    return;
  }

  const frag = document.createDocumentFragment();
  for(const e of matched){
    const card = document.createElement('article');
    card.className = 'card';
    // headwords
    const hw = document.createElement('div');
    hw.className = 'headwords';
    // join headwords with " • "
    const hwText = e.headword.join(' • ');
    hw.innerHTML = highlight(hwText, q);
    card.appendChild(hw);
    // sign
    const sign = document.createElement('p');
    sign.className = 'sign';
    sign.innerHTML = highlight(e.sign, q);
    card.appendChild(sign);
    // note if present
    if(e.note){
      const note = document.createElement('div');
      note.className = 'note';
      note.innerHTML = highlight(e.note, q);
      card.appendChild(note);
    }
    frag.appendChild(card);
  }
  resultsEl.appendChild(frag);
}

// simple debounce
function debounce(fn, wait=200){
  let t;
  return (...args)=>{
    clearTimeout(t);
    t = setTimeout(()=>fn(...args), wait);
  };
}

const onInput = debounce((ev)=>{
  const q = ev.target.value;
  renderResults(q);
}, 120);

searchEl.addEventListener('input', onInput);
clearBtn.addEventListener('click', ()=>{
  searchEl.value = '';
  searchEl.focus();
  renderResults('');
});

// load on start
loadDictionary();
