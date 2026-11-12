'use strict';
/* =========================================================
   Notes — éditeur texte + dessin (style Notes iOS, mode sombre)
   ========================================================= */

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const NOTES_KEY = 'aura_notes_v1';
const TOOLS_KEY = 'aura_tools_v1';

const body = document.body;
const app = $('#app');
const noteEl = $('#note');
const editor = $('#editor');
const page = $('#page');
const scroller = $('#noteScroll');
const ink = $('#ink');
const live = $('#live');
const ictx = ink.getContext('2d');
const lctx = live.getContext('2d');

function load(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function esc(s) { return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

let notes = load(NOTES_KEY, []);
let current = null;
let mode = 'view';          // 'view' | 'edit' | 'draw'
let strokes = [];
let undoStack = [], redoStack = [];

function persist() {
  try { localStorage.setItem(NOTES_KEY, JSON.stringify(notes)); }
  catch { toast('Stockage plein'); }
}

let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 1600);
}

/* ---------------- Clavier virtuel (iOS) ---------------- */
function onViewport() {
  const vv = window.visualViewport; if (!vv) return;
  app.style.height = vv.height + 'px';
  app.style.transform = `translateY(${vv.offsetTop}px)`;
  body.classList.toggle('kb-open', window.innerHeight - vv.height > 120);
}
if (window.visualViewport) {
  visualViewport.addEventListener('resize', onViewport);
  visualViewport.addEventListener('scroll', onViewport);
}

/* Les boutons d'outils ne doivent pas faire perdre le focus à l'éditeur */
document.addEventListener('mousedown', e => {
  if (e.target.closest('.keepfocus')) e.preventDefault();
}, true);

/* =========================================================
   LISTE
   ========================================================= */
function parseHTML(html) { return new DOMParser().parseFromString(html || '', 'text/html').body; }

function noteInfo(n) {
  const b = parseHTML(n.html);
  const lines = [];
  for (const node of b.childNodes) {
    if (node.nodeName === 'UL' || node.nodeName === 'OL' || node.nodeName === 'TABLE') {
      for (const li of node.querySelectorAll('li,td')) { const t = li.textContent.replace(/\s+/g, ' ').trim(); if (t) lines.push(t); }
      continue;
    }
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (t) lines.push(t);
  }
  const hasMedia = (n.strokes && n.strokes.length) || b.querySelector('img');
  return {
    title: lines[0] || (hasMedia ? 'Note manuscrite' : 'Nouvelle note'),
    preview: lines[1] || 'Pas de texte supplémentaire',
    text: lines.join(' ')
  };
}

const sod = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
const dayDiff = ts => Math.round((sod(new Date()) - sod(new Date(ts))) / 864e5);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

function groupLabel(ts) {
  const d = new Date(ts), diff = dayDiff(ts);
  if (diff < 1) return 'Aujourd’hui';
  if (diff < 2) return 'Hier';
  if (diff < 7) return '7 jours précédents';
  if (diff < 30) return '30 jours précédents';
  if (d.getFullYear() === new Date().getFullYear()) return cap(d.toLocaleDateString('fr-FR', { month: 'long' }));
  return String(d.getFullYear());
}
function rowDate(ts) {
  const d = new Date(ts), diff = dayDiff(ts);
  if (diff < 1) return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  if (diff < 2) return 'Hier';
  if (diff < 7) return d.toLocaleDateString('fr-FR', { weekday: 'long' });
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const TRASH = '<svg class="ico" viewBox="0 0 24 24"><path d="M4 6.5h16M9.5 6.5V4.6c0-.6.5-1.1 1.1-1.1h2.8c.6 0 1.1.5 1.1 1.1v1.9M6.2 6.5l.9 12.6c.1 1 .9 1.9 2 1.9h5.8c1.1 0 1.9-.9 2-1.9l.9-12.6M10 10.5v6.5M14 10.5v6.5"/></svg>';

function renderList() {
  const q = $('#search').value.trim().toLowerCase();
  const sorted = [...notes].sort((a, b) => b.updated - a.updated);
  const items = sorted.map(n => ({ n, info: noteInfo(n) }))
    .filter(x => !q || (x.info.text + ' ' + x.info.title).toLowerCase().includes(q));
  $('#count').textContent = notes.length === 1 ? '1 note' : `${notes.length} notes`;
  const groups = $('#groups');
  if (!items.length) {
    groups.innerHTML = `<div class="empty">${q ? 'Aucun résultat' : 'Aucune note'}</div>`;
    return;
  }
  let html = '', last = null;
  for (const { n, info } of items) {
    const g = groupLabel(n.updated);
    if (g !== last) { if (last !== null) html += '</div>'; html += `<div class="group-title">${g}</div><div class="card">`; last = g; }
    html += `<div class="row-wrap"><button class="row-del" data-del="${n.id}" aria-label="Supprimer">${TRASH}</button>
      <div class="row" data-id="${n.id}"><div class="r-title">${esc(info.title)}</div>
      <div class="r-sub"><span class="r-date">${rowDate(n.updated)}</span>${esc(info.preview)}</div></div></div>`;
  }
  html += '</div>';
  groups.innerHTML = html;
}

$('#search').addEventListener('input', renderList);

/* Swipe-to-delete + tap */
(() => {
  let row = null, sx = 0, sy = 0, dx = 0, swiping = false, openRow = null, startOpen = false;
  const groups = $('#groups');
  groups.addEventListener('pointerdown', e => {
    const r = e.target.closest('.row'); if (!r) return;
    row = r; sx = e.clientX; sy = e.clientY; dx = 0; swiping = false; startOpen = r === openRow;
    if (openRow && openRow !== r) { openRow.style.transform = ''; openRow = null; }
  });
  groups.addEventListener('pointermove', e => {
    if (!row) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!swiping && Math.abs(mx) > 8 && Math.abs(mx) > Math.abs(my)) { swiping = true; row.style.transition = 'none'; row.setPointerCapture(e.pointerId); }
    if (swiping) { dx = Math.min(0, mx + (startOpen ? -84 : 0)); row.style.transform = `translateX(${dx}px)`; }
  });
  const end = () => {
    if (!row) return;
    row.style.transition = '';
    if (swiping) {
      if (dx < -50) { row.style.transform = 'translateX(-84px)'; openRow = row; }
      else { row.style.transform = ''; openRow = null; }
    }
    row = null;
  };
  groups.addEventListener('pointerup', end);
  groups.addEventListener('pointercancel', end);
  groups.addEventListener('click', e => {
    const del = e.target.closest('[data-del]');
    if (del) { notes = notes.filter(n => n.id !== del.dataset.del); persist(); openRow = null; renderList(); return; }
    const r = e.target.closest('.row');
    if (!r || swiping) return;
    if (openRow) { openRow.style.transform = ''; openRow = null; return; }
    openNote(r.dataset.id, false);
  });
})();

