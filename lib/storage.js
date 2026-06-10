/*
 * 云端上传(存储层,与界面解耦)。
 * 目前实现 = Supabase:把整台 ZIP 传到 storage 的 qc 桶,并往 qc_records
 * 表插一条元数据(型号/编号/质检员/各类数量/瑕疵备注/zip 路径)。
 *
 * 之所以传整台一个 ZIP(而不是逐张照片):工厂网络一次请求比多次往返稳。
 * 汇总后台拿到 zip_path 后,在浏览器里用 JSZip 解压预览即可。
 *
 * 若日后从工厂传海外 Supabase 偏慢,只需替换本文件(换成阿里云OSS等),
 * 前端 app.js 只认 window.QCStorage.upload(rec) 这一个接口,无需改动。
 */
(function () {
  'use strict';

  var cfg = window.QC_CONFIG || {};
  if (cfg.provider && cfg.provider !== 'supabase') return; // 非 Supabase 模式则不接管

  function configured() {
    return !!(cfg.supabaseUrl && cfg.supabaseKey && cfg.bucket);
  }

  var TIMEOUT_MS = 60000; // 单个请求最多等 60 秒,超时报错而不是一直卡着

  function headers(extra) {
    var h = { apikey: cfg.supabaseKey, Authorization: 'Bearer ' + cfg.supabaseKey };
    if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) h[k] = extra[k]; }
    return h;
  }

  // 带超时的 fetch(用 AbortController)
  function fetchT(url, opts) {
    var ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    if (ctrl) opts.signal = ctrl.signal;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
    return fetch(url, opts)
      .catch(function (e) {
        if (e && e.name === 'AbortError') throw new Error('请求超时（' + (TIMEOUT_MS / 1000) + '秒未响应,可能是网络无法连到云端服务器）');
        throw new Error('网络错误:' + (e && e.message ? e.message : e));
      })
      .then(function (r) { clearTimeout(timer); return r; });
  }

  function uploadZip(path, blob) {
    var url = cfg.supabaseUrl + '/storage/v1/object/' + cfg.bucket + '/' + path;
    return fetchT(url, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/zip', 'x-upsert': 'true' }),
      body: blob,
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('上传ZIP失败 ' + r.status + ' ' + t); });
      return r.json();
    });
  }

  function insertRecord(row) {
    var url = cfg.supabaseUrl + '/rest/v1/qc_records';
    // 注意:不加 Prefer: return=representation —— 员工端无读取权限,读回会被 RLS 拦。
    return fetchT(url, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(row),
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (t) { throw new Error('写记录失败 ' + r.status + ' ' + t); });
      return true;
    });
  }

  // 生成 ASCII 的对象路径(避免中文键名在 URL 里出问题);人类可读的名字
  // 存在数据库 folder 列里。
  function makeZipPath() {
    var ts = Date.now();
    var rand = Math.random().toString(36).slice(2, 8);
    return 'records/' + ts + '-' + rand + '.zip';
  }

  // rec = { blob, folder, model, unit, inspector, photoCount, defectCount,
  //         defectSurfaceCount, attachCount, notes }
  function upload(rec) {
    if (!configured()) return Promise.reject(new Error('未配置云端'));
    var zipPath = makeZipPath();
    return uploadZip(zipPath, rec.blob).then(function () {
      return insertRecord({
        model: rec.model,
        unit: rec.unit,
        inspector: rec.inspector || null,
        folder: rec.folder,
        photo_count: rec.photoCount || 0,
        defect_count: rec.defectCount || 0,
        defect_surface_count: rec.defectSurfaceCount || 0,
        attach_count: rec.attachCount || 0,
        notes: (rec.notes && rec.notes.length) ? rec.notes : null,
        zip_path: zipPath,
      });
    }).then(function () { return { ok: true, path: zipPath }; });
  }

  window.QCStorage = { configured: configured, upload: upload };
})();
