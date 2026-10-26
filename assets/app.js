'use strict';

/* ============================================================
   Local AI — front-end
   Talks only to the local PHP backend on this machine.
   ============================================================ */

const API = {
  chat:      'api/chat.php',
  models:    'api/models.php',
  documents: 'api/documents.php',
  ingest:    'api/ingest.php',
  status:    'api/status.php',
  memory:    'api/memory.php',
};

const STORE_KEY  = 'localai.convos.v1';
const PREF_KEY   = 'localai.prefs.v2';
const CODE_KEY   = 'localai.code.v1';
const DEFAULT_CHAT_MODEL = 'llama3.2:3b';
const DEFAULT_CODE_MODEL = 'qwen2.5-coder:3b';
const VISION_FALLBACK    = 'gemma3:4b';
const VISION_RE = /(llava|gemma3|qwen.*vl|minicpm-v|moondream|bakllava|llama3\.2-vision)/i;

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $('sidebar'), newChat: $('newChat'), convoList: $('convoList'),
  docList: $('docList'), kbCount: $('kbCount'), uploadBtn: $('uploadBtn'),
  fileInput: $('fileInput'), modelSelect: $('modelSelect'),
  ragToggle: $('ragToggle'), ragWrap: $('ragWrap'),
  messages: $('messages'), input: $('input'), sendBtn: $('sendBtn'),
  statusDot: $('statusDot'), statusText: $('statusText'), menuBtn: $('menuBtn'),
  dropOverlay: $('dropOverlay'), toastWrap: $('toastWrap'),
  viewChat: $('viewChat'), viewCode: $('viewCode'),
  attachBtn: $('attachBtn'), imageInput: $('imageInput'), attachPreview: $('attachPreview'),
  codeLang: $('codeLang'), codeAction: $('codeAction'), codeReset: $('codeReset'),
  codeInput: $('codeInput'), codePrompt: $('codePrompt'), codeRun: $('codeRun'),
  codeOutput: $('codeOutput'), codeCopyAll: $('codeCopyAll'),
  memoryBtn: $('memoryBtn'), memoryCount: $('memoryCount'), memoryModal: $('memoryModal'),
  memoryClose: $('memoryClose'), memoryDone: $('memoryDone'), useMemory: $('useMemory'),
  memList: $('memList'), memInput: $('memInput'), memAdd: $('memAdd'),
  memInstructions: $('memInstructions'), memSaveInstructions: $('memSaveInstructions'),
  memClear: $('memClear'), memStatus: $('memStatus'),
};

let conversations = [];
let currentId = null;
let busy = false;
let codeBusy = false;
let mode = 'chat';
let attachedImages = [];       // data URLs waiting to be sent
let codeThread = [];           // [{role, content, label, lang}]
let allModels = [];
let prefs = { modelChat: null, modelCode: null, rag: true, mode: 'chat', useMemory: true, instructions: '', autoModel: true };
let memoryItems = [];