$('#newNoteList').addEventListener('click', () => newNote());

/* =========================================================
   NOTE : ouverture / fermeture / sauvegarde
   ========================================================= */
function newNote() {
  if (current) leaveCurrent();
  const n = { id: uid(), html: '<div><br></div>', strokes: [], created: Date.now(), updated: Date.now() };
  notes.unshift(n);
  openNote(n.id, true);
}

function openNote(id, focus) {
  current = notes.find(n => n.id === id);
  if (!current) return;
  editor.innerHTML = current.html || '<div><br></div>';
  ensureStructure();
  linkify();
  current.html = editor.innerHTML;          // pas de changement de date pour une simple normalisation
  strokes = current.strokes || [];
  undoStack = []; redoStack = [];
  setMode('view');
  body.classList.add('in-note');
  $('#list').inert = true; noteEl.inert = false;
  if (document.activeElement === $('#search')) $('#search').blur();
  scroller.scrollTop = 0;
  sizeCanvas(true);
  if (focus) {
    editor.focus();
    caretTo(editor.firstChild, false);
  }
}

function isEmptyNote() {
  return !editor.textContent.trim() && !editor.querySelector('img,table') && !strokes.length;
}

function leaveCurrent() {
  saveNow();
  if (current && isEmptyNote()) notes = notes.filter(n => n !== current);
  persist();
  current = null;
}

function closeNote() {
  if (mode === 'edit') editor.blur();
  leaveCurrent();
  showList();
}
function showList() {
  setMode('view');
  body.classList.remove('in-note');
  noteEl.inert = true; $('#list').inert = false;
  renderList();
}

let saveT;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(saveNow, 350); }
function saveNow() {
  clearTimeout(saveT);
  if (!current) return;
  const html = editor.innerHTML;
  if (html !== current.html || strokes !== current.strokes) {
    current.html = html; current.strokes = strokes; current.updated = Date.now();
    persist();
  }
}
window.addEventListener('pagehide', saveNow);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });

/* =========================================================
   MODES
   ========================================================= */
function setMode(m) {
  mode = m;
  noteEl.classList.toggle('viewing', m === 'view');
  noteEl.classList.toggle('editing', m === 'edit');
  noteEl.classList.toggle('drawing', m === 'draw');
  editor.contentEditable = m === 'draw' ? 'false' : 'true';
  closePops();
}

editor.addEventListener('focus', () => { if (mode !== 'draw') setMode('edit'); });
editor.addEventListener('blur', () => {
  setTimeout(() => {
    if (document.activeElement === editor || mode !== 'edit') return;
    setMode('view');
    linkify();
    scheduleSave();
  }, 0);
});

$('#back').addEventListener('click', closeNote);
$('#done').addEventListener('click', () => {
  if (mode === 'draw') { setMode('view'); saveNow(); }
  else if (mode === 'edit') { editor.blur(); }
});
$('#share').addEventListener('click', shareNote);

async function shareNote() {
  const info = noteInfo({ html: editor.innerHTML, strokes });
  const text = [...editor.childNodes].map(n => n.textContent).join('\n');
  try {
    if (navigator.share) await navigator.share({ title: info.title, text });
    else { await navigator.clipboard.writeText(text); toast('Copié dans le presse-papiers'); }
  } catch { /* annulé */ }
}

