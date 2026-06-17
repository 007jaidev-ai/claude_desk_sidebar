/*
 * claude-desk-sidebar — frontend chat module (reference snapshot)
 *
 * EXCERPT of the chat UI as it lives inside the Frappe app bundle
 * sena_erp/public/js/sena_ai_sidebar.bundle.js — the Desk-context capture,
 * Desk-aware links, markdown renderer, tool/thinking rendering, attachments,
 * and the ChatPanel component (history, stop, new-chat, paste/drop upload).
 *
 * Not a standalone entry point. Companion modules in this folder:
 *   - sena_chat_store.mjs  multi-chat history persisted in localStorage
 *   - sena_chat_idb.mjs    IndexedDB store for image-attachment previews
 *
 * Host-provided deps (resolved by Frappe's esbuild):
 *   import { createElement as h } from "preact";
 *   import { useCallback, useEffect, useRef, useState } from "preact/hooks";
 *
 * Integration in the host app:
 *   - sena_ai_sidebar.config.js sets window.senaAiSidebarConfig.chatUrl
 *   - a provider entry { kind: "chat", url: chatUrl } renders <ChatPanel/>
 *   - hooks.py app_include_js ships the built bundle into Desk
 */

function Icon({ name }) {
    return h("svg", { className: "icon icon-sm", "aria-hidden": "true" },
        h("use", { href: `#icon-${name}` })
    );
}

// ---- Desk awareness -----------------------------------------------------
// Snapshot of what the user is currently looking at in Desk. Sent with every
// message so the agent can resolve "this", "here", "current item" without the
// user ever typing a doctype/name. Mirrors the snippet in CLAUDE.md.
function getDeskContext() {
    try {
        const f = window.frappe;
        return {
            href: window.location.href,
            route: f?.get_route?.(),
            user: f?.session?.user,
            company: f?.boot?.sysdefaults?.company,
            pageTitle: document.title,
            form: window.cur_frm ? {
                doctype: window.cur_frm.doctype,
                docname: window.cur_frm.docname,
                docstatus: window.cur_frm.doc?.docstatus,
            } : null,
            list: window.cur_list ? { doctype: window.cur_list.doctype } : null,
        };
    } catch (_error) {
        return null;
    }
}

// Surface-aware starter prompts for the empty state, so a non-technical user
// has something to tap instead of a blank box. Changes with the current screen.
function starterPrompts(context) {
    const formType = context?.form?.doctype;
    const listType = context?.list?.doctype;
    if (formType === "Item") {
        return ["Summarize this item", "Stock across warehouses", "Recent transactions for this item"];
    }
    if (formType) {
        return [`Summarize this ${formType}`, "Explain the current status", "What should I check here?"];
    }
    if (listType === "Item") {
        return ["What's low on stock?", "Show items with zero stock", "Summarize this list"];
    }
    if (listType) {
        return [`What needs my attention in these ${listType} records?`, "Summarize this list"];
    }
    return ["What screen am I on?", "Show low-stock items", "Open the Item list"];
}

// Resolve a Frappe in-app route from an href, or null if it's external / not a
// Desk route. Desk is served under /desk (or /app) on this bench.
function deskRouteFromHref(href) {
    try {
        const url = new URL(href, window.location.origin);
        if (url.origin !== window.location.origin) return null;
        const match = url.pathname.match(/^\/(?:app|desk)\/(.+?)\/?$/);
        if (!match) return null;
        return match[1].split("/").map((part) => decodeURIComponent(part)).filter(Boolean);
    } catch (_error) {
        return null;
    }
}

// A link that JUMPS THE VISIBLE DESK TAB in place via frappe.set_route for Desk
// routes (the "show/open/go to" magic moment), instead of opening a new browser
// tab. Anything external opens normally in a new tab.
function SmartLink({ href, children }) {
    const route = deskRouteFromHref(href);
    if (route && route.length && window.frappe?.set_route) {
        return h("a", {
            href,
            className: "sena-md-link sena-md-link-desk",
            title: "Open in Desk",
            onClick: (event) => {
                event.preventDefault();
                try {
                    window.frappe.set_route(route);
                } catch (_error) {
                    window.location.href = href;
                }
            },
        }, children);
    }
    return h("a", { href, target: "_blank", rel: "noopener noreferrer", className: "sena-md-link" }, children);
}

// ---- Lightweight markdown rendering -------------------------------------
// We render assistant text as Preact vnodes (NOT injected HTML), so model
// output can never inject script/markup — it's safe by construction and lets
// code blocks be real components with their own copy button. This is the main
// thing that makes the chat read like an LLM instead of a terminal dump.

