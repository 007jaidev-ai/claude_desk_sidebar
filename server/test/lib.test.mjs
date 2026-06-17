// Unit tests for the chat server's pure helpers. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import * as XLSX from "xlsx";
import {
  contextPreamble, toolLabel, buildUserContent, extractAttachments,
  isAllowedOrigin, parseAllowedOrigins,
} from "../lib.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build a base64 xlsx from an array-of-arrays so tests don't need a fixture.
function xlsxBase64(aoa, sheetName = "Sheet1") {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" });
}

test("contextPreamble: empty when no context", () => {
  assert.equal(contextPreamble(null), "");
  assert.equal(contextPreamble({}), "");
});

test("contextPreamble: describes a form record", () => {
  const out = contextPreamble({ form: { doctype: "Item", docname: "ITM-00021" }, company: "Avinash" });
  assert.match(out, /viewing the Item form "ITM-00021"/);
  assert.match(out, /company: Avinash/);
  assert.match(out, /Resolve "this"/);
});

test("contextPreamble: falls back to list, then route", () => {
  assert.match(contextPreamble({ list: { doctype: "Sales Order" } }), /viewing the Sales Order list/);
  assert.match(contextPreamble({ route: ["query-report", "Stock Balance"] }), /on route query-report\/Stock Balance/);
});

test("toolLabel: known tools", () => {
  assert.equal(toolLabel("Bash", { command: "ls" }), "Ran a command");
  assert.equal(toolLabel("Read", { file_path: "/a/b/CLAUDE.md" }), "Read CLAUDE.md");
  assert.equal(toolLabel("Grep", { pattern: "needle" }), 'Searched for "needle"');
});

test("toolLabel: Frappe/MCP record lookups", () => {
  assert.equal(toolLabel("mcp__frappe__get_doc", { doctype: "Item", name: "ITM-1" }), "Looked up Item ITM-1");
  assert.equal(toolLabel("mcp__frappe__list", { doctype: "Item" }), "Queried Item");
  assert.equal(toolLabel("mcp__server__do_a_thing", {}), "Do a thing");
});

test("buildUserContent: plain string when no attachments", () => {
  assert.equal(buildUserContent("hello", []), "hello");
  assert.equal(buildUserContent("hello"), "hello");
});

test("buildUserContent: image + pdf become inline blocks", () => {
  const content = buildUserContent("look", [
    { kind: "image", mediaType: "image/png", data: "AAAA" },
    { kind: "document", mediaType: "application/pdf", data: "BBBB" },
  ]);
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image");
  assert.equal(content[1].source.media_type, "image/png");
  assert.equal(content[2].type, "document");
  assert.equal(content[2].source.media_type, "application/pdf");
});

test("buildUserContent: drops unsupported types and empty data", () => {
  const content = buildUserContent("x", [
    { kind: "image", mediaType: "image/svg+xml", data: "AAAA" }, // not allowed
    { kind: "document", mediaType: "text/csv", data: "BBBB" },   // not allowed
    { kind: "image", mediaType: "image/png", data: "" },          // empty
  ]);
  assert.equal(content.length, 1); // only the text block survives
});

test("buildUserContent: substitutes placeholder text when prompt empty", () => {
  const content = buildUserContent("", [{ kind: "image", mediaType: "image/png", data: "AAAA" }]);
  assert.equal(content[0].text, "(see attached)");
});

test("buildUserContent: server-extracted text becomes a labeled text block", () => {
  const content = buildUserContent("look", [{ kind: "text", name: "quote.xlsx", text: "| a | b |" }]);
  assert.equal(content.length, 2);
  assert.equal(content[1].type, "text");
  assert.match(content[1].text, /Attached file "quote\.xlsx":/);
  assert.match(content[1].text, /\| a \| b \|/);
});