/* Actions des barres */
function act(name) {
  switch (name) {
    case 'checklist': toggleChecklist(); break;
    case 'attach': pickImage(); break;
    case 'markup': enterDraw(); break;
    case 'new': newNote(); break;
    case 'table': insertTable(); break;
    case 'format': togglePop($('#fmtPop')); refreshFmtState(); break;
    case 'hidekb': editor.blur(); break;
  }
}
$$('[data-act]').forEach(b => b.addEventListener('click', () => act(b.dataset.act)));

function enterDraw() {
  if (mode === 'edit') editor.blur();
  setMode('draw');
  sizeCanvas(true);
  updatePalette();
}

/* =========================================================
   ÉDITEUR TEXTE
   ========================================================= */
try { document.execCommand('defaultParagraphSeparator', false, 'div'); } catch { }

function caretTo(node, atEnd = true) {
  if (!node) return;
  const r = document.createRange();
  r.selectNodeContents(node);
  r.collapse(!atEnd);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}

const INLINE = /^(#text|SPAN|A|B|I|U|S|STRIKE|STRONG|EM|BR|FONT|CODE|SUB|SUP|MARK|IMG)$/;
function ensureStructure() {
  const s = getSelection();
  const anchor = s.rangeCount ? [s.anchorNode, s.anchorOffset] : null;
  let group = null, changed = false;
  for (const n of [...editor.childNodes]) {
    if (n.nodeType === 8) { n.remove(); continue; }
    if (INLINE.test(n.nodeName)) {
      if (!group) { group = document.createElement('div'); editor.insertBefore(group, n); }
      group.appendChild(n); changed = true;
    } else group = null;
  }
  if (!editor.firstChild) {
    editor.innerHTML = '<div><br></div>';
    if (document.activeElement === editor) caretTo(editor.firstChild, false);
    return;
  }
  if (changed && anchor && editor.contains(anchor[0])) { try { s.collapse(anchor[0], anchor[1]); } catch { } }
}

function currentBlock() {
  const s = getSelection();
  if (!s.rangeCount) return null;
  let n = s.anchorNode;
  if (!editor.contains(n)) return null;
  if (n === editor) n = editor.childNodes[s.anchorOffset] || editor.lastChild;
  const li = n && (n.nodeType === 1 ? n : n.parentElement)?.closest('li');
  if (li && editor.contains(li)) return li;
  while (n && n.parentNode !== editor) n = n.parentNode;
  return n;
}

let sizeRaf = 0;
editor.addEventListener('input', () => {
  ensureStructure();
  scheduleSave();
  cancelAnimationFrame(sizeRaf);
  sizeRaf = requestAnimationFrame(() => sizeCanvas(false));
});

/* Entrée dans une checklist */
editor.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
  const b = currentBlock();
  if (b && b.classList && b.classList.contains('cl')) {
    if (!b.textContent.trim()) {
      e.preventDefault();
      b.classList.remove('cl', 'checked');
      return;
    }
    setTimeout(() => {
      const nb = currentBlock();
      if (nb && nb !== b && nb.classList) { nb.classList.add('cl'); nb.classList.remove('checked'); }
    }, 0);
  } else {
    setTimeout(() => {
      const nb = currentBlock();
      if (nb && nb !== b && nb.classList && !nb.textContent.trim()) nb.classList.remove('cl', 'checked');
    }, 0);
  }
});

/* Collage : texte brut */
editor.addEventListener('paste', e => {
  const text = e.clipboardData && e.clipboardData.getData('text/plain');
  if (text == null) return;
  e.preventDefault();
  const html = text.split(/\r?\n/).map(l => esc(l)).join('<br>');
  document.execCommand('insertHTML', false, html);
});

/* Cases à cocher */
function checkTap(e) {
  const pt = e.touches ? e.touches[0] : e;
  const b = e.target.closest && e.target.closest('.cl');
  if (!b || !editor.contains(b) || mode === 'draw') return;
  const r = b.getBoundingClientRect();
  if (pt.clientX - r.left < 32) {
    e.preventDefault();
    b.classList.toggle('checked');
    scheduleSave();
    return true;
  }
}
editor.addEventListener('mousedown', checkTap);
editor.addEventListener('touchstart', checkTap, { passive: false });

/* Liens (en lecture) */
function openLink(href) { window.open(href, '_blank', 'noopener'); }
let tStart = null;
editor.addEventListener('touchstart', e => { const t = e.touches[0]; tStart = { x: t.clientX, y: t.clientY }; }, { passive: true });
editor.addEventListener('touchend', e => {
  if (mode !== 'view' || !tStart) return;
  const t = e.changedTouches[0];
  if (Math.hypot(t.clientX - tStart.x, t.clientY - tStart.y) > 10) return;
  const a = e.target.closest('a');
  if (a) { e.preventDefault(); openLink(a.href); }
});
editor.addEventListener('mousedown', e => {
  if (mode === 'view' && e.button === 0 && e.target.closest('a')) e.preventDefault();
});
editor.addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (mode === 'view') openLink(a.href);
});

/* Toucher sous le texte → éditer à la fin */
page.addEventListener('mousedown', e => {
  if (e.target === page && mode !== 'draw') {
    e.preventDefault();
    editor.focus(); caretTo(editor.lastChild, true);
  }
});

