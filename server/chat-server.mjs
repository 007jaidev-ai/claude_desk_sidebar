// chat-server.mjs
//
// WebSocket server that wraps the Claude Agent SDK and relays a small JSON
// protocol to the browser chat UI. Runs alongside the ttyd terminal (7681) on
// port 7683. Auth is inherited from the local Claude Code login (~/.claude) —
// no API key.
//
// Why streaming-input mode: each turn feeds the SDK a one-message async stream
// (rather than a plain string). That keeps the proven resume-based memory but
// unlocks query.interrupt() — control requests only work in streaming mode — so
// the UI can Stop a long turn.
//
// Client -> server frames:
//   { type: "resume", session }       continue a stored session (sent on connect)
//   { type: "send", text, context }   a user message + current Desk screen
//   { type: "stop" }                  interrupt the in-flight turn
//   { type: "new" }                   drop the session, start fresh
//
// Server -> client frames:
//   { kind: "text", text }            streaming assistant text
//   { kind: "thinking", text }        streaming reasoning (for the dropdown)
//   { kind: "tool", id, label }       a tool started (human label)
//   { kind: "tool_done", id, ok }     that tool finished (✓ / ✗)
//   { kind: "done", session, stopped} turn ended; carries session id
//   { kind: "error", message }        something failed

import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { contextPreamble, toolLabel, buildUserContent } from "./lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_DIR = resolve(__dirname, "../context"); // loads ../context/CLAUDE.md

const PORT = Number(process.env.SENA_CHAT_PORT || 7683);
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });
console.log(`[sena-chat] listening on ws://127.0.0.1:${PORT} (cwd=${CONTEXT_DIR})`);

// A minimal pushable async-iterable: we push the user message in, and close it
// once the turn's result arrives so the SDK knows the turn is complete.
function pushableQueue() {
  const values = [];
  let resolveNext = null;
  let closed = false;
  return {
    push(value) {
      if (closed) return;
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value, done: false }); }
      else values.push(value);
    },
    close() {
      closed = true;
      if (resolveNext) { const r = resolveNext; resolveNext = null; r({ value: undefined, done: true }); }
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (values.length) { yield values.shift(); continue; }
        if (closed) return;
        const next = await new Promise((res) => { resolveNext = res; });
        if (next.done) return;
        yield next.value;
      }
    },
  };
}

wss.on("connection", (ws) => {
  console.log("[sena-chat] client connected");

  // Per-connection state.
  let sessionId = null;     // resumed/continued session; null = fresh
  let busy = false;         // one in-flight turn at a time
  let currentQuery = null;  // active Query (for interrupt)
  let currentQueue = null;  // active input stream (to close on result)

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  async function runTurn(text, context, attachments = []) {
    busy = true;
    let stopped = false;
    let produced = false; // did this attempt stream anything before failing?
    const prompt = contextPreamble(context) + text;
    // String when no attachments; otherwise a multimodal content array.
    const userContent = buildUserContent(prompt, attachments);

    // One streaming attempt. With useResume=false we deliberately start fresh.
    const attempt = async (useResume) => {
      produced = false;
      const queue = pushableQueue();
      currentQueue = queue;
      const options = {
        cwd: CONTEXT_DIR,
        permissionMode: "bypassPermissions",
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
        thinking: { type: "adaptive" }, // let Claude show reasoning when it helps
      };
      if (useResume && sessionId) options.resume = sessionId; // multi-turn memory

      const response = query({ prompt: queue, options });
      currentQuery = response;
      queue.push({ type: "user", message: { role: "user", content: userContent }, parent_tool_use_id: null });

      for await (const msg of response) {
        // `produced` = did we emit any VISIBLE content? A failed resume yields
        // only an error `result` (no text/tool/thinking), so this stays false
        // and the catch below retries fresh. A mid-stream error keeps memory.
        if (msg.type === "stream_event") {
          const ev = msg.event;
          if (ev.type === "content_block_start" && ev.content_block?.type === "thinking") {
            produced = true;
            send({ kind: "thinking_start" });
          } else if (ev.type === "content_block_delta") {
            if (ev.delta?.type === "text_delta") { produced = true; send({ kind: "text", text: ev.delta.text }); }
            // Reasoning text is redacted on the subscription login (empty), but
            // forward it anyway so it auto-fills if a richer auth ever exposes it.
            else if (ev.delta?.type === "thinking_delta" && ev.delta.thinking) {
              produced = true;
              send({ kind: "thinking", text: ev.delta.thinking });
            }
          }
        } else if (msg.type === "system" && msg.subtype === "thinking_tokens") {
          // The only thinking signal the subscription exposes: how much it thought.
          send({ kind: "thinking_tokens", tokens: msg.estimated_tokens });
        } else if (msg.type === "assistant") {
          for (const block of msg.message?.content || []) {
            if (block.type === "tool_use") { produced = true; send({ kind: "tool", id: block.id, label: toolLabel(block.name, block.input) }); }
          }
        } else if (msg.type === "user") {
          for (const block of msg.message?.content || []) {
            if (block.type === "tool_result") send({ kind: "tool_done", id: block.tool_use_id, ok: !block.is_error });
          }
        } else if (msg.type === "result") {
          sessionId = msg.session_id;
          if (msg.subtype && msg.subtype !== "success") stopped = true;
          queue.close(); // turn complete → end the input stream
        }
      }
    };

    try {
      try {
        await attempt(true);
      } catch (err) {
        // If resuming a (likely expired) session failed before producing
        // anything, drop it and retry fresh once — the chat keeps working.
        if (sessionId && !produced) {
          console.warn("[sena-chat] resume failed; starting a fresh session:", err?.message || err);
          sessionId = null;
          send({ kind: "session_reset" });
          await attempt(false);
        } else {
          throw err;
        }
      }
    } catch (err) {
      console.error("[sena-chat] turn error:", err);
      send({ kind: "error", message: String(err?.message || err) });
    } finally {
      // Clear busy BEFORE announcing done, so the client's next message can't
      // race in and get rejected.
      busy = false;
      currentQuery = null;
      currentQueue = null;
      send({ kind: "done", session: sessionId, stopped });
    }
  }

  ws.on("message", async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return send({ kind: "error", message: "Bad JSON from client." });
    }
    const type = payload?.type || "send";

    if (type === "resume") {
      // Continue a session the browser had stored (survives reloads).
      if (!busy && typeof payload.session === "string") sessionId = payload.session;
      return;
    }

    if (type === "new") {
      // Drop the session and start fresh. Interrupt anything in flight.
      if (currentQuery && busy) { try { await currentQuery.interrupt(); } catch (_e) {} }
      if (currentQueue) currentQueue.close();
      sessionId = null;
      busy = false;
      return send({ kind: "new_ok" });
    }

    if (type === "stop") {
      if (currentQuery && busy) { try { await currentQuery.interrupt(); } catch (_e) {} }
      return;
    }

    // type === "send"
    const text = (payload?.text || "").trim();
    const attachments = Array.isArray(payload?.attachments) ? payload.attachments : [];
    if (!text && !attachments.length) return;
    if (busy) return send({ kind: "error", message: "Still answering the previous message." });
    runTurn(text, payload?.context, attachments);
  });

  ws.on("close", () => {
    if (currentQueue) currentQueue.close();
    console.log("[sena-chat] client disconnected");
  });
  ws.on("error", (e) => console.error("[sena-chat] ws error:", e));
});
