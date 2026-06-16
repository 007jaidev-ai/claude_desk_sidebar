# claude-desk-sidebar

A chat interface built **on top of Claude Code** (via the Claude Agent SDK) for the
Frappe/ERPNext **Desk** right sidebar. Instead of an embedded terminal, employees get
a real chat: streaming replies, markdown, tool-call chips, screen-aware answers, and
record links that move the Desk in place.

> Key idea: this is **not** the raw Anthropic API. It runs the *same agent as the
> `claude` CLI* (its tools, file access, and `CLAUDE.md` project context) as a library,
> and only swaps the transport — PTY/terminal → a small WebSocket server → a custom UI.

```
browser chat UI  →  WebSocket  →  Node chat-server  →  Claude Agent SDK  →  Claude Code  →  Claude LLM
   (frontend/)                       (server/)         @anthropic-ai/claude-agent-sdk
```

## Repo layout

| Path | What it is |
|------|------------|
| `server/chat-server.mjs` | The runtime. A WebSocket server (port 7683) that wraps the Agent SDK's `query()` and relays a tiny JSON protocol to the browser. |
| `server/package.json` | Deps: `@anthropic-ai/claude-agent-sdk`, `ws`. |
| `frontend/chat-panel.js` | **Reference snapshot** of the chat UI (Preact). Lives inside a Frappe asset bundle in the host app; see *Integration*. |
| `frontend/chat-panel.css` | Chat + markdown styles. |
| `examples/sena-chat-claude.service` | systemd `--user` unit that keeps the server running. |

## How it works

### Server (`server/chat-server.mjs`)
- Listens on `ws://127.0.0.1:7683`.
- Per browser message `{ text, context }`, it calls the Agent SDK:
  ```js
  query({ prompt, options: {
    cwd,                                        // loads the project's CLAUDE.md
    permissionMode: "bypassPermissions",
    systemPrompt: { type: "preset", preset: "claude_code" },
    includePartialMessages: true,               // stream token deltas
    resume: sessionId,                          // multi-turn memory (after turn 1)
  }})
  ```
- Translates the SDK's event stream into a small wire protocol:
  - `{ kind: "text", text }` — streaming assistant text
  - `{ kind: "tool", name }` — a tool call started (rendered as a chip)
  - `{ kind: "done", session }` — end of turn (carries the session id)
  - `{ kind: "error", message }` — something failed
- **Memory:** the captured `session_id` is passed back as `resume` on the next turn, so
  the agent sees the whole conversation.
- **Ordering matters:** `done` is sent *after* the per-connection `busy` flag is cleared,
  so the client's next message can't race in and get rejected.

### Frontend (`frontend/chat-panel.js`)
- `getDeskContext()` snapshots the current screen (route, doctype/docname, user, company)
  and sends it with every message → the agent resolves "this", "here", "current item"
  without the user typing a record name.
- `SmartLink` turns Desk links (`/app/...`, `/desk/...`) into in-place navigations via
  `frappe.set_route(...)` instead of opening new tabs.
- Surface-aware **starter chips** on the empty state lower the "what do I type" barrier.
- **Auto-reconnect** with exponential backoff (1→2→4→8→15s) and a calm "reconnecting…"
  banner; technical detail goes to the console, never the chat.

## Running the server

Requires Node 18+ and the `claude` CLI installed **and logged in** (the SDK inherits that
login from `~/.claude` — no API key needed).

```bash
cd server
npm install
node chat-server.mjs        # ws://127.0.0.1:7683
```

The server sets its working directory to `../context` (relative to `server/`) so it loads
that folder's `CLAUDE.md`. It is designed to run inside the host Frappe app at
`apps/<app>/tools/sena_sidebar_claude/server/`, next to a `../context/CLAUDE.md`. Adjust
`CONTEXT_DIR` in `chat-server.mjs` if you run it elsewhere.

### Run as a service (Linux)

```bash
cp examples/sena-chat-claude.service ~/.config/systemd/user/
# edit WorkingDirectory/ExecStart paths to match your machine
systemctl --user daemon-reload
systemctl --user enable --now sena-chat-claude
journalctl --user -u sena-chat-claude -f   # logs
```

## Integration with the Frappe app

The frontend code in `frontend/` is shipped from inside the host app's asset bundle
(`sena_erp/public/js/sena_ai_sidebar.bundle.js`), built by Frappe's esbuild. Wiring:

1. `sena_ai_sidebar.config.js` → `window.senaAiSidebarConfig.chatUrl = "ws://127.0.0.1:7683"`.
2. A provider entry `{ key: "claude-chat", kind: "chat", url: chatUrl }` selects `<ChatPanel/>`.
3. `hooks.py` `app_include_js` / `app_include_css` ship the built bundle into Desk.
4. `bench build --app <app>` rebuilds the bundle after changes.

## Notes
- Auth is the existing Claude Code subscription login; nothing is billed per-token and no
  key is stored in this repo.
- `frontend/` is a reference snapshot, not a standalone build — `preact` and the hooks are
  provided by the host bundle.