/* ============================================================
   Markdown (small, dependency-free, HTML-escaped)
   ============================================================ */
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
function inlineMd(s) {
  s = escapeHtml(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return s;
}
function renderMarkdown(src) {
  const codeBlocks = [];
  src = String(src).replace(/```([\w.+#-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    codeBlocks.push({ lang: lang || '', code });
    return '\u0000CODE' + (codeBlocks.length - 1) + '\u0000';
  });
  const lines = src.split('\n');
  let out = '', inP = false, listType = null;
  const closeP = () => { if (inP) { out += '</p>'; inP = false; } };
  const closeList = () => { if (listType) { out += '</' + listType + '>'; listType = null; } };

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    const codeMatch = line.trim().match(/^\u0000CODE(\d+)\u0000$/);
    if (codeMatch) {
      closeP(); closeList();
      const b = codeBlocks[+codeMatch[1]];
      out += '<pre><code data-lang="' + escapeHtml(b.lang) + '">' +
             escapeHtml(b.code.replace(/\n$/, '')) +
             '</code><button class="copy" type="button">Copy</button></pre>';
      continue;
    }
    if (line.trim() === '') { closeP(); closeList(); continue; }
    let m;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeP(); closeList();
      const lvl = Math.min(m[1].length, 3);
      out += '<h' + lvl + '>' + inlineMd(m[2]) + '</h' + lvl + '>';
      continue;
    }
    if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      closeP();
      if (listType !== 'ul') { closeList(); out += '<ul>'; listType = 'ul'; }
      out += '<li>' + inlineMd(m[1]) + '</li>';
      continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      closeP();
      if (listType !== 'ol') { closeList(); out += '<ol>'; listType = 'ol'; }
      out += '<li>' + inlineMd(m[1]) + '</li>';
      continue;
    }
    closeList();
    if (!inP) { out += '<p>'; inP = true; } else { out += '<br>'; }
    out += inlineMd(line);
  }
  closeP(); closeList();
  return out;
}

/* ============================================================
   Storage
   ============================================================ */
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(conversations)); } catch (e) {}
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
}
function saveCode() {
  try { localStorage.setItem(CODE_KEY, JSON.stringify(codeThread.slice(-40))); } catch (e) {}
}
function load() {
  try { conversations = JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { conversations = []; }
  if (!Array.isArray(conversations)) conversations = [];
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
    prefs = Object.assign(prefs, p);
    if (typeof p.rag === 'boolean') els.ragToggle.checked = p.rag;
    if (typeof p.useMemory === 'boolean') els.useMemory.checked = p.useMemory;
    if (typeof prefs.instructions === 'string') els.memInstructions.value = prefs.instructions;
    if (p.mode === 'code' || p.mode === 'chat') mode = p.mode;
  } catch (e) {}
  try { codeThread = JSON.parse(localStorage.getItem(CODE_KEY)) || []; } catch (e) { codeThread = []; }

  if (!conversations.length) newConversation(true);
  else currentId = conversations[0].id;
}
function currentConvo() { return conversations.find((c) => c.id === currentId); }

function newConversation(silent) {
  const c = { id: 'c' + Date.now() + Math.random().toString(36).slice(2, 6),
              title: 'New chat', createdAt: Date.now(), messages: [] };
  conversations.unshift(c);
  currentId = c.id;
  if (!silent) save();
  renderConvoList(); renderMessages();
  return c;
}

/* ============================================================
   Chat rendering
   ============================================================ */
function renderConvoList() {
  els.convoList.innerHTML = '';
  conversations.forEach((c) => {
    const div = document.createElement('div');
    div.className = 'convo' + (c.id === currentId ? ' active' : '');
    div.innerHTML = '<span class="name"></span><span class="del" title="Delete">✕</span>';
    div.querySelector('.name').textContent = c.title || 'New chat';
    div.addEventListener('click', () => {
      currentId = c.id; save(); renderConvoList(); renderMessages();
      els.sidebar.classList.remove('open');
    });
    div.querySelector('.del').addEventListener('click', (e) => {
      e.stopPropagation();
      conversations = conversations.filter((x) => x.id !== c.id);
      if (currentId === c.id) {
        currentId = conversations.length ? conversations[0].id : null;
        if (!currentId) newConversation(true);
      }
      save(); renderConvoList(); renderMessages();
    });
    els.convoList.appendChild(div);
  });
}

function bubbleDOM(m) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + m.role;

  const av = document.createElement('div');
  av.className = 'avatar';
  av.textContent = m.role === 'user' ? '🧑' : '◍';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const who = document.createElement('div');
  who.className = 'who';
  who.textContent = m.role === 'user' ? 'You' : 'Local AI';
  bubble.appendChild(who);

  if (m.images && m.images.length) {
    const imgs = document.createElement('div');
    m.images.forEach((src) => {
      const im = document.createElement('img');
      im.className = 'attached'; im.src = src; im.alt = 'attached image';
      im.addEventListener('click', () => window.open(src, '_blank'));
      imgs.appendChild(im);
    });
    bubble.appendChild(imgs);
  }

  const contentEl = document.createElement('div');
  contentEl.className = 'content';
  contentEl.innerHTML = m.content ? renderMarkdown(m.content) : '';
  bubble.appendChild(contentEl);

  if (m.sources && m.sources.length) {
    const det = document.createElement('details');
    det.className = 'sources';
    det.innerHTML = '<summary>📄 ' + m.sources.length + ' source' + (m.sources.length > 1 ? 's' : '') + ' used</summary>';
    m.sources.forEach((s, i) => {
      const d = document.createElement('div');
      d.className = 'src';
      d.innerHTML = '<span class="sc">match ' + (s.score != null ? s.score : '') + '</span>' +
                    '<b>[' + (i + 1) + '] ' + escapeHtml(s.name) + '</b><br>' + escapeHtml(s.preview || '');
      det.appendChild(d);
    });
    bubble.appendChild(det);
  }

  wrap.appendChild(av); wrap.appendChild(bubble);
  return { wrap, contentEl };
}

function emptyState() {
  const e = document.createElement('div');
  e.className = 'empty';
  e.innerHTML =
    '<div class="big">◍</div>' +
    '<h2>Your private AI is ready</h2>' +
    '<p>Ask it anything, attach an image to ask about it, or add documents to your knowledge base and turn on “Use documents”.</p>' +
    '<div class="chips">' +
    '<button class="chip">Explain how a vector database works</button>' +
    '<button class="chip">Write a Python function to read a CSV</button>' +
    '<button class="chip">Summarise the key risks in a project plan</button>' +
    '</div>';
  e.querySelectorAll('.chip').forEach((chip) => {
    chip.addEventListener('click', () => { els.input.value = chip.textContent; autogrow(); els.input.focus(); });
  });
  return e;
}

function renderMessages() {
  const c = currentConvo();
  els.messages.innerHTML = '';
  if (!c || !c.messages.length) { els.messages.appendChild(emptyState()); return; }
  c.messages.forEach((m) => els.messages.appendChild(bubbleDOM(m).wrap));
  attachCopy(els.messages);
  scrollBottom();
}
function scrollBottom() { els.messages.scrollTop = els.messages.scrollHeight; }

function attachCopy(root) {
  root.querySelectorAll('.content pre .copy, .code-output pre .copy').forEach((btn) => {
    if (btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const code = btn.parentElement.querySelector('code');
      navigator.clipboard.writeText(code ? code.textContent : '').then(() => {
        btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
    });
  });
}

/* ============================================================
   Toasts
   ============================================================ */
function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast' + (kind ? ' ' + kind : '');
  t.textContent = msg;
  els.toastWrap.appendChild(t);
  setTimeout(() => { t.style.transition = 'opacity .3s'; t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 4200);
}

/* ============================================================
   Shared streaming helper
   ============================================================ */
async function streamRequest(payload, handlers) {
  const res = await fetch(API.chat, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok || !res.body) {
    let msg = 'Request failed (' + res.status + ')';
    try { const j = await res.json(); if (j.error) msg = j.error; } catch (e) {}
    throw new Error(msg);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (e) { continue; }
      if (obj.type === 'sources') handlers.onSources && handlers.onSources(obj.sources || []);
      else if (obj.type === 'delta') handlers.onDelta && handlers.onDelta(obj.content || '');
      else if (obj.type === 'error') throw new Error(obj.message || 'Model error');
    }
  }
}
function stripDataUrl(s) {
  const i = String(s).indexOf(',');
  return (i !== -1 && /base64/.test(s.slice(0, i))) ? s.slice(i + 1) : s;
}

/* ============================================================
   Chat: input, images, send
   ============================================================ */
function autogrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 200) + 'px';
}
function setBusy(v) { busy = v; els.sendBtn.disabled = v; els.sendBtn.textContent = v ? '…' : 'Send'; }

function compressImage(file, maxDim = 1024, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL('image/jpeg', quality));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that image.')); };
    img.src = url;
  });
}

function renderAttached() {
  els.attachPreview.innerHTML = '';
  attachedImages.forEach((src, i) => {
    const t = document.createElement('div');
    t.className = 'thumb';
    const im = document.createElement('img'); im.src = src;
    const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '✕';
    rm.addEventListener('click', () => { attachedImages.splice(i, 1); renderAttached(); });
    t.appendChild(im); t.appendChild(rm);
    els.attachPreview.appendChild(t);
  });
}

async function addImages(files) {
  const imgs = [...files].filter((f) => f.type.startsWith('image/'));
  if (!imgs.length) return;
  for (const f of imgs) {
    try { attachedImages.push(await compressImage(f)); }
    catch (e) { toast(e.message, 'err'); }
  }
  renderAttached();
  ensureVisionModel();
}

function isVisionModel(name) { return VISION_RE.test(name || ''); }

function ensureVisionModel() {
  if (!attachedImages.length) return;
  const cur = els.modelSelect.value;
  if (isVisionModel(cur)) return;
  const vis = allModels.find((m) => isVisionModel(m.name));
  if (vis) {
    els.modelSelect.value = vis.name;
    if (mode === 'chat') { prefs.modelChat = vis.name; save(); }
    toast('Switched to ' + vis.name + ' — it can see images.', 'ok');
  } else {
    toast('The selected model can’t read images. Pull a vision model like gemma3:4b.', 'err');
  }
}

async function sendChat() {
  const text = els.input.value.trim();
  if ((!text && !attachedImages.length) || busy) return;
  const c = currentConvo();
  if (!c) return;

  const imgs = attachedImages.slice();
  c.messages.push(imgs.length ? { role: 'user', content: text, images: imgs } : { role: 'user', content: text });
  if (!c.title || c.title === 'New chat') {
    c.title = (text || 'Image').slice(0, 42) + ((text || 'Image').length > 42 ? '…' : '');
  }
  const assistant = { role: 'assistant', content: '', sources: [] };
  c.messages.push(assistant);

  els.input.value = '';
  autogrow();
  attachedImages = []; renderAttached();
  save(); renderConvoList();

  renderMessages();
  const bubble = els.messages.lastElementChild;
  const contentEl = bubble.querySelector('.content');
  setBusy(true);
  contentEl.innerHTML = '<span class="cursor"></span>';

  let raf = null;
  const paint = () => {
    raf = null;
    contentEl.innerHTML = renderMarkdown(assistant.content) + '<span class="cursor"></span>';
    scrollBottom();
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };

  const history = c.messages
    .filter((m) => m !== assistant && (m.content || (m.images && m.images.length)))
    .map((m) => {
      const o = { role: m.role, content: m.content || '' };
      if (m.images && m.images.length) o.images = m.images.map(stripDataUrl);
      return o;
    });

  try {
    await streamRequest({
      model: els.modelSelect.value || DEFAULT_CHAT_MODEL,
      messages: history,
      use_rag: els.ragToggle.checked,
      use_memory: prefs.useMemory !== false,
      system: prefs.instructions || '',
    }, {
      onSources: (s) => { assistant.sources = s; },
      onDelta: (d) => { assistant.content += d; schedule(); },
    });
    if (raf) cancelAnimationFrame(raf);
    if (!assistant.content) assistant.content = '(no response)';
    save(); renderMessages();
  } catch (err) {
    if (raf) cancelAnimationFrame(raf);
    renderMessages();
    toast('Error: ' + (err && err.message ? err.message : err), 'err');
  } finally {
    setBusy(false);
    els.input.focus();
  }
}

/* ============================================================
   Code workspace
   ============================================================ */
const LANGS = ['auto', 'python', 'javascript', 'typescript', 'php', 'java', 'c', 'cpp', 'csharp',
  'go', 'rust', 'ruby', 'sql', 'bash', 'powershell', 'html', 'css', 'json', 'yaml'];
const CODE_ACTIONS = [
  { id: 'explain', label: 'Explain this code', short: 'Explain', prompt: 'Explain what this code does, step by step. Point out anything important, surprising or risky.' },
  { id: 'fix', label: 'Find & fix bugs', short: 'Fix bugs', prompt: 'Find any bugs or problems in this code and fix them. Explain each fix you make.' },
  { id: 'improve', label: 'Improve quality', short: 'Improve', prompt: 'Refactor this code for readability, correctness and performance while keeping the same behaviour. Explain the changes.' },
  { id: 'comment', label: 'Add comments', short: 'Comment', prompt: 'Add clear, helpful comments and docstrings to this code. Return the fully commented code.' },
  { id: 'tests', label: 'Write tests', short: 'Tests', prompt: 'Write thorough unit tests for this code, covering edge cases.' },
  { id: 'optimize', label: 'Optimize performance', short: 'Optimize', prompt: 'Optimize this code for performance and explain the trade-offs.' },
  { id: 'convert', label: 'Convert / rewrite', short: 'Rewrite', prompt: 'Rewrite this code according to my instructions below.' },
  { id: 'custom', label: 'Custom request', short: 'Custom', prompt: '' },
];
const CODE_SYSTEM =
  'You are a senior software engineer helping inside a local coding workspace. ' +
  'Be precise, practical and concise. Always return complete, runnable code inside fenced code blocks ' +
  'with the correct language tag. Explain your reasoning briefly. Preserve the user\'s intent and ' +
  'programming language unless they ask you to change it. If the code has errors, fix them and say what was wrong.';

function fillCodeControls() {
  els.codeLang.innerHTML = '';
  LANGS.forEach((l) => {
    const o = document.createElement('option'); o.value = l; o.textContent = l === 'auto' ? 'language: auto' : l;
    els.codeLang.appendChild(o);
  });
  els.codeAction.innerHTML = '';
  CODE_ACTIONS.forEach((a) => {
    const o = document.createElement('option'); o.value = a.id; o.textContent = a.label;
    els.codeAction.appendChild(o);
  });
}

function renderCodeThread() {
  els.codeOutput.innerHTML = '';
  if (!codeThread.length) {
    const e = document.createElement('div');
    e.className = 'task';
    e.textContent = 'Paste code on the left, choose an action, then Run.';
    els.codeOutput.appendChild(e);
    return;
  }
  codeThread.forEach((t) => {
    const turn = document.createElement('div');
    turn.className = 'turn';
    const task = document.createElement('div');
    task.className = 'task';
    task.textContent = t.role === 'user' ? (t.label || 'Request') : 'Local AI';
    if (t.role === 'user' && t.lang && t.lang !== 'auto') {
      const chip = document.createElement('span'); chip.className = 'codechip'; chip.textContent = t.lang;
      task.appendChild(chip);
    }
    const ans = document.createElement('div');
    ans.className = 'ans content';
    ans.innerHTML = renderMarkdown(t.content || '');
    turn.appendChild(task); turn.appendChild(ans);
    els.codeOutput.appendChild(turn);
  });
  attachCopy(els.codeOutput);
  els.codeOutput.scrollTop = els.codeOutput.scrollHeight;
}

async function runCode() {
  if (codeBusy) return;
  const code = els.codeInput.value;
  const action = CODE_ACTIONS.find((a) => a.id === els.codeAction.value) || CODE_ACTIONS[0];
  const extra = els.codePrompt.value.trim();
  const lang = els.codeLang.value;

  if (!code.trim() && action.id !== 'custom') { toast('Paste some code first.', 'err'); return; }
  if (!code.trim() && action.id === 'custom' && !extra) { toast('Type what you want first.', 'err'); return; }

  const instruction = action.prompt || extra;
  let userContent = 'Task: ' + instruction + '\n';
  if (extra && action.id !== 'custom') userContent += 'Extra instructions: ' + extra + '\n';
  userContent += 'Language: ' + (lang === 'auto' ? 'detect from the code' : lang) + '\n';
  if (code.trim()) userContent += '\n```' + (lang === 'auto' ? '' : lang) + '\n' + code + '\n```\n';

  codeThread.push({ role: 'user', content: userContent, label: action.short, lang });
  const assistant = { role: 'assistant', content: '' };
  codeThread.push(assistant);
  renderCodeThread();
  codeBusy = true;
  els.codeRun.disabled = true;
  els.codeRun.textContent = 'Working…';

  const history = codeThread
    .filter((t) => t !== assistant && t.content)
    .map((t) => ({ role: t.role, content: t.content }));

  let raf = null;
  const paint = () => {
    raf = null;
    const turns = els.codeOutput.querySelectorAll('.turn');
    const last = turns[turns.length - 1];
    if (last) {
      const ans = last.querySelector('.ans');
      if (ans) ans.innerHTML = renderMarkdown(assistant.content) + '<span class="cursor"></span>';
    }
    els.codeOutput.scrollTop = els.codeOutput.scrollHeight;
  };
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  paint();

  try {
    await streamRequest({
      model: els.modelSelect.value || DEFAULT_CODE_MODEL,
      messages: history,
      use_rag: els.ragToggle.checked,
      use_memory: prefs.useMemory !== false,
      system: CODE_SYSTEM + (prefs.instructions ? '\n\nExtra instructions from the user:\n' + prefs.instructions : ''),
      temperature: 0.2,
    }, {
      onDelta: (d) => { assistant.content += d; schedule(); },
    });
    if (raf) cancelAnimationFrame(raf);
    if (!assistant.content) assistant.content = '(no response)';
    renderCodeThread(); saveCode();
  } catch (err) {
    if (raf) cancelAnimationFrame(raf);
    assistant.content = assistant.content || '';
    renderCodeThread();
    toast('Error: ' + (err && err.message ? err.message : err), 'err');
  } finally {
    codeBusy = false;
    els.codeRun.disabled = false;
    els.codeRun.textContent = 'Run  ▸';
  }
}

function copyLastCode() {
  const assistants = codeThread.filter((t) => t.role === 'assistant' && t.content);
  if (!assistants.length) { toast('Nothing to copy yet.'); return; }
  const text = assistants[assistants.length - 1].content;
  const blocks = [...text.matchAll(/```[\w.+#-]*\n?([\s\S]*?)```/g)];
  const out = blocks.length ? blocks[blocks.length - 1][1].replace(/\n$/, '') : text;
  navigator.clipboard.writeText(out).then(() => toast('Copied the last code block.', 'ok'));
}

/* ============================================================
   Modes + models
   ============================================================ */
function setMode(next) {
  mode = next;
  document.querySelectorAll('.mode-tab').forEach((b) => b.classList.toggle('active', b.dataset.mode === next));
  els.viewChat.classList.toggle('hidden', next !== 'chat');
  els.viewCode.classList.toggle('hidden', next !== 'code');
  applyModeModel();
  prefs.mode = next; save();
  if (next === 'code') els.codeInput.focus(); else els.input.focus();
}
function applyModeModel() {
  const wanted = mode === 'code' ? prefs.modelCode : prefs.modelChat;
  if (wanted && [...els.modelSelect.options].some((o) => o.value === wanted)) {
    els.modelSelect.value = wanted;
  }
}

async function loadModels() {
  try {
    const res = await fetch(API.models);
    const data = await res.json();
    allModels = (data.models || []).filter((m) => m.kind === 'chat');
    els.modelSelect.innerHTML = '';
    allModels.forEach((m) => {
      const o = document.createElement('option');
      o.value = m.name;
      o.textContent = (isVisionModel(m.name) ? '👁 ' : '') + m.name + (m.params ? '  ·  ' + m.params : '');
      els.modelSelect.appendChild(o);
    });
    if (!allModels.length) {
      const o = document.createElement('option'); o.value = DEFAULT_CHAT_MODEL; o.textContent = DEFAULT_CHAT_MODEL;
      els.modelSelect.appendChild(o);
    }
    // sensible defaults per mode
    const pick = (list, fallback) => {
      const found = list.find((n) => allModels.some((m) => m.name === n));
      return found || fallback;
    };
    if (prefs.autoModel !== false) {
      // Automatically use the best installed model unless the user picked one themselves.
      prefs.modelChat = pick(['llama3.1:8b', 'llama3.2:3b'], DEFAULT_CHAT_MODEL);
      prefs.modelCode = pick(['qwen2.5-coder:7b', 'qwen2.5-coder:3b'], DEFAULT_CODE_MODEL);
    } else {
      if (!prefs.modelChat) prefs.modelChat = pick(['llama3.1:8b', 'llama3.2:3b'], DEFAULT_CHAT_MODEL);
      if (!prefs.modelCode) prefs.modelCode = pick(['qwen2.5-coder:7b', 'qwen2.5-coder:3b'], DEFAULT_CODE_MODEL);
    }
    applyModeModel();
    save();
  } catch (e) {
    toast('Could not load models: ' + e.message, 'err');
  }
}

/* ============================================================
   Status + knowledge base
   ============================================================ */
async function loadStatus() {
  try {
    const res = await fetch(API.status);
    const s = await res.json();
    if (s.ollama) {
      els.statusDot.className = 'dot on';
      els.statusText.textContent = 'Engine ready · ' + s.docs + ' doc' + (s.docs === 1 ? '' : 's');
    } else {
      els.statusDot.className = 'dot off';
      els.statusText.textContent = 'Engine offline';
    }
  } catch (e) {
    els.statusDot.className = 'dot off'; els.statusText.textContent = 'Engine offline';
  }
}

async function loadDocs() {
  try {
    const res = await fetch(API.documents);
    const data = await res.json();
    const docs = data.documents || [];
    els.kbCount.textContent = docs.length;
    els.docList.innerHTML = '';
    if (!docs.length) {
      const e = document.createElement('div'); e.className = 'doc-empty'; e.textContent = 'No documents yet.';
      els.docList.appendChild(e); return;
    }
    docs.forEach((d) => {
      const row = document.createElement('div');
      row.className = 'doc';
      row.innerHTML = '<span class="ico">📄</span>' +
        '<span class="meta"><span class="dname"></span>' +
        '<span class="dsub">' + (d.chunk_count || 0) + ' chunks · .' + escapeHtml(d.ext || '') + '</span></span>' +
        '<span class="del" title="Remove">✕</span>';
      row.querySelector('.dname').textContent = d.name;
      row.querySelector('.del').addEventListener('click', async () => {
        try {
          await fetch(API.documents, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', id: d.id }) });
          loadDocs(); loadStatus();
        } catch (e) { toast('Delete failed: ' + e.message, 'err'); }
      });
      els.docList.appendChild(row);
    });
  } catch (e) { toast('Could not load documents: ' + e.message, 'err'); }
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const fd = new FormData();
  files.forEach((f) => fd.append('files', f, f.name));
  toast('Indexing ' + files.length + ' file' + (files.length > 1 ? 's' : '') + '… this runs locally.', 'ok');
  els.uploadBtn.disabled = true;
  els.uploadBtn.innerHTML = '<span>⏳ Indexing…</span>';
  try {
    const res = await fetch(API.ingest, { method: 'POST', body: fd });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    (data.results || []).forEach((r) => {
      if (r.ok) toast('Added “' + r.name + '” (' + r.chunks + ' chunks)', 'ok');
      else toast('“' + r.name + '” failed: ' + r.error, 'err');
    });
  } catch (e) {
    toast('Upload failed: ' + e.message, 'err');
  } finally {
    els.uploadBtn.disabled = false;
    els.uploadBtn.innerHTML = '<span>⬆&nbsp; Add documents</span>';
    els.fileInput.value = '';
    loadDocs(); loadStatus();
  }
}

/* ============================================================
   Memory & instructions
   ============================================================ */
function updateMemoryBadge() {
  const n = memoryItems.length;
  if (!n) els.memoryCount.textContent = 'Nothing saved yet';
  else els.memoryCount.textContent = n + ' fact' + (n === 1 ? '' : 's') + (prefs.useMemory === false ? ' · off' : '');
}

function renderMemory() {
  els.memList.innerHTML = '';
  if (!memoryItems.length) {
    const e = document.createElement('div');
    e.className = 'mem-empty';
    e.textContent = 'No facts yet. Add things you want it to remember about you.';
    els.memList.appendChild(e);
    updateMemoryBadge();
    return;
  }
  memoryItems.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'mem-item';

    const txt = document.createElement('span');
    txt.className = 'txt';
    txt.textContent = item.text;
    row.appendChild(txt);

    const edit = document.createElement('button');
    edit.className = 'act';
    edit.title = 'Edit';
    edit.textContent = '✎';
    edit.addEventListener('click', () => startMemoryEdit(row, item));
    row.appendChild(edit);

    const del = document.createElement('button');
    del.className = 'act del';
    del.title = 'Delete';
    del.textContent = '✕';
    del.addEventListener('click', () => deleteMemory(item.id));
    row.appendChild(del);

    els.memList.appendChild(row);
  });
  updateMemoryBadge();
}

function startMemoryEdit(row, item) {
  if (row.querySelector('input')) return;
  row.innerHTML = '';
  const input = document.createElement('input');
  input.value = item.text;
  row.appendChild(input);

  const saveBtn = document.createElement('button');
  saveBtn.className = 'act';
  saveBtn.title = 'Save';
  saveBtn.textContent = '✓';
  row.appendChild(saveBtn);

  const cancel = document.createElement('button');
  cancel.className = 'act';
  cancel.title = 'Cancel';
  cancel.textContent = '↺';
  row.appendChild(cancel);

  const commit = async () => {
    const text = input.value.trim();
    if (!text) { toast('Memory cannot be empty.', 'err'); return; }
    try {
      await memoryAction({ action: 'update', id: item.id, text });
      item.text = text;
      renderMemory();
    } catch (e) { toast('Could not save: ' + e.message, 'err'); }
  };
  saveBtn.addEventListener('click', commit);
  cancel.addEventListener('click', renderMemory);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    if (e.key === 'Escape') renderMemory();
  });
  input.focus();
  input.select();
}