/* Détection de liens / numéros (style « data detectors ») */
const DETECT = /(https?:\/\/[^\s<]*[^\s<.,;:!?'")\]]|www\.[^\s<]*[^\s<.,;:!?'")\]])|(\+?\d[\d .\-]{4,}\d)/gi;
function linkify() {
  editor.querySelectorAll('span.dd').forEach(s => s.replaceWith(document.createTextNode(s.textContent)));
  editor.normalize();
  const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, {
    acceptNode: n => n.parentElement.closest('a,pre') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  const nodes = []; while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const text = node.nodeValue;
    DETECT.lastIndex = 0;
    let m, last = 0, frag = null;
    while ((m = DETECT.exec(text))) {
      if (m[2] && m[2].replace(/\D/g, '').length < 6) continue;
      frag = frag || document.createDocumentFragment();
      frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      let el;
      if (m[1]) { el = document.createElement('a'); el.href = m[1].startsWith('www.') ? 'https://' + m[1] : m[1]; }
      else { el = document.createElement('span'); el.className = 'dd'; }
      el.textContent = m[0];
      frag.appendChild(el);
      last = m.index + m[0].length;
    }
    if (frag) { frag.appendChild(document.createTextNode(text.slice(last))); node.replaceWith(frag); }
  }
}

/* Checklist */
function toggleChecklist() {
  if (mode !== 'edit') {
    const last = editor.lastElementChild;
    let target;
    if (last && editor.children.length > 1 && !last.textContent.trim() && !last.querySelector('img,table') && last.nodeName === 'DIV') {
      target = last;
    } else {
      target = document.createElement('div'); target.innerHTML = '<br>'; editor.appendChild(target);
    }
    target.className = 'cl';
    editor.focus(); caretTo(target, true);
    scheduleSave();
    return;
  }
  const b = currentBlock();
  if (!b || !b.classList) return;
  if (b.nodeName === 'LI') return;
  b.classList.toggle('cl'); b.classList.remove('checked');
  scheduleSave();
}

/* Tableau */
function insertTable() {
  if (mode !== 'edit') { editor.focus(); caretTo(editor.lastChild, true); }
  document.execCommand('insertHTML', false,
    '<table class="nt"><tbody><tr><td><br></td><td><br></td></tr><tr><td><br></td><td><br></td></tr></tbody></table><div><br></div>');
  scheduleSave();
}

/* Image */
let savedRange = null;
function pickImage() {
  const s = getSelection();
  savedRange = (mode === 'edit' && s.rangeCount) ? s.getRangeAt(0).cloneRange() : null;
  $('#fileInput').value = '';
  $('#fileInput').click();
}
$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  const url = await downscale(f, 1400);
  editor.focus();
  if (savedRange && editor.contains(savedRange.startContainer)) { const s = getSelection(); s.removeAllRanges(); s.addRange(savedRange); }
  else caretTo(editor.lastChild, true);
  document.execCommand('insertHTML', false, `<div><img src="${url}"></div><div><br></div>`);
  scheduleSave();
  setTimeout(() => sizeCanvas(false), 100);
});
function downscale(file, max) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      res(c.toDataURL('image/jpeg', .85));
      URL.revokeObjectURL(img.src);
    };
    img.src = URL.createObjectURL(file);
  });
}

/* Panneau Format */
const FMT = {
  title: () => document.execCommand('formatBlock', false, '<h1>'),
  heading: () => document.execCommand('formatBlock', false, '<h2>'),
  sub: () => document.execCommand('formatBlock', false, '<h3>'),
  body: () => document.execCommand('formatBlock', false, '<div>'),
  mono: () => document.execCommand('formatBlock', false, '<pre>'),
  bold: () => document.execCommand('bold'),
  italic: () => document.execCommand('italic'),
  underline: () => document.execCommand('underline'),
  strike: () => document.execCommand('strikeThrough'),
  ul: () => { document.execCommand('insertUnorderedList'); const l = currentBlock()?.closest?.('ul'); l && l.classList.remove('dash'); },
  dash: () => {
    const b = currentBlock(); const inUl = b && b.closest && b.closest('ul');
    if (!inUl) document.execCommand('insertUnorderedList');
    const l = currentBlock()?.closest?.('ul'); l && l.classList.toggle('dash', !(inUl && inUl.classList.contains('dash')));
    if (inUl && !l?.classList.contains('dash')) document.execCommand('insertUnorderedList');
  },
  ol: () => document.execCommand('insertOrderedList'),
  indent: () => document.execCommand('indent'),
  outdent: () => document.execCommand('outdent'),
  close: () => closePops(),
};
$$('#fmtPop [data-f]').forEach(b => b.addEventListener('click', () => {
  if (mode !== 'edit') { editor.focus(); }
  FMT[b.dataset.f]();
  ensureStructure();
  scheduleSave();
  refreshFmtState();
}));
function refreshFmtState() {
  const b = currentBlock();
  const tag = b && b.nodeName;
  const isFirst = b && b === editor.firstChild;
  const map = { title: tag === 'H1' || (isFirst && tag === 'DIV'), heading: tag === 'H2', sub: tag === 'H3', body: tag === 'DIV' && !isFirst, mono: tag === 'PRE' };
  $$('#fmtPop .fmt-styles [data-f]').forEach(x => x.classList.toggle('on', !!map[x.dataset.f]));
  const q = c => { try { return document.queryCommandState(c); } catch { return false; } };
  const st = { bold: q('bold'), italic: q('italic'), underline: q('underline'), strike: q('strikeThrough'), ol: q('insertOrderedList') };
  const ul = b && b.closest && b.closest('ul');
  st.ul = !!ul && !ul.classList.contains('dash'); st.dash = !!ul && ul.classList.contains('dash');
  $$('#fmtPop .seg [data-f]').forEach(x => x.classList.toggle('on', !!st[x.dataset.f]));
}
document.addEventListener('selectionchange', () => { if ($('#fmtPop').classList.contains('open')) refreshFmtState(); });

