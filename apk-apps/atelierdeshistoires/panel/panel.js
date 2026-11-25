// Panel d'administration — Atelier des Histoires
// Lit et écrit le contenu (FORMAT_CONTENU.md) dans le dépôt GitHub, puis publie tout en un seul commit.

const $ = (s) => document.querySelector(s);
const DEFAULTS = { repo: 'fouadmabchour/fouadmabchour.github.io', branch: 'master', path: 'apk-apps/atelierdeshistoires/contenu' };
const KEY = 'atelier-panel-cfg';

const state = {
  cfg: null,
  catalog: null,
  books: new Map(),        // id → book.json chargé
  pending: new Map(),      // chemin relatif → string | Blob  (à publier)
  deletes: new Set(),      // chemins relatifs à supprimer
  deletePrefixes: new Set(), // dossiers à supprimer (livre supprimé)
  bookId: null,            // livre ouvert (null = nouveau)
  draftCover: null,        // Blob de couverture en attente
  chapter: null,           // { ref, isNew }
};

// ───────────── Utilitaires ─────────────
const now = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const slug = (s) => s.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase().replace(/['’]/g, '-').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
const icons = () => window.lucide?.createIcons();
const setStatus = (t) => { $('#status').textContent = t; };
const pad3 = (n) => String(n).padStart(3, '0');

function loadCfg() {
  const raw = localStorage.getItem(KEY) ?? sessionStorage.getItem(KEY);
  return raw ? JSON.parse(raw) : null;
}
function saveCfg(cfg, remember) {
  localStorage.removeItem(KEY); sessionStorage.removeItem(KEY);
  (remember ? localStorage : sessionStorage).setItem(KEY, JSON.stringify(cfg));
}

async function toBase64(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(await data.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Redimensionne une image en WebP (qualité 0,75). cover=true → recadrage 2:3 en 360×540. */
async function toWebp(file, { cover = false, maxWidth = 1080 } = {}) {
  const bmp = await createImageBitmap(file);
  let sx = 0, sy = 0, sw = bmp.width, sh = bmp.height, w, h;
  if (cover) {
    const r = 2 / 3;
    if (sw / sh > r) { sw = sh * r; sx = (bmp.width - sw) / 2; } else { sh = sw / r; sy = (bmp.height - sh) / 2; }
    w = 360; h = 540;
  } else {
    w = Math.min(maxWidth, sw); h = Math.round(sh * (w / sw));
  }
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
  bmp.close();
  return canvas.convertToBlob({ type: 'image/webp', quality: 0.75 });
}

// ───────────── API GitHub ─────────────
/** Mode démo (dépôt « demo ») : lit ../contenu/ en local et simule l'écriture, sans GitHub. */
const demoLog = [];
async function demo(path, opts) {
  const m = path.match(/\/contents\/(.+?)\?/);
  if (m) {
    const rel = decodeURIComponent(m[1]).slice(state.cfg.path.replace(/\/$/, '').length + 1);
    const r = await fetch(`../contenu/${rel}`);
    if (!r.ok) { if (opts.allow404) return null; throw new Error(`démo ${r.status}`); }
    return r.text();
  }
  demoLog.push({ path, method: opts.method ?? 'GET', body: opts.body ? JSON.parse(opts.body) : null });
  window.__demoLog = demoLog;
  if (path.includes('/git/ref/')) return { object: { sha: 'demo-head' } };
  if (path.includes('/git/commits/')) return { sha: 'demo-head', tree: { sha: 'demo-tree' } };
  if (path.includes('/git/trees/') && !opts.method) return { tree: [] };
  return { sha: `demo-${demoLog.length}` };
}

async function gh(path, opts = {}) {
  if (state.cfg.repo === 'demo') return demo(path, opts);
  const r = await fetch(`https://api.github.com${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${state.cfg.token}`,
      Accept: opts.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (r.status === 404 && opts.allow404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} : ${(await r.text()).slice(0, 200)}`);
  return opts.raw ? r.text() : r.json();
}

const repoPath = (rel) => `${state.cfg.path.replace(/\/$/, '')}/${rel}`;

async function readText(rel) {
  const p = state.pending.get(rel);
  if (typeof p === 'string') return p;
  const ref = encodeURIComponent(state.cfg.branch);
  return gh(`/repos/${state.cfg.repo}/contents/${repoPath(rel)}?ref=${ref}&t=${Date.now()}`, { raw: true, allow404: true });
}

function imageUrl(rel) {
  const p = state.pending.get(rel);
  if (p instanceof Blob) return URL.createObjectURL(p);
  if (state.cfg.repo === 'demo') return `../contenu/${rel}`;
  return `https://raw.githubusercontent.com/${state.cfg.repo}/${state.cfg.branch}/${repoPath(rel)}`;
}

function write(rel, data) {
  state.pending.set(rel, typeof data === 'string' || data instanceof Blob ? data : JSON.stringify(data, null, 1));
  state.deletes.delete(rel);
  refreshPending();
}

function remove(rel) { state.pending.delete(rel); state.deletes.add(rel); refreshPending(); }

function refreshPending() {
  const n = state.pending.size + state.deletes.size + state.deletePrefixes.size;
  $('#pending').hidden = n === 0;
  $('#pending').textContent = `${n} modification${n > 1 ? 's' : ''} à publier`;
  $('#btn-publish').disabled = n === 0;
}

/** Publie toutes les modifications en un seul commit (API Git Data). */
async function publish() {
  const { repo, branch } = state.cfg;
  $('#btn-publish').disabled = true;
  setStatus('Publication en cours…');
  // Instantané : une modification faite pendant la publication reste en attente pour la suivante
  const snapPending = new Map(state.pending);
  const snapDeletes = new Set(state.deletes);
  const snapPrefixes = new Set(state.deletePrefixes);
  try {
    const ref = await gh(`/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`);
    const head = await gh(`/repos/${repo}/git/commits/${ref.object.sha}`);
    const tree = [];
    for (const [rel, data] of snapPending) {
      const blob = await gh(`/repos/${repo}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: await toBase64(data), encoding: 'base64' }) });
      tree.push({ path: repoPath(rel), mode: '100644', type: 'blob', sha: blob.sha });
    }
    const toDelete = new Set([...snapDeletes].map(repoPath));
    if (snapPrefixes.size) {
      const full = await gh(`/repos/${repo}/git/trees/${head.tree.sha}?recursive=1`);
      for (const e of full.tree) {
        if (e.type === 'blob' && [...snapPrefixes].some((p) => e.path.startsWith(repoPath(p) + '/'))) toDelete.add(e.path);
      }
    }
    const written = new Set(tree.map((t) => t.path));
    for (const p of toDelete) if (!written.has(p)) tree.push({ path: p, mode: '100644', type: 'blob', sha: null });
    const newTree = await gh(`/repos/${repo}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: head.tree.sha, tree }) });
    const commit = await gh(`/repos/${repo}/git/commits`, {
      method: 'POST', body: JSON.stringify({ message: `Contenu : mise à jour depuis le panel (${now()})`, tree: newTree.sha, parents: [head.sha] }),
    });
    await gh(`/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
    for (const [k, v] of snapPending) if (state.pending.get(k) === v) state.pending.delete(k);
    for (const k of snapDeletes) state.deletes.delete(k);
    for (const k of snapPrefixes) state.deletePrefixes.delete(k);
    refreshPending();
    setStatus(state.pending.size ? 'Publié ✔ — d\'autres modifications restent à publier.' : 'Publié ✔ — visible dans l\'application d\'ici quelques minutes.');
  } catch (e) {
    setStatus(`Échec de la publication : ${e.message}`);
    refreshPending();
  }
}

// ───────────── Catalogue ─────────────
async function loadCatalog() {
  setStatus('Chargement…');
  try {
    const txt = await readText('catalog.json');
    state.catalog = txt ? JSON.parse(txt) : { version: 1, updatedAt: now(), categories: [], books: [] };
    setStatus(txt ? '' : 'Catalogue vide : crée ta première histoire.');
    renderList();
  } catch (e) {
    setStatus(`Impossible de lire le dépôt : ${e.message}`);
  }
}

function saveCatalog() { state.catalog.updatedAt = now(); write('catalog.json', state.catalog); }

function renderList() {
  const ul = $('#book-list');
  ul.replaceChildren();
  const books = [...state.catalog.books].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const b of books) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const img = document.createElement('img');
    img.alt = ''; img.loading = 'lazy'; img.src = imageUrl(b.cover);
    const t = document.createElement('strong'); t.textContent = b.title;
    const s = document.createElement('small'); s.textContent = `${b.chapterCount} chapitre(s) · ${b.status === 'completed' ? 'terminé' : 'en cours'}${b.featured ? ' · à la une' : ''}`;
    btn.append(img, t, s);
    btn.addEventListener('click', () => openBook(b.id));
    li.append(btn); ul.append(li);
  }
}

// ───────────── Édition d'un livre ─────────────
function showView(v) {
  $('#view-list').hidden = v !== 'list';
  $('#view-book').hidden = v !== 'book';
  if (v === 'list') renderList();
}

function renderCatChecks(selected = []) {
  const box = $('#f-cats');
  box.replaceChildren();
  for (const c of state.catalog.categories) {
    const id = `cat-${c.id}`;
    const i = Object.assign(document.createElement('input'), { type: 'checkbox', id, value: c.id, name: 'categories', checked: selected.includes(c.id) });
    const l = Object.assign(document.createElement('label'), { htmlFor: id, textContent: c.name });
    box.append(i, l);
  }
  if (!state.catalog.categories.length) box.textContent = 'Aucune catégorie : crée-en avec le bouton « Catégories ».';
}

async function openBook(id) {
  state.bookId = id; state.draftCover = null;
  const form = $('#book-form');
  form.reset();
  $('#f-title-err').textContent = ''; $('#f-id-err').textContent = '';
  let book = { id: '', title: '', author: '', summary: '', categories: [], status: 'ongoing', chapters: [] };
  if (id) {
    setStatus('Chargement de l\'histoire…');
    const txt = await readText(`books/${id}/book.json`);
    book = txt ? JSON.parse(txt) : book;
    state.books.set(id, book);
    setStatus('');
  }
  const entry = state.catalog.books.find((b) => b.id === id);
  $('#book-title-h').textContent = id ? book.title : 'Nouvelle histoire';
  $('#f-title').value = book.title;
  $('#f-id').value = book.id;
  $('#f-id').readOnly = !!id;
  $('#f-author').value = book.author ?? '';
  $('#f-summary').value = book.summary ?? '';
  form.elements.status.value = book.status ?? 'ongoing';
  $('#f-featured').checked = !!entry?.featured;
  renderCatChecks(book.categories ?? []);
  setCoverPreview(id ? imageUrl(`books/${id}/cover.webp`) : null);
  $('#btn-delete-book').hidden = !id;
  $('#btn-new-chapter').disabled = !id;
  renderChapters();
  showView('book');
  $('#f-title').focus();
}

function setCoverPreview(url) {
  $('#cover-preview').hidden = !url;
  $('#cover-empty').hidden = !!url;
  if (url) $('#cover-preview').src = url;
}

function currentBook() { return state.bookId ? state.books.get(state.bookId) : null; }

function touchBook(book) {
  book.updatedAt = now();
  write(`books/${book.id}/book.json`, book);
  const e = state.catalog.books.find((b) => b.id === book.id);
  if (e) { e.updatedAt = book.updatedAt; e.chapterCount = book.chapters.length; }
  saveCatalog();
}

function validateBook() {
  const t = $('#f-title'), i = $('#f-id');
  let ok = true;
  $('#f-title-err').textContent = t.value.trim() ? '' : 'Le titre est obligatoire.';
  t.setAttribute('aria-invalid', String(!t.value.trim())); ok &&= !!t.value.trim();
  let idMsg = '';
  if (!/^[a-z0-9-]+$/.test(i.value)) idMsg = 'Identifiant invalide.';
  else if (!state.bookId && state.catalog.books.some((b) => b.id === i.value)) idMsg = 'Cet identifiant existe déjà.';
  $('#f-id-err').textContent = idMsg;
  i.setAttribute('aria-invalid', String(!!idMsg)); ok &&= !idMsg;
  if (!state.bookId && !state.draftCover) { $('#f-title-err').textContent ||= 'Ajoute une couverture.'; ok = false; }
  return ok;
}

function saveBook(ev) {
  ev.preventDefault();
  if (!validateBook()) return;
  const f = $('#book-form');
  const id = $('#f-id').value;
  const isNew = !state.bookId;
  const book = isNew ? { id, chapters: [] } : currentBook();
  Object.assign(book, {
    title: $('#f-title').value.trim(),
    author: $('#f-author').value.trim(),
    summary: $('#f-summary').value.trim(),
    cover: `books/${id}/cover.webp`,
    categories: [...f.querySelectorAll('input[name=categories]:checked')].map((c) => c.value),
    tags: book.tags ?? [],
    status: f.elements.status.value,
  });
  if (state.draftCover) { write(`books/${id}/cover.webp`, state.draftCover); state.draftCover = null; }
  let entry = state.catalog.books.find((b) => b.id === id);
  if (!entry) {
    entry = { id, publishedAt: now(), order: Math.max(-1, ...state.catalog.books.map((b) => b.order ?? 0)) + 1 };
    state.catalog.books.push(entry);
  }
  Object.assign(entry, {
    title: book.title, author: book.author, cover: book.cover, summary: book.summary,
    categories: book.categories, tags: book.tags, status: book.status, featured: $('#f-featured').checked,
  });
  state.books.set(id, book);
  state.bookId = id;
  touchBook(book);
  $('#f-id').readOnly = true;
  $('#btn-delete-book').hidden = false;
  $('#btn-new-chapter').disabled = false;
  $('#book-title-h').textContent = book.title;
  setStatus(isNew ? 'Histoire créée. Ajoute ses chapitres puis publie.' : 'Enregistré. Pense à publier.');
}

async function deleteBook() {
  const b = currentBook();
  if (!b || !(await confirmDlg(`Supprimer « ${b.title} » et tous ses chapitres ?`))) return;
  state.catalog.books = state.catalog.books.filter((x) => x.id !== b.id);
  for (const k of [...state.pending.keys()]) if (k.startsWith(`books/${b.id}/`)) state.pending.delete(k);
  state.deletePrefixes.add(`books/${b.id}`);
  state.books.delete(b.id);
  saveCatalog();
  showView('list');
}

// ───────────── Chapitres ─────────────
function renderChapters() {
  const ol = $('#chapter-list');
  ol.replaceChildren();
  const book = currentBook();
  if (!book) { ol.textContent = 'Enregistre d\'abord l\'histoire.'; return; }
  book.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    const n = Object.assign(document.createElement('span'), { className: 'n', textContent: c.number });
    const t = Object.assign(document.createElement('span'), { className: 't', textContent: c.title });
    const mk = (icon, label, fn, disabled = false) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', disabled });
      b.setAttribute('aria-label', `${label} : ${c.title}`);
      b.innerHTML = `<i data-lucide="${icon}"></i>`;
      b.addEventListener('click', fn);
      return b;
    };
    li.append(n, t,
      mk('arrow-up', 'Monter', () => moveChapter(i, -1), i === 0),
      mk('arrow-down', 'Descendre', () => moveChapter(i, 1), i === book.chapters.length - 1),
      mk('pencil', 'Modifier', () => openChapter(c)),
      mk('trash-2', 'Supprimer', () => deleteChapter(i)));
    ol.append(li);
  });
  if (!book.chapters.length) ol.textContent = 'Aucun chapitre.';
  icons();
}

function renumber(book) { book.chapters.forEach((c, i) => { c.number = i + 1; }); }

function moveChapter(i, d) {
  const book = currentBook();
  const [c] = book.chapters.splice(i, 1);
  book.chapters.splice(i + d, 0, c);
  renumber(book);
  // le numéro est aussi stocké dans le fichier du chapitre : on le garde aligné au prochain enregistrement
  touchBook(book); renderChapters();
}

async function deleteChapter(i) {
  const book = currentBook();
  const c = book.chapters[i];
  if (!(await confirmDlg(`Supprimer le chapitre « ${c.title} » ?`))) return;
  book.chapters.splice(i, 1);
  remove(`books/${book.id}/${c.file}`);
  renumber(book); touchBook(book); renderChapters();
}

function nextChapterFile(book) {
  const used = book.chapters.map((c) => parseInt(c.file.match(/(\d+)\.json$/)?.[1] ?? '0', 10));
  return `chapters/${pad3(Math.max(0, ...used) + 1)}.json`;
}

const IMG = /^\[image:([^|\]]+)(?:\|([^\]]*))?\]$/;

async function openChapter(ref) {
  const book = currentBook();
  const isNew = !ref;
  ref ??= { number: book.chapters.length + 1, title: `Chapitre ${book.chapters.length + 1}`, file: nextChapterFile(book) };
  state.chapter = { ref, isNew, dirty: false };
  state.edRange = null;
  $('#c-title').value = ref.title;
  loadEditor([]);
  $('#c-msg').textContent = '';
  if (!isNew) {
    $('#c-msg').textContent = 'Chargement…';
    const txt = await readText(`books/${book.id}/${ref.file}`);
    const ch = txt ? JSON.parse(txt) : { blocks: [] };
    loadEditor(ch.blocks);
    $('#c-msg').textContent = '';
  }
  $('#dlg-chapter').showModal();
  $('#c-editor').scrollTop = 0; $('#dlg-chapter').scrollTop = 0;
  $('#c-title').focus();
}

// ───────────── Éditeur de chapitre : texte et images à leur place ─────────────
const ED = () => $('#c-editor');
const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** "*italique*" → <em> */
const toHtml = (t) => esc(t).replace(/\*([^*]+)\*/g, '<em>$1</em>');
/** Contenu d'un paragraphe → texte au format des chapitres (italique = *…*, <br> = coupure). */
function nodeText(n) {
  if (n.nodeType === 3) return n.nodeValue;
  if (n.nodeName === 'BR') return '\n';
  const inner = [...n.childNodes].map(nodeText).join('');
  const it = ['EM', 'I'].includes(n.nodeName) || n.style?.fontStyle === 'italic';
  return it && inner.trim() ? inner.split('\n').map((x) => (x.trim() ? `*${x}*` : x)).join('\n') : inner;
}
const clean = (t) => t.replace(/\*\*/g, '').replace(/[ \t]+/g, ' ').trim();

function makeFigure(src, caption) {
  const book = currentBook();
  const fig = document.createElement('figure');
  fig.contentEditable = 'false'; fig.dataset.src = src;
  const img = document.createElement('img');
  img.alt = caption || ''; img.src = imageUrl(`books/${book.id}/${src}`);
  const cap = document.createElement('input');
  cap.className = 'cap'; cap.placeholder = 'Légende (facultative)'; cap.value = caption || '';
  cap.setAttribute('aria-label', 'Légende de l\'image');
  cap.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
  cap.addEventListener('input', () => { state.chapter.dirty = true; });
  const tools = document.createElement('div');
  tools.className = 'fig-tools';
  const btn = (icon, label, fn) => {
    const b = document.createElement('button');
    b.type = 'button'; b.title = label; b.setAttribute('aria-label', label);
    b.innerHTML = `<i data-lucide="${icon}"></i>`;
    b.addEventListener('click', () => { fn(); state.chapter.dirty = true; });
    return b;
  };
  tools.append(
    btn('arrow-up', 'Monter l\'image', () => { const p = fig.previousElementSibling; if (p) p.before(fig); fig.scrollIntoView({ block: 'nearest' }); }),
    btn('arrow-down', 'Descendre l\'image', () => { const n = fig.nextElementSibling; if (n) n.after(fig); fig.scrollIntoView({ block: 'nearest' }); }),
    btn('trash-2', 'Retirer l\'image', () => { if (confirm('Retirer cette image du chapitre ?')) fig.remove(); }),
  );
  fig.append(tools, img, cap);
  return fig;
}

function paragraph(text) {
  const p = document.createElement('p');
  p.innerHTML = text ? toHtml(text) : '<br>';
  return p;
}

function loadEditor(blocks) {
  const ed = ED();
  ed.replaceChildren(...blocks.map((b) => (b.type === 'image' ? makeFigure(b.src, b.caption) : paragraph(b.value))));
  if (!ed.lastElementChild || ed.lastElementChild.nodeName === 'FIGURE') ed.append(paragraph(''));
  icons();
}

function readEditor() {
  const out = [];
  for (const n of ED().childNodes) {
    if (n.nodeName === 'FIGURE') { out.push({ type: 'image', src: n.dataset.src, caption: n.querySelector('.cap').value.trim() }); continue; }
    for (const line of nodeText(n).split('\n')) { const v = clean(line); if (v) out.push({ type: 'text', value: v }); }
  }
  return out;
}

/** Paragraphe (enfant direct de l'éditeur) qui contient le curseur. */
function currentPara() {
  const sel = getSelection();
  let n = sel.rangeCount && ED().contains(sel.getRangeAt(0).startContainer) ? sel.getRangeAt(0).startContainer : state.edRange?.startContainer;
  while (n && n.parentNode !== ED()) n = n.parentNode;
  return n && ED().contains(n) ? n : null;
}
function restoreRange() {
  if (!state.edRange) return;
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(state.edRange);
}
function caretAt(node) {
  const r = document.createRange(); r.setStart(node, 0); r.collapse(true);
  const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
}
document.addEventListener('selectionchange', () => {
  const sel = getSelection();
  if (sel.rangeCount && ED()?.contains(sel.getRangeAt(0).startContainer)) state.edRange = sel.getRangeAt(0).cloneRange();
});

function edCommand(cmd) {
  const ed = ED();
  ed.focus(); restoreRange();
  if (cmd === 'italic') document.execCommand('italic');
  else if (cmd === 'ellipsis') document.execCommand('insertText', false, '…');
  else if (cmd === 'quotes') {
    const t = getSelection().toString().trim();
    document.execCommand('insertHTML', false, `<em>« ${esc(t)} »</em>${t ? '' : ''}`);
  }
  else if (cmd === 'dialogue') {
    let p = currentPara();
    if (!p || p.nodeName === 'FIGURE') { p = paragraph(''); ed.append(p); }
    if (!p.textContent.trimStart().startsWith('—')) { caretAt(p); document.execCommand('insertText', false, '— '); }
  } else if (cmd === 'scene') {
    const p = currentPara();
    const s = paragraph('⁂'); const after = paragraph('');
    if (p) p.after(s, after); else ed.append(s, after);
    caretAt(after);
  }
  state.chapter.dirty = true;
}

function saveChapter() {
  const book = currentBook();
  const { ref, isNew } = state.chapter;
  const title = $('#c-title').value.trim() || ref.title;
  const blocks = readEditor();
  const updatedAt = now();
  write(`books/${book.id}/${ref.file}`, { number: ref.number, title, blocks });
  if (isNew) book.chapters.push({ ...ref, title, updatedAt });
  else Object.assign(book.chapters.find((c) => c.file === ref.file), { title, updatedAt });
  touchBook(book);
  renderChapters();
  state.chapter = null;
}

async function insertImage(file) {
  const book = currentBook();
  const { ref } = state.chapter;
  $('#c-msg').textContent = 'Compression de l\'image…';
  const blob = await toWebp(file);
  const base = ref.file.replace(/^chapters\//, '').replace(/\.json$/, '');
  const rel = `images/${base}-${Date.now().toString(36)}.webp`;
  write(`books/${book.id}/${rel}`, blob);
  const fig = makeFigure(rel, '');
  const p = currentPara();
  if (p) p.after(fig); else ED().append(fig);
  if (!fig.nextElementSibling) fig.after(paragraph(''));
  icons();
  fig.scrollIntoView({ block: 'center' });
  state.chapter.dirty = true;
  $('#c-msg').textContent = `Image ajoutée (${Math.round(blob.size / 1024)} Ko).`;
}

// ───────────── Catégories ─────────────
function renderCats() {
  const ul = $('#cat-list');
  ul.replaceChildren();
  const cats = state.catalog.categories;
  cats.forEach((c, i) => {
    const li = document.createElement('li');
    const input = Object.assign(document.createElement('input'), { value: c.name, autocomplete: 'off' });
    input.setAttribute('aria-label', `Nom de la catégorie ${c.name}`);
    input.addEventListener('change', () => { c.name = input.value.trim() || c.name; saveCatalog(); });
    const mk = (icon, label, fn, disabled = false) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'icon', disabled });
      b.setAttribute('aria-label', `${label} : ${c.name}`);
      b.innerHTML = `<i data-lucide="${icon}"></i>`;
      b.addEventListener('click', fn);
      return b;
    };
    li.append(input,
      mk('arrow-up', 'Monter', () => { cats.splice(i - 1, 0, ...cats.splice(i, 1)); saveCatalog(); renderCats(); }, i === 0),
      mk('arrow-down', 'Descendre', () => { cats.splice(i + 1, 0, ...cats.splice(i, 1)); saveCatalog(); renderCats(); }, i === cats.length - 1),
      mk('trash-2', 'Supprimer', async () => {
        const used = state.catalog.books.filter((b) => b.categories?.includes(c.id)).length;
        if (used && !(await confirmDlg(`« ${c.name} » est utilisée par ${used} histoire(s). La supprimer quand même ?`))) return;
        cats.splice(i, 1);
        state.catalog.books.forEach((b) => { b.categories = (b.categories ?? []).filter((x) => x !== c.id); });
        saveCatalog(); renderCats();
      }));
    ul.append(li);
  });
  icons();
}

function addCat() {
  const input = $('#new-cat');
  const name = input.value.trim();
  if (!name) return;
  let id = slug(name) || `cat-${Date.now().toString(36)}`;
  while (state.catalog.categories.some((c) => c.id === id)) id += '-2';
  state.catalog.categories.push({ id, name });
  input.value = '';
  saveCatalog(); renderCats();
}

// ───────────── Dialogues ─────────────
function confirmDlg(text) {
  const d = $('#dlg-confirm');
  $('#confirm-text').textContent = text;
  d.returnValue = '';
  d.showModal();
  return new Promise((res) => d.addEventListener('close', () => { const ok = d.returnValue === 'ok'; d.returnValue = ''; res(ok); }, { once: true }));
}

function openSettings() {
  const c = state.cfg ?? { ...DEFAULTS, token: '' };
  $('#s-token').value = c.token; $('#s-repo').value = c.repo; $('#s-branch').value = c.branch; $('#s-path').value = c.path;
  $('#dlg-settings').showModal();
}

// Repli « clic à l'extérieur » pour les navigateurs sans closedby
if (!('closedBy' in HTMLDialogElement.prototype)) {
  for (const d of document.querySelectorAll('dialog[closedby="any"]')) {
    d.addEventListener('click', (e) => {
      if (e.target !== d) return;
      const r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
  }
}

// ───────────── Événements ─────────────
$('#btn-settings').addEventListener('click', openSettings);
$('#dlg-settings').addEventListener('close', () => {
  const d = $('#dlg-settings');
  if (d.returnValue === 'save' && $('#s-token').value.trim()) {
    state.cfg = { token: $('#s-token').value.trim(), repo: $('#s-repo').value.trim(), branch: $('#s-branch').value.trim(), path: $('#s-path').value.trim() };
    saveCfg(state.cfg, $('#s-remember').checked);
    loadCatalog();
  }
  d.returnValue = '';
});
$('#btn-publish').addEventListener('click', publish);
$('#btn-new-book').addEventListener('click', () => openBook(null));
$('#btn-back').addEventListener('click', () => showView('list'));
$('#btn-categories').addEventListener('click', () => { renderCats(); $('#dlg-cats').showModal(); });
$('#btn-add-cat').addEventListener('click', addCat);
$('#new-cat').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addCat(); } });
$('#dlg-cats').addEventListener('close', () => { if (!$('#view-book').hidden) renderCatChecks([...document.querySelectorAll('input[name=categories]:checked')].map((c) => c.value)); renderList(); });
$('#book-form').addEventListener('submit', saveBook);
$('#btn-delete-book').addEventListener('click', deleteBook);
$('#f-title').addEventListener('input', () => { if (!state.bookId) $('#f-id').value = slug($('#f-title').value); });
$('#cover-file').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  state.draftCover = await toWebp(f, { cover: true });
  setCoverPreview(URL.createObjectURL(state.draftCover));
  e.target.value = '';
});
$('#btn-new-chapter').addEventListener('click', () => openChapter(null));
$('#c-image').addEventListener('change', async (e) => { const f = e.target.files[0]; if (f) await insertImage(f); e.target.value = ''; });
$('#c-editor').addEventListener('input', () => { if (state.chapter) state.chapter.dirty = true; });
// coller du texte : un paragraphe par ligne, sans la mise en forme de la source
$('#c-editor').addEventListener('paste', (e) => {
  if (e.target.closest?.('.cap')) return;
  e.preventDefault();
  const lines = (e.clipboardData.getData('text/plain') || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length <= 1) document.execCommand('insertText', false, lines[0] ?? '');
  else document.execCommand('insertHTML', false, lines.map((l) => `<p>${toHtml(l)}</p>`).join(''));
});
document.querySelectorAll('[data-ed]').forEach((b) => {
  b.addEventListener('mousedown', (e) => e.preventDefault()); // garde le curseur dans le texte
  b.addEventListener('click', () => edCommand(b.dataset.ed));
});
document.execCommand('defaultParagraphSeparator', false, 'p');
$('#c-title').addEventListener('input', () => { if (state.chapter) state.chapter.dirty = true; });
// Échap / Annuler : on confirme si le chapitre a été modifié
$('#dlg-chapter').addEventListener('cancel', (e) => {
  if (state.chapter?.dirty && !window.confirm('Abandonner les modifications de ce chapitre ?')) e.preventDefault();
});
$('#dlg-chapter').addEventListener('close', () => {
  const d = $('#dlg-chapter');
  if (d.returnValue === 'save' && state.chapter) saveChapter();
  else if (d.returnValue === 'cancel' && state.chapter?.dirty && !window.confirm('Abandonner les modifications de ce chapitre ?')) { d.returnValue = ''; d.showModal(); return; }
  d.returnValue = '';
});
window.addEventListener('beforeunload', (e) => { if (state.pending.size || state.deletes.size || state.deletePrefixes.size) e.preventDefault(); });

// ───────────── Démarrage ─────────────
icons();
document.addEventListener('DOMContentLoaded', icons);
window.addEventListener('load', icons);
state.cfg = loadCfg();
if (state.cfg) loadCatalog(); else { setStatus('Connecte-toi à GitHub pour commencer.'); openSettings(); }
