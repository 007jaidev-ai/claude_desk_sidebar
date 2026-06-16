// Unit tests for the chat server's pure helpers. Run: node --test
import { test } from "node:test";
import assert from "node:assert/strict";
import { contextPreamble, toolLabel, buildUserContent } from "../lib.mjs";

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