test("extractAttachments: xlsx becomes a markdown table", async () => {
  const data = xlsxBase64([["Model", "Margin"], ["Luxe 2B", 18], ["Luxe 3B", 21]], "Costing");
  const out = await extractAttachments([
    { kind: "document", name: "quote.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "text");
  assert.equal(out[0].data, undefined); // base64 dropped
  assert.match(out[0].text, /### Costing/);
  assert.match(out[0].text, /\| Model \| Margin \|/);
  assert.match(out[0].text, /\| --- \| --- \|/);
  assert.match(out[0].text, /\| Luxe 2B \| 18 \|/);
});

test("extractAttachments: csv becomes a markdown table", async () => {
  const data = Buffer.from("a,b\n1,2\n3,4").toString("base64");
  const out = await extractAttachments([{ kind: "document", name: "rows.csv", mediaType: "text/csv", data }]);
  assert.match(out[0].text, /\| a \| b \|/);
  assert.match(out[0].text, /\| 1 \| 2 \|/);
});

test("extractAttachments: docx becomes raw text", async () => {
  const data = readFileSync(resolve(__dirname, "fixtures/sample.docx")).toString("base64");
  const out = await extractAttachments([
    { kind: "document", name: "letter.docx", mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data },
  ]);
  assert.equal(out[0].kind, "text");
  assert.match(out[0].text, /Total margin on the Luxe models is 18 percent/);
});

test("extractAttachments: large sheet is row-capped with a truncation note", async () => {
  const aoa = [["n"]];
  for (let i = 1; i <= 1500; i++) aoa.push([i]);
  const data = xlsxBase64(aoa);
  const out = await extractAttachments([
    { kind: "document", name: "big.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data },
  ]);
  // 1500 data rows + 1 header = 1501 rows; cap renders 1000, leaving 501.
  assert.match(out[0].text, /truncated — 501 more row\(s\)/);
  assert.ok(!out[0].text.includes("| 1200 |"));
});

test("extractAttachments: empty/unreadable file degrades to a placeholder, never throws", async () => {
  const out = await extractAttachments([
    { kind: "document", name: "broken.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data: "" },
  ]);
  assert.equal(out[0].kind, "text");
  assert.match(out[0].text, /could not be read/);
});

test("extractAttachments: images and pdfs pass through untouched", async () => {
  const atts = [
    { kind: "image", name: "p.png", mediaType: "image/png", data: "AAAA" },
    { kind: "document", name: "d.pdf", mediaType: "application/pdf", data: "BBBB" },
  ];
  const out = await extractAttachments(atts);
  assert.deepEqual(out, atts);
});

test("extractAttachments: plain text / markdown / log decode to raw text", async () => {
  const data = Buffer.from("# Notes\nrestock the 3B line").toString("base64");
  const out = await extractAttachments([{ kind: "document", name: "notes.md", mediaType: "text/markdown", data }]);
  assert.equal(out[0].kind, "text");
  assert.equal(out[0].data, undefined);
  assert.match(out[0].text, /# Notes/);
  assert.match(out[0].text, /restock the 3B line/);
});

test("extractAttachments: valid JSON is pretty-printed", async () => {
  const data = Buffer.from('{"model":"Luxe 3B","margin":21}').toString("base64");
  const out = await extractAttachments([{ kind: "document", name: "q.json", mediaType: "application/json", data }]);
  assert.match(out[0].text, /"model": "Luxe 3B"/); // re-indented with a space after the colon
});

test("extractAttachments: invalid JSON falls back to raw text", async () => {
  const data = Buffer.from("{not valid json").toString("base64");
  const out = await extractAttachments([{ kind: "document", name: "bad.json", mediaType: "application/json", data }]);
  assert.match(out[0].text, /\{not valid json/);
});

test("extractAttachments: workbook beyond MAX_SHEETS renders the cap and notes the rest", async () => {
  const wb = XLSX.utils.book_new();
  for (let i = 1; i <= 13; i++) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["x"]]), `S${i}`);
  const data = XLSX.write(wb, { type: "base64", bookType: "xlsx" });
  const out = await extractAttachments([
    { kind: "document", name: "many.xlsx", mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", data },
  ]);
  // 12 sheets rendered (MAX_SHEETS), the 13th summarized — not dumped.
  assert.equal((out[0].text.match(/^### /gm) || []).length, 12);
  assert.match(out[0].text, /1 more sheet\(s\) not shown/);
  assert.ok(!out[0].text.includes("### S13"));
});

test("isAllowedOrigin: allows the local Desk origins", () => {
  assert.ok(isAllowedOrigin("http://127.0.0.1:8000"));
  assert.ok(isAllowedOrigin("http://localhost:8888"));
  assert.ok(isAllowedOrigin("http://avinash2.localhost:8888")); // *.localhost
});

test("isAllowedOrigin: allows non-browser clients (no Origin header)", () => {
  assert.ok(isAllowedOrigin(undefined));
  assert.ok(isAllowedOrigin(""));
});

test("isAllowedOrigin: rejects foreign and malformed origins", () => {
  assert.equal(isAllowedOrigin("https://evil.com"), false);
  assert.equal(isAllowedOrigin("http://localhost.evil.com"), false); // not *.localhost
  assert.equal(isAllowedOrigin("not a url"), false);
});

test("isAllowedOrigin: honors the allowlist and the '*' opt-out", () => {
  const list = parseAllowedOrigins("https://desk.example.com, https://b.example.com/");
  assert.ok(isAllowedOrigin("https://desk.example.com", list));
  assert.ok(isAllowedOrigin("https://b.example.com", list)); // trailing slash normalized
  assert.equal(isAllowedOrigin("https://c.example.com", list), false);
  assert.ok(isAllowedOrigin("https://anything.com", parseAllowedOrigins("*")));
});

test("parseAllowedOrigins: splits, trims, lowercases, drops empties", () => {
  assert.deepEqual(parseAllowedOrigins("  https://A.com ,, https://B.com/ "),
    ["https://a.com", "https://b.com"]);
  assert.deepEqual(parseAllowedOrigins(""), []);
});
