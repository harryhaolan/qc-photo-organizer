/*
 * 主管复检（Supervisor review）— 纯前端，零后端。
 * 主管导入质检员生成的「型号-编号.zip」(可多台),逐台:
 *   1) 浏览原始质检照片(从 ZIP 内解出缩略图,可点开大图);
 *   2) 给出复核结论 合格/不合格 + 备注;
 *   3) 补拍包装箱 前/后/左/右/上 5 面照片;
 *   4) 生成「型号-编号-主管复检.zip」: 原始照片原样收进 `原始质检/`,
 *      包装照片进 `包装/`,外加 `主管复检报告.csv`(含原始 + 复核信息)。
 * 全程在浏览器内完成,主管手机/电脑都能用。
 */
(function () {
  'use strict';

  // 包装箱 5 个面(顺序即展示顺序)
  var PACK_FACES = [
    { id: 'front', label: '前' },
    { id: 'back',  label: '后' },
    { id: 'left',  label: '左' },
    { id: 'right', label: '右' },
    { id: 'top',   label: '上' },
  ];
  var IMG_EXT = ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'heic', 'heif', 'tif', 'tiff'];

  // 与质检端一致的部位顺序(总览照片按此排序,和拍照界面一一对应)
  var PART_ORDER = [
    '背面', '左侧板', '正面', '右侧板', '顶板', '玻璃',
    '内侧板（左）', '内侧板（右）', '内背板', '内顶板', '坐板', '坐前板', '脚板', '温度控制面板',
  ];
  // 复核照片分组(顺序即展示顺序),对应质检 ZIP 的子目录
  // 瑕疵单独走「瑕疵复检」卡片(可补复检后照片),不在只读相册里展示
  var GAL_GROUPS = [
    { key: 'ext', title: '外部' },
    { key: 'int', title: '内部' },
    { key: 'attach', title: '附件' },
    { key: 'other', title: '其他' },
  ];

  var els = {
    viewUpload: document.getElementById('view-upload'),
    viewReview: document.getElementById('view-review'),
    drop: document.getElementById('drop'),
    zipInput: document.getElementById('zip-input'),
    queueWrap: document.getElementById('queue-wrap'),
    queue: document.getElementById('queue'),
    queueCount: document.getElementById('queue-count'),
    queueSummary: document.getElementById('queue-summary'),
    rvBack: document.getElementById('rv-back'),
    rvInfo: document.getElementById('rv-info'),
    rvGallery: document.getElementById('rv-gallery'),
    rvPhotoCount: document.getElementById('rv-photo-count'),
    rvVerdict: document.getElementById('rv-verdict'),
    rvVerdictHint: document.getElementById('rv-verdict-hint'),
    rvNote: document.getElementById('rv-note'),
    rvDefectCard: document.getElementById('rv-defect-card'),
    rvDefects: document.getElementById('rv-defects'),
    rvDefectCount: document.getElementById('rv-defect-count'),
    rvPack: document.getElementById('rv-pack'),
    rvPackCount: document.getElementById('rv-pack-count'),
    rvGenerate: document.getElementById('rv-generate'),
    rvSaveDraft: document.getElementById('rv-save-draft'),
    lb: document.getElementById('lb'),
    lbImg: document.getElementById('lb-img'),
    overlay: document.getElementById('overlay'),
    toast: document.getElementById('toast'),
  };

  // units[] = { id, fileName, zip, folderBase, model, unit, inspector,
  //   imageEntries:[{path,name}], csvText, verdict, note,
  //   packaging:{ front:{file,url}, ... }, status:'wait'|'合格'|'不合格', galleryUrls:[] }
  var state = { units: [], current: -1, uidSeq: 0 };

  // ---------- helpers ----------
  function uid() { state.uidSeq += 1; return 'u' + state.uidSeq; }
  function extOf(name) { var m = /\.([A-Za-z0-9]+)$/.exec(name || ''); return m ? m[1].toLowerCase() : ''; }
  function isImage(name) { return IMG_EXT.indexOf(extOf(name)) !== -1; }
  function baseName(name) { var s = String(name || ''); var i = s.lastIndexOf('/'); return i >= 0 ? s.slice(i + 1) : s; }

  // 质检 ZIP 路径形如 `型号-编号/外部/型号-编号-正面.jpg`(瑕疵在 瑕疵/外部|内部)。
  // 用顶层子目录判定分组。
  function classifyEntry(path, folderBase) {
    var segs = path.split('/');
    var fname = segs[segs.length - 1] || '';
    // 不依赖顶层文件夹名是否与文件名一致:按已知目录段或文件名特征判定。
    // 「瑕疵」要最先判(瑕疵照片在 瑕疵/外部|内部 下,路径里也含 外部/内部)。
    if (segs.indexOf('瑕疵') !== -1 || /[-_]瑕疵\d+/.test(fname)) return 'defect';
    if (segs.indexOf('附件') !== -1) return 'attach';
    if (segs.indexOf('外部') !== -1) return 'ext';
    if (segs.indexOf('内部') !== -1) return 'int';
    return 'other';
  }
  // 去掉「型号-编号-」前缀与扩展名,得到友好标签:正面 / 正面-瑕疵1-毛刺。
  function labelOf(name, folderBase) {
    var n = String(name || '');
    var dot = n.lastIndexOf('.'); if (dot > 0) n = n.slice(0, dot);
    if (folderBase && n.indexOf(folderBase + '-') === 0) n = n.slice(folderBase.length + 1);
    return n || name;
  }
  // 不打开复检即可统计:一张「瑕疵」照片记为一处瑕疵(与 ensureDefects 口径一致)。
  function defectCountOf(u) {
    return u.imageEntries.filter(function (e) {
      return classifyEntry(e.path, u.folderBase) === 'defect';
    }).length;
  }
  function partRank(label) {
    var i = PART_ORDER.indexOf(label);
    return i === -1 ? 999 : i;
  }
  function sortGroupItems(key, arr) {
    arr.sort(function (a, b) {
      if (key === 'ext' || key === 'int') {
        var ra = partRank(a.label), rb = partRank(b.label);
        if (ra !== rb) return ra - rb;
      }
      return a.label < b.label ? -1 : (a.label > b.label ? 1 : 0);
    });
    return arr;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function csvEscape(v) {
    var s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function fmtNow() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  var toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg; els.toast.classList.add('on');
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { els.toast.classList.remove('on'); }, 2200);
  }
  function showOverlay(on) { els.overlay.classList.toggle('on', !!on); }

  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  // ---------- IndexedDB draft store (本机暂存待终审草稿) ----------
  // File 对象经结构化克隆存入 IndexedDB 会保留(含 name),刷新/关页后仍在。
  var DB_NAME = 'qc-supervisor', STORE = 'drafts';
  function idbOpen() {
    return new Promise(function (res, rej) {
      if (!window.indexedDB) { rej(new Error('浏览器不支持本机暂存')); return; }
      var r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE, { keyPath: 'key' }); };
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }
  function idbPut(obj) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(obj);
        tx.oncomplete = function () { db.close(); res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }
  function idbAll() {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readonly');
        var rq = tx.objectStore(STORE).getAll();
        rq.onsuccess = function () { db.close(); res(rq.result || []); };
        rq.onerror = function () { rej(rq.error); };
      });
    });
  }
  function idbDel(key) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = function () { db.close(); res(); };
        tx.onerror = function () { rej(tx.error); };
      });
    });
  }

  // ---------- load ZIPs ----------
  function handleFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) {
      return /\.zip$/i.test(f.name) || f.type === 'application/zip';
    });
    if (!files.length) { toast('请选择 .zip 文件'); return; }
    showOverlay(true);
    var jobs = files.map(function (f) { return loadOneZip(f); });
    Promise.all(jobs).then(function (results) {
      var added = results.filter(Boolean).length;
      showOverlay(false);
      renderQueue();
      if (added) toast('已导入 ' + added + ' 台');
      else toast('未能解析所选 ZIP');
    }).catch(function (err) {
      console.error(err); showOverlay(false); toast('导入失败：' + (err && err.message ? err.message : err));
    });
  }

  function loadOneZip(file) {
    return JSZip.loadAsync(file).then(function (zip) {
      var entries = [];
      zip.forEach(function (path, obj) { if (!obj.dir) entries.push(path); });
      if (!entries.length) return null;

      // 推断 型号-编号 文件夹名:优先用「质检备注.csv」所在的顶层目录,其次用
      // 出现最多的顶层目录(忽略 __MACOSX 等杂项),最后退回压缩包文件名。
      var csvEntry = entries.filter(function (p) { return /质检备注\.csv$/.test(p); })[0];
      var folderBase;
      if (csvEntry && csvEntry.indexOf('/') !== -1) {
        folderBase = csvEntry.split('/')[0];
      } else {
        var counts = {};
        entries.forEach(function (p) {
          var seg = p.indexOf('/') !== -1 ? p.split('/')[0] : '';
          if (seg && seg !== '__MACOSX') counts[seg] = (counts[seg] || 0) + 1;
        });
        var best = '', bestN = 0;
        Object.keys(counts).forEach(function (k) { if (counts[k] > bestN) { bestN = counts[k]; best = k; } });
        folderBase = best || file.name.replace(/\.zip$/i, '');
      }

      var imageEntries = entries.filter(isImage).map(function (p) { return { path: p, name: baseName(p) }; });

      var unitObj = {
        id: uid(), fileName: file.name, sourceFile: file, zip: zip, folderBase: folderBase,
        model: '', unit: '', inspector: '',
        imageEntries: imageEntries, csvText: '',
        verdict: '', note: '', status: 'wait', draftKey: null,
        packaging: {}, galleryUrls: [],
      };

      // 读 质检备注.csv 拿 型号/编号/质检员
      var csvPath = entries.filter(function (p) { return /质检备注\.csv$/.test(p); })[0];
      var csvP = csvPath
        ? zip.file(csvPath).async('string').then(function (txt) { unitObj.csvText = txt; parseMeta(unitObj, txt); })
        : Promise.resolve();

      return csvP.then(function () {
        // 没有 CSV 就尝试从 folderBase 推断 型号/编号(最后一个 '-' 后为编号)
        if (!unitObj.model && folderBase) {
          var dash = folderBase.lastIndexOf('-');
          if (dash > 0) { unitObj.model = folderBase.slice(0, dash); unitObj.unit = folderBase.slice(dash + 1); }
          else unitObj.model = folderBase;
        }
        // 同一 型号-编号 已在列表(含已暂存草稿)则不重复加入,避免覆盖进度
        var dup = state.units.filter(function (x) { return x.folderBase === unitObj.folderBase; })[0];
        if (dup) return null;
        state.units.push(unitObj);
        return unitObj;
      });
    }).catch(function (err) { console.error('解析失败', file.name, err); return null; });
  }

  function parseMeta(unitObj, csvText) {
    var lines = String(csvText || '').replace(/^﻿/, '').split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      var c = ln.indexOf(',');
      if (c < 0) continue;
      var k = ln.slice(0, c).trim();
      var v = ln.slice(c + 1).trim().replace(/^"|"$/g, '');
      if (k === '型号') unitObj.model = v;
      else if (k === '编号') unitObj.unit = v;
      else if (k === '质检员') unitObj.inspector = v;
    }
  }

  // ---------- queue view ----------
  function renderQueue() {
    els.queueWrap.classList.toggle('hide', state.units.length === 0);
    els.queueCount.textContent = state.units.length;
    els.queue.innerHTML = state.units.map(function (u, i) {
      var pillClass = u.status === '合格' ? 'ok' : (u.status === '不合格' ? 'bad' : (u.status === 'draft' ? 'draft' : 'wait'));
      var pillText = u.status === 'wait' ? '待复核' : (u.status === 'draft' ? '待终审' : u.status);
      var metaBits = [];
      if (u.unit) metaBits.push('编号 ' + u.unit);
      if (u.inspector) metaBits.push('质检员 ' + u.inspector);
      metaBits.push(u.imageEntries.length + ' 张');
      if (u.status === 'draft' && u.savedAt) metaBits.push('暂存 ' + u.savedAt);
      var openText = u.status === 'draft' ? '继续终审' : '检查';
      return '' +
        '<div class="unit">' +
          '<div class="unit__main">' +
            '<div class="unit__name">' + escapeHtml(u.model || u.folderBase || u.fileName) + '</div>' +
            '<div class="unit__meta">' + escapeHtml(metaBits.join(' · ')) + '</div>' +
          '</div>' +
          '<span class="pill ' + pillClass + '">' + escapeHtml(pillText) + '</span>' +
          '<button class="btn" data-open="' + i + '">' + openText + '</button>' +
          '<button class="unit__del" data-del="' + i + '" aria-label="移除">✕</button>' +
        '</div>';
    }).join('');
    renderSummary();
  }

  // 汇总:导入的全部 ZIP 共多少台、合计多少处瑕疵,并逐台列出瑕疵数。
  function renderSummary() {
    if (!els.queueSummary) return;
    var units = state.units;
    if (!units.length) { els.queueSummary.innerHTML = ''; return; }

    var rows = units.map(function (u) { return { u: u, n: defectCountOf(u) }; });
    var totalDefects = rows.reduce(function (s, r) { return s + r.n; }, 0);
    var machinesWithDefect = rows.filter(function (r) { return r.n > 0; }).length;

    var stats =
      '<div class="summary__stats">' +
        '<div class="summary__stat">' +
          '<div class="summary__num">' + units.length + '</div>' +
          '<div class="summary__lbl">导入台数</div>' +
        '</div>' +
        '<div class="summary__stat bad">' +
          '<div class="summary__num">' + totalDefects + '</div>' +
          '<div class="summary__lbl">瑕疵总数</div>' +
        '</div>' +
        '<div class="summary__stat bad">' +
          '<div class="summary__num">' + machinesWithDefect + '</div>' +
          '<div class="summary__lbl">有瑕疵台数</div>' +
        '</div>' +
      '</div>';

    var list = rows.map(function (r) {
      var name = r.u.model || r.u.folderBase || r.u.fileName;
      var unitTxt = r.u.unit ? ' <span>编号 ' + escapeHtml(r.u.unit) + '</span>' : '';
      var countCls = r.n > 0 ? 'summary__row-count' : 'summary__row-count zero';
      var countTxt = r.n > 0 ? (r.n + ' 处瑕疵') : '无瑕疵';
      return '<div class="summary__row">' +
          '<div class="summary__row-name">' + escapeHtml(name) + unitTxt + '</div>' +
          '<div class="' + countCls + '">' + countTxt + '</div>' +
        '</div>';
    }).join('');

    els.queueSummary.innerHTML = stats +
      '<div class="summary__h">逐台明细</div>' +
      '<div class="summary__list">' + list + '</div>';
  }

  // ---------- review view ----------
  function revokeGallery(u) {
    (u.galleryUrls || []).forEach(function (url) { URL.revokeObjectURL(url); });
    u.galleryUrls = [];
  }

  function openReview(index) {
    var u = state.units[index];
    if (!u) return;
    state.current = index;
    els.viewUpload.classList.add('hide');
    els.viewReview.classList.remove('hide');
    window.scrollTo(0, 0);

    // fresh start for this open: drop any stale object URLs from a previous view
    revokeGallery(u);

    // info
    var info = [];
    info.push('<b>' + escapeHtml(u.model || u.folderBase) + '</b>');
    if (u.unit) info.push('<span>编号</span> ' + escapeHtml(u.unit));
    if (u.inspector) info.push('<span>质检员</span> ' + escapeHtml(u.inspector));
    els.rvInfo.innerHTML = info.join(' &nbsp;·&nbsp; ');

    // verdict + note
    renderVerdict(u);
    els.rvNote.value = u.note || '';

    // re-create transient URLs for packaging photos (e.g. restored from a draft)
    PACK_FACES.forEach(function (f) {
      var p = u.packaging[f.id];
      if (p && p.file) { p.url = URL.createObjectURL(p.file); u.galleryUrls.push(p.url); }
      else if (p) p.url = null;
    });
    renderPackaging(u);

    // defect re-inspection (瑕疵单独成卡片,可补复检后照片)
    ensureDefects(u);
    // re-create transient URLs for any already-added repair photos
    (u.defects || []).forEach(function (d) {
      d.origUrl = null;
      if (d.repairFile) { d.repairUrl = URL.createObjectURL(d.repairFile); u.galleryUrls.push(d.repairUrl); }
      else d.repairUrl = null;
    });
    renderDefects(u);
    loadDefectThumbs(u, index);
    updateVerdictGating(u);

    // gallery (async load blobs from the zip) — defects handled above, exclude here
    var galEntries = u.imageEntries.filter(function (e) { return classifyEntry(e.path, u.folderBase) !== 'defect'; });
    els.rvPhotoCount.textContent = '(' + galEntries.length + ')';
    els.rvGallery.innerHTML = '<div class="empty">正在载入照片…</div>';
    var jobs = galEntries.map(function (e) {
      return u.zip.file(e.path).async('blob').then(function (blob) {
        var renderable = ['heic', 'heif'].indexOf(extOf(e.name)) === -1;
        var url = renderable ? URL.createObjectURL(blob) : null;
        if (url) u.galleryUrls.push(url);
        return {
          name: e.name, url: url,
          group: classifyEntry(e.path, u.folderBase),
          label: labelOf(e.name, u.folderBase),
        };
      }).catch(function () {
        return { name: e.name, url: null, group: classifyEntry(e.path, u.folderBase), label: labelOf(e.name, u.folderBase) };
      });
    });
    Promise.all(jobs).then(function (items) {
      if (state.current !== index) return; // 已离开
      if (!items.length) { els.rvGallery.innerHTML = '<div class="empty">该 ZIP 内未找到照片</div>'; return; }
      var buckets = {};
      items.forEach(function (it) { (buckets[it.group] || (buckets[it.group] = [])).push(it); });
      var html = GAL_GROUPS.map(function (g) {
        var arr = buckets[g.key];
        if (!arr || !arr.length) return '';
        sortGroupItems(g.key, arr);
        var cells = arr.map(function (it) {
          var inner = it.url
            ? '<img src="' + it.url + '" alt="' + escapeHtml(it.label) + '" data-zoom="' + it.url + '" />'
            : '<div class="gal__cell--none">无法预览</div>';
          return '<div class="gal__cell">' + inner +
            '<div class="cap">' + escapeHtml(it.label) + '</div></div>';
        }).join('');
        return '<div class="gal-group">' +
          '<div class="gal-group__h">' + escapeHtml(g.title) + ' <span>' + arr.length + '</span></div>' +
          '<div class="gal">' + cells + '</div></div>';
      }).join('');
      els.rvGallery.innerHTML = html;
    });
  }

  function renderVerdict(u) {
    var btns = els.rvVerdict.querySelectorAll('button');
    btns.forEach(function (b) {
      var v = b.dataset.v;
      b.classList.toggle('on-ok', u.verdict === '合格' && v === '合格');
      b.classList.toggle('on-bad', u.verdict === '不合格' && v === '不合格');
    });
  }

  // ---------- defect re-inspection ----------
  // Build the persistent per-unit defect list from the ZIP's 瑕疵 entries (once).
  // repairFile (the after-photo) persists across re-opens; thumb URLs are transient.
  function ensureDefects(u) {
    if (u.defects) return;
    u.defects = u.imageEntries
      .filter(function (e) { return classifyEntry(e.path, u.folderBase) === 'defect'; })
      .map(function (e) {
        return { id: uid(), path: e.path, label: labelOf(e.name, u.folderBase), name: e.name,
                 origUrl: null, repairFile: null, repairUrl: null, note: '' };
      });
  }

  function defectsResolved(u) {
    return (u.defects || []).every(function (d) { return !!d.repairFile; });
  }
  function unresolvedCount(u) {
    return (u.defects || []).filter(function (d) { return !d.repairFile; }).length;
  }

  function renderDefects(u) {
    var defects = u.defects || [];
    els.rvDefectCard.hidden = defects.length === 0;
    if (!defects.length) return;
    var done = defects.length - unresolvedCount(u);
    els.rvDefectCount.textContent = '(已修复 ' + done + '/' + defects.length + ')';
    els.rvDefects.innerHTML = defects.map(function (d) {
      var has = !!d.repairFile;
      var origThumb = d.origUrl
        ? '<img src="' + d.origUrl + '" alt="' + escapeHtml(d.label) + '" data-zoom="' + d.origUrl + '" />'
        : '<div class="dfx__thumb--none">载入中…</div>';
      var slotInner = (has && d.repairUrl)
        ? '<div class="dfx__slot-box"><img src="' + d.repairUrl + '" alt="复检后" /></div>'
        : '<div class="dfx__slot-box">＋<span>复检后照片</span></div>';
      var clearBtn = has ? '<button type="button" class="dfx__clear" data-dfx-clear="' + d.id + '">移除复检照片</button>' : '';
      return '' +
        '<div class="dfx' + (has ? ' done' : '') + '" data-dfx="' + d.id + '">' +
          '<div class="dfx__top">' +
            '<div class="dfx__thumb">' + origThumb + '</div>' +
            '<div class="dfx__meta">' +
              '<div class="dfx__label">' + escapeHtml(d.label) + '</div>' +
              '<div class="dfx__cap">原始瑕疵</div>' +
              '<span class="dfx__status ' + (has ? 'done' : 'wait') + '">' + (has ? '已修复' : '待修复') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="dfx__after">' +
            '<label class="dfx__slot' + (has ? ' has' : '') + '">' +
              '<input type="file" accept="image/*" capture="environment" aria-label="' + escapeHtml(d.label) + ' 复检后照片" />' +
              slotInner +
            '</label>' +
            '<div class="dfx__after-side">' +
              '<input class="dfx__note" type="text" placeholder="修复说明（选填，如：已打磨/已更换）" value="' + escapeHtml(d.note || '') + '" />' +
              clearBtn +
            '</div>' +
          '</div>' +
        '</div>';
    }).join('');
  }

  // Load original defect thumbnails from the ZIP, then patch their <img> in place.
  function loadDefectThumbs(u, index) {
    (u.defects || []).forEach(function (d) {
      u.zip.file(d.path).async('blob').then(function (blob) {
        if (state.current !== index) return;
        var cell = els.rvDefects.querySelector('[data-dfx="' + d.id + '"] .dfx__thumb');
        if (!cell) return;
        var renderable = ['heic', 'heif'].indexOf(extOf(d.name)) === -1;
        if (!renderable) { cell.innerHTML = '<div class="dfx__thumb--none">无法预览</div>'; return; }
        d.origUrl = URL.createObjectURL(blob);
        u.galleryUrls.push(d.origUrl);
        cell.innerHTML = '<img src="' + d.origUrl + '" alt="' + escapeHtml(d.label) + '" data-zoom="' + d.origUrl + '" />';
      }).catch(function () {
        var cell = els.rvDefects.querySelector('[data-dfx="' + d.id + '"] .dfx__thumb');
        if (cell) cell.innerHTML = '<div class="dfx__thumb--none">无法预览</div>';
      });
    });
  }

  function setRepairPhoto(dfxId, file) {
    var u = state.units[state.current];
    if (!u || !file) return;
    var d = (u.defects || []).filter(function (x) { return x.id === dfxId; })[0];
    if (!d) return;
    if (d.repairUrl) URL.revokeObjectURL(d.repairUrl);
    d.repairFile = file;
    d.repairUrl = URL.createObjectURL(file);
    u.galleryUrls.push(d.repairUrl);
    renderDefects(u);
    updateVerdictGating(u);
  }

  function clearRepairPhoto(dfxId) {
    var u = state.units[state.current];
    if (!u) return;
    var d = (u.defects || []).filter(function (x) { return x.id === dfxId; })[0];
    if (!d) return;
    if (d.repairUrl) URL.revokeObjectURL(d.repairUrl);
    d.repairFile = null; d.repairUrl = null;
    if (u.verdict === '合格') u.verdict = ''; // 撤掉修复后不能再是合格
    renderDefects(u);
    renderVerdict(u);
    updateVerdictGating(u);
  }

  // Lock the 合格 button until every defect has a re-inspection photo.
  function updateVerdictGating(u) {
    var locked = !defectsResolved(u);
    var okBtn = els.rvVerdict.querySelector('button[data-v="合格"]');
    if (okBtn) okBtn.classList.toggle('locked', locked);
    var n = unresolvedCount(u);
    var hint = els.rvVerdictHint;
    if (!u.defects || !u.defects.length) {
      hint.textContent = ''; hint.className = 'vhint';
    } else if (n > 0) {
      hint.textContent = '还有 ' + n + ' 处瑕疵未上传复检后照片，全部修复后方可判定合格。';
      hint.className = 'vhint warn';
    } else {
      hint.textContent = '全部 ' + u.defects.length + ' 处瑕疵已上传复检照片，可判定合格。';
      hint.className = 'vhint ok';
    }
  }

  function renderPackaging(u) {
    els.rvPack.innerHTML = PACK_FACES.map(function (f) {
      var p = u.packaging[f.id];
      var has = p && p.url;
      var box = has
        ? '<div class="pack__box"><img src="' + p.url + '" alt="包装箱' + f.label + '" /></div>'
        : '<div class="pack__box"><span class="pack__label">' + f.label + '</span><span class="pack__hint">点击拍照</span></div>';
      var tag = has ? '<span class="pack__tag">' + f.label + '</span>' : '';
      return '' +
        '<div class="pack' + (has ? ' has' : '') + '" data-pack="' + f.id + '">' +
          '<input type="file" accept="image/*" capture="environment" aria-label="包装箱' + f.label + '" />' +
          box + tag +
          '<button type="button" class="pack__clear" data-clear="' + f.id + '" aria-label="移除">✕</button>' +
        '</div>';
    }).join('');
    updatePackCount(u);
  }

  function updatePackCount(u) {
    var n = PACK_FACES.filter(function (f) { return u.packaging[f.id]; }).length;
    els.rvPackCount.textContent = '(' + n + '/' + PACK_FACES.length + ')';
  }

  function setPackPhoto(faceId, file) {
    var u = state.units[state.current];
    if (!u || !file) return;
    var old = u.packaging[faceId];
    if (old && old.url) URL.revokeObjectURL(old.url);
    var url = URL.createObjectURL(file);
    u.galleryUrls.push(url);
    u.packaging[faceId] = { file: file, url: url, ext: extOf(file.name) || 'jpg' };
    renderPackaging(u);
  }

  function clearPackPhoto(faceId) {
    var u = state.units[state.current];
    if (!u) return;
    var old = u.packaging[faceId];
    if (old && old.url) URL.revokeObjectURL(old.url);
    delete u.packaging[faceId];
    renderPackaging(u);
  }

  function leaveReview() {
    var u = state.units[state.current];
    if (u) revokeGallery(u);
    state.current = -1;
    els.viewReview.classList.add('hide');
    els.viewUpload.classList.remove('hide');
    renderQueue();
  }

  // ---------- generate report ----------
  function buildReportCsv(u, packCount) {
    var BOM = '﻿', CRLF = '\r\n', L = [];
    L.push('型号,' + csvEscape(u.model));
    L.push('编号,' + csvEscape(u.unit));
    L.push('原始质检员,' + csvEscape(u.inspector || ''));
    L.push('主管复核结论,' + csvEscape(u.verdict || '未填写'));
    L.push('主管复核备注,' + csvEscape(u.note || ''));
    L.push('复核时间,' + csvEscape(fmtNow()));
    L.push('原始照片数,' + u.imageEntries.length);
    L.push('包装照片数,' + packCount + '/' + PACK_FACES.length);
    var defects = u.defects || [];
    var fixed = defects.filter(function (d) { return d.repairFile; }).length;
    L.push('瑕疵处理,' + (defects.length ? ('已修复 ' + fixed + '/' + defects.length) : '无瑕疵'));
    L.push('原始来源文件,' + csvEscape(u.fileName));
    if (defects.length) {
      L.push('');
      L.push('===== 瑕疵复检明细 =====');
      L.push('瑕疵,是否修复,复检后照片,修复说明');
      defects.forEach(function (d) {
        L.push([
          csvEscape(d.label),
          d.repairFile ? '已修复' : '未修复',
          d.repairFile ? (u.folderBase + '-' + d.label + '-复检后') : '无',
          csvEscape((d.note || '').trim()),
        ].join(','));
      });
    }
    if (u.csvText) {
      L.push('');
      L.push('===== 原始质检备注 =====');
      String(u.csvText).replace(/^﻿/, '').split(/\r?\n/).forEach(function (ln) { L.push(ln); });
    }
    return BOM + L.join(CRLF) + CRLF;
  }

  function generateReport() {
    var u = state.units[state.current];
    if (!u) return;
    if (!u.verdict) {
      if (!window.confirm('还没选择复核结论（合格/不合格），仍要生成报告吗？')) return;
    }
    u.note = els.rvNote.value;
    var packCount = PACK_FACES.filter(function (f) { return u.packaging[f.id]; }).length;

    showOverlay(true);
    var out = new JSZip();
    var reportBase = u.folderBase + '-主管复检';
    var root = out.folder(reportBase);

    // 1) 原始质检照片原样收进 原始质检/
    var origDir = root.folder('原始质检');
    var copyJobs = [];
    u.zip.forEach(function (path, obj) {
      if (obj.dir) return;
      copyJobs.push(obj.async('blob').then(function (blob) { origDir.file(path, blob); }));
    });

    // 2) 包装照片进 包装/
    var packDir = root.folder('包装');
    PACK_FACES.forEach(function (f) {
      var p = u.packaging[f.id];
      if (p && p.file) packDir.file(u.folderBase + '-包装箱-' + f.label + '.' + (p.ext || 'jpg'), p.file);
    });

    // 3) 复检后照片进 瑕疵复检/
    var defects = u.defects || [];
    if (defects.length) {
      var fixDir = root.folder('瑕疵复检');
      var usedFix = {};
      defects.forEach(function (d) {
        if (!d.repairFile) return;
        var ext = extOf(d.repairFile.name) || 'jpg';
        var base = u.folderBase + '-' + d.label + '-复检后';
        var fname = base + '.' + ext;
        var n = 2; while (usedFix[fname]) { fname = base + '(' + (n++) + ').' + ext; }
        usedFix[fname] = true;
        fixDir.file(fname, d.repairFile);
      });
    }

    // 4) 复检报告 CSV
    root.file('主管复检报告.csv', buildReportCsv(u, packCount));

    Promise.all(copyJobs).then(function () {
      return out.generateAsync({ type: 'blob', compression: 'STORE' });
    }).then(function (blob) {
      triggerDownload(blob, reportBase + '.zip');
      u.status = u.verdict || '已复核';
      // 终审出报告后,清掉本机暂存的草稿
      var doneDraft = u.draftKey ? idbDel(u.draftKey).catch(function () {}) : Promise.resolve();
      u.draftKey = null;
      return doneDraft;
    }).then(function () {
      showOverlay(false);
      toast('已生成 ' + reportBase + '.zip');
      leaveReview();
    }).catch(function (err) {
      console.error(err); showOverlay(false); toast('生成失败：' + (err && err.message ? err.message : err));
    });
  }

  // ---------- draft save / restore (本机暂存待终审) ----------
  function saveDraft() {
    var u = state.units[state.current];
    if (!u) return;
    u.note = els.rvNote.value;
    ensureDefects(u);
    var draft = {
      key: u.folderBase,
      fileName: u.fileName, folderBase: u.folderBase,
      model: u.model, unit: u.unit, inspector: u.inspector,
      zipFile: u.sourceFile, csvText: u.csvText || '',
      verdict: u.verdict || '', note: u.note || '',
      status: 'draft', savedAt: fmtNow(),
      defects: (u.defects || []).map(function (d) {
        return { path: d.path, label: d.label, name: d.name, note: d.note || '', repair: d.repairFile || null };
      }),
      packaging: {},
    };
    PACK_FACES.forEach(function (f) {
      var p = u.packaging[f.id];
      if (p && p.file) draft.packaging[f.id] = p.file;
    });
    if (!draft.zipFile) { toast('该台缺少原始文件，无法暂存'); return; }

    showOverlay(true);
    idbPut(draft).then(function () {
      u.status = 'draft'; u.draftKey = u.folderBase; u.savedAt = draft.savedAt;
      showOverlay(false);
      toast('已临时保存（待终审），可交最终主管');
      leaveReview();
    }).catch(function (err) {
      console.error(err); showOverlay(false);
      toast('暂存失败：' + (err && err.message ? err.message : err));
    });
  }

  function reconstructUnit(draft) {
    return JSZip.loadAsync(draft.zipFile).then(function (zip) {
      var entries = []; zip.forEach(function (p, o) { if (!o.dir) entries.push(p); });
      var imageEntries = entries.filter(isImage).map(function (p) { return { path: p, name: baseName(p) }; });
      var u = {
        id: uid(), fileName: draft.fileName, sourceFile: draft.zipFile, zip: zip, folderBase: draft.folderBase,
        model: draft.model, unit: draft.unit, inspector: draft.inspector,
        imageEntries: imageEntries, csvText: draft.csvText || '',
        verdict: draft.verdict || '', note: draft.note || '',
        status: draft.status || 'draft', draftKey: draft.key, savedAt: draft.savedAt,
        packaging: {}, galleryUrls: [],
        defects: (draft.defects || []).map(function (d) {
          return { id: uid(), path: d.path, label: d.label, name: d.name,
                   origUrl: null, repairFile: d.repair || null, repairUrl: null, note: d.note || '' };
        }),
      };
      PACK_FACES.forEach(function (f) {
        var file = draft.packaging && draft.packaging[f.id];
        if (file) u.packaging[f.id] = { file: file, url: null, ext: extOf(file.name) || 'jpg' };
      });
      return u;
    }).catch(function (e) { console.error('草稿恢复失败', draft && draft.key, e); return null; });
  }

  function restoreDrafts() {
    idbAll().then(function (drafts) {
      if (!drafts || !drafts.length) return;
      showOverlay(true);
      return Promise.all(drafts.map(reconstructUnit)).then(function (units) {
        units.filter(Boolean).forEach(function (u) {
          if (!state.units.filter(function (x) { return x.folderBase === u.folderBase; })[0]) state.units.push(u);
        });
        showOverlay(false);
        renderQueue();
      });
    }).catch(function (e) { console.error('读取草稿失败', e); });
  }

  function deleteUnit(index) {
    var u = state.units[index];
    if (!u) return;
    var isDraft = u.status === 'draft';
    if (!window.confirm(isDraft ? '删除该暂存草稿（已拍的复检/包装照片会丢失）？' : '从列表移除该台？')) return;
    revokeGallery(u);
    PACK_FACES.forEach(function (f) { var p = u.packaging[f.id]; if (p && p.url) URL.revokeObjectURL(p.url); });
    state.units.splice(index, 1);
    if (u.draftKey) idbDel(u.draftKey).catch(function () {});
    renderQueue();
  }

  // ---------- events ----------
  els.zipInput.addEventListener('change', function () { handleFiles(this.files); this.value = ''; });
  els.drop.addEventListener('dragover', function (e) { e.preventDefault(); els.drop.classList.add('over'); });
  els.drop.addEventListener('dragleave', function () { els.drop.classList.remove('over'); });
  els.drop.addEventListener('drop', function (e) {
    e.preventDefault(); els.drop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files) handleFiles(e.dataTransfer.files);
  });
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { if (e.target !== els.zipInput) e.preventDefault(); });

  els.queue.addEventListener('click', function (e) {
    var del = e.target.closest('[data-del]');
    if (del) { deleteUnit(Number(del.dataset.del)); return; }
    var open = e.target.closest('[data-open]');
    if (open) openReview(Number(open.dataset.open));
  });

  els.rvBack.addEventListener('click', leaveReview);
  els.rvSaveDraft.addEventListener('click', saveDraft);

  els.rvVerdict.addEventListener('click', function (e) {
    var btn = e.target.closest('button[data-v]');
    if (!btn) return;
    var u = state.units[state.current];
    if (!u) return;
    if (btn.dataset.v === '合格' && !defectsResolved(u)) {
      toast('还有 ' + unresolvedCount(u) + ' 处瑕疵未上传复检后照片，无法判定合格');
      return;
    }
    u.verdict = u.verdict === btn.dataset.v ? '' : btn.dataset.v;
    renderVerdict(u);
  });

  // defect: add / clear re-inspection photo, edit repair note
  els.rvDefects.addEventListener('change', function (e) {
    var input = e.target.closest('input[type=file]');
    if (!input) return;
    var wrap = input.closest('[data-dfx]');
    var file = input.files && input.files[0];
    if (wrap && file) setRepairPhoto(wrap.dataset.dfx, file);
    input.value = '';
  });
  els.rvDefects.addEventListener('click', function (e) {
    var clr = e.target.closest('[data-dfx-clear]');
    if (clr) { e.preventDefault(); clearRepairPhoto(clr.dataset.dfxClear); return; }
    var img = e.target.closest('img[data-zoom]');
    if (img) { els.lbImg.src = img.dataset.zoom; els.lb.classList.add('on'); }
  });
  els.rvDefects.addEventListener('input', function (e) {
    var ta = e.target.closest('.dfx__note');
    if (!ta) return;
    var wrap = ta.closest('[data-dfx]');
    var u = state.units[state.current];
    if (!u || !wrap) return;
    var d = (u.defects || []).filter(function (x) { return x.id === wrap.dataset.dfx; })[0];
    if (d) d.note = ta.value;
  });
  els.rvNote.addEventListener('input', function () {
    var u = state.units[state.current]; if (u) u.note = els.rvNote.value;
  });

  els.rvPack.addEventListener('change', function (e) {
    var input = e.target.closest('input[type=file]');
    if (!input) return;
    var wrap = input.closest('[data-pack]');
    var file = input.files && input.files[0];
    if (wrap && file) setPackPhoto(wrap.dataset.pack, file);
    input.value = '';
  });
  els.rvPack.addEventListener('click', function (e) {
    var clr = e.target.closest('[data-clear]');
    if (clr) { e.preventDefault(); clearPackPhoto(clr.dataset.clear); }
  });

  els.rvGenerate.addEventListener('click', generateReport);

  // lightbox
  els.rvGallery.addEventListener('click', function (e) {
    var img = e.target.closest('img[data-zoom]');
    if (!img) return;
    els.lbImg.src = img.dataset.zoom; els.lb.classList.add('on');
  });
  els.lb.addEventListener('click', function () { els.lb.classList.remove('on'); els.lbImg.removeAttribute('src'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      if (els.lb.classList.contains('on')) { els.lb.classList.remove('on'); els.lbImg.removeAttribute('src'); }
      else if (!els.viewReview.classList.contains('hide')) leaveReview();
    }
  });

  window.addEventListener('pagehide', function () {
    state.units.forEach(function (u) {
      revokeGallery(u);
      PACK_FACES.forEach(function (f) { var p = u.packaging[f.id]; if (p && p.url) URL.revokeObjectURL(p.url); });
    });
  });

  // 启动:载入本机暂存的待终审草稿
  restoreDrafts();
})();
