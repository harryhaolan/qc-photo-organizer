/*
 * 注意:真正的云端配置(含上传钥匙)不放在本仓库,而是启动时由 boot.js 从
 * 阿里云 OSS 上的 public/qc-config.json 读取(避免把钥匙提交到公开 git)。
 *
 * 本文件仅记录配置的结构示例,供参考:
 *
 *   {
 *     "provider": "oss",
 *     "oss": {
 *       "region": "oss-cn-shenzhen",
 *       "bucket": "haoyao-qc",
 *       "accessKeyId": "<只能 PutObject 到 records/ 的 RAM 钥匙>",
 *       "accessKeySecret": "<对应 secret>"
 *     }
 *   }
 *
 * 备用 Supabase 结构:{ provider:"supabase", supabaseUrl, supabaseKey, bucket }
 */
