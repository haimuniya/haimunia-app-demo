// ---------- IndexedDB ----------
// Deliberately distinct from the real production app's own database name.
// Both apps are served from the same GitHub Pages origin (haimuniya.
// github.io), just different paths, and IndexedDB is scoped per-origin,
// not per-path — reusing that name would mean a real member's local
// training data and this demo's community/social code share one database.
const DB_NAME = "haimunia-demo-db", STORE = "entries", MOVSTORE = "movements", WODSTORE = "wodEntries", CUSTOMWODSTORE = "customWods", BWSTORE = "bodyweight", SETTINGSTORE = "settings", MEASTYPESTORE = "measureTypes", MEASSTORE = "measurements", OUTBOXSTORE = "syncOutbox", WODTAGSTORE = "wodMovementTags",
      // Launch-readiness audit, RELIABILITY. The community write queue -
      // deliberately a SECOND store rather than more rows in syncOutbox:
      // syncOutbox is a last-write-wins mirror of private_records, this one
      // is an ordered, attempt-counted event queue. See src/outbox.js.
      COMMOUTBOXSTORE = "communityOutbox";
let _dbPromise = null;
function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    // v10 adds communityOutbox. onupgradeneeded is guarded per store, so an
    // existing v9 database gains the new store and keeps every other one.
    const req = indexedDB.open(DB_NAME, 10);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MOVSTORE)) db.createObjectStore(MOVSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(WODSTORE)) db.createObjectStore(WODSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CUSTOMWODSTORE)) db.createObjectStore(CUSTOMWODSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BWSTORE)) db.createObjectStore(BWSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(SETTINGSTORE)) db.createObjectStore(SETTINGSTORE, { keyPath: "key" });
      if (!db.objectStoreNames.contains(MEASTYPESTORE)) db.createObjectStore(MEASTYPESTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(MEASSTORE)) db.createObjectStore(MEASSTORE, { keyPath: "id" });
      if (!db.objectStoreNames.contains(OUTBOXSTORE)) db.createObjectStore(OUTBOXSTORE, { keyPath: "id" });
      // A user-typed WOD builder movement (e.g. "Sandbag Carry") used to
      // live only in the in-memory WOD_MOVEMENT_TAGS array, unlike every
      // other "custom X" feature (movements, WODs), which all write
      // through to IndexedDB - it vanished on reload, and re-building a
      // similar WOD meant re-categorizing the same movement from scratch.
      if (!db.objectStoreNames.contains(WODTAGSTORE)) db.createObjectStore(WODTAGSTORE, { keyPath: "name" });
      if (!db.objectStoreNames.contains(COMMOUTBOXSTORE)) db.createObjectStore(COMMOUTBOXSTORE, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { _dbPromise = null; reject(req.error); };
  });
  return _dbPromise;
}
// Settings live in IndexedDB alongside everything else. userName is the only
// PII in the app and previously sat in localStorage, which "clear all data"
// never touched.
async function dbGetSetting(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(SETTINGSTORE, "readonly").objectStore(SETTINGSTORE).get(key);
    req.onsuccess = () => resolve(req.result ? req.result.value : null);
    req.onerror = () => reject(req.error);
  });
}
async function dbSetSetting(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGSTORE, "readwrite");
    tx.objectStore(SETTINGSTORE).put({ key, value });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearSettings() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SETTINGSTORE, "readwrite");
    tx.objectStore(SETTINGSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadMovements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOVSTORE, "readonly");
    const req = tx.objectStore(MOVSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbAddMovement(m) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOVSTORE, "readwrite");
    tx.objectStore(MOVSTORE).put(m);
    tx.oncomplete = () => { queueSyncRecord("movement", m); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearMovements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOVSTORE, "readwrite");
    tx.objectStore(MOVSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadWodMovementTags() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(WODTAGSTORE, "readonly").objectStore(WODTAGSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbAddWodMovementTag(t) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODTAGSTORE, "readwrite");
    tx.objectStore(WODTAGSTORE).put(t);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearWodMovementTags() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODTAGSTORE, "readwrite");
    tx.objectStore(WODTAGSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadWodEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODSTORE, "readonly");
    const req = tx.objectStore(WODSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPutWodEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODSTORE, "readwrite");
    tx.objectStore(WODSTORE).put(entry);
    tx.oncomplete = () => { queueSyncRecord("wod_entry", entry); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteWodEntry(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODSTORE, "readwrite");
    tx.objectStore(WODSTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("wod_entry", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearWodEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WODSTORE, "readwrite");
    tx.objectStore(WODSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadCustomWods() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CUSTOMWODSTORE, "readonly");
    const req = tx.objectStore(CUSTOMWODSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbAddCustomWod(w) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CUSTOMWODSTORE, "readwrite");
    tx.objectStore(CUSTOMWODSTORE).put(w);
    tx.oncomplete = () => { queueSyncRecord("custom_wod", w); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearCustomWods() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CUSTOMWODSTORE, "readwrite");
    tx.objectStore(CUSTOMWODSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadBodyweight() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BWSTORE, "readonly");
    const req = tx.objectStore(BWSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPutBodyweight(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BWSTORE, "readwrite");
    tx.objectStore(BWSTORE).put(entry);
    tx.oncomplete = () => { queueSyncRecord("bodyweight", entry); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteBodyweight(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BWSTORE, "readwrite");
    tx.objectStore(BWSTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("bodyweight", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearBodyweight() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(BWSTORE, "readwrite");
    tx.objectStore(BWSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadMeasureTypes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(MEASTYPESTORE, "readonly").objectStore(MEASTYPESTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbAddMeasureType(t) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASTYPESTORE, "readwrite");
    tx.objectStore(MEASTYPESTORE).put(t);
    tx.oncomplete = () => { queueSyncRecord("measure_type", t); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteMeasureType(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASTYPESTORE, "readwrite");
    tx.objectStore(MEASTYPESTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("measure_type", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearMeasureTypes() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASTYPESTORE, "readwrite");
    tx.objectStore(MEASTYPESTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadMeasurements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(MEASSTORE, "readonly").objectStore(MEASSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPutMeasurement(m) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASSTORE, "readwrite");
    tx.objectStore(MEASSTORE).put(m);
    tx.oncomplete = () => { queueSyncRecord("measurement", m); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteMeasurement(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASSTORE, "readwrite");
    tx.objectStore(MEASSTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("measurement", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClearMeasurements() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MEASSTORE, "readwrite");
    tx.objectStore(MEASSTORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadAll() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => { queueSyncRecord("strength_entry", entry); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDelete(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("strength_entry", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
async function dbClear() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
async function dbPutSyncOutboxRow(row) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOXSTORE, "readwrite");
    tx.objectStore(OUTBOXSTORE).put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadSyncOutbox() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(OUTBOXSTORE, "readonly").objectStore(OUTBOXSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbDeleteSyncOutbox(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(OUTBOXSTORE, "readwrite");
    tx.objectStore(OUTBOXSTORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
// The community write queue (src/outbox.js). Same three-call shape as the
// private_records outbox above, against its own store.
async function dbPutCommunityOutboxRow(row) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COMMOUTBOXSTORE, "readwrite");
    tx.objectStore(COMMOUTBOXSTORE).put(row);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function dbLoadCommunityOutbox() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(COMMOUTBOXSTORE, "readonly").objectStore(COMMOUTBOXSTORE).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
async function dbDeleteCommunityOutbox(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(COMMOUTBOXSTORE, "readwrite");
    tx.objectStore(COMMOUTBOXSTORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteMovementRecord(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(MOVSTORE, "readwrite");
    tx.objectStore(MOVSTORE).delete(id);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
async function dbDeleteCustomWod(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CUSTOMWODSTORE, "readwrite");
    tx.objectStore(CUSTOMWODSTORE).delete(id);
    tx.oncomplete = () => { queueSyncRecord("custom_wod", { id }, true); resolve(); };
    tx.onerror = () => reject(tx.error);
  });
}
