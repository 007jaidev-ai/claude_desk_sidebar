// chat-server.mjs — Phase 1.
//
// A tiny WebSocket server that wraps the Claude Agent SDK. The browser cannot
// run the SDK (it needs Node + filesystem access to BE Claude Code), so this
// Node process holds the SDK and relays messages to/from the browser over a
// WebSocket on port 7683 — running ALONGSIDE the existing ttyd terminal (7681).
//
// Wire protocol (server -> browser), one JSON object per ws frame:
//   { kind: "text",  text }   incremental assistant text (render as it arrives)
//   { kind: "tool",  name }   the agent started using a tool (show a chip)
//   { kind: "done",  session }final-of-turn; carries the session id for later
//   { kind: "error", message }something went wrong this turn
//
// Browser -> server:
//   { text }                  the user's message for this turn
//
// Run:  node chat-server.mjs

import { WebSocketServer } from "ws";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONTEXT_DIR = resolve(__dirname, "../context"); // loads ../context/CLAUDE.md

const PORT = Number(process.env.SENA_CHAT_PORT || 7683);
// Bind to loopback only — this is a local dev tool, never exposed to the network.
const wss = new WebSocketServer({ host: "127.0.0.1", port: PORT });

console.log(`[sena-chat] listening on ws://127.0.0.1:${PORT} (cwd=${CONTEXT_DIR})`);

// Build a short context note from the Desk snapshot the browser sends with each
// message. This is what lets the agent resolve "this", "here", "current item"
// without the user typing a doctype/name — they're already looking at it.
function contextPreamble(context) {
  if (!context || typeof context !== "object") return "";
  const bits = [];
  if (context.form?.doctype) {
    bits.push(`viewing the ${context.form.doctype} form${context.form.docname ? ` "${context.form.docname}"` : ""}`);
  } else if (context.list?.doctype) {
    bits.push(`viewing the ${context.list.doctype} list`);
  } else if (Array.isArray(context.route) && context.route.length) {
    bits.push(`on route ${context.route.join("/")}`);
  }
  if (context.href) bits.push(`url: ${context.href}`);
  if (context.company) bits.push(`company: ${context.company}`);
  if (context.user) bits.push(`signed in as: ${context.user}`);
  if (!bits.length) return "";
  return (
    `[Current Desk context — the user is ${bits.join("; ")}. ` +
    `Resolve "this", "here", "current", and "same screen" against this context.]\n\n`
  );
}

wss.on("connection", (ws) => {
  console.log("[sena-chat] client connected");

  // Per-connection state.
  let sessionId = null; // captured from each turn's "result"; reused for multi-turn later
  let busy = false;     // one active query() per connection at a time

  const send = (obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };

  ws.on("message", async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      return send({ kind: "error", message: "Bad JSON from client." });
    }

    const text = (payload?.text || "").trim();
    if (!text) return;

    // The browser attaches a snapshot of the screen the user is on. Prepend it
    // so "this"/"here"/"current" just work. Sent every turn (the user may have
    // navigated between messages), and it's cheap.
    const prompt = contextPreamble(payload?.context) + text;

    // Guard: ignore a new prompt while a turn is still streaming. The browser
    // also disables its send button, but never trust the client.
    if (busy) {
      return send({ kind: "error", message: "Still answering the previous message." });
    }
    busy = true;

    try {
      const options = {
        cwd: CONTEXT_DIR,
        permissionMode: "bypassPermissions",
        systemPrompt: { type: "preset", preset: "claude_code" },
        includePartialMessages: true,
      };
      // Multi-turn memory: after the first turn we have a sessionId, so resume
      // that session instead of starting fresh. This is what lets turn N see
      // everything from turns 1..N-1. Without it, every message is a blank slate.
      if (sessionId) {
        options.resume = sessionId;
      }

      const response = query({ prompt, options });

      for await (const msg of response) {
        if (msg.type === "stream_event") {
          const ev = msg.event;
          // Streaming assistant text.
          if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
            send({ kind: "text", text: ev.delta.text });
          }
          // A tool call is starting — surface it as a chip in the UI.
          if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
            send({ kind: "tool", name: ev.content_block.name });
          }
        } else if (msg.type === "result") {
          // Capture the session id so the NEXT turn can resume this session.
          // Do NOT send "done" here: the client reacts to "done" by firing its
          // next message instantly, and if we haven't cleared `busy` yet that
          // message races in and gets rejected. Send "done" in finally, after
          // busy is false, so the server is provably ready for the next turn.
          sessionId = msg.session_id;
        }
      }
    } catch (err) {
      console.error("[sena-chat] query error:", err);
      send({ kind: "error", message: String(err?.message || err) });
    } finally {
      // Clear busy BEFORE announcing done — this closes the race above.
      busy = false;
      send({ kind: "done", session: sessionId });
    }
  });

  ws.on("close", () => console.log("[sena-chat] client disconnected"));
  ws.on("error", (e) => console.error("[sena-chat] ws error:", e));
});
