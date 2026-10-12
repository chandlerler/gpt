// 电商采集大师 - 全局配置（唯一配置入口）
// 服务器地址说明：
//  - 线上地址 https://facailo.xyz（与 server/.env 的 SERVER_DOMAIN 保持一致）
//  - 部署到自有服务器时，只需修改下面的 serverUrl，扩展所有模块（授权/转发）都会同步生效
var AIS_CONFIG = {
  serverUrl: 'https://www.facailo.xyz',
  get apiBase() { return this.serverUrl + '/api'; },
  // 云数据/评论分析服务地址（默认同授权服务器；语义不影响 serverUrl）
  get dataApi() { return this.serverUrl + '/api/data'; },
  // 用户反馈（Bug/功能建议）接收地址：部署 server/feedback-server.js 后生效。
  // 若 serverUrl 指向自有域名，需在 manifest.json host_permissions 加入该域名。
  get feedbackApi() { return this.serverUrl + '/api/feedback'; }
};

// 兼容不同运行环境（content script 隔离世界 / service worker / 直接脚本）
if (typeof window !== 'undefined') window.AIS_CONFIG = AIS_CONFIG;
if (typeof globalThis !== 'undefined') globalThis.AIS_CONFIG = AIS_CONFIG;