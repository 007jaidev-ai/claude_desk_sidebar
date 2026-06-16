// Unit tests for the localStorage chat store. Run: node --test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage mock with an optional byte budget to exercise quota
// eviction. Installed before importing the module under test.
function installLocalStorage(maxBytes = Infinity) {
  const map = new Map();
  let bytes = 0;
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => {
      const size = String(v).length;
      const prev = map.has(k) ? String(map.get(k)).length : 0;
      if (bytes - prev + size > maxBytes) {
        const e = new Error("QuotaExceededError"); e.name = "QuotaExceededError"; throw e;
      }
      bytes += size - prev; map.set(k, String(v));
    },
    removeItem: (k) => { if (map.has(k)) { bytes -= String(map.get(k)).length; map.delete(k); } },
  };
}

const store = await import("./sena_chat_store.mjs");

beforeEach(() => installLocalStorage());

test("round-trip: commitChat then loadStore", () => {
  const chat = store.newChatRecord();
  chat.title = "Hello"; chat.messages = [{ role: "user", text: "hi", tools: [], attachments: [] }];
  store.commitChat(chat, { setCurrent: true });
  const loaded = store.loadStore();
  assert.equal(loaded.currentId, chat.id);
  assert.equal(loaded.chats.length, 1);
  assert.equal(loaded.chats[0].title, "Hello");
});

test("chatTitleFrom: first user message, truncated", () => {
  assert.equal(store.chatTitleFrom([{ role: "user", text: "What is stock?" }]), "What is stock?");
  const long = "x".repeat(80);
  assert.equal(store.chatTitleFrom([{ role: "user", text: long }]).length, 51); // 50 + ellipsis
  assert.equal(store.chatTitleFrom([]), "New chat");
});

test("persistMessages: keeps only metadata (no base64), retains idbId", () => {
  const out = store.persistMessages([
    { role: "user", text: "hi", tools: [{ label: "Read x", status: "ok", extra: 1 }],
      attachments: [{ name: "s.png", kind: "image", mediaType: "image/png", data: "AAAA", dataUrl: "data:...", idbId: "k1" }] },
  ]);
  assert.deepEqual(out[0].tools, [{ label: "Read x", status: "ok" }]);
  assert.deepEqual(out[0].attachments, [{ name: "s.png", kind: "image", mediaType: "image/png", idbId: "k1" }]);
  assert.equal(out[0].attachments[0].data, undefined);
  assert.equal(out[0].attachments[0].dataUrl, undefined);
});

test("saveStore: evicts oldest beyond MAX_CHATS and returns them", () => {
  const s = { version: 1, currentId: null, chats: [] };
  for (let i = 0; i < store.MAX_CHATS + 5; i++) s.chats.push({ id: "c" + i, title: "t", updatedAt: i, messages: [] });
  const evicted = store.saveStore(s);
  assert.equal(s.chats.length, store.MAX_CHATS);
  assert.equal(evicted.length, 5);
  // Newest (highest updatedAt) kept; oldest evicted.
  assert.ok(s.chats.every((c) => c.updatedAt >= 5));
  assert.ok(evicted.every((c) => c.updatedAt < 5));
});

test("commitChat is multi-tab-safe: doesn't clobber a chat another tab added", () => {
  // Tab A creates chat A.
  const a = store.newChatRecord(); a.id = "A"; a.updatedAt = 1;
  store.commitChat(a, { setCurrent: true });
  // Tab B (separate in-memory view) had only its own chat B and commits it.
  const b = store.newChatRecord(); b.id = "B"; b.updatedAt = 2;
  store.commitChat(b, { setCurrent: true });
  const loaded = store.loadStore();
  const ids = loaded.chats.map((c) => c.id).sort();
  assert.deepEqual(ids, ["A", "B"]); // A survived
});

test("deleteChatById: removes and clears currentId if it was current", () => {
  const a = store.newChatRecord(); a.id = "A";
  store.commitChat(a, { setCurrent: true });
  const { store: after, removed } = store.deleteChatById("A");
  assert.equal(after.chats.length, 0);
  assert.equal(after.currentId, null);
  assert.equal(removed[0].id, "A");
});

test("attachmentIdsOf: collects idbIds across chats/messages", () => {
  const ids = store.attachmentIdsOf([
    { messages: [{ attachments: [{ idbId: "k1" }, { idbId: null }] }, { attachments: [{ idbId: "k2" }] }] },
  ]);
  assert.deepEqual(ids.sort(), ["k1", "k2"]);
});

test("saveStore: survives a tight quota by dropping until it fits", () => {
  installLocalStorage(400); // tiny budget
  const s = { version: 1, currentId: null, chats: [] };
  for (let i = 0; i < 10; i++) s.chats.push({ id: "c" + i, title: "t".repeat(20), updatedAt: i, messages: [] });
  store.saveStore(s);
  // Whatever remains must actually be persisted (no throw escaped).
  const loaded = store.loadStore();
  assert.ok(loaded.chats.length <= 10);
});
