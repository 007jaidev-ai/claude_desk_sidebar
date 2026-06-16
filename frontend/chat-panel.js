/*
 * claude-desk-sidebar — frontend chat module (reference snapshot)
 *
 * EXCERPT of the chat UI as it lives inside the Frappe app bundle
 * sena_erp/public/js/sena_ai_sidebar.bundle.js. Not a standalone entry point —
 * it shows the chat-side code (Desk-context capture, Desk-aware links, markdown
 * rendering, the ChatPanel component) that pairs with the server in ../server.
 *
 * Host-provided deps (resolved by Frappe's esbuild from preact):
 *   import { createElement as h } from "preact";
 *   import { useCallback, useEffect, useRef, useState } from "preact/hooks";
 *
 * Integration points in the host app:
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
    const [messages, setMessages] = useState([]); // { role, text, tools: [] }
    const [input, setInput] = useState("");
    const [streaming, setStreaming] = useState(false);
    const [connected, setConnected] = useState(false);
    const wsRef = useRef(null);
    const scrollRef = useRef(null);
    const textareaRef = useRef(null);

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
            } else if (frame.kind === "tool") {
                appendToLastAssistant((last) => { last.tools = last.tools.concat(frame.name); });
            } else if (frame.kind === "error") {
                // Never dump raw errors into chat — log for devs, show a calm note.
                console.error("[sena-ai] assistant error:", frame.message);
                appendToLastAssistant((last) => {
                    if (!last.text) last.text = "⚠️ Something went wrong. Please try again.";
                });
                setStreaming(false);
            } else if (frame.kind === "done") {
                // Turn finished: stop streaming and resolve the in-progress
                // message's tool chips from "running…" to a completed ✓.
                appendToLastAssistant((last) => { last.done = true; });
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
            ws.onopen = () => { attempt = 0; setConnected(true); onStatus("online"); };
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

    // Auto-scroll to the newest message as content streams in.
    useEffect(() => {
        const el = scrollRef.current;
        if (el) el.scrollTop = el.scrollHeight;
    }, [messages]);

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

    // Send arbitrary text — used by both the input box and the starter chips.
    const sendText = useCallback((raw) => {
        const text = (raw || "").trim();
        const ws = wsRef.current;
        if (!text || streaming || !ws || ws.readyState !== WebSocket.OPEN) return;
        // Push the user's message + an empty assistant message to stream into.
        setMessages((prev) => prev.concat(
            { role: "user", text, tools: [], done: true },
            { role: "assistant", text: "", tools: [], done: false }
        ));
        setInput("");
        setStreaming(true);
        // Attach the current Desk screen so "this" / "here" / "current" resolve
        // server-side without the user typing a doctype or record name.
        ws.send(JSON.stringify({ text, context: getDeskContext() }));
    }, [streaming]);

    const sendMessage = useCallback(() => sendText(input), [sendText, input]);

    const onKeyDown = useCallback((event) => {
        // Enter sends; Shift+Enter inserts a newline.
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            sendMessage();
        }
    }, [sendMessage]);

    const copyMessage = useCallback((text) => {
        try {
            navigator.clipboard?.writeText(text);
        } catch (_error) {
            // Best effort.
        }
    }, []);

    return h("section", { className: "sena-ai-chat", "data-chat-theme": theme },
        !connected && h("div", { className: "sena-ai-chat-disconnected", role: "status" },
            h("span", { className: "sena-ai-reconnect-dot" }),
            "Assistant is reconnecting…"
        ),
        h("div", { className: "sena-ai-chat-log", ref: scrollRef },
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
                    message.tools.map((toolName, toolIndex) => h("span", {
                        key: toolIndex,
                        className: `sena-ai-tool-chip${message.done ? " sena-ai-tool-chip-done" : ""}`,
                    },
                        h(Icon, { name: message.done ? "tick" : "tool" }),
                        message.done ? friendlyTool(toolName) : `${friendlyTool(toolName)}…`))
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
                    className: "sena-ai-copy-btn",
                    title: "Copy",
                    onClick: () => copyMessage(message.text),
                }, h(Icon, { name: "copy" }))
            ))
        ),
        h("div", { className: "sena-ai-chat-input" },
            h("div", { className: "sena-ai-composer" },
                h("textarea", {
                    className: "sena-ai-chat-textarea",
                    placeholder: `Message ${BRAND_NAME}…`,
                    value: input,
                    rows: 1,
                    ref: textareaRef,
                    onInput: (event) => setInput(event.target.value),
                    onKeyDown,
                }),
                h("button", {
                    type: "button",
                    className: "sena-ai-send-btn",
                    title: streaming ? "Working…" : "Send (Enter)",
                    "aria-label": "Send message",
                    disabled: streaming || !input.trim(),
                    onClick: sendMessage,
                }, streaming
                    ? h("span", { className: "sena-ai-send-spinner", "aria-hidden": "true" })
                    : h(Icon, { name: "send" }))
            ),
            h("div", { className: "sena-ai-composer-hint" }, "Enter to send · Shift+Enter for a new line")
        )
    );
}
