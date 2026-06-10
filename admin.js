/*
 * 皓曜质检 · 汇总后台(阿里云 OSS 版,仅供老板/管理员使用)。
 *
 * 用一把【能读取】的 RAM 钥匙(AccessKeyId/Secret)读取 records/ 下所有 .json
 * 元数据并列表;点开下载/预览对应 .zip。钥匙只存在本机浏览器 localStorage,
 * 运行时输入,不写死、不部署。
 */
(function () {
  'use strict';

  var DEFAULT_REGION = 'oss-cn-hongkong';
  var LS_KEY = 'qc_admin_oss';

  var appEl = document.getElementById('app');
  var refreshBtn = document.getElementById('refresh-btn');
  var logoutBtn = document.getElementById('logout-btn');
  var modal = document.getElementById('modal');
  var modalGrid = document.getElementById('modal-grid');
  var modalTitle = document.getElementById('modal-title');
  var modalClose = document.getElementById('modal-close');
  var modalDl = document.getElementById('modal-dl');

  var cache = [];
  var objectUrls = [];

  // ---------- 配置 ----------
  function getCfg() { try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (e) { return null; } }
  function setCfg(c) { localStorage.setItem(LS_KEY, JSON.stringify(c)); }
  function clearCfg() { localStorage.removeItem(LS_KEY); }

  function client() {
    var c = getCfg();
    return new window.OSS({
      region: c.region, bucket: c.bucket,
      accessKeyId: c.accessKeyId, accessKeySecret: c.accessKeySecret,
      secure: true,
    });
  }

  // ---------- OSS 读取 ----------
  function listJsonKeys() {
    var c = client();
    var keys = [];
    function page(marker) {
      var q = { prefix: 'records/', 'max-keys': 1000 };
      if (marker) q.marker = marker;
      return c.list(q, {}).then(function (res) {
        (res.objects || []).forEach(function (ob) {
          if (/\.json$/.test(ob.name)) keys.push(ob.name);
        });
        if (res.isTruncated && res.nextMarker) return page(res.nextMarker);
      });
    }
    return page().then(function () { return keys; });
  }

  function getJson(key) {
    return client().get(key).then(function (res) {
      var text = new TextDecoder('utf-8').decode(res.content);
      var meta = JSON.parse(text);
      meta._jsonKey = key;
      return meta;
    });
  }

  function fetchZipBlob(zipKey) {
    return client().get(zipKey).then(function (res) {
      return new Blob([res.content], { type: 'application/zip' });
    });
  }

  function signedDownloadUrl(zipKey, filename) {
    return client().signatureUrl(zipKey, {
      expires: 3600,
      response: { 'content-disposition': 'attachment; filename="' + encodeURIComponent(filename) + '"' },
    });
  }

  // ---------- 工具 ----------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function saveBlob(blob, name) {
    var u = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = u; a.download = name; document.body.appendChild(a); a.click();
    a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 4000);
  }

  // ---------- 登录 ----------
  function renderSetup(msg) {
    refreshBtn.hidden = true; logoutBtn.hidden = true;
    var c = getCfg() || {};
    appEl.innerHTML =
      '<div class="setup">' +
        '<h2>登录汇总后台</h2>' +
        '<p>输入你的阿里云 OSS 信息和【能读取的 RAM 钥匙】。只保存在本机浏览器,不会上传。</p>' +
        (msg ? '<div class="err" style="padding:10px 0">' + esc(msg) + '</div>' : '') +
        '<label>地域 Region</label>' +
        '<input id="cfg-region" type="text" value="' + esc(c.region || DEFAULT_REGION) + '" />' +
        '<label>桶名 Bucket</label>' +
        '<input id="cfg-bucket" type="text" value="' + esc(c.bucket || 'haoyao-qc-hk') + '" placeholder="haoyao-qc-hk" />' +
        '<label>AccessKeyId(读取权限的 RAM 子账号)</label>' +
        '<input id="cfg-id" type="text" value="' + esc(c.accessKeyId || '') + '" placeholder="LTAI..." />' +
        '<label>AccessKeySecret</label>' +
        '<input id="cfg-secret" type="password" placeholder="••••••" />' +
        '<button class="btn" id="cfg-save">进入后台</button>' +
      '</div>';
    document.getElementById('cfg-save').addEventListener('click', function () {
      var cfg = {
        region: document.getElementById('cfg-region').value.trim(),
        bucket: document.getElementById('cfg-bucket').value.trim(),
        accessKeyId: document.getElementById('cfg-id').value.trim(),
        accessKeySecret: document.getElementById('cfg-secret').value.trim(),
      };
      if (!cfg.region || !cfg.bucket || !cfg.accessKeyId || !cfg.accessKeySecret) {
        renderSetup('四项都要填'); return;
      }
      setCfg(cfg); load();
    });
  }

  // ---------- 列表 ----------
  function rowHtml(rec, i) {
    var hasDefect = (rec.defect_count || 0) > 0;
    var notes = '';
    if (rec.notes && rec.notes.length) {
      notes = '<div class="notes">' + rec.notes.filter(function (n) { return n.note; })
        .map(function (n) { return esc(n.part) + '：' + esc(n.note); }).join('；') + '</div>';
    }
    return '<tr>' +
      '<td><strong>' + esc(rec.folder) + '</strong>' + notes + '</td>' +
      '<td>' + esc(rec.inspector || '—') + '</td>' +
      '<td>' + (rec.photo_count || 0) + ' 张</td>' +
      '<td>' + (hasDefect
          ? '<span class="pill bad">瑕疵 ' + rec.defect_count + ' 张 / ' + (rec.defect_surface_count || 0) + ' 处</span>'
          : '<span class="pill ok">无瑕疵</span>') + '</td>' +
      '<td>' + esc(fmtTime(rec.created_at)) + '</td>' +
      '<td><div class="act">' +
        (rec.zip_key
          ? '<button data-preview="' + i + '">预览照片</button><button data-dl="' + i + '">下载ZIP</button>'
          : '<span class="notes">无文件</span>') +
      '</div></td>' +
    '</tr>';
  }

  function renderList(list) {
    if (!list.length) { appEl.innerHTML = '<div class="empty">还没有任何质检记录。</div>'; return; }
    var rows = list.map(function (rec) { return rowHtml(rec, cache.indexOf(rec)); }).join('');
    appEl.innerHTML =
      '<div class="bar">' +
        '<input type="search" id="q" placeholder="搜索型号 / 编号 / 质检员…" />' +
        '<span class="stat">共 ' + cache.length + ' 台' + (list.length !== cache.length ? '（筛选出 ' + list.length + '）' : '') + '</span>' +
      '</div>' +
      '<table><thead><tr>' +
        '<th>型号-编号</th><th>质检员</th><th>照片</th><th>瑕疵</th><th>时间</th><th>操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';

    var q = document.getElementById('q');
    q.addEventListener('input', function () {
      var kw = q.value.trim().toLowerCase();
      if (!kw) { renderList(cache); document.getElementById('q').focus(); return; }
      renderList(cache.filter(function (r) {
        return [r.folder, r.model, r.unit, r.inspector].join(' ').toLowerCase().indexOf(kw) >= 0;
      }));
      var nq = document.getElementById('q'); nq.value = kw; nq.focus();
    });

    appEl.querySelectorAll('[data-dl]').forEach(function (b) {
      b.addEventListener('click', function () { downloadRecord(cache[+b.getAttribute('data-dl')], b); });
    });
    appEl.querySelectorAll('[data-preview]').forEach(function (b) {
      b.addEventListener('click', function () { previewRecord(cache[+b.getAttribute('data-preview')], b); });
    });
  }

  function downloadRecord(rec, btn) {
    try {
      var url = signedDownloadUrl(rec.zip_key, rec.folder + '.zip');
      window.location.href = url;       // 直接从 OSS 下载,快
    } catch (e) { alert(e.message); }
  }

  function previewRecord(rec, btn) {
    var old = btn.textContent; btn.textContent = '加载中…'; btn.disabled = true;
    fetchZipBlob(rec.zip_key).then(function (blob) {
      return JSZip.loadAsync(blob);
    }).then(function (zip) {
      var imgs = [];
      zip.forEach(function (path, entry) {
        if (!entry.dir && /\.(jpe?g|png|webp|gif)$/i.test(path)) imgs.push(entry);
      });
      imgs.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
      return Promise.all(imgs.map(function (e) {
        return e.async('blob').then(function (b) { return { name: e.name, url: URL.createObjectURL(b) }; });
      }));
    }).then(function (items) { openModal(rec, items); })
      .catch(function (e) { alert(e.message); })
      .then(function () { btn.textContent = old; btn.disabled = false; });
  }

  function openModal(rec, items) {
    closeModalUrls();
    modalTitle.textContent = rec.folder + (rec.inspector ? ' · ' + rec.inspector : '') + ' · ' + items.length + ' 张';
    modalDl.onclick = function () { try { window.location.href = signedDownloadUrl(rec.zip_key, rec.folder + '.zip'); } catch (e) { alert(e.message); } };
    modalGrid.innerHTML = items.map(function (it) {
      objectUrls.push(it.url);
      var label = it.name.replace(/^[^/]+\//, '');
      return '<div class="ph"><a href="' + it.url + '" target="_blank"><img src="' + it.url + '" loading="lazy" /></a>' +
             '<div class="cap">' + esc(label) + '</div></div>';
    }).join('') || '<div class="empty">该台没有照片(可能只含附件)。</div>';
    modal.classList.add('on');
  }

  function closeModalUrls() { objectUrls.forEach(function (u) { URL.revokeObjectURL(u); }); objectUrls = []; }
  function closeModal() { modal.classList.remove('on'); closeModalUrls(); modalGrid.innerHTML = ''; }
  modalClose.addEventListener('click', closeModal);
  modal.addEventListener('click', function (e) { if (e.target === modal) closeModal(); });

  // ---------- 启动 ----------
  function load() {
    refreshBtn.hidden = false; logoutBtn.hidden = false;
    appEl.innerHTML = '<div class="empty">加载中…</div>';
    listJsonKeys().then(function (keys) {
      if (!keys.length) { cache = []; renderList([]); return; }
      return Promise.all(keys.map(function (k) {
        return getJson(k).catch(function () { return null; }); // 个别坏的跳过
      })).then(function (metas) {
        cache = metas.filter(Boolean).sort(function (a, b) {
          return (b.created_at || '') < (a.created_at || '') ? -1 : 1;
        });
        renderList(cache);
      });
    }).catch(function (e) {
      renderSetup('读取失败:' + (e && e.message ? e.message : e) + '（检查 Region/桶名/钥匙是否正确,以及桶的跨域CORS是否已配置）');
    });
  }

  refreshBtn.addEventListener('click', load);
  logoutBtn.addEventListener('click', function () { clearCfg(); renderSetup(); });

  if (getCfg()) load(); else renderSetup();
})();
