/*
 * 启动引导:从阿里云 OSS 读取云端配置(含上传钥匙),再加载存储模块与主程序。
 * 这样钥匙不进公开 git 仓库;配置对象就近放在深圳 OSS,读取很快。
 *
 * 取不到配置时降级:仍可本地拍照打包下载,只是不上传云端。
 */
(function () {
  'use strict';

  var V = 'v22';
  var CONFIG_URL = 'https://haoyao-qc-hk.oss-cn-hongkong.aliyuncs.com/public/qc-config.json';

  function loadScript(src, cb) {
    var s = document.createElement('script');
    s.src = src;
    s.onload = cb || null;
    s.onerror = function () { window.alert('加载失败:' + src + '\n请检查网络后刷新。'); };
    document.body.appendChild(s);
  }

  function startApp() {
    // 先加载存储实现(按 provider 接管 window.QCStorage),再加载主程序
    loadScript('lib/storage-oss.js?' + V, function () {
      loadScript('lib/storage.js?' + V, function () {
        loadScript('app.js?' + V);
      });
    });
  }

  fetch(CONFIG_URL + '?t=' + (new Date().getTime()), { cache: 'no-store' })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (cfg) { window.QC_CONFIG = cfg; startApp(); })
    .catch(function (e) {
      console.error('云端配置加载失败,降级为仅本地打包', e);
      window.QC_CONFIG = {}; // 无上传能力,但本地生成下载仍可用
      startApp();
    });
})();
