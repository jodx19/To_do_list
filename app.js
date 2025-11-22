// assets/js/app.js — compact v2 (drop-in replacement)
// Features: migration, debounce save, CRUD, soft-delete, undo, bulk, DnD, reminders, export/import, search toggle
const STORAGE_KEY = 'todo.tasks.v2';
(() => {
  /* ---------- Model ---------- */
  const uid = () => 't_' + Math.random().toString(36).slice(2, 9);
  class Task {
    constructor({ id, text = '', createdAt = Date.now(), due = null, completed = false, priority = 'low', tags = [], recurrence = null, status = 'active', order = 0 } = {}) {
      this.id = id || uid();
      this.text = text;
      this.createdAt = createdAt;
      this.due = due;
      this.completed = completed;
      this.priority = priority;
      this.tags = tags;
      this.recurrence = recurrence;
      this.status = status;
      this.order = order;
      this.reminderSent = false;
    }
  }

  /* ---------- Storage (migrate + debounce) ----------
     - We sanitize and whitelist task fields before saving to protect against prototype pollution
     - Debounce saves to avoid thrashing localStorage during fast interactions
  */
  const Storage = (() => {
    let timer = null;
    function migrateFromV1(raw) {
      try {
        const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
        const arr = Array.isArray(data) ? data : (data.tasks || []);
        return {
          meta: { version: STORAGE_KEY, updatedAt: Date.now(), prefs: {} },
          tasks: arr.map((t, i) => new Task({
            text: t.text || t.task || String(t),
            completed: !!t.checked,
            createdAt: t.createdAt || Date.now(),
            order: i
          }))
        };
      } catch (e) {
        console.warn('migrateFromV1 failed', e);
        return { meta: { version: STORAGE_KEY, updatedAt: Date.now(), prefs: {} }, tasks: [] };
      }
    }
    function load() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return { tasks: parsed.map(t => new Task(t)), meta: { prefs: {} } };
          return { tasks: (parsed.tasks || []).map(t => new Task(t)), meta: parsed.meta || { prefs: {} } };
        }
        const legacy = localStorage.getItem('todo.tasks.v1') || localStorage.getItem('tasks');
        if (legacy) {
          const migrated = migrateFromV1(legacy);
          save(migrated.tasks, migrated.meta);
          return migrated;
        }
        return { tasks: [], meta: { prefs: {} } };
      } catch (e) {
        console.error('Storage.load error', e);
        return { tasks: [], meta: { prefs: {} } };
      }
    }
    function save(tasks, meta = {}) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          // Whitelist and sanitize task fields to avoid prototype pollution / unexpected props
          const safeTasks = (Array.isArray(tasks) ? tasks : []).map(t => ({
            id: String(t.id || ''),
            text: String(t.text || ''),
            createdAt: Number(t.createdAt) || Date.now(),
            due: t.due || null,
            completed: !!t.completed,
            priority: t.priority || 'low',
            tags: Array.isArray(t.tags) ? t.tags.slice(0, 50) : [],
            recurrence: t.recurrence || null,
            status: t.status || 'active',
            order: Number(t.order) || 0
          }));
          const payload = { tasks: safeTasks, meta: Object.assign({ updatedAt: Date.now(), prefs: {} }, meta) };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
        } catch (e) { console.error('Storage.save error', e); }
        timer = null;
      }, 200);
    }
    return { load, save, migrateFromV1 };
  })();

  /* ---------- App State & Utils ---------- */
  const qs = s => document.querySelector(s);
  const qsa = s => Array.from(document.querySelectorAll(s));
  const announce = (msg) => { const a = qs('#sr-announcements'); if (a) a.textContent = msg; };

  // Helper: convert timestamp (or date string) to local input datetime value
  function toLocalInputDatetime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  let state = {
    tasks: [],
    meta: { prefs: {} },
    filter: 'all',
    sort: 'created',
    search: '',
    selected: new Set(),
    view: 'list'
  };

  /* ---------- Core CRUD & features ---------- */
  function persist() { Storage.save(state.tasks, state.meta); }
  function addTask(text, extras = {}) {
    if (!text || !text.trim()) return;
    const t = new Task(Object.assign({ text: text.trim(), createdAt: Date.now(), order: state.tasks.length }, extras));
    state.tasks.unshift(t); reindex(); persist(); announce(`Added: ${t.text}`); render();
  }
  function updateTask(id, patch = {}) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    Object.assign(t, patch);
    // Persist safe state and update the single DOM node where possible (avoid full re-render)
    persist();
    announce(`Updated: ${t.text}`);
    updateTaskElement(t);
  }
  function softDelete(id) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    t.status = 'deleted'; persist(); announce(`Moved to Trash: ${t.text}`);
    showUndo(() => { t.status = 'active'; persist(); render(); }, 10000);
    render();
  }
  function purge(id) { state.tasks = state.tasks.filter(t => t.id !== id); reindex(); persist(); render(); }
  function toggleComplete(id) {
    const t = state.tasks.find(x => x.id === id); if (!t) return;
    t.completed = !t.completed;
    // persist and update only the changed task in the DOM for performance
    persist();
    announce(t.completed ? 'Completed' : 'Marked incomplete');
    updateTaskElement(t);
  }
  function reindex() { state.tasks.forEach((t, i) => t.order = i); }

  /* ---------- Bulk actions ---------- */
  function bulkApply(action) {
    const ids = Array.from(state.selected);
    ids.forEach(id => {
      const t = state.tasks.find(x => x.id === id);
      if (!t) return;
      if (action === 'delete') t.status = 'deleted';
      if (action === 'complete') t.completed = true;
      if (action === 'priority-high') t.priority = 'high';
    });
    state.selected.clear(); persist(); announce('Bulk action applied'); render();
  }

  /* ---------- Sorting / Filtering / Search ---------- */
  function visibleTasks() {
    let list = state.view === 'trash' ? state.tasks.filter(t => t.status === 'deleted') : state.tasks.filter(t => t.status !== 'deleted');
    if (state.filter === 'pending') list = list.filter(t => !t.completed);
    if (state.filter === 'completed') list = list.filter(t => t.completed);
    if (state.search) {
      const q = state.search.toLowerCase();
      list = list.filter(t => (t.text || '').toLowerCase().includes(q) || (t.tags || []).join(' ').toLowerCase().includes(q));
    }
    if (state.sort === 'created') list.sort((a, b) => b.createdAt - a.createdAt);
    if (state.sort === 'due') list.sort((a, b) => (a.due ? 1 : 2) - (b.due ? 1 : 2) || new Date(a.due || 1) - new Date(b.due || 1));
    if (state.sort === 'priority') { const w = { high: 2, medium: 1, low: 0 }; list.sort((a, b) => w[b.priority || 'low'] - w[a.priority || 'low']); }
    return list;
  }

  /* ---------- DnD (reorder) ---------- */
  let dragId = null;
  function onDragStart(e) {
    dragId = this.dataset.id;
    this.classList.add('dragging');
    try {
      e.dataTransfer.effectAllowed = 'move';
      // Firefox requires setData to be called for drag to work reliably
      e.dataTransfer.setData('text/plain', dragId);
    } catch (err) {
      // ignore if dataTransfer not available
    }
    this.setAttribute('aria-grabbed', 'true');
  }
  function onDrop(e) {
    e.preventDefault();
    const destId = this.dataset.id;
    if (!dragId || !destId || destId === dragId) return;
    const sI = state.tasks.findIndex(t => t.id === dragId);
    const dI = state.tasks.findIndex(t => t.id === destId);
    if (sI < 0 || dI < 0) return;
    const [itm] = state.tasks.splice(sI, 1);
    state.tasks.splice(dI, 0, itm);
    reindex();
    persist();
    announce('Reordered');
    render();
    dragId = null;
  }
  function onDragEnd() { this.classList.remove('dragging'); this.setAttribute('aria-grabbed', 'false'); dragId = null; }

  /* ---------- Reminders ---------- */
  function checkReminders() {
    const now = Date.now();
    state.tasks.forEach(t => {
      if (t.due && !t.reminderSent && !t.completed && t.status === 'active') {
        const dueTs = new Date(t.due).getTime();
        if (!isNaN(dueTs) && dueTs <= now) {
          if (window.Notification && Notification.permission === 'granted') new Notification('Task due', { body: t.text });
          else if (window.Notification && Notification.permission !== 'denied') Notification.requestPermission().then(p => { if (p === 'granted') new Notification('Task due', { body: t.text }); else flash(`Due: ${t.text}`); });
          else flash(`Due: ${t.text}`);
          t.reminderSent = true;
        }
      }
    });
    persist();
  }

  /* ---------- Export/Import ---------- */
  // Use same whitelist for export to avoid leaking unexpected props
  function exportJSON() {
    const safeTasks = state.tasks.map(t => ({
      id: String(t.id || ''),
      text: String(t.text || ''),
      createdAt: Number(t.createdAt) || Date.now(),
      due: t.due || null,
      completed: !!t.completed,
      priority: t.priority || 'low',
      tags: Array.isArray(t.tags) ? t.tags.slice(0, 50) : [],
      recurrence: t.recurrence || null,
      status: t.status || 'active',
      order: Number(t.order) || 0
    }));
    const blob = new Blob([JSON.stringify({ meta: state.meta, tasks: safeTasks }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'todo.tasks.v2.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    announce('Export ready');
  }

  // Import with validation and size limit to prevent abuse/DoS and malformed data
  function importJSONFile(file) {
    const MAX_TASKS = 5000;
    const fr = new FileReader();
    fr.onload = e => {
      try {
        const parsed = JSON.parse(e.target.result);
        // accept either a top-level array or an object with a tasks array
        const tasksArray = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.tasks) ? parsed.tasks : null);
        if (!Array.isArray(tasksArray)) throw new Error('Invalid file format: expected tasks array');
        if (tasksArray.length > MAX_TASKS) throw new Error('Import exceeds maximum allowed tasks');

        // validate each task structure minimally and whitelist fields
        const valid = tasksArray.every(t => t && typeof t === 'object' && (typeof t.id === 'string' || typeof t.text === 'string'));
        if (!valid) throw new Error('Import contains invalid task items');

        // map into Task instances and whitelist fields using constructor
        state.tasks = tasksArray.slice(0, MAX_TASKS).map(t => new Task(t));
        if (parsed && !Array.isArray(parsed) && parsed.meta) state.meta = parsed.meta;
        reindex();
        persist();
        render();
        announce('Import done');
      } catch (err) {
        console.error('Import error', err);
        flash(`Import failed: ${err.message}`);
        announce('Import failed');
      }
    };
    fr.readAsText(file);
  }

  /* ---------- Undo Snackbar (simple) ----------
     - Built via DOM APIs to avoid innerHTML and XSS risk
     - Action callback is provided to restore state when Undo clicked
  */
  let undoTimer = null;
  function showUndo(cb, timeout = 8000) {
    let sb = qs('.snackbar');
    if (!sb) {
      sb = document.createElement('div');
      sb.className = 'snackbar';
      sb.setAttribute('role', 'status');
      document.body.appendChild(sb);
    }
    sb.textContent = '';
    const txt = document.createElement('span'); txt.textContent = 'Action done';
    const btn = document.createElement('button'); btn.className = 'undo'; btn.type = 'button'; btn.textContent = 'Undo'; btn.setAttribute('aria-label', 'Undo action');
    btn.addEventListener('click', () => { if (undoTimer) clearTimeout(undoTimer); cb(); if (sb.parentNode) sb.remove(); });
    sb.appendChild(txt); sb.appendChild(btn);
    if (undoTimer) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => { if (sb.parentNode) sb.remove(); undoTimer = null; }, timeout);
  }
  function flash(msg, timeout = 3000) { const el = qs('#flash') || (() => { const d = document.createElement('div'); d.id = 'flash'; d.setAttribute('role', 'status'); document.body.appendChild(d); return d; })(); el.textContent = msg; setTimeout(() => { if (el.parentNode) el.textContent = ''; }, timeout); }

  /* ---------- Rendering (accessible, optimized with delegation) ---------- */
  function render() {
    const list = qs('#todo-list');
    const empty = qs('#empty-state');
    list.innerHTML = '';
    const items = visibleTasks();
    if (!items.length) { empty.style.display = 'block'; return; } else empty.style.display = 'none';

    // Use DocumentFragment to batch DOM inserts
    const fragment = document.createDocumentFragment();
    items.forEach(t => {
      // Build nodes via DOM API to avoid XSS and keep textContent safe
      const li = document.createElement('li');
      li.className = 'task';
      li.draggable = true;
      li.dataset.id = t.id;
      li.setAttribute('role', 'listitem');
      li.setAttribute('aria-grabbed', 'false');
      if (t.completed) li.classList.add('completed');

      // selection checkbox
      const sel = document.createElement('input'); sel.type = 'checkbox'; sel.className = 'select'; sel.setAttribute('aria-label', 'Select task'); if (state.selected.has(t.id)) sel.checked = true;

      // toggle complete
      const toggleBtn = document.createElement('button'); toggleBtn.className = 'toggle'; toggleBtn.type = 'button'; toggleBtn.setAttribute('aria-label', t.completed ? 'Mark incomplete' : 'Mark complete'); toggleBtn.setAttribute('aria-pressed', t.completed ? 'true' : 'false'); toggleBtn.textContent = t.completed ? '✔' : '○'; if (t.completed) toggleBtn.classList.add('active');

      // main content
      const main = document.createElement('div'); main.className = 'main';
      const title = document.createElement('div'); title.className = 'title'; title.textContent = String(t.text || '');
      const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = `${new Date(t.createdAt).toLocaleString()}${t.due ? (' • due ' + new Date(t.due).toLocaleString()) : ''}`;
      main.appendChild(title); main.appendChild(meta);

      // badges
      const badges = document.createElement('div'); badges.className = 'badges';
      const bp = document.createElement('span'); bp.className = 'badge badge-priority'; bp.textContent = String(t.priority || '');
      badges.appendChild(bp);
      (t.tags || []).slice(0, 3).forEach(tag => { const s = document.createElement('span'); s.className = 'badge badge-tag'; s.textContent = String(tag); badges.appendChild(s); });

      // actions
      const acts = document.createElement('div'); acts.className = 'acts';
      const editBtn = document.createElement('button'); editBtn.className = 'btn-icon edit'; editBtn.type = 'button'; editBtn.textContent = '✏️'; editBtn.setAttribute('aria-label', 'Edit task');
      const delBtn = document.createElement('button'); delBtn.className = 'btn-icon del'; delBtn.type = 'button'; delBtn.textContent = '🗑️'; delBtn.setAttribute('aria-label', 'Delete task');
      acts.appendChild(editBtn); acts.appendChild(delBtn);

      // append in order
      li.appendChild(sel);
      li.appendChild(toggleBtn);
      li.appendChild(main);
      li.appendChild(badges);
      li.appendChild(acts);

      // Drag events
      li.addEventListener('dragstart', onDragStart);
      li.addEventListener('dragover', e => e.preventDefault());
      li.addEventListener('drop', onDrop);
      li.addEventListener('dragend', onDragEnd);

      fragment.appendChild(li);
    });
    list.appendChild(fragment);

    // Set up event delegation for all task actions
    bindTaskListEvents();
    renderBulk();
  }

  // Small helper: update a single rendered task DOM node to avoid full re-render
  function updateTaskElement(t) {
    try {
      // safer find without relying on CSS.escape
      const all = Array.from(document.querySelectorAll('#todo-list li.task'));
      const li = all.find(n => n.dataset.id === String(t.id));
      if (!li) return;
      // completed state
      if (t.completed) li.classList.add('completed'); else li.classList.remove('completed');
      // toggle button
      const toggleBtn = li.querySelector('.toggle');
      if (toggleBtn) {
        toggleBtn.textContent = t.completed ? '✔' : '○';
        toggleBtn.setAttribute('aria-pressed', t.completed ? 'true' : 'false');
        toggleBtn.setAttribute('aria-label', t.completed ? 'Mark incomplete' : 'Mark complete');
        toggleBtn.classList.toggle('active', !!t.completed);
      }
      // text and meta
      const title = li.querySelector('.title'); if (title) title.textContent = String(t.text || '');
      const meta = li.querySelector('.meta'); if (meta) meta.textContent = `${new Date(t.createdAt).toLocaleString()}${t.due ? (' • due ' + new Date(t.due).toLocaleString()) : ''}`;
      // priority badge
      const bp = li.querySelector('.badge-priority'); if (bp) bp.textContent = String(t.priority || '');
      // tags: refresh tag badges
      const badges = li.querySelector('.badges');
      if (badges) {
        badges.querySelectorAll('.badge-tag').forEach(n => n.remove());
        (t.tags || []).slice(0, 3).forEach(tag => { const s = document.createElement('span'); s.className = 'badge badge-tag'; s.textContent = String(tag); badges.appendChild(s); });
      }
    } catch (err) { console.error('updateTaskElement error', err); }
  }

  // Event delegation for task list (single listener instead of per-item)
  function bindTaskListEvents() {
    const list = qs('#todo-list');
    // Remove old listener if exists
    if (list._delegateListener) {
      list.removeEventListener('click', list._delegateListener);
      list.removeEventListener('change', list._delegateChangeListener);
    }

    const clickHandler = (e) => {
      const task = e.target.closest('.task');
      if (!task) return;
      const id = task.dataset.id;
      const t = state.tasks.find(x => x.id === id);
      if (!t) return;

      if (e.target.matches('.toggle')) toggleComplete(id);
      if (e.target.matches('.edit')) startEdit(task, t);
      if (e.target.matches('.del')) softDelete(id);
    };

    const changeHandler = (e) => {
      const checkbox = e.target.closest('.select');
      if (!checkbox) return;
      const task = checkbox.closest('.task');
      if (!task) return;
      const id = task.dataset.id;

      if (checkbox.checked) state.selected.add(id);
      else state.selected.delete(id);
      renderBulk();
    };

    list.addEventListener('click', clickHandler);
    list.addEventListener('change', changeHandler);
    list._delegateListener = clickHandler;
    list._delegateChangeListener = changeHandler;
  }

  function renderBulk() {
    const card = qs('.card'); if (!card) return;
    let bar = card.querySelector('.bulk-bar');
    if (state.selected.size === 0) { if (bar) bar.remove(); return; }
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'bulk-bar';
      const left = document.createElement('div'); left.textContent = `${state.selected.size} selected`;
      const right = document.createElement('div'); right.className = 'bulk-actions';
      const mkBtn = (txt, act) => { const b = document.createElement('button'); b.className = 'btn btn-ghost bulk'; b.type = 'button'; b.dataset.act = act; b.textContent = txt; return b; };
      right.appendChild(mkBtn('Complete', 'complete'));
      right.appendChild(mkBtn('Prio+', 'priority-high'));
      right.appendChild(mkBtn('Delete', 'delete'));
      bar.appendChild(left); bar.appendChild(right);
      card.insertBefore(bar, card.querySelector('.list'));
      bar.addEventListener('click', (e) => { const b = e.target.closest('button.bulk'); if (!b) return; bulkApply(b.dataset.act); });
    }
    const leftDiv = bar.querySelector('div'); if (leftDiv) leftDiv.textContent = `${state.selected.size} selected`;
  }

  /* ---------- Inline edit (compact) ---------- */
  function startEdit(li, task) {
    const main = li.querySelector('.main');
    const input = document.createElement('input'); input.className = 'edit'; input.value = task.text;
    const due = document.createElement('input'); due.type = 'datetime-local'; due.className = 'edit-due'; if (task.due) try { due.value = toLocalInputDatetime(task.due); } catch (e) { }

    const save = document.createElement('button'); save.className = 'save'; save.textContent = 'Save';
    const cancel = document.createElement('button'); cancel.className = 'cancel'; cancel.textContent = 'Cancel';
    const wrap = document.createElement('div'); wrap.className = 'edit-inline'; wrap.append(input, due, save, cancel);
    main.replaceWith(wrap);

    input.focus();
    function commit() { updateTask(task.id, { text: input.value.trim(), due: due.value ? new Date(due.value).toISOString() : null }); }
    save.onclick = () => { commit(); render(); };
    cancel.onclick = () => render();
    input.onkeydown = (e) => { if (e.key === 'Enter') { commit(); } if (e.key === 'Escape') render(); };
  }

  /* ---------- Bind UI ---------- */
  function bind() {
    const form = qs('#todo-form'); const input = qs('#todo-input'); const filters = qsa('[data-filter]'); const search = qs('.search-input'); const sort = qs('.sort-select');
    form?.addEventListener('submit', e => { e.preventDefault(); if (input.value.trim()) { addTask(input.value.trim()); input.value = ''; } });
    filters.forEach(f => f.addEventListener('click', () => { state.filter = f.dataset.filter; filters.forEach(b => b.classList.toggle('active', b === f)); render(); }));
    if (search) search.addEventListener('input', debounce(e => { state.search = e.target.value; render(); }, 400));
    if (sort) { sort.value = state.sort; sort.addEventListener('change', e => { state.sort = e.target.value; persist(); render(); }); }

    // search toggle behavior (show/hide) — enhanced: left reveal, aria, ESC, outside click
    const searchBtn = qs('.search-toggle');
    const searchInput = qs('.search-input');
    const searchWrapper = qs('.search-wrapper');
    const controls = qs('.controls');
    const inputWrap = qs('.input-wrap');

    if (searchBtn && searchInput && searchWrapper && controls && inputWrap) {
      // ensure initial aria state
      searchBtn.setAttribute('aria-expanded', 'false');
      searchInput.setAttribute('aria-hidden', 'true');
      const prefersReduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      // Helper: compute shift so search input becomes visible inside controls/app

      function computeSearchShift() {
    
    const searchWidth = 240;

    
    const extraPadding = 40;

   
    return -(searchWidth / 1.4) - extraPadding;
}

      function openSearch() {
        searchWrapper.classList.add('open');
        searchBtn.setAttribute('aria-expanded', 'true');
        searchInput.classList.remove('visually-hidden');
        searchInput.setAttribute('aria-hidden', 'false');

        // compute shift on next frame so CSS width has been applied
        requestAnimationFrame(() => {
          const shiftValue = computeSearchShift();
          document.documentElement.style.setProperty('--search-offset', shiftValue);
          controls.classList.add('search-open');

          // focus with a small delay unless reduced motion requested
          if (prefersReduced) searchInput.focus();
          else setTimeout(() => searchInput.focus(), 70);
        });
      }

      function closeSearch() {
        controls.classList.remove('search-open');
        // reset offset (smooth because .input-wrap has transition)
        document.documentElement.style.setProperty('--search-offset', '0px');

        searchWrapper.classList.remove('open');
        searchBtn.setAttribute('aria-expanded', 'false');
        searchInput.classList.add('visually-hidden');
        searchInput.setAttribute('aria-hidden', 'true');
        searchInput.blur();

        if (state.search) { state.search = ''; render(); }
      }

      searchBtn.addEventListener('click', (e) => {
        if (searchWrapper.classList.contains('open')) closeSearch();
        else openSearch();
      });

      // close on Escape when input focused — return focus to the toggle button per A11y
      searchInput.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { closeSearch(); searchBtn.focus(); }
      });

      // close when clicking outside — guard to avoid adding duplicate handlers
      if (searchWrapper._docClickListener) document.removeEventListener('click', searchWrapper._docClickListener);
      const docClick = (e) => { if (!searchWrapper.contains(e.target) && searchWrapper.classList.contains('open')) closeSearch(); };
      document.addEventListener('click', docClick);
      searchWrapper._docClickListener = docClick;

      // recalc shift on resize to keep layout stable
      let resizeTimer = null;
      function recalcIfOpen() {
        if (!controls.classList.contains('search-open')) return;
        const shiftValue = computeSearchShift();
        document.documentElement.style.setProperty('--search-offset', shiftValue);
      }
      window.addEventListener('resize', () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(recalcIfOpen, 120);
      });
    }

    // keyboard shortcut: n to focus input
    document.addEventListener('keydown', (e) => { if (e.key === 'n' && document.activeElement.tagName !== 'INPUT') { input?.focus(); } });

    // footer buttons: export/import, trash
    const footer = qs('footer');
    if (footer) {
      const exp = el('button', 'Export', 'btn btn-ghost'); exp.type = 'button'; exp.addEventListener('click', exportJSON);
      const imp = el('button', 'Import', 'btn btn-ghost'); imp.type = 'button';
      const fileInput = el('input'); fileInput.type = 'file'; fileInput.accept = 'application/json'; fileInput.style.display = 'none'; fileInput.addEventListener('change', (e) => { if (e.target.files[0]) importJSONFile(e.target.files[0]); });
      const trash = el('button', 'Trash', 'btn btn-ghost'); trash.type = 'button'; trash.addEventListener('click', () => { state.view = state.view === 'trash' ? 'list' : 'trash'; render(); });
      footer.appendChild(exp); footer.appendChild(imp); footer.appendChild(trash); footer.appendChild(fileInput);
      imp.addEventListener('click', () => fileInput.click());
    }
  }
  function el(tag = 'div', txt = '', cls = '') { const e = document.createElement(tag); if (txt) e.textContent = txt; if (cls) e.className = cls; return e; }
  function debounce(fn, t) { let to; return (...a) => { if (to) clearTimeout(to); to = setTimeout(() => fn(...a), t); }; }

  /* ---------- Init ---------- */
  function init() {
    const loaded = Storage.load();
    state.tasks = (loaded.tasks || []).map(t => new Task(t));
    state.meta = loaded.meta || { prefs: {} };
    if (state.meta.prefs && state.meta.prefs.theme) document.documentElement.classList.toggle('light', state.meta.prefs.theme === 'light');
    bind();
    render();
    checkReminders(); setInterval(checkReminders, 60 * 1000);
  }

  /* ---------- Expose init (with guard) ---------- */
  let isInitialized = false;
  document.addEventListener('DOMContentLoaded', () => {
    if (isInitialized) return;
    isInitialized = true;
    init();
  });
})();
