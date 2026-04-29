const ANALYTICS_DB_NAME = 'xga_analytics';
const ANALYTICS_DB_VERSION = 1;
const REPLY_EVENTS_STORE = 'replyEvents';

let dbPromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function openAnalyticsDb() {
  if (dbPromise) return dbPromise;
  if (typeof indexedDB === 'undefined') {
    dbPromise = Promise.reject(new Error('IndexedDB is not available in this context.'));
    return dbPromise;
  }

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(ANALYTICS_DB_NAME, ANALYTICS_DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(REPLY_EVENTS_STORE)) {
        const store = db.createObjectStore(REPLY_EVENTS_STORE, { keyPath: 'id' });
        store.createIndex('sentAt', 'sentAt', { unique: false });
        store.createIndex('targetPostId', 'targetPostId', { unique: false });
        store.createIndex('replyPostId', 'replyPostId', { unique: false });
        store.createIndex('replyType', 'replyType', { unique: false });
        store.createIndex('targetCategory', 'targetCategory', { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open analytics database.'));
  });

  return dbPromise;
}

async function withReplyEventsStore(mode, callback) {
  const db = await openAnalyticsDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(REPLY_EVENTS_STORE, mode);
    const store = transaction.objectStore(REPLY_EVENTS_STORE);
    let callbackResult;

    transaction.oncomplete = () => resolve(callbackResult);
    transaction.onerror = () => reject(transaction.error || new Error('Analytics database transaction failed.'));
    transaction.onabort = () => reject(transaction.error || new Error('Analytics database transaction aborted.'));

    try {
      callbackResult = callback(store);
    } catch (error) {
      transaction.abort();
      reject(error);
    }
  });
}

async function putReplyEvent(event) {
  await withReplyEventsStore('readwrite', (store) => {
    store.put(event);
  });
  return event;
}

async function getReplyEvent(id) {
  return withReplyEventsStore('readonly', (store) => requestToPromise(store.get(id)));
}

async function getAllReplyEvents() {
  return withReplyEventsStore('readonly', (store) => requestToPromise(store.getAll()));
}

async function updateReplyEvent(id, updater) {
  return withReplyEventsStore('readwrite', (store) => new Promise((resolve, reject) => {
    const getRequest = store.get(id);
    getRequest.onerror = () => reject(getRequest.error || new Error('Could not read analytics event.'));
    getRequest.onsuccess = () => {
      const current = getRequest.result;
      if (!current) {
        resolve(null);
        return;
      }

      const next = updater(current);
      const putRequest = store.put(next);
      putRequest.onerror = () => reject(putRequest.error || new Error('Could not update analytics event.'));
      putRequest.onsuccess = () => resolve(next);
    };
  }));
}

async function clearReplyEvents() {
  await withReplyEventsStore('readwrite', (store) => {
    store.clear();
  });
}

export {
  ANALYTICS_DB_NAME,
  REPLY_EVENTS_STORE,
  clearReplyEvents,
  getAllReplyEvents,
  getReplyEvent,
  openAnalyticsDb,
  putReplyEvent,
  updateReplyEvent
};
