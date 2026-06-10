/*
 * 云端上传 —— 阿里云 OSS 实现(国内/香港机房,工厂网络快)。
 * 仅当 window.QC_CONFIG.provider === 'oss' 时启用,注册到 window.QCStorage。
 *
 * 设计与 Supabase 版一致:员工端用一把"只能上传"的 RAM 钥匙(放在网页里,
 * 即使被看到也只能 PutObject,不能读/列/删)。每台记录上传两个对象:
 *   records/{id}.zip   —— 整台照片打包
 *   records/{id}.json  —— 该台元数据(型号/编号/质检员/各数量/瑕疵备注/zip键名)
 * 后台列出 records/ 下的 .json 即可建表,点开再下载对应 .zip。
 */
(function () {
  'use strict';

  var cfg = window.QC_CONFIG || {};
  if (cfg.provider !== 'oss') return; // 不是 OSS 模式则不接管

  var o = cfg.oss || {};

  function configured() {
    return !!(window.OSS && o.region && o.bucket && o.accessKeyId && o.accessKeySecret);
  }

  function client() {
    return new window.OSS({
      region: o.region,
      bucket: o.bucket,
      accessKeyId: o.accessKeyId,
      accessKeySecret: o.accessKeySecret,
      secure: true,            // 走 https
    });
  }

  function makeId() {
    var ts = Date.now();
    var rand = Math.random().toString(36).slice(2, 8);
    return ts + '-' + rand;
  }

  // rec = { blob, folder, model, unit, inspector, photoCount, defectCount,
  //         defectSurfaceCount, attachCount, notes }
  function upload(rec) {
    if (!configured()) return Promise.reject(new Error('未配置阿里云 OSS(或 SDK 未加载)'));
    var c = client();
    var id = makeId();
    var zipKey = 'records/' + id + '.zip';
    var jsonKey = 'records/' + id + '.json';

    var meta = {
      folder: rec.folder,
      model: rec.model,
      unit: rec.unit,
      inspector: rec.inspector || '',
      photo_count: rec.photoCount || 0,
      defect_count: rec.defectCount || 0,
      defect_surface_count: rec.defectSurfaceCount || 0,
      attach_count: rec.attachCount || 0,
      notes: (rec.notes && rec.notes.length) ? rec.notes : [],
      created_at: new Date().toISOString(),
      zip_key: zipKey,
    };
    var jsonBlob = new Blob([JSON.stringify(meta)], { type: 'application/json' });

    // 先传 ZIP,再传 JSON(JSON 在后 → 列表里看到 .json 说明该台已完整)
    return c.put(zipKey, rec.blob).then(function () {
      return c.put(jsonKey, jsonBlob);
    }).then(function () {
      return { ok: true, path: zipKey };
    }).catch(function (e) {
      var msg = (e && e.message) ? e.message : String(e);
      if (e && (e.name === 'RequestError' || e.code === 'RequestError')) {
        msg = '网络无法连到 OSS(请检查网络 / bucket 跨域CORS设置)：' + msg;
      }
      throw new Error(msg);
    });
  }

  window.QCStorage = { configured: configured, upload: upload };
})();