// Inline spans: `code`, [links](url), **bold**, _italic_. Recurses into
// emphasis/links but never into code. No keys — siblings are uniformly
// unkeyed so Preact diffs by index (fine, since we re-render whole messages).
function parseInline(text) {
    const nodes = [];
    let rest = text;
    const patterns = [
        { type: "code", re: /`([^`]+)`/ },
        { type: "link", re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
        { type: "url", re: /((?:https?:\/\/|\/(?:app|desk)\/)[^\s<>()]+)/ },
        { type: "bold", re: /\*\*([\s\S]+?)\*\*/ },
        { type: "bold", re: /__([\s\S]+?)__/ },
        { type: "italic", re: /\*([\s\S]+?)\*/ },
        { type: "italic", re: /_([\s\S]+?)_/ },
    ];
    while (rest.length) {
        let best = null;
        for (const pattern of patterns) {
            const match = pattern.re.exec(rest);
            if (match && (best === null || match.index < best.match.index)) {
                best = { pattern, match };
            }
        }
        if (!best) { nodes.push(rest); break; }
        const { pattern, match } = best;
        if (match.index > 0) nodes.push(rest.slice(0, match.index));
        if (pattern.type === "code") {
            nodes.push(h("code", { className: "sena-md-icode" }, match[1]));
        } else if (pattern.type === "link") {
            nodes.push(h(SmartLink, { href: match[2] }, match[1]));
        } else if (pattern.type === "url") {
            // Bare URL: keep trailing punctuation (./,/)) out of the link.
            let raw = match[1];
            const trailMatch = raw.match(/[.,;:!?)]+$/);
            const trail = trailMatch ? trailMatch[0] : "";
            const link = trail ? raw.slice(0, -trail.length) : raw;
            nodes.push(h(SmartLink, { href: link }, link));
            if (trail) nodes.push(trail);
        } else if (pattern.type === "bold") {
            nodes.push(h("strong", null, parseInline(match[1])));
        } else {
            nodes.push(h("em", null, parseInline(match[1])));
        }
        rest = rest.slice(match.index + match[0].length);
    }
    return nodes;
}

// Soft line breaks inside a paragraph become <br>.
function parseInlineMultiline(text) {
    const out = [];
    text.split("\n").forEach((line, index) => {
        if (index > 0) out.push(h("br", null));
        for (const node of parseInline(line)) out.push(node);
    });
    return out;
}

// Block parser: fenced code, headings, blockquotes, tables, lists, paragraphs.
// Tolerant of partial input mid-stream (an unclosed ``` renders as open code).
function parseBlocks(src) {
    const blocks = [];
    const lines = (src || "").split("\n");
    let i = 0;
    const isListItem = (line) => /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    while (i < lines.length) {
        const line = lines[i];
        const fence = /^```(.*)$/.exec(line);
        if (fence) {
            const lang = (fence[1].trim().split(/\s+/)[0]) || "";
            const codeLines = [];
            i++;
            while (i < lines.length && !/^```/.test(lines[i])) { codeLines.push(lines[i]); i++; }
            if (i < lines.length) i++; // consume closing fence when present
            blocks.push({ type: "code", lang, text: codeLines.join("\n") });
            continue;
        }
        if (/^\s*$/.test(line)) { i++; continue; }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) { blocks.push({ type: "heading", level: heading[1].length, text: heading[2] }); i++; continue; }
        if (/^>\s?/.test(line)) {
            const quote = [];
            while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, "")); i++; }
            blocks.push({ type: "quote", text: quote.join("\n") });
            continue;
        }
        if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
            const header = line;
            i += 2; // header + separator
            const rows = [];
            while (i < lines.length && /\|/.test(lines[i]) && !/^\s*$/.test(lines[i])) { rows.push(lines[i]); i++; }
            blocks.push({ type: "table", header, rows });
            continue;
        }
        if (isListItem(line)) {
            const ordered = /^\s*\d+\./.test(line);
            const items = [];
            while (i < lines.length && isListItem(lines[i])) {
                items.push(isListItem(lines[i])[3]);
                i++;
            }
            blocks.push({ type: "list", ordered, items });
            continue;
        }
        const para = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) && !/^```/.test(lines[i])
            && !/^#{1,6}\s/.test(lines[i]) && !/^>\s?/.test(lines[i]) && !isListItem(lines[i])) {
            para.push(lines[i]); i++;
        }
        blocks.push({ type: "para", text: para.join("\n") });
    }
    return blocks;
}

function splitTableRow(line) {
    let cell = line.trim();
    if (cell.startsWith("|")) cell = cell.slice(1);
    if (cell.endsWith("|")) cell = cell.slice(0, -1);
    return cell.split("|").map((value) => value.trim());
}

// A fenced code block with a language label and its own copy button.
function CodeBlock({ lang, text }) {
    const [copied, setCopied] = useState(false);
    const copy = useCallback(() => {
        try {
            navigator.clipboard?.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
        } catch (_error) {
            // Best effort.
        }
    }, [text]);
    return h("div", { className: "sena-md-codeblock" },
        h("div", { className: "sena-md-codeblock-head" },
            h("span", { className: "sena-md-codeblock-lang" }, lang || "code"),
            h("button", { type: "button", className: "sena-md-codeblock-copy", onClick: copy },
                copied ? "Copied ✓" : "Copy")
        ),
        h("pre", { className: "sena-md-pre" }, h("code", null, text))
    );
}

function renderMarkdown(src) {
    return parseBlocks(src).map((block, index) => {
        if (block.type === "code") {
            return h(CodeBlock, { key: index, lang: block.lang, text: block.text });
        }
        if (block.type === "heading") {
            return h("div", { key: index, className: `sena-md-h sena-md-h${block.level}` }, parseInline(block.text));
        }
        if (block.type === "quote") {
            return h("blockquote", { key: index, className: "sena-md-quote" }, parseInlineMultiline(block.text));
        }
        if (block.type === "list") {
            return h(block.ordered ? "ol" : "ul", { key: index, className: "sena-md-list" },
                block.items.map((item, itemIndex) => h("li", { key: itemIndex }, parseInline(item))));
        }
        if (block.type === "table") {
            const headers = splitTableRow(block.header);
            const rows = block.rows.map(splitTableRow);
            return h("div", { key: index, className: "sena-md-table-wrap" },
                h("table", { className: "sena-md-table" },
                    h("thead", null, h("tr", null, headers.map((cell, cellIndex) => h("th", { key: cellIndex }, parseInline(cell))))),
                    h("tbody", null, rows.map((row, rowIndex) => h("tr", { key: rowIndex },
                        row.map((cell, cellIndex) => h("td", { key: cellIndex }, parseInline(cell))))))
                )
            );
        }
        return h("p", { key: index, className: "sena-md-p" }, parseInlineMultiline(block.text));
    });
}

// Map raw tool names to friendly, employee-readable phrases. Never show the
// raw `Bash` / `mcp__server__tool` identifiers to a factory operator.
const FRIENDLY_TOOL = {
    Bash: "Running a command",
    Read: "Reading a file",
    Edit: "Editing a file",
    Write: "Writing a file",
    Glob: "Finding files",
    Grep: "Searching",
    Task: "Working on a sub-task",
    WebFetch: "Fetching a page",
    WebSearch: "Searching the web",
    TodoWrite: "Planning",
};

function friendlyTool(name) {
    const raw = String(name || "");
    if (FRIENDLY_TOOL[raw]) return FRIENDLY_TOOL[raw];
    // mcp__server__tool_name → "Tool name"
    const tail = raw.startsWith("mcp__") ? raw.split("__").pop() : raw;
    const words = tail.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
    if (!words) return "Working";
    return words.charAt(0).toUpperCase() + words.slice(1);
}

// ChatPanel — the custom chat UI that talks to the Node chat-server over a
// WebSocket (Phase 1's protocol: text / tool / done / error frames). It renders
// streaming assistant text, tool-use chips, a per-message Copy button, and an
// input box. It replaces the <iframe> only for the "chat" provider.
function ChatPanel({ url, onStatus, theme }) {
    // Load persisted chats once; restore the last-open chat if any.
    const initRef = useRef(null);
    if (!initRef.current) {
        const store = loadStore();
        const restored = store.chats.find((c) => c.id === store.currentId) || null;
        initRef.current = {
            messages: restored ? hydrateMessages(restored.messages) : [],
            chatId: restored ? restored.id : null,
            sessionId: restored ? restored.sessionId : null,
            chatList: chatMetaList(store),
        };
    }

    const [messages, setMessages] = useState(initRef.current.messages);
    const [chatId, setChatId] = useState(initRef.current.chatId);
    const [input, setInput] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [connected, setConnected] = useState(false);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [chatList, setChatList] = useState(initRef.current.chatList);
    const [attachments, setAttachments] = useState([]); // {id,name,kind,mediaType,data,dataUrl,size}
    const [rejectNote, setRejectNote] = useState("");   // transient attachment rejection message
    const [copiedIdx, setCopiedIdx] = useState(-1);     // which message's Copy was just clicked
    const [dragOver, setDragOver] = useState(false);    // drop-zone highlight
    const fileInputRef = useRef(null);
    const wsRef = useRef(null);
    const scrollRef = useRef(null);
    const textareaRef = useRef(null);
    const attachmentsRef = useRef([]);                  // latest attachments (for cap checks)
    const atBottomRef = useRef(true); // is the log scrolled to (near) the bottom?
    const sessionRef = useRef(initRef.current.sessionId); // current chat's SDK session
    const chatIdRef = useRef(chatId);
    chatIdRef.current = chatId;

    // Upsert the current chat (creating a record on first use). Multi-tab-safe:
    // commitChat reloads from disk before writing, so a chat another tab created
    // is never clobbered. Evicted chats' image blobs are pruned from IndexedDB.
    function persistCurrent(msgs, sessionId) {
        let id = chatIdRef.current;
        let chat = getChat(id);
        if (!chat) {
            chat = newChatRecord();
            id = chat.id;
            chatIdRef.current = id;
            setChatId(id);
        }
        chat.messages = persistMessages(msgs);
        if (sessionId) { chat.sessionId = sessionId; sessionRef.current = sessionId; }
        if (!chat.title || chat.title === "New chat") chat.title = chatTitleFrom(msgs);
        chat.updatedAt = Date.now();
        const { store, evicted } = commitChat(chat, { setCurrent: true });
        if (evicted && evicted.length) idbDeleteMany(attachmentIdsOf(evicted));
        setChatList(chatMetaList(store));
    }

    // Fill image previews from IndexedDB after restore/open (stored chats keep
    // only an idbId, not the bytes). Guarded so a chat switch mid-load is a no-op.
    async function loadAttachmentPreviews(forChatId, msgs) {
        const jobs = [];
        msgs.forEach((m, mi) => (m.attachments || []).forEach((a, ai) => {
            if (a.idbId && a.kind === "image" && !a.dataUrl) {
                jobs.push(idbGet(a.idbId).then((v) => ({ mi, ai, dataUrl: v && v.dataUrl })));
            }
        }));
        if (!jobs.length) return;
        const results = await Promise.all(jobs);
        if (chatIdRef.current !== forChatId) return;
        setMessages((prev) => {
            const next = prev.slice();
            let changed = false;
            for (const r of results) {
                if (!r.dataUrl) continue;
                const msg = next[r.mi];
                if (!msg || !msg.attachments || !msg.attachments[r.ai]) continue;
                const atts = msg.attachments.slice();
                atts[r.ai] = { ...atts[r.ai], dataUrl: r.dataUrl };
                next[r.mi] = { ...msg, attachments: atts };
                changed = true;
            }
            return changed ? next : prev;
        });
    }

    // Connect with auto-reconnect + exponential backoff. A factory operator
    // should never see a stack trace or a shell command — if the link drops we
    // quietly retry and show a calm "reconnecting" banner; technical detail goes
    // to the browser console only.
    useEffect(() => {
        let unmounted = false;
        let attempt = 0;
        let retryTimer = null;

        const handleFrame = (event) => {
            let frame;
            try {
                frame = JSON.parse(event.data);
            } catch (_error) {
                return;
            }
            if (frame.kind === "text") {
                appendToLastAssistant((last) => { last.text += frame.text; });
            } else if (frame.kind === "thinking_start") {
                appendToLastAssistant((last) => { last.thinking = { ...last.thinking, active: true }; });
            } else if (frame.kind === "thinking") {
                appendToLastAssistant((last) => { last.thinking = { ...last.thinking, text: (last.thinking?.text || "") + frame.text }; });
            } else if (frame.kind === "thinking_tokens") {
                appendToLastAssistant((last) => { last.thinking = { ...last.thinking, tokens: frame.tokens }; });
            } else if (frame.kind === "tool") {
                // A tool started — chip shows "<label>…" until it resolves.
                appendToLastAssistant((last) => {
                    last.tools = last.tools.concat({ id: frame.id, label: frame.label, status: "running" });
                });
            } else if (frame.kind === "tool_done") {
                // Resolve that chip to ✓ / ✗ by matching the tool id.
                appendToLastAssistant((last) => {
                    last.tools = last.tools.map((tool) =>
                        tool.id === frame.id ? { ...tool, status: frame.ok ? "ok" : "fail" } : tool);
                });
            } else if (frame.kind === "error") {
                // Never dump raw errors into chat — log for devs, show a calm note.
                console.error("[sena-ai] assistant error:", frame.message);
                appendToLastAssistant((last) => {
                    if (!last.text) last.text = "⚠️ Something went wrong. Please try again.";
                });
                setStreaming(false);
            } else if (frame.kind === "session_reset") {
                // Server couldn't resume a stale session and started fresh.
                console.warn("[sena-ai] session expired; continuing in a new session");
                sessionRef.current = frame.session || null;
            } else if (frame.kind === "done") {
                // Turn finished: stop streaming, close the thinking pill. The
                // session id is kept in a ref; the persist effect saves the chat.
                if (frame.session) sessionRef.current = frame.session;
                appendToLastAssistant((last) => {
                    last.done = true;
                    last.stopped = frame.stopped;
                    if (last.thinking) last.thinking = { ...last.thinking, active: false };
                });
                setStreaming(false);
            }
        };

        const scheduleReconnect = () => {
            if (unmounted) return;
            attempt += 1;
            const delay = Math.min(15000, 1000 * 2 ** (attempt - 1)); // 1,2,4,8,15s…
            console.warn(`[sena-ai] chat link down, reconnecting in ${delay}ms (attempt ${attempt})`);
            retryTimer = setTimeout(connect, delay);
        };

        const connect = () => {
            if (unmounted) return;
            onStatus("connecting");
            let ws;
            try {
                ws = new WebSocket(url);
            } catch (error) {
                console.warn("[sena-ai] websocket construct failed:", error);
                return scheduleReconnect();
            }
            wsRef.current = ws;
            ws.onopen = () => {
                attempt = 0; setConnected(true); onStatus("online");
                // Resume the current chat's session so memory survives a reload.
                try {
                    if (sessionRef.current) ws.send(JSON.stringify({ type: "resume", session: sessionRef.current }));
                } catch (_e) {}
            };
            ws.onmessage = handleFrame;
            ws.onerror = () => { /* surfaced via onclose */ };
            ws.onclose = () => {
                setConnected(false);
                onStatus("offline");
                setStreaming(false); // release the input if a turn was mid-flight
                if (!unmounted) scheduleReconnect();
            };
        };

        connect();
        return () => {
            unmounted = true;
            if (retryTimer) clearTimeout(retryTimer);
            const ws = wsRef.current;
            if (ws) { ws.onclose = null; ws.close(); } // don't reconnect on unmount
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [url]);

    // Track whether the user is near the bottom, so streaming doesn't yank them
    // up while they're reading older messages.
    const onLogScroll = useCallback(() => {
        const el = scrollRef.current;
        if (el) atBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    }, []);

    // Auto-scroll to newest only when already near the bottom.
    useEffect(() => {
        const el = scrollRef.current;
        if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
    }, [messages]);

    // Cross-tab: refresh the history list when another tab updates the store.
    useEffect(() => {
        const onStorage = (e) => { if (e.key === CHATS_KEY) setChatList(chatMetaList(loadStore())); };
        window.addEventListener("storage", onStorage);
        return () => window.removeEventListener("storage", onStorage);
    }, []);

    // On mount, fill image previews for the restored chat from IndexedDB.
    useEffect(() => {
        if (chatIdRef.current && messages.length) loadAttachmentPreviews(chatIdRef.current, messages);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // Keep a ref of the current draft attachments for synchronous cap checks.
    useEffect(() => { attachmentsRef.current = attachments; }, [attachments]);

    // History drawer: close on Escape.
    useEffect(() => {
        if (!historyOpen) return;
        const onEsc = (e) => { if (e.key === "Escape") setHistoryOpen(false); };
        window.addEventListener("keydown", onEsc);
        return () => window.removeEventListener("keydown", onEsc);
    }, [historyOpen]);

    // Persist the conversation whenever it comes to rest (turn ended or link
    // dropped). Skipped mid-stream so we don't hammer localStorage per token.
    useEffect(() => {
        if (streaming || !messages.length) return;
        persistCurrent(messages, sessionRef.current);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [streaming, messages]);

    // Auto-grow the composer: reset to one line, then expand to fit content up
    // to a cap. Runs on every input change so it also snaps back after a send
    // clears the value — no drag handle to discover. The .chat-log shrinks to
    // give it room (flex), so a long draft never hides the conversation.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }, [input]);

    // Mutate the in-progress (last) assistant message immutably for Preact.
    function appendToLastAssistant(mutate) {
        setMessages((prev) => {
            if (!prev.length) return prev;
            const next = prev.slice();
            const last = { ...next[next.length - 1] };
            mutate(last);
            next[next.length - 1] = last;
            return next;
        });
    }

    // ---- Attachments (paste / drop / pick) ----
    const ATTACH_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB per file
    const ATTACH_MAX_COUNT = 8;                  // files per message
    const ATTACH_MAX_TOTAL = 22 * 1024 * 1024;   // ~match the server's per-turn cap

    // Spreadsheet/doc types the server extracts to text (see lib.mjs). Some
    // browsers report an empty file.type for .csv/.xlsx, so we also map by
    // extension and use that as the mediaType the server dispatches on.
    const DOC_MIME = new Set([
        "text/csv", "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]);
    const EXT_MIME = {
        csv: "text/csv",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    };

    const flashReject = useCallback((msg) => {
        setRejectNote(msg);
        setTimeout(() => setRejectNote(""), 4000);
    }, []);

    const addFiles = useCallback((files) => {
        Array.from(files || []).forEach((file) => {
            const isImage = file.type.startsWith("image/");
            const ext = (file.name?.split(".").pop() || "").toLowerCase();
            const mediaType = file.type || EXT_MIME[ext] || "";
            const isPdf = mediaType === "application/pdf";
            const isDoc = isPdf || DOC_MIME.has(mediaType);
            if (!isImage && !isDoc) return flashReject(`"${file.name}" isn't a supported file (image, PDF, or spreadsheet/doc).`);
            if (file.size > ATTACH_MAX_BYTES) return flashReject(`"${file.name}" is over 5 MB.`);
            const reader = new FileReader();
            reader.onload = () => {
                const dataUrl = String(reader.result || "");
                const comma = dataUrl.indexOf(",");
                const data = comma >= 0 ? dataUrl.slice(comma + 1) : "";
                if (!data) return;
                const cur = attachmentsRef.current;
                if (cur.length >= ATTACH_MAX_COUNT) return flashReject(`Up to ${ATTACH_MAX_COUNT} files per message.`);
                const used = cur.reduce((n, a) => n + (a.size || 0), 0);
                if (used + file.size > ATTACH_MAX_TOTAL) return flashReject("Attachments too large for one message.");
                setAttachments((prev) => prev.concat({
                    id: genId(),
                    name: file.name || (isImage ? "image.png" : isPdf ? "document.pdf" : "file"),
                    kind: isImage ? "image" : "document",
                    mediaType,
                    data,
                    dataUrl: isImage ? dataUrl : null,
                    size: file.size,
                }));
            };
            reader.readAsDataURL(file);
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [flashReject]);

    const removeAttachment = useCallback((id) => {
        setAttachments((prev) => prev.filter((a) => a.id !== id));
    }, []);

    // Ctrl+V a screenshot, or paste any image/PDF file.
    const onPaste = useCallback((event) => {
        const items = event.clipboardData?.items;
        if (!items) return;
        const files = [];
        for (const item of items) {
            if (item.kind === "file") { const f = item.getAsFile(); if (f) files.push(f); }
        }
        if (files.length) { event.preventDefault(); addFiles(files); }
    }, [addFiles]);

    const onDrop = useCallback((event) => {
        setDragOver(false);
        if (event.dataTransfer?.files?.length) { event.preventDefault(); addFiles(event.dataTransfer.files); }
    }, [addFiles]);
    const onDragOver = useCallback((event) => {
        if (event.dataTransfer?.types?.includes("Files")) { event.preventDefault(); setDragOver(true); }
    }, []);
    const onDragLeave = useCallback((event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setDragOver(false);
    }, []);

    // Core send: text and/or attachments. Used by the composer and starter chips.
    const doSend = useCallback((rawText, atts) => {
        const text = (rawText || "").trim();
        const useAtts = (atts || []).filter((a) => a.data); // skip any still-loading
        const ws = wsRef.current;
        if ((!text && !useAtts.length) || streaming || !ws || ws.readyState !== WebSocket.OPEN) return;
        // Stash image previews in IndexedDB; the message keeps only an idbId so
        // the thumbnail survives reload without bloating localStorage.
        const msgAtts = useAtts.map((a) => {
            const idbId = (a.kind === "image" && a.dataUrl) ? genId() : null;
            if (idbId) idbPut(idbId, { dataUrl: a.dataUrl, name: a.name, mediaType: a.mediaType });
            return { name: a.name, kind: a.kind, mediaType: a.mediaType, dataUrl: a.dataUrl, idbId };
        });
        setMessages((prev) => prev.concat(
            { role: "user", text, tools: [], thinking: null, done: true, attachments: msgAtts },
            { role: "assistant", text: "", tools: [], thinking: { active: false, text: "", tokens: 0 }, done: false }
        ));
        setInput("");
        setAttachments([]);
        setStreaming(true);
        // Send text + Desk context + attachment bytes (base64) to the server.
        ws.send(JSON.stringify({
            type: "send",
            text,
            context: getDeskContext(),
            attachments: useAtts.map((a) => ({ name: a.name, kind: a.kind, mediaType: a.mediaType, data: a.data })),
        }));
    }, [streaming]);

    const sendMessage = useCallback(() => doSend(input, attachments), [doSend, input, attachments]);
    const sendText = useCallback((raw) => doSend(raw, []), [doSend]);

    // Stop a long turn — the server calls query.interrupt().
    const stopTurn = useCallback(() => {
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stop" }));
    }, []);

    // Load a stored chat record into the view and resume its session. Plain
    // helper so both openChat and deleteChat can reuse it.
    function openChatRecord(chat) {
        if (!chat) return;
        chatIdRef.current = chat.id;
        sessionRef.current = chat.sessionId || null;
        setChatId(chat.id);
        const msgs = hydrateMessages(chat.messages);
        setMessages(msgs);
        setCurrentId(chat.id);
        loadAttachmentPreviews(chat.id, msgs); // async-fill image thumbnails
        atBottomRef.current = true;            // jump to the bottom of the opened chat
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(chat.sessionId
                ? { type: "resume", session: chat.sessionId }
                : { type: "new" }));
        }
    }

    // New chat: empty thread (the record is created on first send) + tell the
    // server to drop the session.
    const newChat = useCallback(() => {
        chatIdRef.current = null;
        sessionRef.current = null;
        setChatId(null);
        setMessages([]);
        setStreaming(false);
        setInput("");
        setCurrentId(null);
        const ws = wsRef.current;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "new" }));
        setHistoryOpen(false);
    }, []);

    // Open a stored chat from the history drawer (fresh from disk).
    const openChat = useCallback((id) => {
        if (streaming) return; // don't switch mid-answer
        openChatRecord(getChat(id));
        setHistoryOpen(false);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [streaming]);

    // Delete a stored chat; clean its IndexedDB blobs; if it was open, fall back
    // to the most recent remaining chat (or an empty one).
    const deleteChat = useCallback((id) => {
        const { store, removed } = deleteChatById(id);
        idbDeleteMany(attachmentIdsOf(removed));
        if (id === chatIdRef.current) {
            const nextMeta = chatMetaList(store)[0];
            if (nextMeta) {
                openChatRecord(store.chats.find((c) => c.id === nextMeta.id));
            } else {
                chatIdRef.current = null; sessionRef.current = null;
                setChatId(null); setMessages([]); setCurrentId(null);
                const ws = wsRef.current;
                if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "new" }));
            }
        }
        setChatList(chatMetaList(store));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onKeyDown = useCallback((event) => {
        // Enter sends; Shift+Enter inserts a newline.
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    }, [sendMessage]);

    const copyMessage = useCallback((text, idx) => {
        try {
            navigator.clipboard?.writeText(text);
            setCopiedIdx(idx);
            setTimeout(() => setCopiedIdx((cur) => (cur === idx ? -1 : cur)), 1200);
        } catch (_error) {
            // Best effort.
        }
    }, []);

    return h("section", {
        className: `sena-ai-chat${dragOver ? " sena-ai-dragging" : ""}`,
        "data-chat-theme": theme,
        onDragOver, onDragLeave, onDrop,
    },
        dragOver && h("div", { className: "sena-ai-dropzone" },
            h(Icon, { name: "attachment" }), "Drop an image or PDF to attach"),
        rejectNote && h("div", { className: "sena-ai-reject-note", role: "status" }, rejectNote),
        !connected && h("div", { className: "sena-ai-chat-disconnected", role: "status" },
            h("span", { className: "sena-ai-reconnect-dot" }),
            `${BRAND_NAME} is reconnecting…`
        ),
        (messages.length > 0 || chatList.length > 0) && h("div", { className: "sena-ai-chat-actions" },
            chatList.length > 0 && h("button", {
                type: "button",
                className: "sena-ai-history-btn",
                title: "Chat history",
                onClick: () => setHistoryOpen(true),
            }, h(Icon, { name: "history" }), "History"),
            messages.length > 0 && h("button", {
                type: "button",
                className: "sena-ai-newchat-btn",
                title: "Start a new chat",
                onClick: newChat,
            }, h(Icon, { name: "add" }), "New chat")
        ),
        historyOpen && h("div", {
            className: "sena-ai-history",
            role: "dialog",
            "aria-modal": "true",
            "aria-label": "Chat history",
        },
            h("div", { className: "sena-ai-history-head" },
                h("strong", null, "Chats"),
                h("button", {
                    type: "button",
                    className: "sena-ai-history-close",
                    title: "Close",
                    "aria-label": "Close history",
                    onClick: () => setHistoryOpen(false),
                }, h(Icon, { name: "close" }))
            ),
            h("div", { className: "sena-ai-history-list" },
                chatList.length === 0
                    ? h("div", { className: "sena-ai-history-empty" }, "No saved chats yet.")
                    : chatList.map((c) => h("div", {
                        key: c.id,
                        className: `sena-ai-history-item${c.id === chatId ? " is-active" : ""}`,
                    },
                        h("button", {
                            type: "button",
                            className: "sena-ai-history-open",
                            onClick: () => openChat(c.id),
                        },
                            h("span", { className: "sena-ai-history-title" }, c.title || "Untitled"),
                            h("span", { className: "sena-ai-history-time" }, relativeTime(c.updatedAt))
                        ),
                        h("button", {
                            type: "button",
                            className: "sena-ai-history-del",
                            title: "Delete chat",
                            "aria-label": "Delete chat",
                            onClick: () => deleteChat(c.id),
                        }, h(Icon, { name: "close" }))
                    ))
            )
        ),
        h("div", { className: "sena-ai-chat-log", ref: scrollRef, onScroll: onLogScroll },
            messages.length === 0 && h("div", { className: "sena-ai-chat-empty" },
                h("div", { className: "sena-ai-chat-empty-avatar", "aria-hidden": "true" }, BRAND_NAME.charAt(0)),
                h("div", { className: "sena-ai-chat-empty-title" }, `Hi, I'm ${BRAND_NAME}`),
                h("p", null, "Ask me about the screen you're on, an item, a report, or anything in your workflow."),
                h("div", { className: "sena-ai-starters" },
                    starterPrompts(getDeskContext()).map((prompt, index) => h("button", {
                        key: index,
                        type: "button",
                        className: "sena-ai-starter-chip",
                        disabled: !connected,
                        onClick: () => sendText(prompt),
                    }, prompt))
                )
            ),
            messages.map((message, index) => h("div", {
                key: index,
                className: `sena-ai-msg sena-ai-msg-${message.role}`,
            },
                message.tools.length > 0 && h("div", { className: "sena-ai-msg-tools" },
                    message.tools.map((tool, toolIndex) => h("span", {
                        key: toolIndex,
                        className: `sena-ai-tool-chip sena-ai-tool-${tool.status}`,
                    },
                        h(Icon, { name: tool.status === "ok" ? "tick" : tool.status === "fail" ? "close" : "tool" }),
                        tool.status === "running" ? `${tool.label}…` : tool.label))
                ),
                message.role === "assistant" && message.thinking
                    && (message.thinking.active || message.thinking.tokens || (message.thinking.text && message.thinking.text.trim()))
                    && ((message.thinking.active && !message.done && !(message.thinking.text && message.thinking.text.trim()))
                        // Live indicator while reasoning (text is redacted on the subscription plan).
                        ? h("div", { className: "sena-ai-thinking-live" },
                            h("span", { className: "sena-ai-reconnect-dot" }), "Thinking…")
                        // Collapsible after the turn: real reasoning if exposed, else a note + token estimate.
                        : h("details", { className: "sena-ai-thinking" },
                            h("summary", null, message.thinking.tokens
                                ? `Thought for ~${message.thinking.tokens} tokens`
                                : "Thought process"),
                            (message.thinking.text && message.thinking.text.trim())
                                ? h("div", { className: "sena-ai-thinking-body" }, message.thinking.text)
                                : h("div", { className: "sena-ai-thinking-body sena-ai-thinking-muted" },
                                    "Reasoned before answering — the full chain-of-thought isn't exposed on this plan."))),
                message.attachments && message.attachments.length > 0 && h("div", { className: "sena-ai-msg-attachments" },
                    message.attachments.map((att, ai) => (att.dataUrl && att.kind === "image")
                        ? h("img", { key: ai, className: "sena-ai-att-thumb", src: att.dataUrl, alt: att.name, title: att.name })
                        : h("span", { key: ai, className: "sena-ai-att-chip", title: att.name },
                            h(Icon, { name: att.kind === "image" ? "image" : "file" }), att.name))
                ),
                h("div", {
                    className: message.role === "assistant"
                        ? "sena-ai-msg-text sena-ai-md"
                        : "sena-ai-msg-text",
                },
                    message.role === "assistant"
                        ? (message.text
                            ? renderMarkdown(message.text)
                            : (streaming ? h("span", { className: "sena-ai-typing" }, "…") : ""))
                        : message.text
                ),
                message.role === "assistant" && message.text && h("button", {
                    type: "button",
                    className: `sena-ai-copy-btn${copiedIdx === index ? " is-copied" : ""}`,
                    title: copiedIdx === index ? "Copied" : "Copy",
                    onClick: () => copyMessage(message.text, index),
                }, h(Icon, { name: copiedIdx === index ? "tick" : "copy" }))
            ))
        ),
        h("div", { className: "sena-ai-chat-input" },
            attachments.length > 0 && h("div", { className: "sena-ai-attach-row" },
                attachments.map((att) => h("div", { key: att.id, className: "sena-ai-attach" },
                    att.dataUrl
                        ? h("img", { className: "sena-ai-attach-thumb", src: att.dataUrl, alt: att.name, title: att.name })
                        : h("span", { className: "sena-ai-attach-doc", title: att.name }, h(Icon, { name: "file" }), att.name),
                    h("button", {
                        type: "button", className: "sena-ai-attach-x", title: "Remove",
                        "aria-label": "Remove attachment", onClick: () => removeAttachment(att.id),
                    }, h(Icon, { name: "close" }))
                ))
            ),
            h("div", { className: "sena-ai-composer" },
                h("input", {
                    type: "file", ref: fileInputRef, accept: "image/*,application/pdf,.csv,.xlsx,.docx",
                    multiple: true, style: "display:none",
                    onChange: (event) => { addFiles(event.target.files); event.target.value = ""; },
                }),
                h("button", {
                    type: "button", className: "sena-ai-attach-btn",
                    title: "Attach image or PDF", "aria-label": "Attach a file",
                    onClick: () => fileInputRef.current && fileInputRef.current.click(),
                }, h(Icon, { name: "attachment" })),
                h("textarea", {
                    className: "sena-ai-chat-textarea",
                    placeholder: `Message ${BRAND_NAME}…`,
                    value: input,
                    rows: 1,
                    ref: textareaRef,
                    onInput: (event) => setInput(event.target.value),
                    onKeyDown,
                    onPaste,
                }),
                streaming
                    ? h("button", {
                        type: "button",
                        className: "sena-ai-send-btn sena-ai-stop-btn",
                        title: "Stop",
                        "aria-label": "Stop generating",
                        onClick: stopTurn,
                    }, h("span", { className: "sena-ai-stop-icon", "aria-hidden": "true" }))
                    : h("button", {
                        type: "button",
                        className: "sena-ai-send-btn",
                        title: "Send (Enter)",
                        "aria-label": "Send message",
                        disabled: !input.trim() && attachments.length === 0,
                        onClick: sendMessage,
                    }, h(Icon, { name: "send" }))
            ),
            h("div", { className: "sena-ai-composer-hint" }, "Enter to send · paste or drop an image / PDF")
        )
    );
}