/* =========================================================
   POPOVERS / MENUS
   ========================================================= */
function closePops(except) {
  $$('.pop.open, .menu.open').forEach(p => { if (p !== except) p.classList.remove('open'); });
}
function togglePop(p) { const o = p.classList.contains('open'); closePops(); if (!o) p.classList.add('open'); }

document.addEventListener('pointerdown', e => {
  if (e.target.closest('.pop, .menu, [data-act="format"], .tool, #colorWheel, #plusBtn, .more')) return;
  closePops();
}, true);

function showMenu(items, anchorBottom) {
  const m = $('#menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.appendChild(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    if (it.danger) b.className = 'danger';
    b.disabled = !!it.disabled;
    b.innerHTML = `<span>${it.label}</span>${it.icon || ''}`;
    b.addEventListener('click', () => { closePops(); it.run(); });
    m.appendChild(b);
  }
  if (anchorBottom) { m.style.top = 'auto'; m.style.bottom = anchorBottom; m.style.transformOrigin = '100% 100%'; }
  else { m.style.top = ''; m.style.bottom = ''; m.style.transformOrigin = ''; }
  togglePop(m);
}

const IC = {
  undo: '<svg class="ico sm" viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
  redo: '<svg class="ico sm" viewBox="0 0 24 24"><path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/></svg>',
  share: '<svg class="ico sm" viewBox="0 0 24 24"><path d="M12 14.6V3M7.9 7.1 12 3l4.1 4.1"/><path d="M8.8 9.6H7.6a2.4 2.4 0 0 0-2.4 2.4v7.2a2.4 2.4 0 0 0 2.4 2.4h8.8a2.4 2.4 0 0 0 2.4-2.4V12a2.4 2.4 0 0 0-2.4-2.4h-1.2"/></svg>',
  trash: TRASH.replace('class="ico"', 'class="ico sm"'),
  clear: '<svg class="ico sm" viewBox="0 0 24 24"><path d="M7 21h12M5.6 15.6l7.8-10.2a2 2 0 0 1 2.8-.4l2.4 1.8a2 2 0 0 1 .4 2.8L12 19.8H8.2z"/></svg>',
};

function noteMenu() {
  const items = [];
  if (mode === 'edit') {
    items.push({ label: 'Annuler', icon: IC.undo, run: () => document.execCommand('undo') });
    items.push({ label: 'Rétablir', icon: IC.redo, run: () => document.execCommand('redo') });
  } else {
    items.push({ label: 'Annuler', icon: IC.undo, disabled: !undoStack.length, run: undo });
    items.push({ label: 'Rétablir', icon: IC.redo, disabled: !redoStack.length, run: redo });
  }
  if (mode === 'draw') items.push({ label: 'Partager', icon: IC.share, run: shareNote });
  items.push('-');
  items.push({ label: 'Effacer le dessin', icon: IC.clear, disabled: !strokes.length, run: clearDrawing });
  items.push({ label: 'Supprimer', icon: IC.trash, danger: true, run: deleteCurrent });
  showMenu(items);
}
$$('.more').forEach(b => b.addEventListener('click', noteMenu));

function deleteCurrent() {
  if (!current) return;
  const id = current.id;
  if (mode === 'edit') editor.blur();
  notes = notes.filter(n => n.id !== id);
  current = null; persist();
  showList();
  toast('Note supprimée');
}

/* =========================================================
   DESSIN
   ========================================================= */
const DEFAULT_TOOLS = {
  pen:    { color: '#FFFFFF', width: 3,   opacity: 1 },
  mono:   { color: '#FFFFFF', width: 1.6, opacity: 1 },
  marker: { color: '#E8B21F', width: 16,  opacity: .8 },
  eraser: { mode: 'object', width: 20 },
  pencil: { color: '#FFFFFF', width: 3,   opacity: 1 },
};
const WIDTHS = {
  pen: [1.5, 2.2, 3, 4.5, 7], mono: [.8, 1.2, 1.6, 2.4, 3.5], marker: [8, 12, 16, 24, 34],
  pencil: [1.5, 2.2, 3, 4.5, 7], eraser: [8, 14, 20, 32, 48],
};
const saved = load(TOOLS_KEY, {});
const tools = {};
for (const k in DEFAULT_TOOLS) tools[k] = { ...DEFAULT_TOOLS[k], ...(saved.tools && saved.tools[k]) };
let tool = saved.tool && tools[saved.tool] ? saved.tool : 'pen';
let lastInk = saved.lastInk || 'pen';
let recent = saved.recent || [];
function saveTools() { localStorage.setItem(TOOLS_KEY, JSON.stringify({ tools, tool, lastInk, recent })); }