async function memoryAction(payload) {
  const res = await fetch(API.memory, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data = {};
  try { data = await res.json(); } catch (e) {}
  if (!res.ok || data.error) throw new Error(data.error || ('Request failed (' + res.status + ')'));
  return data;
}

async function addMemory() {
  const raw = els.memInput.value.trim();
  if (!raw) { els.memInput.focus(); return; }
  els.memAdd.disabled = true;
  try {
    const data = await memoryAction({ action: 'add', text: raw });
    els.memInput.value = '';
    await loadMemory();
    toast('Saved ' + (data.added || 1) + ' memory item' + ((data.added || 1) === 1 ? '' : 's') + '.', 'ok');
  } catch (e) {
    toast('Could not save memory: ' + e.message, 'err');
  } finally {
    els.memAdd.disabled = false;
    els.memInput.focus();
  }
}

async function deleteMemory(id) {
  try {
    await memoryAction({ action: 'delete', id });
    memoryItems = memoryItems.filter((m) => m.id !== id);
    renderMemory();
  } catch (e) { toast('Could not delete: ' + e.message, 'err'); }
}

async function clearMemory() {
  if (!memoryItems.length) { toast('Memory is already empty.'); return; }
  if (!window.confirm('Delete every saved memory item? This cannot be undone.')) return;
  try {
    await memoryAction({ action: 'clear' });
    memoryItems = [];
    renderMemory();
    toast('Memory cleared.', 'ok');
  } catch (e) { toast('Could not clear memory: ' + e.message, 'err'); }
}

async function loadMemory() {
  try {
    const res = await fetch(API.memory);
    const data = await res.json();
    memoryItems = Array.isArray(data.items) ? data.items : [];
    renderMemory();
  } catch (e) {
    memoryItems = [];
    renderMemory();
  }
}

function saveInstructions() {
  prefs.instructions = els.memInstructions.value.trim();
  save();
  els.memStatus.textContent = 'Saved locally ✓';
  els.memStatus.classList.add('ok');
  setTimeout(() => {
    els.memStatus.textContent = 'Saved locally';
    els.memStatus.classList.remove('ok');
  }, 2000);
}

function openMemory() {
  els.memInstructions.value = prefs.instructions || '';
  els.useMemory.checked = prefs.useMemory !== false;
  els.memoryModal.classList.add('show');
  els.memoryModal.setAttribute('aria-hidden', 'false');
  loadMemory();
  setTimeout(() => els.memInput.focus(), 60);
}

function closeMemory() {
  els.memoryModal.classList.remove('show');
  els.memoryModal.setAttribute('aria-hidden', 'true');
}

/* ============================================================
   Wiring + boot
   ============================================================ */
function bind() {
  // chat
  els.sendBtn.addEventListener('click', sendChat);
  els.input.addEventListener('input', autogrow);
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  });
  els.attachBtn.addEventListener('click', () => els.imageInput.click());
  els.imageInput.addEventListener('change', (e) => { addImages(e.target.files); e.target.value = ''; });

  // code
  els.codeRun.addEventListener('click', runCode);
  els.codeReset.addEventListener('click', () => {
    codeThread = []; saveCode(); els.codeInput.value = ''; els.codePrompt.value = ''; renderCodeThread();
  });
  els.codeCopyAll.addEventListener('click', copyLastCode);
  els.codePrompt.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runCode(); } });

  // modes
  document.querySelectorAll('.mode-tab').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  // sidebar + common
  els.newChat.addEventListener('click', () => { newConversation(); els.sidebar.classList.remove('open'); els.input.focus(); });
  els.modelSelect.addEventListener('change', () => {
    if (mode === 'code') prefs.modelCode = els.modelSelect.value; else prefs.modelChat = els.modelSelect.value;
    prefs.autoModel = false;   // remember the user's explicit choice
    save();
  });
  els.ragToggle.addEventListener('change', () => { prefs.rag = els.ragToggle.checked; save(); });
  els.menuBtn.addEventListener('click', () => els.sidebar.classList.toggle('open'));

  // memory & instructions
  els.memoryBtn.addEventListener('click', openMemory);
  els.memoryClose.addEventListener('click', closeMemory);
  els.memoryDone.addEventListener('click', closeMemory);
  els.memoryModal.addEventListener('click', (e) => { if (e.target === els.memoryModal) closeMemory(); });
  els.memAdd.addEventListener('click', addMemory);
  els.memInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); addMemory(); }
  });
  els.useMemory.addEventListener('change', () => {
    prefs.useMemory = els.useMemory.checked;
    save(); updateMemoryBadge();
    toast(prefs.useMemory ? 'Memory is on for chats.' : 'Memory is off — facts are kept but not sent.', 'ok');
  });
  els.memSaveInstructions.addEventListener('click', saveInstructions);
  els.memInstructions.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveInstructions(); }
  });
  els.memClear.addEventListener('click', clearMemory);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.memoryModal.classList.contains('show')) closeMemory();
  });

  // upload
  els.uploadBtn.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', (e) => uploadFiles(e.target.files));

  // drag & drop files (documents) and images
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; els.dropOverlay.classList.add('show'); });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault(); dragDepth--; if (dragDepth <= 0) { dragDepth = 0; els.dropOverlay.classList.remove('show'); }
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault(); dragDepth = 0; els.dropOverlay.classList.remove('show');
    const files = e.dataTransfer && e.dataTransfer.files ? e.dataTransfer.files : null;
    if (!files || !files.length) return;
    const imgs = [...files].filter((f) => f.type.startsWith('image/'));
    const others = [...files].filter((f) => !f.type.startsWith('image/'));
    if (mode === 'chat' && imgs.length) addImages(imgs);
    if (others.length) uploadFiles(others);
  });
}

async function boot() {
  load();
  bind();
  renderConvoList();
  renderMessages();
  fillCodeControls();
  renderCodeThread();
  setMode(mode);
  autogrow();
  if (mode === 'chat') els.input.focus();
  await loadModels();
  loadStatus();
  loadDocs();
  loadMemory();
  setInterval(loadStatus, 20000);
}

boot();
