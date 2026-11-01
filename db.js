/* IndexedDB 层：cards / meta / reviews。所有函数返回 Promise，不抛同步异常。 */
const DB_NAME = 'math-pattern-srs';
const DB_VERSION = 1;
let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      reject(err);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('cards')) {
        const store = db.createObjectStore('cards', { keyPath: 'id' });
        store.createIndex('bucket', 'bucket', { unique: false });
        store.createIndex('due', 'due', { unique: false });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'k' });
      }
      if (!db.objectStoreNames.contains('reviews')) {
        db.createObjectStore('reviews', { autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('数据库被其他标签页占用，请关闭其他页面后重试'));
  });
  return dbPromise;
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('事务被中断'));
  });
}

export async function getAllCards() {
  const db = await openDB();
  const tx = db.transaction('cards', 'readonly');
  const req = tx.objectStore('cards').getAll();
  const out = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
  return out;
}

export async function putCard(card) {
  const db = await openDB();
  const tx = db.transaction('cards', 'readwrite');
  tx.objectStore('cards').put(card);
  await done(tx);
  return card;
}

export async function putCards(cards) {
  if (!cards || !cards.length) return 0;
  const db = await openDB();
  const tx = db.transaction('cards', 'readwrite');
  const store = tx.objectStore('cards');
  cards.forEach((c) => store.put(c));
  await done(tx);
  return cards.length;
}

export async function deleteCard(id) {
  const db = await openDB();
  const tx = db.transaction('cards', 'readwrite');
  tx.objectStore('cards').delete(id);
  await done(tx);
}

export async function getMeta(k, fallback = null) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readonly');
  const req = tx.objectStore('meta').get(k);
  const row = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
  return row ? row.v : fallback;
}

export async function setMeta(k, v) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  tx.objectStore('meta').put({ k, v });
  await done(tx);
  return v;
}

export async function logReview(entry) {
  try {
    const db = await openDB();
    const tx = db.transaction('reviews', 'readwrite');
    tx.objectStore('reviews').put({ ...entry, at: Date.now() });
    await done(tx);
  } catch (err) {
    /* 统计日志失败不影响复习 */
  }
}

export async function countCards() {
  const cards = await getAllCards();
  return {
    total: cards.length,
    active: cards.filter((c) => c.bucket === 'active').length,
    mastered: cards.filter((c) => c.bucket === 'mastered').length,
  };
}

export async function clearAll() {
  const db = await openDB();
  const tx = db.transaction(['cards', 'meta', 'reviews'], 'readwrite');
  tx.objectStore('cards').clear();
  tx.objectStore('meta').clear();
  tx.objectStore('reviews').clear();
  await done(tx);
}
