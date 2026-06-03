/*
 * QC Photo Organizer — client-only logic.
 * Users fill in a product model + unit number and attach up to 11 photos (one
 * per fixed surface). Each surface has a "has defect" checkbox; when checked, a
 * defect gallery appears where the inspector can add MULTIPLE defect photos, each
 * with its own note. A final "extra files" area accepts PDF / Word / image
 * attachments. Export is a ZIP that unzips into a single folder `{model}-{unit}`
 * with sub-folders 外部 / 内部 (overview photos), 瑕疵/外部 + 瑕疵/内部 (defect
 * photos) and 附件 (attachments), plus a `质检备注.csv` manifest. Everything runs
 * in the browser; no backend.
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
  const ATTACH_FOLDER = '附件';
  const GROUP_TOTALS = PARTS.reduce(function (acc, p) {
    acc[p.group] = (acc[p.group] || 0) + 1;
    return acc;
  }, {});

  // Unique ids for dynamically added defect/attachment entries (DOM <-> state).
  var uidSeq = 0;
  function nextUid() { uidSeq += 1; return 'k' + uidSeq; }

  // ---- Runtime state ----
  // slots[id] = { file, previewUrl, ext, hasDefect, defects: [] }
  //   defects[] = { uid, file, note, previewUrl, ext }
  // attachments[] = { uid, file, ext }
  const state = {
    model: '',
    unit: '01',
    slots: {},
    attachments: [],
    status: 'idle',   // 'idle' | 'generating' | 'ready'
    history: [],      // newest first; see recordHistory()
    lastBlob: null,   // current export blob, for the "下载" button
    lastFolder: '',
  };
  PARTS.forEach(function (p) {
    state.slots[p.id] = { file: null, previewUrl: null, ext: '', hasDefect: false, defects: [] };
  });

  // ---- DOM refs (script is deferred, so the DOM is ready) ----
  const els = {
    main: document.getElementById('main'),
    modelInput: document.getElementById('model-input'),
    unitInput: document.getElementById('unit-input'),
    folderPreview: document.getElementById('folder-preview'),
    countNum: document.getElementById('count-num'),
    countDefect: document.getElementById('count-defect'),
    countAttach: document.getElementById('count-attach'),
    attachList: document.querySelector('[data-attach-list]'),
    attachCount: document.querySelector('[data-attach-count]'),
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

  // Sanitize an attachment's original filename, preserving its extension.
  function sanitizeAttachmentName(name) {
    var raw = String(name == null ? '' : name);
    var dot = raw.lastIndexOf('.');
    var base = dot > 0 ? raw.slice(0, dot) : raw;
    var ext = dot > 0 ? raw.slice(dot + 1) : '';
    base = sanitizeFilename(base, '附件');
    var safeExt = ext.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
    return safeExt ? base + '.' + safeExt : base;
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

  function formatSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
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

  // Total defect photos across all surfaces.
  function countDefectPhotos() {
    var n = 0;
    for (var i = 0; i < PARTS.length; i++) n += state.slots[PARTS[i].id].defects.length;
    return n;
  }

  // Surfaces that have at least one defect photo.
  function countDefectSurfaces() {
    var n = 0;
    for (var i = 0; i < PARTS.length; i++) if (state.slots[PARTS[i].id].defects.length) n++;
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
        '<div class="slot__defects" hidden>' +
          '<div class="slot__defects-list"></div>' +
          '<label class="defect-add">' +
            '<input class="defect-add-input visually-hidden" type="file" accept="image/*" capture="environment" multiple aria-label="添加' + l + '瑕疵照片" />' +
            '<span class="defect-add__btn">+ 添加瑕疵照片</span>' +
          '</label>' +
        '</div>' +
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

  // ---- Per-surface defect gallery ----

  function defectItemMarkup(entry, index) {
    var thumb;
    if (entry.previewUrl) {
      thumb = '<div class="defect-item__thumb"><img alt="瑕疵' + index + '预览" src="' + entry.previewUrl + '" /></div>';
    } else {
      thumb = '<div class="defect-item__thumb defect-item__thumb--none">' +
        '<span>无法预览</span><small>' + escapeHtml(entry.file ? entry.file.name : '') + '</small></div>';
    }
    return '' +
      '<div class="defect-item" data-defect-uid="' + entry.uid + '">' +
        thumb +
        '<div class="defect-item__body">' +
          '<div class="defect-item__head">' +
            '<span class="defect-item__tag">瑕疵' + index + '</span>' +
            '<button class="defect-item__remove" type="button" aria-label="移除瑕疵' + index + '">✕</button>' +
          '</div>' +
          '<textarea class="defect-item__note" rows="2" placeholder="请描述该瑕疵（方便溯源）" aria-label="瑕疵' + index + '备注">' +
            escapeHtml(entry.note || '') +
          '</textarea>' +
        '</div>' +
      '</div>';
  }

  // Re-render a surface's defect list from state. Notes are written to state on
  // input, so rebuilding innerHTML never loses data (only on add/remove).
  function renderDefects(id) {
    var card = cardFor(id);
    if (!card) return;
    var list = card.querySelector('.slot__defects-list');
    if (!list) return;
    var defects = state.slots[id].defects;
    list.innerHTML = defects.map(function (e, i) { return defectItemMarkup(e, i + 1); }).join('');
  }

  function addDefectPhotos(id, files) {
    var slot = state.slots[id];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      slot.defects.push({
        uid: nextUid(),
        file: f,
        note: '',
        previewUrl: isRenderable(f) ? URL.createObjectURL(f) : null,
        ext: fileExt(f),
      });
    }
    renderDefects(id);
    updateCounts();
    markDirty();
    updateActionBar();
  }

  function removeDefect(id, uid) {
    var defects = state.slots[id].defects;
    for (var i = 0; i < defects.length; i++) {
      if (defects[i].uid === uid) {
        if (defects[i].previewUrl) URL.revokeObjectURL(defects[i].previewUrl);
        defects.splice(i, 1);
        break;
      }
    }
    renderDefects(id);
    updateCounts();
    markDirty();
    updateActionBar();
  }

  // ===================== Attachments (extra files) =====================

  function attachItemMarkup(a) {
    var ext = (a.ext || extFromName(a.file.name) || '').toUpperCase();
    var badge = ext ? '<span class="attach-item__ext">' + escapeHtml(ext) + '</span>' : '';
    return '' +
      '<div class="attach-item" data-attach-uid="' + a.uid + '">' +
        '<svg class="attach-item__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6H6Zm7 1.5L18.5 9H13V3.5Z"/></svg>' +
        '<span class="attach-item__name">' + escapeHtml(a.file.name) + '</span>' +
        badge +
        '<span class="attach-item__size">' + formatSize(a.file.size) + '</span>' +
        '<button class="attach-item__remove" type="button" aria-label="移除该文件">✕</button>' +
      '</div>';
  }

  function renderAttachments() {
    els.attachList.innerHTML = state.attachments.map(attachItemMarkup).join('');
    els.attachCount.textContent = state.attachments.length ? state.attachments.length + ' 个' : '';
  }

  function addAttachments(files) {
    for (var i = 0; i < files.length; i++) {
      state.attachments.push({ uid: nextUid(), file: files[i], ext: fileExt(files[i]) });
    }
    renderAttachments();
    updateCounts();
    markDirty();
    updateActionBar();
  }

  function removeAttachment(uid) {
    for (var i = 0; i < state.attachments.length; i++) {
      if (state.attachments[i].uid === uid) { state.attachments.splice(i, 1); break; }
    }
    renderAttachments();
    updateCounts();
    markDirty();
    updateActionBar();
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
    var dp = countDefectPhotos();
    els.countDefect.textContent = dp > 0 ? (' · 瑕疵 ' + dp) : '';
    var ac = state.attachments.length;
    els.countAttach.textContent = ac > 0 ? (' · 附件 ' + ac) : '';
  }

  function updateFolderPreview() {
    var base = sanitizeFilename(state.model) + '-' + sanitizeFilename(effectiveUnit());
    els.folderPreview.textContent = state.model.trim() ? '将生成文件夹：' + base : '';
  }

  function updateActionBar() {
    var valid = state.model.trim().length > 0;
    var pc = countPhotos();
    var dp = countDefectPhotos();
    var ac = state.attachments.length;

    els.generateBtn.disabled = state.status === 'generating' ? true : !valid;

    if (!valid) {
      els.hint.textContent = '请填写产品型号';
      els.hint.dataset.tone = 'warn';
    } else if (state.status === 'ready') {
      els.hint.textContent = '已生成，可下载或继续“下一台”';
      els.hint.dataset.tone = 'ok';
    } else if (pc > 0 || dp > 0 || ac > 0) {
      var bits = [];
      if (pc > 0) bits.push(pc + ' 张照片');
      if (dp > 0) bits.push('瑕疵 ' + dp + ' 张');
      if (ac > 0) bits.push('附件 ' + ac + ' 个');
      els.hint.textContent = '将导出 ' + bits.join(' + ') + ' + 备注';
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
    // The defect flag and defect photos are intentionally kept.
    updateSlotView(id);
    updateCounts();
    markDirty();
    updateActionBar();
  }

  function setDefect(id, on) {
    var slot = state.slots[id];
    // Unchecking with existing defect photos: confirm before discarding them.
    if (!on && slot.defects.length > 0) {
      if (!window.confirm('取消勾选会移除已添加的 ' + slot.defects.length + ' 张瑕疵照片，确定吗？')) {
        var revertCard = cardFor(id);
        if (revertCard) {
          var c = revertCard.querySelector('.slot__defect-check');
          if (c) c.checked = true;
        }
        return;
      }
      slot.defects.forEach(function (d) { if (d.previewUrl) URL.revokeObjectURL(d.previewUrl); });
      slot.defects = [];
    }
    slot.hasDefect = on;
    var card = cardFor(id);
    if (card) {
      card.dataset.defect = on ? 'on' : '';
      var area = card.querySelector('.slot__defects');
      if (area) area.hidden = !on;
      renderDefects(id);
    }
    updateCounts();
    markDirty();
    updateActionBar();
  }

  // ===================== ZIP + CSV =====================

  function buildCsv(model, unit, partCount, defectPhotoCount, defectSurfaceCount, attachCount, rows) {
    var BOM = '\uFEFF'; // makes Excel/WPS read the file as UTF-8 (avoids garbled Chinese)
    var CRLF = '\r\n';
    var L = [];
    L.push('型号,' + csvEscape(model));
    L.push('编号,' + csvEscape(unit));
    L.push('生成时间,' + csvEscape(formatNow()));
    L.push('部位照片,' + partCount + '/' + TOTAL);
    L.push('瑕疵照片,' + defectPhotoCount + ' 张（' + defectSurfaceCount + ' 个部位）');
    L.push('附件,' + attachCount + ' 个');
    L.push('');
    L.push('类别,部位,类型,文件名,瑕疵备注');
    rows.forEach(function (r) {
      L.push([
        csvEscape(r.category), csvEscape(r.label), csvEscape(r.type),
        csvEscape(r.path), csvEscape(r.note),
      ].join(','));
    });
    return BOM + L.join(CRLF) + CRLF;
  }

  // Build the export blob from a slots map + attachments list (shared by generate
  // and re-download). Overview photos go into 外部/内部; defect photos into
  // 瑕疵/外部 or 瑕疵/内部 (named ...-瑕疵N); attachments into 附件. STORE (no
  // deflate) keeps it fast on phones; sub-folders are created lazily.
  function buildZipBlob(model, unit, slots, attachments) {
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
    var defectPhotoCount = 0;
    var defectSurfaceCount = 0;

    PARTS.forEach(function (part) {
      var slot = slots[part.id] || {};
      var groupDir = GROUP_FOLDER[part.group];

      var overviewPath = '';
      if (slot.file) {
        var ext = slot.ext || extFromMime(slot.file.type) || 'bin';
        var fname = folderBase + '-' + sanitizeFilename(part.label) + '.' + ext;
        overviewPath = addTo(groupDir, fname, slot.file);
        partCount++;
      }
      rows.push({ category: groupDir, label: part.label, type: '总览', path: overviewPath, note: '' });

      var defects = slot.defects || [];
      if (defects.length > 0) defectSurfaceCount++;
      defects.forEach(function (d, i) {
        if (!d.file) return;
        var dext = d.ext || extFromMime(d.file.type) || 'bin';
        var dname = folderBase + '-' + sanitizeFilename(part.label) + '-瑕疵' + (i + 1) + '.' + dext;
        var dpath = addTo(DEFECT_FOLDER + '/' + groupDir, dname, d.file);
        defectPhotoCount++;
        rows.push({ category: groupDir, label: part.label, type: '瑕疵', path: dpath, note: (d.note || '').trim() });
      });
    });

    var attachCount = 0;
    (attachments || []).forEach(function (a) {
      if (!a.file) return;
      var apath = addTo(ATTACH_FOLDER, sanitizeAttachmentName(a.file.name), a.file);
      attachCount++;
      rows.push({ category: ATTACH_FOLDER, label: '', type: '附件', path: apath, note: '' });
    });

    root.file('质检备注.csv', buildCsv(model, unit, partCount, defectPhotoCount, defectSurfaceCount, attachCount, rows));

    return zip.generateAsync({ type: 'blob', compression: 'STORE' }).then(function (blob) {
      return {
        blob: blob, folderBase: folderBase, count: partCount,
        defectCount: defectPhotoCount, defectSurfaceCount: defectSurfaceCount, attachCount: attachCount,
      };
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

    if (countPhotos() === 0 && countDefectPhotos() === 0 && state.attachments.length === 0) {
      if (!window.confirm('未选择任何照片或文件，仍要生成（仅包含备注清单）？')) return;
    }

    var unit = effectiveUnit();
    state.unit = unit;
    els.unitInput.value = unit; // reflect the normalised value (e.g. blank -> 01)

    setStatus('generating');
    showOverlay('spinner', '正在生成…');

    buildZipBlob(model, unit, state.slots, state.attachments).then(function (res) {
      state.lastBlob = res.blob;
      state.lastFolder = res.folderBase;
      triggerDownload(res.blob, res.folderBase + '.zip');
      recordHistory(res, model, unit);
      var extra = res.defectCount > 0 ? '（瑕疵 ' + res.defectCount + ' 张）' : '';
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

  function recordHistory(res, model, unit) {
    var snap = {};
    PARTS.forEach(function (p) {
      var s = state.slots[p.id];
      var defectsSnap = s.defects.map(function (d) { return { file: d.file, note: d.note, ext: d.ext }; });
      snap[p.id] = { file: s.file, ext: s.ext, hasDefect: s.hasDefect, defects: defectsSnap };
    });
    var attachSnap = state.attachments.map(function (a) { return { file: a.file, ext: a.ext }; });
    state.history.unshift({
      folderName: res.folderBase,
      model: model,
      unit: unit,
      timestamp: formatNow(),
      photoCount: res.count,
      defectCount: res.defectCount,
      defectSurfaceCount: res.defectSurfaceCount,
      attachCount: res.attachCount,
      slots: snap,
      attachments: attachSnap,
    });
    updateActionBar();
  }

  function nextUnit() {
    PARTS.forEach(function (p) {
      var s = state.slots[p.id];
      if (s.previewUrl) { URL.revokeObjectURL(s.previewUrl); s.previewUrl = null; }
      s.defects.forEach(function (d) { if (d.previewUrl) URL.revokeObjectURL(d.previewUrl); });
      s.file = null; s.ext = ''; s.hasDefect = false; s.defects = [];
    });
    state.attachments = [];
    state.unit = incrementUnit(effectiveUnit());
    els.unitInput.value = state.unit;
    state.lastBlob = null;
    state.lastFolder = '';

    renderSlots();        // fresh DOM: empty slots, unchecked defects, no galleries
    renderAttachments();  // clears the extra-files list
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
      var bits = [h.photoCount + ' 张'];
      if (h.defectCount) bits.push('瑕疵 ' + h.defectCount);
      if (h.attachCount) bits.push('附件 ' + h.attachCount);
      return '' +
        '<div class="hist-item">' +
          '<div class="hist-item__main">' +
            '<div class="hist-item__name">' + escapeHtml(h.folderName) + '</div>' +
            '<div class="hist-item__meta">' + bits.join(' · ') + ' · ' + escapeHtml(h.timestamp) + '</div>' +
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
      var defects = s.defects || [];
      var badge = defects.length ? '<span class="hist-defect-badge">瑕疵 ' + defects.length + '</span>' : '';
      var defectHtml = '';
      if (defects.length) {
        defectHtml = '<div class="hist-defect-grid">' + defects.map(function (d, i) {
          var note = (d.note || '').trim();
          return '<div class="hist-defect-cell">' +
            detailThumb(d.file, p.label + ' 瑕疵' + (i + 1)) +
            '<div class="hist-defect-note' + (note ? '' : ' is-empty') + '">' +
              (note ? escapeHtml(note) : '（未填写备注）') +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      }
      return '' +
        '<div class="hist-detail-item">' +
          detailThumb(s.file, p.label) +
          '<div class="hist-detail-meta">' +
            '<div class="hist-detail-part">' + escapeHtml(p.label) + badge + '</div>' +
            defectHtml +
          '</div>' +
        '</div>';
    }).join('');

    var attachHtml = '';
    if (h.attachments && h.attachments.length) {
      attachHtml = '<div class="hist-attach">' +
        '<div class="hist-attach__title">附件 ' + h.attachments.length + ' 个</div>' +
        h.attachments.map(function (a) {
          return '<div class="hist-attach__item">' + escapeHtml(a.file ? a.file.name : '') + '</div>';
        }).join('') +
      '</div>';
    }

    var metaBits = [h.photoCount + ' 张照片'];
    if (h.defectCount) metaBits.push(h.defectCount + ' 张瑕疵');
    if (h.attachCount) metaBits.push(h.attachCount + ' 个附件');
    els.historyBody.innerHTML = '' +
      '<div class="hist-detail-head">' +
        '<span>' + metaBits.join(' · ') + ' · ' + escapeHtml(h.timestamp) + '</span>' +
        '<button class="btn btn--secondary" type="button" data-hist-dl="' + index + '">重新下载</button>' +
      '</div>' +
      '<div class="hist-detail-grid">' + cards + '</div>' +
      attachHtml;
  }

  function reDownload(index) {
    var h = state.history[index];
    if (!h) return;
    showToast('正在打包…');
    buildZipBlob(h.model, h.unit, h.slots, h.attachments).then(function (res) {
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

    // File selection + defect checkbox (delegated change)
    els.main.addEventListener('change', function (e) {
      var input = e.target.closest('.slot__input');
      if (input) {
        var fcard = input.closest('.slot');
        var file = input.files && input.files[0];
        if (file) setSlotFile(fcard.dataset.partId, file);
        input.value = ''; // allow re-selecting the same file later
        return;
      }
      var dadd = e.target.closest('.defect-add-input');
      if (dadd) {
        var dcard = dadd.closest('.slot');
        if (dadd.files && dadd.files.length) addDefectPhotos(dcard.dataset.partId, dadd.files);
        dadd.value = '';
        return;
      }
      var aadd = e.target.closest('.attach-add-input');
      if (aadd) {
        if (aadd.files && aadd.files.length) addAttachments(aadd.files);
        aadd.value = '';
        return;
      }
      var chk = e.target.closest('.slot__defect-check');
      if (chk) {
        setDefect(chk.closest('.slot').dataset.partId, chk.checked);
      }
    });

    // Defect notes (delegated input)
    els.main.addEventListener('input', function (e) {
      var ta = e.target.closest('.defect-item__note');
      if (!ta) return;
      var card = ta.closest('.slot');
      var item = ta.closest('.defect-item');
      if (!card || !item) return;
      var defects = state.slots[card.dataset.partId].defects;
      var uid = item.dataset.defectUid;
      for (var i = 0; i < defects.length; i++) {
        if (defects[i].uid === uid) { defects[i].note = ta.value; break; }
      }
      markDirty();
    });

    // Remove buttons: overview photo, defect photo, attachment (delegated click)
    els.main.addEventListener('click', function (e) {
      var rm = e.target.closest('.slot__remove');
      if (rm) { clearSlot(rm.closest('.slot').dataset.partId); return; }
      var drm = e.target.closest('.defect-item__remove');
      if (drm) {
        var dc = drm.closest('.slot');
        var di = drm.closest('.defect-item');
        removeDefect(dc.dataset.partId, di.dataset.defectUid);
        return;
      }
      var arm = e.target.closest('.attach-item__remove');
      if (arm) { removeAttachment(arm.closest('.attach-item').dataset.attachUid); return; }
    });

    // Drag & drop onto a surface slot or the attachments area (delegated)
    els.main.addEventListener('dragover', function (e) {
      var drop = e.target.closest('.slot__drop, .attach-drop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.add('is-dragover');
    });
    els.main.addEventListener('dragleave', function (e) {
      var drop = e.target.closest('.slot__drop, .attach-drop');
      if (!drop) return;
      if (!drop.contains(e.relatedTarget)) drop.classList.remove('is-dragover');
    });
    els.main.addEventListener('drop', function (e) {
      var drop = e.target.closest('.slot__drop, .attach-drop');
      if (!drop) return;
      e.preventDefault();
      drop.classList.remove('is-dragover');
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || !files.length) return;
      if (drop.classList.contains('attach-drop')) { addAttachments(files); return; }
      setSlotFile(drop.closest('.slot').dataset.partId, files[0]);
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

    // Stop the browser from opening a file dropped outside a drop zone.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) {
      if (!(e.target.closest && e.target.closest('.slot__drop, .attach-drop'))) e.preventDefault();
    });

    // Best-effort cleanup of any live object URLs on unload.
    window.addEventListener('pagehide', function () {
      PARTS.forEach(function (p) {
        var s = state.slots[p.id];
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
        s.defects.forEach(function (d) { if (d.previewUrl) URL.revokeObjectURL(d.previewUrl); });
      });
      revokeDetailUrls();
    });
  }

  // ===================== Init =====================

  renderSlots();
  renderAttachments();
  state.model = els.modelInput.value || '';
  state.unit = els.unitInput.value || '01';
  wire();
  updateCounts();
  updateFolderPreview();
  setStatus('idle');
})();
