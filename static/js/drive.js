(() => {
  'use strict';

  const $ = (sel, root = document) => root.querySelector(sel);
  const csrf = $('meta[name="csrf"]').content;
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } },
                  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } } };

  const state = {
    view: 'files', folder: null, q: '', sort: store.get('kumo.sort') || 'name',
    mode: store.get('kumo.mode') || 'grid', animate: true, items: [], path: [], usage: { used: 0, quota: 1 },
  };

  /* ---------- helpers ---------- */
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtSize(n) {
    if (n < 1024) return n + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return (n < 10 ? n.toFixed(1) : Math.round(n)) + ' ' + units[i];
  }

  function fmtDate(ts) {
    const d = new Date(ts * 1000), now = new Date();
    if (d.toDateString() === now.toDateString())
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short',
      year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  async function api(method, url, body) {
    const opt = { method, headers: { 'X-CSRF-Token': csrf } };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const res = await fetch(url, opt);
    let data = {};
    try { data = await res.json(); } catch { /* empty body */ }
    if (res.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
    return data;
  }

  function toast(message, opts = {}) {
    const el = document.createElement('div');
    el.className = 'toast' + (opts.error ? ' error' : '');
    el.innerHTML = `<span>${esc(message)}</span>`;
    if (opts.action) {
      const b = document.createElement('button');
      b.textContent = opts.action;
      b.onclick = () => { el.remove(); opts.onAction(); };
      el.appendChild(b);
    }
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), opts.action ? 7000 : 4200);
  }
  const fail = e => toast(e.message, { error: true });

  /* ---------- icons ---------- */
  const ICON = {
    more: '<svg viewBox="0 0 24 24"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
    link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/></svg>',
    grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.5"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.5"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.5"/></svg>',
    list: '<svg viewBox="0 0 24 24"><path d="M4 6h16M4 12h16M4 18h16"/></svg>',
  };

  function thumb(it) {
    if (it.is_folder)
      return '<div class="fold"><span class="fold-back"></span><span class="fold-paper a"></span><span class="fold-paper b"></span><span class="fold-front"></span></div>';
    if (it.kind === 'image' && it.preview === 'image' && !it.deleted)
      return `<img src="/api/items/${it.id}/file?inline=1" alt="" loading="lazy">`;
    const label = (it.ext || 'file').slice(0, 4);
    return `<div class="doc" data-k="${esc(it.kind)}"><b>${esc(label)}</b></div>`;
  }

  /* ---------- routing ---------- */
  function parseHash() {
    const [a, b] = location.hash.replace(/^#\/?/, '').split('/');
    if (a === 'folder' && /^\d+$/.test(b || '')) return { view: 'files', folder: +b };
    if (['recent', 'starred', 'trash'].includes(a)) return { view: a, folder: null };
    return { view: 'files', folder: null };
  }

  async function route() {
    Object.assign(state, parseHash());
    state.q = '';
    state.animate = true;
    $('#q').value = '';
    await load();
  }

  /* ---------- loading & rendering ---------- */
  async function load() {
    const params = new URLSearchParams({ view: state.q ? 'search' : state.view });
    if (state.folder && !state.q) params.set('folder', state.folder);
    if (state.q) params.set('q', state.q);
    try {
      const data = await api('GET', '/api/items?' + params);
      state.items = data.items;
      state.path = data.path;
      state.usage = data.usage;
      render();
    } catch (e) {
      if (/no longer exists/i.test(e.message)) { location.hash = '#/'; return; }
      fail(e);
    }
  }

  function renderMeter() {
    const { used, quota } = state.usage;
    $('#meter-text').textContent = `${fmtSize(used)} of ${fmtSize(quota)} used`;
    $('#meter-bar').style.width = Math.min(100, (used / quota) * 100) + '%';
    $('#meter').classList.toggle('full', used / quota > 0.9);
  }

  function sorted(items) {
    const list = [...items];
    const key = state.sort;
    const cmp = {
      name: (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }),
      updated: (a, b) => b.updated - a.updated,
      size: (a, b) => b.size - a.size,
    }[key];
    list.sort((a, b) => (state.view === 'recent' || state.view === 'trash') && !state.q
      ? 0 : (b.is_folder - a.is_folder) || cmp(a, b));
    return list;
  }

  const EMPTY = {
    files: ['folder', 'This folder is empty', 'Drop files anywhere on the page, or use Upload.'],
    recent: ['upload', 'Nothing recent yet', 'Files you upload will show up here.'],
    starred: ['check', 'No starred items', 'Star the files and folders you open most.'],
    trash: ['lock', 'Trash is empty', 'Deleted items stay here until you remove them for good.'],
    search: ['search', 'No matches', 'Try a different word, or check the spelling.'],
  };

  function emptyIcon(name) {
    const paths = {
      folder: '<path d="M8 20a6 6 0 0 1 6-6h14l6 6h22a6 6 0 0 1 6 6v6H8z" fill="url(#kSolid)"/><rect x="6" y="26" width="58" height="36" rx="10" fill="url(#kFrost)" stroke="rgba(255,255,255,.55)"/>',
      upload: '<circle cx="48" cy="26" r="15" fill="url(#kSolid)"/><path d="M22 56a13 13 0 0 1-2-25.8A17 17 0 0 1 52.5 33 11.5 11.5 0 0 1 52 56z" fill="url(#kFrost)" stroke="rgba(255,255,255,.55)"/>',
      check: '<circle cx="30" cy="42" r="14" fill="url(#kFrost)" stroke="rgba(255,255,255,.55)"/><path d="M16 30l14 14L58 14" fill="none" stroke="url(#kSolid)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>',
      lock: '<path d="M22 32V24a14 14 0 0 1 28 0v8" fill="none" stroke="url(#kSolid)" stroke-width="8" stroke-linecap="round"/><rect x="14" y="31" width="44" height="34" rx="11" fill="url(#kFrost)" stroke="rgba(255,255,255,.55)"/>',
      search: '<circle cx="30" cy="30" r="20" fill="url(#kSolid)"/><circle cx="34" cy="34" r="17" fill="url(#kFrost)" stroke="rgba(255,255,255,.55)"/><path d="M47 47l13 13" stroke="url(#kSolid)" stroke-width="8" stroke-linecap="round"/>',
    };
    return `<svg class="ei" viewBox="0 0 72 72" aria-hidden="true">${paths[name]}</svg>`;
  }

  function render() {
    const inFiles = state.view === 'files' && !state.q;
    const titles = { files: 'My files', recent: 'Recent', starred: 'Starred', trash: 'Trash' };
    const current = state.path[state.path.length - 1];
    const title = state.q ? `Results for “${state.q}”` : inFiles && current ? current.name : titles[state.view];

    $('#title').textContent = title;
    document.title = `${title} · Kumo`;

    const crumbs = $('#crumbs');
    if (inFiles && state.path.length) {
      const parts = [`<a href="#/" data-drop="root">My files</a>`];
      state.path.forEach((p, i) => {
        parts.push('<i>/</i>');
        parts.push(i === state.path.length - 1
          ? `<span>${esc(p.name)}</span>` : `<a href="#/folder/${p.id}" data-drop="${p.id}">${esc(p.name)}</a>`);
      });
      crumbs.innerHTML = parts.join('');
    } else {
      crumbs.innerHTML = state.q ? '<a href="#/">Back to My files</a>' : '';
    }

    $('#sort').value = state.sort;
    $('#mode').innerHTML = state.mode === 'grid' ? ICON.list : ICON.grid;
    $('#new-folder').hidden = !inFiles;
    $('#upload-btn').hidden = !inFiles;
    $('#empty-trash').hidden = !(state.view === 'trash' && !state.q && state.items.length);
    document.querySelectorAll('.dock a').forEach(a => {
      if (a.dataset.view === state.view && !state.q) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    placeDock();

    renderMeter();

    const box = $('#listing');
    if (!state.items.length) {
      const [icon, head, body] = EMPTY[state.q ? 'search' : state.view];
      box.innerHTML = `<div class="empty">${emptyIcon(icon)}<h2>${head}</h2><p>${body}</p>` +
        (inFiles ? '<button class="btn btn-primary" id="empty-upload" type="button">Upload files</button>' : '') + '</div>';
      const b = $('#empty-upload');
      if (b) b.onclick = () => $('#file-input').click();
      return;
    }

    const draggable = state.view !== 'trash';
    const animateNow = state.animate;
    state.animate = false;
    box.innerHTML = `<div class="grid ${state.mode === 'list' ? 'list' : ''} ${animateNow ? 'enter' : ''}">` + sorted(state.items).map((it, i) => `
      <div class="item" style="--d:${Math.min(i, 14) * 38}ms" tabindex="0" role="button" data-id="${it.id}" ${draggable ? 'draggable="true"' : ''}
           ${it.is_folder && draggable ? `data-drop="${it.id}"` : ''} aria-label="${esc(it.name)}">
        <div class="badges">${it.starred ? `<span class="badge star" title="Starred">${ICON.star}</span>` : ''}${it.shared ? `<span class="badge" title="Shared with a link">${ICON.link}</span>` : ''}</div>
        <div class="thumb">${thumb(it)}</div>
        <div class="info">
          <div class="name" title="${esc(it.name)}">${esc(it.name)}</div>
          <div class="meta"><span>${it.is_folder ? 'Folder' : fmtSize(it.size)}</span><span>${fmtDate(state.view === 'trash' ? it.deleted : it.updated)}</span></div>
        </div>
        <button class="more" type="button" aria-label="Actions for ${esc(it.name)}" aria-haspopup="menu" aria-expanded="false">${ICON.more}</button>
      </div>`).join('') + '</div>';
  }

  function placeDock() {
    const dock = $('.dock'), ind = $('.dock-ind'), cur = dock.querySelector('[aria-current]');
    if (!cur) { ind.style.opacity = 0; return; }
    ind.style.opacity = 1;
    ind.style.setProperty('--x', cur.offsetLeft + 'px');
    ind.style.setProperty('--w', cur.offsetWidth + 'px');
  }
  addEventListener('resize', placeDock);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeDock);

  /* ---------- dialogs ---------- */
  function askText({ title, value = '', ok }) {
    const dlg = $('#dlg-text'), input = $('#dlg-text-input');
    $('#dlg-text-title').textContent = title;
    $('#dlg-text-ok').textContent = ok;
    input.value = value;
    return new Promise(resolve => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok' ? input.value.trim() : null), { once: true });
      dlg.returnValue = '';
      dlg.showModal();
      input.focus();
      const dot = value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    });
  }

  function askConfirm({ title, body, ok }) {
    const dlg = $('#dlg-confirm');
    $('#dlg-confirm-title').textContent = title;
    $('#dlg-confirm-body').textContent = body;
    $('#dlg-confirm-ok').textContent = ok;
    return new Promise(resolve => {
      dlg.addEventListener('close', () => resolve(dlg.returnValue === 'ok'), { once: true });
      dlg.returnValue = '';
      dlg.showModal();
    });
  }

  /* ---------- actions ---------- */
  const byId = id => state.items.find(i => i.id === +id);

  function open(it) {
    if (state.view === 'trash') return;
    if (it.is_folder) { location.hash = `#/folder/${it.id}`; return; }
    if (it.preview) preview(it); else download(it);
  }
  const download = it => { location.href = `/api/items/${it.id}/file`; };

  async function preview(it) {
    const dlg = $('#dlg-preview'), body = $('#pv-body'), url = `/api/items/${it.id}/file?inline=1`;
    $('#pv-name').textContent = it.name;
    $('#pv-download').href = `/api/items/${it.id}/file`;
    body.innerHTML = '';
    const make = {
      image: () => { const e = document.createElement('img'); e.src = url; e.alt = it.name; return e; },
      pdf: () => { const e = document.createElement('iframe'); e.src = url; e.title = it.name; return e; },
      audio: () => { const e = document.createElement('audio'); e.src = url; e.controls = true; return e; },
      video: () => { const e = document.createElement('video'); e.src = url; e.controls = true; return e; },
    };
    if (make[it.preview]) body.appendChild(make[it.preview]());
    else {
      const pre = document.createElement('pre');
      pre.textContent = 'Loading…';
      body.appendChild(pre);
      fetch(url).then(r => r.text()).then(t => {
        pre.textContent = t.length > 200000 ? t.slice(0, 200000) + '\n\n… preview truncated, download for the full file.' : t;
      }).catch(() => { pre.textContent = 'Could not load this file.'; });
    }
    dlg.showModal();
  }

  async function newFolder() {
    const name = await askText({ title: 'New folder', value: 'Untitled folder', ok: 'Create' });
    if (!name) return;
    try { await api('POST', '/api/folders', { name, parent_id: state.folder }); await load(); } catch (e) { fail(e); }
  }

  async function rename(it) {
    const name = await askText({ title: 'Rename', value: it.name, ok: 'Save' });
    if (!name || name === it.name) return;
    try { await api('PATCH', `/api/items/${it.id}`, { name }); await load(); } catch (e) { fail(e); }
  }

  async function toggleStar(it) {
    try { await api('PATCH', `/api/items/${it.id}`, { starred: !it.starred }); await load(); } catch (e) { fail(e); }
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }

  async function share(it) {
    try {
      const { url } = await api('POST', `/api/items/${it.id}/share`, { enabled: true });
      const ok = await copyText(url);
      toast(ok ? 'Link copied. Anyone with it can download this file.' : url);
      await load();
    } catch (e) { fail(e); }
  }

  async function copyLink(it) {
    try {
      const { url } = await api('GET', `/api/items/${it.id}/share`);
      toast((await copyText(url)) ? 'Link copied' : url);
    } catch (e) { fail(e); }
  }

  async function unshare(it) {
    try { await api('POST', `/api/items/${it.id}/share`, { enabled: false }); toast('Sharing turned off'); await load(); } catch (e) { fail(e); }
  }

  async function trash(it) {
    try {
      const card = document.querySelector(`.item[data-id="${it.id}"]`);
      if (card) { card.classList.add('leaving'); await new Promise(r => setTimeout(r, 230)); }
      await api('DELETE', `/api/items/${it.id}`);
      await load();
      toast('Moved to trash', { action: 'Undo', onAction: () => restore(it, true) });
    } catch (e) { fail(e); }
  }

  async function restore(it, quiet) {
    try { await api('POST', `/api/items/${it.id}/restore`); await load(); if (!quiet) toast('Restored'); } catch (e) { fail(e); }
  }

  async function purge(it) {
    const ok = await askConfirm({
      title: 'Delete forever?',
      body: `“${it.name}” will be permanently removed${it.is_folder ? ', along with everything inside it' : ''}. This can't be undone.`,
      ok: 'Delete forever',
    });
    if (!ok) return;
    try { await api('DELETE', `/api/items/${it.id}/purge`); await load(); } catch (e) { fail(e); }
  }

  async function emptyTrash() {
    const ok = await askConfirm({ title: 'Empty trash?', body: 'Everything in the trash will be permanently removed.', ok: 'Empty trash' });
    if (!ok) return;
    try { await api('POST', '/api/trash/empty'); await load(); toast('Trash emptied'); } catch (e) { fail(e); }
  }

  async function move(id, target) {
    try { await api('PATCH', `/api/items/${id}`, { parent_id: target }); await load(); toast('Moved'); } catch (e) { fail(e); }
  }

  /* ---------- context menu ---------- */
  let menuEl = null, menuBtn = null;
  function closeMenu() {
    if (menuEl) menuEl.remove();
    if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false');
    menuEl = menuBtn = null;
  }

  function menuFor(it) {
    if (state.view === 'trash') return [
      ['Restore', () => restore(it)],
      ['hr'],
      ['Delete forever', () => purge(it), 'danger'],
    ];
    const list = [[it.is_folder ? 'Open' : (it.preview ? 'Preview' : 'Download'), () => open(it)]];
    if (!it.is_folder) list.push(['Download', () => download(it)]);
    list.push(['Rename', () => rename(it)]);
    list.push([it.starred ? 'Remove star' : 'Add star', () => toggleStar(it)]);
    if (!it.is_folder) {
      list.push(['hr']);
      if (it.shared) { list.push(['Copy link', () => copyLink(it)]); list.push(['Stop sharing', () => unshare(it)]); }
      else list.push(['Share with a link', () => share(it)]);
    }
    if (it.parent_id !== null && state.view === 'files')
      list.push(['Move to My files', () => move(it.id, null)]);
    list.push(['hr']);
    list.push(['Move to trash', () => trash(it), 'danger']);
    return list;
  }

  function openMenu(it, x, y, btn) {
    closeMenu();
    menuEl = document.createElement('div');
    menuEl.className = 'menu';
    menuEl.setAttribute('role', 'menu');
    menuFor(it).forEach(([label, fn, cls]) => {
      if (label === 'hr') { menuEl.appendChild(document.createElement('hr')); return; }
      const b = document.createElement('button');
      b.type = 'button'; b.setAttribute('role', 'menuitem');
      b.textContent = label;
      if (cls) b.className = cls;
      b.onclick = () => { closeMenu(); fn(); };
      menuEl.appendChild(b);
    });
    document.body.appendChild(menuEl);
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.max(10, Math.min(x, innerWidth - r.width - 10)) + 'px';
    menuEl.style.top = Math.max(10, Math.min(y, innerHeight - r.height - 10)) + 'px';
    if (btn) { menuBtn = btn; btn.setAttribute('aria-expanded', 'true'); }
    menuEl.querySelector('button').focus();
  }

  /* ---------- uploads ---------- */
  const queue = [];
  let active = 0, uploadedAny = false;

  function uploadFiles(files) {
    files = [...files];
    if (!files.length) return;
    const parent = state.view === 'files' && !state.q ? state.folder : null;
    files.forEach(file => queue.push({ file, parent }));
    pump();
  }

  function panelRow(file) {
    const panel = $('#uploads');
    if (!panel.firstChild) panel.innerHTML = '<h3>Uploading</h3>';
    panel.hidden = false;
    const row = document.createElement('div');
    row.className = 'up-row';
    row.innerHTML = `<span>${esc(file.name)}</span><span class="bar"><i></i></span>`;
    panel.appendChild(row);
    return row;
  }

  function pump() {
    while (active < 2 && queue.length) {
      const job = queue.shift();
      active++;
      send(job).finally(() => {
        active--;
        if (queue.length) pump();
        else if (!active) finishUploads();
      });
    }
  }

  function send({ file, parent }) {
    return new Promise(resolve => {
      const row = panelRow(file), bar = $('i', row);
      const fd = new FormData();
      fd.append('files', file);
      if (parent) fd.append('parent', parent);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload');
      xhr.setRequestHeader('X-CSRF-Token', csrf);
      xhr.upload.onprogress = e => { if (e.lengthComputable) bar.style.width = (e.loaded / e.total * 100) + '%'; };
      xhr.onload = () => {
        if (xhr.status === 201) { bar.style.width = '100%'; uploadedAny = true; }
        else {
          let msg = 'Upload failed.';
          try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
          row.classList.add('fail');
          row.firstChild.textContent = `${file.name}: ${msg}`;
          toast(msg, { error: true });
        }
        resolve();
      };
      xhr.onerror = () => { row.classList.add('fail'); toast('Network error. Check your connection.', { error: true }); resolve(); };
      xhr.send(fd);
    });
  }

  async function finishUploads() {
    if (uploadedAny) { await load(); toast('Upload complete'); }
    uploadedAny = false;
    setTimeout(() => { if (!active && !queue.length) { $('#uploads').hidden = true; $('#uploads').innerHTML = ''; } }, 2200);
  }

  /* ---------- events ---------- */
  const listing = $('#listing');

  listing.addEventListener('click', e => {
    const card = e.target.closest('.item');
    if (!card) return;
    const it = byId(card.dataset.id);
    const btn = e.target.closest('.more');
    if (btn) {
      e.stopPropagation();
      if (menuBtn === btn) { closeMenu(); return; }
      const r = btn.getBoundingClientRect();
      openMenu(it, r.right - 220, r.bottom + 6, btn);
    } else open(it);
  });

  listing.addEventListener('keydown', e => {
    const card = e.target.closest('.item');
    if (card && e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(byId(card.dataset.id)); }
  });

  listing.addEventListener('contextmenu', e => {
    const card = e.target.closest('.item');
    if (!card) return;
    e.preventDefault();
    openMenu(byId(card.dataset.id), e.clientX, e.clientY);
  });

  document.addEventListener('click', e => {
    if (menuEl && !menuEl.contains(e.target)) closeMenu();
    const acct = $('#acct');
    if (acct.open && !acct.contains(e.target)) acct.open = false;
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') { closeMenu(); $('#acct').open = false; }
    if (e.key === '/' && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); $('#q').focus(); }
  });
  window.addEventListener('wheel', closeMenu, { passive: true });
  window.addEventListener('touchmove', closeMenu, { passive: true });

  $('#new-folder').onclick = newFolder;
  $('#upload-btn').onclick = () => $('#file-input').click();
  $('#empty-trash').onclick = emptyTrash;
  $('#file-input').onchange = e => { uploadFiles(e.target.files); e.target.value = ''; };
  $('#sort').onchange = e => { state.sort = e.target.value; store.set('kumo.sort', state.sort); render(); };
  $('#mode').onclick = () => { state.mode = state.mode === 'grid' ? 'list' : 'grid'; store.set('kumo.mode', state.mode); render(); };
  $('#pv-close').onclick = () => $('#dlg-preview').close();
  $('#dlg-preview').addEventListener('close', () => { $('#pv-body').innerHTML = ''; });
  $('#dlg-preview').addEventListener('click', e => { if (e.target === e.currentTarget) e.currentTarget.close(); });

  let searchTimer;
  $('#q').addEventListener('input', e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 220);
  });

  window.addEventListener('hashchange', route);

  /* drag & drop: files in from the desktop, items moved between folders */
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && [...e.dataTransfer.types].includes('Files');

  window.addEventListener('dragenter', e => {
    if (!hasFiles(e) || state.view === 'trash') return;
    dragDepth++; $('#dropzone').classList.add('on');
  });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('#dropzone').classList.remove('on');
  });
  window.addEventListener('dragover', e => {
    if (hasFiles(e) || e.dataTransfer.types.includes('text/x-kumo')) e.preventDefault();
  });
  window.addEventListener('drop', e => {
    e.preventDefault();
    dragDepth = 0; $('#dropzone').classList.remove('on');
    document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
    const dt = e.dataTransfer;

    if (hasFiles(e)) {
      if (state.view === 'trash') return;
      const files = []; let skipped = false;
      [...dt.items].forEach(item => {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        if (entry && entry.isDirectory) { skipped = true; return; }
        const f = item.getAsFile(); if (f) files.push(f);
      });
      if (skipped) toast('Folders can’t be dropped yet. Create a folder, then drop its files inside.', { error: true });
      uploadFiles(files);
      return;
    }
    const id = dt.getData('text/x-kumo');
    const zone = e.target.closest && e.target.closest('[data-drop]');
    if (id && zone) {
      const target = zone.dataset.drop === 'root' ? null : +zone.dataset.drop;
      if (target !== +id) move(+id, target);
    }
  });

  listing.addEventListener('dragstart', e => {
    const card = e.target.closest('.item');
    if (!card) return;
    e.dataTransfer.setData('text/x-kumo', card.dataset.id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('dragging');
  });
  listing.addEventListener('dragend', e => {
    const card = e.target.closest('.item');
    if (card) card.classList.remove('dragging');
    document.querySelectorAll('.drop-target').forEach(n => n.classList.remove('drop-target'));
  });
  document.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('text/x-kumo')) return;
    const zone = e.target.closest && e.target.closest('[data-drop]');
    document.querySelectorAll('.drop-target').forEach(n => { if (n !== zone) n.classList.remove('drop-target'); });
    if (zone) { e.preventDefault(); zone.classList.add('drop-target'); }
  });

  /* go */
  route();
})();