let dpr = 1, cw = 0, ch = 0;
function maxStrokeY() {
  let m = 0;
  for (const s of strokes) { const b = s.b || (s.b = bbox(s.p)); if (b[3] > m) m = b[3]; }
  return m;
}
function sizeCanvas(force) {
  const w = page.clientWidth || window.innerWidth;
  page.style.minHeight = '';
  const need = Math.ceil(Math.max(editor.offsetHeight, scroller.clientHeight, maxStrokeY() + scroller.clientHeight * .6));
  if (!force && w === cw && Math.abs(need - ch) < 2) return;
  cw = w; ch = need;
  page.style.minHeight = ch + 'px';
  const base = window.devicePixelRatio || 1;
  dpr = Math.min(base, Math.sqrt(16e6 / (cw * ch)));
  for (const c of [ink, live]) {
    c.style.width = cw + 'px'; c.style.height = ch + 'px';
    c.width = Math.round(cw * dpr); c.height = Math.round(ch * dpr);
  }
  redraw();
}
window.addEventListener('resize', () => { if (current) sizeCanvas(false); });

function redraw() {
  ictx.setTransform(1, 0, 0, 1, 0, 0);
  ictx.clearRect(0, 0, ink.width, ink.height);
  ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
  for (const s of strokes) drawStroke(ictx, s);
}

function bbox(p) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (let i = 0; i < p.length; i += 2) { a = Math.min(a, p[i]); c = Math.max(c, p[i]); b = Math.min(b, p[i + 1]); d = Math.max(d, p[i + 1]); }
  return [a, b, c, d];
}
function buildPath(ctx, p) {
  ctx.beginPath();
  const n = p.length / 2;
  ctx.moveTo(p[0], p[1]);
  if (n === 1) { ctx.lineTo(p[0] + .01, p[1] + .01); return; }
  for (let i = 1; i < n - 1; i++) {
    const x = p[2 * i], y = p[2 * i + 1];
    ctx.quadraticCurveTo(x, y, (x + p[2 * i + 2]) / 2, (y + p[2 * i + 3]) / 2);
  }
  ctx.lineTo(p[2 * n - 2], p[2 * n - 1]);
}
function rng(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

function drawStroke(ctx, s) {
  const p = s.p;
  ctx.save();
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  if (s.t === 'erase') {
    ctx.globalCompositeOperation = 'destination-out';
    ctx.strokeStyle = '#000'; ctx.lineWidth = s.w;
    buildPath(ctx, p); ctx.stroke();
  } else if (s.t === 'pencil') {
    const r = rng(s.seed || 1);
    ctx.strokeStyle = s.c;
    ctx.globalAlpha = s.o * .5; ctx.lineWidth = s.w; buildPath(ctx, p); ctx.stroke();
    ctx.lineWidth = Math.max(.6, s.w * .45);
    for (let k = 0; k < 3; k++) {
      ctx.globalAlpha = s.o * (.35 + r() * .2);
      const q = p.map(v => v + (r() - .5) * s.w * .7);
      buildPath(ctx, q); ctx.stroke();
    }
  } else {
    ctx.strokeStyle = s.c; ctx.globalAlpha = s.o; ctx.lineWidth = s.w;
    buildPath(ctx, p); ctx.stroke();
  }
  ctx.restore();
}

/* Undo / redo (instantanés de la liste de traits) */
function commit(next, prev = strokes) {
  undoStack.push(prev); if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
  strokes = next;
  scheduleSave();
}
function undo() { if (!undoStack.length) return; redoStack.push(strokes); strokes = undoStack.pop(); redraw(); scheduleSave(); }
function redo() { if (!redoStack.length) return; undoStack.push(strokes); strokes = redoStack.pop(); redraw(); scheduleSave(); }
function clearDrawing() { if (!strokes.length) return; commit([]); redraw(); }

document.addEventListener('keydown', e => {
  if (mode !== 'draw') return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
});

/* Pointeurs */
const pointers = new Map();
let cur = null, panY = null, liveRaf = 0;
const r1 = v => Math.round(v * 10) / 10;
function pagePt(e) { const r = page.getBoundingClientRect(); return [r1(e.clientX - r.left), r1(e.clientY - r.top)]; }
const avgY = () => { let s = 0; for (const p of pointers.values()) s += p.y; return s / pointers.size; };

live.addEventListener('pointerdown', e => {
  if (mode !== 'draw') return;
  e.preventDefault();
  closePops();
  live.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2) { cancelStroke(); panY = avgY(); return; }
  startStroke(e);
});
live.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size >= 2) {
    const y = avgY(); scroller.scrollTop -= (y - panY); panY = y; return;
  }
  if (!cur || cur.id !== e.pointerId) return;
  const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ev of (evs.length ? evs : [e])) moveStroke(pagePt(ev));
});
function pointerEnd(e) {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (cur && cur.id === e.pointerId) endStroke();
  if (pointers.size < 2) panY = null;
}
live.addEventListener('pointerup', pointerEnd);
live.addEventListener('pointercancel', e => { if (cur && cur.id === e.pointerId) cancelStroke(); pointerEnd(e); });

