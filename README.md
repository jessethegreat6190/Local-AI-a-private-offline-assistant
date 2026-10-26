# Local AI — a private, offline assistant

**Chat, document Q&A, image understanding, a coding workspace, and long-term
memory — all running on your own Windows PC.** No cloud, no accounts, no API
keys, and no data leaving your machine.

Local AI is a browser app backed by **PHP 8.2 + SQLite**, with open models served
locally by **[Ollama](https://ollama.com)**. Conversations, documents, embeddings
and saved memories stay on disk in `data/`.

```
Browser  →  PHP app (this folder)  →  Ollama engine (localhost:11434)  →  local model
                     │
                     └── SQLite knowledge base (data/localai.sqlite)
```

## At a glance

| | |
|---|---|
| 💬 **Chat** | Streaming answers, local conversation history |
| 📄 **Documents** | PDF, DOCX, TXT, MD, CSV, JSON, HTML and code — answers cite the sources used |
| 🖼 **Images** | Attach or drag-drop a screenshot; a vision model reads it |
| ⌨ **Code** | Explain, fix, improve, comment, test, optimize or rewrite code |
| 🧠 **Memory** | Facts about you and custom instructions, added to every chat |
| 🔒 **Private** | Listens on `127.0.0.1` only; `data/` is git-ignored and blocked from the web |

## Requirements

- **Windows 10/11** (the launcher is a `.bat`; the app itself is portable)
- **PHP 8.2+** with `pdo_sqlite` and `curl` — XAMPP's PHP works
- **[Ollama](https://ollama.com)** with at least one chat model and one embedding model
- **Python 3** *(optional)* for PDF/DOCX text extraction (`pypdf`, `python-docx`)

A dedicated GPU is not required — everything runs on the CPU. 3B models are the
most responsive; 7–8B models give better answers but are slower.

## Start it

Double-click **`start.bat`**. It will:

1. Check the local AI engine; if it isn't responding, it restarts it cleanly.
2. Start the web app and open **http://127.0.0.1:8090/** in your browser.

Keep the window open while you use the app — closing it stops the web server.
To stop the engine too, right-click the Ollama tray icon and choose **Quit**
(or run `stop.bat` for the web server only).

> Prefer XAMPP/Apache? Start Apache in the XAMPP Control Panel and open
> **http://localhost/local-ai/** instead. Everything still runs locally.

### First run

Pull the models the app uses (only once):

```bat
ollama pull nomic-embed-text     :: document embeddings (needed for documents)
ollama pull llama3.2:3b          :: fast general chat
ollama pull qwen2.5-coder:3b     :: fast coding
ollama pull gemma3:4b            :: vision + strong general
ollama pull llama3.1:8b          :: higher-quality chat (optional, slower)
ollama pull qwen2.5-coder:7b     :: better coding (optional, slower)
```

The app lists whatever is installed — anything missing simply won't appear in
the model dropdown.

## Features

### 💬 Chat
- Streaming answers, conversation history kept in your browser.
- **Attach an image** (🖼 button, or drag an image in) and ask about it — this uses
  a vision model (`gemma3:4b`).
- **Use documents** toggle: answer questions from your own files and cite the
  sources used.

### ⌨ Code workspace
Switch to the **Code** tab for a dedicated coding view:
- Paste code, choose the language and an action:
  **Explain**, **Fix bugs**, **Improve**, **Comment**, **Write tests**,
  **Optimize**, **Convert/rewrite**, or a **Custom** request.
- Results stream into the right-hand panel with copy buttons.
- Uses the coder model (`qwen2.5-coder:7b` when installed).

### 🧠 Memory & instructions
Click **Memory & instructions** at the bottom of the sidebar. Everything here is
stored in your local SQLite database and added to every chat:

- **About you** — short facts ("My name is Sam", "I run a hotel in Kampala").
  Add one per line; edit or delete them any time.
- **Custom instructions** — tone and rules ("Be concise", "Use British spelling").
- **Use memory in chats** toggle — turn it off and the facts stay saved but are
  not sent to the model.

The assistant treats memory as background context: it won't recite it at you, but
it knows your name, preferences and situation. It works in the Code tab too.

### 📄 Knowledge base
Click **Add documents** (or drag files in). Supported: **PDF, DOCX, TXT, MD, CSV,
JSON, HTML**, and most source-code files. Documents are chunked, embedded locally,
and stored in `data/localai.sqlite`. They are never uploaded anywhere.

## Recommended models

| Model | Size | Used for |
|---|---|---|
| `llama3.1:8b` | ~4.9 GB | best general answers (slower) |
| `llama3.2:3b` | ~2.0 GB | fast general answers |
| `qwen2.5-coder:7b` | ~4.7 GB | best coding results (slower) |
| `qwen2.5-coder:3b` | ~1.9 GB | fast coding |
| `gemma3:4b` | ~3.1 GB | **vision** (images) + strong general |
| `nomic-embed-text` | ~0.27 GB | document embeddings |

Pick any of them from the dropdown in the top bar. Click the 👁 icon to see which
models can read images.

### Add more models
```bat
ollama pull llama3.2:1b        :: tiny + very fast
ollama pull qwen2.5:7b         :: strong general model
ollama pull llava:7b           :: alternative vision model
```
Then refresh the page and pick it from the dropdown.

## Privacy

- The web app listens on **127.0.0.1 only** — not reachable from other devices.
- `data/` (uploads, embeddings, database) is blocked from web access and excluded
  from git.
- No telemetry, no accounts, no API keys.
- Ollama itself binds to localhost; models run on your CPU.

> Note: Ollama periodically checks for updates online. That is the only outbound
> traffic, and it carries no personal data. Disable it in the Ollama tray settings
> if you prefer.

## A note on speed

Your PC has **no dedicated graphics card**, so models run on the CPU:

- **3B models** — most responsive, good for everyday use.
- **4B (gemma3)** — great balance, needed for images.
- **7–8B models** — better quality, noticeably slower (and use more RAM).

16 GB of RAM comfortably fits one 8B model at a time. The first reply after a
restart is slower while the model loads into memory.

## File map

```
local-ai/
├─ start.bat / stop.bat      launchers
├─ index.html                the interface
├─ assets/                   style.css, app.js
├─ api/
│  ├─ chat.php               streaming chat, RAG, images, memory, system prompts
│  ├─ ingest.php             index uploaded documents
│  ├─ documents.php          list / delete documents
│  ├─ memory.php             saved facts about you (CRUD)
│  ├─ models.php             list local models
│  ├─ status.php             engine health
│  ├─ extract.py             PDF/DOCX text extraction
│  ├─ lib.php                helpers (DB, Ollama, vectors, chunking)
│  └─ config.php             settings
└─ data/                     your private data (git-ignored)
   ├─ localai.sqlite         documents, chunks, memory
   └─ uploads/
```

## Troubleshooting

**“Engine offline” in the app**
Run `start.bat` again — it restarts a wedged engine automatically. Or start
Ollama manually and wait for the tray icon.

**A model isn't in the dropdown**
It may still be downloading. Check with `ollama list`, then refresh the page.

**PDF says “Python is not available”**
PDF/DOCX extraction uses Python. Install Python 3 and the parsers:
```bat
python -m pip install pypdf python-docx
```

**Port 8090 already in use**
Close the other Local AI window, or run `stop.bat`, then start again.
