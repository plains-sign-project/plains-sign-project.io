// dictionary/script.js
// Full implementation (IDB cache, Fuse fuzzy, filters, search-in selector, keyboard nav, detail modal)

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

  const detailModal = document.getElementById('detailModal');
  const detailContent = document.getElementById('detailContent');
  const closeDetail = document.getElementById('closeDetail');

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
        const tx =

