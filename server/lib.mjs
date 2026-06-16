// lib.mjs — pure helpers for the chat server, split out so they can be unit
// tested under Node without starting the WebSocket server.

import { basename } from "node:path";

export const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_ATTACH = 8;
export const MAX_ATTACH_B64 = 32 * 1024 * 1024; // ~24MB of real bytes across a turn

// Desk-screen note prepended to every message so "this"/"here"/"current"
// resolve without the user typing a doctype/name.
export function contextPreamble(context) {
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

// Turn a raw tool call into a short, human-readable label for the chip.
export function toolLabel(name, input) {
  const i = input || {};
  const t = (s, n = 48) => (s && String(s).length > n ? String(s).slice(0, n) + "…" : String(s || ""));
  switch (name) {
    case "Bash": return `Ran a command`;
    case "Read": return `Read ${basename(i.file_path || "a file")}`;
    case "Edit": return `Edited ${basename(i.file_path || "a file")}`;
    case "Write": return `Wrote ${basename(i.file_path || "a file")}`;
    case "Grep": return `Searched for "${t(i.pattern, 32)}"`;
    case "Glob": return `Looked for files (${t(i.pattern, 32)})`;
    case "WebFetch": return `Fetched a page`;
    case "WebSearch": return `Searched the web`;
    case "Task": return `Ran a sub-task`;
  }
  if (i.doctype && (i.name || i.docname)) return `Looked up ${i.doctype} ${i.name || i.docname}`;
  if (i.doctype) return `Queried ${i.doctype}`;
  const tail = name?.startsWith("mcp__") ? name.split("__").pop() : name;
  const words = String(tail || "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Working";
}

// Build a multimodal user-message content array. Images and PDFs go inline as
// base64 blocks; anything else is dropped (the client pre-filters). Returns the
// plain prompt string when there are no attachments.
export function buildUserContent(prompt, attachments) {
  if (!attachments || !attachments.length) return prompt;
  const content = [{ type: "text", text: prompt || "(see attached)" }];
  let total = 0, count = 0;
  for (const att of attachments) {
    if (count >= MAX_ATTACH) break;
    const data = typeof att?.data === "string" ? att.data : "";
    if (!data) continue;
    total += data.length;
    if (total > MAX_ATTACH_B64) break;
    const media = att.mediaType || "";
    if (att.kind === "image" && ALLOWED_IMAGE.has(media)) {
      content.push({ type: "image", source: { type: "base64", media_type: media, data } });
      count++;
    } else if (att.kind === "document" && media === "application/pdf") {
      content.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data } });
      count++;
    }
  }
  return content;
}