function startStroke(e) {
  const [x, y] = pagePt(e);
  const T = tools[tool];
  if (tool === 'eraser') {
    if (T.mode === 'object') { cur = { id: e.pointerId, kind: 'obj', snap: strokes, last: [x, y] }; eraseObj(x, y, x, y); }
    else { cur = { id: e.pointerId, kind: 'pix', s: { t: 'erase', w: T.width, p: [x, y] } }; pixSeg(x, y, x, y); }
    return;
  }
  cur = { id: e.pointerId, kind: 'ink', s: { t: tool, c: T.color, o: T.opacity, w: T.width, p: [x, y], seed: (Math.random() * 1e9) | 0 } };
  scheduleLive();
}
function moveStroke([x, y]) {
  if (!cur) return;
  if (cur.kind === 'obj') { const [lx, ly] = cur.last; eraseObj(lx, ly, x, y); cur.last = [x, y]; return; }
  const p = cur.s.p, lx = p[p.length - 2], ly = p[p.length - 1];
  if (Math.hypot(x - lx, y - ly) < .6) return;
  p.push(x, y);
  if (cur.kind === 'pix') pixSeg(lx, ly, x, y);
  else scheduleLive();
}
function scheduleLive() {
  if (liveRaf) return;
  liveRaf = requestAnimationFrame(() => {
    liveRaf = 0;
    lctx.setTransform(1, 0, 0, 1, 0, 0);
    lctx.clearRect(0, 0, live.width, live.height);
    if (cur && cur.kind === 'ink') { lctx.setTransform(dpr, 0, 0, dpr, 0, 0); drawStroke(lctx, cur.s); }
  });
}
function clearLive() { lctx.setTransform(1, 0, 0, 1, 0, 0); lctx.clearRect(0, 0, live.width, live.height); }
function endStroke() {
  const c = cur; cur = null;
  if (c.kind === 'ink') {
    c.s.b = bbox(c.s.p);
    commit([...strokes, c.s]);
    drawStroke(ictx, c.s);
    cancelAnimationFrame(liveRaf); liveRaf = 0; clearLive();
  } else if (c.kind === 'pix') {
    c.s.b = bbox(c.s.p);
    commit([...strokes, c.s]);
  } else if (c.kind === 'obj') {
    if (strokes !== c.snap) { undoStack.push(c.snap); redoStack = []; scheduleSave(); }
  }
  sizeCanvas(false);
}
function cancelStroke() {
  if (!cur) return;
  if (cur.kind === 'obj') strokes = cur.snap;
  cur = null;
  cancelAnimationFrame(liveRaf); liveRaf = 0; clearLive();
  redraw();
}
function pixSeg(x0, y0, x1, y1) {
  ictx.save();
  ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ictx.globalCompositeOperation = 'destination-out';
  ictx.lineCap = 'round'; ictx.lineWidth = tools.eraser.width;
  ictx.beginPath(); ictx.moveTo(x0, y0); ictx.lineTo(x1 + .01, y1); ictx.stroke();
  ictx.restore();
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
  let t = l ? ((px - ax) * dx + (py - ay) * dy) / l : 0; t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function hits(s, x, y, r) {
  const b = s.b || (s.b = bbox(s.p)), pad = r + s.w / 2;
  if (x < b[0] - pad || x > b[2] + pad || y < b[1] - pad || y > b[3] + pad) return false;
  const p = s.p;
  if (p.length === 2) return Math.hypot(p[0] - x, p[1] - y) <= pad;
  for (let i = 0; i < p.length - 2; i += 2) if (segDist(x, y, p[i], p[i + 1], p[i + 2], p[i + 3]) <= pad) return true;
  return false;
}
function eraseObj(x0, y0, x1, y1) {
  const r = tools.eraser.width / 2;
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / (r / 2)));
  let next = strokes;
  for (let i = 0; i <= steps; i++) {
    const x = x0 + (x1 - x0) * i / steps, y = y0 + (y1 - y0) * i / steps;
    const f = next.filter(s => s.t === 'erase' || !hits(s, x, y, r));
    if (f.length !== next.length) next = f;
  }
  if (next !== strokes) { strokes = next; redraw(); }
}

/* Palette */
function updatePalette() {
  $$('.tool').forEach(el => {
    const t = el.dataset.tool, T = tools[t];
    el.classList.toggle('sel', t === tool);
    if (T.color) $$('.tipc, .band', el).forEach(n => n.setAttribute('fill', T.color));
    const l = $('.lbl', el); if (l) l.textContent = T.opacity < 1 ? Math.round(T.opacity * 100) : '';
  });
  $('#cwDot').style.background = (tools[tool].color || tools[lastInk].color);
}

$$('.tool').forEach(el => el.addEventListener('click', () => {
  const t = el.dataset.tool;
  if (t === tool) { const p = $('#toolPop'); if (p.classList.contains('open')) closePops(); else { renderToolPop(); togglePop(p); } return; }
  tool = t; if (t !== 'eraser') lastInk = t;
  closePops(); updatePalette(); saveTools();
}));

