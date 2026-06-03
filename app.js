/*
 * QC Photo Organizer — client-only logic.
 * Users fill in a product model + unit number and attach up to 11 photos (one
 * per fixed surface). Each surface has a "has defect" checkbox; when checked,
 * its note becomes editable and the photo is also copied into a defect folder.
 * Export is a ZIP that unzips into a single folder `{model}-{unit}` with sub-
 * folders 外部 / 内部 (all photos) and 瑕疵 (flagged photos, under 外部/内部),
 * plus a `质检备注.csv` manifest. Everything runs in the browser; no backend.
 */
(function () {
  'use strict';

  // ---- Static config: the 11 fixed surfaces, in display order ----
  const PARTS = [
    { id: 'front',       label: '正面',        group: 'external' },
    { id: 'back',        label: '背面',        group: 'external' },
    { id: 'left_side',   label: '左侧板',      group: 'external' },
    { id: 'right_side',  label: '右侧板',      group: 'external' },
    { id: 'top',         label: '顶板',        group: 'external' },
    { id: 'inner_left',  label: '内侧板（左）', group: 'internal' },
    { id: 'inner_right', label: '内侧板（右）', group: 'internal' },
    { id: 'inner_back',  label: '内背板',      group: 'internal' },
    { id: 'seat',        label: '坐板',        group: 'internal' },
    { id: 'seat_front',  label: '坐前板',      group: 'internal' },
    { id: 'foot',        label: '脚板',        group: 'internal' },
  ];
  const TOTAL = PARTS.length; // 11
  const GROUP_FOLDER = { external: '外部', internal: '内部' };
  const DEFECT_FOLDER = '瑕疵';
  const GROUP_TOTALS = PARTS.reduce(function (acc, p) {
    acc[p.group] = (acc[p.group] || 0) + 1;
    return acc;
  }, {});

  // ---- Runtime state ----
  const state = {
    model: '',
    unit: '01',
    slots: {},        // id -> { file, note, previewUrl, ext, hasDefect }
    status: 'idle',   // 'idle' | 'generating' | 'ready'
    history: [],      // newest first; see recordHistory()
    lastBlob: null,   // current export blob, for the "下载" button
    lastFolder: '',
  };
  PARTS.forEach(function (p) {
    state.slots[p.id] = { file: null, note: '', previewUrl: null, ext: '', hasDefect: false };
  });

  // ---- DOM refs (script is deferred, so the DOM is ready) ----
  const els = {
    main: document.getElementById('main'),
    modelInput: document.getElementById('model-input'),
    unitInput: document.getElementById('unit-input'),
    folderPreview: document.getElementById('folder-preview'),
    countNum: document.getElementById('count-num'),
    countDefect: document.getElementById('count-defect'),
    historyBtn: document.getElementById('history-btn'),
    historyCount: document.getElementById('history-count'),
    generateBtn: document.getElementById('generate-btn'),
    downloadBtn: document.getElementById('download-btn'),
    nextBtn: document.getElementById('next-btn'),
    hint: document.getElementById('action-hint'),
    overlay: document.getElementById('overlay'),
    spinner: document.getElementById('spinner'),
    checkmark: document.getElementById('checkmark'),
    overlayText: document.getElementById('overlay-text'),
    historyModal: document.getElementById('history-modal'),
    historyBack: document.getElementById('history-back'),
    historyTitle: document.getElementById('history-modal-title'),
    historyBody: document.getElementById('history-body'),
    toast: document.getElementById('toast'),
  };

  // ===================== Helpers =====================

  function prefersReducedMotion() {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function cardFor(id) {
    return document.querySelector('.slot[data-part-id="' + id + '"]');
  }

  function effectiveUnit() {
    return (state.unit || '').trim() || '01';
  }

  // Strip filesystem-illegal characters while preserving Chinese (kept as UTF-8
  // in the ZIP entry names). Returns a safe, length-capped name.
  function sanitizeFilename(raw, fallback) {
    var s = String(raw == null ? '' : raw);
    if (s.normalize) s = s.normalize('NFC');
    s = s.replace(/[\/\\:*?"<>|]/g, '_'); // illegal on Windows/macOS
    s = s.replace(/[\x00-\x1f\x7f]/g, ''); // control chars
    s = s.replace(/\s+/g, ' ').trim();     // collapse whitespace
    s = s.replace(/^\.+/, '').replace(/[. ]+$/, ''); // no leading dots / trailing dot or space
    if (!s) s = fallback || '未命名';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(s)) s = '_' + s; // Windows reserved
    return s.slice(0, 80);
  }

  function extFromName(name) {
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(name || '');
    return m ? m[1].toLowerCase() : '';
  }

  function extFromMime(type) {
    var map = {
      'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp',
      'image/gif': 'gif', 'image/heic': 'heic', 'image/heif': 'heif',
      'image/bmp': 'bmp', 'image/tiff': 'tif',
    };
    return map[(type || '').toLowerCase()] || '';
  }

  // Whether the browser can likely render this file as an <img>. HEIC/HEIF are
  // excluded — most desktop browsers cannot decode them (the file is still kept).
  function isRenderable(file) {
    var t = (file.type || '').toLowerCase();
    var ext = extFromName(file.name);
    if (t === 'image/heic' || t === 'image/heif') return false;
    if (ext === 'heic' || ext === 'heif') return false;
    if (t.indexOf('image/') === 0) return true;
    if (!t && ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'].indexOf(ext) !== -1) return true;
    return false;
  }

  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function fileExt(file) {
    return extFromName(file.name) || extFromMime(file.type) || 'bin';
  }

  function formatNow() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  // Increment a unit string, preserving any non-digit prefix/suffix and zero-pad
  // width: "01" -> "02", "09" -> "10", "A-01" -> "A-02". Non-numeric kept as-is.
  function incrementUnit(unit) {
    var s = String(unit || '').trim();
    var m = /^(\D*?)(\d+)(\D*)$/.exec(s);
    if (!m) return s || '01';
    var next = String(Number(m[2]) + 1).padStart(m[2].length, '0');
    return m[1] + next + m[3];
  }

  function dedupe(name, used) {
    if (!used.has(name)) { used.add(name); return name; }
    var dot = name.lastIndexOf('.');
    var base = dot > 0 ? name.slice(0, dot) : name;
    var ext = dot > 0 ? name.slice(dot) : '';
    var i = 2, candidate;
    do { candidate = base + ' (' + i + ')' + ext; i++; } while (used.has(candidate));
    used.add(candidate);
    return candidate;
  }

  function countPhotos() {
    var n = 0;
    for (var i = 0; i < PARTS.length; i++) if (state.slots[PARTS[i].id].file) n++;
    return n;
  }

  function countDefects() {
    var n = 0;
    for (var i = 0; i < PARTS.length; i++) if (state.slots[PARTS[i].id].hasDefect) n++;
    return n;
  }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  var toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    void els.toast.offsetWidth; // force reflow so the transition runs
    els.toast.classList.add('is-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      els.toast.classList.remove('is-show');
      setTimeout(function () { els.toast.hidden = true; }, 250);
    }, 2200);
  }

  // ===================== Slot rendering =====================

  function slotMarkup(part) {
    var l = escapeHtml(part.label);
    return '' +
      '<div class="slot" data-part-id="' + part.id + '" data-state="empty">' +
        '<div class="slot__top">' +
          '<span class="slot__label">' + l + '</span>' +
          '<button class="slot__remove" type="button" aria-label="移除' + l + '的照片" hidden>✕</button>' +
        '</div>' +
        '<label class="slot__drop">' +
          '<input class="slot__input visually-hidden" type="file" accept="image/*" capture="environment" aria-label="' + l + ' 照片" />' +
          '<div class="slot__placeholder">' +
            '<svg class="slot__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 3 7.2 5H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3.2L15 3H9Zm3 5a5 5 0 1 1 0 10 5 5 0 0 1 0-10Zm0 2a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg>' +
            '<span class="slot__hint-text">点击拍照 / 选择照片</span>' +
          '</div>' +
          '<div class="slot__preview"><img alt="' + l + ' 照片预览" /></div>' +
          '<div class="slot__nopreview">' +
            '<svg class="slot__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6Zm7 1.5L18.5 9H13V3.5Z"/></svg>' +
            '<span class="slot__filename"></span>' +
            '<span class="slot__nopreview-tag">已选择（无法预览）</span>' +
          '</div>' +
        '</label>' +
        '<label class="slot__defect">' +
          '<input class="slot__defect-check" type="checkbox" aria-label="' + l + ' 有瑕疵" />' +
          '<span>有瑕疵</span>' +
        '</label>' +
        '<textarea class="slot__note" rows="2" disabled placeholder="勾选「有瑕疵」后填写备注" aria-label="' + l + ' 瑕疵备注"></textarea>' +
      '</div>';
  }

  function renderSlots() {
    var groups = { external: [], internal: [] };
    PARTS.forEach(function (p) { groups[p.group].push(slotMarkup(p)); });
    document.querySelector('[data-slot-grid="external"]').innerHTML = groups.external.join('');
    document.querySelector('[data-slot-grid="internal"]').innerHTML = groups.internal.join('');
  }

  function updateSlotView(id) {
    var slot = state.slots[id];
    var card = cardFor(id);
    if (!card) return;
    var img = card.querySelector('.slot__preview img');
    var removeBtn = card.querySelector('.slot__remove');
    var filenameEl = card.querySelector('.slot__filename');

    if (!slot.file) {
      card.dataset.state = 'empty';
      removeBtn.hidden = true;
      img.classList.remove('is-loaded');
      img.removeAttribute('src');
      return;
    }

    removeBtn.hidden = false;
    if (slot.previewUrl) {
      card.dataset.state = 'preview';
      img.classList.remove('is-loaded');
      img.onload = function () { img.classList.add('is-loaded'); };
      img.onerror = function () {
        if (slot.previewUrl) { URL.revokeObjectURL(slot.previewUrl); slot.previewUrl = null; }
        card.dataset.state = 'nopreview';
        filenameEl.textContent = slot.file ? slot.file.name : '';
      };
      img.src = slot.previewUrl;
    } else {
      card.dataset.state = 'nopreview';
      filenameEl.textContent = slot.file.name;
    }
  }

  // ===================== Shared UI updates =====================

  function updateCounts() {
    var total = 0;
    var byGroup = { external: 0, internal: 0 };
    PARTS.forEach(function (p) {
      if (state.slots[p.id].file) { total++; byGroup[p.group]++; }
    });
    els.countNum.textContent = total;
    document.querySelector('[data-group-count="external"]').textContent = byGroup.external + '/' + GROUP_TOTALS.external;
    document.querySelector('[data-group-count="internal"]').textContent = byGroup.internal + '/' + GROUP_TOTALS.internal;
    var dc = countDefects();
    els.countDefect.textContent = dc > 0 ? (' · 瑕疵 ' + dc) : '';
  }

  function updateFolderPreview() {
    var base = sanitizeFilename(state.model) + '-' + sanitizeFilename(effectiveUnit());
    els.folderPreview.textContent = state.model.trim() ? '将生成文件夹：' + base : '';
  }

  function updateActionBar() {
    var valid = state.model.trim().length > 0;
    var pc = countPhotos();
    var dc = countDefects();

    els.generateBtn.disabled = state.status === 'generating' ? true : !valid;

    if (!valid) {
      els.hint.textContent = '请填写产品型号';
      els.hint.dataset.tone = 'warn';
    } else if (state.status === 'ready') {
      els.hint.textContent = '已生成，可下载或继续“下一台”';
      els.hint.dataset.tone = 'ok';
    } else if (pc > 0) {
      els.hint.textContent = '将导出 ' + pc + ' 张照片' + (dc > 0 ? '（其中 ' + dc + ' 项有瑕疵）' : '') + ' + 备注';
      els.hint.dataset.tone = '';
    } else {
      els.hint.textContent = '可不拍照，仅生成备注清单';
      els.hint.dataset.tone = '';
    }

    if (state.history.length > 0) {
      els.historyBtn.hidden = false;
      els.historyCount.textContent = state.history.length;
    } else {
      els.historyBtn.hidden = true;
    }
  }

  function setStatus(s) {
    state.status = s;
    var ready = s === 'ready';
    els.generateBtn.hidden = ready;
    els.downloadBtn.hidden = !ready;
    els.nextBtn.hidden = !ready;
    updateActionBar();
  }

  // Any edit after a successful export invalidates the "ready" state.
  function markDirty() {
    if (state.status === 'ready') {
      state.lastBlob = null;
      state.lastFolder = '';
      setStatus('idle');
    }
  }

  // ===================== Slot file handling =====================

  function setSlotFile(id, file) {
    var slot = state.slots[id];
    if (slot.previewUrl) { URL.revokeObjectURL(slot.previewUrl); slot.previewUrl = null; }
    slot.file = file;
    slot.ext = fileExt(file);
    if (isRenderable(file)) slot.previewUrl = URL.createObjectURL(file);
    updateSlotView(id);
    updateCounts();
    markDirty();
    updateActionBar();
  }

  function clearSlot(id) {
    var slot = state.slots[id];
    if (slot.previewUrl) { URL.revokeObjectURL(slot.previewUrl); slot.previewUrl = null; }
    slot.file = null;
    slot.ext = '';
    // The defect flag and note are intentionally kept (e.g. "surface missing").
    updateSlotView(id);
    updateCounts();
    markDirty();
    updateActionBar();
  }

  function setDefect(id, on) {
    var slot = state.slots[id];
    slot.hasDefect = on;
    var card = cardFor(id);
    if (card) {
      card.dataset.defect = on ? 'on' : '';
      var note = card.querySelector('.slot__note');
      note.disabled = !on;
      note.placeholder = on ? '请描述瑕疵（方便溯源）' : '勾选「有瑕疵」后填写备注';
      if (on) { try { note.focus(); } catch (e) {} }
    }
    updateCounts();
    markDirty();
    updateActionBar();
  }

  // ===================== ZIP + CSV =====================

  function buildCsv(model, unit, partCount, defectCount, rows) {
    var BOM = '\uFEFF'; // makes Excel/WPS read the file as UTF-8 (avoids garbled Chinese)
    var CRLF = '\r\n';
    var L = [];
    L.push('型号,' + csvEscape(model));
    L.push('编号,' + csvEscape(unit));
    L.push('生成时间,' + csvEscape(formatNow()));
    L.push('部位照片,' + partCount + '/' + TOTAL);
    L.push('瑕疵,' + defectCount + ' 项');
    L.push('');
    L.push('类别,部位,是否有照片,是否有瑕疵,文件名,瑕疵备注');
    rows.forEach(function (r) {
      L.push([
        csvEscape(r.category), csvEscape(r.label),
        r.has ? '是' : '否', r.defect ? '是' : '否',
        csvEscape(r.path), csvEscape(r.defect ? r.note : ''),
      ].join(','));
    });
    return BOM + L.join(CRLF) + CRLF;
  }

  // Build the export blob from any slots map (shared by generate + re-download).
  // Photos go into 外部/内部; any flagged photo is ALSO copied into 瑕疵/外部 or
  // 瑕疵/内部. STORE (no deflate) keeps it fast on phones; sub-folders are lazy.
  function buildZipBlob(model, unit, slots) {
    var folderBase = sanitizeFilename(model) + '-' + sanitizeFilename(unit);
    var zip = new JSZip();
    var root = zip.folder(folderBase);
    var dirs = {};
    var usedByDir = {};

    function addTo(dirName, fileName, file) {
      if (!dirs[dirName]) dirs[dirName] = root.folder(dirName);
      var used = usedByDir[dirName] || (usedByDir[dirName] = new Set());
      var name = dedupe(fileName, used);
      dirs[dirName].file(name, file);
      return dirName + '/' + name;
    }

    var rows = [];
    var partCount = 0;
    var defectCount = 0;
    PARTS.forEach(function (part) {
      var slot = slots[part.id] || {};
      var groupDir = GROUP_FOLDER[part.group];
      var path = '';
      if (slot.file) {
        var ext = slot.ext || extFromMime(slot.file.type) || 'bin';
        var fname = folderBase + '-' + sanitizeFilename(part.label) + '.' + ext;
        path = addTo(groupDir, fname, slot.file);
        partCount++;
        if (slot.hasDefect) addTo(DEFECT_FOLDER + '/' + groupDir, fname, slot.file); // copy into defect folder
      }
      if (slot.hasDefect) defectCount++;
      rows.push({
        category: groupDir,
        label: part.label,
        has: !!slot.file,
        defect: !!slot.hasDefect,
        path: path,
        note: (slot.note || '').trim(),
      });
    });

    root.file('质检备注.csv', buildCsv(model, unit, partCount, defectCount, rows));

    return zip.generateAsync({ type: 'blob', compression: 'STORE' }).then(function (blob) {
      return { blob: blob, folderBase: folderBase, count: partCount, defectCount: defectCount };
    });
  }

  function showOverlay(mode, text) {
    els.overlay.hidden = false;
    els.overlayText.textContent = text;
    if (mode === 'spinner') {
      els.spinner.hidden = false;
      els.checkmark.hidden = true;
      els.checkmark.classList.remove('is-drawn');
    } else {
      els.spinner.hidden = true;
      els.checkmark.hidden = false;
      requestAnimationFrame(function () { els.checkmark.classList.add('is-drawn'); });
    }
  }

  function hideOverlay() { els.overlay.hidden = true; }

  function generate() {
    if (typeof JSZip === 'undefined') { showToast('打包组件未加载，请刷新页面'); return; }
    var model = state.model.trim();
    if (!model) { updateActionBar(); return; }

    if (countPhotos() === 0) {
      if (!window.confirm('未选择任何照片，仍要生成（仅包含备注清单）？')) return;
    }

    var unit = effectiveUnit();
    state.unit = unit;
    els.unitInput.value = unit; // reflect the normalised value (e.g. blank -> 01)

    setStatus('generating');
    showOverlay('spinner', '正在生成…');

    buildZipBlob(model, unit, state.slots).then(function (res) {
      state.lastBlob = res.blob;
      state.lastFolder = res.folderBase;
      triggerDownload(res.blob, res.folderBase + '.zip');
      recordHistory(res.folderBase, res.count, res.defectCount, model, unit);
      var extra = res.defectCount > 0 ? '（瑕疵 ' + res.defectCount + ' 项）' : '';
      showOverlay('check', '已生成 ' + res.folderBase + '.zip · 共 ' + res.count + ' 张' + extra);
      setStatus('ready');
      setTimeout(hideOverlay, 1500);
    }).catch(function (err) {
      console.error(err);
      hideOverlay();
      setStatus('idle');
      showToast('生成失败，请重试');
    });
  }

  function recordHistory(folderBase, count, defectCount, model, unit) {
    var snap = {};
    PARTS.forEach(function (p) {
      var s = state.slots[p.id];
      snap[p.id] = { file: s.file, note: s.note, ext: s.ext, hasDefect: s.hasDefect };
    });
    state.history.unshift({
      folderName: folderBase,
      model: model,
      unit: unit,
      timestamp: formatNow(),
      photoCount: count,
      defectCount: defectCount,
      slots: snap,
    });
    updateActionBar();
  }

  function nextUnit() {
    PARTS.forEach(function (p) {
      var s = state.slots[p.id];
      if (s.previewUrl) { URL.revokeObjectURL(s.previewUrl); s.previewUrl = null; }
      s.file = null; s.ext = ''; s.note = ''; s.hasDefect = false;
    });
    state.unit = incrementUnit(effectiveUnit());
    els.unitInput.value = state.unit;
    state.lastBlob = null;
    state.lastFolder = '';

    renderSlots(); // fresh DOM: empty slots, unchecked defects, disabled notes
    updateCounts();
    updateFolderPreview();
    setStatus('idle');
    window.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
    showToast('已切换到编号 ' + state.unit + '，可以拍下一台了');
  }

  // ===================== History panel =====================

  var detailUrls = []; // object URLs created for the detail view; revoked on leave
  function revokeDetailUrls() {
    detailUrls.forEach(function (u) { URL.revokeObjectURL(u); });
    detailUrls = [];
  }

  function openHistory() {
    renderHistoryList();
    els.historyModal.hidden = false;
    document.body.classList.add('modal-open');
  }

  function closeHistory() {
    els.historyModal.hidden = true;
    document.body.classList.remove('modal-open');
    revokeDetailUrls();
    els.historyBack.hidden = true;
    els.historyTitle.textContent = '本次生成记录';
  }

  function renderHistoryList() {
    revokeDetailUrls();
    els.historyBack.hidden = true;
    els.historyTitle.textContent = '本次生成记录';
    if (!state.history.length) {
      els.historyBody.innerHTML = '<p class="hist-empty">暂无记录</p>';
      return;
    }
    els.historyBody.innerHTML = state.history.map(function (h, i) {
      var defectMeta = h.defectCount ? ' · 瑕疵 ' + h.defectCount : '';
      return '' +
        '<div class="hist-item">' +
          '<div class="hist-item__main">' +
            '<div class="hist-item__name">' + escapeHtml(h.folderName) + '</div>' +
            '<div class="hist-item__meta">' + h.photoCount + ' 张' + defectMeta + ' · ' + escapeHtml(h.timestamp) + '</div>' +
          '</div>' +
          '<div class="hist-item__actions">' +
            '<button class="btn btn--ghost" type="button" data-hist-view="' + i + '">查看</button>' +
            '<button class="btn btn--secondary" type="button" data-hist-dl="' + i + '">重新下载</button>' +
          '</div>' +
        '</div>';
    }).join('');
  }

  function detailThumb(file, label) {
    if (file && isRenderable(file)) {
      var url = URL.createObjectURL(file);
      detailUrls.push(url);
      return '<img class="hist-thumb" src="' + url + '" alt="' + escapeHtml(label) + '" loading="lazy" />';
    }
    if (file) {
      return '<div class="hist-thumb hist-thumb--none"><span>无法预览</span><small>' + escapeHtml(file.name) + '</small></div>';
    }
    return '<div class="hist-thumb hist-thumb--empty">未拍摄</div>';
  }

  function renderHistoryDetail(index) {
    revokeDetailUrls();
    var h = state.history[index];
    if (!h) return;
    els.historyBack.hidden = false;
    els.historyTitle.textContent = h.folderName;

    var cards = PARTS.map(function (p) {
      var s = h.slots[p.id] || {};
      var note = (s.note || '').trim();
      var badge = s.hasDefect ? '<span class="hist-defect-badge">有瑕疵</span>' : '';
      var noteHtml = s.hasDefect
        ? '<div class="hist-detail-note' + (note ? '' : ' is-empty') + '">' + (note ? escapeHtml(note) : '（未填写备注）') + '</div>'
        : '';
      return '' +
        '<div class="hist-detail-item">' +
          detailThumb(s.file, p.label) +
          '<div class="hist-detail-meta">' +
            '<div class="hist-detail-part">' + escapeHtml(p.label) + badge + '</div>' +
            noteHtml +
          '</div>' +
        '</div>';
    }).join('');

    var meta = h.photoCount + ' 张照片' + (h.defectCount ? ' · ' + h.defectCount + ' 项瑕疵' : '');
    els.historyBody.innerHTML = '' +
      '<div class="hist-detail-head">' +
        '<span>' + meta + ' · ' + escapeHtml(h.timestamp) + '</span>' +
        '<button class="btn btn--secondary" type="button" data-hist-dl="' + index + '">重新下载</button>' +
      '</div>' +
      '<div class="hist-detail-grid">' + cards + '</div>';
  }

  function reDownload(index) {
    var h = state.history[index];
    if (!h) return;
    showToast('正在打包…');
    buildZipBlob(h.model, h.unit, h.slots).then(function (res) {
      triggerDownload(res.blob, res.folderBase + '.zip');
    }).catch(function (err) {
      console.error(err);
      showToast('打包失败，请重试');
    });
  }

  // ===================== Event wiring =====================

  function wire() {
    // Product meta inputs
    els.modelInput.addEventListener('input', function () {
      state.model = els.modelInput.value;
      updateFolderPreview();
      markDirty();
      updateActionBar();
    });
    els.unitInput.addEventListener('input', function () {
      state.unit = els.unitInput.value;
      updateFolderPreview();
      markDirty();
      updateActionBar();
    });

    // Slot file selection + defect checkbox (delegated change)
    els.main.addEventListener('change', function (e) {
      var input = e.target.closest('.slot__input');
      if (input) {
        var fcard = input.closest('.slot');
        var file = input.files && input.files[0];
        if (file) setSlotFile(fcard.dataset.partId, file);
        input.value = ''; // allow re-selecting the same file later
        return;
      }
      var chk = e.target.closest('.slot__defect-check');
      if (chk) {
        setDefect(chk.closest('.slot').dataset.partId, chk.checked);
      }
    });

    // Defect notes (delegated input)
    els.main.addEventListener('input', function (e) {
      var ta = e.target.closest('.slot__note');
      if (!ta) return;
      state.slots[ta.closest('.slot').dataset.partId].note = ta.value;
      markDirty();
    });

    // Remove photo (delegated click)
    els.main.addEventListener('click', function (e) {
      var rm = e.target.closest('.slot__remove');
      if (!rm) return;
      clearSlot(rm.closest('.slot').dataset.partId);
    });

    // Drag & drop onto a surface slot (delegated)
    els.main.addEventListener('dragover', function (e) {
      var drop = e.target.closest('.slot__drop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.add('is-dragover');
    });
    els.main.addEventListener('dragleave', function (e) {
      var drop = e.target.closest('.slot__drop');
      if (!drop) return;
      if (!drop.contains(e.relatedTarget)) drop.classList.remove('is-dragover');
    });
    els.main.addEventListener('drop', function (e) {
      var drop = e.target.closest('.slot__drop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.remove('is-dragover');
      var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) setSlotFile(drop.closest('.slot').dataset.partId, file);
    });

    // Action bar
    els.generateBtn.addEventListener('click', generate);
    els.downloadBtn.addEventListener('click', function () {
      if (state.lastBlob) triggerDownload(state.lastBlob, state.lastFolder + '.zip');
    });
    els.nextBtn.addEventListener('click', nextUnit);
    els.historyBtn.addEventListener('click', openHistory);

    // History modal
    els.historyModal.addEventListener('click', function (e) {
      if (e.target.closest('[data-close-history]')) { closeHistory(); return; }
      var v = e.target.closest('[data-hist-view]');
      if (v) { renderHistoryDetail(Number(v.dataset.histView)); return; }
      var d = e.target.closest('[data-hist-dl]');
      if (d) { reDownload(Number(d.dataset.histDl)); return; }
    });
    els.historyBack.addEventListener('click', renderHistoryList);
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !els.historyModal.hidden) closeHistory();
    });

    // Stop the browser from opening a file dropped outside a slot.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!(e.target.closest && e.target.closest('.slot__drop'))) e.preventDefault();
    });

    // Best-effort cleanup of any live object URLs on unload.
    window.addEventListener('pagehide', function () {
      PARTS.forEach(function (p) {
        var s = state.slots[p.id];
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      });
      revokeDetailUrls();
    });
  }

  // ===================== Init =====================

  renderSlots();
  state.model = els.modelInput.value || '';
  state.unit = els.unitInput.value || '01';
  wire();
  updateCounts();
  updateFolderPreview();
  setStatus('idle');
})();
