// sena_chat_idb.js — tiny IndexedDB store for attachment previews (images).
//
// Keeps localStorage small: the chat store holds only an `idbId`; the actual
// dataUrl lives here (IndexedDB has a far larger quota). Every op degrades
// gracefully to a no-op if IndexedDB is unavailable (private mode, old browser).

const DB_NAME = "sena-ai-chat";
const STORE = "attachments";
let dbPromise = null;

function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        try {
            const req = indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => { req.result.createObjectStore(STORE); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        } catch (error) { reject(error); }
    });
    return dbPromise;
}

function run(mode, op) {
    return open().then((db) => new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const request = op(t.objectStore(STORE));
        t.oncomplete = () => resolve(request ? request.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
    }));
}

export async function idbPut(id, value) {
    try { await run("readwrite", (s) => s.put(value, id)); } catch (_e) { /* ignore */ }
}

export async function idbGet(id) {
    try { return await run("readonly", (s) => s.get(id)); } catch (_e) { return undefined; }
}

export async function idbDeleteMany(ids) {
    if (!ids || !ids.length) return;
    try { await run("readwrite", (s) => { ids.forEach((id) => s.delete(id)); return null; }); } catch (_e) { /* ignore */ }
}
