// sena_chat_store.js — localStorage-backed multi-chat history store.
//
// Pure JS (no preact, no DOM beyond localStorage) so it can be unit-tested under
// Node with a localStorage mock. esbuild inlines it into sena_ai_sidebar.bundle.js.
//
// Each chat keeps its transcript (re-readable after reload) and its SDK session
// id (so reopening resumes the agent's memory). One localStorage key holds the
// whole store; the newest MAX_CHATS are kept. Image previews are NOT stored here
// (only an `idbId` pointer) — the bytes live in IndexedDB to spare the quota.

export const CHATS_KEY = "sena-ai-sidebar::chats";
export const MAX_CHATS = 40;

export function genId() {
    try { return crypto.randomUUID(); } catch (_e) { /* older browsers */ }
    return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadStore() {
    try {
        const parsed = JSON.parse(localStorage.getItem(CHATS_KEY) || "null");
        if (parsed && Array.isArray(parsed.chats)) return parsed;
    } catch (_e) { /* corrupt or absent */ }
    return { version: 1, currentId: null, chats: [] };
}

// Low-level write: keep newest MAX_CHATS; on quota errors drop oldest and retry.
// Returns the chats that were evicted (so the caller can clean their IndexedDB
// attachment blobs).
export function saveStore(store) {
    store.chats.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const evicted = store.chats.length > MAX_CHATS ? store.chats.splice(MAX_CHATS) : [];
    for (let attempt = 0; attempt < 6; attempt++) {
        try { localStorage.setItem(CHATS_KEY, JSON.stringify(store)); return evicted; }
        catch (_e) { if (!store.chats.length) return evicted; evicted.push(store.chats.pop()); }
    }
    return evicted;
}

// Strip ephemeral/redacted fields before persisting — keep only what we render,
// plus the idbId pointer to the image preview in IndexedDB.
export function persistMessages(messages) {
    return (messages || []).map((m) => ({
        role: m.role,
        text: m.text || "",
        tools: (m.tools || []).map((t) => ({ label: t.label, status: t.status })),
        attachments: (m.attachments || []).map((a) => ({
            name: a.name, kind: a.kind, mediaType: a.mediaType, idbId: a.idbId || null,
        })),
    }));
}

// Restore stored messages to the in-memory render shape (dataUrl filled later
// from IndexedDB by the caller).
export function hydrateMessages(stored) {
    return (stored || []).map((m) => ({
        role: m.role,
        text: m.text || "",
        tools: (m.tools || []).map((t) => ({ ...t })),
        attachments: (m.attachments || []).map((a) => ({ ...a })),
        thinking: null,
        done: true,
    }));
}

export function chatTitleFrom(messages) {
    const first = (messages || []).find((m) => m.role === "user" && m.text);
    const text = (first?.text || "New chat").replace(/\s+/g, " ").trim();
    return text.length > 50 ? text.slice(0, 50) + "…" : text;
}

export function newChatRecord() {
    const now = Date.now();
    return { id: genId(), title: "New chat", sessionId: null, createdAt: now, updatedAt: now, messages: [] };
}

export function chatMetaList(store) {
    return store.chats
        .slice()
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
        .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }));
}

export function relativeTime(ms) {
    const s = Math.max(0, Math.round((Date.now() - (ms || 0)) / 1000));
    if (s < 60) return "just now";
    const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
    const hr = Math.round(m / 60); if (hr < 24) return `${hr}h ago`;
    const d = Math.round(hr / 24); return `${d}d ago`;
}

// Collect IndexedDB attachment ids referenced by a set of chats (for cleanup).
export function attachmentIdsOf(chats) {
    const ids = [];
    for (const chat of chats || []) {
        for (const m of chat.messages || []) {
            for (const a of m.attachments || []) if (a.idbId) ids.push(a.idbId);
        }
    }
    return ids;
}

// ---- Multi-tab-safe writers: always reload from disk before writing, so we
// never clobber chats another tab created since our in-memory copy. ----

// Upsert a chat (by id); optionally mark it current. Returns { store, evicted }.
export function commitChat(chat, opts) {
    const store = loadStore();
    const idx = store.chats.findIndex((c) => c.id === chat.id);
    if (idx >= 0) store.chats[idx] = chat; else store.chats.push(chat);
    if (opts && opts.setCurrent) store.currentId = chat.id;
    const evicted = saveStore(store);
    return { store, evicted };
}

export function deleteChatById(id) {
    const store = loadStore();
    const removed = store.chats.filter((c) => c.id === id);
    store.chats = store.chats.filter((c) => c.id !== id);
    if (store.currentId === id) store.currentId = null;
    saveStore(store);
    return { store, removed };
}

export function setCurrentId(id) {
    const store = loadStore();
    store.currentId = id;
    saveStore(store);
    return store;
}

export function getChat(id) {
    return loadStore().chats.find((c) => c.id === id) || null;
}