function renderToolPop() {
  const p = $('#toolPop'), T = tools[tool];
  const ws = WIDTHS[tool], maxW = ws[ws.length - 1];
  let html = '<div class="tp-widths">' + ws.map(w =>
    `<button data-w="${w}" class="${w === T.width ? 'on' : ''}"><span style="width:${Math.round(4 + (w / maxW) * 18)}px;height:${Math.round(4 + (w / maxW) * 18)}px;${T.color ? `background:${T.color};opacity:${T.opacity}` : ''}"></span></button>`
  ).join('') + '</div>';
  if (tool === 'eraser') {
    html += `<div class="tp-modes">
      <button data-m="pixel" class="${T.mode === 'pixel' ? 'on' : ''}">Gomme pixel <span class="ck">✓</span></button>
      <button data-m="object" class="${T.mode === 'object' ? 'on' : ''}">Gomme objet <span class="ck">✓</span></button></div>`;
  } else {
    html += `<div class="tp-label"><span>Opacité</span><span id="opv">${Math.round(T.opacity * 100)} %</span></div>
      <input type="range" class="op" min="5" max="100" value="${Math.round(T.opacity * 100)}" style="--trk:linear-gradient(90deg,transparent,${T.color})">`;
  }
  p.innerHTML = html;
  $$('[data-w]', p).forEach(b => b.addEventListener('click', () => { T.width = +b.dataset.w; saveTools(); renderToolPop(); }));
  $$('[data-m]', p).forEach(b => b.addEventListener('click', () => { T.mode = b.dataset.m; saveTools(); renderToolPop(); }));
  const r = $('input.op', p);
  if (r) r.addEventListener('input', () => { T.opacity = r.value / 100; $('#opv').textContent = r.value + ' %'; updatePalette(); saveTools(); });
}

/* Sélecteur de couleur (grille) */
function hsl2hex(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = n => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
  return ('#' + f(0) + f(8) + f(4)).toUpperCase();
}
const GRID = (() => {
  const out = [];
  for (let i = 0; i < 12; i++) { const v = Math.round(255 - i * 255 / 11).toString(16).padStart(2, '0'); out.push(('#' + v + v + v).toUpperCase()); }
  const hues = [200, 215, 240, 270, 300, 335, 4, 20, 36, 48, 58, 85];
  const rows = [[100, 16], [100, 24], [95, 32], [90, 40], [90, 48], [95, 56], [95, 64], [95, 73], [90, 82]];
  for (const [s, l] of rows) for (const h of hues) out.push(hsl2hex(h, s, l));
  return out;
})();

function inkTool() { return tool === 'eraser' ? lastInk : tool; }
function renderColorPop() {
  const p = $('#colorPop'), t = inkTool(), T = tools[t];
  p.innerHTML = `<div class="cp-head"><span>Couleurs</span><button class="xbtn" data-x aria-label="Fermer"><svg viewBox="0 0 24 24" width="14" height="14"><path d="M6 6l12 12M18 6 6 18" stroke="#c7c7cc" stroke-width="2.6" stroke-linecap="round"/></svg></button></div>
    <div class="grid">${GRID.map(c => `<button data-c="${c}" style="background:${c}" class="${c === T.color.toUpperCase() ? 'on' : ''}"></button>`).join('')}</div>
    <div class="tp-label"><span>Opacité</span><span id="opv2">${Math.round(T.opacity * 100)} %</span></div>
    <input type="range" class="op" min="5" max="100" value="${Math.round(T.opacity * 100)}" style="--trk:linear-gradient(90deg,transparent,${T.color})">
    ${recent.length ? `<div class="swatches">${recent.map(c => `<button data-c="${c}" style="background:${c}"></button>`).join('')}</div>` : ''}`;
  $('[data-x]', p).addEventListener('click', closePops);
  $$('[data-c]', p).forEach(b => b.addEventListener('click', () => {
    const c = b.dataset.c;
    T.color = c;
    recent = [c, ...recent.filter(x => x !== c)].slice(0, 8);
    if (tool === 'eraser') tool = t;
    saveTools(); updatePalette(); renderColorPop();
  }));
  const r = $('input.op', p);
  r.addEventListener('input', () => { T.opacity = r.value / 100; $('#opv2').textContent = r.value + ' %'; updatePalette(); saveTools(); });
}
$('#colorWheel').addEventListener('click', () => { const p = $('#colorPop'); if (!p.classList.contains('open')) renderColorPop(); togglePop(p); });

$('#plusBtn').addEventListener('click', () => {
  showMenu([
    { label: 'Annuler', icon: IC.undo, disabled: !undoStack.length, run: undo },
    { label: 'Rétablir', icon: IC.redo, disabled: !redoStack.length, run: redo },
    '-',
    { label: 'Effacer le dessin', icon: IC.clear, danger: true, disabled: !strokes.length, run: clearDrawing },
  ], '130px');
});

/* =========================================================
   DÉMARRAGE
   ========================================================= */
noteEl.inert = true;
renderList();
updatePalette();
onViewport();
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => { });
}
