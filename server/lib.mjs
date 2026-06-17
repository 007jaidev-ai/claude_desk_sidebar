// lib.mjs — pure helpers for the chat server, split out so they can be unit
// tested under Node without starting the WebSocket server.

import { basename } from "node:path";
import * as XLSX from "xlsx";
import mammoth from "mammoth";

export const ALLOWED_IMAGE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export const MAX_ATTACH = 8;
export const MAX_ATTACH_B64 = 32 * 1024 * 1024; // ~24MB of real bytes across a turn

// Spreadsheet / document types we extract to text on the server instead of
// shipping raw bytes to the model. Keyed by mediaType so the client can keep
// sending plain `kind: "document"` attachments.
export const SHEET_TYPES = new Set([
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export const DOC_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

// Generous-cap guardrails so a huge workbook can't blow the context window.
export const MAX_SHEET_ROWS = 1000; // rows rendered per sheet (incl. header)
export const MAX_SHEET_COLS = 60;   // columns rendered per sheet
export const MAX_SHEETS = 12;       // sheets rendered per workbook
export const MAX_EXTRACT_CHARS = 200_000; // hard stop on extracted text per file

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
    // Server-extracted spreadsheet/doc text (see extractAttachments) carries no
    // base64 `data`, so handle it before the data guard below.
    if (att.kind === "text" && att.text) {
      content.push({ type: "text", text: `Attached file "${att.name || "file"}":\n${att.text}` });
      count++;
      continue;
    }
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

// Server-side extraction: turn spreadsheet/doc attachments into plain text the
// model can read, BEFORE buildUserContent runs. Images and PDFs pass through
// untouched (they go inline as native blocks). xlsx/csv/docx become a light
// `{ kind: "text", name, text }` entry — the heavy base64 is dropped. A single
// file that fails to parse degrades to a short placeholder note rather than
// breaking the turn. Kept separate from buildUserContent so that helper stays
// pure/sync; this one is async because mammoth is.
export async function extractAttachments(attachments) {
  if (!attachments || !attachments.length) return attachments || [];
  const out = [];
  for (const att of attachments) {
    const media = att?.mediaType || "";
    const isSheet = SHEET_TYPES.has(media);
    const isDoc = DOC_TYPES.has(media);
    if (!isSheet && !isDoc) {
      out.push(att); // image / pdf / anything else: leave as-is
      continue;
    }
    const name = att?.name || (isSheet ? "spreadsheet" : "document");
    try {
      const buffer = Buffer.from(typeof att?.data === "string" ? att.data : "", "base64");
      if (!buffer.length) throw new Error("empty file");
      const text = isSheet ? extractWorkbook(buffer) : await extractDocx(buffer);
      out.push({ kind: "text", name, text: clampChars(text, MAX_EXTRACT_CHARS) });
    } catch (err) {
      console.warn(`[sena-chat] could not extract "${name}":`, err?.message || err);
      out.push({ kind: "text", name, text: `Attached file "${name}" could not be read (${err?.message || "unknown error"}).` });
    }
  }
  return out;
}

// Render every sheet of a workbook (or a CSV) as a markdown table. SheetJS
// reads csv/xls/xlsx from the same buffer entry point.
function extractWorkbook(buffer) {
  const wb = XLSX.read(buffer, { type: "buffer" });
  const names = wb.SheetNames.slice(0, MAX_SHEETS);
  const parts = [];
  for (const sheetName of names) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: "" });
    parts.push(`### ${sheetName}\n\n${rowsToMarkdown(rows)}`);
  }
  if (wb.SheetNames.length > MAX_SHEETS) {
    parts.push(`_(${wb.SheetNames.length - MAX_SHEETS} more sheet(s) not shown.)_`);
  }
  return parts.join("\n\n");
}

async function extractDocx(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return (result?.value || "").trim() || "_(no readable text)_";
}

// Array-of-arrays (from sheet_to_json header:1) -> a markdown table, capped.
function rowsToMarkdown(rows) {
  if (!rows || !rows.length) return "_(empty sheet)_";
  const shown = rows.slice(0, MAX_SHEET_ROWS);
  const cols = Math.min(MAX_SHEET_COLS, shown.reduce((m, r) => Math.max(m, (r || []).length), 0));
  if (!cols) return "_(empty sheet)_";
  const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
  const line = (r) => "| " + Array.from({ length: cols }, (_, i) => cell((r || [])[i])).join(" | ") + " |";
  const lines = [line(shown[0]), "| " + Array.from({ length: cols }, () => "---").join(" | ") + " |"];
  for (let i = 1; i < shown.length; i++) lines.push(line(shown[i]));
  if (rows.length > MAX_SHEET_ROWS) lines.push(`\n_(truncated — ${rows.length - MAX_SHEET_ROWS} more row(s) not shown.)_`);
  return lines.join("\n");
}

function clampChars(text, max) {
  const s = String(text ?? "");
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}
