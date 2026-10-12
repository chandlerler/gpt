// ===== Shadow DOM 桥接 =====
// 面板 DOM 在 closed ShadowRoot 内（content.js injectPanel 创建），页面 JS 无法通过 document 访问。
// 统一经 __AIS_DOC() 查询面板元素；__AIS_HOST() 返回 shadow host（用于事件 target 重定向判断）。
function __AIS_DOC() {
  return (typeof window !== 'undefined' && window.__AIS_SHADOW__) ? window.__AIS_SHADOW__ : document;
}
function __AIS_HOST() {
  return (typeof window !== 'undefined') ? (window.__AIS_SHADOW_HOST__ || null) : null;
}

// ===== v1.2.334：面板就绪握手（信号 + 闩锁，时序无关）=====
// 真机定位：content.js 注入面板后派发 ui:ready，但该事件可能在 panel.js 注册监听【之前】就派发（信号丢失），
// 于是 updatePlatformInfo 从未在面板存在后被调用 → 顶部永久「检测中」。
// 三重兜底：① content.js 直接调用本回调；② 事件监听；③ 闩锁 __AIS_PANEL_READY__（面板已就绪时补跑）。
try {
  var __aisPanelReady = function () {
    try { window.__AIS_PLAT_T0__ = 0; window.__AIS_PLAT_N__ = 0; } catch (eT0) {}   // v1.2.350/351：就绪信号到达 → 平台名自愈重新计数
    if (!window.__AIS_INIT_DONE__) { try { aisInit(); } catch (eA) {} }
    // v1.2.336：面板刚注入时元素可能尚未可见（或随后被首次 render 覆盖），做 3 次有界补写（非看门狗，不轮询）
    try { updatePlatformInfo(0); } catch (eB) {}
    setTimeout(function () { try { updatePlatformInfo(0); } catch (eB2) {} }, 700);
    setTimeout(function () { try { updatePlatformInfo(0); } catch (eB3) {} }, 1800);
  };
  window.__aisOnPanelReady = __aisPanelReady;
  window.addEventListener('ui:ready', function () { try { __aisPanelReady(); } catch (eC) {} });
  if (window.__AIS_PANEL_READY__) setTimeout(function () { try { __aisPanelReady(); } catch (eD) {} }, 0);
} catch (eH) {}
// v1.1.101：补齐缺失的 storage 工具函数（此前全仓未定义，aisInit 自 326 行起 ReferenceError 崩溃，
// 返回按钮/BI 导出/重新识别/右键菜单/快捷键/断点恢复等绑定全部失效）
function storeGet(keys) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.get(keys, function (r) { resolve(r || {}); });
    } catch (e) { resolve({}); }
  });
}
function storeSet(obj) {
  return new Promise(function (resolve) {
    try {
      chrome.storage.local.set(obj, function () { resolve(true); });
    } catch (e) { resolve(false); }
  });
}
// v1.1.103：淘宝系（淘宝/天猫）平台不再展示「好评率」（平台本身不提供该指标，自行计算易误导）
function isTaobaoFamilyHost() {
  try { return /(^|\.)taobao\.com$|(^|\.)tmall\.com$|(^|\.)tmall\.hk$/i.test(location.hostname || ''); } catch (e) { return false; }
}
// v1.1.104：把弹窗 HTML 挂到面板文档（ShadowRoot/Document 都没有 insertAdjacentHTML，
// 此前 showTrialNotice/showMemberInfoModal 用错方法 → TypeError 被 catch 吞掉 → 历史页「功能说明/打包下载」点了没反应）
function aisMountHtml(html) {
  var mount = __AIS_DOC();
  var tmp = document.createElement('div');
  tmp.innerHTML = html.trim();
  var root = tmp.firstElementChild;
  var target = (mount && mount.host !== undefined && typeof mount.appendChild === 'function') ? mount : document.body;
  target.appendChild(root);
  return root;
}

// v1.1.110：【真机致命伤】panel.js 顶层函数（refreshMemberCache/isMemberNow/aisInit 首用逻辑）引用裸 state，
// 但该全局从未存在——image-collector.js 自 v1.1.36 起 var state 在 IIFE 内（私有），真机 aisInit 一直在
// refreshMemberCache 处 ReferenceError → 面板 DOM 构建中断（壳测试因 window.state={} 桩掩盖了 10 个版本）。
// 这里补一个隔离世界内的共享状态对象（字段按需写入）。
if (typeof state === 'undefined') {
  window.state = { aisIsMember: true, aisFirstUseAt: 0 };
}

// ========== v1.1.39 统一弹窗 UI（替代原生 alert/confirm）==========
// v1.2.263：运行提示改为**常驻面板**（用户要求：去掉显示在网页正中的浮层）。
//   ① 面板底部状态条 #ais-status 显示最新一条（常驻）
//   ② 点状态条展开「运行提示」记录（最近 50 条，带时间与类型色），一次性反馈不会被下一条覆盖丢失
var __aisToastWrap = null;
var __aisMsgLog = [];
function __aisEsc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
// v1.2.266：面板提示里**不展示真实地址**（用户要求）——兜底把任何 URL 抹掉
function __aisNoUrl(s) {
  return String(s == null ? '' : s)
    .replace(/https?:\/\/[^\s，。；;、)）(（【】\[\]<>]+/gi, '（地址已隐藏）')
    .replace(/\s*@\s*（地址已隐藏）/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function renderMsgList() {
  try {
    var box = __AIS_DOC().getElementById('ais-msglist');
    if (!box) return;
    if (!__aisMsgLog.length) { box.innerHTML = '<div class="ais-msg-empty">暂无运行提示</div>'; return; }
    var html = '<div class="ais-msg-head">运行提示（最近 ' + __aisMsgLog.length + ' 条 · 点状态条收起）</div>';
    for (var i = __aisMsgLog.length - 1; i >= 0; i--) {
      var m = __aisMsgLog[i], d = new Date(m.at);
      var hh = ('0' + d.getHours()).slice(-2), mi = ('0' + d.getMinutes()).slice(-2), ss = ('0' + d.getSeconds()).slice(-2);
      html += '<div class="ais-msg-item ' + m.kind + '"><span class="ais-msg-time">' + hh + ':' + mi + ':' + ss + '</span><span class="ais-msg-text">' + __aisEsc(m.t) + '</span></div>';
    }
    box.innerHTML = html;
  } catch (e) { console.warn('[renderMsgList]', e); }
}
function toggleMsgList(force) {
  try {
    var box = __AIS_DOC().getElementById('ais-msglist');
    if (!box) return;
    var show = (force === undefined) ? !box.classList.contains('show') : !!force;
    if (show) renderMsgList();
    box.classList.toggle('show', show);
  } catch (e) {}
}
function aisToast(msg, type) {
  try {
    var text = (typeof aisText === 'function') ? aisText(msg) : String(msg == null ? '' : msg);   // v1.2.282
    if (!text) return;
    var kind = (type === 'error') ? 'error' : (type === 'warn' ? 'warn' : (type === 'info' ? 'info' : 'ok'));
    __aisMsgLog.push({ t: text, kind: kind, at: Date.now() });
    if (__aisMsgLog.length > 50) __aisMsgLog.splice(0, __aisMsgLog.length - 50);
    try { setStatus(text, kind === 'info' ? '' : kind); } catch (e0) {}
    try { renderMsgList(); } catch (e1) {}
  } catch (e) { console.warn("[aisToast]", e); }
}
function aisDialog(msg, opts) {
  opts = opts || {};
  return new Promise(function (resolve) {
    try {
      var doc = __AIS_DOC();
      var bar = document.createElement('div');
      bar.className = 'ais-confirmbar';
      var icoBg = opts.type === 'error' ? 'linear-gradient(135deg,#f43f5e,#dc2626)' : (opts.type === 'warn' ? 'linear-gradient(135deg,#f59e0b,#d97706)' : 'linear-gradient(135deg,#f09a4d,#e07b33)');
      var ico = document.createElement('div');
      ico.className = 'ais-confirmbar-ico';
      ico.style.background = icoBg;
      ico.textContent = opts.type === 'error' ? '✕' : (opts.type === 'warn' ? '!' : 'i');
      var msgw = document.createElement('div');
      msgw.className = 'ais-confirmbar-msg';
      var tt = document.createElement('div');
      tt.className = 'ais-confirmbar-title';
      tt.textContent = opts.title || (opts.type === 'error' ? '出错了' : (opts.type === 'warn' ? '请注意' : '提示'));
      var bd = document.createElement('div');
      bd.className = 'ais-confirmbar-text';
      bd.textContent = String(msg == null ? '' : msg);
      msgw.appendChild(tt); msgw.appendChild(bd);
      var btns = document.createElement('div');
      btns.className = 'ais-confirmbar-btns';
      function mkBtn(txt, primary, val) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ais-cbtn ' + (primary ? 'p' : 'g');
        b.textContent = txt;
        b.addEventListener('click', function () { bar.remove(); aisPanelViewDismiss(); resolve(val); });
        return b;
      }
      if (opts.cancelText !== null) btns.appendChild(mkBtn(opts.cancelText || '取消', false, false));
      btns.appendChild(mkBtn(opts.okText || '确定', true, true));
      bar.appendChild(ico); bar.appendChild(msgw); bar.appendChild(btns);
      // v1.2.177：确认条挂到 #ais-body 顶层并压过所有层——此前挂进 #ais-panelview(z30)，
      // 在云端文件等高级别视图(z-index 2147483000 遮罩)内会被盖住导致按钮点不到
      var topHost = doc.querySelector ? doc.querySelector('#ais-body') : null;
      if (!topHost) topHost = aisPanelViewHost() || doc;
      bar.style.zIndex = '2147483600';
      topHost.appendChild(bar);
    } catch (e) { resolve(false); }
  });
}
function aisAlert(msg, opts) { return aisDialog(msg, Object.assign({ cancelText: null }, opts || {})); }
function aisConfirm(msg, opts) { return aisDialog(msg, Object.assign({ title: "请确认" }, opts || {})); }


// ========== 电商采集大师 Panel Controller ==========
// Panel state
var AIS = {
  step: 'scan',
  fields: [],
  containerSelector: null,
  data: [],
  detailData: null, // 详情页深度采集数据
  totalCollected: 0,
  isManualSelect: false,
  pollTimer: null,
  reviewPageLimit: 0, // 当前详情采集的评论页数上限（0=不限），用于进度显示
};

// ========== Init ==========
function aisInit() {
  // 防重：同一 shadow 生命周期内只初始化一次，避免 retry/热重载重复调用导致事件叠加（点击一次触发多次）
  if (window.__AIS_INIT_DONE__ && !window.__AIS_INIT_FORCE__) return;
  // Defensive: ensure all required elements exist
  var els = {
    floatBtn: __AIS_DOC().getElementById('ais-float-btn'),
    panel: __AIS_DOC().getElementById('ais-panel'),
    btnMinimize: __AIS_DOC().getElementById('ais-btn-minimize'),
    btnSidebar: __AIS_DOC().getElementById('ais-btn-sidebar'),
    btnClose: __AIS_DOC().getElementById('ais-btn-close'),
    btnScan: __AIS_DOC().getElementById('ais-btn-scan'),
    btnManual: __AIS_DOC().getElementById('ais-btn-manual'),
    btnDetail: __AIS_DOC().getElementById('ais-btn-detail'),
    btnBack: __AIS_DOC().getElementById('ais-btn-back'),
    btnStart: __AIS_DOC().getElementById('ais-btn-start'),
    btnCancelManual: __AIS_DOC().getElementById('ais-btn-cancel-manual'),
    btnStop: __AIS_DOC().getElementById('ais-btn-stop'),
    btnCSV: __AIS_DOC().getElementById('ais-btn-csv'),
    btnExcel: __AIS_DOC().getElementById('ais-btn-excel'),
    btnCopy: __AIS_DOC().getElementById('ais-btn-copy'),
    btnImages: __AIS_DOC().getElementById('ais-btn-images'),
    btnRescan: __AIS_DOC().getElementById('ais-btn-rescan'),
    startPageMinus: __AIS_DOC().getElementById('ais-start-minus'),
    startPagePlus: __AIS_DOC().getElementById('ais-start-plus'),
    endPageMinus: __AIS_DOC().getElementById('ais-end-minus'),
    endPagePlus: __AIS_DOC().getElementById('ais-end-plus'),
    countPageMinus: __AIS_DOC().getElementById('ais-count-minus'), // v1.2.229：补齐采集页数 ± 的 DOM 映射（此前缺失导致按钮点击无反应）
    countPagePlus: __AIS_DOC().getElementById('ais-count-plus'),
  };
  
  // If panel HTML hasn't been injected yet (content.js may still be running), retry
  if (!els.floatBtn || !els.panel) {
    console.log('[电商采集大师] Panel DOM not ready, retrying in 200ms...');
    setTimeout(aisInit, 200);
    return;
  }
  // v1.2.330：平台名必须在【任何可能抛异常的绑定之前】写一次——
  // 原先只在第 413 行写，若中间的 els.*.addEventListener / showSubview 抛异常，平台名就永久停在「检测中...」。
  try { updatePlatformInfo(0); } catch (ePlat0) {}
  // Show float button, hide panel initially
  els.floatBtn.style.display = 'flex';
  els.panel.classList.add('ais-minimized');

  // 动态注入版本号（从 manifest 读取，避免硬编码）
  try {
    var verEl = __AIS_DOC().getElementById('ais-version');
    if (verEl && chrome.runtime.getManifest) {
      verEl.textContent = 'v' + chrome.runtime.getManifest().version;
    }
  } catch(e) {}

  // 详情采集按钮始终可见（无论是否在详情页，点击时智能判断）
  if (els.btnDetail) {
    els.btnDetail.classList.remove('ais-hidden');
    // 若当前在详情页，添加高亮提示
    if (window.__detailCollector && window.__detailCollector.isDetailPage()) {
      els.btnDetail.classList.add('ais-action-detail-active');
    }
  }

  // v1.1.95：面板默认直达图片快采子视图（实际工作台）；读取仍由悬浮球/详情页触发
  showSubview('images');
  window.__AIS_INIT_DONE__ = true;
  window.__AIS_INIT_FORCE__ = false;

  // Float button click = toggle panel
  els.floatBtn.addEventListener('click', function() {
    if (els.panel.classList.contains('ais-minimized')) {
      els.panel.classList.remove('ais-minimized');
      // If no active step, default to scan
      var activeStep = els.panel.querySelector('.ais-step.active');
      if (!activeStep) {
        __AIS_DOC().getElementById('ais-step-scan').classList.add('active');
      }
      checkStoredSelection();
      // v1.1.41：详情页点悬浮球 → 展开面板直达图片快采并开始采集
      try { if (window.AISIMG && window.AISIMG.openImages && window.__detailCollector && window.__detailCollector.isDetailPage && window.__detailCollector.isDetailPage()) window.AISIMG.openImages(); } catch (eF) {}
    } else {
      // Don't minimize if currently collecting data
      var progStep = __AIS_DOC().getElementById('ais-step-progress');
      if (progStep && progStep.classList.contains('active')) {
        return; // Keep panel open during collection
      }
      els.panel.classList.add('ais-minimized');
    }
  });

  // Minimize button
  els.btnMinimize.addEventListener('click', function() {
    els.panel.classList.add('ais-minimized');
  });

  // 侧边栏按钮 - 收起为右侧窄条
  els.btnSidebar.addEventListener('click', function() {
    // 采集进行中不允许收起
    var progStep = __AIS_DOC().getElementById('ais-step-progress');
    if (progStep && progStep.classList.contains('active')) return;
    els.panel.classList.add('ais-sidebar-mode');
    els.panel.classList.remove('ais-minimized');
  });

  // 侧边栏模式下点击 logo 展开
  var logoEl = els.panel.querySelector('.ais-logo');
  if (logoEl) {
    logoEl.addEventListener('click', function() {
      if (els.panel.classList.contains('ais-sidebar-mode')) {
        els.panel.classList.remove('ais-sidebar-mode');
      }
    });
  }

  // Close button - hide completely
  els.btnClose.addEventListener('click', function() {
    els.panel.classList.add('ais-minimized');
    els.floatBtn.style.display = 'none';
    // Show float after 30s
    setTimeout(function() {
      els.floatBtn.style.display = 'flex';
    }, 30000);
  });

  // === Step buttons ===

  // AI Scan
  if (els.btnScan) els.btnScan.addEventListener('click', scanPage); // v1.1.92：列表页已移除，元素可能不存在

  // Detail collection
  if (els.btnDetail) {
    els.btnDetail.addEventListener('click', startDetailCollection);
  }
  // 底部"开始采集"主按钮（同详情采集逻辑）
  var btnDetailStart = __AIS_DOC().getElementById('ais-btn-detail-start');
  if (btnDetailStart) btnDetailStart.addEventListener('click', startDetailCollection);

  // v1.1.92：工作台首页卡片已移除（原卡片绑定块删除）——顶部导航胶囊直接绑定功能
  var navDetailPill = __AIS_DOC().getElementById('ais-nav-detail');
  if (navDetailPill) navDetailPill.addEventListener('click', function() { showSubview('images'); });
  var navMonitorPill = __AIS_DOC().getElementById('ais-nav-monitor');
  if (navMonitorPill) navMonitorPill.addEventListener('click', function() { showMonitorPanel(); });
  var navFeedbackPill = __AIS_DOC().getElementById('ais-nav-feedback');
  if (navFeedbackPill) navFeedbackPill.addEventListener('click', function() { showFeedbackPanel(); });
  // v1.1.173：顶部 QQ 图标 → 打开 QQ 临时会话（定制/售后，新标签）
  var navQqPill = __AIS_DOC().getElementById('ais-nav-qq');
  if (navQqPill) navQqPill.addEventListener('click', function() { try { window.open('https://wpa.qq.com/msgrd?v=3&uin=22503719&site=qq&menu=yes', '_blank'); } catch (e) {} });

  // v1.1.92：采集历史 → 直达内页「采集历史」页签（不再弹窗）
  var btnHistoryInPage = __AIS_DOC().getElementById('ais-btn-history');
  if (btnHistoryInPage) btnHistoryInPage.addEventListener('click', function() { openHistoryTab(); });

  // 采集速度（fast/normal/slow）：加载设置并绑定切换
  (function initSpeedMode() {
    var sel = __AIS_DOC().getElementById('ais-speed-mode');
    var slowChk = __AIS_DOC().getElementById('ais-slow-mode');
    var setSpeed = function(mode) {
      try {
        if (typeof RequestPolicy !== 'undefined' && RequestPolicy.setSpeedMode) RequestPolicy.setSpeedMode(mode);
        else if (typeof AntiCrawl !== 'undefined' && AntiCrawl.setSlowMode) AntiCrawl.setSlowMode(mode === 'slow');
      } catch(e) {}
      chrome.storage.local.set({ ais_speed_mode: mode });
    };
    if (sel) {
      chrome.storage.local.get(['ais_speed_mode'], function(r) {
        var mode = r.ais_speed_mode || 'normal';
        sel.value = mode;
        setSpeed(mode);
      });
      sel.addEventListener('change', function() {
        var mode = sel.value || 'normal';
        setSpeed(mode);
        var label = mode === 'fast' ? '快速（更快，风控概率略高）' : (mode === 'slow' ? '慢速（更安全）' : '标准');
        setStatus('采集速度：' + label);
      });
      // 旧 slow 开关仍可用（勾选=slow）
      if (slowChk) {
        slowChk.addEventListener('change', function() {
          if (sel) sel.value = slowChk.checked ? 'slow' : 'normal';
          setSpeed(slowChk.checked ? 'slow' : 'normal');
          setStatus(slowChk.checked ? '已开启慢速模式（采集更安全）' : '标准速度');
        });
      }
      return;
    }
    // 兼容旧版：仅勾选框
    if (slowChk) {
      chrome.storage.local.get(['ais_slow_mode'], function(r) {
        var v = !!r.ais_slow_mode;
        slowChk.checked = v;
        try { if (typeof RequestPolicy !== 'undefined' && RequestPolicy.setSpeedMode) RequestPolicy.setSpeedMode(v ? 'slow' : 'normal'); } catch(e) {}
      });
      slowChk.addEventListener('change', function() {
        var v = slowChk.checked;
        try { if (typeof RequestPolicy !== 'undefined' && RequestPolicy.setSpeedMode) RequestPolicy.setSpeedMode(v ? 'slow' : 'normal'); } catch(e) {}
        chrome.storage.local.set({ ais_speed_mode: v ? 'slow' : 'normal' });
        setStatus(v ? '已开启慢速模式（采集更安全）' : '标准速度');
      });
    }
  })();

  // v1.1.92：子视图返回按钮已随列表页移除（如后续新增返回按钮，绑定 showSubview('detail')）

  // 详情采集配置面板：联动逻辑
  registerDetailConfigInteractions();

  // 步骤2智能切换：详情模式隐藏页码配置
  initStep2SmartSwitch();

  // Manual Select
  if (els.btnManual) els.btnManual.addEventListener('click', startManualSelect); // v1.1.92：同上守卫
  els.btnCancelManual.addEventListener('click', cancelManualSelect);

  // Preview → back（底部 + 顶部双入口）
  els.btnBack.addEventListener('click', showStep.bind(null, 'scan'));
  try {
    var backTop = __AIS_DOC().getElementById('ais-btn-back-top');
    if (backTop) backTop.addEventListener('click', showStep.bind(null, 'scan'));
  } catch(e) {}

  // Start scrape
  els.btnStart.addEventListener('click', startScraping);

  // v1.1.92：History 按钮绑定已上移至首页卡片绑定区（直达内页历史页签，不弹窗）

  // Monitor button (定时监控)
  var btnMonitor = __AIS_DOC().getElementById('ais-btn-monitor');
  if (btnMonitor) btnMonitor.addEventListener('click', function() { showMonitorPanel(); });

  // 云数据入口（上传/查看/分析）
  var btnCloudData = __AIS_DOC().getElementById('ais-btn-clouddata');
  if (btnCloudData) btnCloudData.addEventListener('click', showCloudDataPanel);


  if (window.AisFloatSettings) AisFloatSettings.apply();

  // License button (授权管理)
  var btnLicense = __AIS_DOC().getElementById('ais-btn-license');
  var licenseTag = __AIS_DOC().getElementById('ais-license-tag');
  if (btnLicense) btnLicense.addEventListener('click', function() {
    if (window.LicenseModal) LicenseModal.show();
  });
  if (licenseTag) licenseTag.addEventListener('click', function() {
    if (window.LicenseModal) LicenseModal.show();
  });
  // 监听授权变更事件，更新状态显示
  window.addEventListener('ui:license', function () { updateLicenseTag(); refreshMemberCache(); }); // v1.1.154：授权变更同步刷新运行时状态
  // 初始化授权状态显示
  updateLicenseTag();
  refreshMemberCache();
  try { updatePlatformInfo(); } catch (e) {}

  // v1.2.264：footer「立即检查规则更新」——绕过 worker 侧 24h 缓存强制重拉，结果回显状态条
  try {
    var btnRules = __AIS_DOC().getElementById('ais-btn-rules');
    // v1.2.315：扩展被重载/更新后，旧页面里的内容脚本上下文会失效（chrome.runtime 变 undefined），
    // 此时点「立即更新规则」必抛 "Extension context invalidated"。给出可执行提示，而不是干巴巴报错。
    function __aisExtAlive() {
      try { return !!(window.chrome && chrome.runtime && chrome.runtime.id); } catch (eAlive) { return false; }
    }
    function __aisStaleMsg() {
      return '扩展刚更新或重载过，本页脚本已失效 —— 请按 F5 刷新页面后重试（刷新后新规则自动生效）';
    }
    if (btnRules && !btnRules.__aisBound) {
      btnRules.__aisBound = 1;
      btnRules.addEventListener('click', function (e) {
        e.stopPropagation();
        if (btnRules.disabled) return;
        btnRules.disabled = true;
        try { btnRules.classList.add('busy'); } catch (eB) {}
        if (!__aisExtAlive()) {   // v1.2.315：上下文已失效，先提示刷新，避免抛 "Extension context invalidated"
          btnRules.disabled = false;
          try { btnRules.classList.remove('busy'); } catch (eB0) {}
          var sm0 = __aisStaleMsg();
          try { status(sm0, 'error'); } catch (eS0) {}
          aisToast(sm0, 'error');
          return;
        }
        try { status('正在检查规则更新…'); } catch (eS) {}
        var pr = (window.AisAnchors && window.AisAnchors.refresh) ? window.AisAnchors.refresh(true) : Promise.resolve({ ok: false, error: '注册表未加载' });
        pr.then(function (r) {
          btnRules.disabled = false;
          try { btnRules.classList.remove('busy'); } catch (eB2) {}
          // v1.2.341：worker 在“拉取失败但有缓存”时同样返回 ok:true + stale:true，
          // 原逻辑据此报「规则已更新 v16」——用户会以为拿到的是最新版（真机实测就是被这条误导）。
          var __stale = !!(r && r.ok && (r.stale || (r.error && r.v)));
          if (r && r.ok && !__stale) {
            var m = __aisNoUrl('规则已更新：v' + (r.v || '?'));   // v1.2.266：不再显示来源地址
            try { status(m, 'ok'); } catch (e1) {}
            aisToast(m, 'ok');
          } else if (__stale) {
            var rsn = __aisNoUrl(String(r.error || '网络不可用'));
            var mSt = '规则刷新失败：' + rsn + '（当前沿用缓存 v' + (r.v || '?') + '，可能已过期）';
            try { status(mSt, 'error'); } catch (e1b) {}
            aisToast(mSt, 'error');
          } else {
            var list = ((r && r.errors && r.errors.length) ? r.errors : [((r && r.error) || '未知错误')]).map(__aisNoUrl);
            if (/context invalidated/i.test(list.join(' '))) {   // v1.2.315：孤儿上下文
              var smCtx = __aisStaleMsg();
              aisToast(smCtx, 'error');
              try { status(smCtx, 'error'); } catch (eCtx) {}
              return;
            }
            var em = '规则更新失败：' + list[0] + (list.length > 1 ? '（共 ' + list.length + ' 个源不可用）' : '');
            if (r && r.stale) em += ' · 沿用上次缓存';
            // 先写「运行提示」记录（含全部源原因），再写常驻状态条（简短的主源原因）；两者都不含真实地址
            aisToast('规则更新失败：' + list.join(' ； '), 'error');
            try { status(em, 'error'); } catch (e2) {}
          }
        }).catch(function (err) {
          btnRules.disabled = false;
          try { btnRules.classList.remove('busy'); } catch (eB3) {}
          var __rawErr = String((err && err.message) || err);
          var em2 = /context invalidated|Extension context/i.test(__rawErr) ? __aisStaleMsg() : ('规则更新失败：' + __rawErr);
          try { status(em2, 'error'); } catch (e3) {}
          aisToast(em2, 'error');
        });
      });
    }
  } catch (eBtnRules) { console.warn('[ais-btn-rules]', eBtnRules); }

// ===== v1.2.377：远程版本提示 ===== 
  // 服务器把 common.latestVersion 改成比本机更高的版本号 → 页脚亮「可更新 vX.Y.Z」，点一下直达 common.updateUrl。
  // 纯信息性提示：**不需要发版**就能告诉老用户有新版本（真正的修复逻辑仍需用户更新，但提示可以远程控制）。
  try {
    function __aisVerNum(v) { try { return String(v || '').split('.').map(function (x) { return parseInt(x, 10) || 0; }).reduce(function (a, b) { return a * 10000 + b; }, 0); } catch (eVN) { return 0; } }
    function __aisCheckUpdate() {
      try {
        var pill = __AIS_DOC().getElementById('ais-update-pill'); if (!pill) return;
        var local = '';
        try { local = (window.chrome && chrome.runtime && chrome.runtime.getManifest) ? chrome.runtime.getManifest().version : ''; } catch (eL) {}
        var latest = String(aisSel('common.latestVersion', '') || '').replace(/^v/i, '');
        if (!local || !latest || __aisVerNum(latest) <= __aisVerNum(local)) { pill.style.display = 'none'; return; }
        pill.textContent = '可更新 v' + latest;
        pill.title = String(aisSel('common.updateNote', '') || ('发现新版本 v' + latest + '，点击去更新'));
        pill.style.display = '';
        if (!pill.__aisBound) {
          pill.__aisBound = 1;
          pill.addEventListener('click', function (e) {
            e.stopPropagation();
            // v1.2.459：兜底默认值补上真实地址 —— 原 `https://www.facailo.xyz/update` 实测 404（/update、/download 均 404，
            //   真实存在的是 /download.html「下载安装」页，页内直达商店安装）。规则键 common.updateUrl 已同步改正。
            var u = String(aisSel('common.updateUrl', 'https://www.facailo.xyz/download.html') || '');
            if (u) { try { window.open(u, '_blank'); } catch (eO) {} try { status('已打开更新页：v' + latest, 'ok'); } catch (eS) {} }
            else { try { status('有新版本 v' + latest + '，请到浏览器扩展页点「更新」', 'ok'); } catch (eS2) {} }
          });
        }
      } catch (eCk) {}
    }
    __aisCheckUpdate();
    try { document.addEventListener('cfg:sync', function () { setTimeout(__aisCheckUpdate, 300); }); } catch (eCS) {}
    try { window.__aisCheckUpdate = __aisCheckUpdate; } catch (eCW) {}
  } catch (eUpd) {}

  // v1.2.263：点状态条展开/收起「运行提示」记录（提示常驻面板）
  try {
    var stHit = __AIS_DOC().getElementById('ais-status-hit');
    if (stHit && !stHit.__aisBound) {
      stHit.__aisBound = 1;
      stHit.addEventListener('click', function (e) { e.stopPropagation(); toggleMsgList(); });
    }
  } catch (eMsgHit) {}

  // 快捷键帮助按钮（footer 常驻，点击切换 popover）
  var btnShortcuts = __AIS_DOC().getElementById('ais-btn-shortcuts');
  var shortcutsPopover = __AIS_DOC().getElementById('ais-shortcuts-popover');
  if (btnShortcuts && shortcutsPopover) {
    btnShortcuts.addEventListener('click', function(e) {
      e.stopPropagation();
      shortcutsPopover.classList.toggle('show');
    });
    // 点击外部关闭 popover（面板在 closed shadow 内：shadowRoot 监听拿到真实 target；document 兜底处理页面点击）
    // 防重：热重载时旧监听持有已销毁 shadow 内的旧引用，先移除旧监听再重新注册
    var _popKey = 'ais-popover-click';
    if (window.__AIS_POP_CLICK_HANDLER__) {
      try { document.removeEventListener('click', window.__AIS_POP_CLICK_HANDLER__); } catch(e) {}
      window.__AIS_POP_CLICK_HANDLER__ = null;
    }
    if (window.__AIS_POP_SHADOW_HANDLER__) {
      try { __AIS_DOC().removeEventListener('click', window.__AIS_POP_SHADOW_HANDLER__); } catch(e) {}
      window.__AIS_POP_SHADOW_HANDLER__ = null;
    }
    var _popShadowHandler = function(e) {
      if (!shortcutsPopover.contains(e.target) && e.target !== btnShortcuts) {
        shortcutsPopover.classList.remove('show');
      }
    };
    var _popDocHandler = function(e) {
      // closed shadow 内事件冒泡到 document 时 target 被重定向为 host，跳过（shadowRoot 已处理）
      if (e.target === __AIS_HOST()) return;
      if (!shortcutsPopover.contains(e.target) && e.target !== btnShortcuts) {
        shortcutsPopover.classList.remove('show');
      }
    };
    window.__AIS_POP_SHADOW_HANDLER__ = _popShadowHandler;
    window.__AIS_POP_DOC_HANDLER__ = _popDocHandler;
    __AIS_DOC().addEventListener('click', _popShadowHandler);
    document.addEventListener('click', _popDocHandler);
  }

  // Batch detail collection
  var chkBatchDetail = __AIS_DOC().getElementById('ais-chk-batch-detail');
  var btnBatchDetail = __AIS_DOC().getElementById('ais-btn-batch-detail');
  if (chkBatchDetail && btnBatchDetail) {
    chkBatchDetail.addEventListener('change', function() {
      if (this.checked) {
        btnBatchDetail.classList.remove('ais-btn-disabled');
        btnBatchDetail.disabled = false;
      } else {
        btnBatchDetail.classList.add('ais-btn-disabled');
        btnBatchDetail.disabled = true;
      }
    });
    btnBatchDetail.addEventListener('click', async function() {
      if (this.disabled) return;
      // 授权校验：批量详情采集
      var allowed = await requirePaidFeature('batch_detail', '批量详情页采集');
      if (allowed) startBatchDetailCollection();
    });
  }

  // 启动时检测是否有未完成的批量采集任务或批量采集结果
  checkAndResumeBatchCollection().then(function(isBatch) {
    if (isBatch) {
      // 延迟启动，等待页面完全加载
      setTimeout(collectCurrentBatchItem, 2000);
    } else {
      // 检测是否有批量采集完成的结果待显示
      chrome.storage.local.get(['aisBatchResult'], function(r) {
        if (r.aisBatchResult && Date.now() - r.aisBatchResult.timestamp < 5 * 60 * 1000) {
          var result = r.aisBatchResult;
          chrome.storage.local.remove('aisBatchResult');
          showBatchResult(result.successCount, result.failCount, result.total, result.results);
        }
      });
    }
  });

  // 起始页、采集页数、截止页三者联动。默认 1 页，可直接输入或选择快捷页数。
  var startPageInput = __AIS_DOC().getElementById('ais-start-page');
  var endPageInput = __AIS_DOC().getElementById('ais-end-page');
  var pageCountInput = __AIS_DOC().getElementById('ais-page-count');
  function boundedPage(value) { return Math.min(999, Math.max(1, parseInt(value, 10) || 1)); }
  function updatePageInfo(source) {
    var start = boundedPage(startPageInput && startPageInput.value);
    var end = boundedPage(endPageInput && endPageInput.value);
    var count = boundedPage(pageCountInput && pageCountInput.value);
    if (source === 'count' || source === 'start') end = Math.min(999, start + count - 1);
    else { if (end < start) end = start; count = end - start + 1; }
    if (startPageInput) startPageInput.value = start;
    if (endPageInput) endPageInput.value = end;
    if (pageCountInput) pageCountInput.value = count;
    var info = __AIS_DOC().getElementById('ais-page-info');
    if (info) info.textContent = '将采集第 ' + start + (end > start ? ' - ' + end : '') + ' 页，共 ' + count + ' 页';
    __AIS_DOC().querySelectorAll('[data-page-count]').forEach(function(btn) {
      btn.classList.toggle('active', parseInt(btn.getAttribute('data-page-count'), 10) === count);
    });
  }
  if (els.startPageMinus) els.startPageMinus.addEventListener('click', function() { startPageInput.value = boundedPage(startPageInput.value) - 1; updatePageInfo('start'); });
  if (els.startPagePlus) els.startPagePlus.addEventListener('click', function() { startPageInput.value = boundedPage(startPageInput.value) + 1; updatePageInfo('start'); });
  if (els.endPageMinus) els.endPageMinus.addEventListener('click', function() { endPageInput.value = boundedPage(endPageInput.value) - 1; updatePageInfo('end'); });
  if (els.endPagePlus) els.endPagePlus.addEventListener('click', function() { endPageInput.value = boundedPage(endPageInput.value) + 1; updatePageInfo('end'); });
  // v1.2.229：采集页数 ± 此前无任何绑定（起始页/截止页有），补齐并复用三者联动
  if (els.countPageMinus) els.countPageMinus.addEventListener('click', function() { if (pageCountInput) pageCountInput.value = boundedPage(pageCountInput.value) - 1; updatePageInfo('count'); });
  if (els.countPagePlus) els.countPagePlus.addEventListener('click', function() { if (pageCountInput) pageCountInput.value = boundedPage(pageCountInput.value) + 1; updatePageInfo('count'); });
  if (startPageInput) startPageInput.addEventListener('input', function() { updatePageInfo('start'); });
  if (endPageInput) endPageInput.addEventListener('input', function() { updatePageInfo('end'); });
  if (pageCountInput) pageCountInput.addEventListener('input', function() { updatePageInfo('count'); });
  __AIS_DOC().querySelectorAll('[data-page-count]').forEach(function(btn) {
    btn.addEventListener('click', async function() { if (pageCountInput) pageCountInput.value = this.getAttribute('data-page-count'); updatePageInfo('count'); });
  });
  updatePageInfo('count');

  // Stop scrape
  if (els.btnStop) els.btnStop.addEventListener('click', stopScraping);

  // Export
  els.btnCSV.addEventListener('click', exportCSV);
  if (els.btnExcel) els.btnExcel.addEventListener('click', exportExcel);
  if (els.btnImages) els.btnImages.addEventListener('click', downloadImages);
  els.btnCopy.addEventListener('click', copyData);
  // JSON 导出
  var btnJSON = __AIS_DOC().getElementById('ais-btn-json');
  if (btnJSON) btnJSON.addEventListener('click', exportJSON);
  // 发布导出（淘宝/京东CSV + 图片下载）
  // 数据库/BI 导出（Webhook / SQL）
  var btnBI = __AIS_DOC().getElementById('ais-btn-bi');
  if (btnBI) btnBI.addEventListener('click', showBIExportModal);
  if (els.btnRescan) els.btnRescan.addEventListener('click', function() { showStep('scan'); }); // v1.1.101 守卫

  // v1.1.92：返回按钮改为回到详情采集工作台（功能首页已移除）
  var btnHome = __AIS_DOC().getElementById('ais-btn-home');
  if (btnHome) btnHome.addEventListener('click', function() {
    showStep('scan');
    showSubview('images');
    setStatus('就绪');
  });

  setStatus('就绪');
  updatePlatformInfo();
  registerKeyboardShortcuts();
  registerContextMenuHandlers();
  registerFieldFilter();
  registerResumeBanner();
  registerIncrementalButton();
  registerReviewProgressListener();
  checkExistingBreakpoint();

}

// Start!
aisInit();

// v1.2.334：就绪握手已上移到文件顶部（信号 + 闩锁），此处不再重复注册。


// ========== Context Menu Handlers ==========
// 接收来自background的右键菜单事件
function registerContextMenuHandlers() {
  // 抓取这个列表
  window.addEventListener('ui:scan', function() {
    if (typeof scanPage === 'function') {
      scanPage();
    }
  });
  // 深度采集详情
  window.addEventListener('ui:detail', function(e) {
    if (typeof startDetailCollection === 'function') {
      startDetailCollection();
    }
  });
  // 从断点恢复
  window.addEventListener('ui:resume', function() {
    checkExistingBreakpoint(true);
  });
  // 增量去重采集
  window.addEventListener('ui:incr', function() {
    // 跳到预览页并自动开始增量采集
    if (AIS.fields && AIS.fields.length > 0) {
      showStep('preview');
      startIncrementalScraping();
    } else {
      // 没识别过字段先扫描
      scanPage().then(function() {
        setTimeout(startIncrementalScraping, 800);
      });
    }
  });
}

// ========== Field Filter ==========
function registerFieldFilter() {
  var input = __AIS_DOC().getElementById('ais-field-filter');
  var clearBtn = __AIS_DOC().getElementById('ais-field-filter-clear');
  if (!input || !clearBtn) return;
  input.addEventListener('input', function() {
    var q = input.value.trim().toLowerCase();
    var items = __AIS_DOC().querySelectorAll('#ais-field-list .ais-field-item');
    clearBtn.classList.toggle('visible', q.length > 0);
    for (var i = 0; i < items.length; i++) {
      var label = items[i].querySelector('.ais-field-name');
      var name = label ? label.textContent.toLowerCase() : '';
      items[i].classList.toggle('filtered-out', q && name.indexOf(q) < 0);
    }
  });
  clearBtn.addEventListener('click', async function() {
    input.value = '';
    input.dispatchEvent(new Event('input'));
    input.focus();
  });
}

// ========== Resume Banner (断点续采) ==========
function registerResumeBanner() {
  var btnResume = __AIS_DOC().getElementById('ais-btn-resume');
  var btnDiscard = __AIS_DOC().getElementById('ais-btn-discard');
  if (btnResume) {
    btnResume.addEventListener('click', function() {
      resumeFromBreakpoint();
    });
  }
  if (btnDiscard) {
    btnDiscard.addEventListener('click', function() {
      var url = location.href;
      chrome.runtime.sendMessage({ action: 'clearBreakpoint', url: url });
      __AIS_DOC().getElementById('ais-resume-banner').classList.add('ais-hidden');
      setStatus('已忽略断点');
    });
  }
}

// 检测当前页面是否存在断点
function checkExistingBreakpoint(forceShow) {
  if (!window.IncrementalCollector) return;
  var url = location.href;
  IncrementalCollector.getBreakpoint(url).then(function(bp) {
    if (!bp) return;
    // 断点必须在24小时内
    if (Date.now() - bp.savedAt > 24 * 60 * 60 * 1000) {
      IncrementalCollector.clearBreakpoint(url);
      return;
    }
    // 只有未完成时才显示
    if (bp.lastPage >= bp.endPage && !forceShow) return;

    var banner = __AIS_DOC().getElementById('ais-resume-banner');
    var desc = __AIS_DOC().getElementById('ais-resume-desc');
    if (banner) banner.classList.remove('ais-hidden');
    if (desc) {
      desc.textContent = '已完成 ' + bp.lastPage + ' / ' + bp.endPage + ' 页，已采集 ' + bp.collectedCount + ' 条';
    }
    AIS.pendingBreakpoint = bp;
  });
}

// 从断点恢复采集
function resumeFromBreakpoint() {
  if (!AIS.pendingBreakpoint) {
    setStatus('无可用断点');
    return;
  }
  var bp = AIS.pendingBreakpoint;
  // 恢复状态
  AIS.fields = bp.fields || [];
  AIS.containerSelector = bp.containerSelector;
  // 从 lastPage + 1 开始
  var resumeStart = (bp.lastPage || bp.startPage || 1) + 1;
  var startInput = __AIS_DOC().getElementById('ais-start-page');
  var endInput = __AIS_DOC().getElementById('ais-end-page');
  if (startInput) startInput.value = resumeStart;
  if (endInput) endInput.value = bp.endPage;
  if (startInput) startInput.dispatchEvent(new Event('input'));
  setStatus('从第 ' + resumeStart + ' 页恢复采集（请确认字段后点击开始采集）');
  // 渲染字段并跳到预览页，让用户确认字段配置后手动开始
  renderFieldList();
  loadPreview();
  showStep('preview');
}

// 公共弹窗关闭绑定：统一关闭按钮(.ais-modal-hero-close) + 遮罩点击关闭行为
// onClose 为可选的清理回调（在 mask.remove() 之前执行）。返回 closeFn 供手动调用/绑定到其它按钮。
// v1.1.44：弹窗统一改为面板内视图（不再弹出遮罩弹窗）
function aisPanelViewHost() {
  var doc = __AIS_DOC();
  // v1.1.44b：ShadowRoot 上 getElementById 不可靠（返回 null），改用标准 querySelector
  var body = doc.querySelector ? doc.querySelector('#ais-body') : null;
  if (!body) return null;
  var host = doc.querySelector('#ais-panelview');
  if (host && !host.firstChild) { host.remove(); host = null; } // v1.2.243：残留的空宿主先清掉再复用
  if (!host) {
    host = document.createElement('div');
    host.id = 'ais-panelview';
    host.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;z-index:30;overflow:auto;display:block;';
    // v1.2.243 兜底：万一还是被空宿主挡住，点一下自愈（移除后用户再点即可命中下面的按钮）
    host.addEventListener('click', function (e) {
      if (!host.firstChild) { host.remove(); try { e.stopPropagation(); } catch (e1) {} }
    });
    body.appendChild(host);
  }
  return host;
}
function aisPanelViewDismiss() {
  var doc = __AIS_DOC();
  var host = doc.querySelector ? doc.querySelector('#ais-panelview') : null;
  if (host && !host.firstChild) host.remove();
}
function bindModalClose(mask, onClose) {
  var closeFn = function() {
    if (typeof onClose === 'function') onClose();
    if (mask && mask.parentNode) mask.remove(); aisPanelViewDismiss();
  };
  var closeBtn = mask.querySelector('.ais-modal-hero-close');
  if (closeBtn) closeBtn.addEventListener('click', closeFn);
  mask.addEventListener('click', function(e) { if (e.target === mask) closeFn(); });
  return closeFn;
}

// ========== Incremental Button ==========
function registerIncrementalButton() {
  var btn = __AIS_DOC().getElementById('ais-btn-incremental');
  if (!btn) return;
  btn.addEventListener('click', startIncrementalScraping);
}

// 监听全部评论翻页进度
function registerReviewProgressListener() {
  window.addEventListener('rev:progress', function(e) {
    var d = e.detail;
    if (!d) return;
    // 只在详情采集进行中时更新
    var progStep = __AIS_DOC().getElementById('ais-step-progress');
    if (!progStep || !progStep.classList.contains('active')) return;

    var infoEl = __AIS_DOC().getElementById('ais-progress-info');
    if (infoEl) {
      if (d.page === 0) {
        infoEl.textContent = '正在进入评价面板...';
      } else {
        // 免费版/专业版：显示页数上限提示
        var limit = AIS.reviewPageLimit || 0;
        if (limit > 0) {
          infoEl.textContent = '评论翻页中: 第 ' + d.page + '/' + limit + ' 页, 已采集 ' + d.totalReviews + ' 条';
        } else {
          infoEl.textContent = '评论翻页中: 第 ' + d.page + ' 页, 已采集 ' + d.totalReviews + ' 条';
        }
      }
    }
  });
}

// 增量采集：基于历史数据去重
async function startIncrementalScraping() {
  if (!AIS.fields || AIS.fields.length === 0) {
    setStatus('请先识别字段');
    return;
  }
  // 增量采集为专业版功能，需校验授权
  var allowed = await requirePaidFeature('incremental', '增量采集');
  if (!allowed) return;
  setStatus('增量采集中...');

  var fields = getActiveFields();
  var s = window.__aiScraper;
  var startPage = parseInt(__AIS_DOC().getElementById('ais-start-page').value) || 1;
  var endPage = parseInt(__AIS_DOC().getElementById('ais-end-page').value) || 1;

  // 1. 先在当前页采集
  s.extractCurrentPage(fields, AIS.containerSelector).then(function(currentData) {
    // 2. 与历史比对
    var url = location.href;
    if (!window.IncrementalCollector) {
      // 无增量模块，直接走普通流程
      handleIncrementalResult({ isNewCollection: true, newData: currentData, dupCount: 0 });
      return;
    }
    IncrementalCollector.getIncremental(url, currentData).then(function(result) {
      handleIncrementalResult(result);
    });
  });
}

function handleIncrementalResult(result) {
  if (result.isNewCollection) {
    // 首次采集
    AIS.data = result.newData;
    AIS.totalCollected = result.newData.length;
    showIncrementalSummary({
      newCount: result.newData.length,
      dupCount: 0,
      previousCount: 0,
      currentCount: result.newData.length,
      isFirst: true
    });
  } else {
    // 增量：合并新数据
    AIS.data = (AIS.data || []).concat(result.newData);
    AIS.totalCollected = AIS.data.length;
    showIncrementalSummary({
      newCount: result.newData.length,
      dupCount: result.dupCount,
      previousCount: result.previousCount,
      currentCount: result.currentCount,
      isFirst: false
    });
  }
  // 保存历史
  if (window.IncrementalCollector) {
    IncrementalCollector.saveHistory(location.href, AIS.data);
  }
  // 保存到采集历史面板
  saveToHistory({
    type: 'list',
    url: window.location.href,
    title: document.title || '列表采集',
    itemCount: AIS.data.length,
    data: AIS.data,
    fields: AIS.fields,
    timestamp: Date.now()
  });
  // 渲染done页
  showDone();
}

function showIncrementalSummary(info) {
  // 在done页hero下方插入增量结果横幅
  var doneHero = __AIS_DOC().querySelector('.ais-done-hero');
  if (!doneHero) return;
  var existing = __AIS_DOC().querySelector('.ais-incremental-result');
  if (existing) existing.remove();

  var banner = document.createElement('div');
  banner.className = 'ais-incremental-result';
  var html = '';
  if (info.isFirst) {
    html += '<div class="ais-incremental-row">🌱 <strong>首次采集</strong></div>';
    html += '<div class="ais-incremental-row">本次新增：<strong class="ais-new">' + info.newCount + ' 条</strong></div>';
  } else {
    html += '<div class="ais-incremental-row">➕ <strong>增量采集结果</strong></div>';
    html += '<div class="ais-incremental-row">上次数据：<strong>' + info.previousCount + ' 条</strong> · 本次抓取：<strong>' + info.currentCount + ' 条</strong></div>';
    html += '<div class="ais-incremental-row">新增数据：<strong class="ais-new">' + info.newCount + ' 条</strong> · 重复过滤：<strong class="ais-dup">' + info.dupCount + ' 条</strong></div>';
    html += '<div class="ais-incremental-row">合并后总计：<strong>' + (info.previousCount + info.newCount) + ' 条</strong></div>';
  }
  banner.innerHTML = html;
  doneHero.insertAdjacentElement('afterend', banner);
}

// ========== Save Breakpoint on Interruption ==========
// 在采集停止/异常时保存断点
function saveCurrentBreakpoint() {
  if (!window.IncrementalCollector) return;
  var s = window.__aiScraper;
  if (!s || !s.isRunning) return;
  var state = {
    url: location.href,
    fields: AIS.fields,
    containerSelector: AIS.containerSelector,
    startPage: parseInt(__AIS_DOC().getElementById('ais-start-page').value) || 1,
    endPage: parseInt(__AIS_DOC().getElementById('ais-end-page').value) || 1,
    lastPage: s._collectedPages || 0,
    collectedCount: (s.extractedData || []).length,
    collectedHashes: []
  };
  IncrementalCollector.saveBreakpoint(state);
}

// ========== Test Bridge (供自动化测试调用) ==========
// 监听测试事件，通过 CustomEvent detail 返回结果
function showStep(name) {
  AIS.step = name;
  // 进入完成页时强制展开面板（移除最小化/侧边栏态），否则 #ais-panel.ais-minimized 的 pointer-events:none 会让完成页按钮点不动
  if (name === 'done') {
    try {
      var _pnl2 = __AIS_DOC().getElementById('ais-panel');
      if (_pnl2) { _pnl2.classList.remove('ais-minimized'); _pnl2.classList.remove('ais-sidebar-mode'); }
      var _fb2 = __AIS_DOC().getElementById('ais-float-btn');
      if (_fb2) { try { _fb2.style.display = 'none'; } catch(e) {} }
    } catch(e) {}
  }
  var steps = __AIS_DOC().querySelectorAll('#ais-panel .ais-step');
  for (var i = 0; i < steps.length; i++) steps[i].classList.remove('active');
  var target = __AIS_DOC().getElementById('ais-step-' + name);
  if (target) target.classList.add('active');
  updateStepper(name);

  // 步骤2智能切换：详情模式隐藏页码配置，显示采集配置摘要
  if (name === 'preview') {
    var isDetail = AIS.detailMode === true;
    var stepPreview = __AIS_DOC().getElementById('ais-step-preview');
    var configCard = stepPreview ? stepPreview.querySelector('.ais-config-card') : null;
    var summaryEl = __AIS_DOC().getElementById('ais-detail-config-summary');
    if (configCard) configCard.style.display = isDetail ? 'none' : '';
    if (summaryEl) {
      summaryEl.classList.toggle('ais-hidden', !isDetail);
      if (isDetail) updateDetailConfigSummary();
    }
  }
}

// 更新步骤指示器
function updateStepper(currentStep) {
  var stepOrder = ['scan', 'preview', 'progress', 'done'];
  // manual 是 scan 的子状态，不计入步骤
  if (currentStep === 'manual') currentStep = 'scan';
  var currentIdx = stepOrder.indexOf(currentStep);
  if (currentIdx === -1) return;

  var dots = __AIS_DOC().querySelectorAll('.ais-step-dot');
  var lines = __AIS_DOC().querySelectorAll('.ais-step-line');
  for (var i = 0; i < dots.length; i++) {
    dots[i].classList.remove('active', 'done');
    if (i < currentIdx) {
      dots[i].classList.add('done');
    } else if (i === currentIdx) {
      dots[i].classList.add('active');
    }
  }
  for (var j = 0; j < lines.length; j++) {
    lines[j].classList.toggle('active', j < currentIdx);
  }
}

// 更新平台检测信息
function updatePlatformInfo(retry) {
  // v1.2.323：自愈移到函数开头——原实现在尾部，若 nameEl 未就绪在下方 `if(!nameEl) return` 早退
  // （或 init 在调用点前中断），自愈 setTimeout 永远不会被安排 → 平台名永久卡「检测中...」。
  // 现在先安排自愈再执行正文：1.2s 后若仍「检测中」或元素未就绪就重调，上限 30 次（36s）兜底收敛。
  // ===== v1.2.351：自愈改为「全局计数 + shadow 树更换即重置」=====
  // 真根因（静态证据链）：头部元素来自 content/panel.html 的 span#ais-platform-name（初值「检测中...」），
  // 由 content.js 注入 closed shadow；content.js 重新注入面板时会先把 window.__AIS_SHADOW__ 置 null 再重建整棵树。
  // 面板重建后新树头部又是「检测中...」，而旧实现的一次性预算（36s / 30 次）在旧树上早已耗尽 → 再也不会重写
  // → 顶部永久「检测中...」（chips 与 AISIMG 都在同一新树里，所以看起来「面板是活的、只有平台名不动」）。
  // 修法：① 只要仍卡在「检测中...」就继续自愈（上限 900×1.2s≈18min）；
  //       ② 发现 shadow 树换了就立刻重置计数（面板一重建就重新给满额度）。
  try {
    if (window.__AIS_PLAT_ROOT__ !== window.__AIS_SHADOW__) {
      window.__AIS_PLAT_ROOT__ = window.__AIS_SHADOW__;
      window.__AIS_PLAT_N__ = 0;
    }
  } catch (eRT) {}
  var _n = retry || 0;
  if (_n === 0) { try { window.__AIS_PLAT_N__ = 0; } catch (eN0) {} }
  var _el0 = null;
  try { _el0 = __AIS_DOC().getElementById('ais-platform-name'); if (!_el0) _el0 = document.getElementById('ais-platform-name'); } catch (e0) {}
  var _stuck = (!_el0) || String(_el0.textContent || '').trim() === '检测中...';
  var _cnt = Number(window.__AIS_PLAT_N__) || 0;
  // v1.2.407：去掉「900 次上限」（原 900×1.2s≈18 分钟后**永久放弃** → 顶栏永久卡「检测中...」）。
  // 改为【无上限 + 退避】：前 30 次 1.2s，之后 5s 一次，直到真正显示成功；
  // 面板重建（shadow 根变化）时循环开头已重置计数，所以不会无限打转。
  if (_stuck) {
    try { window.__AIS_PLAT_N__ = _cnt + 1; } catch (eN1) {}
    var _delay = _cnt < 30 ? 1200 : 5000;
    setTimeout(function () { try { updatePlatformInfo(1); } catch (e2) {} }, _delay);
  }
  try {
    var info = window.__PlatformConfigs ? window.__PlatformConfigs.detect() : null;
    // v1.2.348：兜底平台名——即使 __PlatformConfigs 缺失 / 未命中（改版、地区版式、旧配置、脚本时序），
    // 也绝不让顶部停在「检测中...」。按 host + URL 形态给名（亚马逊真机实测：该平台此前完全没进 platform-configs）。
    if (!info || !info.platform || info.platform === 'generic') {
      // v1.2.354：先查【远程平台识别表】common.platformHosts = [[hostRe, platformKey, pageTypeRe?], ...]
      // 新平台/新域名/改版后站点只需改远端即可识别，无需发版。
      try {
        var __rows = aisArr('common.platformHosts', []);
        var __hx = String(location.hostname || '').toLowerCase(), __ux = String(location.href || '');
        for (var __ri = 0; __ri < __rows.length; __ri++) {
          var __row = __rows[__ri];
          if (!__row) continue;
          if (typeof __row === 'string') __row = __row.split('#');   // v1.2.356：分隔符改用 #（host 正则本身含 | ，用 | 会被切碎）   // 远程行也支持 "hostRe|platKey|pageRe" 字符串形式
          if (!__row.length) continue;
          var __re = new RegExp(__row[0], 'i');
          if (!__re.test(__hx)) continue;
          var __pt = 'home';
          if (__row[2]) { try { __pt = new RegExp(__row[2], 'i').test(__ux) ? 'detail' : 'home'; } catch (ePT) {} }
          info = { platform: String(__row[1] || 'generic'), pageType: __pt };
          break;
        }
      } catch (eRMT) {}
      try {
        var __h = String(location.hostname || '').toLowerCase(), __u = String(location.href || '');
        var __hf = null;
        if (/(^|\.)amazon\.[a-z.]{2,}$/.test(__h) || /(^|\.)amzn\.com$/.test(__h)) {
          __hf = { platform: 'amazon', pageType: (/\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\//i.test(__u) ? 'detail' : (/\/s\?|field-keywords|\/s\//i.test(__u) ? 'search' : 'home')) };
        } else if (/1688\.com$/.test(__h)) __hf = { platform: '1688', pageType: (/\/offer\//.test(__u) ? 'detail' : 'home') };
        else if (/tmall\.com$/.test(__h)) __hf = { platform: 'tmall', pageType: (/detail|item/.test(__h) || /\/item|\/detail/.test(__u) ? 'detail' : 'home') };
        else if (/taobao\.com$/.test(__h)) __hf = { platform: 'taobao', pageType: (/^item\./.test(__h) || /\/item/.test(__u) ? 'detail' : 'home') };
        else if (/jd\.com$/.test(__h) || /3\.cn$/.test(__h)) __hf = { platform: 'jd', pageType: (/^item\./.test(__h) || /\/item/.test(__u) ? 'detail' : 'home') };
        else if (/yangkeduo\.com$|pinduoduo\.com$/.test(__h)) __hf = { platform: 'pdd', pageType: (/goods/.test(__u) ? 'detail' : 'home') };
        if (__hf) info = __hf;
      } catch (eHF) {}
    }
    var nameEl = __AIS_DOC().getElementById('ais-platform-name');
    var dotEl = __AIS_DOC().querySelector('.ais-platform-dot');
    if (!nameEl) {
      // v1.2.330：shadow 引用缺失/不同步时回落到 document（legacy 挂载或影子引用指向旧 host）
      try { nameEl = document.getElementById('ais-platform-name'); } catch (eNF) {}
      try { if (!dotEl) dotEl = document.querySelector('.ais-platform-dot'); } catch (eNF2) {}
      if (!nameEl) return;
    }
    if (info && info.platform && info.platform !== 'generic') {
      // v1.2.187：平台标签改为「平台名 · 页面类型」（原来只显示「电商详情页」，用户看不出是哪个平台）
      var PLAT = { taobao: '淘宝', tmall: '天猫', jd: '京东', pdd: '拼多多', '1688': '1688', amazon: '亚马逊' };   // v1.2.284
      var PAGE = { detail: '详情页', search: '搜索页', home: '首页', login: '登录页' };
      var pName = PLAT[info.platform] || info.platform;
      nameEl.textContent = pName + (PAGE[info.pageType] ? ' · ' + PAGE[info.pageType] : '');
      if (dotEl) { dotEl.classList.remove('generic', 'detecting'); dotEl.classList.add('identified'); }
    } else {
      nameEl.textContent = '通用模式';
      if (dotEl) { dotEl.classList.remove('identified', 'detecting'); dotEl.classList.add('generic'); }
    }
  } catch(e) {
    var nameEl2 = __AIS_DOC().getElementById('ais-platform-name');
    if (nameEl2) nameEl2.textContent = '通用模式';
    var dotEl2 = __AIS_DOC().querySelector('.ais-platform-dot');
    if (dotEl2) { dotEl2.classList.remove('identified', 'detecting'); dotEl2.classList.add('generic'); }
  }
  // v1.2.323：原尾部自愈块（v1.1.67，n<3）已上移到函数开头并放宽到 30 次，此处不再重复安排。
}

// v1.2.329：看门狗已按用户要求卸载（不再 1.5s 轮询、不再往 document.title 写诊断标签）。
// 平台名仍由 updatePlatformInfo() 自身负责（含 v1.2.407 的无上限退避自愈）。

// v1.2.407：事件驱动的即时补查——切回标签页 / 页面重新可见时立刻再判一次平台名，
// 覆盖「面板重建、SPA 软导航、后台标签页计时器被节流」等场景。
try {
  document.addEventListener('visibilitychange', function () {
    try { if (!document.hidden) updatePlatformInfo(1); } catch (eV) {}
  });
  window.addEventListener('focus', function () { try { updatePlatformInfo(1); } catch (eF) {} });
  document.addEventListener('ssr:ready', function () { try { setTimeout(function(){ try { updatePlatformInfo(1); } catch (eS) {} }, 400); } catch (eS2) {} });
} catch (eEvt) {}

// ========== Keyboard Shortcuts ==========
// Alt+S：展开/收起面板  Alt+A：AI识别  Alt+M：手动选择  ESC：取消/最小化
function registerKeyboardShortcuts() {
  // 防重：热重载时先移除旧监听（同一个 handler 引用），避免键盘快捷键双触发
  if (window.__AIS_KB_HANDLER__) {
    try { document.removeEventListener('keydown', window.__AIS_KB_HANDLER__); } catch(e) {}
    window.__AIS_KB_HANDLER__ = null;
  }
  var _kbHandler = function(e) {
    // 忽略输入框中的按键（除了全局的Alt+S）
    // closed shadow 内按键冒泡到 document 时 e.target 被重定向为 host，
    // 若 target 是 host，改读 shadow 内 activeElement 做输入框判断
    // v1.2.281 快捷键设置：捕获模式优先响应
    if (window.__AIS_SHORT_CAPTURE__) {
      var cap = window.__AIS_SHORT_CAPTURE__;
      if (e.key === 'Escape') { window.__AIS_SHORT_CAPTURE__ = null; setStatus('已取消快捷键设置'); e.preventDefault(); return; }
      var cb = aisCombo(e);
      if (cb && cb.length > 1) {
        window.__AIS_SHORT_USER__ = window.__AIS_SHORT_USER__ || {};
        window.__AIS_SHORT_USER__[cap.name] = cb;
        try { chrome.storage.local.set({ aisShortcuts: window.__AIS_SHORT_USER__ }); } catch (e0) {}
        window.__AIS_SHORT_CAPTURE__ = null;
        window.__AIS_SHORT_IDX__ = (window.__AIS_SHORT_IDX__ || 0) + 1;
        setStatus('已把「' + (AIS_SHORT_NAMES[cap.name] || cap.name) + '」设为 ' + cb + '（再点一次菜单可继续改下一个）', true);
        e.preventDefault();
        return;
      }
    }
    var t = e.target;
    if (t === __AIS_HOST()) {
      try {
        var sh = window.__AIS_SHADOW__;
        if (sh && sh.activeElement) t = sh.activeElement;
      } catch(err) {}
    }
    var tag = (t.tagName || '').toLowerCase();
    var isInput = (tag === 'input' || tag === 'textarea' || tag === 'select' || t.isContentEditable);

    // Alt+S：切换面板显隐（全局，连输入框也响应）
    if (aisShortMatch(e, 'togglePanel')) {   // v1.2.281 可配置（默认 Alt+S）
      e.preventDefault();
      var floatBtn = __AIS_DOC().getElementById('ais-float-btn');
      var panel = __AIS_DOC().getElementById('ais-panel');
      if (!floatBtn || !panel) return;
      if (panel.classList.contains('ais-minimized')) {
        panel.classList.remove('ais-minimized');
        if (!panel.querySelector('.ais-step.active')) {
          var scanStep = __AIS_DOC().getElementById('ais-step-scan');
          if (scanStep) scanStep.classList.add('active');
        }
      } else {
        // 采集进行中不允许收起
        var progStep = __AIS_DOC().getElementById('ais-step-progress');
        if (progStep && progStep.classList.contains('active')) return;
        panel.classList.add('ais-minimized');
      }
      return;
    }

    if (isInput) return; // 以下快捷键在输入框中不触发

    // ESC：取消手动选择 / 收起面板
    if (aisShortMatch(e, 'close')) {   // v1.2.281 可配置（默认 Escape）
      var manualStep = __AIS_DOC().getElementById('ais-step-manual');
      if (manualStep && manualStep.classList.contains('active')) {
        // 不直接点击cancelBtn，让ManualSelector的_onKeyDown处理disable+CustomEvent
        // 这里只兜底：如果300ms后还在manual页，则强制回scan
        setTimeout(function() {
          var stillManual = __AIS_DOC().getElementById('ais-step-manual');
          if (stillManual && stillManual.classList.contains('active') && AIS.isManualSelect) {
            AIS.isManualSelect = false;
            if (AIS.pollTimer) clearInterval(AIS.pollTimer);
            if (window.__manualSelector) window.__manualSelector.disable();
            showStep('scan');
            setStatus('已取消');
          }
        }, 350);
        e.preventDefault();
        return;
      }
      // 重命名输入框中ESC由其自身处理
      var panel2 = __AIS_DOC().getElementById('ais-panel');
      if (panel2 && !panel2.classList.contains('ais-minimized')) {
        var progStep2 = __AIS_DOC().getElementById('ais-step-progress');
        if (progStep2 && progStep2.classList.contains('active')) return;
        panel2.classList.add('ais-minimized');
        e.preventDefault();
      }
      return;
    }

    // Alt+A：触发AI识别
    if (aisShortMatch(e, 'scan')) {   // v1.2.281 可配置（默认 Alt+A）
      e.preventDefault();
      var scanStep2 = __AIS_DOC().getElementById('ais-step-scan');
      if (scanStep2 && scanStep2.classList.contains('active')) {
        scanPage();
      }
      return;
    }

    // Alt+M：手动选择
    if (aisShortMatch(e, 'manual')) {   // v1.2.281 可配置（默认 Alt+M）
      e.preventDefault();
      var scanStep3 = __AIS_DOC().getElementById('ais-step-scan');
      if (scanStep3 && scanStep3.classList.contains('active')) {
        startManualSelect();
      }
      return;
    }

    // Alt+Enter：在预览页直接开始采集
    if (aisShortMatch(e, 'start')) {   // v1.2.281 可配置（默认 Alt+Enter）
      e.preventDefault();
      var previewStep = __AIS_DOC().getElementById('ais-step-preview');
      if (previewStep && previewStep.classList.contains('active')) {
        var startBtn = __AIS_DOC().getElementById('ais-btn-start');
        if (startBtn) startBtn.click();
      }
      return;
    }
  }; // end _kbHandler
  // ===== v1.2.281 快捷键可配置：远程 common.shortcuts 作默认 + 本地 aisShortcuts 覆盖 + 更多菜单里「按一次键即改」 =====
  var AIS_SHORT_DEFAULTS = { togglePanel: 'Alt+S', scan: 'Alt+A', manual: 'Alt+M', start: 'Alt+Enter', close: 'Escape' };
  try { window.startShortCapture = startShortCapture; window.resetShortcuts = resetShortcuts; } catch (eWS) {}
  var AIS_SHORT_NAMES = { togglePanel: '显示/收起面板', scan: 'AI识别', manual: '手动选择', start: '开始采集' };
  var AIS_SHORT_ORDER = ['togglePanel', 'scan', 'manual', 'start'];
  window.__AIS_SHORT_USER__ = window.__AIS_SHORT_USER__ || null;
  window.__AIS_SHORT_IDX__ = window.__AIS_SHORT_IDX__ || 0;
  window.__AIS_SHORT_CAPTURE__ = null;
  function aisShortMap() {
    var m = {};
    Object.keys(AIS_SHORT_DEFAULTS).forEach(function (k) { m[k] = AIS_SHORT_DEFAULTS[k]; });
    try { aisArr('common.shortcuts', []).forEach(function (p) { if (p && p[0] && p[1]) m[String(p[0])] = String(p[1]); }); } catch (e) {}
    var u = window.__AIS_SHORT_USER__;
    if (u) Object.keys(u).forEach(function (k) { if (u[k]) m[k] = String(u[k]); });
    return m;
  }
  function aisCombo(e) {
    var parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    if (e.metaKey) parts.push('Meta');
    var k = e.key;
    if (k === ' ') k = 'Space';
    if (k && k.length === 1) k = k.toUpperCase();
    parts.push(k);
    return parts.join('+');
  }
  function aisShortMatch(e, name) { try { return aisCombo(e) === (aisShortMap()[name] || '__none__'); } catch (err) { return false; } }
  function startShortCapture() {
    try {
      var n = AIS_SHORT_ORDER[window.__AIS_SHORT_IDX__ % AIS_SHORT_ORDER.length];
      window.__AIS_SHORT_CAPTURE__ = { name: n };
      setStatus('请按下「' + (AIS_SHORT_NAMES[n] || n) + '」的新组合键（Esc 取消）', 'warn');
    } catch (e) { setStatus('快捷键设置失败'); }
  }
  function resetShortcuts() {
    try { window.__AIS_SHORT_USER__ = null; chrome.storage.local.remove('aisShortcuts', function () { setStatus('已恢复默认快捷键', true); }); } catch (e) { setStatus('恢复失败'); }
  }
  try { chrome.storage.local.get(['aisShortcuts'], function (r) { try { window.__AIS_SHORT_USER__ = (r && r.aisShortcuts) || null; } catch (e) {} }); } catch (e) {}
  window.__AIS_KB_HANDLER__ = _kbHandler;
  document.addEventListener('keydown', _kbHandler);
}

// ========== Scan ==========
// ========== 拼多多 H5 SSR JSON 数据源 ==========
// 拼多多移动站(yangkeduo.com)会把商品列表明文写入 window.rawData（SSR JSON），
// 而 DOM 中标题/价格用自定义字体混淆，直接读 JSON 最可靠、字段最全
async function tryPddH5JsonSource() {
  var href = location.href || '';
  if (href.indexOf('yangkeduo.com') < 0) return null;
  // 隔离世界拿不到主世界的 window.rawData，经 background 在主世界执行脚本读取
  var resp = await new Promise(function(resolve) {
    var done = false;
    var timer = setTimeout(function() { if (!done) { done = true; resolve(null); } }, 4000);
    try {
      chrome.runtime.sendMessage({ action: 'mainWorldGetPddRawData' }, function(r) {
        if (!done) { done = true; clearTimeout(timer); resolve(r); }
      });
    } catch (e) {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    }
  });
  // executeScript 的结果会外套一层 {documentId, frameId, result} ，需要解包
  var payload = resp.result && resp.result.result ? resp.result.result : resp.result;
  if (!resp || !resp.success || !payload || !payload.ok) return null;
  var list = payload.list || null;
  if (!list || !list.length) return null;
  var items = [];
  for (var i = 0; i < list.length; i++) {
    var it = list[i];
    if (!it || !it.goodsName || !it.goodsID) continue;
    var price = it.price;
    if (price == null && it.priceInfo != null) price = parseFloat(String(it.priceInfo));
    // 拼多多 price 单位为分，统一转成元
    if (typeof price === 'number' && isFinite(price)) {
      price = (price / 100).toFixed(2);
    } else if (typeof price === 'string') {
      var pn = parseFloat(price);
      price = isFinite(pn) ? (pn / 100).toFixed(2) : price;
    } else {
      price = '';
    }
    var img = it.imgUrl || it.longImgUrl || it.thumbWM || '';
    var link = it.linkURL || ('goods.html?goods_id=' + it.goodsID);
    if (link.indexOf('http') !== 0) link = 'https://mobile.yangkeduo.com/' + link.replace(/^\/+/, '');
    items.push({
      '标题': it.goodsName || '',
      '价格': price,
      '销量': it.salesTip || '',
      '图片': img,
      '链接': link,
      '商品ID': String(it.goodsID)
    });
  }
  return items.length ? items : null;
}

async function scanPage() {
  setStatus('正在 AI 识别...');

  // 拼多多 H5：优先使用 SSR JSON 数据源（DOM 中标题/价格被字体混淆）
  AIS.jsonMode = false;
  var jsonItems = null;
  // 拼多多 H5 的 rawData 偶尔会延迟加载，重试几次再回落到 DOM 扫描
  for (var jt = 0; jt < 3; jt++) {
    try { jsonItems = await tryPddH5JsonSource(); }
    catch (err) { console.error('[电商采集大师] 拼多多H5数据源异常:', err); }
    if (jsonItems) break;
    if (jt < 2) { setStatus('正在读取拼多多数据源...'); await new Promise(function(r){ setTimeout(r, 1200); }); }
  }
  if (jsonItems) {
    AIS.jsonMode = true;
    AIS.jsonItems = jsonItems;
    AIS.fields = [
      { name: '标题', displayName: '标题', sample: String(jsonItems[0]['标题'] || '').substring(0, 30) },
      { name: '价格', displayName: '价格', sample: String(jsonItems[0]['价格'] || '') },
      { name: '销量', displayName: '销量', sample: String(jsonItems[0]['销量'] || '') },
      { name: '图片', displayName: '图片', sample: String(jsonItems[0]['图片'] || '').substring(0, 40) },
      { name: '链接', displayName: '链接', sample: String(jsonItems[0]['链接'] || '').substring(0, 40) },
      { name: '商品ID', displayName: '商品ID', sample: String(jsonItems[0]['商品ID'] || '') }
    ];
    AIS.containerSelector = '';
    renderFieldList();
    loadPreview();
    showStep('preview');
    setStatus('识别到 ' + AIS.fields.length + ' 个字段 [拼多多H5数据源]');
    return;
  }

  // 详情页自动切换到详情采集模式（列表扫描不适用于单商品详情页）
  var dc = window.__detailCollector;
  if (dc && dc.isDetailPage()) {
    console.log('[电商采集大师] 检测到详情页，自动切换到深度采集模式');
    setStatus('检测到详情页，启动深度采集...');
    return startDetailCollection();
  }

  // 列表采集模式：重置详情模式标志
  AIS.detailMode = false;

  var s = window.__aiScraper;
  var containers = [];
  try {
    containers = s.scanDataContainers();
  } catch (err) {
    console.error('[电商采集大师] 扫描异常:', err);
    setStatus('扫描异常: ' + err.message);
    return;
  }
  if (containers.length === 0) {
    setStatus('未检测到数据');
    // 给出可操作的诊断建议
    var tip = __AIS_DOC().querySelector('.ais-hero-desc');
    if (tip) {
      tip.innerHTML = '未找到商品列表，请尝试：<br>1. <strong>手动框选区域</strong>（推荐）<br>2. 滚动页面让商品加载<br>3. 确认页面已登录并显示商品';
    }
    return;
  }
  // 平台配置识别的容器绝对优先（标记 platform: true）
  // 不与通用扫描比较字段数，因为非商品容器可能产生更多假阳性字段
  var platformContainers = containers.filter(function(c){ return c.platform; });
  var bestContainer, bestFields;
  if (platformContainers.length > 0) {
    bestContainer = platformContainers[0];
    bestFields = s.identifyFields(bestContainer.element);
  } else {
    // 无平台配置时，通用扫描：选字段最多的
    bestContainer = containers[0];
    bestFields = [];
    for (var ci = 0; ci < Math.min(containers.length, 3); ci++) {
      var fields = s.identifyFields(containers[ci].element);
      if (fields.length > bestFields.length) {
        bestFields = fields;
        bestContainer = containers[ci];
      }
    }
  }
  AIS.fields = bestFields;
  AIS.containerSelector = bestContainer.selector;
  renderFieldList();
  loadPreview();
  showStep('preview');
  // 显示平台信息
  var platformName = '';
  if (window.__PlatformConfigs) {
    var pInfo = window.__PlatformConfigs.detect();
    platformName = ' [' + pInfo.name + ']';
  }
  setStatus('识别到 ' + AIS.fields.length + ' 个字段' + platformName);
}

// ========== Manual Select ==========
async function startManualSelect() {
  AIS.isManualSelect = true;
  showStep('manual');
  setStatus('点击页面数据区域...');
  window.__manualSelector.enable();

  // Poll for storage result
  AIS.pollTimer = setInterval(async function() {
    var r = await chrome.storage.local.get(['manualSelectResult']);
    if (r.manualSelectResult && Date.now() - r.manualSelectResult.timestamp < 30000) {
      cleanupManualListeners();
      handleManualResult(r.manualSelectResult);
    }
  }, 500);

  // 统一清理（修复：原 30s 超时只清 pollTimer，未移除 onMessage/window 监听导致泄漏）
  function cleanupManualListeners() {
    if (AIS.pollTimer) { clearInterval(AIS.pollTimer); AIS.pollTimer = null; }
    try { chrome.runtime.onMessage.removeListener(handler); } catch (e) {}
    try { window.removeEventListener('ui:cancel', cancelHandler); } catch (e) {}
  }

  // Also listen for real-time message
  var handler = function(request) {
    if (request.action === 'containerSelected') {
      cleanupManualListeners();
      chrome.storage.local.get(['manualSelectResult'], function(r) {
        if (r.manualSelectResult) handleManualResult(r.manualSelectResult);
      });
    }
  };
  // 同上下文ESC取消事件（chrome.runtime.sendMessage不会触发自身onMessage）
  var cancelHandler = function() {
    cleanupManualListeners();
    if (AIS.isManualSelect) {
      AIS.isManualSelect = false;
      showStep('scan');
      setStatus('已取消');
    }
  };
  window.addEventListener('ui:cancel', cancelHandler);
  chrome.runtime.onMessage.addListener(handler);
  setTimeout(function() { cleanupManualListeners(); }, 30000);
}

function cancelManualSelect() {
  AIS.isManualSelect = false;
  if (AIS.pollTimer) clearInterval(AIS.pollTimer);
  window.__manualSelector.disable();
  showStep('scan');
  setStatus('已取消');
}

function handleManualResult(result) {
  AIS.isManualSelect = false;
  AIS.containerSelector = result.selector;
  AIS.fields = result.fields;
  window.__manualSelector.disable();
  renderFieldList();
  loadPreview();
  showStep('preview');
  setStatus('识别到 ' + AIS.fields.length + ' 个字段');
}

// ========== Fields ==========
function renderFieldList() {
  var list = __AIS_DOC().getElementById('ais-field-list');
  var html = '';
  for (var i = 0; i < AIS.fields.length; i++) {
    var f = AIS.fields[i];
    var displayName = f.displayName || f.name;
    var escName = escapeHtml(displayName);
    html += '<div class="ais-field-item">' +
      '<input type="checkbox" id="fld_' + i + '" checked value="' + escapeHtml(f.name) + '" data-idx="' + i + '">' +
      '<label for="fld_' + i + '" class="ais-field-name" data-idx="' + i + '" title="双击重命名">' + escName + '</label>' +
      '<input type="text" class="ais-field-edit ais-hidden" data-idx="' + i + '" value="' + escName + '">' +
      '<span class="ais-field-sample">' + escapeHtml(f.sample || '') + '</span>' +
      '<button class="ais-field-remove" data-idx="' + i + '" title="删除字段">×</button>' +
      '</div>';
  }
  list.innerHTML = html;
  __AIS_DOC().getElementById('ais-field-count').textContent = AIS.fields.length;

  // Remove buttons
  var removes = list.querySelectorAll('.ais-field-remove');
  for (var r = 0; r < removes.length; r++) {
    (function(idx) {
      removes[r].addEventListener('click', function(e) {
        e.stopPropagation();
        AIS.fields.splice(idx, 1);
        renderFieldList();
        loadPreview();
      });
    })(r);
  }

  // 双击重命名
  var nameEls = list.querySelectorAll('.ais-field-name');
  for (var n = 0; n < nameEls.length; n++) {
    (function(idx) {
      var nameEl = nameEls[idx];
      nameEl.addEventListener('dblclick', function(e) {
        e.stopPropagation();
        startRenameField(idx);
      });
    })(n);
  }

  // 重命名输入框事件
  var editEls = list.querySelectorAll('.ais-field-edit');
  for (var ed = 0; ed < editEls.length; ed++) {
    (function(idx) {
      var editEl = editEls[ed];
      editEl.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { e.preventDefault(); commitRename(idx, this.value); }
        else if (e.key === 'Escape') { e.preventDefault(); cancelRename(idx); }
      });
      editEl.addEventListener('blur', function() { commitRename(idx, this.value); });
    })(ed);
  }
}

function startRenameField(idx) {
  var item = __AIS_DOC().querySelector('.ais-field-item:nth-child(' + (idx + 1) + ')');
  if (!item) return;
  var label = item.querySelector('.ais-field-name');
  var edit = item.querySelector('.ais-field-edit');
  if (!label || !edit) return;
  label.classList.add('ais-hidden');
  edit.classList.remove('ais-hidden');
  edit.focus();
  edit.select();
}

function commitRename(idx, value) {
  value = (value || '').trim();
  if (!value) { cancelRename(idx); return; }
  if (AIS.fields[idx]) {
    AIS.fields[idx].displayName = value;
  }
  renderFieldList();
  loadPreview();
}

function cancelRename(idx) {
  var item = __AIS_DOC().querySelector('.ais-field-item:nth-child(' + (idx + 1) + ')');
  if (!item) return;
  var label = item.querySelector('.ais-field-name');
  var edit = item.querySelector('.ais-field-edit');
  if (label) label.classList.remove('ais-hidden');
  if (edit) edit.classList.add('ais-hidden');
}

function getActiveFields() {
  var cbs = __AIS_DOC().querySelectorAll('#ais-field-list input[type="checkbox"]');
  var active = [];
  for (var i = 0; i < cbs.length; i++) {
    if (cbs[i].checked) {
      var f = AIS.fields[parseInt(cbs[i].dataset.idx)];
      if (f) active.push(f);
    }
  }
  return active;
}

async function loadPreview() {
  var s = window.__aiScraper;
  var fields = getActiveFields();
  if (fields.length === 0) return;

  var data;
  if (AIS.jsonMode && AIS.jsonItems) {
    data = AIS.jsonItems;
  } else {
    data = await s.extractCurrentPage(fields, AIS.containerSelector);
  }
  renderPreview(data, fields);
}

function renderPreview(data, fields) {
  var preview = __AIS_DOC().getElementById('ais-preview-table');
  if (!data || data.length === 0) {
    preview.innerHTML = '<div style="padding:14px;color:#94a3b8;text-align:center;font-size:12px;">未提取到数据，请尝试其他字段或手动选择容器</div>';
    return;
  }
  var html = '<table><thead><tr>';
  for (var i = 0; i < fields.length; i++) {
    var dn = fields[i].displayName || fields[i].name;
    html += '<th>' + escapeHtml(dn) + '</th>';
  }
  html += '</tr></thead><tbody>';
  var limit = Math.min(data.length, 5);
  for (var r = 0; r < limit; r++) {
    html += '<tr>';
    for (var f = 0; f < fields.length; f++) {
      var v = data[r][fields[f].name] || '';
      html += '<td title="' + escapeHtml(v) + '">' + escapeHtml(v) + '</td>';
    }
    html += '</tr>';
  }
  html += '</tbody></table>';
  if (data.length > 5) {
    html += '<div style="padding:6px 8px;color:#94a3b8;font-size:11px;text-align:center;border-top:1px solid var(--ais-border-soft);">显示前 5 条 / 共 ' + data.length + ' 条</div>';
  }
  preview.innerHTML = html;
}

// ========== Scraping ==========
// 采集时彻底隐藏面板，避免遮挡商品页/评论弹窗/滚动条；采集结束恢复
// 评论概览汇总：从 ratingDistribution/total 计算好评率/差评率/均分（修复：原读不存在的 stats.summary）
function __reviewSummary(stats) {
  var out = { positiveRate: 0, negativeRate: 0, avgRating: 0 };
  if (!stats) return out;
  var rd = stats.ratingDistribution || {};
  var total = stats.total || 0;
  var sum = 0, cnt = 0;
  for (var k in rd) { var g = rd[k]; if (!g) continue; var nn = g.count || 0; var ss = parseInt(k, 10) || 0; sum += ss * nn; cnt += nn; }
  var pos = (rd['4']?rd['4'].count:0) + (rd['5']?rd['5'].count:0);
  var neg = (rd['1']?rd['1'].count:0) + (rd['2']?rd['2'].count:0);
  if (total) { out.positiveRate = Math.round(pos / total * 100); out.negativeRate = Math.round(neg / total * 100); }
  if (cnt) out.avgRating = String((sum / cnt).toFixed(1));
  return out;
}
function hidePanel() { try { var _p = __AIS_DOC().getElementById('ais-panel'); if (_p) _p.style.display = 'none'; } catch(e) {} }
function showPanel() { try { var _p = __AIS_DOC().getElementById('ais-panel'); if (_p) _p.style.display = ''; } catch(e) {} }
async function startScraping() {
  if (window.__aiScraper && window.__aiScraper.isRunning) { try { setStatus('采集已在进行中'); } catch(e) {} return; } // 修复：防并发
  // 采集时彻底隐藏扩展面板，避免遮挡页面/评论弹窗/滚动条
  hidePanel();
  var fields = getActiveFields();
  if (fields.length === 0) { aisToast('请至少选择一个字段', 'warn'); return; }

  // 起止页码：maxPages = 截止页，startPage = 起始页
  var startPage = parseInt(__AIS_DOC().getElementById('ais-start-page').value) || 1;
  var endPage = parseInt(__AIS_DOC().getElementById('ais-end-page').value) || 1;
  if (startPage > endPage) endPage = startPage;
  var maxPages = endPage;
  var collectCount = endPage - startPage + 1; // 实际采集页数

  // 授权校验：多页采集（采集页数 > 1 时需要专业版）
  if (collectCount > 1) {
    var allowed = await requirePaidFeature('multi_page', '多页批量采集');
    if (!allowed) return;
  }

  AIS.data = [];
  AIS.totalCollected = 0;

  // 拼多多 H5：JSON 数据源直接使用，无需 DOM 翻页
  if (AIS.jsonMode && AIS.jsonItems) {
    showStep('progress');
    updateProgress(1, 1);
    AIS.data = (AIS.jsonItems || []).slice();
    AIS.totalCollected = AIS.data.length;
    showDone();
    return;
  }

  // 通知 background worker 记录平台活跃（用于会话保活）
  try { chrome.runtime.sendMessage({ action: 'trackPlatform' }); } catch(e) {}

  showStep('progress');
  updateProgress(0, collectCount);

  var s = window.__aiScraper;
  s.isRunning = true;

  // 轮询 __aiScraper 状态更新进度
  var jumpPhase = startPage > 1;
  var pollTimer = setInterval(function() {
    if (!s.isRunning) return;
    // 风控暂停：检测到验证码/风控页面时显示提示浮层，等待用户完成验证
    if (typeof AntiCrawl !== 'undefined' && AntiCrawl.isPaused()) {
      ensureAntiCrawlPauseOverlay();
      return;
    }
    if (jumpPhase && s.currentPage < startPage) {
      // 跳页阶段
      __AIS_DOC().getElementById('ais-progress-info').textContent = '正在跳转到第 ' + startPage + ' 页...';
      __AIS_DOC().getElementById('ais-progress-pct').textContent = '...';
    } else {
      jumpPhase = false;
      // 采集阶段：使用实际已采集页数（由content.js维护）
      var collected = s._collectedPages || 0;
      updateProgress(Math.min(collected, collectCount), collectCount);
      // 附加已采集条数信息
      var itemCount = (s.extractedData ? s.extractedData.length : 0) || (AIS.data ? AIS.data.length : 0) || 0;
      var hintEl = __AIS_DOC().getElementById('ais-progress-hint');
      if (hintEl && itemCount > 0) {
        hintEl.textContent = '已采集 ' + itemCount + ' 条数据，请勿关闭页面';
      }
    }
  }, 400);

  s.scrapeAllPages(fields, maxPages, AIS.containerSelector, startPage).then(function(data) {
    clearInterval(pollTimer);
    AIS.data = data;
    AIS.totalCollected = data.length;
    // v1.1.40：普通列表采集也写入采集历史（此前仅增量采集写入，导致历史不生效）
    saveToHistory({
      type: 'list',
      url: window.location.href,
      title: document.title || '列表采集',
      itemCount: data.length,
      data: data.slice(0, 100),
      fields: AIS.fields,
      timestamp: Date.now()
    });
    showDone();
  }).catch(function(err) {
    clearInterval(pollTimer);
    s.isRunning = false;
    console.error('[电商采集大师] 采集失败:', err);
    aisAlert('采集失败: ' + (err && err.message ? err.message : '未知错误') + '\n\n已采集的数据仍可在完成页导出。', { type: 'error' });
    if (AIS.data && AIS.data.length > 0) {
      AIS.totalCollected = AIS.data.length;
      showDone();
    } else {
      showStep('scan');
      setStatus('采集失败');
    }
  });
}

function updateProgress(current, total) {
  var pct = total > 0 ? Math.round((Math.min(current, total) / total) * 100) : 0;
  __AIS_DOC().getElementById('ais-progress-circle').setAttribute('stroke-dasharray', pct + ' 100');
  __AIS_DOC().getElementById('ais-progress-pct').textContent = pct + '%';
  __AIS_DOC().getElementById('ais-progress-info').textContent = '第 ' + current + ' / ' + total + ' 页';
}

// 风控暂停浮层：用户完成验证后点击继续
function ensureAntiCrawlPauseOverlay() {
  var overlay = __AIS_DOC().getElementById('ais-anticrawl-overlay');
  if (overlay) return;
  overlay = document.createElement('div');
  overlay.id = 'ais-anticrawl-overlay';
  overlay.className = 'ais-modal-mask';
  overlay.innerHTML = '<div class="ais-anticrawl-box">' +
    '<div class="ais-anticrawl-icon">🛡️</div>' +
    '<div class="ais-anticrawl-title">检测到风控 / 验证码</div>' +
    '<div class="ais-anticrawl-desc">采集已自动暂停。请切换到页面完成验证码或人工验证，然后点击继续。</div>' +
    '<div class="ais-anticrawl-actions">' +
      '<button type="button" class="ais-btn ais-btn-primary" id="ais-anticrawl-resume">✅ 已完成验证，继续采集</button>' +
      '<button type="button" class="ais-btn ais-btn-danger" id="ais-anticrawl-stop">停止采集</button>' +
    '</div>' +
  '</div>';
  (aisPanelViewHost() || __AIS_DOC()).appendChild(overlay);
  var resumeBtn = overlay.querySelector('#ais-anticrawl-resume');
  if (resumeBtn) resumeBtn.addEventListener('click', function() {
    if (typeof AntiCrawl !== 'undefined') AntiCrawl.setPaused(false);
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    aisPanelViewDismiss(); // v1.2.243：同上，空宿主会挡住整个面板
  });
  var stopBtn = overlay.querySelector('#ais-anticrawl-stop');
  if (stopBtn) stopBtn.addEventListener('click', function() {
    stopScraping();
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  });
}

// 授权已达免费版页数上限提示
// 购买页：发卡网（5分钟自动发码）。年卡 u4gl3l，月卡 poydkp
// Local capabilities do not depend on a license, clock, storage or network.
function refreshMemberCache() {
  state.aisIsMember = true;
  state.aisLicenseReady = true;
  state.aisLicenseStatus = 'local';
}
function isMemberNow() { return true; }


function hisPackFree() { try { return aisSel('common.historyPackFree', 'off') === 'on'; } catch (e) { return false; } }
function requireHisPack(featureLabel) { return hisPackFree() ? true : requireMember(featureLabel); }
function requireMember(featureLabel) { return true; }

function showTrialNotice() { LicenseModal.show(); }

function showLicenseLimitNotice() {}

try { chrome.runtime.onMessage.addListener(function(msg, sender, sendResp) { try { if (msg && msg.action === 'licenseLimitReached') { showLicenseLimitNotice(msg.pageLimit, msg.count); } } catch(e) {} if (sendResp) sendResp({ ok: true }); }); } catch(e) {}
async function stopScraping() {
  // 保存断点：用户主动停止时记录当前进度
  try { saveCurrentBreakpoint(); } catch(e) { console.warn('[电商采集大师] 保存断点失败:', e); }
  // 停止采集（做空值/异常保护，避免点击无效）
  try {
    var sc = window.__aiScraper;
    if (sc && typeof sc.stopScraping === 'function') sc.stopScraping();
    else { console.warn('[电商采集大师] __aiScraper 未就绪，无法停止'); }
    // 同时停止详情/评论采集器（DetailCollector，独立于列表采集器）
    if (typeof window.DetailCollector !== 'undefined' && window.DetailCollector) {
      window.DetailCollector.stopCollection();
    }
  } catch(e) { console.warn('[电商采集大师] 停止采集异常:', e); }
  // 恢复被隐藏的面板
  try { showPanel(); } catch(e) {}
  // 立即给出反馈，不阻塞
  setStatus('已停止，正在保存已采集数据...');
}

// ========== Export ==========
// CSV 美化生成器位于 lib/csv-beautifier.js（全局 window.CSVBeautifier）
// 生成结构化、带分区和装饰分隔符的 CSV 报告

// 价格字段格式统一：提取纯数字并保留2位小数（去¥￥$符号、千分位逗号、单位）
// 输入 "¥299" / "2,199.00" / "券后268元" → 输出 "299.00" / "2199.00" / "268.00"
function normalizePrice(value) {
  if (value == null) return value;
  var s = String(value).trim();
  if (!s) return s;
  // 提取数字部分（含小数点和千分位）
  var m = s.replace(/[¥￥$,\s]/g, '').match(/(\d+(?:\.\d+)?)/);
  if (!m) return s; // 无数字则原样返回
  var num = parseFloat(m[1]);
  if (isNaN(num)) return s;
  return num.toFixed(2);
}

// 对数据行的价格字段做格式统一（返回新数组，不改原数据）
function normalizePriceFields(data, fields) {
  var priceKeys = (fields || []).filter(function(f) {
    return /价格|price/i.test(f);
  });
  if (priceKeys.length === 0) return data;
  return data.map(function(row) {
    var nr = {};
    for (var k in row) {
      if (priceKeys.indexOf(k) >= 0) {
        nr[k] = normalizePrice(row[k]);
      } else {
        nr[k] = row[k];
      }
    }
    return nr;
  });
}

async function exportCSV() {
  try {
    var r = await chrome.storage.local.get(['lastData', 'lastFields', 'detailData', 'skuData', 'reviewData', 'isDetailPage', 'platform']);

    var csv, filename;

    if (r.isDetailPage && r.detailData) {
      // 详情页：分区结构美化 CSV
      var d = JSON.parse(JSON.stringify(r.detailData)); // 深拷贝，避免污染原数据
      // 价格格式统一
      if (d.basic && d.basic.price) d.basic.price = normalizePrice(d.basic.price);
      if (d.skus) d.skus.forEach(function(s) { if (s.price) s.price = normalizePrice(s.price); });
      var reviewStats = (d.reviews && d.reviews.length > 0 && window.StatsAnalyzer)
        ? { reviewAnalysis: window.StatsAnalyzer.analyzeReviews(d.reviews) }
        : null;
      var goodRate = calculateGoodRate(d.reviews || []);
      csv = CSVBeautifier.buildDetailCSV(d, reviewStats, goodRate);
      var itemId = d.itemId || 'detail';
      filename = 'ai-scraper-详情-' + itemId + '-' + new Date().toISOString().slice(0, 10) + '.csv';
    } else {
      // 列表页：表格 + 统计摘要美化 CSV
      if (!r.lastData || !r.lastFields || r.lastData.length === 0) {
        console.warn('[导出] 无数据可导出', { lastData: r.lastData, lastFields: r.lastFields });
        { aisToast('无数据可导出，请先采集商品数据', 'warn'); return; }
      }
      var fields = r.lastFields;
      // 价格格式统一（深拷贝后清洗，不改原数据）
      var data = normalizePriceFields(r.lastData, fields);
      var stats = (window.StatsAnalyzer && data.length > 0)
        ? window.StatsAnalyzer.analyzeListData(data, fields.map(function(f) { return { name: f }; }))
        : null;
      var meta = [
        ['导出时间', new Date().toLocaleString('zh-CN')],
        ['数据来源', r.platform || '未知平台'],
        ['数据条数', data.length + ' 条'],
        ['字段数量', fields.length + ' 个']
      ];
      csv = CSVBeautifier.buildListCSV(data, fields, stats, meta);
      filename = 'ai-scraper-列表-' + new Date().toISOString().slice(0, 10) + '.csv';
    }

    var csvBom = (csv && csv.charCodeAt(0) === 0xFEFF) ? csv : ('\uFEFF' + (csv || '')); // 修复：中文 CSV 补 BOM
    var blob = new Blob([csvBom], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('CSV 已下载（美化版）');
  } catch (err) {
    console.error('导出CSV错误:', err);
    aisToast('导出失败: ' + err.message, 'error');
  }
}

async function exportJSON() {
  try {
    var r = await chrome.storage.local.get(['lastData', 'lastFields', 'detailData', 'skuData', 'reviewData', 'isDetailPage']);

    var exportObj;
    if (r.isDetailPage && r.detailData) {
      // 详情页：导出完整结构化数据（含统计）
      exportObj = {
        exportTime: new Date().toISOString(),
        type: 'detail',
        basic: r.detailData.basic,
        skus: r.detailData.skus,
        reviews: r.detailData.reviews,
        images: r.detailData.images,
        parameters: r.detailData.parameters,
        reviewAnalysis: (r.detailData.reviews && r.detailData.reviews.length > 0 && window.StatsAnalyzer)
          ? window.StatsAnalyzer.analyzeReviews(r.detailData.reviews) : null,
        disclaimer: '本数据由 电商采集大师 工具自动采集自公开网页，仅供个人学习、研究使用。用户应遵守各平台服务协议及相关法律法规，不得用于商业用途或侵权行为。数据准确性不作保证，使用风险自负。工具开发者不承担因数据使用产生的任何法律责任。'
      };
    } else {
      // 列表页：导出数据 + 统计
      if (!r.lastData || r.lastData.length === 0) {
        { aisToast('无数据可导出，请先采集数据', 'warn'); return; }
      }
      var fields = r.lastFields || Object.keys(r.lastData[0] || {});
      exportObj = {
        exportTime: new Date().toISOString(),
        type: 'list',
        fields: fields,
        data: r.lastData,
        stats: window.StatsAnalyzer
          ? window.StatsAnalyzer.analyzeListData(r.lastData, fields.map(function(f) { return { name: f }; }))
          : null,
        disclaimer: '本数据由 电商采集大师 工具自动采集自公开网页，仅供个人学习、研究使用。用户应遵守各平台服务协议及相关法律法规，不得用于商业用途或侵权行为。数据准确性不作保证，使用风险自负。工具开发者不承担因数据使用产生的任何法律责任。'
      };
    }

    var json = JSON.stringify(exportObj, null, 2);
    var blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ai-scraper-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('JSON 已下载');
  } catch (err) {
    console.error('导出JSON错误:', err);
    aisToast('导出失败: ' + err.message, 'error');
  }
}

async function copyData() {
  try {
    var r = await chrome.storage.local.get(['lastData', 'lastFields', 'detailData', 'skuData', 'reviewData', 'isDetailPage']);
    
    if (r.isDetailPage && r.detailData) {
      var flatData = await generateDetailFlatData(r.detailData, r.skuData, r.reviewData);
      r.lastData = [flatData];
      r.lastFields = Object.keys(flatData);
    }
    
    if (!r.lastData || !r.lastFields || r.lastData.length === 0) {
      { aisToast('无数据可导出，请先采集商品数据', 'warn'); return; }
    }

    var fields = r.lastFields, data = r.lastData;
    var text = fields.join('\t') + '\n';
    for (var i = 0; i < data.length; i++) {
      var row = [];
      for (var f = 0; f < fields.length; f++) row.push(data[i][fields[f]] || '');
      text += row.join('\t') + '\n';
    }

    try {
      await navigator.clipboard.writeText(text);
      setStatus('已复制到剪贴板');
    } catch(e) {
      var ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setStatus('已复制到剪贴板');
    }
  } catch (err) {
    console.error('复制错误:', err);
    aisToast('复制失败: ' + err.message, 'error');
  }
}

// Helper: Generate flat data from detailData
async function generateDetailFlatData(detailData, skuData, reviewData) {
  if (!detailData) return {};
  
  var data = detailData;
  var result = {
    '商品ID': data.itemId || '',
    '商品标题': (data.basic && data.basic.title) || '',
    '商品价格': (data.basic && data.basic.price) || '',
    '店铺名称': (data.basic && data.basic.shopName) || '',
    '销量': (data.basic && data.basic.salesText) || '',
    '评分': (data.basic && data.basic.rating) || '',
    '详情页URL': data.url || '',
    '采集时间': data.timestamp || '',
    '商品参数': (data.parameters || []).map(p => `${p.name}:${p.value}`).join('; '),
    'SKU数量': (data.skus || []).length,
    '评论数量': (data.reviews || []).length,
    '好评率': calculateGoodRate(data.reviews || [])
  };
  
  (data.images || []).forEach((img, i) => {
    result['图片' + (i + 1)] = img;
  });
  
  return result;
}

function calculateGoodRate(reviews) {
  if (!reviews || reviews.length === 0) return '';
  var goodCount = reviews.filter(function(r) { return r.rating >= 4; }).length;
  return Math.round((goodCount / reviews.length) * 100) + '%';
}

// ========== Storage check ==========
async function checkStoredSelection() {
  var r = await chrome.storage.local.get(['manualSelectResult']);
  if (r.manualSelectResult && Date.now() - r.manualSelectResult.timestamp < 60000) {
    AIS.containerSelector = r.manualSelectResult.selector;
    AIS.fields = r.manualSelectResult.fields;
    renderFieldList();
    loadPreview();
    showStep('preview');
    setStatus('已恢复上次选择');
    await chrome.storage.local.remove('manualSelectResult');
  }
}


async function downloadImages() {
  var r = await chrome.storage.local.get(['lastData']);
  if (!r.lastData || r.lastData.length === 0) { aisToast('无数据可导出图片', 'warn'); return; }

  var imageFields = [];
  // Find image fields in the first record
  if (r.lastData.length > 0) {
    var first = r.lastData[0];
    for (var key in first) {
      if (/图片|image|img|图/i.test(key)) {
        imageFields.push(key);
      }
    }
  }

  if (imageFields.length === 0) { aisToast('未找到图片字段', 'warn'); return; }
  var totalImgs = 0;
  for (var ti = 0; ti < r.lastData.length; ti++) {
    for (var tf = 0; tf < imageFields.length; tf++) {
      var u = r.lastData[ti][imageFields[tf]];
      if (u && u.indexOf('http') === 0) totalImgs++;
    }
  }
  if (totalImgs === 0) { aisToast('未找到可下载的图片URL', 'warn'); return; }

  // 选择保存目录：调用浏览器原生"选择文件夹"对话框（Windows 文件夹选择器风格），记忆上次选择
  var saveFolder = 'aiscraper-img';
  try {
    var savedFolder = await chrome.storage.local.get(['ais_img_folder']);
    if (savedFolder && savedFolder.ais_img_folder) saveFolder = savedFolder.ais_img_folder;
  } catch(e) {}
  try {
    // 原生文件夹选择器：<input type="file" webkitdirectory> 会弹出系统"选择文件夹"窗口
    var chosen = await new Promise(function(resolve) {
      var input = document.createElement('input');
      input.type = 'file';
      input.webkitdirectory = true;
      input.style.display = 'none';
      document.body.appendChild(input);
      var done = false;
      input.addEventListener('change', function() {
        var folder = '';
        try {
          // 取所选文件夹名（webkitRelativePath 第一段 = 文件夹名）
          if (input.files && input.files.length > 0 && input.files[0].webkitRelativePath) {
            var parts = input.files[0].webkitRelativePath.split('/');
            if (parts.length > 0) folder = parts[0];
          }
        } catch(e) {}
        done = true;
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(folder);
      });
      input.addEventListener('cancel', function() {
        done = true;
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(null); // 用户取消
      });
      try {
        // 用户手势内触发系统文件夹选择窗口
        input.click();
      } catch(e) {
        if (input.parentNode) input.parentNode.removeChild(input);
        resolve(null);
      }
      // 兜底：如果选择器没有触发（某些环境），返回 null
      setTimeout(function() { if (!done) { done = true; if (input.parentNode) input.parentNode.removeChild(input); resolve(null); } }, 60000);
    });
    if (chosen === null) return; // 用户取消了文件夹选择
    if (String(chosen).trim()) saveFolder = String(chosen).trim();
  } catch(e) {
    // 选择器不可用时保持默认目录
  }
  // 清洗非法字符
  saveFolder = saveFolder.replace(/[\\/:*?"<>|]/g, '_');
  try { chrome.storage.local.set({ ais_img_folder: saveFolder }); } catch(e) {}

  if (!(await aisConfirm('找到 ' + imageFields.length + ' 个图片字段，共 ' + totalImgs + ' 张图片\n保存到目录：' + saveFolder + '\n确定要下载吗？', { okText: '开始下载' }))) { aisToast('已取消下载'); return; }

  setStatus('正在下载 ' + totalImgs + ' 张图片...');
  var count = 0;
  var failed = 0;
  for (var di = 0; di < r.lastData.length; di++) {
    var record = r.lastData[di];
    for (var fi = 0; fi < imageFields.length; fi++) {
      var url = record[imageFields[fi]];
      if (url && url.indexOf('http') === 0) {
        try {
          // 推断扩展名
          var ext = '.jpg';
          var m = url.match(/\.(png|jpe?g|webp|gif|bmp)(\?|$)/i);
          if (m) ext = '.' + m[1].toLowerCase();
          var filename = saveFolder + '/' + (di + 1) + '-' + (fi + 1) + ext;
          // 优先使用chrome.downloads API（受downloads权限保护，不会被弹窗拦截）
          await new Promise(function(resolve) {
            chrome.runtime.sendMessage({
              action: 'downloadImage',
              url: url,
              filename: filename
            }, function(resp) {
              if (chrome.runtime.lastError || !resp || !resp.success) failed++;
              else count++;
              resolve();
            });
          });
          // 节流：每张间隔100ms避免触发风控
          await new Promise(function(r) { setTimeout(r, 100); });
        } catch(e) { failed++; }
      }
    }
    // 每10条更新一次状态
    if ((di + 1) % 10 === 0) setStatus('已下载 ' + count + ' / ' + totalImgs + ' 张');
  }
  setStatus('下载完成：成功 ' + count + ' 张' + (failed > 0 ? '，失败 ' + failed + ' 张' : ''));
}

// ========== Tab 导航切换 ==========
// 子视图切换：home / list / detail
function showSubview(view) {
  // v1.1.95：详情工作台即图片快采子视图（ais-subview-detail 自 v1.1.41 起不存在）——统一映射
  if (view === 'detail') view = 'images';
  var homeEl = __AIS_DOC().getElementById('ais-home-view');
  var listEl = __AIS_DOC().getElementById('ais-subview-list');
  var detailEl = __AIS_DOC().getElementById('ais-subview-detail');
  var imagesEl = __AIS_DOC().getElementById('ais-subview-images');
  if (homeEl) homeEl.style.display = (view === 'home') ? '' : 'none';
  if (listEl) listEl.style.display = (view === 'list') ? '' : 'none';
  if (detailEl) detailEl.style.display = (view === 'detail') ? '' : 'none';
  if (imagesEl) imagesEl.style.display = (view === 'images') ? '' : 'none';
  // v1.2.182：步骤条只服务列表采集流程；图片/SKU/评论视图下隐藏，减少顶部 20px 与视觉噪声
  try { var stepEl = __AIS_DOC().getElementById('ais-stepper'); if (stepEl) stepEl.style.display = (view === 'images' || view === 'home') ? 'none' : ''; } catch (eSt) {}
  AIS.currentTab = view;
}

// v1.1.92：采集历史直达内页（图片快采子视图的历史页签），替代原弹窗
function openHistoryTab() {
  try {
    var im = __AIS_DOC().getElementById('ais-subview-images');
    var dv = __AIS_DOC().getElementById('ais-subview-detail');
    var hv = __AIS_DOC().getElementById('ais-home-view');
    if (im) im.style.display = '';
    if (dv) dv.style.display = 'none';
    if (hv) hv.style.display = 'none';
    AIS.currentTab = 'images';
  } catch (e) {}
  // 复用图片快采模块的页签切换（其监听器做 revealPanel + switchTab）
  try { document.dispatchEvent(new CustomEvent('ui:show', { detail: 'history' })); } catch (e2) {}
  try { var sd = (typeof window !== 'undefined' && window.__AIS_SHADOW__) ? window.__AIS_SHADOW__ : null; if (sd) sd.dispatchEvent(new CustomEvent('ui:show', { detail: 'history' })); } catch (e3) {}
  try { var p = __AIS_DOC().getElementById('ais-panel'); if (p) p.classList.remove('ais-minimized'); } catch (e4) {}
  try { setStatus('采集历史'); } catch (e5) {}
}

// ========== 详情采集配置面板：联动逻辑 ==========
function registerDetailConfigInteractions() {
  var chkReviews = __AIS_DOC().getElementById('ais-chk-reviews');
  var reviewImagesWrap = __AIS_DOC().getElementById('ais-chk-review-images-wrap');
  var reviewSettings = __AIS_DOC().getElementById('ais-review-settings');
  var chkReviewImages = __AIS_DOC().getElementById('ais-chk-review-images');
  var scopeAll = __AIS_DOC().getElementById('ais-scope-all');
  var scopeLimit = __AIS_DOC().getElementById('ais-scope-limit');
  var reviewLimitInputEl = __AIS_DOC().getElementById('ais-review-limit');
  var reviewLimitHint = __AIS_DOC().getElementById('ais-review-limit-hint');

  // 二选一联动：采集全部翻页到底；自定义采集按页数停止。
  function syncReviewScope() {
    if (!scopeAll || !scopeLimit || !reviewLimitInputEl) return;
    if (scopeAll.checked) {
      reviewLimitInputEl.value = '';
      reviewLimitInputEl.disabled = true;
      if (reviewLimitHint) reviewLimitHint.textContent = '当前：采集全部（翻页到底）';
    } else {
      reviewLimitInputEl.disabled = false;
      if (reviewLimitHint) reviewLimitHint.textContent = '当前：自定义采集 ' + (parseInt(reviewLimitInputEl.value, 10) || 5) + ' 页（达到页数即停）';
    }
  }
  if (scopeAll) scopeAll.addEventListener('change', syncReviewScope);
  if (scopeLimit) scopeLimit.addEventListener('change', syncReviewScope);
  if (reviewLimitInputEl) reviewLimitInputEl.addEventListener('input', syncReviewScope);
  syncReviewScope();

  // 评论开关联动：关闭评论时，禁用评论图片/全部评论/自定义页数
  function syncReviewDependencies() {
    if (!chkReviews) return;
    var enabled = chkReviews.checked;
    if (reviewImagesWrap) reviewImagesWrap.classList.toggle('ais-chk-disabled', !enabled);
    if (reviewSettings) reviewSettings.classList.toggle('ais-section-disabled', !enabled);
    // 关闭评论时，强制取消勾选评论图片和全部评论
    if (!enabled) {
      if (chkReviewImages) chkReviewImages.checked = false;
      if (scopeAll) scopeAll.checked = true;
      if (scopeLimit) scopeLimit.checked = false;
      syncReviewScope();
    } else if (chkReviewImages && !chkReviewImages.checked && chkReviewImages.dataset.wasChecked === 'true') {
      // 恢复之前的状态
      chkReviewImages.checked = true;
      delete chkReviewImages.dataset.wasChecked;
    }
  }

  if (chkReviews) {
    chkReviews.addEventListener('change', function() {
      if (!this.checked && chkReviewImages && chkReviewImages.checked) {
        chkReviewImages.dataset.wasChecked = 'true';
      }
      syncReviewDependencies();
    });
    syncReviewDependencies();
  }

  // 全选/反选按钮
  var toggleBtn = __AIS_DOC().getElementById('ais-detail-config-toggle');
  if (toggleBtn) {
    // 初始化按钮文案：默认全部勾选时显示"取消全选"
    var initIds = ['ais-chk-skus', 'ais-chk-params', 'ais-chk-reviews',
                   'ais-chk-main-images', 'ais-chk-desc-images', 'ais-chk-review-images'];
    var initAllChecked = true;
    initIds.forEach(function(id) {
      var el = __AIS_DOC().getElementById(id);
      if (el && !el.disabled && !el.checked) initAllChecked = false;
    });
    toggleBtn.textContent = initAllChecked ? '取消全选' : '全选';

    toggleBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var ids = ['ais-chk-skus', 'ais-chk-params', 'ais-chk-reviews',
                 'ais-chk-main-images', 'ais-chk-desc-images', 'ais-chk-review-images'];
      // 判断是否全部已勾选（除必选项外）
      var allChecked = true;
      ids.forEach(function(id) {
        var el = __AIS_DOC().getElementById(id);
        if (el && !el.disabled && !el.checked) allChecked = false;
      });
      // 全选则全部取消；非全选则全部勾选
      ids.forEach(function(id) {
        var el = __AIS_DOC().getElementById(id);
        if (el && !el.disabled) el.checked = !allChecked;
      });
      // 按钮文案显示"下一步动作"：当前全选->显示"取消全选"；当前未全选->显示"全选"
      toggleBtn.textContent = allChecked ? '取消全选' : '全选';
      syncReviewDependencies();
    });
  }
}

// ========== 步骤2智能切换：详情模式隐藏页码配置 ==========
function initStep2SmartSwitch() {
  // 在步骤2的采集范围卡片前插入"详情采集配置摘要"容器（默认隐藏）
  var stepPreview = __AIS_DOC().getElementById('ais-step-preview');
  var configCard = stepPreview ? stepPreview.querySelector('.ais-config-card') : null;
  if (!configCard) return;
  // 避免重复创建
  if (__AIS_DOC().getElementById('ais-detail-config-summary')) return;
  var summaryEl = document.createElement('div');
  summaryEl.id = 'ais-detail-config-summary';
  summaryEl.className = 'ais-detail-config-summary ais-hidden';
  summaryEl.innerHTML = '<div class="ais-detail-config-subheader">本次采集内容</div><div id="ais-detail-config-summary-body"></div>';
  configCard.parentNode.insertBefore(summaryEl, configCard);
}

// 更新详情采集配置摘要
function updateDetailConfigSummary() {
  var body = __AIS_DOC().getElementById('ais-detail-config-summary-body');
  if (!body) return;
  var items = [];
  var chkMap = [
    ['ais-chk-skus', 'SKU规格'],
    ['ais-chk-params', '商品参数'],
    ['ais-chk-reviews', '评论数据'],
    ['ais-chk-main-images', '商品主图'],
    ['ais-chk-desc-images', '详情图片'],
    ['ais-chk-review-images', '评论图片']
  ];
  chkMap.forEach(function(pair) {
    var el = __AIS_DOC().getElementById(pair[0]);
    if (el && el.checked) items.push(pair[1]);
  });
  var scopeAll = __AIS_DOC().getElementById('ais-scope-all');
  var limitInput = __AIS_DOC().getElementById('ais-review-limit');
  var extras = [];
  if (scopeAll && scopeAll.checked) extras.push('全部评论');
  if (!scopeAll || !scopeAll.checked) {
    if (limitInput && limitInput.value) extras.push('前' + limitInput.value + '条');
  }

  var html = '<div class="ais-config-summary-tags">';
  items.forEach(function(name) {
    html += '<span class="ais-config-summary-tag">✓ ' + name + '</span>';
  });
  if (extras.length > 0) {
    html += '<span class="ais-config-summary-tag ais-config-summary-extra">' + extras.join(' · ') + '</span>';
  }
  html += '</div>';
  body.innerHTML = html;
}

// ========== Detail Collection ==========
async function startDetailCollection() {
  // v1.1.41：详情页深度采集页面已删除，统一直达图片快采「图片采集」页签
  try { if (window.AISIMG && window.AISIMG.openImages) { window.AISIMG.openImages(); return; } } catch (eD) {}
  // 记录平台（差评文案按平台区分：淘宝=疑似差评，京东=差评/中评/好评）
  AIS._currentPlatform = /(^|\.)amazon\.[a-z.]{2,}/i.test(location.hostname) ? 'amazon' : /taobao\.com|tmall\.com/.test(location.href) ? 'taobao' : /jd\.com/.test(location.href) ? 'jd' : 'other';   // v1.2.284
  // 采集期间保持进度面板可见，用户可自行最小化；不再强制隐藏导致无法查看进度或停止。
  try {
    var detailPanel = __AIS_DOC().getElementById('ais-panel');
    if (detailPanel) { detailPanel.style.display = ''; detailPanel.classList.remove('ais-minimized', 'ais-sidebar-mode'); }
  } catch(e) {}
  var s = window.__detailCollector;
  // 先判断是否在详情页，不在则给出明确提示
  if (!s || !s.isDetailPage()) {
    aisAlert('请在以下页面使用此功能：\n• 淘宝/天猫商品详情页 (item.taobao.com / detail.tmall.com)\n• 京东商品详情页 (item.jd.com)\n• 拼多多商品详情页 (yangkeduo.com)\n• 1688商品详情页 (detail.1688.com)', { type: 'warn' });
    setStatus('当前非详情页');
    return;
  }

  // 标记详情采集模式（步骤2智能切换用）
  AIS.detailMode = true;

  setStatus('正在深度采集商品详情...');
  showStep('progress');

  try {
    // 分阶段进度提示
    setStatus('阶段 1/5：初始化采集器...');
    var initResult = await s.init();
    if (!initResult || !initResult.success) {
      aisAlert('初始化失败：' + (initResult && initResult.error ? initResult.error : '未在URL中找到商品ID') +
            '\n\n请确认当前页面是商品详情页（URL含id参数）。', { type: 'error' });
      showStep('scan');
      setStatus('初始化失败');
      return;
    }
    updateProgress(1, 5);
    await new Promise(function(r) { setTimeout(r, 800); });

    setStatus('阶段 2/5：等待页面数据加载...');
    updateProgress(2, 5);
    
    // 获取详情采集配置项
    var scopeAll = __AIS_DOC().getElementById('ais-scope-all');
    // 评论范围二选一：全部翻页到底；自定义模式按页数停止。
    var collectAllReviews = !scopeAll || scopeAll.checked;
    var chkReviewImages = __AIS_DOC().getElementById('ais-chk-review-images');
    var collectReviewImages = chkReviewImages ? chkReviewImages.checked : true;
    var chkReviews = __AIS_DOC().getElementById('ais-chk-reviews');
    var collectReviews = chkReviews ? chkReviews.checked : true;
  // v1.1.172：京东评论采集已下线——京东全链路强制不采评论
  if (/jd\.com|3\.cn/.test(location.href)) collectReviews = false;
    var chkSkus = __AIS_DOC().getElementById('ais-chk-skus');
    var collectSkus = chkSkus ? chkSkus.checked : true;
    var chkParams = __AIS_DOC().getElementById('ais-chk-params');
    var collectParameters = chkParams ? chkParams.checked : true;
    var chkMainImages = __AIS_DOC().getElementById('ais-chk-main-images');
    var collectMainImages = chkMainImages ? chkMainImages.checked : true;
    var chkDescImages = __AIS_DOC().getElementById('ais-chk-desc-images');
    var collectDescImages = chkDescImages ? chkDescImages.checked : true;
    // 评论页数：采集全部为 0（翻页到底），自定义模式使用 reviewPageLimit。
    var reviewLimitInput = __AIS_DOC().getElementById('ais-review-limit');
    var customReviewPages = 0;
    if (reviewLimitInput && scopeAll && !scopeAll.checked) {
      var v = parseInt(reviewLimitInput.value, 10);
      if (!isNaN(v) && v > 0) customReviewPages = Math.min(999, v);
    }
    // 采集速度：已移除选项，统一使用最慢（最低风控），尽量降低被反爬概率
    var reviewSpeed = 'slow';;

    var reviewPageLimit = 0;

    // 按用户输入的页数执行。
    if (!collectAllReviews && customReviewPages > 0) {
      reviewPageLimit = reviewPageLimit > 0 ? Math.min(reviewPageLimit, customReviewPages) : customReviewPages;
    }
    // 存入全局状态，供评论翻页进度监听器显示 "X/N 页"
    AIS.reviewPageLimit = reviewPageLimit;



    // 联动：评论关闭时，强制关闭评论图片和全部评论
    if (!collectReviews) {
      collectReviewImages = false;
      collectAllReviews = false;
    }

    if (collectAllReviews) {
      setStatus('阶段 3/5：采集全部评论（翻页中，需较长时间）...');
    } else if (collectReviews) {
      setStatus('阶段 3/5：采集评论数据...');
    } else if (collectSkus || collectParameters) {
      setStatus('阶段 3/5：采集 SKU 与参数...');
    } else {
      setStatus('阶段 3/5：采集商品数据...');
    }
    console.log('[电商采集大师] 详情采集配置', {
      collectSkus: collectSkus, collectParameters: collectParameters,
      collectReviews: collectReviews, collectReviewImages: collectReviewImages,
      collectMainImages: collectMainImages, collectDescImages: collectDescImages,
      collectAllReviews: collectAllReviews, reviewLimit: 0, reviewPageLimit: reviewPageLimit
    });

    var result = await s.extractDetailData({
      collectAllReviews: collectAllReviews,
      collectReviewImages: collectReviewImages,
      collectReviews: collectReviews,
      collectSkus: collectSkus,
      collectParameters: collectParameters,
      collectMainImages: collectMainImages,
      collectDescImages: collectDescImages,
      reviewLimit: 0,
      reviewPageLimit: reviewPageLimit,
      reviewSpeed: reviewSpeed
    });
    updateProgress(4, 5);

    setStatus('阶段 5/5：整理数据...');
    updateProgress(5, 5);
    await new Promise(function(r) { setTimeout(r, 300); });

    if (!result.success) {
      if (result.loginRequired) {
        aisAlert('登录已失效！\n\n' + (result.error || '请重新登录') + '\n\n请在当前页面重新登录后再次点击采集。', { type: 'warn' });
      } else if (result.antiCrawl) {
        aisAlert('触发反爬验证！\n\n' + result.error + '\n\n建议：\n1. 完成 页面上的验证码/人工验证\n2. 等待 30 秒以上\n3. 降低采集频率（避免连续批量采集）', { type: 'warn' });
      } else {
        aisAlert('采集失败: ' + (result.error || '未知错误'), { type: 'error' });
      }
      showStep('scan');
      setStatus('就绪');
      return;
    }

    AIS.detailData = result.data;
    
    var flatData = s.exportFlatData(result);
    var skuData = s.generateSkuSheetData(result);
    var reviewData = s.generateReviewSheetData(result);
    
    if (!flatData || Object.keys(flatData).length === 0) {
      aisAlert('未能提取到有效商品数据，请确认当前页面是否为商品详情页', { type: 'warn' });
      showStep('scan');
      setStatus('就绪');
      return;
    }
    
    await chrome.storage.local.set({
      lastData: [flatData],
      lastFields: Object.keys(flatData),
      detailData: result.data,
      skuData: skuData,
      reviewData: reviewData,
      isDetailPage: true
    });

    AIS.data = [flatData];
    AIS.totalCollected = 1;

    // 保存到采集历史
    saveToHistory({
      type: 'detail',
      url: window.location.href,
      title: result.data.basic.title || '未命名商品',
      itemCount: 1,
      data: result.data,
      timestamp: Date.now()
    });

    // 直接进入完成页（含可折叠数据预览）
    showDone(true);

  } catch (err) {
    console.error('详情采集错误:', err);
    aisAlert('采集过程中出现错误: ' + err.message, { type: 'error' });
    setStatus('采集失败');
    showStep('scan');
  }
}

// ========== 批量详情页采集（列表页顺序采集） ==========
function getBatchOwnerToken() {
  var key = 'ais_batch_owner_token';
  var token = '';
  try { token = sessionStorage.getItem(key) || ''; } catch(e) {}
  if (!token) {
    token = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
    try { sessionStorage.setItem(key, token); } catch(e) {}
  }
  return token;
}
function batchTargetMatches(expected, actual) {
  try {
    var a = new URL(expected), b = new URL(actual);
    var idA = (a.searchParams.get('id') || a.searchParams.get('goods_id') || (a.pathname.match(/\d{5,}/) || [''])[0]);
    var idB = (b.searchParams.get('id') || b.searchParams.get('goods_id') || (b.pathname.match(/\d{5,}/) || [''])[0]);
    return idA && idB ? idA === idB : (a.hostname === b.hostname && a.pathname === b.pathname);
  } catch(e) { return false; }
}
function clearBatchStateIfOwned(runId) {
  chrome.storage.local.get(['aisBatchState'], function(r) {
    if (r.aisBatchState && r.aisBatchState.runId === runId) chrome.storage.local.remove('aisBatchState');
  });
}

async function startBatchDetailCollection() {
  var s = window.__detailCollector;
  if (!s) { aisToast('采集器未就绪', 'warn'); return; }
  var ownerToken = getBatchOwnerToken();
  var existingBatch = await chrome.storage.local.get(['aisBatchState']);
  if (existingBatch.aisBatchState && Date.now() - (existingBatch.aisBatchState.timestamp || 0) < 30 * 60 * 1000) {
    aisToast('已有批量详情任务正在运行，请先在原标签页完成或等待任务过期。', 'warn');
    return;
  }

  // 检测是否在详情页（批量采集需要在列表页）
  if (s.isDetailPage()) {
    aisAlert('批量详情采集需要在商品列表页/搜索结果页使用，请在列表页打开面板后再使用此功能。\n\n当前页面已是商品详情页，可直接使用「详情页深度采集」。', { type: 'warn' });
    return;
  }

  // 提取列表页所有商品URL
  setStatus('正在提取商品链接...');
  var itemUrls = extractItemUrlsFromListPage();
  if (itemUrls.length === 0) {
    aisAlert('未在当前页面找到商品链接。\n\n请确认当前页面是商品列表页或搜索结果页（如淘宝搜索、京东搜索等）。', { type: 'warn' });
    setStatus('未找到商品链接');
    return;
  }

  var batchLimitInput = __AIS_DOC().getElementById('ais-batch-limit');
  var batchLimit = 10;
  if (batchLimitInput) {
    var v = parseInt(batchLimitInput.value, 10);
    if (!isNaN(v) && v > 0) batchLimit = Math.min(v, 100);
  }

  if (itemUrls.length > batchLimit) {
    if (!(await aisConfirm('当前页面共找到 ' + itemUrls.length + ' 个商品链接，将采集前 ' + batchLimit + ' 个。\n\n' +
        '注意：批量采集使用精简模式（不翻页评论、不下详情图），如需完整数据请逐个采集。\n\n' +
        '批量采集将在当前标签页依次跳转每个详情页，完成后返回当前列表页。\n\n是否继续？', { okText: '开始批量采集' }))) {
      setStatus('已取消批量采集');
      return;
    }
    itemUrls = itemUrls.slice(0, batchLimit);
  } else {
    if (!(await aisConfirm('找到 ' + itemUrls.length + ' 个商品链接，将依次采集每个详情页。\n\n' +
        '注意：批量采集使用精简模式（不翻页评论、不下详情图），如需完整数据请逐个采集。\n\n' +
        '批量采集将在当前标签页依次跳转，完成后返回当前列表页。\n\n是否继续？', { okText: '开始批量采集' }))) {
      setStatus('已取消批量采集');
      return;
    }
  }

  // 保存当前列表页URL，完成后返回
  var listPageUrl = window.location.href;
  chrome.storage.local.set({
    aisBatchState: {
      runId: 'batch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      ownerToken: ownerToken,
      urls: itemUrls,
      currentIndex: 0,
      expectedUrl: itemUrls[0] || '',
      results: [],
      listPageUrl: listPageUrl,
      timestamp: Date.now()
    }
  }, function() {
    // 开始采集第一个
    navigateToBatchItem(0);
  });
}

// 从列表页提取所有商品URL
function extractItemUrlsFromListPage() {
  var urls = [];
  var seen = {};

  // 平台特定选择器
  var platformSelectors = [
    // 淘宝/天猫
    'a[href*="item.taobao.com/item.htm"]',
    'a[href*="detail.tmall.com/item.htm"]',
    'a[href*="item.tmall.com/item.htm"]',
    // 京东
    'a[href*="item.jd.com/"]',
    'a[href*="item.m.jd.com/product/"]',
    // 拼多多
    'a[href*="yangkeduo.com/goods.html"]',
    'a[href*="pinduoduo.com/goods"]',
    // 1688
    'a[href*="detail.1688.com/offer"]',
    'a[href*="1688.com/offer/"]'
  ];

  for (var si = 0; si < platformSelectors.length; si++) {
    var els = document.querySelectorAll(platformSelectors[si]);
    for (var ei = 0; ei < els.length; ei++) {
      var href = els[ei].href;
      if (!href || seen[href]) continue;
      // 提取商品ID避免URL参数差异导致重复
      var idMatch = href.match(/[?&]id=(\d+)/) || href.match(/\/item\/(\d+)/) ||
                    href.match(/item\.jd\.com\/(\d+)/) || href.match(/goods_id=(\d+)/);
      var id = idMatch ? idMatch[1] : href;
      if (seen[id]) continue;
      seen[id] = true;
      urls.push(href);
    }
  }

  return urls;
}

// 导航到批量采集的第 index 个商品
function navigateToBatchItem(index) {
  chrome.storage.local.get(['aisBatchState'], function(r) {
    var state = r.aisBatchState;
    if (!state || index >= state.urls.length) {
      // 全部完成
      finishBatchCollection(state);
      return;
    }

    if (state.ownerToken !== getBatchOwnerToken()) return;
    var url = state.urls[index];
    state.currentIndex = index;
    state.expectedUrl = url;
    state.timestamp = Date.now();
    chrome.storage.local.set({ aisBatchState: state });

    // 显示进度
    showStep('progress');
    updateProgress(index, state.urls.length);
    __AIS_DOC().getElementById('ais-progress-info').textContent =
      '批量采集 ' + (index + 1) + ' / ' + state.urls.length + '：正在跳转...';

    // 注册 batch 完成监听（页面加载后自动采集）
    // 由于页面跳转后 panel.js 会重新加载，使用 storage 传递状态
    // 在 init 中检测 aisBatchState 并自动开始单个详情采集
    window.location.href = url;
  });
}

// 批量采集中：检测是否有未完成的批量任务
async function checkAndResumeBatchCollection() {
  return new Promise(function(resolve) {
    chrome.storage.local.get(['aisBatchState'], function(r) {
      var state = r.aisBatchState;
      if (!state || !state.runId || state.ownerToken !== getBatchOwnerToken()) { resolve(false); return; }

      // 超过30分钟的任务视为过期
      if (Date.now() - state.timestamp > 30 * 60 * 1000) {
        clearBatchStateIfOwned(state.runId);
        resolve(false);
        return;
      }

      var s = window.__detailCollector;
      if (!s || !s.isDetailPage() || !batchTargetMatches(state.expectedUrl, window.location.href)) { resolve(false); return; }

      // 当前是详情页，且存在批量任务 -> 自动采集当前商品
      resolve(true);
    });
  });
}

// 批量采集：采集当前详情页并继续下一个
async function collectCurrentBatchItem() {
  var s = window.__detailCollector;
  if (!s || !s.isDetailPage()) return;

  var r = await chrome.storage.local.get(['aisBatchState']);
  var state = r.aisBatchState;
  if (!state || !state.runId || state.ownerToken !== getBatchOwnerToken() || !batchTargetMatches(state.expectedUrl, window.location.href)) return;

  var idx = state.currentIndex;
  setStatus('批量采集 ' + (idx + 1) + '/' + state.urls.length + '：正在采集...');
  showStep('progress');
  updateProgress(idx, state.urls.length);

  try {
    await s.init();
    // 使用简化选项（批量采集时关闭评论翻页以加速）
    var result = await s.extractDetailData({
      collectAllReviews: false,
      collectReviewImages: false,
      collectReviews: true,
      collectSkus: true,
      collectParameters: true,
      collectMainImages: true,
      collectDescImages: false
    });

    if (result.success) {
      state.results.push({
        url: window.location.href,
        title: result.data.basic.title || '未命名',
        data: result.data,
        timestamp: Date.now()
      });
    } else if (result.loginRequired) {
      // 登录失效，停止批量采集并提醒用户
      aisAlert('登录已失效！批量采集已停止。\n\n请重新登录后再次启动批量采集。', { type: 'warn' });
      setStatus('采集中止（需重新登录）');
      showStep('scan');
      return;
    } else if (result.antiCrawl) {
      // 触发反爬，停止批量采集并提醒用户
      aisAlert('触发反爬验证！批量采集已停止。\n\n' + result.error + '\n\n建议：\n1. 完成页面上的验证\n2. 等待 5 分钟以上\n3. 减少批量采集的商品数量', { type: 'warn' });
      setStatus('采集中止（触发反爬）');
      showStep('scan');
      return;
    }
  } catch (e) {
    console.error('[Batch] 单个商品采集失败:', e);
    state.results.push({
      url: window.location.href,
      title: '采集失败: ' + e.message,
      data: null,
      error: e.message,
      timestamp: Date.now()
    });
  }

  state.currentIndex = idx + 1;
  chrome.storage.local.set({ aisBatchState: state });

  // 跳转下一个或完成
  if (state.currentIndex < state.urls.length) {
    // 反爬：批量采集间隔4-8秒随机延迟，避免触发风控
    var batchDelay = 4000 + Math.random() * 4000;
    setStatus('批量采集 ' + (idx + 1) + '/' + state.urls.length + '：等待 ' + Math.round(batchDelay/1000) + ' 秒后继续（反爬保护）...');
    setTimeout(function() { navigateToBatchItem(state.currentIndex); }, batchDelay);
  } else {
    finishBatchCollection(state);
  }
}

// 批量采集完成
function finishBatchCollection(state) {
  if (!state) return;
  var successCount = state.results.filter(function(r) { return r.data; }).length;
  var failCount = state.results.length - successCount;

  // 保存到历史
  saveToHistory({
    type: 'batch',
    url: state.listPageUrl,
    title: '批量采集 ' + successCount + ' 件商品',
    itemCount: successCount,
    data: state.results,
    timestamp: Date.now()
  });

  // 只清除当前 run，避免旧页面收尾误删新任务。
  clearBatchStateIfOwned(state.runId);

  // 返回列表页
  if (state.listPageUrl && state.listPageUrl !== window.location.href) {
    // 在跳转前保存完成提示，返回后显示
    chrome.storage.local.set({
      aisBatchResult: {
        successCount: successCount,
        failCount: failCount,
        total: state.urls.length,
        results: state.results,
        timestamp: Date.now()
      }
    });
    window.location.href = state.listPageUrl;
  } else {
    showBatchResult(successCount, failCount, state.urls.length, state.results);
  }
}

function showBatchResult(successCount, failCount, total, results) {
  // 展开面板（移除最小化），亮出批量结果
  try {
    var _pnl = __AIS_DOC().getElementById('ais-panel');
    if (_pnl) { _pnl.classList.remove('ais-minimized'); _pnl.classList.remove('ais-sidebar-mode'); }
    var _fb = __AIS_DOC().getElementById('ais-float-btn');
    if (_fb) { try { _fb.style.display = 'none'; } catch(e) {} }
  } catch(e) {}
  showStep('done');
  var totalEl = __AIS_DOC().getElementById('ais-done-total');
  if (totalEl) totalEl.textContent = successCount + ' 件商品';

  // 批量采集是多个详情页数据集合：显示发布导出 Hero + Excel，隐藏"其他导出方式"标题
  var exportHeader = __AIS_DOC().getElementById('ais-export-section-header');
  var excelBtn = __AIS_DOC().getElementById('ais-btn-excel');
  var csvBtn = __AIS_DOC().getElementById('ais-btn-csv');
  if (exportHeader) exportHeader.classList.remove('ais-hidden');
  if (excelBtn) excelBtn.classList.remove('ais-hidden');
  if (csvBtn) csvBtn.classList.remove('ais-hidden');

  // 将批量结果写入 storage 和 AIS 内存，确保导出功能可用
  // 每个商品用 exportFlatData 扁平化为一行（与单详情采集一致），否则导出读到的是嵌套对象、字段错位
  var s = window.__detailCollector;
  var validResults = results.filter(function(r) { return r && r.data; });
  var flatRows = validResults.map(function(r) {
    try {
      // exportFlatData 要求 { success: true, data } 结构（它校验 detailData.success）
      var flat = (s && s.exportFlatData) ? s.exportFlatData({ success: true, data: r.data }) : null;
      return flat || r.data;
    } catch(e) { return r.data; }
  });
  AIS.data = flatRows;
  AIS.detailData = null; // 批量模式清除单商品详情
  AIS.isBatchDetail = true;
  // 汇总 lastFields：取首行字段（导出列头）
  var bf = (flatRows[0] && typeof flatRows[0] === 'object') ? Object.keys(flatRows[0]) : [];
  chrome.storage.local.set({
    lastData: flatRows,
    lastFields: bf.length > 0 ? bf : ['标题', '价格', 'SKU', '评论', '图片'],
    detailData: null,
    skuData: null,
    reviewData: null,
    isDetailPage: false,
    isBatchDetail: true
  });

  var summaryEl = __AIS_DOC().getElementById('ais-detail-summary');
  if (summaryEl) {
    summaryEl.classList.remove('ais-hidden');
    var html = '<div class="ais-stat-card">' +
      '<div class="ais-stat-title">📦 批量详情采集完成</div>' +
      '<div class="ais-stat-row">' +
        '<span class="ais-stat-chip ais-chip-green">✓ 成功 ' + successCount + '</span>' +
        (failCount > 0 ? '<span class="ais-stat-chip ais-chip-red">✗ 失败 ' + failCount + '</span>' : '') +
        '<span class="ais-stat-chip ais-chip-blue">共 ' + total + '</span>' +
      '</div>';
    // 列出每个商品
    html += '<div class="ais-batch-result-list">';
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      var status = r.data ? 'success' : 'fail';
      html += '<div class="ais-batch-result-item ais-batch-' + status + '">' +
        '<span class="ais-batch-result-status">' + (r.data ? '✓' : '✗') + '</span>' +
        '<span class="ais-batch-result-title">' + escapeHtml(r.title || '未命名') + '</span>' +
      '</div>';
    }
    html += '</div></div>';
    summaryEl.innerHTML = html;
  }
}


// 渲染详情数据预览 HTML（供 done 步骤的可折叠预览使用）
function renderDetailPreviewHtml(detailData) {
  var d = detailData || {};
  var reviews = d.reviews || [];
  var skus = d.skus || [];
  var params = d.parameters || [];
  var images = d.images || [];
  var descImgs = d.descImages || [];
  var reviewImgCount = 0;
  reviews.forEach(function(r) { if (r.images) reviewImgCount += r.images.length; });

  var html = '';

  // 商品基本信息卡片
  html += '<div class="ais-preview-card">';
  html += '<div class="ais-preview-card-header"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg><span>商品信息</span></div>';
  html += '<div class="ais-preview-info-grid">';
  html += '<div class="ais-preview-info-item"><label>标题</label><div class="ais-preview-info-value">' + escapeHtml(d.basic.title || '-') + '</div></div>';
  html += '<div class="ais-preview-info-item"><label>价格</label><div class="ais-preview-info-value ais-price">' + escapeHtml(d.basic.price || '-') + '</div></div>';
  html += '<div class="ais-preview-info-item"><label>店铺</label><div class="ais-preview-info-value">' + escapeHtml(d.basic.shopName || '-') + '</div></div>';
  html += '<div class="ais-preview-info-item"><label>商品ID</label><div class="ais-preview-info-value">' + escapeHtml(d.itemId || '-') + '</div></div>';
  html += '</div>';
  html += '</div>';

  // 数据统计卡片
  html += '<div class="ais-preview-stats-row">';
  html += '<div class="ais-preview-stat"><div class="ais-preview-stat-num">' + skus.length + '</div><div class="ais-preview-stat-label">SKU</div></div>';
  html += '<div class="ais-preview-stat"><div class="ais-preview-stat-num">' + reviews.length + '</div><div class="ais-preview-stat-label">评论</div></div>';
  html += '<div class="ais-preview-stat"><div class="ais-preview-stat-num">' + params.length + '</div><div class="ais-preview-stat-label">参数</div></div>';
  html += '<div class="ais-preview-stat"><div class="ais-preview-stat-num">' + images.length + '</div><div class="ais-preview-stat-label">主图</div></div>';
  html += '<div class="ais-preview-stat"><div class="ais-preview-stat-num">' + descImgs.length + '</div><div class="ais-preview-stat-label">详情图</div></div>';
  html += '<div class="ais-preview-stat"><div class="ais-preview-stat-num">' + reviewImgCount + '</div><div class="ais-preview-stat-label">评论图</div></div>';
  html += '</div>';

  // SKU 预览表格（前5个）
  if (skus.length > 0) {
    html += '<div class="ais-preview-card">';
    html += '<div class="ais-preview-card-header"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg><span>SKU规格（前5个）</span></div>';
    html += '<div class="ais-preview-table-wrap"><table class="ais-preview-table"><thead><tr><th>规格</th><th>价格</th><th>库存</th></tr></thead><tbody>';
    var skuLimit = Math.min(skus.length, 5);
    for (var si = 0; si < skuLimit; si++) {
      html += '<tr><td>' + escapeHtml(skus[si].name || skus[si].spec || '-') + '</td>';
      html += '<td>' + escapeHtml(skus[si].price || '-') + '</td>';
      html += '<td>' + escapeHtml(String(skus[si].stock != null ? skus[si].stock : '-')) + '</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '</div>';
  }

  // 评论预览（前3条）
  if (reviews.length > 0) {
    html += '<div class="ais-preview-card">';
    html += '<div class="ais-preview-card-header"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><span>评论预览（前3条）</span></div>';
    var revLimit = Math.min(reviews.length, 3);
    for (var ri = 0; ri < revLimit; ri++) {
      var rv = reviews[ri];
      html += '<div class="ais-preview-review-item">';
      html += '<div class="ais-preview-review-meta">';
      html += '<span class="ais-preview-review-user">' + escapeHtml(rv.userName || rv.username || '匿名') + '</span>';
      if (rv.score) html += '<span class="ais-preview-review-score">' + escapeHtml(String(rv.score)) + '★</span>';
      if (rv.time) html += '<span class="ais-preview-review-time">' + escapeHtml(rv.time) + '</span>';
      if (rv.images && rv.images.length > 0) html += '<span class="ais-preview-review-imgs">' + rv.images.length + '图</span>';
      html += '</div>';
      html += '<div class="ais-preview-review-content">' + escapeHtml(rv.content || '') + '</div>';
      html += '</div>';
    }
    html += '</div>';
  }

  // 参数预览（前8个）
  if (params.length > 0) {
    html += '<div class="ais-preview-card">';
    html += '<div class="ais-preview-card-header"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><span>商品参数</span></div>';
    html += '<div class="ais-preview-params">';
    var paramLimit = Math.min(params.length, 8);
    for (var pi = 0; pi < paramLimit; pi++) {
      html += '<div class="ais-preview-param-item"><span class="ais-preview-param-name">' + escapeHtml(params[pi].name || params[pi].key || '-') + '</span><span class="ais-preview-param-value">' + escapeHtml(params[pi].value || '-') + '</span></div>';
    }
    html += '</div>';
    html += '</div>';
  }

  return html;
}

function escapeHtml(str) {
  if (str == null) return '';
  return String(str).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

// Update showDone to support both list and detail view
function showDone(isDetail) {
  // 采集完成，恢复并展开面板（移除最小化状态，直接亮出完成页）
  try { showPanel(); } catch(e) {}
  try {
    var _pnl = __AIS_DOC().getElementById('ais-panel');
    if (_pnl) { _pnl.classList.remove('ais-minimized'); _pnl.classList.remove('ais-sidebar-mode'); }
    var _fb = __AIS_DOC().getElementById('ais-float-btn');
    if (_fb) { try { _fb.style.display = 'none'; } catch(e) {} } // 面板展开时隐藏悬浮球避免重叠
  } catch(e) {}
  showStep('done');

  var totalEl = __AIS_DOC().getElementById('ais-done-total');
  var summaryEl = __AIS_DOC().getElementById('ais-detail-summary');
  var excelBtn = __AIS_DOC().getElementById('ais-btn-excel');
  var csvBtn = __AIS_DOC().getElementById('ais-btn-csv');
  var exportHeader = __AIS_DOC().getElementById('ais-export-section-header');

  if (isDetail && AIS.detailData) {
    // ===== 详情采集：显示发布导出 + Excel多Sheet =====
    totalEl.textContent = '1 件商品';
    var d = AIS.detailData;

    if (summaryEl) {
      summaryEl.classList.remove('ais-hidden');
      // 评论深度分析：放在顶部显眼位置（紧凑：星级一行 + SKU一行 + 商品信息一行 chips）
      var reviewStats = (d.reviews && d.reviews.length > 0 && window.StatsAnalyzer && StatsAnalyzer.analyzeReviews)
        ? window.StatsAnalyzer.analyzeReviews(d.reviews) : null;
      var html = '';

      // 顶部：评论概览卡（星级网格 + SKU网格 并排）
      if (reviewStats) {
        html += '<div class="ais-stat-card ais-review-overview">' +
          '<div class="ais-stat-title">💬 评论分析 <span class="ais-stat-chip ' + (__reviewSummary(reviewStats).positiveRate >= 90 ? 'ais-chip-green' : 'ais-chip-yellow') + '" style="margin-left:4px;">好评率 ' + __reviewSummary(reviewStats).positiveRate + '%</span></div>';
        // 星级分布（一行5格）
        if (reviewStats.ratingDistribution) {
          var rd2 = reviewStats.ratingDistribution;
          html += '<div class="ais-rating-grid">';
          [['5','5★'],['4','4★'],['3','3★'],['2','2★'],['1','1★']].forEach(function(item) {
            var dd = rd2[item[0]];
            if (!dd) return;
            html += '<div class="ais-rating-cell">' +
              '<span class="ais-rating-num">' + dd.count + '</span>' +
              '<span class="ais-rating-pct">' + dd.pct + '%</span>' +
              '<span class="ais-rating-star">' + item[1] + '</span>' +
            '</div>';
          });
          html += '</div>';
        }
        // SKU 分布（一行2个）
        if (reviewStats.skuDistribution && reviewStats.skuDistribution.length > 0) {
          html += '<div class="ais-sku-grid" style="margin-top:4px;">';
          var msc = Math.max.apply(null, reviewStats.skuDistribution.slice(0, 6).map(function(x){return x.count;}));
          reviewStats.skuDistribution.slice(0, 6).forEach(function(x) {
            var pct2 = msc > 0 ? Math.round(x.count / msc * 100) : 0;
            var np2 = reviewStats.total > 0 ? Math.round(x.count / reviewStats.total * 100) : 0;
            html += '<div class="ais-sku-cell">' +
              '<div class="ais-sku-head"><span class="ais-sku-name" title="' + escapeHtml(x.sku) + '">' + escapeHtml(x.sku.substring(0, 10)) + '</span><span class="ais-sku-count">' + x.count + '条</span></div>' +
              '<div class="ais-sku-bar"><span class="ais-sku-fill" style="width:' + pct2 + '%"></span></div>' +
              '<div class="ais-sku-pct">占评论 ' + np2 + '%</div>' +
            '</div>';
          });
          html += '</div>';
        }
        html += '</div>';
      }

      // 商品信息一行 chips（紧凑）
      html += '<div class="ais-stat-card ais-goods-card">' +
        '<div class="ais-goods-title" title="' + escapeHtml(d.basic.title || '') + '">📦 ' + escapeHtml((d.basic.title || '未知商品').substring(0, 30)) + '</div>' +
        '<div class="ais-stat-row">' +
          '<span class="ais-stat-chip ais-chip-green">💰 ' + escapeHtml(d.basic.price || '-') + '</span>' +
          '<span class="ais-stat-chip ais-chip-blue">🏪 ' + escapeHtml(d.basic.shopName || '-') + '</span>' +
          '<span class="ais-stat-chip ais-chip-purple">SKU ' + d.skus.length + '</span>' +
          '<span class="ais-stat-chip ais-chip-yellow">评论 ' + d.reviews.length + '</span>' +
          '<span class="ais-stat-chip">🖼 ' + d.images.length + '</span>' +
        '</div>' +
      '</div>';

      // 查看完整评论分析
      html += '<div style="text-align:center;margin-top:6px;"><button type="button" id="ais-btn-open-review" class="ais-btn ais-btn-sm ais-btn-primary">💬 查看完整评论 / 导出差评</button></div>';
      summaryEl.innerHTML = html;
      var openReviewBtn = summaryEl.querySelector('#ais-btn-open-review');
      if (openReviewBtn) openReviewBtn.addEventListener('click', showReviewPanel);
    }

    // 详情采集：显示 Excel多Sheet + "其他导出方式"标题
    if (exportHeader) exportHeader.classList.remove('ais-hidden');
    if (excelBtn) excelBtn.classList.remove('ais-hidden');
    if (csvBtn) csvBtn.classList.remove('ais-hidden');

    // 详情采集：填充可折叠的数据预览
    var previewWrap = __AIS_DOC().getElementById('ais-done-detail-preview');
    var previewBody = __AIS_DOC().getElementById('ais-done-detail-preview-body');
    if (previewWrap && previewBody) {
      previewBody.innerHTML = renderDetailPreviewHtml(AIS.detailData);
      previewWrap.classList.remove('ais-hidden');
    }
  } else {
    // ===== 列表采集 =====
    totalEl.textContent = AIS.totalCollected;

    // 列表采集：显示导出区（表格/图片等所有入口）
    if (exportHeader) exportHeader.classList.remove('ais-hidden');
    if (excelBtn) excelBtn.classList.remove('ais-hidden');
    if (csvBtn) csvBtn.classList.remove('ais-hidden');

    // 列表采集：隐藏可折叠数据预览（仅详情采集显示）
    var previewWrap = __AIS_DOC().getElementById('ais-done-detail-preview');
    if (previewWrap) previewWrap.classList.add('ais-hidden');

    if (summaryEl) summaryEl.classList.remove('ais-hidden');

    var fields = getActiveFields();
    // 构建导出字段名映射：使用用户重命名后的displayName作为列标题
    var exportNames = [];
    var renameMap = {}; // 原名 -> 显示名
    for (var i = 0; i < fields.length; i++) {
      var dn = fields[i].displayName || fields[i].name;
      exportNames.push(dn);
      renameMap[fields[i].name] = dn;
    }
    if (AIS.data && AIS.data.length > 0) {
      // 转换数据：把原始key替换为displayName
      var renamedData = [];
      for (var d = 0; d < AIS.data.length; d++) {
        var newRow = {};
        var origRow = AIS.data[d];
        for (var key in origRow) {
          if (origRow.hasOwnProperty(key)) {
            var newKey = renameMap[key] || key;
            newRow[newKey] = origRow[key];
          }
        }
        renamedData.push(newRow);
      }
      chrome.storage.local.set({
        lastData: renamedData,
        lastFields: exportNames,
        isDetailPage: false
      }, function() {
        // 列表采集：清除上次详情采集残留的 detailData/skuData/reviewData
        // 避免Excel多Sheet导出时混入上一次详情页的SKU/评论数据
        chrome.storage.local.remove(['detailData', 'skuData', 'reviewData']);
      });
    }

    // 列表页统计仪表盘（用原始key分析，但显示用displayName）
    if (summaryEl && window.StatsAnalyzer && AIS.data && AIS.data.length > 0) {
      var listStats = window.StatsAnalyzer.analyzeListData(AIS.data, fields);
      if (listStats) {
        summaryEl.innerHTML = renderListStats(listStats);
      }
    }
  }

  setStatus('采集完成');

  // ===== 评论引导：采集完成后触发（仅在有数据时）=====
  if (window.ReviewPrompt) {
    if (isDetail && AIS.detailData) {
      ReviewPrompt.onDetailCollectSuccess();
    } else if (AIS.data && AIS.data.length > 0) {
      ReviewPrompt.onListCollectSuccess(AIS.data.length);
    }
  }

  // ===== 采集完成提示：浏览器桌面通知 =====
  try {
    var _nTitle = isDetail ? '✓ 商品详情采集完成' : '✓ 列表采集完成';
    var _nCount = isDetail ? 1 : (AIS.totalCollected || (AIS.data ? AIS.data.length : 0));
    var _nMsg = '已采集 ' + _nCount + ' 条数据，可在右侧面板导出 CSV/Excel。';
    chrome.runtime.sendMessage({ action: 'notifyCollectDone', title: _nTitle, message: _nMsg }).catch(function(){});
  } catch(e) {}
}

// 渲染列表页统计仪表盘
function renderListStats(stats) {
  var html = '<section class="ais-dashboard" aria-label="数据统计仪表盘">' +
    '<header class="ais-dashboard-head">' +
      '<div><h3>数据统计</h3><p>基于本次采集的 ' + (stats.total || 0) + ' 条记录</p></div>' +
      '<span class="ais-dashboard-status"><i></i>已完成</span>' +
    '</header>';

  var metrics = [];
  if (stats.price) {
    metrics.push({ label: '平均价格', value: '¥' + stats.price.avg, note: stats.price.count + ' 条有效价格', tone: 'blue' });
    metrics.push({ label: '价格中位数', value: '¥' + stats.price.median, note: '区间 ¥' + stats.price.min + ' - ¥' + stats.price.max, tone: 'slate' });
  }
  if (stats.sales) {
    metrics.push({ label: '累计销量', value: String(stats.sales.total), note: stats.sales.count + ' 条有效销量', tone: 'green' });
    metrics.push({ label: '最高销量', value: String(stats.sales.max), note: '平均 ' + stats.sales.avg, tone: 'amber' });
  }
  if (metrics.length) {
    html += '<div class="ais-dashboard-metrics">';
    metrics.forEach(function(m) {
      html += '<div class="ais-dashboard-metric ais-dashboard-metric-' + m.tone + '">' +
        '<span class="ais-dashboard-metric-label">' + m.label + '</span>' +
        '<strong>' + m.value + '</strong><small>' + m.note + '</small></div>';
    });
    html += '</div>';
  }

  html += '<div class="ais-dashboard-grid">';
  if (stats.price && stats.price.distribution && stats.price.distribution.length) {
    var p = stats.price;
    var maxPriceCount = Math.max.apply(null, p.distribution.map(function(d) { return d.count; })) || 1;
    html += '<section class="ais-dashboard-section ais-dashboard-section-wide"><div class="ais-dashboard-section-head"><h4>价格分布</h4><span>有效价格 ' + p.count + ' 条</span></div><div class="ais-dashboard-bars">';
    p.distribution.forEach(function(d) {
      var pct = Math.round(d.count / maxPriceCount * 100);
      html += '<div class="ais-dashboard-bar-row"><span title="' + escapeHtml(d.label) + '">' + escapeHtml(d.label) + '</span><div><i style="width:' + pct + '%"></i></div><b>' + d.count + '</b></div>';
    });
    html += '</div></section>';
  }
  if (stats.shop && stats.shop.topShops && stats.shop.topShops.length) {
    var maxShopCount = Math.max.apply(null, stats.shop.topShops.slice(0, 5).map(function(s) { return s.count; })) || 1;
    html += '<section class="ais-dashboard-section ais-dashboard-section-wide"><div class="ais-dashboard-section-head"><h4>商家排行</h4><span>共 ' + stats.shop.uniqueCount + ' 家</span></div><ol class="ais-dashboard-ranking">';
    stats.shop.topShops.slice(0, 5).forEach(function(s, i) {
      var pct = Math.round(s.count / maxShopCount * 100);
      html += '<li><em>' + (i + 1) + '</em><span title="' + escapeHtml(s.name) + '">' + escapeHtml(s.name) + '</span><div><i style="width:' + pct + '%"></i></div><b>' + s.count + '</b></li>';
    });
    html += '</ol></section>';
  }
  if (stats.coupon) {
    var c = stats.coupon;
    html += '<section class="ais-dashboard-section ais-dashboard-coupon"><div class="ais-dashboard-section-head"><h4>优惠覆盖</h4><span>' + c.rate + '%</span></div>' +
      '<div class="ais-dashboard-coupon-track"><i style="width:' + c.rate + '%"></i></div>' +
      '<div class="ais-dashboard-coupon-meta"><span>有券 ' + c.withCoupon + '</span><span>无券 ' + c.withoutCoupon + '</span></div></section>';
  }
  html += '</div></section>';
  return html;
}

// 渲染评论深度分析
function renderReviewAnalysis(stats) {
  var html = '<div class="ais-stat-card"><div class="ais-stat-title">💬 评论深度分析（' + stats.total + ' 条）</div>';

  // 星级分布（紧凑网格：一行多项）
  if (stats.ratingDistribution) {
    var rd = stats.ratingDistribution;
    var rateColor = rd.positiveRate >= 90 ? 'ais-chip-green' : rd.positiveRate >= 70 ? 'ais-chip-yellow' : 'ais-chip-red';
    html += '<div style="margin-bottom:6px;">';
    html += '<div class="ais-stat-label">⭐ 星级分布' + (isTaobaoFamilyHost() ? '' : ' <span class="ais-stat-chip ' + rateColor + '" style="margin-left:4px;">好评率 ' + rd.positiveRate + '%</span>') + '</div>';
    html += '<div class="ais-rating-grid">';
    [['5','5★'],['4','4★'],['3','3★'],['2','2★'],['1','1★']].forEach(function(item) {
      var d = rd[item[0]];
      html += '<div class="ais-rating-cell">' +
        '<span class="ais-rating-num">' + d.count + '</span>' +
        '<span class="ais-rating-pct">' + d.pct + '%</span>' +
        '<span class="ais-rating-star">' + item[1] + '</span>' +
      '</div>';
    });
    html += '</div></div>';
  }

  // 词频 Top10
  if (stats.wordFrequency && stats.wordFrequency.length > 0) {
    html += '<div style="margin-bottom:10px;">';
    html += '<div class="ais-stat-label">📝 高频关键词 Top10</div>';
    html += '<div class="ais-stat-row">';
    var chipClasses = ['ais-chip-red','ais-chip-yellow','ais-chip-green','ais-chip-blue','ais-chip-purple'];
    stats.wordFrequency.slice(0, 10).forEach(function(w, i) {
      html += '<span class="ais-stat-chip ' + chipClasses[i % 5] + '">' + w.word + ' (' + w.count + ')</span>';
    });
    html += '</div></div>';
  }

  // SKU 评论分布（紧凑网格：一行 2 个）
  if (stats.skuDistribution && stats.skuDistribution.length > 0) {
    html += '<div style="margin-bottom:6px;">';
    html += '<div class="ais-stat-label">🏷 SKU 评论分布</div>';
    html += '<div class="ais-sku-grid">';
    var maxSkuCount = Math.max.apply(null, stats.skuDistribution.slice(0,5).map(function(s){return s.count;}));
    stats.skuDistribution.slice(0, 5).forEach(function(s) {
      var pct = maxSkuCount > 0 ? Math.round(s.count / maxSkuCount * 100) : 0;
      var namePct = stats.total > 0 ? Math.round(s.count / stats.total * 100) : 0;
      html += '<div class="ais-sku-cell">' +
        '<div class="ais-sku-head"><span class="ais-sku-name" title="' + escapeHtml(s.sku) + '">' + escapeHtml(s.sku.substring(0, 10)) + '</span><span class="ais-sku-count">' + s.count + '条</span></div>' +
        '<div class="ais-sku-bar"><span class="ais-sku-fill" style="width:' + pct + '%"></span></div>' +
        '<div class="ais-sku-pct">占评论 ' + namePct + '%</div>' +
      '</div>';
    });
    html += '</div></div>';
  }

  // 时间趋势
  if (stats.timeTrend && stats.timeTrend.length > 0) {
    html += '<div style="margin-bottom:6px;">';
    html += '<div class="ais-stat-label">📅 评论趋势（近' + stats.timeTrend.length + '天）</div>';
    var maxCount = Math.max.apply(null, stats.timeTrend.map(function(d) { return d.count; }));
    stats.timeTrend.forEach(function(d) {
      var pct = maxCount > 0 ? Math.round(d.count / maxCount * 100) : 0;
      html += '<div class="ais-bar-row">' +
        '<span class="ais-bar-label">' + d.date.substring(5) + '</span>' +
        '<span class="ais-bar-track"><span class="ais-bar-fill" style="width:' + pct + '%"></span></span>' +
        '<span class="ais-bar-count">' + d.count + '</span>' +
      '</div>';
    });
    html += '</div>';
  }

  // 汇总
  html += '<div class="ais-stat-row" style="margin-top:8px;padding-top:8px;border-top:1px solid #e2e8f0;">';
  html += '<span class="ais-stat-chip ais-chip-blue">🖼 有图 ' + stats.withImage + '</span>';
  html += '<span class="ais-stat-chip ais-chip-purple">✏️ 追评 ' + stats.appendCount + '</span>';
  html += '</div>';

  // 差评预警
  if (stats.negativeAlert && stats.negativeAlert.negativeCount > 0) {
    var na = stats.negativeAlert;
    var levelText = na.level === 'high' ? '高危' : na.level === 'medium' ? '中危' : na.level === 'low' ? '低危' : '待观察';
    var levelClass = na.level === 'high' ? 'ais-alert-high' : na.level === 'medium' ? 'ais-alert-medium' : na.level === 'low' ? 'ais-alert-low' : 'ais-alert-info';
    var negName = '低星评价';
    html += '<div class="ais-negative-alert ' + levelClass + '">';
    html += '<div class="ais-negative-alert-header">';
    html += '<span class="ais-negative-alert-icon">⚠️</span>';
    html += '<span class="ais-negative-alert-title">' + negName + '预警 · ' + levelText + '</span>';
    html += '<span class="ais-negative-alert-stat">' + na.negativeCount + ' 条' + negName + '（' + na.negativeRate + '%）</span>';
    html += '</div>';
    if (na.suspectedCount > 0) html += '<div class="ais-negative-risk-row"><span class="ais-negative-risk-label">待确认文本线索：</span><span class="ais-stat-chip">' + na.suspectedCount + ' 条（不计入预警）</span></div>';
    // 风险关键词
    if (na.riskKeywords && na.riskKeywords.length > 0) {
      html += '<div class="ais-negative-risk-row">';
      html += '<span class="ais-negative-risk-label">风险词：</span>';
      na.riskKeywords.forEach(function(k) {
        html += '<span class="ais-stat-chip ais-chip-red">' + escapeHtml(k.word) + ' (' + k.count + ')</span>';
      });
      html += '</div>';
    }
    // 最近差评
    if (na.recentNegatives && na.recentNegatives.length > 0) {
      html += '<div class="ais-negative-list">';
      na.recentNegatives.slice(0, 3).forEach(function(r) {
        html += '<div class="ais-negative-item">';
        html += '<span class="ais-negative-item-rating">' + r.rating + '★</span>';
        html += '<span class="ais-negative-item-content">' + escapeHtml(r.content) + '</span>';
        if (r.time) html += '<span class="ais-negative-item-time">' + escapeHtml(r.time) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div>';
  }

  html += '</div>';
  return html;
}

// ========== 评论分析功能 ==========
// 从多来源收集评论数据：当前详情采集 / storage 详情数据 / 采集历史
function gatherReviewsForAnalysis(cb) {
  var sources = [];
  // 1. 当前内存中的详情采集数据
  if (AIS && AIS.detailData && AIS.detailData.success && AIS.detailData.data && AIS.detailData.data.reviews && AIS.detailData.data.reviews.length > 0) {
    sources.push({
      title: (AIS.detailData.data.basic && AIS.detailData.data.basic.title) || '当前商品',
      url: AIS.detailData.data.url || location.href,
      reviews: AIS.detailData.data.reviews
    });
  }
  chrome.storage.local.get(['detailData', 'reviewData', 'aisHistory'], function(r) {
    // 2. storage 中的详情数据
    if (r.detailData && r.detailData.success && r.detailData.data && r.detailData.data.reviews && r.detailData.data.reviews.length > 0) {
      var dup = sources.some(function(src) { return src.url && src.url === (r.detailData.data.url || ''); });
      if (!dup) {
        sources.push({
          title: (r.detailData.data.basic && r.detailData.data.basic.title) || '最近采集的商品',
          url: r.detailData.data.url || '',
          reviews: r.detailData.data.reviews
        });
      }
    }
    // 3. 采集历史中的详情记录
    var history = r.aisHistory || [];
    for (var i = 0; i < history.length; i++) {
      var h = history[i];
      if (h.type === 'detail' && h.data && h.data.reviews && h.data.reviews.length > 0) {
        var dup2 = sources.some(function(src) { return src.url && src.url === (h.url || ''); });
        if (!dup2) {
          sources.push({
            title: h.title || '历史商品',
            url: h.url || '',
            reviews: h.data.reviews,
            fromHistory: true
          });
        }
      }
    }
    // 4. storage 中的 reviewData（Excel 表格式）作为兜底
    if (sources.length === 0 && r.reviewData && r.reviewData.length > 0) {
      sources.push({
        title: '最近采集的评论数据',
        url: '',
        reviews: r.reviewData.map(function(row) {
          return {
            rating: row['评分'] || 0,
            content: row['评论内容'] || '',
            appendContent: row['追评内容'] || '',
            username: row['用户名'] || '',
            skuInfo: row['SKU信息'] || '',
            time: row['评论时间'] || '',
            hasImage: row['是否有图'] === '是',
            isAppend: row['是否追评'] === '是'
          };
        })
      });
    }
    cb(sources);
  });
}

// 通用下载：浏览器下载文本文件
function downloadTextFile(filename, content, mime) {
  var blob = new Blob([content], { type: mime || 'text/csv;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
}

// 评论导出（全部或仅差评）
function exportReviewsCsv(reviews, negativeOnly, title) {
  if (!reviews || reviews.length === 0) { aisToast('没有可导出的评论数据', 'warn'); return; }
  var negName = (AIS._currentPlatform === 'taobao') ? '高风险评论' : '差评';
  var list = negativeOnly
    ? reviews.filter(function(r) { return (parseInt(r.rating) || 0) <= 2; })
    : reviews;
  if (list.length === 0) { aisToast('没有' + negName + '数据（1-2星）', 'warn'); return; }
  var headers = ['评分', '用户名', '评论内容', '追评内容', 'SKU信息', '评论时间', '是否有图', '是否追评'];
  var rows = list.map(function(r) {
    return {
      '评分': r.rating || 0,
      '用户名': r.username || r.userName || '',
      '评论内容': (r.content || '').trim(),
      '追评内容': r.appendContent || '',
      'SKU信息': r.skuInfo || '',
      '评论时间': r.time || '',
      '是否有图': r.hasImage ? '是' : '否',
      '是否追评': r.isAppend ? '是' : '否'
    };
  });
  // v1.2.448【下载口径统一】四处都改：
  //   ① 文件名 `<安全标题>_<类型>.csv`（原来是 `评论明细-<标题>-<时间戳>.csv`，这一种口径全项目独一份）；
  //   ② 下载走 worker 的 `downloadData`（原来是 `<a download>`+Blob，没有下载记录、不能"打开目录"）；
  //   ③ CSV 转义走共享 `skuToCsv`/`csvCell`（含公式注入防护，原来手写一套）；
  //   ④ 去掉数据后面的 `# 商品/导出时间/共N条` 元信息行（其它 CSV 都是纯表格，首行即表头）。
  var safeTitle = safeFs(title || '导出').slice(0, 40) || '导出';
  var fname = safeTitle + (negativeOnly ? '_高风险评论.csv' : '_评论.csv');
  var csv = headers.map(csvCell).join(',') + '\r\n' + rows.map(function(r) {
    return headers.map(function(h) { return csvCell(r[h]); }).join(',');
  }).join('\r\n');
  sendBg({ action: 'downloadData', base64: b64Utf8(String.fromCharCode(65279) + csv), mime: 'text/csv', filename: fname });
  setStatus((negativeOnly ? negName : '评论') + ' CSV 已导出：' + fname + '（' + list.length + ' 条）');
}

// 评论分析面板
function showReviewPanel() {
  var existing = __AIS_DOC().querySelector('.ais-modal-mask');
  if (existing) existing.remove();
  gatherReviewsForAnalysis(function(sources) {
    var mask = document.createElement('div');
    mask.className = 'ais-modal-mask';
    mask.innerHTML = '<div class="ais-modal ais-modal-review">' +
      '<div class="ais-modal-hero ais-hero-pink">' +
        '<div class="ais-modal-hero-bg"></div>' +
        '<div class="ais-modal-hero-content">' +
          '<div class="ais-modal-hero-icon">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
          '</div>' +
          '<div class="ais-modal-hero-text">' +
            '<div class="ais-modal-hero-title">评论分析</div>' +
            '<div class="ais-modal-hero-sub">星级分布 · 差评预警 · 高频关键词</div>' +
          '</div>' +
          '<button class="ais-modal-hero-close" aria-label="关闭">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="ais-modal-body" id="ais-review-body"></div>' +
    '</div>';
    (aisPanelViewHost() || __AIS_DOC()).appendChild(mask);
    bindModalClose(mask);

    var body = mask.querySelector('#ais-review-body');
    if (!sources || sources.length === 0) {
      body.innerHTML = '<div class="ais-empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>' +
        '<div class="ais-empty-title">暂无评论数据</div>' +
        '<div class="ais-empty-desc">请先在商品详情页使用"详情采集"（勾选评论数据），完成后即可在此分析评论</div>' +
      '</div>';
      return;
    }

    // 数据源选择
    var html = '';
    if (sources.length > 1) {
      html += '<div class="ais-review-source-row">';
      html += '<label>数据来源：</label><select id="ais-review-source" class="ais-review-source-select">';
      for (var i = 0; i < sources.length; i++) {
        var label = sources[i].title + (sources[i].fromHistory ? '（历史）' : '') + ' · ' + sources[i].reviews.length + ' 条';
        html += '<option value="' + i + '">' + escapeHtml(label.substring(0, 40)) + '</option>';
      }
      html += '</select>';
      html += '</div>';
    }
    html += '<div id="ais-review-content"></div>';
    body.innerHTML = html;

    var selectEl = body.querySelector('#ais-review-source');
    function renderSource(idx) {
      var src = sources[idx] || sources[0];
      var reviews = src.reviews;
      var stats = window.StatsAnalyzer && StatsAnalyzer.analyzeReviews ? StatsAnalyzer.analyzeReviews(reviews) : null;
      var contentEl = body.querySelector('#ais-review-content');
      contentEl.innerHTML = renderReviewAnalysisPanel(src, reviews, stats);
      bindReviewExportButtons(contentEl, src);
    }
    if (selectEl) {
      selectEl.addEventListener('change', function() { renderSource(parseInt(this.value, 10)); });
    }
    renderSource(0);
  });
}

// 渲染评论分析内容
function renderReviewAnalysisPanel(src, reviews, stats) {
  if (!stats) return '<div class="ais-empty-state"><div class="ais-empty-desc">无有效评论数据</div></div>';
  var html = '';

  // ===== 顶部卡片：商品名 + 核心指标 =====
  var s = __reviewSummary(stats);
  html += '<div class="ais-mv-card">';
  html += '<div class="ais-mv-goods-row">' +
    '<span class="ais-mv-goods-icon">📦</span>' +
    '<span class="ais-mv-goods-title" title="' + escapeHtml(src.title || '商品') + '">' + escapeHtml(src.title || '商品') + '</span>';
  if (src.fromHistory) html += '<span class="ais-mv-badge">历史</span>';
  html += '</div>';
  html += '<div class="ais-mv-tiles">';
  if (!isTaobaoFamilyHost()) html += '<div class="ais-mv-tile ais-mv-tile-good"><b>' + s.positiveRate + '%</b><span>好评率</span></div>';
  html += '<div class="ais-mv-tile"><b>' + s.negativeRate + '%</b><span>差评率</span></div>';
  html += '<div class="ais-mv-tile"><b>' + s.avgRating + '</b><span>平均评分</span></div>';
  html += '<div class="ais-mv-tile ais-mv-tile-accent"><b>' + stats.total + '</b><span>评论总数</span></div>';
  html += '</div>';
  if (stats.withImage > 0 || stats.appendCount > 0) {
    html += '<div class="ais-mv-sub-row">';
    if (stats.withImage > 0) html += '<span>🖼 有图 ' + stats.withImage + ' 条</span>';
    if (stats.appendCount > 0) html += '<span>✏️ 追评 ' + stats.appendCount + ' 条</span>';
    html += '</div>';
  }
  html += '</div>';

  // ===== 差评话题归因 =====
  var topics = (stats && stats.summary && stats.summary.negativeTopics) ? stats.summary.negativeTopics : [];
  if (topics.length > 0) {
    html += '<div class="ais-mv-section"><div class="ais-mv-label">🔍 差评话题归因</div><div class="ais-mv-tags">';
    topics.slice(0, 6).forEach(function(t) {
      html += '<span class="ais-mv-tag ais-mv-tag-warn">' + escapeHtml(t.topic) + '<em>' + t.count + '</em></span>';
    });
    html += '</div></div>';
  }

  // ===== 星级分布（横向条） =====
  if (stats.ratingDistribution) {
    var rd = stats.ratingDistribution;
    var maxRd = 0;
    var stars = [['5','5★'],['4','4★'],['3','3★'],['2','2★'],['1','1★']];
    for (var si = 0; si < stars.length; si++) { var c2 = rd[stars[si][0]] ? rd[stars[si][0]].count : 0; if (c2 > maxRd) maxRd = c2; }
    html += '<div class="ais-mv-section"><div class="ais-mv-label">⭐ 星级分布</div><div class="ais-mv-bars">';
    stars.forEach(function(item) {
      var d = rd[item[0]];
      if (!d) return;
      var pctW = maxRd > 0 ? Math.round(d.count / maxRd * 100) : 0;
      html += '<div class="ais-mv-bar ais-mv-bar-star' + item[0] + '">' +
        '<span class="ais-mv-bar-label">' + item[1] + '</span>' +
        '<span class="ais-mv-bar-track"><span class="ais-mv-bar-fill" style="width:' + pctW + '%"></span></span>' +
        '<span class="ais-mv-bar-count">' + d.count + ' 条 · ' + d.pct + '%</span>' +
      '</div>';
    });
    html += '</div></div>';
  }

  // ===== 高频关键词 =====
  if (stats.wordFrequency && stats.wordFrequency.length > 0) {
    html += '<div class="ais-mv-section"><div class="ais-mv-label">📝 高频关键词 Top' + Math.min(stats.wordFrequency.length, 12) + '</div><div class="ais-mv-tags">';
    stats.wordFrequency.slice(0, 12).forEach(function(w, i) {
      html += '<span class="ais-mv-tag' + (i < 3 ? ' ais-mv-tag-hot' : '') + '">' + escapeHtml(w.word) + '<em>' + w.count + '</em></span>';
    });
    html += '</div></div>';
  }

  // ===== SKU 分布（横向条） =====
  if (stats.skuDistribution && stats.skuDistribution.length > 0) {
    var maxSkuCount = 0;
    var skus = stats.skuDistribution.slice(0, 6);
    for (var sk = 0; sk < skus.length; sk++) { if (skus[sk].count > maxSkuCount) maxSkuCount = skus[sk].count; }
    html += '<div class="ais-mv-section"><div class="ais-mv-label">🏷 SKU 评论分布</div><div class="ais-mv-bars">';
    skus.forEach(function(x) {
      var pct = maxSkuCount > 0 ? Math.round(x.count / maxSkuCount * 100) : 0;
      var namePct = stats.total > 0 ? Math.round(x.count / stats.total * 100) : 0;
      html += '<div class="ais-mv-bar">' +
        '<span class="ais-mv-bar-label ais-mv-bar-label-sku" title="' + escapeHtml(x.sku) + '">' + escapeHtml(x.sku.substring(0, 8)) + '</span>' +
        '<span class="ais-mv-bar-track"><span class="ais-mv-bar-fill ais-mv-bar-fill-sku" style="width:' + pct + '%"></span></span>' +
        '<span class="ais-mv-bar-count">' + x.count + ' 条 · ' + namePct + '%</span>' +
      '</div>';
    });
    html += '</div></div>';
  }

  // ===== 评论趋势 =====
  if (stats.timeTrend && stats.timeTrend.length > 0) {
    var maxCount = 0;
    for (var tt = 0; tt < stats.timeTrend.length; tt++) { if (stats.timeTrend[tt].count > maxCount) maxCount = stats.timeTrend[tt].count; }
    html += '<div class="ais-mv-section"><div class="ais-mv-label">📅 评论趋势</div><div class="ais-mv-bars">';
    stats.timeTrend.forEach(function(d) {
      var pct = maxCount > 0 ? Math.round(d.count / maxCount * 100) : 0;
      html += '<div class="ais-mv-bar">' +
        '<span class="ais-mv-bar-label">' + escapeHtml(d.date.substring(5)) + '</span>' +
        '<span class="ais-mv-bar-track"><span class="ais-mv-bar-fill ais-mv-bar-fill-trend" style="width:' + pct + '%"></span></span>' +
        '<span class="ais-mv-bar-count">' + d.count + ' 条</span>' +
      '</div>';
    });
    html += '</div></div>';
  }

  // ===== 差评预警 =====
  if (stats.negativeAlert && stats.negativeAlert.negativeCount > 0) {
    var na = stats.negativeAlert;
    var levelText = na.level === 'high' ? '高危' : na.level === 'medium' ? '中危' : na.level === 'low' ? '低危' : '待观察';
    var levelClass = na.level === 'high' ? 'ais-alert-high' : na.level === 'medium' ? 'ais-alert-medium' : na.level === 'low' ? 'ais-alert-low' : 'ais-alert-info';
    html += '<div class="ais-mv-section"><div class="ais-negative-alert ' + levelClass + '">';
    html += '<div class="ais-negative-alert-header">';
    html += '<span class="ais-negative-alert-icon">⚠️</span>';
    html += '<span class="ais-negative-alert-title">低星评价预警 · ' + levelText + '</span>';
    html += '<span class="ais-negative-alert-stat">' + na.negativeCount + ' 条（' + na.negativeRate + '%）</span>';
    html += '</div>';
    if (na.suspectedCount > 0) html += '<div class="ais-negative-risk-row"><span class="ais-negative-risk-label">待确认文本线索：</span><span class="ais-stat-chip">' + na.suspectedCount + ' 条（不计入预警）</span></div>';
    if (na.riskKeywords && na.riskKeywords.length > 0) {
      html += '<div class="ais-negative-risk-row"><span class="ais-negative-risk-label">风险词：</span>';
      na.riskKeywords.forEach(function(k) {
        html += '<span class="ais-stat-chip ais-chip-red">' + escapeHtml(k.word) + ' (' + k.count + ')</span>';
      });
      html += '</div>';
    }
    if (na.recentNegatives && na.recentNegatives.length > 0) {
      html += '<div class="ais-negative-list">';
      na.recentNegatives.forEach(function(r) {
        html += '<div class="ais-negative-item">';
        html += '<span class="ais-negative-item-rating">' + r.rating + '★</span>';
        html += '<span class="ais-negative-item-content">' + escapeHtml(r.content) + '</span>';
        if (r.skuInfo) html += '<span class="ais-negative-item-sku">' + escapeHtml(r.skuInfo) + '</span>';
        if (r.time) html += '<span class="ais-negative-item-time">' + escapeHtml(r.time) + '</span>';
        html += '</div>';
      });
      html += '</div>';
    }
    html += '</div></div>';
  } else {
    html += '<div class="ais-mv-section"><div class="ais-mv-tag ais-mv-tag-ok">✅ 无差评（1-2星）</div></div>';
  }

  // ===== 导出 =====
  html += '<div class="ais-review-export-row">' +
    '<button type="button" class="ais-btn ais-btn-primary" id="ais-export-neg">⚠️ 导出差评 CSV（' + (stats.negativeAlert ? stats.negativeAlert.negativeCount : 0) + ' 条）</button>' +
    '<button type="button" class="ais-btn ais-btn-ghost" id="ais-export-all">📄 导出全部评论 CSV（' + reviews.length + ' 条）</button>' +
  '</div>';
  return html;
}


// 绑定评论导出按钮
function bindReviewExportButtons(container, src) {
  var negBtn = container.querySelector('#ais-export-neg');
  if (negBtn) negBtn.addEventListener('click', function() { exportReviewsCsv(src.reviews, true, src.title); });
  var allBtn = container.querySelector('#ais-export-all');
  if (allBtn) allBtn.addEventListener('click', function() { exportReviewsCsv(src.reviews, false, src.title); });
}

// ========== Excel Export ==========
async function exportExcel() {
  try {
    var r = await chrome.storage.local.get(['lastData', 'lastFields', 'detailData', 'skuData', 'reviewData', 'isDetailPage']);

    // 列表采集模式：忽略上次详情采集残留的 detailData/skuData/reviewData
    // 避免Excel多Sheet导出时混入上一次详情页的SKU/评论数据
    if (!r.isDetailPage) {
      r.detailData = null;
      r.skuData = null;
      r.reviewData = null;
    }

    // 授权校验：详情页Excel多Sheet导出（多Sheet含SKU/评论等需要专业版）
    if (r.isDetailPage && r.detailData) {
      var allowed = await requirePaidFeature('excel_multi_sheet', 'Excel多Sheet导出');
      if (!allowed) return;
    }

    if (r.isDetailPage && r.detailData) {
      var flatData = await generateDetailFlatData(r.detailData, r.skuData, r.reviewData);
      r.lastData = [flatData];
      r.lastFields = Object.keys(flatData);
    }

    if (!r.lastData || !r.lastFields || r.lastData.length === 0) {
      console.warn('[Excel导出] 无数据可导出', { lastData: r.lastData, isDetailPage: r.isDetailPage });
      { aisToast('无数据可导出，请先采集商品数据', 'warn'); return; }
    }

    var sheets = {};
    
    sheets['商品基本信息'] = {
      headers: r.lastFields,
      rows: r.lastData
    };

    // 统计摘要 Sheet（紧跟商品基本信息之后，作为第二个 Sheet）
    if (window.StatsAnalyzer) {
      var statsRows = [];
      var statsHeaders = ['指标', '数值'];

      if (r.isDetailPage && r.detailData && r.detailData.reviews && r.detailData.reviews.length > 0) {
        // 详情页：评论分析
        var reviewStats = window.StatsAnalyzer.analyzeReviews(r.detailData.reviews);
        if (reviewStats) {
          statsRows.push({ '指标': '评论总数', '数值': reviewStats.total });
          statsRows.push({ '指标': '好评率%', '数值': reviewStats.ratingDistribution.positiveRate });
          statsRows.push({ '指标': '5星数', '数值': reviewStats.ratingDistribution['5'].count });
          statsRows.push({ '指标': '4星数', '数值': reviewStats.ratingDistribution['4'].count });
          statsRows.push({ '指标': '3星数', '数值': reviewStats.ratingDistribution['3'].count });
          statsRows.push({ '指标': '2星数', '数值': reviewStats.ratingDistribution['2'].count });
          statsRows.push({ '指标': '1星数', '数值': reviewStats.ratingDistribution['1'].count });
          statsRows.push({ '指标': '有图评论数', '数值': reviewStats.withImage });
          statsRows.push({ '指标': '追评数', '数值': reviewStats.appendCount });
          reviewStats.wordFrequency.slice(0, 10).forEach(function(w, i) {
            statsRows.push({ '指标': '关键词Top' + (i + 1), '数值': w.word + ' (' + w.count + ')' });
          });
          if (reviewStats.skuDistribution) {
            reviewStats.skuDistribution.forEach(function(s, i) {
              if (i < 5) statsRows.push({ '指标': 'SKU分布-' + (i + 1), '数值': s.sku + ' (' + s.count + ')' });
            });
          }
        }
      } else if (r.lastData && r.lastData.length > 0) {
        // 列表页：数据统计
        var fieldObjs = r.lastFields.map(function(f) { return { name: f }; });
        var listStats = window.StatsAnalyzer.analyzeListData(r.lastData, fieldObjs);
        if (listStats) {
          statsRows.push({ '指标': '数据总数', '数值': listStats.total });
          if (listStats.price) {
            statsRows.push({ '指标': '价格-均价', '数值': listStats.price.avg });
            statsRows.push({ '指标': '价格-最低', '数值': listStats.price.min });
            statsRows.push({ '指标': '价格-最高', '数值': listStats.price.max });
            statsRows.push({ '指标': '价格-中位数', '数值': listStats.price.median });
            listStats.price.distribution.forEach(function(d) {
              statsRows.push({ '指标': '价格区间-' + d.label, '数值': d.count });
            });
          }
          if (listStats.sales) {
            statsRows.push({ '指标': '销量-总销量', '数值': listStats.sales.total });
            statsRows.push({ '指标': '销量-平均销量', '数值': listStats.sales.avg });
            statsRows.push({ '指标': '销量-最高', '数值': listStats.sales.max });
          }
          if (listStats.shop) {
            statsRows.push({ '指标': '商家总数', '数值': listStats.shop.uniqueCount });
            listStats.shop.topShops.forEach(function(s, i) {
              statsRows.push({ '指标': 'Top' + (i + 1) + '商家', '数值': s.name + ' (' + s.count + ')' });
            });
          }
          if (listStats.coupon) {
            statsRows.push({ '指标': '有优惠券数', '数值': listStats.coupon.withCoupon });
            statsRows.push({ '指标': '优惠券覆盖率%', '数值': listStats.coupon.rate });
          }
        }
      }

      if (statsRows.length > 0) {
        sheets['统计摘要'] = { headers: statsHeaders, rows: statsRows };
      }
    }

    if (r.skuData && r.skuData.length > 0) {
      var skuFields = Object.keys(r.skuData[0]);
      sheets['SKU规格'] = {
        headers: skuFields,
        rows: r.skuData
      };

      // SKU 矩阵展开 Sheet（电商垂直差异化）
      if (window.StatsAnalyzer && window.StatsAnalyzer.buildSkuMatrix) {
        // 把 skuData 转换为 buildSkuMatrix 期望的格式
        var skuInput = r.skuData.map(function(row) {
          return {
            skuId: row['SKU_ID'] || '',
            name: row['SKU名称'] || row['SKU'] || '',
            price: row['SKU价格'] || row['价格'] || '',
            stock: row['库存'] || '',
            available: (row['是否有货'] === '是' || row['是否有货'] === true),
            specs: null
          };
        });
        var matrix = window.StatsAnalyzer.buildSkuMatrix(skuInput);
        if (matrix.rows.length > 0) {
          var matFields = Object.keys(matrix.rows[0]);
          sheets['SKU矩阵'] = {
            headers: matFields,
            rows: matrix.rows
          };
          // 矩阵摘要
          var matSummaryRows = [];
          var sm = matrix.summary;
          matSummaryRows.push({ '指标': 'SKU总数', '数值': sm.total });
          matSummaryRows.push({ '指标': '有货SKU', '数值': sm.available });
          matSummaryRows.push({ '指标': '缺货SKU', '数值': sm.outOfStock });
          matSummaryRows.push({ '指标': '总库存', '数值': sm.stockSum });
          matSummaryRows.push({ '指标': '最低价', '数值': sm.priceMin });
          matSummaryRows.push({ '指标': '最高价', '数值': sm.priceMax });
          matSummaryRows.push({ '指标': '价格区间', '数值': sm.priceRange });
          matSummaryRows.push({ '指标': '均价', '数值': sm.avgPrice });
          if (sm.specDimensions && sm.specDimensions.length > 0) {
            matSummaryRows.push({ '指标': '规格维度', '数值': sm.specDimensions.join(' / ') });
          }
          sheets['SKU矩阵摘要'] = { headers: ['指标', '数值'], rows: matSummaryRows };
        }
      }
    }

    if (r.reviewData && r.reviewData.length > 0) {
      var reviewFields = Object.keys(r.reviewData[0]);
      sheets['评论数据'] = {
        headers: reviewFields,
        rows: r.reviewData
      };

      // 评论聚合分析 Sheet（电商垂直差异化）
      if (window.StatsAnalyzer && window.StatsAnalyzer.aggregateReviews) {
        // 转换 reviewData 为 aggregateReviews 期望的格式
        var reviewInput = r.reviewData.map(function(row) {
          return {
            rating: row['评分'] || 0,
            content: row['评论内容'] || '',
            skuInfo: row['SKU信息'] || '',
            time: row['评论时间'] || '',
            username: row['用户名'] || '',
            hasImage: (row['是否有图'] === '是' || row['是否有图'] === true),
            isAppend: (row['是否追评'] === '是' || row['是否追评'] === true)
          };
        });
        var reviewAgg = window.StatsAnalyzer.aggregateReviews(reviewInput);
        if (reviewAgg.total > 0) {
          var aggRows = [];
          aggRows.push({ '指标': '评论总数', '数值': reviewAgg.total });
          aggRows.push({ '指标': '好评率%', '数值': reviewAgg.summary.positiveRate });
          aggRows.push({ '指标': '差评率%', '数值': reviewAgg.summary.negativeRate });
          aggRows.push({ '指标': '平均评分', '数值': reviewAgg.summary.avgRating });
          aggRows.push({ '指标': '带图率%', '数值': reviewAgg.summary.withImageRate });
          aggRows.push({ '指标': '追评数', '数值': reviewAgg.summary.appendCount });
          aggRows.push({ '指标': '近7天评论', '数值': reviewAgg.byTime.last7d });
          aggRows.push({ '指标': '近30天评论', '数值': reviewAgg.byTime.last30d });
          aggRows.push({ '指标': '更早评论', '数值': reviewAgg.byTime.older });
          // 星级
          ['5','4','3','2','1'].forEach(function(s) {
            aggRows.push({ '指标': s + '星评论数', '数值': reviewAgg.byRating[s] });
          });
          // 关键词
          if (reviewAgg.topKeywords) {
            reviewAgg.topKeywords.forEach(function(kw, i) {
              aggRows.push({ '指标': '关键词Top' + (i + 1), '数值': kw.word + ' (' + kw.count + ')' });
            });
          }
          sheets['评论聚合'] = { headers: ['指标', '数值'], rows: aggRows };

          // 按SKU细分表
          if (reviewAgg.bySku && reviewAgg.bySku.length > 0 && reviewAgg.bySku[0].sku !== '未指定SKU') {
            var skuAggRows = reviewAgg.bySku.map(function(s) {
              return {
                'SKU': s.sku,
                '评论数': s.total,
                '好评率%': s.positiveRate,
                '5星': s.ratings[5],
                '4星': s.ratings[4],
                '3星': s.ratings[3],
                '2星': s.ratings[2],
                '1星': s.ratings[1],
                '带图数': s.withImage
              };
            });
            sheets['评论SKU细分'] = { headers: Object.keys(skuAggRows[0]), rows: skuAggRows };
          }
        }
      }
    }

    // ========== 使用 SheetJS 生成标准 .xlsx（支持多 Sheet）==========
    if (typeof XLSX === 'undefined' || typeof JSZip === 'undefined') {
      return exportExcelLegacy(sheets);
    }

    // 免责声明 Sheet
    var disclaimerText = '本数据由 电商采集大师 工具自动采集自公开网页，仅供个人学习、研究使用。用户应遵守各平台服务协议及相关法律法规，不得用于商业用途或侵权行为。数据准确性不作保证，使用风险自负。工具开发者不承担因数据使用产生的任何法律责任。';
    sheets['免责声明'] = { headers: ['免责声明'], rows: [{ '免责声明': disclaimerText }] };

    var wb = XLSX.utils.book_new();
    var sheetNames = Object.keys(sheets);
    var allColWidths = {};

    sheetNames.forEach(function(name) {
      var sheet = sheets[name];
      var aoa = [sheet.headers];
      sheet.rows.forEach(function(row) {
        var rowArr = sheet.headers.map(function(h) {
          var val = row[h];
          if (val === null || val === undefined) return '';
          return val;
        });
        aoa.push(rowArr);
      });
      var ws = XLSX.utils.aoa_to_sheet(aoa);

      var colWidths = sheet.headers.map(function(h) {
        var maxLen = (h || '').length;
        sheet.rows.forEach(function(row) {
          var v = String(row[h] || '').length;
          if (v > maxLen) maxLen = v;
        });
        return Math.min(maxLen + 3, 60);
      });
      allColWidths[name] = colWidths;
      ws['!cols'] = colWidths.map(function(w) { return { wch: w }; });

      XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
    });

    var rawArray = XLSX.write(wb, { bookType: 'xlsx', type: 'array', bookSST: false });
    var styledArray = await injectXlsxStyles(rawArray, sheetNames, sheets, allColWidths);
    if (!styledArray) {
      var blob = new Blob([rawArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'ai-scraper-' + new Date().toISOString().slice(0, 10) + '.xlsx';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setStatus('Excel 已下载 (无样式)');
      return;
    }

    var blob = new Blob([styledArray], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ai-scraper-' + new Date().toISOString().slice(0, 10) + '.xlsx';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    setStatus('Excel 已下载 (' + sheetNames.join(', ') + ')');
  } catch (err) {
    console.error('Excel导出错误:', err);
    aisToast('导出失败: ' + err.message, 'error');
  }
}

// 旧版 HTML .xls 导出（SheetJS 未加载时的回退）
function exportExcelLegacy(sheets) {
  try {
    var html = '<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">';
    html += '<head><meta charset="UTF-8"/><!--[if gte mso 9]><xml><x:ExcelWorkbook><x:ExcelWorksheets>';

    var sheetNames = Object.keys(sheets);
    sheetNames.forEach(function(name) {
      var safeName = name.substring(0, 31);
      html += '<x:ExcelWorksheet><x:Name>' + safeName + '</x:Name><x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions></x:ExcelWorksheet>';
    });
    html += '</x:ExcelWorksheets></x:ExcelWorkbook></xml><![endif]--></head><body>';

    sheetNames.forEach(function(name) {
      var sheet = sheets[name];
      html += '<div>';
      html += '<table border="1">';
      html += '<tr>' + sheet.headers.map(function(h) { return '<th style="background:#f0f0f0;font-weight:bold;">' + h + '</th>'; }).join('') + '</tr>';
      sheet.rows.forEach(function(row) {
        html += '<tr>';
        html += sheet.headers.map(function(h) {
          var val = row[h];
          if (val === null || val === undefined) val = '';
          val = String(val);
          if (/^[=+\-@\t]/.test(val)) val = "'" + val;
          val = val.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          return '<td>' + val + '</td>';
        }).join('');
        html += '</tr>';
      });
      html += '</table>';
      html += '</div>';
    });
    html += '</body></html>';

    var blob = new Blob(['\uFEFF' + html], { type: 'application/vnd.ms-excel;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'ai-scraper-' + new Date().toISOString().slice(0, 10) + '.xls';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('Excel 已下载 (HTML回退)');
  } catch (err) {
    console.error('Excel导出(回退)错误:', err);
    aisToast('导出失败: ' + err.message, 'error');
  }
}

// ========== JSZip 样式注入 ==========
async function injectXlsxStyles(rawArray, sheetNames, sheets, allColWidths) {
  try {
    var zip = await JSZip.loadAsync(rawArray);
    if (!zip) return null;
    zip.file('xl/styles.xml', buildStyledStylesXml());
    for (var si = 0; si < sheetNames.length; si++) {
      var name = sheetNames[si];
      var sheet = sheets[name];
      var colWidths = allColWidths[name] || [];
      zip.file('xl/worksheets/sheet' + (si + 1) + '.xml', buildStyledSheetXml(sheet, colWidths));
    }
    return await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  } catch (e) {
    console.error('[样式注入] 失败:', e);
    return null;
  }
}
function buildStyledStylesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="6">' +
      '<font><sz val="10"/><name val="微软雅黑"/></font>' +
      '<font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>' +
      // v1.2.453：与电商宝导出格式对齐（extracted/lib/export.js cellStyle）——标题 14px 粗白 / 副标题 10px 斜体灰
      '<font><b/><sz val="14"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>' +
      '<font><i/><sz val="10"/><color rgb="FF786D65"/><name val="微软雅黑"/></font>' +
      // v1.2.453：电商宝表头/正文字号是 11（参考文件实测 A3/A4 sz=11），故单独两个字体
      '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="微软雅黑"/></font>' +
      '<font><sz val="11"/><name val="微软雅黑"/></font>' +
    '</fonts>' +
    '<fills count="8">' +
      '<fill><patternFill patternType="none"/></fill>' +
      '<fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FF4472C4"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF2F7FB"/></patternFill></fill>' +
      // v1.2.453：电商宝色板（accentDark 标题 / FFF8F2 副标题 / accent 表头 / FFF9F4 斑马）
      '<fill><patternFill patternType="solid"><fgColor rgb="FF9F4E31"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF8F2"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFC96A3C"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF9F4"/></patternFill></fill>' +
    '</fills>' +
    '<borders count="3">' +
      '<border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FF999999"/></left>' +
        '<right style="thin"><color rgb="FF999999"/></right>' +
        '<top style="thin"><color rgb="FF999999"/></top>' +
        '<bottom style="thin"><color rgb="FF999999"/></bottom><diagonal/></border>' +
      // v1.2.453：电商宝边框色 EADFD3
      '<border><left style="thin"><color rgb="FFEADFD3"/></left>' +
        '<right style="thin"><color rgb="FFEADFD3"/></right>' +
        '<top style="thin"><color rgb="FFEADFD3"/></top>' +
        '<bottom style="thin"><color rgb="FFEADFD3"/></bottom><diagonal/></border>' +
    '</borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="9">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" wrapText="1"/>' +
      '</xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1">' +
        '<alignment vertical="center"/>' +
      '</xf>' +
      '<xf numFmtId="0" fontId="0" fillId="3" borderId="1" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment vertical="center"/>' +
      '</xf>' +
      // 6 表头 / 7 斑马 / 8 正文 —— 电商宝口径（仅在 sheet.title 存在时使用；字号 11、字体 id 4/5）
      '<xf numFmtId="0" fontId="2" fillId="4" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="left" vertical="center"/>' +
      '</xf>' +
      '<xf numFmtId="0" fontId="3" fillId="5" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="left" vertical="center"/>' +
      '</xf>' +
      '<xf numFmtId="0" fontId="4" fillId="6" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="center" vertical="center" wrapText="1"/>' +
      '</xf>' +
      // v1.2.455：数据单元格**不再自动换行**（原来 wrapText=1，超长「商品链接」被撑成几十行 —— 用户「这个自动换行」）
      '<xf numFmtId="0" fontId="5" fillId="7" borderId="2" xfId="0" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment vertical="top"/>' +
      '</xf>' +
      '<xf numFmtId="0" fontId="5" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1">' +
        '<alignment vertical="top"/>' +
      '</xf>' +
    '</cellXfs></styleSheet>';
}
function buildStyledSheetXml(sheet, colWidths) {
  var headers = sheet.headers;
  var rows = sheet.rows;
  // v1.2.453：sheet.title 存在时输出「电商宝口径」三行表头结构：
  //   第1行 标题（合并 A1:<末列>1，行高 25）· 第2行 导出时间/条数（合并，行高 18）· 第3行 表头（行高 24）
  //   + autoFilter（A3:<末列><末行>）+ mergeCells。元素顺序必须按 OOXML schema：cols → sheetData → autoFilter → mergeCells
  var hasTitle = !!sheet.title;
  var headRow = hasTitle ? 3 : 1;
  var lastCol = colLetter(headers.length - 1);
  var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"/></sheetViews><cols>';
  for (var ci = 0; ci < headers.length; ci++) {
    var w = colWidths[ci] || 10;
    xml += '<col min="' + (ci + 1) + '" max="' + (ci + 1) + '" width="' + w + '" customWidth="1"/>';
  }
  xml += '</cols><sheetData>';
  if (hasTitle) {
    xml += '<row r="1" ht="25" customHeight="1"><c r="A1" s="4" t="str"><v>' + escXml(sheet.title) + '</v></c></row>';
    xml += '<row r="2" ht="18" customHeight="1"><c r="A2" s="5" t="str"><v>' + escXml(sheet.subtitle || '') + '</v></c></row>';
  }
  xml += '<row r="' + headRow + '"' + (hasTitle ? ' ht="24" customHeight="1"' : '') + '>';
  for (var h = 0; h < headers.length; h++) {
    xml += '<c r="' + colLetter(h) + headRow + '" s="' + (hasTitle ? 6 : 1) + '" t="str"><v>' + escXml(headers[h]) + '</v></c>';
  }
  xml += '</row>';
  for (var ri = 0; ri < rows.length; ri++) {
    var row = rows[ri];
    var rowNum = ri + headRow + 1;
    var xfId = hasTitle ? ((ri % 2 === 0) ? 8 : 7) : ((ri % 2 === 0) ? 3 : 2);
    xml += '<row r="' + rowNum + '">';
    for (var hi = 0; hi < headers.length; hi++) {
      var val = row[headers[hi]];
      if (val === null || val === undefined) val = '';
      val = String(val);
      xml += '<c r="' + colLetter(hi) + rowNum + '" s="' + xfId + '" t="str"><v>' + escXml(val) + '</v></c>';
    }
    xml += '</row>';
  }
  xml += '</sheetData>';
  if (hasTitle) {
    xml += '<autoFilter ref="A' + headRow + ':' + lastCol + (rows.length + headRow) + '"/>';
    xml += '<mergeCells count="2"><mergeCell ref="A1:' + lastCol + '1"/><mergeCell ref="A2:' + lastCol + '2"/></mergeCells>';
  }
  xml += '</worksheet>';
  return xml;
}
function colLetter(n) {
  var s = '';
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
}
function escXml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(msg, kind) {
  msg = (typeof aisText === 'function') ? aisText(msg) : String(msg == null ? '' : msg);   // v1.2.282 防作用域未就绪崩溃
  var el = __AIS_DOC().getElementById('ais-status');
  if (el) el.textContent = msg;
  var dot = __AIS_DOC().getElementById('ais-status-dot');
  if (dot) {
    // v1.2.263：支持显式类型（ok/warn/error）；并把「加载中」也识别为 busy
    dot.classList.remove('busy', 'error', 'warn', 'ok');
    if (kind === 'error' || (!kind && /失败|错误|取消/.test(msg))) dot.classList.add('error');
    else if (kind === 'warn') dot.classList.add('warn');
    else if (kind === 'ok') dot.classList.add('ok');
    else if (/采集中|正在|等待|识别中|加载中/.test(msg)) dot.classList.add('busy');
  }
}

// ========== 采集历史功能 ==========
function saveToHistory(record) {
  chrome.storage.local.get(['aisHistory'], function(r) {
    var history = r.aisHistory || [];
    history.unshift(record); // 最新的在前
    // 限制最多 50 条
    if (history.length > 50) history = history.slice(0, 50);
    chrome.storage.local.set({ aisHistory: history }, function() {
      // v1.1.40：写入失败（多为配额超限）→ 降级为仅元信息重试，保证历史不丢
      if (chrome.runtime.lastError) {
        var lite = history.map(function(h) {
          if (h !== record) return h;
          var o = {};
          for (var k in h) { if (k !== 'data') o[k] = h[k]; }
          o.dataOmitted = true;
          return o;
        });
        chrome.storage.local.set({ aisHistory: lite }, function() { void chrome.runtime.lastError; });
      }
    });
  });
}


// === 授权管理 ===
// 更新头部授权状态标签
function updateLicenseTag() {
  var tag = __AIS_DOC().getElementById('ais-license-tag');
  if (tag) {
    tag.className = 'ais-license-status-tag ais-license-status-active';
    tag.textContent = '本地版';
    tag.title = '本地功能无需激活，不设到期时间';
  }
  var hint = __AIS_DOC().getElementById('ais-review-page-limit-hint');
  if (hint) hint.style.display = 'none';
  var checkbox = __AIS_DOC().getElementById('ais-chk-review-images');
  if (checkbox) checkbox.disabled = false;
  var wrap = __AIS_DOC().getElementById('ais-chk-review-images-wrap');
  if (wrap) {
    wrap.classList.remove('ais-chk-locked');
    var lock = wrap.querySelector('.ais-chk-lock-hint');
    if (lock) lock.remove();
  }
}

// Compatibility entry points used by existing collection/export handlers.
function checkPaidFeature() { return Promise.resolve({ allowed: true, unlimited: true, local: true }); }
function showLicenseRequired() { LicenseModal.show(); }
async function requirePaidFeature() { return true; }


function showHistoryPanel() {
  var existing = __AIS_DOC().querySelector('.ais-modal-mask');
  if (existing) existing.remove();

  chrome.storage.local.get(['aisHistory', 'dataHistory', 'aisImgHistory'], function(r) {
    // 统一旧/新历史 schema，避免 time/count 记录显示为 Invalid Date/0 条数据。
    function normalize(item, source, sourceIndex) {
      item = item || {};
      var rawTime = item.timestamp || item.time || item.ts || 0;
      var parsedTime = typeof rawTime === 'number' ? rawTime : Date.parse(rawTime);
      return {
        type: item.type || (source === 'aisImgHistory' ? 'images' : (item.data ? 'batch' : 'list')),
        title: item.title || item.name || (item.data && item.data[0] && (item.data[0].商品名称 || item.data[0].商品标题 || item.data[0].标题)) || '未命名',
        url: item.url || item.itemUrl || '',
        itemCount: Number(item.itemCount != null ? item.itemCount : (item.count != null ? item.count : (Array.isArray(item.data) ? item.data.length : 0))) || 0,
        timestamp: Number.isFinite(parsedTime) ? parsedTime : 0,
        data: item.data,
        _source: source,
        _sourceIndex: sourceIndex
      };
    }
    var history = [];
    (Array.isArray(r.aisHistory) ? r.aisHistory : []).forEach(function(item, index) { history.push(normalize(item, 'aisHistory', index)); });
    (Array.isArray(r.dataHistory) ? r.dataHistory : []).forEach(function(item, index) { history.push(normalize(item, 'dataHistory', index)); });
    (Array.isArray(r.aisImgHistory) ? r.aisImgHistory : []).forEach(function(item, index) { history.push(normalize(item, 'aisImgHistory', index)); });
    var seenAll = {};
    history = history.filter(function(x) {
      var key = (x.type || '') + '|' + (x.timestamp || 0) + '|' + (x.url || '') + '|' + (x.itemCount || 0);
      if (seenAll[key]) return false;
      seenAll[key] = true;
      return true;
    }).sort(function(a, b) { return (b.timestamp || 0) - (a.timestamp || 0); }).slice(0, 50);

    var mask = document.createElement('div');
    mask.className = 'ais-modal-mask';
    var html = '<div class="ais-modal ais-modal-history">' +
      '<div class="ais-modal-hero ais-hero-slate">' +
        '<div class="ais-modal-hero-bg"></div>' +
        '<div class="ais-modal-hero-content">' +
          '<div class="ais-modal-hero-icon">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
          '</div>' +
          '<div class="ais-modal-hero-text">' +
            '<div class="ais-modal-hero-title">采集历史</div>' +
            '<div class="ais-modal-hero-sub">共 ' + history.length + ' 条采集记录</div>' +
          '</div>' +
          '<button class="ais-modal-hero-close" aria-label="关闭">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
          '</button>' +
        '</div>' +
      '</div>' +
      '<div class="ais-modal-body">';

    if (history.length === 0) {
      html += '<div class="ais-empty-state">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
        '<div class="ais-empty-title">暂无采集记录</div>' +
        '<div class="ais-empty-desc">完成采集后会自动保存到此处</div>' +
      '</div>';
    } else {
      html += '<div class="ais-history-toolbar">' +
        '<span class="ais-history-count">共 ' + history.length + ' 条记录</span>' +
        '<button type="button" class="ais-history-clear-btn" id="ais-history-clear">清空全部</button>' +
      '</div>';
      html += '<div class="ais-history-list">';
      for (var i = 0; i < history.length; i++) {
        var h = history[i];
        var d = new Date(h.timestamp);
        var timeStr = d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
        var typeLabel = h.type === 'detail' ? '详情采集' : (h.type === 'batch' ? '批量采集' : (h.type === 'images' ? '图片采集' : '列表采集'));
        var typeClass = h.type === 'detail' ? 'ais-history-type-detail' : (h.type === 'batch' ? 'ais-history-type-batch' : (h.type === 'images' ? 'ais-history-type-images' : 'ais-history-type-list'));
        html += '<div class="ais-history-item" data-idx="' + i + '">' +
          '<div class="ais-history-item-main">' +
            '<div class="ais-history-item-title">' + escapeHtml(h.title || '未命名') + '</div>' +
            '<div class="ais-history-item-meta">' +
              '<span class="ais-history-type ' + typeClass + '">' + typeLabel + '</span>' +
              '<span class="ais-history-time">' + timeStr + '</span>' +
              '<span class="ais-history-count-badge">' + (h.itemCount || 0) + ' 条数据</span>' +
            '</div>' +
            '<div class="ais-history-url" title="' + escapeHtml(h.url || '') + '">' + escapeHtml(h.url || '') + '</div>' +
          '</div>' +
          '<div class="ais-history-item-actions">' +
            '<button class="ais-btn-sm ais-btn-primary" data-action="load" data-idx="' + i + '">加载</button>' +
            '<button class="ais-btn-sm ais-btn-ghost" data-action="delete" data-idx="' + i + '">删除</button>' +
          '</div>' +
        '</div>';
      }
      html += '</div>';
    }

    html += '</div></div>';
    mask.innerHTML = html;
    (aisPanelViewHost() || __AIS_DOC()).appendChild(mask);

    var closeModal = bindModalClose(mask);

    // 清空全部
    var clearBtn = mask.querySelector('#ais-history-clear');
    if (clearBtn) {
      clearBtn.addEventListener('click', async function() {
        if (await aisConfirm('确定清空所有采集历史吗？此操作不可撤销。', { okText: '确认清空' })) {
          chrome.storage.local.set({ aisHistory: [], dataHistory: [], aisImgHistory: [] }, function() {
            closeModal();
            showHistoryPanel();
          });
        }
      });
    }

    // 加载/删除
    var actionBtns = mask.querySelectorAll('.ais-history-item-actions button');
    actionBtns.forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.stopPropagation();
        var idx = parseInt(this.getAttribute('data-idx'), 10);
        var action = this.getAttribute('data-action');
        if (action === 'delete') {
          if (!(await aisConfirm('确定删除这条历史记录吗？删除后无法恢复。'))) return;
          history.splice(idx, 1);
          // 三源合并列表删除后同步重建来源，避免旧 dataHistory 记录复活
          var updates = { aisHistory: [], dataHistory: [], aisImgHistory: [] };
          history.forEach(function(x) {
            if (x._source === 'aisImgHistory') updates.aisImgHistory.push({ ts: x.timestamp, title: x.title, url: x.url, count: x.itemCount });
            else if (x._source === 'dataHistory') updates.dataHistory.push({ time: new Date(x.timestamp).toISOString(), title: x.title, url: x.url, count: x.itemCount, data: x.data });
            else updates.aisHistory.push(x);
          });
          chrome.storage.local.set(updates, function() {
            closeModal();
            showHistoryPanel();
          });
        } else if (action === 'load') {
          var record = history[idx];
          closeModal();
          loadHistoryRecord(record);
        }
      });
    });
  });
}

function loadHistoryRecord(record) {
  if (record && record.type === 'images') {
    setStatus('已打开图片快采页签（' + (record.itemCount || 0) + ' 张图片）');
    try { window.dispatchEvent(new CustomEvent('ui:open')); } catch (e) {}
    return;
  }
  if (!record) return;
  if (record.type === 'detail' && record.data) {
    AIS.detailData = record.data;
    var s = window.__detailCollector;
    if (s) {
      var flatData = s.exportFlatData({ data: record.data });
      AIS.data = [flatData];
      AIS.totalCollected = 1;
    }
    showDone(true);
    setStatus('已加载历史记录: ' + (record.title || ''));
  } else if (record.type === 'batch' && record.data) {
    // 批量采集历史：复用 showBatchResult
    var results = record.data;
    var successCount = results.filter(function(r) { return r.data; }).length;
    var failCount = results.length - successCount;
    showBatchResult(successCount, failCount, results.length, results);
    setStatus('已加载批量采集记录: ' + successCount + ' 件商品');
  } else if (record.data) {
    // 列表采集历史
    AIS.data = record.data;
    AIS.totalCollected = record.data.length;
    AIS.fields = record.fields || [];
    showDone(false);
    setStatus('已加载历史记录: ' + record.data.length + ' 条数据');
  }
}

// ========== 采集模板功能 ==========
// Original paid cloud storage is not provisioned in this local distribution.

// ========== 意见反馈 / Bug 反馈 ==========
function showFeedbackPanel() {
  var existing = __AIS_DOC().querySelector('.ais-modal-mask');
  if (existing) existing.remove();
  var manifestVersion = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest) ? (chrome.runtime.getManifest().version || '') : '';
  var html = '<div class="ais-modal-mask"><div class="ais-modal ais-modal-feedback">' +
    '<div class="ais-modal-hero">' +
      '<div class="ais-modal-hero-content">' +
        '<div class="ais-modal-hero-icon">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>' +
        '</div>' +
        '<div class="ais-modal-hero-text">' +
          '<div class="ais-modal-hero-title">意见反馈</div>' +
          '<div class="ais-modal-hero-sub">Bug 反馈 · 功能建议 · 其他</div>' +
        '</div>' +
        '<button class="ais-modal-hero-close" aria-label="关闭"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>' +
      '</div>' +
    '</div>' +
    '<div class="ais-modal-body">' +
      '<div class="ais-fb-field"><label>反馈类型</label>' +
        '<select id="ais-fb-type"><option value="bug">🐞 Bug 反馈</option><option value="feature">💡 功能建议</option><option value="other">📝 其他</option></select>' +
      '</div>' +
      '<div class="ais-fb-field"><label>标题（必填，不少于 2 个字）</label>' +
        '<input id="ais-fb-title" maxlength="80" placeholder="一句话描述问题或建议">' +
      '</div>' +
      '<div class="ais-fb-field"><label>详细描述（必填）</label>' +
        '<textarea id="ais-fb-desc" rows="4" maxlength="2000" placeholder="操作步骤 / 期望结果 / 实际结果"></textarea>' +
      '</div>' +
      '<div class="ais-fb-field"><label>联系方式（选填）</label>' +
        '<input id="ais-fb-contact" maxlength="80" placeholder="邮箱 / QQ / 微信，方便我们回复你">' +
      '</div>' +
      '<div class="ais-fb-hint">将附带：扩展 v' + escapeHtml(manifestVersion) + ' · 当前页面 URL · 浏览器环境</div>' +
      '<div class="ais-fb-actions">' +
        '<button type="button" class="ais-btn ais-btn-ghost" id="ais-fb-cancel">取消</button>' +
        '<button type="button" class="ais-btn ais-btn-primary" id="ais-fb-submit">提交反馈</button>' +
      '</div>' +
    '</div></div></div>';
  var mask = document.createElement('div');
  mask.innerHTML = html.trim();
  var root = mask.firstElementChild;
  (aisPanelViewHost() || __AIS_DOC()).appendChild(root);
  bindModalClose(root);
  var q = function(id) { return root.querySelector('#' + id); };
  var cancelBtn = q('ais-fb-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', function() { root.remove(); });
  var submitBtn = q('ais-fb-submit');
  if (submitBtn) submitBtn.addEventListener('click', function() {
    var type = (q('ais-fb-type') && q('ais-fb-type').value) || 'other';
    var title = (q('ais-fb-title') && q('ais-fb-title').value || '').trim();
    var desc = (q('ais-fb-desc') && q('ais-fb-desc').value || '').trim();
    var contact = (q('ais-fb-contact') && q('ais-fb-contact').value || '').trim();
    if (title.length < 2) { aisToast('请填写至少 2 个字的标题', 'warn'); return; }
    if (!desc) { aisToast('请填写详细描述', 'warn'); return; }
    var btn = q('ais-fb-submit');
    btn.disabled = true; btn.textContent = '提交中...';
    var feedbackApi = (window.AIS_CONFIG && AIS_CONFIG.feedbackApi) || 'https://www.facailo.xyz/api/feedback';
    var payload = {
      type: type, title: title, description: desc, contact: contact,
      url: (typeof location !== 'undefined' && location.href ? location.href : '').substring(0, 2000),
      version: manifestVersion,
      platform: /taobao\.com|tmall\.com/.test(location.href) ? 'taobao' : (/jd\.com/.test(location.href) ? 'jd' : (/pinduoduo\.com|yangkeduo\.com/.test(location.href) ? 'pdd' : 'other')),
      ts: Date.now()
    };
    chrome.runtime.sendMessage({ action: 'submitFeedback', url: feedbackApi, payload: payload }, function(resp) {
      btn.disabled = false; btn.textContent = '提交反馈';
      if (resp && resp.success) { aisToast('已收到你的反馈，感谢支持！', 'ok'); root.remove(); }
      else { aisAlert('提交失败：' + ((resp && resp.error) || '未知错误') + '\n\n若服务器未部署反馈接口，请参考说明部署 server/feedback-server.js（见 server/ 目录）。', { type: 'error' }); }
    });
  });
}

// v1.1.70：功能说明弹窗（免费/会员功能对照 + 购买/激活入口）
function showMemberInfoModal() { LicenseModal.show(); }
function showCloudDataPanel() {
  aisAlert('原作者云存储与云分析由独立服务器提供，本地版未接入这些服务。请使用采集历史、文件导出和本地评论分析保存及处理数据。', { type: 'info' });
}


function showMonitorPanel() {
  var existing = __AIS_DOC().querySelector('.ais-modal-mask');
  if (existing) existing.remove();

  chrome.storage.local.get(['monitorTasks'], function(r) {
    var tasks = r.monitorTasks || [];
    var isDetail = isDetailPageUrl();
    var currentUrl = window.location.href;

    // 构建任务卡片
    function buildTaskCard(t) {
      var intervalText = formatIntervalText(t.interval);
      var fieldText = { price: '价格', stock: '库存', title: '标题' }[t.targetField] || '价格';
      var lastValueText = t.lastValue ? escapeHtml(t.lastValue) : '—';
      var lastCheckText = t.lastCheckAt ? formatRelativeTime(t.lastCheckAt) : '从未检查';
      var statusClass = t.enabled ? 'ais-mon-on' : 'ais-mon-off';
      var statusText = t.enabled ? '运行中' : '已暂停';
      var platformIcon = '';
      try {
        var host = new URL(t.url).hostname;
        if (/taobao|tmall/.test(host)) platformIcon = '淘';
        else if (/jd\.com/.test(host)) platformIcon = '京';
        else if (/pinduoduo|pdd/.test(host)) platformIcon = '拼';
        else if (/1688/.test(host)) platformIcon = '1688';
        else platformIcon = '商';
      } catch(e) { platformIcon = '商'; }

      return '<div class="ais-mon-task" data-id="' + t.id + '">' +
        '<div class="ais-mon-task-top">' +
          '<div class="ais-mon-task-logo">' + platformIcon + '</div>' +
          '<div class="ais-mon-task-info">' +
            '<div class="ais-mon-task-name">' + escapeHtml(t.name || '未命名') + '</div>' +
            '<div class="ais-mon-task-meta">' +
              '<span class="ais-mon-tag">' + intervalText + '</span>' +
              '<span class="ais-mon-tag ais-mon-tag-field">' + fieldText + '</span>' +
            '</div>' +
          '</div>' +
          '<span class="ais-mon-status ' + statusClass + '"><span class="ais-mon-status-dot"></span>' + statusText + '</span>' +
        '</div>' +
        '<div class="ais-mon-task-body">' +
          '<div class="ais-mon-task-value">' +
            '<span class="ais-mon-task-value-label">当前' + fieldText + '</span>' +
            '<span class="ais-mon-task-value-num' + (t.lastValue ? '' : ' ais-mon-task-value-empty') + '">' + lastValueText + '</span>' +
          '</div>' +
          '<div class="ais-mon-task-time">' + lastCheckText + '</div>' +
        '</div>' +
        // P1-2 价格历史趋势摘要：历史低/高 + 最近涨跌
        ((t.minValue != null || t.maxValue != null) ?
          '<div class="ais-mon-task-trend" style="display:flex;gap:8px;padding:4px 12px;font-size:11px;margin-top:-6px;">' +
            (t.minValue != null ? '<span style="color:#16a34a;">▼低 ' + escapeHtml(String(t.minValue)) + '</span>' : '') +
            (t.maxValue != null ? '<span style="color:#dc2626;">▲高 ' + escapeHtml(String(t.maxValue)) + '</span>' : '') +
            (t.lastTrend ? '<span style="color:#64748b;">' + escapeHtml(t.lastTrend) + '</span>' : '') +
          '</div>' : '') +
        '<div class="ais-mon-task-actions">' +
          '<button type="button" class="ais-mon-act ais-mon-act-toggle' + (t.enabled ? '' : ' ais-mon-act-resume') + '" data-action="toggle">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' + (t.enabled ? '<rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/>' : '<polygon points="5 3 19 12 5 21 5 3"/>') + '</svg>' +
            (t.enabled ? '暂停' : '启动') +
          '</button>' +
          '<button type="button" class="ais-mon-act" data-action="history">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 17 9 11 13 15 21 7"/></svg>' +
            '历史' +
          '</button>' +
          '<button type="button" class="ais-mon-act ais-mon-act-del" data-action="delete">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-2 14a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2L5 6"/></svg>' +
            '删除' +
          '</button>' +
        '</div>' +
      '</div>';
    }

    var html =
      '<div class="ais-modal-mask" id="ais-mon-mask">' +
        '<div class="ais-modal ais-modal-monitor">' +
          '<div class="ais-modal-head">' +
            '<span class="ais-modal-head-title">监控任务</span>' +
            '<span class="ais-mon-badge">' + tasks.length + '</span>' +
            '<button class="ais-modal-hero-close" aria-label="关闭">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button>' +
          '</div>' +
          '<div class="ais-modal-body">' +


          // 新建任务区
          '<div class="ais-mon-create">' +
            '<div class="ais-mon-create-title">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
              '新建监控任务' +
            '</div>' +
            '<div class="ais-mon-field">' +
              '<label>商品名称</label>' +
              '<input type="text" id="ais-monitor-name" placeholder="详情页自动填入，也可手动修改" maxlength="30">' +
            '</div>' +
            '<div class="ais-mon-field">' +
              '<label>商品详情页 URL</label>' +
              '<input type="text" id="ais-monitor-url" placeholder="https://item.jd.com/..." value="' + (isDetail ? escapeHtml(currentUrl) : '') + '">' +
            '</div>' +
            '<div class="ais-mon-field-row">' +
              '<div class="ais-mon-field">' +
                '<label>检查频率</label>' +
                '<select id="ais-monitor-interval">' +
                  '<option value="60">每小时</option>' +
                  '<option value="180">每3小时</option>' +
                  '<option value="360" selected>每6小时</option>' +
                  '<option value="720">每12小时</option>' +
                  '<option value="1440">每天</option>' +
                  '<option value="custom">自定义…</option>' +
                '</select>' +
              '</div>' +
              '<div class="ais-mon-field">' +
                '<label>监控字段</label>' +
                '<div style="height:34px;display:flex;align-items:center;padding:0 10px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;font-size:12px;color:#334155;">💰 价格（价格监控）</div>' +
              '</div>' +
            '</div>' +
            '<div class="ais-mon-field ais-mon-field-custom" id="ais-mon-custom-row" style="display:none;">' +
              '<label>自定义间隔</label>' +
              '<div class="ais-mon-custom-input">' +
                '<input type="number" id="ais-monitor-custom-val" min="1" max="10080" value="30" placeholder="1-10080">' +
                '<select id="ais-monitor-custom-unit">' +
                  '<option value="1">分钟</option>' +
                  '<option value="60">小时</option>' +
                  '<option value="1440">天</option>' +
                '</select>' +
                '<span class="ais-mon-custom-hint">最小1分钟，最大7天</span>' +
              '</div>' +
            '</div>' +
            '<label class="ais-mon-notify">' +
              '<input type="checkbox" id="ais-monitor-notify" checked>' +
              '<span class="ais-mon-notify-switch"></span>' +
              '<span class="ais-mon-notify-label">价格变动时通知</span>' +
            '</label>' +

            // 通知方式配置
            '<div class="ais-mon-notify-channels" id="ais-mon-notify-channels">' +
              '<div class="ais-mon-notify-channels-title">通知方式</div>' +
              '<label class="ais-mon-chk-row">' +
                '<input type="checkbox" class="ais-mon-channel" value="browser" checked>' +
                '<span>浏览器通知</span>' +
                '<small>右下角弹窗</small>' +
              '</label>' +
              '<label class="ais-mon-chk-row">' +
                '<input type="checkbox" class="ais-mon-channel" value="sound" checked>' +
                '<span>声音提醒</span>' +
                '<small>播放提示音</small>' +
              '</label>' +
              '<label class="ais-mon-chk-row">' +
                '<input type="checkbox" class="ais-mon-channel" value="webhook">' +
                '<span>Webhook推送</span>' +
                '<small>飞书/钉钉/企业微信</small>' +
              '</label>' +
              '<div class="ais-mon-webhook-config" id="ais-mon-webhook-config" style="display:none;">' +
                '<div class="ais-mon-field">' +
                  '<label>Webhook 类型</label>' +
                  '<select id="ais-monitor-webhook-type">' +
                    '<option value="feishu">飞书</option>' +
                    '<option value="dingtalk">钉钉</option>' +
                    '<option value="wechat">企业微信</option>' +
                    '<option value="custom">自定义</option>' +
                  '</select>' +
                '</div>' +
                '<div class="ais-mon-field">' +
                  '<label>Webhook URL</label>' +
                  '<input type="text" id="ais-monitor-webhook-url" placeholder="https://open.feishu.cn/open-apis/bot/v2/hook/xxx">' +
                '</div>' +
                '<button type="button" class="ais-mon-test-btn" id="ais-monitor-test-webhook">测试推送</button>' +
              '</div>' +
            '</div>' +
            '<button type="button" class="ais-mon-create-btn" id="ais-monitor-create-btn">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>' +
              '创建监控任务' +
            '</button>' +
          '</div>' +

          // 任务列表区
          '<div class="ais-mon-list-section">' ;

    if (tasks.length === 0) {
      html += '<div class="ais-mon-empty">' +
        '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>' +
        '<div class="ais-mon-empty-text">暂无监控任务</div>' +
        '<div class="ais-mon-empty-hint">在上方创建你的第一个监控任务</div>' +
      '</div>';
    } else {
      html += '<div class="ais-mon-list">';
      tasks.forEach(function(t) { html += buildTaskCard(t); });
      html += '</div>';
    }

    html += '</div>'; // list-section
    html += '</div>'; // modal-body
    html += '</div></div>'; // modal, mask

    var modalEl = document.createElement('div');
    modalEl.innerHTML = html;
    var mask = modalEl.firstElementChild;
    (aisPanelViewHost() || __AIS_DOC()).appendChild(mask);

    var closeModal = bindModalClose(mask);

    // v1.1.113：商品名称自动抓取填入（详情页打开监控时预填，免手输）
    if (isDetail) {
      try {
        var autoRaw = '';
        var og = document.querySelector('meta[property="og:title"], meta[name="og:title"]');
        var _mHost = location.hostname;
        var _mSel = null;
        if (/jd\.com$/.test(_mHost)) _mSel = document.querySelector('.itemInfo .sku-name, .product-intro .sku-name, [class*=sku-name]');
        else if (/taobao\.com$|tmall\.com$/.test(_mHost)) _mSel = document.querySelector('[class*=ItemHeader--title], .tb-detail-hd h1, [class*=mainTitle]');
        else if (/1688\.com$/.test(_mHost)) _mSel = document.querySelector('[class*="offer-title"], .title-text, .mod-detail-title h1, h1[class*="title"]');
        autoRaw = ((_mSel && _mSel.textContent) || (og && og.content) || '').trim() || document.title;
        autoRaw = String(autoRaw).replace(/\s*[-_|–—][^-_|–—]*$/, '').replace(/\s+/g, ' ').trim();
        var _mName = mask.querySelector('#ais-monitor-name');
        if (_mName && !_mName.value && autoRaw) _mName.value = autoRaw.substring(0, 30);
      } catch (eAutoName) {}
    }

    // 频率下拉框切换：选中"自定义"时显示自定义输入行
    var intervalSel = mask.querySelector('#ais-monitor-interval');
    var customRow = mask.querySelector('#ais-mon-custom-row');
    if (intervalSel && customRow) {
      intervalSel.addEventListener('change', function() {
        customRow.style.display = (this.value === 'custom') ? '' : 'none';
      });
    }

    // Webhook checkbox 联动：勾选时显示配置区
    var webhookChk = mask.querySelector('.ais-mon-channel[value="webhook"]');
    var webhookConfig = mask.querySelector('#ais-mon-webhook-config');
    if (webhookChk && webhookConfig) {
      webhookChk.addEventListener('change', function() {
        webhookConfig.style.display = this.checked ? '' : 'none';
      });
    }

    // 测试 Webhook 推送
    var testBtn = mask.querySelector('#ais-monitor-test-webhook');
    if (testBtn) {
      testBtn.addEventListener('click', function() {
        var wType = mask.querySelector('#ais-monitor-webhook-type').value;
        var wUrl = (mask.querySelector('#ais-monitor-webhook-url').value || '').trim();
        if (!wUrl) { aisToast('请先填写 Webhook URL', 'warn'); return; }
        testBtn.disabled = true;
        testBtn.textContent = '推送中...';
        chrome.runtime.sendMessage({
          action: 'testMonitorWebhook',
          webhookType: wType,
          webhookUrl: wUrl
        }, function(resp) {
          testBtn.disabled = false;
          testBtn.textContent = '测试推送';
          if (resp && resp.success) {
            aisToast('测试消息已发送，请检查你的群消息', 'ok');
          } else {
            aisToast('推送失败：' + (resp && resp.error ? resp.error : '未知错误'), 'error');
          }
        });
      });
    }

    // 创建任务
    mask.querySelector('#ais-monitor-create-btn').addEventListener('click', async function() {
      var allowed = await requirePaidFeature('monitor', '定时监控');
      if (!allowed) return;

      var name = (mask.querySelector('#ais-monitor-name').value || '').trim();
      var url = (mask.querySelector('#ais-monitor-url').value || '').trim();
      var intervalRaw = mask.querySelector('#ais-monitor-interval').value;
      var field = 'price'; // v1.1.113 监控改为价格监控（固定价格字段；旧库存/标题任务仍按原字段运行）
      var notify = mask.querySelector('#ais-monitor-notify').checked;

      // 解析间隔（分钟）
      var interval;
      if (intervalRaw === 'custom') {
        var customVal = parseInt(mask.querySelector('#ais-monitor-custom-val').value) || 0;
        var customUnit = parseInt(mask.querySelector('#ais-monitor-custom-unit').value) || 1;
        interval = customVal * customUnit;
        if (interval < 1) { aisToast('自定义间隔不能小于1分钟', 'warn'); return; }
        if (interval > 10080) { aisToast('自定义间隔不能超过7天（10080分钟）', 'warn'); return; }
      } else {
        interval = parseInt(intervalRaw) || 360;
      }

      // 收集通知方式
      var notifyChannels = [];
      mask.querySelectorAll('.ais-mon-channel:checked').forEach(function(cb) { notifyChannels.push(cb.value); });
      var webhookType = mask.querySelector('#ais-monitor-webhook-type').value;
      var webhookUrl = (mask.querySelector('#ais-monitor-webhook-url').value || '').trim();
      if (notifyChannels.indexOf('webhook') >= 0 && !webhookUrl) {
        aisToast('已选择Webhook推送，请填写Webhook URL', 'warn');
        return;
      }

      if (!url) { aisToast('请填写商品详情页URL', 'warn'); return; }
      if (!/^https?:\/\//.test(url)) { aisToast('URL格式不正确', 'warn'); return; }
      if (!name) name = url.substring(url.lastIndexOf('/') + 1, 40) || '监控任务';

      var task = {
        id: 'monitor_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        name: name,
        url: url,
        interval: interval,
        targetField: field,
        notifyOnChange: notify,
        notifyChannels: notifyChannels,
        webhookType: webhookType,
        webhookUrl: webhookUrl,
        lastValue: '',
        lastCheckAt: 0,
        enabled: true,
        history: [],
        createdAt: Date.now()
      };

      chrome.storage.local.get(['monitorTasks'], async function(rr) {
        var list = rr.monitorTasks || [];
        if (list.length >= 20) { aisToast('监控任务最多20个，请先删除旧任务', 'warn'); return; }
        list.push(task);
        chrome.storage.local.set({ monitorTasks: list }, function() {
          chrome.runtime.sendMessage({ action: 'scheduleMonitorTask', task: task }, function() {
            closeModal();
            showMonitorPanel();
            setStatus('监控任务已创建: ' + name);
          });
        });
      });
    });

    // 任务操作
    var actionBtns = mask.querySelectorAll('.ais-mon-task-actions button');
    actionBtns.forEach(function(btn) {
      btn.addEventListener('click', async function() {
        var item = btn.closest('.ais-mon-task');
        var taskId = item.dataset.id;
        var action = btn.dataset.action;

        chrome.storage.local.get(['monitorTasks'], async function(rr) {
          var list = rr.monitorTasks || [];
          var idx = list.findIndex(function(t) { return t.id === taskId; });
          if (idx < 0) return;
          var task = list[idx];

          if (action === 'toggle') {
            task.enabled = !task.enabled;
            chrome.runtime.sendMessage({
              action: task.enabled ? 'scheduleMonitorTask' : 'cancelMonitorTask',
              task: task
            });
            chrome.storage.local.set({ monitorTasks: list }, function() {
              closeModal();
              showMonitorPanel();
            });
          } else if (action === 'delete') {
            if (!(await aisConfirm('确认删除监控任务「' + (task.name || '') + '」？', { okText: '删除' }))) return;
            chrome.runtime.sendMessage({ action: 'cancelMonitorTask', task: task });
            list.splice(idx, 1);
            chrome.storage.local.set({ monitorTasks: list }, function() {
              closeModal();
              showMonitorPanel();
            });
          } else if (action === 'history') {
            showMonitorHistory(task);
          }
        });
      });
    });
  });
}

// 相对时间格式化
function formatRelativeTime(ts) {
  if (!ts) return '从未';
  var diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
  return new Date(ts).toLocaleDateString('zh-CN');
}

// 间隔（分钟）转可读文本
function formatIntervalText(minutes) {
  if (!minutes || minutes < 1) return '每6小时';
  if (minutes < 60) return '每' + minutes + '分钟';
  if (minutes % 1440 === 0) return '每' + (minutes / 1440) + '天';
  if (minutes % 60 === 0) return '每' + (minutes / 60) + '小时';
  // 混合：小时+分钟
  var h = Math.floor(minutes / 60);
  var m = minutes % 60;
  return h > 0 ? '每' + h + '小时' + (m > 0 ? m + '分' : '') : '每' + m + '分钟';
}

// 监控历史弹窗（时间线式）
function showMonitorHistory(task) {
  var history = task.history || [];
  var fieldText = { price: '价格', stock: '库存', title: '标题' }[task.targetField] || '价格';

  var html =
    '<div class="ais-modal-mask">' +
      '<div class="ais-modal ais-modal-monitor">' +
        '<div class="ais-modal-hero ais-hero-purple">' +
          '<div class="ais-modal-hero-bg"></div>' +
          '<div class="ais-modal-hero-content">' +
            '<div class="ais-modal-hero-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"/><polyline points="14 7 21 7 21 14"/></svg>' +
            '</div>' +
            '<div class="ais-modal-hero-text">' +
              '<div class="ais-modal-hero-title">监控历史</div>' +
              '<div class="ais-modal-hero-sub">' + escapeHtml(task.name || '未命名') + ' · ' + fieldText + '</div>' +
            '</div>' +
            '<button class="ais-modal-hero-close" aria-label="关闭">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
            '</button>' +
          '</div>' +
        '</div>' +
        '<div class="ais-modal-body">' +

        '<div class="ais-mon-hist-header">' +
          '<div class="ais-mon-hist-name">' + escapeHtml(task.name || '未命名') + '</div>' +
          '<div class="ais-mon-hist-field">监控字段：' + fieldText + '</div>' +
        '</div>';

  if (history.length === 0) {
    html += '<div class="ais-mon-empty">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="3 17 9 11 13 15 21 7"/></svg>' +
      '<div class="ais-mon-empty-text">暂无采集记录</div>' +
      '<div class="ais-mon-empty-hint">等待定时任务首次执行</div>' +
    '</div>';
  } else {
    html += '<div class="ais-mon-timeline">';
    history.slice().reverse().forEach(function(h, idx) {
      var isLatest = (idx === 0);
      var changed = h.changed === true;
      var trendClass = 'ais-mon-trend-flat';
      var trendIcon = '➖';
      var trendText = '持平';
      if (h.prevValue && h.value !== h.prevValue) {
        // 数值比较
        var prevNum = parseFloat(String(h.prevValue).replace(/[^\d.]/g, ''));
        var curNum = parseFloat(String(h.value).replace(/[^\d.]/g, ''));
        if (!isNaN(prevNum) && !isNaN(curNum)) {
          if (curNum > prevNum) { trendClass = 'ais-mon-trend-up'; trendIcon = '📈'; trendText = '上涨 +' + (curNum - prevNum).toFixed(2); }
          else { trendClass = 'ais-mon-trend-down'; trendIcon = '📉'; trendText = '下降 -' + (prevNum - curNum).toFixed(2); }
        } else {
          trendClass = 'ais-mon-trend-change'; trendIcon = '🔄'; trendText = '变动';
        }
      }
      var timeStr = new Date(h.checkedAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

      html += '<div class="ais-mon-tl-item' + (isLatest ? ' ais-mon-tl-latest' : '') + '">' +
        '<div class="ais-mon-tl-dot ' + trendClass + '"></div>' +
        '<div class="ais-mon-tl-content">' +
          '<div class="ais-mon-tl-time">' + timeStr + (isLatest ? '<span class="ais-mon-tl-badge">最新</span>' : '') + '</div>' +
          '<div class="ais-mon-tl-value">' +
            '<span class="ais-mon-tl-num ' + trendClass + '">' + escapeHtml(h.value || '无数据') + '</span>' +
            (changed ? '<span class="ais-mon-tl-trend ' + trendClass + '">' + trendIcon + ' ' + trendText + '</span>' : '') +
          '</div>' +
          (h.prevValue ? '<div class="ais-mon-tl-prev">上次：' + escapeHtml(h.prevValue) + '</div>' : '') +
        '</div>' +
      '</div>';
    });
    html += '</div>';
  }

  html += '</div></div></div>';
  var modalEl = document.createElement('div');
  modalEl.innerHTML = html;
  var mask = modalEl.firstElementChild;
  (aisPanelViewHost() || __AIS_DOC()).appendChild(mask);
  bindModalClose(mask);
}

// 判断当前是否详情页URL
function isDetailPageUrl() {
  var u = window.location.href;
  return /item\.(taobao|tmall|jd)\.com|detail\.(tmall|1688)\.com|goods\.html/.test(u);
}

// ========== 数据库/BI 导出功能 ==========
// 支持 Webhook (POST JSON) 与 SQL 导出

function showBIExportModal() {
  // 数据库/BI导出为专业版功能
  requirePaidFeature('bi_export', '数据库/BI导出').then(function(allowed) {
    if (!allowed) return;
    _showBIExportModalInner();
  });
}

function _showBIExportModalInner() {
  chrome.storage.local.get(['lastData', 'lastFields', 'detailData', 'isDetailPage', 'platform', 'ais_bi_config'], function(r) {
    var hasListData = r.lastData && r.lastFields && r.lastData.length > 0;
    var hasDetailData = r.isDetailPage && r.detailData;
    if (!hasListData && !hasDetailData) {
      aisToast('无数据可导出，请先采集数据', 'warn');
      return;
    }

    var cfg = r.ais_bi_config || { webhookUrl: '', sqlTable: 'products', mode: 'webhook' };
    var dataCount = hasListData ? r.lastData.length : (r.detailData ? 1 : 0);

    var old = __AIS_DOC().getElementById('ais-bi-mask');
    if (old) old.remove();

    var html =
      '<div class="ais-modal-mask" id="ais-bi-mask">' +
        '<div class="ais-modal ais-modal-bi">' +
          '<div class="ais-modal-hero ais-hero-indigo">' +
            '<div class="ais-modal-hero-bg"></div>' +
            '<div class="ais-modal-hero-content">' +
              '<div class="ais-modal-hero-icon">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/></svg>' +
              '</div>' +
              '<div class="ais-modal-hero-text">' +
                '<div class="ais-modal-hero-title">数据库 / BI 导出</div>' +
                '<div class="ais-modal-hero-sub">Webhook 推送 · SQL 导出 · ' + dataCount + ' 条数据</div>' +
              '</div>' +
              '<button class="ais-modal-hero-close" aria-label="关闭">' +
                '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
              '</button>' +
            '</div>' +
          '<div class="ais-modal-body">' +
            '<div class="ais-bi-info">本次将导出 <strong>' + dataCount + '</strong> 条数据（来源：' + escapeHtml(r.platform || '未知') + '）</div>' +

            '<div class="ais-bi-tabs">' +
              '<button class="ais-bi-tab active" data-bi-tab="webhook">Webhook / API</button>' +
              '<button class="ais-bi-tab" data-bi-tab="sql">SQL 导出</button>' +
            '</div>' +

            // Webhook 面板
            '<div class="ais-bi-panel active" data-bi-panel="webhook">' +
              '<div class="ais-bi-field">' +
                '<label>Webhook / API 地址</label>' +
                '<input type="text" id="ais-bi-webhook-url" placeholder="https://your-api.com/ingest 或 Power BI 流数据集 URL" value="' + escapeHtml(cfg.webhookUrl || '') + '">' +
                '<small>将采集数据以 JSON 数组 POST 到该地址，适用于自建 API、n8n、Zapier、Power BI 流数据集等</small>' +
              '</div>' +
              '<div class="ais-bi-field">' +
                '<label>认证 Token（可选）</label>' +
                '<input type="text" id="ais-bi-webhook-token" placeholder="Bearer token 或 API Key" value="' + escapeHtml(cfg.webhookToken || '') + '">' +
                '<small>若填写，将以 Authorization: Bearer &lt;token&gt; 头部发送</small>' +
              '</div>' +
              '<button id="ais-bi-webhook-send" class="ais-btn ais-btn-primary ais-btn-block">发送到 Webhook</button>' +
              '<div id="ais-bi-webhook-result" class="ais-bi-result"></div>' +
            '</div>' +

            // SQL 面板
            '<div class="ais-bi-panel" data-bi-panel="sql">' +
              '<div class="ais-bi-field">' +
                '<label>表名</label>' +
                '<input type="text" id="ais-bi-sql-table" placeholder="products" value="' + escapeHtml(cfg.sqlTable || 'products') + '">' +
                '<small>生成的 INSERT 语句将写入此表</small>' +
              '</div>' +
              '<div class="ais-bi-field">' +
                '<label>SQL 方言</label>' +
                '<select id="ais-bi-sql-dialect">' +
                  '<option value="mysql"' + (cfg.sqlDialect === 'mysql' ? ' selected' : '') + '>MySQL</option>' +
                  '<option value="postgres"' + (cfg.sqlDialect === 'postgres' ? ' selected' : '') + '>PostgreSQL</option>' +
                  '<option value="sqlite"' + (cfg.sqlDialect === 'sqlite' ? ' selected' : '') + '>SQLite</option>' +
                '</select>' +
              '</div>' +
              '<div class="ais-bi-sql-actions">' +
                '<button id="ais-bi-sql-preview" class="ais-btn ais-btn-ghost ais-btn-sm">预览 SQL</button>' +
                '<button id="ais-bi-sql-download" class="ais-btn ais-btn-primary ais-btn-sm">下载 .sql 文件</button>' +
                '<button id="ais-bi-sql-copy" class="ais-btn ais-btn-ghost ais-btn-sm">复制 SQL</button>' +
              '</div>' +
              '<pre id="ais-bi-sql-preview-box" class="ais-bi-sql-preview"></pre>' +
            '</div>' +

            '<div class="ais-bi-tip">💡 Webhook 适合实时推送数据到 BI 看板或数据库；SQL 适合离线导入到 MySQL/PostgreSQL/SQLite。</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var modalEl = document.createElement('div');
    modalEl.innerHTML = html;
    var mask = modalEl.firstElementChild;
    (aisPanelViewHost() || __AIS_DOC()).appendChild(mask);

    bindModalClose(mask);

    // Tab 切换
    var tabs = mask.querySelectorAll('.ais-bi-tab');
    tabs.forEach(function(tab) {
      tab.addEventListener('click', function() {
        tabs.forEach(function(t) { t.classList.remove('active'); });
        tab.classList.add('active');
        mask.querySelectorAll('.ais-bi-panel').forEach(function(p) { p.classList.remove('active'); });
        var target = mask.querySelector('.ais-bi-panel[data-bi-panel="' + tab.dataset.biTab + '"]');
        if (target) target.classList.add('active');
      });
    });

    // 保存配置辅助
    function saveBiConfig(patch) {
      chrome.storage.local.get(['ais_bi_config'], function(rr) {
        var merged = Object.assign({}, rr.ais_bi_config || {}, patch);
        chrome.storage.local.set({ ais_bi_config: merged });
      });
    }

    // 获取归一化数据（列表/详情）
    function getExportRows() {
      if (hasListData) {
        return { rows: r.lastData, fields: r.lastFields, type: 'list' };
      }
      // 详情页：扁平化
      var d = r.detailData;
      var row = Object.assign({}, d.basic || {}, { itemId: d.itemId, platform: d.platform });
      if (d.skus && d.skus.length) row.skus = JSON.stringify(d.skus);
      if (d.reviews && d.reviews.length) row.reviews = JSON.stringify(d.reviews.slice(0, 50));
      return { rows: [row], fields: Object.keys(row), type: 'detail' };
    }

    // Webhook 发送
    var sendBtn = mask.querySelector('#ais-bi-webhook-send');
    if (sendBtn) {
      sendBtn.addEventListener('click', function() {
        var url = (mask.querySelector('#ais-bi-webhook-url').value || '').trim();
        var token = (mask.querySelector('#ais-bi-webhook-token').value || '').trim();
        var resultBox = mask.querySelector('#ais-bi-webhook-result');
        if (!url) { resultBox.innerHTML = '<span class="ais-bi-err">请填写 Webhook 地址</span>'; return; }

        saveBiConfig({ webhookUrl: url, webhookToken: token });
        var exp = getExportRows();
        var payload = { source: 'ai-scraper', platform: r.platform, exportType: exp.type, exportedAt: new Date().toISOString(), count: exp.rows.length, data: exp.rows };

        sendBtn.disabled = true;
        sendBtn.textContent = '发送中...';
        resultBox.innerHTML = '<span class="ais-bi-loading">正在发送 ' + exp.rows.length + ' 条数据...</span>';

        var headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(payload) })
          .then(function(resp) {
            if (resp.ok) {
              resultBox.innerHTML = '<span class="ais-bi-ok">✓ 发送成功（' + exp.rows.length + ' 条，HTTP ' + resp.status + '）</span>';
            } else {
              return resp.text().then(function(t) {
                throw new Error('HTTP ' + resp.status + ': ' + t.substring(0, 200));
              });
            }
          })
          .catch(function(err) {
            resultBox.innerHTML = '<span class="ais-bi-err">✗ 发送失败：' + escapeHtml(err.message) + '<br><small>提示：若遇 CORS 错误，目标服务需允许跨域，或通过中间代理转发</small></span>';
          })
          .finally(function() {
            sendBtn.disabled = false;
            sendBtn.textContent = '发送到 Webhook';
          });
      });
    }

    // SQL 生成
    function generateSQL() {
      var table = (mask.querySelector('#ais-bi-sql-table').value || 'products').trim().replace(/[^a-zA-Z0-9_]/g, '') || 'products';
      var dialect = mask.querySelector('#ais-bi-sql-dialect').value || 'mysql';
      saveBiConfig({ sqlTable: table, sqlDialect: dialect });
      var exp = getExportRows();
      var fields = exp.fields;
      var rows = exp.rows;
      var q = dialect === 'mysql' ? '`' : (dialect === 'postgres' ? '"' : '');
      var lines = [];

      // CREATE TABLE
      lines.push('-- 电商采集大师 导出 ' + exp.type + ' 数据');
      lines.push('-- 生成时间: ' + new Date().toLocaleString('zh-CN'));
      lines.push('-- 数据条数: ' + rows.length);
      lines.push('');
      lines.push('CREATE TABLE IF NOT EXISTS ' + q + table + q + ' (');
      var colDefs = fields.map(function(f) {
        var safeName = String(f).replace(/[`"' ]/g, '');
        return '  ' + q + safeName + q + ' TEXT';
      });
      colDefs.push('  ' + q + '_imported_at' + q + ' TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
      lines.push(colDefs.join(',\n'));
      lines.push(');');
      lines.push('');

      // INSERT
      function esc(v) {
        if (v == null) return 'NULL';
        var s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return "'" + s.replace(/'/g, "''") + "'";
      }
      var safeFields = fields.map(function(f) { return String(f).replace(/[`"' ]/g, ''); });
      var colList = safeFields.map(function(f) { return q + f + q; }).join(', ');
      for (var i = 0; i < rows.length; i++) {
        var vals = safeFields.map(function(f) { return esc(rows[i][f]); });
        lines.push('INSERT INTO ' + q + table + q + ' (' + colList + ') VALUES (' + vals.join(', ') + ');');
      }
      return lines.join('\n');
    }

    // SQL 预览
    var previewBtn = mask.querySelector('#ais-bi-sql-preview');
    if (previewBtn) {
      previewBtn.addEventListener('click', function() {
        var sql = generateSQL();
        var box = mask.querySelector('#ais-bi-sql-preview-box');
        box.textContent = sql.substring(0, 3000) + (sql.length > 3000 ? '\n... (已截断，共 ' + sql.length + ' 字符)' : '');
        box.style.display = 'block';
      });
    }

    // SQL 下载
    var dlBtn = mask.querySelector('#ais-bi-sql-download');
    if (dlBtn) {
      dlBtn.addEventListener('click', function() {
        var sql = generateSQL();
        var blob = new Blob([sql], { type: 'text/sql;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'ai-scraper-export-' + new Date().toISOString().slice(0, 10) + '.sql';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    }

    // SQL 复制
    var copySqlBtn = mask.querySelector('#ais-bi-sql-copy');
    if (copySqlBtn) {
      copySqlBtn.addEventListener('click', function() {
        var sql = generateSQL();
        navigator.clipboard.writeText(sql).then(function() {
          copySqlBtn.textContent = '已复制 ✓';
          setTimeout(function() { copySqlBtn.textContent = '复制 SQL'; }, 1500);
        }).catch(function() {
          aisToast('复制失败，请手动预览并复制', 'error');
        });
      });
    }
  });
}

// ===== v1.1.35 侧边栏工作台：rail 导航桥接 =====
// 面板 HTML 由 content.js 异步 fetch 后注入 shadow root，脚本求值时元素可能尚不存在，
// 因此轮询等待 DOM 就绪再绑定（绑定后自停；点击 rail 图标 = 触发首页对应功能卡片）
(function () {
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var d2 = __AIS_DOC();
    var probe = d2.getElementById('ais-home-list');
    if (!probe) { if (tries > 60) clearInterval(timer); return; }
    clearInterval(timer);
    try {
      var railMap = {
        'ais-nav-list': 'ais-home-list',
        'ais-nav-detail': 'ais-home-detail',
        'ais-nav-review': 'ais-home-review',
        'ais-nav-monitor': 'ais-home-monitor',
        'ais-nav-feedback': 'ais-home-feedback'
      };
      Object.keys(railMap).forEach(function (nid) {
        var n = d2.getElementById(nid);
        var c = d2.getElementById(railMap[nid]);
        if (n && c && !n.getAttribute('data-rail-bound')) {
          n.setAttribute('data-rail-bound', '1');
          n.addEventListener('click', function () { c.click(); });
        }
      });
      var navIds = ['ais-nav-list', 'ais-nav-detail', 'ais-nav-review', 'ais-nav-monitor', 'ais-nav-feedback'];
      var syncNav = function () {
        var hv = d2.getElementById('ais-home-view');
        var lv = d2.getElementById('ais-subview-list');
        var dv = d2.getElementById('ais-subview-detail');
        var target = null;
        if (hv && hv.style.display !== 'none') target = null;
        else if (lv && lv.style.display !== 'none') target = 'ais-nav-list';
        else if (dv && dv.style.display !== 'none') target = 'ais-nav-detail';
        navIds.forEach(function (id) {
          var el = d2.getElementById(id);
          if (el) el.classList.toggle('active', el.id === target);
        });
      };
      ['ais-home-view', 'ais-subview-list', 'ais-subview-detail'].forEach(function (id) {
        var el = d2.getElementById(id);
        if (el && typeof MutationObserver !== 'undefined') {
          new MutationObserver(syncNav).observe(el, { attributes: true, attributeFilter: ['style'] });
        }
      });
    } catch (e) {}
  }, 250);
})();






















// ==================== v1.1.41 图片快采+差评分析+高风险评论模块（评论采集模板 + 聚类报告 + 统一弹窗） ====================
var AISIMG = (function () {
  'use strict';

  var state = {
    main: [], sku: [], desc: [], video: '', videos: [], minSize: 0, sortMode: 0, natSize: {},   // v1.2.310：URL 无声明尺寸时的实测 naturalWidth 缓存视频；video 保留为第一个（兼容 35 处旧引用）
    filter: 'all', itemTitle: '', itemId: '', descUrl: '',
    skuRows: [], skuValueImgs: [], revProgTotal: 0, aisIsMember: true, aisFirstUseAt: 0, aisLicenseReady: true, readFinished: false, descFetched: false,
    reading: false, pendingOpen: false, deepRetried: false, lastDownloadId: null, bound: false, autoRevRan: false,
    reviews: [], analysis: null, revTriedSsr: false,     skuPropNames: [], itemProps: [], sizeChart: [], revStop: false, revCollecting: false, revLoop: null,
    wdjList: [], wdjTotal: 0, wdjPages: 0, wdjEndWhy: '', wdjErr: '', wdjAt: 0, wdjFullDone: 0, wdjReqs: 0, wdjBudget: 0
  };
  var TYPE_LABEL = { main: '主图', sku: 'SKU图', desc: '详情图', video: '视频' };
  var DELAYS = [400, 1800, 4000, 7000, 10500];

  function D() { return __AIS_DOC(); }
  function $(id) { return D().getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function uniq(a) { var s = {}, o = []; (a || []).forEach(function (u) { if (u && !s[u]) { s[u] = 1; o.push(u); } }); return o; }
  function abs(u) { u = String(u || ''); if (/^https?:/i.test(u)) return u; if (u.indexOf('//') === 0) return 'https:' + u; return ''; }
  function extOf(u) { var m = String(u || '').match(/\.(jpe?g|png|webp|gif|mp4|mov|webm|bmp)(?:\?|$)/i); var e = m ? m[1].toLowerCase() : 'jpg'; return e === 'jpeg' ? 'jpg' : e; }
  function pad(n) { return String(n).padStart(2, '0'); }
  // v1.2.292 多视频：videos 为真源，video 是它的第一个（兼容既有判断）
  function addVideo(u) {
    try {
      var v = abs(u); if (!v) return false;
      if (!state.videos) state.videos = [];
      if (state.videos.indexOf(v) < 0) state.videos.push(v);
      if (!state.video) state.video = v;
      return true;
    } catch (e) { return false; }
  }
  function videoList() { return (state.videos && state.videos.length) ? state.videos : (state.video ? [state.video] : []); }
  // >>> v1.2.293 图片尺寸筛选（Node 单测抽段）>>>
  // 从 URL 读【声明】的像素尺寸（判不出返回 0 = 未知）。按评论事实「图片不能分类、有点乱」加的再筛选维度。
  function declaredSizeOf(u) {
    var s = String(u || '');
    var m;
    if ((m = /__CR\d+,\d+,(\d+),\d+/.exec(s))) return parseInt(m[1], 10) || 0;            // 亚马逊 __CR<l,t,w,h> 裁切宽
    if ((m = /_AC_SR(\d+),(\d+)/.exec(s))) return parseInt(m[1], 10) || 0;               // 亚马逊 _AC_SR<w,h> 缩略
    if ((m = /_(?:AC_)?S[LX](\d+)/i.exec(s))) return parseInt(m[1], 10) || 0;             // 亚马逊 _AC_SL1500_ / _SX500_
    if ((m = /_(\d{2,4})x(\d{2,4})[a-z0-9]*\.(?:jpe?g|png|webp|gif|avif)/i.exec(s))) {   // 淘宝/天猫 _430x430q90.jpg
      return Math.max(parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0);
    }
    if ((m = /\/s(\d{2,4})x(\d{2,4})[_\/]/i.exec(s))) {                                 // 京东 /s450x450_jfs/
      return Math.max(parseInt(m[1], 10) || 0, parseInt(m[2], 10) || 0);
    }
    if ((m = /[?&](?:w|width)=(\d+)/i.exec(s))) return parseInt(m[1], 10) || 0;
    return 0;
  }
  // 判不出尺寸一律保留（与详情图判据同口径：宁多留不误杀）
  function keepBySize(u, minSize) {
    var min = Number(minSize) || 0;
    if (!min) return true;
    var d = declaredSizeOf(u);
    if (!d) { var sn = (state && state.natSize) ? state.natSize[String(u)] : null; if (sn) return sn >= min; return true; }
    return d >= min;
  }
  // v1.2.310：URL 无声明尺寸（如淘宝 O1CN 原始链）时，用网格实际加载出的 naturalWidth 兜底量测——只在出现新测量值时重排一次
  function scheduleSizeMeasure() {
    try {
      var g = $('aisimg-grid'); if (!g) return;
      clearTimeout(state.__szTimer);
      state.__szTimer = setTimeout(function () {
        var added = 0;
        var imgs = g.querySelectorAll('img');
        for (var i = 0; i < imgs.length && i < 300; i++) {
          var im = imgs[i], u = String(im.src || im.getAttribute('data-src') || '');
          if (!u) continue;
          // v1.2.335：尺寸门槛用【长边】max(宽,高)——详情图是长图，只看宽度会把 750x2000 的详情图当成 750 滤掉（真机京东：详情 24 张全被滤光）
          if (im.naturalWidth || im.naturalHeight) {
            var _le = (Number(aisNum('common.sizeFilterLongEdge', 1)) !== 0)
              ? Math.max(im.naturalWidth || 0, im.naturalHeight || 0)
              : (im.naturalWidth || 0);   // v1.2.337 策略化：长边(默认) / 仅宽度
            var _cur = state.natSize[u];
            if (_cur == null || (_le > _cur && (Number(state.minSize) || 0) && _cur < Number(state.minSize))) { state.natSize[u] = _le; added++; }
          }
        }
        if (added && (Number(state.minSize) || 0)) { try { render(); } catch (eR) {} }
      }, 140);
    } catch (eS) {}
  }
  // <<< v1.2.293 图片尺寸筛选 <<<
  function typeOf(u) { if (videoList().indexOf(u) >= 0) return 'video'; var ks = ['main', 'sku', 'desc']; for (var i = 0; i < ks.length; i++) { if (state[ks[i]].indexOf(u) > -1) return ks[i]; } return 'main'; }
  function sendBg(msg, timeoutMs) {
    // v1.1.108：可选强制超时——worker 无响应（executeScript 挂起/页签导航等）时以 {success:false} 兜底，采集循环永不卡死
    return new Promise(function (res) {
      var done = false;
      var t = timeoutMs ? setTimeout(function () { if (!done) { done = true; res({ success: false, error: '后台请求超时(' + Math.round(timeoutMs / 1000) + 's)' }); } }, timeoutMs) : null;
      try {
        chrome.runtime.sendMessage(msg, function (r) {
          if (done) return; done = true;
          if (t) clearTimeout(t);
          try { void chrome.runtime.lastError; } catch (eLE) {}
          res(r || null);
        });
      } catch (e) { if (t) clearTimeout(t); res({ success: false, error: (e && e.message) || 'sendMessage 异常' }); }
    });
  }
  function sendBgLegacy(msg) { return new Promise(function (res) { try { chrome.runtime.sendMessage(msg, function (r) { void chrome.runtime.lastError; res(r || null); }); } catch (e) { res(null); } }); }
  function storeGet(k) { return new Promise(function (res) { try { chrome.storage.local.get(k, function (o) { res(o && o[k]); }); } catch (e) { res(null); } }); }
  function storeSet(o) { return new Promise(function (res) { try { chrome.storage.local.set(o, function () { res(true); }); } catch (e) { res(false); } }); }
  function unwrap(x) { return (x && x.url && x.data) ? x.data : (x || null); }
  function mergeDesc(list, opt) {
    // v1.2.289：亚马逊详情图只认 A+ 官方载荷（我们自己 hires detailFilter 判据），别的通道（通用 DOM / descUrl）一律不收，避免混入无关图
    if (state.__amzDescLocked) return false;
    // v1.2.352：平台【详情载荷】是权威全量列表，允许其中与主图/SKU 重复的图也进详情组。
    // 真机 1688 实测：offer_details 载荷 7 张里有 4 张与画廊图相同 → 旧逻辑把它们剔除 → 用户看到「详情图只有 3 张/显示不全」。
    // DOM 兜底通道保持旧行为（去重跨组），避免把画廊图误当详情图污染详情组。
    var __allowDup = !!(opt && opt.allowGalleryDup);
    if (!__allowDup) { try { __allowDup = aisFlag('common.descPayloadAllowDup', false); } catch (eAD) {} }
    var f = (list || []).filter(function (u) {
      if (!u) return false;
      if (state.desc.indexOf(u) >= 0) return false;
      if (__allowDup) return true;
      return state.main.indexOf(u) < 0 && state.sku.indexOf(u) < 0;
    });
    if (f.length) { state.desc = uniq(state.desc.concat(f)); return true; }
    return false;
  }
  // v1.2.221：运行状态不再发网页正中浮层（用户要求）——统一常驻面板底部状态条 #ais-status，
  // busy/error 指示点由 setStatus 既有逻辑驱动。一次性操作反馈（导出/复制成功等）仍走 aisToast。
  function status(t, ok) {
    try {
      var msg = (typeof aisText === 'function') ? aisText(t) : String(t == null ? '' : t);   // v1.2.282
      if (!msg) return;
      var now = Date.now();
      if (status.__last === msg && (now - (status.__at || 0)) < 800) return;
      status.__last = msg; status.__at = now;
      // v1.2.264：把 ok/类型透传给 setStatus，状态点才会变色（true→ok，字符串→原样，其余不指定）
      if (typeof setStatus === 'function') { setStatus(msg, (ok === true) ? 'ok' : (typeof ok === 'string' ? ok : '')); return; }
      var elS = __AIS_DOC().getElementById('ais-status');
      if (elS) elS.textContent = msg;
      var dotS = __AIS_DOC().getElementById('ais-status-dot');
      if (dotS) { dotS.classList.remove('busy', 'error'); if (/采集中|正在|等待|识别中/.test(msg)) dotS.classList.add('busy'); else if (/失败|错误|取消/.test(msg)) dotS.classList.add('error'); }
    } catch (e) {}
  }
  // v1.2.180：下载/导出进度条 + 可见提示（status 已是空函数，用户此前完全看不到反馈）
  var __aisProgTimer = null;
  function progShow(title) {
    var w = $('aisimg-progwrap'); if (!w) return;
    w.style.display = '';
    var t = $('aisimg-progtitle'); if (t) t.textContent = title || '处理中';
    var n = $('aisimg-prognum'); if (n) n.textContent = '';
    var f = $('aisimg-progfill'); if (f) f.style.width = '4%';
    var nt = $('aisimg-prognote'); if (nt) nt.textContent = '正在准备…';
  }
  function progSet(done, total, note, pct) {
    var n = $('aisimg-prognum'), f = $('aisimg-progfill'), nt = $('aisimg-prognote');
    var p = (pct != null) ? pct : (total ? Math.round((done || 0) / total * 100) : 0);
    if (n) n.textContent = total ? ((done || 0) + ' / ' + total + (p ? ' · ' + p + '%' : '')) : (p ? p + '%' : '');
    if (f) f.style.width = Math.max(4, Math.min(100, p)) + '%';
    if (nt) nt.textContent = note || '';
  }
  function progHide(delay) {
    if (__aisProgTimer) { clearTimeout(__aisProgTimer); __aisProgTimer = null; }
    __aisProgTimer = setTimeout(function () { var w = $('aisimg-progwrap'); if (w) w.style.display = 'none'; }, delay == null ? 2000 : delay);
  }
  function statusLink(t, ok, downloadId) { showOpenFolder(downloadId); }
  // v1.2.416：v1.1.58 曾把此入口按需求移除（函数被掏成空壳），v1.2.181 又把按钮加回来却没人重新实现。
  // 现补回：优先打开指定下载项所在文件夹，其次打开浏览器默认下载目录。
  function showOpenFolder(id, silent) {
    // v1.2.416：内容脚本没有 chrome.downloads（真机实测三项全 false），只能转交 SW。
    try {
      sendBg({ action: 'openDownloadFolder', id: (id != null ? id : null) }).then(function (r) {
        if (!silent) { try { aisToast(r && r.ok ? '已打开下载所在文件夹' : ('打开失败：' + ((r && r.error) || '未知错误')), r && r.ok ? 'info' : 'error'); } catch (eT) {} }
      }).catch(function () {});
      return true;
    } catch (eOF) {}
    return false;
  }

  function isTbDetail() {
    try {
      var h = location.hostname;
      if (/^(?:detail|item)\.tmall\.com$/.test(h)) return true;
      if (/^item\.taobao\.com$/.test(h)) return /item\.html|[?&]id=/.test(location.href);
    } catch (e) {}
    return false;
  }
  function isDetail() {
    try {
      var h = location.hostname;
      if (/^(?:detail|item)\.tmall\.com$/.test(h)) return true;
      if (/^item\.taobao\.com$/.test(h)) return /item\.html|[?&]id=/.test(location.href);
      if (/(^|\.)amazon\.[a-z.]{2,}$/i.test(h) || /(^|\.)amzn\.com$/i.test(h)) return /\/(?:dp|product|gp\/product|gp\/aw\/d)\/[A-Z0-9]{10}/i.test(location.pathname) || /[?&]asin=[A-Z0-9]{10}/i.test(location.search);
      if (/^item\.jd\.com$/.test(h)) return /\.html/.test(location.pathname);
      if (/(^|\.)1688\.com$/.test(h)) return /\/offer\//.test(location.pathname);
      // v1.2.197：拼多多商品详情页（必须带 goods_id/goods.html，首页/搜索页不算）——
      // 加入后 openImages/入口点击即自动读取（与京东/1688 行为一致，实测 PDD 之前不自动读）
      // v1.2.199：只认 goods.html——goods_comments.html（评论列表页）不做图片读取
      if (/(^|\.)yangkeduo\.com$/.test(h) || /(^|\.)pinduoduo\.com$/.test(h)) return /goods\.html/.test(location.pathname);
    } catch (e) {}
    return false;
  }
  function extractMeta() {
    // v1.2.194：拼多多特判——document.title 恒为「拼多多」（不能当标题）；URL 是 goods_id=（原正则不认）
    var __isPdd = /yangkeduo\.com|pinduoduo\.com/.test(location.href);
    if (!state.itemId) {
      try {
        var m = __isPdd
          ? location.href.match(/goods_id=(\d+)/)
          : (location.href.match(/[?&]id=(\d+)/) || location.href.match(/offer\/(\d+)/) || location.href.match(/(\d{6,})\.html/) || location.href.match(/\/(?:dp|product|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i) || location.href.match(/[?&]asin=([A-Z0-9]{10})/i));
        if (m) state.itemId = m[1].toUpperCase();
      } catch (e) {}
    }
    if (!state.itemTitle) {
      if (__isPdd) {
        // 先拦截 JSON（按 goods_id 精确匹配，防推荐流商品名串味），再 DOM 启发式；都取不到就留空
        var jt = '';
        try { jt = (pddJsonMeta() || {}).title || ''; } catch (eJT) {}
        if (!jt) { try { jt = pddTitleFromDom() || ''; } catch (eJD2) {} }
        if (jt) state.itemTitle = jt;
      } else {
        try {
          state.itemTitle = String(document.title || '').replace(/[-\u2013\u2014|]\s*(淘宝网|天猫|tmall\.com|淘宝|京东|JD\.com|京东商城|1688|阿里巴巴|jd\.com).*$/i, '').trim() || String(document.title || '').trim();
        } catch (e) {}
      }
    }
  }

  // v1.2.414【根治补强】：读取主世界写的 DOM 桥（跨世界可靠，不依赖消息时序）。
  // 真机实证：主世界 SSR SKU 完整，但面板只拿到 DOM 兜底 → SKU 图/维度名都不对。
  function __ssrBridgeRead(id) {
    try {
      var el = document.getElementById(id);
      if (!el) return null;
      var t = String(el.textContent || '');
      if (!t || t.length < 2) return null;
      return JSON.parse(t);
    } catch (e) { return null; }
  }
  function collectState() {
    var c = window.__AIS_IMG_COLLECTOR__;
    var dc = window.__detailCollector && window.__detailCollector._interceptedData;
    // v1.2.442：接口「详情」通道默认关闭（=商店基线行为）——v1.2.365 漏改事件名后这条通道整整死了十几个版本，
    // 现在采集器修好了，但「详情通道」一旦恢复会同时启用 主图接口/参数/尺码表自动点击 等一串行为，
    // 属新行为 → 按项目规则默认关闭，由服务器开（规则 common.apiDetailChannel=on，无需发版）。
    var __apiDetailOn = true;
    try { __apiDetailOn = String(aisSel('common.apiDetailChannel', 'off')) === 'on'; } catch (eAD) {}
    return {
      detail: __apiDetailOn ? unwrap((c && c.detailResponse) || (dc && dc.detailResponse) || null) : null,
      sku: unwrap((c && c.skuResponse) || (dc && dc.skuResponse) || __ssrBridgeRead('ais-ssr-sku-bridge') || null),
      descResp: unwrap((c && c.descResponse) || null),
      review: unwrap((c && c.reviewResponse) || (dc && dc.reviewResponse) || null),
      all: (c && c.allResponses) || (dc && dc.allResponses) || []
    };
  }
  // v1.2.442【根因修复·SKU 晚到数据落表】：把任意来源的「SKU 载荷」统一落到面板状态。
  // 受控真机复现（本地伪造淘宝页 + 真扩展，零真实流量）：
  //   · 主世界写的 DOM 桥 #ais-ssr-sku-bridge 有 8754 字节完整 skuBase/skuCore；
  //   · 隔离世界跑 P.buildSkuTable(这份载荷) 稳定出 11 行（其中 10 行带 SKU 图）；
  //   · 但只要「没有读取在跑」，面板 SKU 就恒为 0 —— 因为晚到数据只有 ssr:ready 一条触发路径，
  //     而那条路径在 !state.readFinished 时直接 return（注释写「轮询会拾取」），
  //     偏偏此时根本没有轮询在跑（用户没点悬浮球 / 读取已结束）→ 数据永远没人拾取。
  // 本函数把这层拾取补齐：不管读取是否在跑，只要拿到 SKU 载荷就补 SKU 图 + 规格表。
  function applySkuPayload(raw, opts) {
    try {
      var P = window.__AIS_IMG_PARSER__;
      if (!P || !raw) return false;
      var changed = false;
      try {
        var r = P.collectImages(null, raw);
        if (r && r.sku && r.sku.length) {
          var before = (state.sku || []).length;
          state.sku = uniq((state.sku || []).concat(jdCleanSku(r.sku)));
          if (state.sku.length > before) changed = true;
        }
        if (r && r.valueImgs && r.valueImgs.length && !(state.skuValueImgs || []).length) {
          state.skuValueImgs = jdCleanValueImgs(r.valueImgs);
        }
      } catch (eSk0) {}
      if (!(state.skuRows || []).length) {
        try {
          var bt = P.buildSkuTable(raw, { title: state.itemTitle, itemId: state.itemId, url: location.href });
          if (bt && bt.rows && bt.rows.length) {
            state.skuRows = bt.rows;
            state.skuPropNames = bt.propNames || [];
            changed = true;
          }
        } catch (eSk1) {}
      }
      if (changed && (!opts || opts.render !== false)) {
        try { render(); } catch (eSk2) {}
        // v1.2.442：SKU 规格表只在 finishRead / 点 SKU 页签时才渲染 —— 晚到补数据这条路径没有读取收尾，
        // 会出现「计数 11、规格表 0 行」的新的口径不一致，所以这里主动补一次表格渲染（受控复现实测所得）。
        try { renderSku(); } catch (eSk4) {}
      }
      return changed;
    } catch (eSk) { return false; }
  }
  // v1.2.461【京东 SKU 真因修复 · 移植电商宝 domJdSku()】真机实测（item.jd.com/10193206821242）：
  //   ① pageConfig.product 只有 colorApiDomain/chooseLOCShop —— 没有 colorSize/skus（v1.2.460 那路在本页无数据）
  //   ② 拦到的 27 条接口响应里也没有 SKU（skuList 是空数组）
  //   ③ 规格数据**只在 DOM**：.specification-item-sku ×16，父容器 .specification-group-content
  //   ⇒ 按「父元素身份」分组（不依赖类名，抗改版），组名取 祖父→父 的 title/Title/name，值取规格项文本
  //     （≤40 字、去重、剥离「无货/缺货/售罄」标记），再交给 jdDimsToSkuBase 交叉成 skuBase。
  function jdChipImg(el) {
    try {
      var im = el && el.querySelector ? el.querySelector('img') : null;
      if (!im) return '';
      var raw = im.getAttribute('src') || im.getAttribute('data-src') || im.getAttribute('data-lazyload') || im.src || '';
      if (!raw) return '';
      if (raw.indexOf('//') === 0) raw = 'https:' + raw;
      var min = aisNum('jd.skuMinPx', 32);
      var w = im.naturalWidth || im.naturalHeight || 0;
      if (min > 0 && w && w < min) return '';   // 超小占位图剔除
      return raw;
    } catch (e) { return ''; }
  }
  function jdDomDims() {
    var dims = [];
    try {
      if (!/(^|\.)jd\.com$/i.test(location.hostname)) return dims;
      var els = document.querySelectorAll(aisSel('jd.skuItem', '.specification-item-sku'));
      if (!els.length) return dims;
      var groups = [];
      var pickTitle = function (root) {
        if (!root) return '';
        try {
          var t = root.querySelector(aisSel('jd.skuGroupTitle', '[class*="group-label"], [class*="Label"], [class*="label"], [class*="title"], [class*="Title"], [class*="name"]'));
          if (t) {
            var s = String(t.textContent || '').replace(/\s+/g, ' ').trim();
            if (s && s.length <= 12) return s;
          }
        } catch (e) {}
        return '';
      };
      for (var i = 0; i < els.length; i++) {
        var el = els[i], par = el.parentElement, g = null;
        for (var gi = 0; gi < groups.length; gi++) { if (groups[gi]._el === par) { g = groups[gi]; break; } }
        if (!g) { g = { _el: par, name: pickTitle(par && par.parentElement) || pickTitle(par), values: [], _seen: {} }; groups.push(g); }
        var txt = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!txt || txt.length > 40 || g._seen[txt]) continue;
        g._seen[txt] = 1;
        var lack = /无货|缺货|售罄|暂时缺货/.test(txt);
        var nm = txt.replace(/[\s（(【\[]*(无货|缺货|售罄|已售罄|暂时缺货)[\s）)】\]]*/g, '').trim() || txt;
        g.values.push({ name: nm, image: jdChipImg(el), lack: lack });
      }
      for (var k = 0; k < groups.length && dims.length < 4; k++) {
        if (groups[k].values.length) dims.push({ name: groups[k].name || ('规格' + (dims.length + 1)), values: groups[k].values });
      }
    } catch (e) {}
    return dims;
  }
  // 京东 DOM 规格 → skuBase → 与淘宝同一套 SKU 管线；成功返回 true
  function jdDomSkuTry() {
    try {
      if (aisSel('jd.domSku', 'on') === 'off') return false;
      if (!/(^|\.)jd\.com$/i.test(location.hostname)) return false;
      var P = window.__AIS_IMG_PARSER__;
      if (!P || !P.jdDimsToSkuBase) return false;
      var dims = jdDomDims();
      if (!dims.length) return false;
      var base = P.jdDimsToSkuBase(dims);
      if (!base || !base.skus || !base.skus.length) return false;
      return !!applySkuPayload({ data: { skuBase: base } });
    } catch (e) { return false; }
  }
  // v1.2.442【根因修复·有界晚到拾取】：读取结束/面板初始化后若 SKU 仍为空，最多盯 N 秒 DOM 桥。
  // 有界收敛：拿到数据立刻停、到时立刻停（规则 common.skuBridgeWait，单位秒，0=关闭 → 回到商店基线）。
  function skuBridgePickup() {
    try {
      if (state.__skuPickupTimer) return;
      var waitS = aisNum('common.skuBridgeWait', 15);
      if (!(waitS > 0)) return;
      var t0 = Date.now();
      state.__skuPickupTimer = setInterval(function () {
        try {
          if ((state.skuRows || []).length) { clearInterval(state.__skuPickupTimer); state.__skuPickupTimer = null; return; }
          if (Date.now() - t0 >= waitS * 1000) { clearInterval(state.__skuPickupTimer); state.__skuPickupTimer = null; return; }
          // v1.2.461：京东先试 DOM 规格区（真机实测这是主通道）——成功即收工
          if (jdDomSkuTry()) { clearInterval(state.__skuPickupTimer); state.__skuPickupTimer = null; return; }
          // v1.2.460【移植自电商宝】京东：主世界把 pageConfig.product（colorSize+skus）写进 #ais-ssr-jdsku-bridge，
          //   这里转成 skuBase 后喂给与淘宝完全相同的 SKU 管线（applySkuPayload）。
          var jdRaw = __ssrBridgeRead('ais-ssr-jdsku-bridge');
          if (jdRaw) {
            try {
              var Pj = window.__AIS_IMG_PARSER__;
              var jdp = (jdRaw && jdRaw.data) ? jdRaw.data : jdRaw;
              var baseJd = (Pj && Pj.jdPageConfigToSkuBase) ? Pj.jdPageConfigToSkuBase(jdp) : null;
              if (baseJd && baseJd.skus && baseJd.skus.length && applySkuPayload({ data: { skuBase: baseJd } })) {
                clearInterval(state.__skuPickupTimer); state.__skuPickupTimer = null; return;
              }
            } catch (eJd0) {}
          }
          var raw = __ssrBridgeRead('ais-ssr-sku-bridge');
          if (raw && applySkuPayload(raw)) { clearInterval(state.__skuPickupTimer); state.__skuPickupTimer = null; }
        } catch (ePk) { clearInterval(state.__skuPickupTimer); state.__skuPickupTimer = null; }
      }, 1000);
    } catch (ePk0) {}
  }

  // v1.2.248：alicdn 尺寸后缀 → 原图（淘宝/天猫/1688 的 DOM 兜底共用一份归一化）
  // ① 基名后仍挂尺寸指令：a.jpg_50x50.jpg / a.jpg_.webp / a.jpg_q50.jpg / a.png_100x100.png
  // ② 点号形式：a.jpg.400x400xzq90.jpg
  // ③ 尺寸在扩展名之前：a_50x50.jpg（直接删会丢扩展名，故升级到 800x800）
  function aliUp(u) {
    u = abs(u || '');
    if (!u || u.indexOf('alicdn.com') < 0) return u;
    var q = '', qi = u.indexOf('?');
    if (qi > -1) { q = u.slice(qi); u = u.slice(0, qi); }
    var r = u;
    // v1.2.258：清洗链可远程覆盖（registry ali.normalize）；远程正则非法时自动整体回落下面这组内置链
    var chain = aisNorm('ali.normalize', [
      [/\.(jpe?g|png|webp|gif)[._]+(?:sum|webp|q\d+|\d+x\d+(?:q\d+|xzq\d+|zq\d+)?)(?:[._]+(?:jpe?g|png|webp|gif))?$/i, '.$1'],
      [/\.(jpe?g|png|webp|gif)\.\d+x\d+(?:xzq\d+)?(?:\.(?:jpe?g|png|webp|gif))?$/i, '.$1'],
      [/_(\d{2,5}x\d{2,5})(q\d+)?(\.(?:jpe?g|png|webp|gif))$/i, '_800x800$2$3']
    ]);
    for (var ci = 0; ci < chain.length; ci++) { try { r = r.replace(chain[ci][0], chain[ci][1]); } catch (eC) {} }
    return r + q;
  }
  // v1.1.76：1688 新版详情页 DOM 图片直读（不依赖接口拦截；alicdn 原图还原）
  function ali1688Up(u) {
    var v = abs(u || '');
    if (!v || v.indexOf('alicdn.com') < 0) return '';
    return aliUp(v);
  }
  function a1688Dom() {
    try {
      if (!/(^|\.)1688\.com$/.test(location.hostname) || !/\/offer\//.test(location.pathname)) return;
      // v1.1.77：SSR 直读优先（window.context 经 worker 主世界桥接，零额外请求）
      sendBg({ action: 'mainWorldGet1688RawData' }).then(function (r) {
        try {
          var d = r && r.result;
          if (!d || !d.ok) { a1688DomFallback(); return; }
          var mains = (d.imageList && d.imageList.length ? d.imageList : (d.offerImgList || []));
          if (mains.length) state.main = uniq(mains).slice(0, 60);
          var skus = [], vi = [];
          (d.skuProps || []).forEach(function (p) {
            (p.value || []).forEach(function (v) {
              if (!v.imageUrl || !aisImgUsable(v.imageUrl)) return;   // v1.2.344 入库闸
              skus.push(v.imageUrl);
              vi.push({ name: p.prop || '', value: v.name || '', image: v.imageUrl });
            });
          });
          skus = skus.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
          if (skus.length) {
            state.sku = uniq(skus.concat(state.sku || []));
            if (!state.skuValueImgs || !state.skuValueImgs.length) state.skuValueImgs = vi;
          }
          if (d.detailUrl && !state.descUrl) { state.descUrl = d.detailUrl; try { if (!state.descFetched) fetchDesc(); } catch (e8) {} } // v1.1.78：立刻拉详情，不等下轮
          if (d.video && !state.video) addVideo(d.video);   // v1.2.292
          // v1.1.81：商品属性 + 包装信息 → 属性卡（state.itemProps）
          try {
            if ((d.featureAttrs && d.featureAttrs.length) || d.packInfo) {
              var ip = [];
              (d.featureAttrs || []).forEach(function (fa) { ip.push({ name: fa.name, value: fa.value }); });
              if (d.packInfo && d.packInfo.unitWeight) {
                var g2 = Math.round(d.packInfo.unitWeight * 1000);
                ip.push({ name: '包装·单件重量', value: g2 + ' g' });
              }
              if (ip.length) state.itemProps = ip;
            }
          } catch (e6) {}
          // v1.1.79：SKU 规格表（skuModel.skuInfoMap → 面板规格表行）
          try {
            var smm = d.skuModel;
            if (smm && smm.props && smm.props.length && (!state.skuRows || !state.skuRows.length)) {
              var decE = function (s) { return String(s || '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&'); };
              var propNames2 = smm.props.map(function (p2) { return p2.prop; });
              // v1.2.342 修复「1688 SKU 图不准确」：原实现把所有维度的「值名」压成一张扁平表，
              // 且只拿规格串第一段(parts3[0])去查 → 跨维度同名值互相覆盖、带图维度不是第一段时错位/丢图。
              // 现改为【维度名::值名】精确成对；行取图时按「该维度在行里的值」查，取第一个真正带图的维度（1688 通常是「颜色」）。
              var imgByPV = {}, imgByName2 = {}, imgByValue = {};
              smm.props.forEach(function (p2) {
                (p2.value || []).forEach(function (v2) {
                  if (!v2.imageUrl) return;
                  var vn2x = decE(v2.name);
                  imgByPV[String(p2.prop) + '::' + vn2x] = v2.imageUrl;
                  if (!imgByName2[vn2x]) imgByName2[vn2x] = v2.imageUrl;
                  if (!imgByValue[vn2x]) imgByValue[vn2x] = v2.imageUrl;   // 顺序无关兜底
                });
              });
              var imgProps2 = smm.props.map(function (p2) { return String(p2.prop); });
              var infoSrc = {};
              var hasO = smm.infoMapOriginal && Object.keys(smm.infoMapOriginal).length;
              if (hasO) infoSrc = smm.infoMapOriginal; else infoSrc = smm.infoMap || {};
              var rows2 = [];
              Object.keys(infoSrc).forEach(function (k3, i3) {
                var it3 = infoSrc[k3];
                if (!it3) return;
                var spec3 = decE(it3.specAttrs || k3);
                var parts3 = spec3.split('>');
                var row3 = { 序号: i3 + 1, 商品标题: state.itemTitle || '', 商品ID: state.itemId || '', 商品链接: location.href, SKU_ID: it3.skuId != null ? it3.skuId : '', 商家编码: '', 规格: spec3, 价格: it3.discountPrice || it3.price || '', 库存: it3.canBookCount != null ? it3.canBookCount : '' };
                propNames2.forEach(function (pn2, pi2) { row3[pn2] = decE(parts3[pi2] || ''); });
                // v1.2.342：优先按维度精确配对 → 再按规格段文本顺序无关匹配 → 最后才用旧扁平表兜底
                var im3 = '';
                for (var ip2 = 0; ip2 < imgProps2.length && !im3; ip2++) {
                  var pvTxt2 = decE(row3[imgProps2[ip2]] || '');
                  if (pvTxt2 && imgByPV[imgProps2[ip2] + '::' + pvTxt2]) im3 = imgByPV[imgProps2[ip2] + '::' + pvTxt2];
                }
                if (!im3) {
                  for (var pj2 = 0; pj2 < parts3.length && !im3; pj2++) {
                    var seg3 = decE(parts3[pj2] || '');
                    if (seg3 && imgByValue[seg3]) im3 = imgByValue[seg3];
                  }
                }
                if (!im3) im3 = imgByName2[decE(parts3[0] || '')] || '';
                if (im3) row3['SKU图'] = (typeof aliUp === 'function' ? aliUp(im3) : im3);   // v1.2.342：SKU 图同样还原原图
                rows2.push(row3);
              });
              if (rows2.length) { state.skuRows = rows2; state.skuPropNames = propNames2; }
            }
          } catch (e7) {}
          render();
        } catch (e9) { try { a1688DomFallback(); } catch (e10) {} }
      }).catch(function () { try { a1688DomFallback(); } catch (e11) {} });
    } catch (e) { try { a1688DomFallback(); } catch (e12) {} }
  }
  function a1688DomFallback() {
    try {
      if (!/(^|\.)1688\.com$/.test(location.hostname) || !/\/offer\//.test(location.pathname)) return;
      // 主图：真画廊 viewer 图（preview-img），替换而非累加（去推荐位/logo 杂质）
      var found = [];
      // v1.2.258：画廊选择器与域名白名单可远程覆盖（registry ali.*）
      var aliHost = new RegExp(aisSel('ali.mainHost', 'ibank|cbu01'));
      document.querySelectorAll(aisSel('ali.gallery', '.ant-image-img.preview-img')).forEach(function (im) {
        var u = ali1688Up(im.getAttribute('src') || im.getAttribute('data-src') || '');
        if (u && aliHost.test(u)) found.push(u);
      });
      found = found.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
      if (found.length) state.main = uniq(found).slice(0, 60);
      // SKU 色卡：module-od-sku-selection 内 ant-image-img
      var skus = [], vi = [];
      document.querySelectorAll(aisSel('ali.skuImg', '.module-od-sku-selection img.ant-image-img')).forEach(function (im) {
        var u = ali1688Up(im.getAttribute('src') || im.getAttribute('data-src') || '');
        if (!u || !aisImgUsable(u)) return;   // v1.2.344 入库闸
        skus.push(u);
        var nm = String(im.getAttribute('alt') || '').trim();
        try { var pr = im.closest('[class*="item"], label, div'); if (!nm && pr) nm = String(pr.getAttribute('title') || '').trim(); } catch (e1) {}
        vi.push({ name: '', value: nm, image: u });
      });
      skus = skus.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
      if (skus.length) {
        state.sku = uniq(skus.concat(state.sku || []));
        if (!state.skuValueImgs || !state.skuValueImgs.length) state.skuValueImgs = vi;
      }
    } catch (e) {}
  }
  // v1.1.71：京东新版详情页 DOM 图片直读（不依赖接口拦截；CDN 原图还原）
  function jdImgUp(u) {
    u = abs(u || '');
    if (!u || u.indexOf('360buyimg.com') < 0) return '';
    // v1.2.258：清洗链可远程覆盖（registry jd.normalize）；远程正则非法时自动回落下面这组内置链。
    // 内置链语义：/s228x228_jfs/→/jfs/（去尺寸前缀=原图）；连续 .avif 去净；
    //            /n5/ 这类数字尺寸段→/imgzone/（京东原图通道）；去掉 !cc_50x64.jpg 变体后缀。
    var chain = aisNorm('jd.normalize', [
      [/\/s\d+x\d+_(jfs\/)/, '/$1'],
      [/(?:\.avif)+(?=$|\?)/i, ''],
      [/\/n\d+\//, '/imgzone/'],
      [/!cc_\d+x\d+\.(?:jpe?g|png|webp)(?=$|\?)/i, '']
    ]);
    for (var ci = 0; ci < chain.length; ci++) { try { u = u.replace(chain[ci][0], chain[ci][1]); } catch (eC) {} }
    return u;
  }
  // v1.2.260：JD **接口/拦截器路径**（parseAll 里的 P.collectImages）此前完全没走 jdImgUp ——
  // 于是 .avif 原样入库、也没有任何尺寸闸，这正是「还是有 avif 的 SKU 图」的来源。
  // 统一在入库前清洗：① URL 尺寸前缀 /s{n}x{n}_jfs/ 任一边 < jd.skuMinPx 即丢（未加载也能判）
  // ② 360buyimg 走 jdImgUp 归一化（去 .avif / 去尺寸前缀），非 360buyimg 的图原样保留（不误删）③ 去重。
  // 非京东页面直接原样返回，不介入其它平台。
  function jdCleanSku(list) {
    if (!list || !list.length) return [];
    if (!/jd\.com|3\.cn/.test(location.href)) return list.slice();
    var min = aisNum('jd.skuMinPx', 32);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var raw = String(list[i] || '');
      var m = raw.match(/\/s(\d+)x(\d+)_jfs\//i);
      if (m && (parseInt(m[1], 10) < min || parseInt(m[2], 10) < min)) continue; // 超小图
      var u = (raw.indexOf('360buyimg.com') > -1) ? jdImgUp(raw) : abs(raw);
      if (u && out.indexOf(u) < 0) out.push(u);
    }
    return out;
  }
  function jdCleanValueImgs(list) {
    if (!list || !list.length) return [];
    if (!/jd\.com|3\.cn/.test(location.href)) return list.slice(); // 非京东平台不介入
    var urls = jdCleanSku(list.map(function (x) { return (x && x.image) || ''; }));
    if (!urls.length) return [];
    var idx = {}; urls.forEach(function (u) { idx[u] = 1; });
    var out = [];
    list.forEach(function (x) {
      var raw = (x && x.image) || '';
      var u = (String(raw).indexOf('360buyimg.com') > -1) ? jdImgUp(raw) : abs(raw);
      if (u && idx[u]) out.push({ name: (x && x.name) || '', value: (x && x.value) || '', image: u });
    });
    return out;
  }
  // v1.2.262：SKU 规格值图片统一归一化。此前 domSkuFallback 三处都只用 abs() ——
  // 京东规格图会以 s48x48_jfs/...jpg.avif **原始形态**入库（既是 48x48 小图、又带 .avif），
  // 这正是用户实测到的那条 URL。京东走 jdImgUp（→ /jfs/ 原图，实测 800x800），其它平台走 aliUp。
  function skuValImg(el) {
    try {
      if (!el) return '';
      var im = el.querySelector ? el.querySelector('img') : (el.tagName === 'IMG' ? el : null);
      if (!im) return '';
      var raw = im.getAttribute('src') || im.getAttribute('data-src') || im.getAttribute('data-lazyload') || im.src || '';
      if (!raw) return '';
      if (raw.indexOf('360buyimg.com') > -1 || /jd\.com|3\.cn/.test(location.href)) {
        var jmin = aisNum('jd.skuMinPx', 32);
        var m = String(raw).match(/\/s(\d+)x(\d+)_jfs\//i);
        if (m && (parseInt(m[1], 10) < jmin || parseInt(m[2], 10) < jmin)) return '';
        var w = im.naturalWidth || 0, h = im.naturalHeight || 0;
        if (w && h && (w < jmin || h < jmin)) return '';
        return jdImgUp(raw);
      }
      return aliUp(abs(raw));
    } catch (e) { return ''; }
  }
  // v1.1.172 锚点注册表快捷取值（注册表缺失自动回退内置字面量）
  function aisSel(p, f) { try { return window.AisAnchors.sel(p, f); } catch (e) { return f; } }
  // v1.2.258：全平台可远程配置的取数助手（注册表缺失/类型不符时自动回退内置值）
  function aisArr(p, f) { try { return window.AisAnchors.arr(p, f); } catch (e) { return f; } }
// v1.2.276 行为参数层 helper
function aisTune(n, f) { try { return window.AisAnchors.tune(n, f); } catch (e) { return f; } }
function aisFlag(n, f) { try { return window.AisAnchors.flag(n, f); } catch (e) { return !!f; } }
// ===== v1.2.275 全远程文案层：texts / textRules / labelTexts（纯数据，远程可覆盖，无需发版）=====
// 设计：只在【出口函数】套一层查表，不改 270+ 个调用点；映射三条规则：
//   1) 原文精确匹配 -> 替换；2) 再按 textRules 正则替换；3) 远程取不到时行为与原来完全一致
var __aisTextCache = null;
// ===== v1.2.277 导出列名远程化：colTitles = [[原表头, 新表头], ...] =====
var __aisJsonSheet = (typeof XLSX !== 'undefined' && XLSX.utils && XLSX.utils.json_to_sheet) ? XLSX.utils.json_to_sheet : null;
var __aisColCache = null;
function __aisColMap() {
  if (__aisColCache) return __aisColCache;
  var m = {};
  try { aisArr('common.colTitles', []).forEach(function (p) { if (p && p.length >= 2 && p[0]) m[String(p[0])] = String(p[1]); }); } catch (e) {}
  __aisColCache = m;
  return m;
}
function __aisSheet(rows) {
  try {
    var M = __aisColMap();
    var ks = Object.keys(M);
    if (ks.length && Array.isArray(rows) && rows.length && rows[0] && typeof rows[0] === 'object') {
      rows = rows.map(function (r) {
        var o = {};
        Object.keys(r).forEach(function (k) { o[M[k] || k] = r[k]; });
        return o;
      });
    }
  } catch (e) {}
  return __aisJsonSheet(rows);
}
try { document.addEventListener('cfg:sync', function () { __aisColCache = null; __aisTextCache = null; }); } catch (e) {}
// v1.2.282：把文案/列名/标签工具发布到全局 —— 避免调用点（如 setStatus）与定义不在同一作用域时 ReferenceError
try {
  if (typeof aisText === 'function') window.aisText = aisText;
  if (typeof aisLabelsApply === 'function') window.aisLabelsApply = aisLabelsApply;
  if (typeof __aisTextMaps === 'function') window.__aisTextMaps = __aisTextMaps;
  if (typeof __aisSheet === 'function') window.__aisSheet = __aisSheet;
  if (typeof __aisColMap === 'function') window.__aisColMap = __aisColMap;
  if (typeof __aisJsonSheet === 'function') window.__aisJsonSheet = __aisJsonSheet;
} catch (ePub) {}
// v1.2.283（已废弃）：closed shadow root 下 document 委托拿不到内部按钮 id，故改为各绑定独立 try（见 v1.2.284）
try {
  if (!window.__AIS_HEADER_DELEGATED__) {
    window.__AIS_HEADER_DELEGATED__ = true;
    document.addEventListener('click', function (ev) {
      try {
        var id = '';
        var path = (ev.composedPath && ev.composedPath()) || [];
        for (var i = 0; i < path.length && i < 6; i++) { if (path[i] && path[i].id) { id = path[i].id; break; } }
        if (!id) { var tg = ev.target; id = (tg && tg.id) || ''; }
        if (!id) return;
        if (id === 'ais-btn-help') {
          ev.stopPropagation();
          if (typeof helpModal === 'function') helpModal();
        } else if (id === 'ais-btn-more') {
          ev.stopPropagation();
          var mp = __AIS_DOC().getElementById('ais-nav-more');
          if (mp) mp.classList.toggle('open');
        } else if (id === 'ais-btn-shortcut') {
          ev.stopPropagation();
          if (typeof startShortCapture === 'function') startShortCapture();
        } else if (id === 'ais-btn-shortreset') {
          ev.stopPropagation();
          if (typeof resetShortcuts === 'function') resetShortcuts();
        } else if (id === 'aisimg-imgsrch') {
          ev.stopPropagation();
          if (typeof imgSearch === 'function') imgSearch();
        }
      } catch (e) {}
    }, true);
  }
} catch (eDel) {}
function __aisTextMaps() {
  if (__aisTextCache) return __aisTextCache;
  var map = {}, rules = [], labels = [], prefixes = [];
  try {
    aisArr('common.texts', []).forEach(function (p) { if (p && p.length >= 2 && p[0]) map[String(p[0])] = String(p[1]); });
    aisArr('common.textRules', []).forEach(function (p) {
      if (p && p.length >= 2 && p[0]) { try { rules.push([new RegExp(String(p[0])), String(p[1])]); } catch (e) {} }
    });
    aisArr('common.labelTexts', []).forEach(function (p) { if (p && p.length >= 2 && p[0]) labels.push([String(p[0]), String(p[1])]); });
    aisArr('common.textPrefixes', []).forEach(function (p) { if (p && p.length >= 2 && p[0]) prefixes.push([String(p[0]), String(p[1])]); });
  } catch (e) {}
  __aisTextCache = { map: map, rules: rules, labels: labels, prefixes: prefixes };
  return __aisTextCache;
}
function aisText(s) {
  var raw = String(s == null ? '' : s);
  if (!raw) return raw;
  try {
    var M = __aisTextMaps();
    var t = (M.map[raw] != null) ? M.map[raw] : raw;
    for (var k = 0; k < M.prefixes.length; k++) {
      var pf = M.prefixes[k];
      if (pf[0] && t.indexOf(pf[0]) === 0) { t = pf[1] + t.slice(pf[0].length); break; }
    }
    for (var i = 0; i < M.rules.length; i++) { try { t = t.replace(M.rules[i][0], M.rules[i][1]); } catch (e) {} }
    return t;
  } catch (e) { return raw; }
}
function aisLabelsApply() {
  try {
    var M = __aisTextMaps();
    if (!M.labels.length) return -1;
    var doc = __AIS_DOC();
    if (!doc) return 0;
    var n = 0;
    M.labels.forEach(function (p) {
      try {
        var el = doc.getElementById(p[0]);
        if (!el) return;
        for (var i = 0; i < el.childNodes.length; i++) {
          if (el.childNodes[i].nodeType === 3) { el.childNodes[i].nodeValue = p[1]; n++; return; }
        }
        if (!el.children.length) { el.textContent = p[1]; n++; }
      } catch (e) {}
    });
    return n;
  } catch (e) { return 0; }
}
// 远程规则到达后失效缓存并重套标签；面板出现前做有限次重试（最多 10 次，收敛即停）
try { document.addEventListener('cfg:sync', function () { __aisTextCache = null; setTimeout(function () { try { aisLabelsApply(); } catch (e) {} }, 60); }); } catch (e) {}
try {
  var __labTries = 0;
  var __labTimer = setInterval(function () {
    __labTries++;
    var r = -1;
    try { r = aisLabelsApply(); } catch (e) {}
    if (r >= 0 || __labTries >= 10) { try { clearInterval(__labTimer); } catch (e) {} }
  }, 2000);
} catch (e) {}
  function aisNum(p, f) { try { return window.AisAnchors.num(p, f); } catch (e) { return f; } }
  function aisNorm(p, f) { try { return window.AisAnchors.norm(p, f); } catch (e) { return f; } }
  // v1.1.147：京东详情图自动懒加载（用户要求：不再依赖后台直拉/被动收集，主动滚动触发楼层加载）
  function jdAutoLazyLoad() {
    try {
      // v1.2.317：淘宝/天猫/1688/拼多多 的详情图同样是滚动懒加载，但此前只有京东会滚动扫描 ——
      // 三站详情图只能靠后台接口，接口拿不到就是 0 张（用户实测「详情图还是不显示」的根因）。
      // 现非京东分流到通用滚动采集（语义判据，不依赖类名）。
      if (!/\.jd\.com$/.test(location.hostname)) { genericDescLazyLoad(); return; }
      if (window.__AIS_JD_LAZY_RUNNING__) return;
      window.__AIS_JD_LAZY_RUNNING__ = 1;
      // v1.1.170：新版京东详情内容在「商品详情」tab 内懒挂载——先切 tab（页内 tab 切换，等价真人操作）再滚动，
      // 否则整个 DOM 里没有详情图（实测 bigImgGroups 仅主图+logo）
      try {
        var jt2 = document.querySelectorAll(aisSel('jd.descTab', '[class*="left-tabs-item"], [class*="tab-item"], [role="tab"]'));
        for (var tj = 0; tj < jt2.length; tj++) {
          var tt2 = String(jt2[tj].textContent || '');
          if (tt2.indexOf('商品详情') > -1 || (tt2.indexOf('详情') > -1 && tt2.length < 8)) { jt2[tj].click(); break; }
        }
      } catch (eT2) {}
      var step = 700, y = window.pageYOffset || 0, ticks = 0, lastLen = -1, same = 0;
      // v1.2.252：上限按页高动态计算（旧值写死 50 拍/15 秒 —— 实测 60000px 长页只能滚到 35700px 就放弃，底下详情图永远采不到）
      var pageH = (document.body && document.body.scrollHeight) || (document.documentElement && document.documentElement.scrollHeight) || 0;
      var maxTicks = Math.min(240, Math.max(60, Math.ceil(pageH / step) + 20));
      var t = setInterval(function () {
        try {
          ticks++;
          y += step;
          window.scrollTo(0, y);
          jdDomImages();
          var len = state.desc ? state.desc.length : 0;
          if (len === lastLen) same++; else { same = 0; lastLen = len; }
          var bottom = y >= pageH - 400;
          if ((bottom && same >= 5) || ticks > maxTicks) { // v1.2.252：到底后多等 2 拍给懒加载挂图，上限按页高算
            clearInterval(t);
            jdDwellDetail(); // v1.2.253：转入「驻留详情容器」阶段（由它负责收尾扫描与滚回顶部）
          }
        } catch (e3) { clearInterval(t); window.__AIS_JD_LAZY_RUNNING__ = 0; }
      }, 300);
    } catch (e) {}
  }
  // v1.2.253：详情图驻留扫描。实测京东会在详情图**离开视口后卸载**（滚回顶部时 #detail-main 内图片数=0，
  // 同一商品滚到底时是 21 张），且长图挂载有延迟（粗扫快速路过只连续命中 2 个位置，不足以触发）。
  // 因此：粗扫到底触发懒加载 → 回到详情容器处**驻留**反复扫描 → **先采集再滚回顶部**（顺序修正）。
  function jdDwellDetail() {
    var finish = function () {
      try { jdDomImages(); render(); } catch (e0) {}        // 顺序修正：先采集
      var len = state.desc ? state.desc.length : 0;
      try { window.scrollTo(0, 0); } catch (e1) {}          // 再滚回顶部
      window.__AIS_JD_LAZY_RUNNING__ = 0;
      if (len) status('详情图懒加载完成：' + len + ' 张', true);
    };
    try {
      var host = null;
      try { host = document.querySelector(aisSel('jd.descBoxParent', '#detail-main, .ssd-module-wrap, .ssd-module, #detail .content, .detail-content, #J-detail-content, #shadowHost, .wdis-content')); } catch (e2) {}
      var target = 0;
      if (host) { try { target = Math.max(0, host.getBoundingClientRect().top + (window.pageYOffset || 0) - 120); } catch (e3) {} }
      var n = 0, lastLen = state.desc ? state.desc.length : 0, stable = 0;
      var maxN = 24; // 最多 12 秒
      var t2 = setInterval(function () {
        n++;
        try {
          // 轻微往返：长图挂载常需「可见 + 一次滚动事件」，同时避免被判定为静止
          try { window.scrollTo(0, (n % 2) ? target + 240 : target); } catch (e4) {}
          jdDomImages();
          var len = state.desc ? state.desc.length : 0;
          if (len === lastLen) stable++; else { stable = 0; lastLen = len; }
          if (stable >= 8 || n >= maxN) { clearInterval(t2); finish(); }
        } catch (e5) { clearInterval(t2); finish(); }
      }, 500);
    } catch (e) { finish(); }
  }
  // v1.2.317 通用详情图取真图：data-* 优先（懒加载真图常在 data-src），剔除占位/无效 URL
  function genericPickSrc(im) {
    var cs = [im.getAttribute('data-src'), im.getAttribute('data-ks-lazyload'), im.getAttribute('data-lazyload'), im.getAttribute('data-original'), im.getAttribute('data-img'), im.getAttribute('data-srcset'), im.getAttribute('srcset'), im.getAttribute('src')];
    for (var i = 0; i < cs.length; i++) {
      var u = String(cs[i] || '').trim();
      if (!u) continue;
      u = u.split(',')[0].trim().split(/\s+/)[0];
      if (u.indexOf('//') === 0) u = 'https:' + u;
      if (!/^https?:\/\//i.test(u)) continue;
      if (/\.gif(?:\?|$)/i.test(u)) continue;
      if (/(?:blank|loading|placeholder|spacer|1x1)/i.test(u)) continue;
      return u;
    }
    return '';
  }
  // v1.2.317 通用详情图语义收集（非京东）：图床白名单 + 页面下半部 + 长边门槛 + 去重，阈值走远程键
  function genericDomDescImages() {
    try {
      var hostRe = new RegExp(aisSel('common.descHostRe', 'alicdn\\.com|360buyimg\\.com|cbuimg\\.com|tbcdn\\.cn|pddpic\\.com|yangkeduo\\.com'), 'i');
      var badRe = new RegExp(aisSel('common.descBadRe', 'babel|imagetools|/icon|/logo|sprite|avatar|/tps/'), 'i');
      var minEdge = aisNum('common.descAdaptiveMinEdge', 300);
      var topRatio = aisNum('common.descAdaptiveTopRatio', 0.45);
      var topPx = aisNum('common.descAdaptiveTopPx', 1200);
      var pageH = Math.max(document.documentElement.scrollHeight || 0, (document.body && document.body.scrollHeight) || 0);
      // v1.2.320：矮页（实测有 3914px 的商品页）用固定 45% 会把详情图整段误杀（45%≈1761px，而详情图在 1761px 以上）
      // → 取「页高×45%」与「绝对上限 1200px」的较小值，长页维持低位排除、矮页不再误杀
      var yTop = Math.min(pageH * topRatio, topPx);
      // v1.2.322：容器级过滤——修复「详情图混入无关图」（评价晒图/推荐位/服务图标等与详情同域同尺寸，仅靠域名+尺寸分不开）
      var descHostSel = aisDcSel('tb.desc', '#imageTextInfo-content, .desc-root, .descV8-container, .desc-v8wrap, #J_DivItemDesc, #desc-lazy, #description, [class*="descV8"], [class*="Description--"], [class*="detail-desc"], [class*="item-desc"], [class*="goods-desc"]');
      var badBoxRe = new RegExp(aisSel('common.descBadBoxRe', 'review|comment|rate-|rating|feedback|recommend|guess|like|similar|coupon|service|nav|crumbs|footer|header|shop-card|seller|anchor|params|property'), 'i');
      var inBadBox = function (el) {
        var p = el, n = 0;
        while (p && n++ < 12) {
          var cn = String(p.className || '') + ' ' + String(p.id || '');
          if (badBoxRe.test(cn)) return true;
          p = p.parentElement;
        }
        return false;
      };
      var inDescBox = function (el) {
        var p = el, n = 0;
        while (p && n++ < 12) {
          try { if (p.matches && p.matches(descHostSel)) return true; } catch (eM) {}
          p = p.parentElement;
        }
        return false;
      };
      var hasDescBox = false;
      try { hasDescBox = !!document.querySelector(descHostSel); } catch (eH) {}
      var added = 0;
      var all = document.querySelectorAll('img');
      for (var i = 0; i < all.length; i++) {
        var im = all[i];
        var u = genericPickSrc(im);
        if (!u || badRe.test(u) || !hostRe.test(u)) continue;
        if (inBadBox(im)) continue;                                // v1.2.322：排除评价/推荐/服务等容器
        if (hasDescBox && !inDescBox(im)) continue;                // v1.2.322：页面有详情容器时，只认容器内的图
        var r = im.getBoundingClientRect();
        var ay = r.top + (window.pageYOffset || 0);
        if (ay < yTop) continue;                                  // 排除头部主图/推荐位
        var le = Math.max(im.naturalWidth || r.width || 0, im.naturalHeight || r.height || 0);
        if (le && le < minEdge) continue;                          // 排除小图标/占位
        if (state.main.indexOf(u) > -1 || state.sku.indexOf(u) > -1) continue;
        if (state.desc.indexOf(u) > -1) continue;
        state.desc.push(u); added++;
      }
      try { window.__AIS_DESC_COUNT__ = state.desc.length; } catch (eC) {}
      return added;
    } catch (eG) { return 0; }
  }
  // v1.2.317 通用滚动：300ms/步、≤14 步、连续 3 步无新增即停，结束滚回原位
  function genericDescLazyLoad() {
    try {
      if (window.__AIS_DESC_LAZY_RUNNING__) return;
      window.__AIS_DESC_LAZY_RUNNING__ = 1;
      var y0 = window.pageYOffset || 0;
      var step = 0, idle = 0, MAX = 14;
      // v1.2.319：步长必须覆盖整页（淘宝详情页可达 2.7 万 px，固定 700px×14 步只到 9800px，永远滚不到 45% 以下的详情图）
      var pageH = Math.max(document.documentElement.scrollHeight || 0, (document.body && document.body.scrollHeight) || 0);
      var stepPx = Math.max(700, Math.ceil(pageH / 12));
      genericDomDescImages();
      var t = setInterval(function () {
        step++;
        try {
          window.scrollTo(0, Math.min(pageH, y0 + step * stepPx));
          var added = genericDomDescImages();
          if (added > 0) idle = 0; else idle++;
          if (idle >= 3 || step >= MAX) {
            clearInterval(t);
            try { window.scrollTo(0, y0); } catch (e1) {}
            window.__AIS_DESC_LAZY_RUNNING__ = 0;
            try { render(); } catch (eR) {}
            try { if (state.desc.length) status('详情图滚动采集完成：' + state.desc.length + ' 张', true); } catch (eS2) {}
          }
        } catch (eT) { clearInterval(t); window.__AIS_DESC_LAZY_RUNNING__ = 0; try { window.scrollTo(0, y0); } catch (eT2) {} }
      }, 300);
    } catch (eL) { window.__AIS_DESC_LAZY_RUNNING__ = 0; }
  }
  function jdDomImages() {
    try {
      if (!/\.jd\.com$/.test(location.hostname)) return;
      // 主图/画廊 → state.main（v1.1.73：优先真画廊轮播容器，避免横幅/logo 混入；找到后替换而非累加，清掉 API 兜底杂质）
      var found = [];
      [aisSel('jd.gallery', '.image-carousel.vertical.thumbnails img, .preview-wrap .main-img img, img#spec-img')].forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (im) {
          if (/play-icon|skeleton/i.test(String(im.className || ''))) return;
          var u = jdImgUp(im.getAttribute('src') || im.getAttribute('data-lazy-img') || im.getAttribute('data-src') || '');
          if (u && /\/jfs\//.test(u)) found.push(u);
        });
      });
      found = found.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
      if (!found.length) {
        document.querySelectorAll('.preview-wrap img.image').forEach(function (im) {
          if (/play-icon|skeleton/i.test(String(im.className || ''))) return;
          var u = jdImgUp(im.getAttribute('src') || im.getAttribute('data-lazy-img') || im.getAttribute('data-src') || '');
          if (u && /\/jfs\//.test(u)) found.push(u);
        });
        found = found.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
      }
      if (found.length) state.main = uniq(found).slice(0, 30);
      // 详情楼层长图（v1.1.147：容器级判定放宽——楼层/详情容器内均收，兼容新旧模板与懒加载属性）
      var dsc = [];
      // v1.2.250：层0 与层2/层3 共用同一套过滤（尺寸门槛 + 推荐卡排除 + imagetools 图标封禁）。
      // 层0 此前**没有任何过滤**；v1.2.249 修掉 this.log 崩溃后它才第一次真正生效（命中 >=3 即压掉层2/3），
      // 于是推荐卡图/小图标被当成详情图采入 —— 实测表现为「京东详情图采集到无关图片」。
      var dscSeen = {};
      var descImgOk = function (u2) {
        if (!u2 || !/\/jfs\//.test(u2) || dscSeen[u2]) return false;
        if (new RegExp(aisSel('jd.iconDomain', '/imagetools/')).test(u2)) return false; // v1.2.258：封禁域可远程覆盖（babel 是详情图 CDN 本身，只封 imagetools 图标）
        return true;
      };
      var bigEnough = function (im) {
        var w2 = im.naturalWidth || im.width || (parseInt(im.getAttribute('width'), 10) || 0);
        var h2 = im.naturalHeight || im.height || (parseInt(im.getAttribute('height'), 10) || 0);
        if (!w2 || !h2) return true; // 未加载出的懒图不因尺寸被排除
        return w2 >= aisNum('jd.minW', 300) && h2 >= aisNum('jd.minH', 200); // v1.2.258 门槛可远程覆盖
      };
      // v1.2.251：排除判定同时覆盖「商品链接/推荐位」与「装修/福袋/连续推荐/搭配」两类容器
      var inRecommend = function (im) {
        try {
          if (!im.closest) return false;
          if (im.closest(aisSel('jd.excludeAnchor', 'a[href*="item.jd.com"], a[href*="//item.jd"], a[href*="npcitem.jd"], [class*="recommend"]'))) return true;
          if (im.closest(aisSel('jd.descExclude', '[class*="jdmcc"], [class*="continuous-product"], [class*="recommend"], [class*="Recommend"], [class*="similar"], [class*="expert-selection"], #waist-root, [class*="waist"], [class*="elevator"], [class*="Elevator"]'))) return true;
          return false;
        } catch (eR) { return false; }
      };
      // v1.2.249：详情容器并入搞图宝实测的 #J-detail-content / #shadowHost / .wdis-content / .ssd-module；
      // 容器与父级判定都走锚点注册表（jd.descBox / jd.descBoxParent），站点改版只改远程规则
      document.querySelectorAll(aisSel('jd.descBox', 'img.shop-editor-floor, #detail-main img, .ssd-module-wrap img, .ssd-module img, #detail .content img, .detail-content img, #J-detail-content img, #shadowHost img, .wdis-content img')).forEach(function (im) {
        var inBox = /shop-editor-floor/i.test(String(im.className || '')) ||
          (im.closest && im.closest(aisSel('jd.descBoxParent', '#detail-main, .ssd-module-wrap, .ssd-module, #detail .content, .detail-content, #J-detail-content, #shadowHost, .wdis-content')));
        if (!inBox) return;
        if (!bigEnough(im)) return;      // v1.2.250：小图标/装饰图
        if (inRecommend(im)) return;     // v1.2.250：推荐卡图
        var u = jdImgUp(im.getAttribute('src') || im.getAttribute('data-src') || im.getAttribute('data-lazyload') || im.getAttribute('data-lazy-img') || '');
        if (!descImgOk(u)) return;
        dscSeen[u] = 1; dsc.push(u);
      });
      // v1.2.254：JD 新版详情模块把详情图渲染为 CSS background-image（不是 <img>）。
      // 实测 #detail-main 内 10 个 .ssd-module（958x840），而 <img> 数量为 0 —— 只扫 img 必然采不到。
      // 有界：最多检查 400 个元素，且要求元素渲染尺寸 >=300x200。
      try {
        var bgBoxes = document.querySelectorAll(aisSel('jd.descBgBox', '#detail-main *, .ssd-module-wrap *, [class*="ssd-module"] *, [id*="detail-main"] *, #J-detail-content *, #shadowHost *, .wdis-content *'));
        var bgChecked = 0, bgMax = aisNum('jd.bgScanMax', 400); // v1.2.258 扫描上限/门槛可远程覆盖
        var bgMinW = aisNum('jd.bgMinW', 300), bgMinH = aisNum('jd.bgMinH', 200);
        Array.prototype.forEach.call(bgBoxes, function (el) {
          if (bgChecked >= bgMax) return;
          bgChecked++;
          var r = null;
          try { r = el.getBoundingClientRect(); } catch (eB0) { return; }
          if (!r || r.width < bgMinW || r.height < bgMinH) return;
          if (inRecommend(el)) return;
          var bu = jdImgUp(bgImageUrl(el));
          if (!descImgOk(bu)) return;
          dscSeen[bu] = 1; dsc.push(bu);
        });
      } catch (eBg) {}
      dsc = dsc.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
      // v1.2.251 纠正：真详情容器是 #detail-main（实测 21 张 790x1513 长图在其内）。
      // 原锚点 jdmccBagWrap 实为「京东魔方 jdmcc 福袋营销组件」，采出来是 339x339 装修图 —— 已弃用。
      // v1.2.257：容器型来源改为「并集」——不再「先命中就先压制后续」。
      // 任一个容器选择器失效时其余仍能兜住（v1.2.251 之前正是「一个错锚点压制整条链路」酿成事故）。
      if (/jd\.com|3\.cn/.test(location.href)) {
        var bagSeen = {}, bagImgs = [];
        document.querySelectorAll(aisSel('jd.descBag', '#detail-main img, [id*="detail-main"] img')).forEach(function (bim) {
          var bu = jdImgUp(bim.getAttribute('src') || bim.getAttribute('data-lazyload') || bim.getAttribute('data-src') || bim.getAttribute('data-original') || bim.getAttribute('data-lazy-img') || '');
          if (!bu || !/\/jfs\//.test(bu) || bagSeen[bu]) return;
          var bw = bim.naturalWidth || bim.width || 0, bh = bim.naturalHeight || bim.height || 0;
          var bagMin = aisNum('jd.bagMinPx', 250); // v1.2.258 门槛可远程覆盖
          if (bw && (bw < bagMin || (bh && bh < bagMin))) return;
          bagSeen[bu] = 1; bagImgs.push(bu);
        });
        if (bagImgs.length) {
          // v1.2.249：此处原为 this.log(...) —— jdDomImages 是普通函数且本文件 'use strict'，
          // this 为 undefined，必抛 TypeError 并被下方 catch 吞掉，导致 5829 行之后的
          // 层2/层3 兜底、mergeDesc(dsc) 与 JD SKU 色卡图采集全部跳过（JD 详情图/SKU图恒为空）。
          bagImgs.forEach(function (u5) { dsc.push(u5); });
        }
      }
      // v1.1.168/170：京东新版详情楼层语义兜底（抗改版）。
      // v1.1.170 实测修订：elevator 容器是楼层导航（60×60 图标）、babel 是营销 banner——
      // 按尺寸（≥300×200）+ 域（排除 babel/imagetools）过滤，聚簇改为「图数最多的连续簇」
      // v1.2.257：层2（detail 命名族）改为无条件并集（原为 if (dsc.length < 3)）；
      // 仅层3（全页位置启发式，噪音大）保留门槛。
      {
        // v1.2.250：descImgOk/bigEnough 已上提到层0 之前共用；此处只补登记已有图，勿重置 dscSeen
        dsc.forEach(function (u4) { dscSeen[u4] = 1; });
        document.querySelectorAll(aisSel('jd.descFloor', '[id*="detail"] img, [class*="detail"] img')).forEach(function (im) {
          if (!bigEnough(im)) return;
          if (inRecommend(im)) return; // v1.2.251：统一走 inRecommend（含装修/推荐/搭配排除）
          var u2 = jdImgUp(im.getAttribute('src') || im.getAttribute('data-lazyload') || im.getAttribute('data-src') || im.getAttribute('data-original') || im.getAttribute('data-lazy-img') || '');
          if (!descImgOk(u2)) return;
          dscSeen[u2] = 1; dsc.push(u2);
        });
        if (dsc.length < 3) {
          var bigs2 = [];
          document.querySelectorAll('img').forEach(function (im2) {
            var u3 = jdImgUp(im2.getAttribute('src') || im2.getAttribute('data-lazyload') || im2.getAttribute('data-src') || im2.getAttribute('data-original') || im2.getAttribute('data-lazy-img') || '');
            if (!descImgOk(u3)) return;
            if (inRecommend(im2)) return; // v1.2.251：层3 扫全页 img，必须排除装修/推荐区
            if (!bigEnough(im2)) return;
            var top2 = 0; try { top2 = im2.getBoundingClientRect().top + (window.pageYOffset || 0); } catch (eC) {}
            if (top2 > (window.innerHeight || 800) * 1.2) bigs2.push({ u: u3, top: top2 });
          });
          bigs2.sort(function (a, b) { return a.top - b.top; });
          // 连续簇切分（相邻间距 < 2.5 屏），取图数最多的簇（详情楼层 = 连续多张长图）
          var runs2 = [], run2 = [];
          for (var bi2 = 0; bi2 < bigs2.length; bi2++) {
            if (!run2.length) { run2.push(bigs2[bi2]); continue; }
            if (bigs2[bi2].top - run2[run2.length - 1].top < (window.innerHeight || 800) * 2.5) run2.push(bigs2[bi2]);
            else { runs2.push(run2); run2 = [bigs2[bi2]]; }
          }
          if (run2.length) runs2.push(run2);
          var best2 = null;
          for (var ri2 = 0; ri2 < runs2.length; ri2++) {
            if (runs2[ri2].length < 3) continue;
            if (!best2 || runs2[ri2].length >= best2.length) best2 = runs2[ri2];
          }
          (best2 || []).forEach(function (c2) { if (!dscSeen[c2.u]) { dscSeen[c2.u] = 1; dsc.push(c2.u); } });
        }
      }
      if (dsc.length) { try { mergeDesc(dsc); } catch (e0) {} }
      // 被动观察：详情楼层渐次插入时自动补收（纯观察零行为；防抖 800ms；v1.1.74）
      if (!window.__AIS_JD_DESC_OBS__) {
        window.__AIS_JD_DESC_OBS__ = 1;
        var jt = 0;
        try {
          new MutationObserver(function () {
            clearTimeout(jt);
            jt = setTimeout(function () {
              try {
                var before = (state.desc ? state.desc.length : 0) + (state.main ? state.main.length : 0);
                jdDomImages();
                if ((state.desc ? state.desc.length : 0) + (state.main ? state.main.length : 0) !== before) render();
              } catch (e3) {}
            }, 800);
          }).observe(document.body || document.documentElement, { childList: true, subtree: true });
        } catch (e2) {}
      }
      // SKU 规格色卡图 → state.sku + skuValueImgs（alt = 规格名）
      var skus = [], vi = [];
      // v1.2.259：规格容器里常混入 avif 超小图（占位/图标）。判据：URL 尺寸前缀 /s{n}x{n}_jfs/
      //（未加载也能判）+ natural 尺寸双保险；阈值可远程覆盖（registry jd.skuMinPx）。
      var skuMin = aisNum('jd.skuMinPx', 32);
      document.querySelectorAll(aisSel('jd.specImg', '.page-right-spec img, [class*="specification"] img, [class*="specification-item-sku"] img')).forEach(function (im) {
        // v1.1.168：放宽类名门槛——新京东选项 img 类名不固定，命中规格容器即收
        var inSpec = /specification-item-sku-image|spec/i.test(String(im.className || '')) || (im.closest && im.closest('[class*="specification-item-sku"], .page-right-spec, [class*="specification-item"]'));
        if (!inSpec) return;
        var rawSrc = im.getAttribute('src') || im.getAttribute('data-src') || '';
        var mSize = String(rawSrc).match(/\/s(\d+)x(\d+)_jfs\//i);
        if (mSize && (parseInt(mSize[1], 10) < skuMin || parseInt(mSize[2], 10) < skuMin)) return; // 超小图
        var nw = im.naturalWidth || 0, nh = im.naturalHeight || 0;
        if (nw && nh && (nw < skuMin || nh < skuMin)) return;                                      // 超小图
        var u = jdImgUp(rawSrc);
        if (!u || !/\/jfs\//.test(u)) return;
        skus.push(u);
        vi.push({ name: '', value: String(im.getAttribute('alt') || '').trim(), image: u });
      });
      skus = skus.filter(function (u, i, a) { return u && a.indexOf(u) === i; });
      if (skus.length) {
        state.sku = uniq(skus.concat(state.sku || []));
        if (!state.skuValueImgs || !state.skuValueImgs.length) state.skuValueImgs = vi;
      }
    } catch (e) {}
  }
  // v1.2.248：CSS background-image 取图——覆盖主图/详情图以背景图渲染的页面（以背景图渲染的商品页）
  function bgImageUrl(el) {
    try {
      if (!el) return '';
      var st = null;
      try { st = getComputedStyle(el); } catch (e0) { return ''; }
      var bg = st && st.backgroundImage;
      if (!bg || bg === 'none' || bg.indexOf('url(') < 0) return '';
      var m = bg.match(/url\(["']?([^"')]+)["']?\)/);
      if (!m) return '';
      var u = abs(m[1]);
      if (!u || !/\.(jpe?g|png|webp|gif)/i.test(u)) return '';
      if (/(?:logo|icon|avatar|sprite)/i.test(u)) return '';
      return u;
    } catch (e) { return ''; }
  }
  function domFallbackMain() {
    try {
      var found = [];
      // v1.2.258：选择器列表 / 背景图候选框 / 尺寸门槛 均可远程覆盖（registry common.*）
      var sels = aisArr('common.mainBox', ['#J_UlThumb img', '.PicGallery--thumbs img', '[class*="thumbnail"] img', '[class*="Thumb"] img', '[class*="gallery"] img', 'img[src*="alicdn.com/img/ibank"]']);
      sels.forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (im) {
          // v1.2.248：归一化 alicdn 尺寸后缀——原逻辑直接取 #J_UlThumb img（缩略图条）会把缩略图当原图存下
          var u = aliUp(im.getAttribute('src') || im.getAttribute('data-src') || '');
          if (u && /\.(jpg|jpeg|jfif|png|webp|avif|bmp)/i.test(u) && !/(?:logo|icon|avatar)/i.test(u)) found.push(u);
        });
      });
      // v1.2.248：CSS background-image 通道（尺寸门槛 200x200 防装饰图/横幅误入）
      var bgMin = aisNum('common.bgMinPx', 200);
      aisArr('common.bgBox', ['[class*="gallery"]', '[class*="Gallery"]', '[class*="media-view"]', '[class*="head-figure"]', '[class*="main-img"]', '[class*="preview-wrap"]']).forEach(function (sel) {
        document.querySelectorAll(sel).forEach(function (el) {
          var w = el.clientWidth || 0, h = el.clientHeight || 0;
          if (w < bgMin || h < bgMin) return;
          var u = bgImageUrl(el);
          if (u) found.push(u);
        });
      });
      state.main = uniq(state.main.concat(found)).slice(0, 30);
    } catch (e) {}
  }
  // ===== v1.2.327 自适应取图（主图 / SKU 图）：抗平台改版 =====
  // 起因：京东改版后 #J_UlThumb / [class*="thumbnail"] / .specification-item-sku 全落空，
  //       主图与 SKU 图恒为空（详情图走的是另一套已自适应的逻辑，反而正常）。
  // 设计：把「主图/SKU 图」判成「尺寸 × 形状 × 位置 × 容器语义 × 图床」的函数，而不是类名表。
  //   主图  = 方形（0.65~1.5）、边长≥260、页面靠上、非推荐/评价区 → 取最靠上的一簇
  //   SKU图 = 小方图（20~320）成簇（同父容器≥2 张）或位于页面上部 → 升到原图后入库
  // 通道：<img> 全属性（src/data-*/srcset/currentSrc）+ 背景图（色卡常无 <img>）
  function aisSrcsetBest(v) {
    var parts = String(v || '').split(','), best = '', bestW = -1;
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i].trim(); if (!seg) continue;
      var bits = seg.split(/\s+/), w = 0;
      var m1 = String(bits[1] || '').match(/^(\d+)w$/); if (m1) w = parseInt(m1[1], 10);
      var m2 = String(bits[1] || '').match(/^(\d+(?:\.\d+)?)x$/); if (m2) w = Math.round(parseFloat(m2[1]) * 1000);
      if (w >= bestW) { bestW = w; best = bits[0]; }
    }
    return best;
  }
  function aisImgAttrsUrl(im) {
    var a = ['data-lazyload', 'data-lazy-img', 'data-lazy-src', 'data-src', 'data-original',
             'data-img', 'data-url', 'data-ks-lazyload', 'data-echo', 'data-origin', 'srcset', 'src'];
    for (var i = 0; i < a.length; i++) {
      var v = im.getAttribute && im.getAttribute(a[i]);
      if (!v) continue;
      if (v.indexOf('data:') === 0) continue;
      if (a[i] === 'srcset') { var b = aisSrcsetBest(v); if (b) return b; continue; }
      return v;
    }
    try { if (im.currentSrc) return im.currentSrc; } catch (eCS) {}
    // v1.2.331：兜底——把元素上【所有】属性值里像图片 URL 的都试一遍（懒加载属性名未知/改版时唯一稳的路子）
    try {
      var at = im.attributes || [];
      for (var k = 0; k < at.length; k++) {
        var av = String((at[k] && at[k].value) || '').trim();
        if (av.length < 12 || av.indexOf('data:') === 0) continue;
        if (av.indexOf(' ') > 0) { var bb = aisSrcsetBest(av); if (bb) return bb; }
        if (/^(?:https?:)?\/\/[^\s"']+\.(?:jpg|jpeg|png|webp|avif|gif)/i.test(av)) return av;
      }
    } catch (eAV) {}
    return '';
  }
  function aisBgUrl(el) {
    try {
      var bi = getComputedStyle(el).backgroundImage;
      if (!bi || bi === 'none') return '';
      var m = bi.match(/url\(["']?([^"')]+)["']?\)/i);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }
  // 去重键：抹掉尺寸后缀与查询串（同一张图的多种尺寸视为一张）
  function aisImgIdent(u) {
    return String(u || '').replace(/^https?:/, '').replace(/\/[sn]\d+x\d+[^/]*_?/g, '/').replace(/[?#].*$/, '');
  }
  // 升原图：京东 jfs 的 sNNNxNNN_jfs 还原为 /jfs/（改版不影响图床规则）
  function aisImgUp(u) {
    if (!u) return '';
    if (/360buyimg\.com/.test(u)) {
      return u.replace(/s\d+x\d+[^/]*_jfs/g, 'jfs').replace(/!q\d+(?=\.(?:jpg|jpeg|png|webp|avif))/i, '');
    }
    // v1.2.342：阿里系（淘宝/天猫/1688）走 aliUp 还原原图 —— 此前只处理京东，
    // 自适应扫描抓到 alicdn 缩略图（_60x60.jpg / _.webp / .jpg_400x400.jpg）也原样入库。
    if (/alicdn\.com/.test(u)) { try { return aliUp(u); } catch (eA) { return u; } }
    return u;
  }
  // v1.2.344：入库前第一道闸——过滤「明显打不开/占位」的图（真机 1688 实测：自适应通道混入 2 张打不开的 UI 图，显示成「SKU图 3/4」破图）
  function aisImgUsable(u) {
    var s = String(u || '');
    if (!s || s.indexOf('data:') === 0 || !/^https?:/i.test(s)) return false;
    if (/(^|[\/._-])(blank|loading|placeholder|nopic|spacer|transparent|default)([._-]|\.)/i.test(s)) return false;
    if (/alicdn\.com\/tps\//i.test(s) && !/\.(?:jpg|jpeg|png|webp|avif)/i.test(s)) return false;   // 阿里 tps 下多为图标/占位
    // v1.2.345：广告/推广位图（真机 1688 实测：.../-2-gg_dtc.png 成排出现 → 被自适应当色卡，显示为无标签「SKU图 1/2」）
    if (/(^|[\/._-])(gg|ad|adv|ads|banner|promo|promotion)(_dtc)?([._-]|\.)/i.test(s)) return false;
    // v1.2.354：全平台可远程覆盖的噪声词库（平台改版新增占位图命名时，只改远端即可，无需发版）
    try { var __nz = aisSel('common.noiseUrl', ''); if (__nz && new RegExp(__nz, 'i').test(s)) return false; } catch (eNZ) {}
    return true;
  }
  // v1.2.347：亚马逊自适应扫描——图床/尺寸token/属性JSON/结构语义四通道，抗类名改版
  function amazonAdaptiveScan() {
    try {
      var hostsRe = new RegExp(aisSel('amazon.imgHostRe', 'media-amazon\\.com|ssl-images-amazon\\.com|images-amazon\\.com'), 'i');
      var aplusRe = new RegExp(aisSel('amazon.aplusHostRe', 'aplus-media|aplus-media-library'), 'i');
      var noise = new RegExp(aisSel('amazon.noiseUrl', 'sprite|icon|logo|loading|grey-pixel|transparent-pixel|play-icon|badge|star'), 'i');
      var dmin = aisNum('amazon.detailMinEdge', 500);
      var up = function (u) {
        var s = String(u || '').trim();
        if (!s || s.indexOf('data:') === 0) return '';
        s = abs(s);
        // 任意尺寸 token → 大图（Amazon: ._SS40_. / ._SX38_SY50_. / ._AC_UL320_. / ._AC_SL1500_.）
        s = s.replace(/\._[A-Z0-9,_]+_\.(jpg|jpeg|png|webp)/i, '._SL1500_.$1');
        return s;
      };
      var seen = {}, mains = [], skus = [], descs = [];
      function push(list, u, y) {
        var k = String(u).replace(/\._[A-Z0-9,_]+_\./i, '.');
        if (!k || seen[k]) return; seen[k] = 1; list.push({ u: u, y: y || 0 });
      }
      var docY = window.pageYOffset || 0;
      // ① data-a-dynamic-image（亚马逊主图官方属性：JSON 尺寸表）→ 主图
      try {
        var pool = document.querySelectorAll('[data-a-dynamic-image], #landingImage, #imgTagWrapperId img, #imageBlock img, [data-old-hires]');
        for (var i = 0; i < pool.length && i < 200; i++) {
          var el = pool[i], best = '';
          var dj = el.getAttribute && el.getAttribute('data-a-dynamic-image');
          if (dj) {
            try { var map = JSON.parse(dj), bw = 0; for (var mk in map) { var w = (map[mk] && map[mk][0]) || 0; if (w > bw) { bw = w; best = mk; } } } catch (eD) {}
          }
          if (!best) best = (el.getAttribute && (el.getAttribute('data-old-hires') || el.getAttribute('data-src') || el.getAttribute('src'))) || '';
          var u1 = up(best);
          if (!/^https?:/i.test(u1) || !hostsRe.test(u1) || noise.test(u1)) continue;
          var r1 = el.getBoundingClientRect ? el.getBoundingClientRect() : { top: 0 };
          push(mains, u1, r1.top + docY);
        }
      } catch (e0) {}
      // ② 变体色卡：twister/变体容器内的小尺寸图（_SS40_ 等），按容器语义限定
      try {
        var cand = document.querySelectorAll('#twister img, #variation_color_name img, [id*="variation"] img, [class*="swatch"] img, [class*="Swatch"] img, [id*="inline-twister"] img');
        for (var j = 0; j < cand.length && j < 200; j++) {
          var im2 = cand[j], u2 = up(im2.getAttribute('data-src') || im2.getAttribute('src') || '');
          if (!/^https?:/i.test(u2) || !hostsRe.test(u2) || noise.test(u2)) continue;
          var w2 = im2.naturalWidth || 0; if (w2 && w2 > 220) continue;   // 色卡通常 40~150
          var r2 = im2.getBoundingClientRect ? im2.getBoundingClientRect() : { top: 0 };
          push(skus, u2, r2.top + docY);
        }
      } catch (e1) {}
      // ③ A+ 详情：图床判据（aplus-media*）为主，容器判据为辅
      try {
        var all = document.querySelectorAll('img, [data-src], [style*="background"]');
        for (var k2 = 0; k2 < all.length && k2 < 1500; k2++) {
          var el3 = all[k2];
          var cands = [el3.getAttribute && el3.getAttribute('data-src'), el3.getAttribute && el3.getAttribute('src')];
          try { var bg = getComputedStyle(el3).backgroundImage || ''; var mb = bg.match(/url\(["']?([^"')]+)/); if (mb) cands.push(mb[1]); } catch (eB) {}
          for (var ci = 0; ci < cands.length; ci++) {
            var u3 = up(cands[ci]);
            if (!/^https?:/i.test(u3) || !hostsRe.test(u3) || noise.test(u3)) continue;
            var isAplus = aplusRe.test(u3);
            var inBox = false;
            try { if (el3.closest) inBox = !!el3.closest(aisSel('amazon.aplus', '#aplus, #aplus_feature_div, .aplus-v2, #aplus3p_feature_div')); } catch (eC) {}
            if (!isAplus && !inBox) continue;
            if (isAplus && !inBox) { var nw = el3.naturalWidth || 0, nh = el3.naturalHeight || 0; if (nw && nh && Math.max(nw, nh) < dmin) continue; }
            push(descs, u3, 0);
          }
        }
      } catch (e2) {}
      // ④ 商品属性：技术规格表 / 详情要点（结构语义，不依赖具体类名）
      try {
        var props = [];
        var tables = document.querySelectorAll('[id*="productDetails"] table tr, [id*="techSpec"] tr, [id*="detailBullets"] li, .a-keyvalue');
        for (var p3 = 0; p3 < tables.length && p3 < 200; p3++) {
          var row = tables[p3], parts = [];
          var th = row.querySelector('th, .a-text-bold, .prodDetSectionEntry, .a-color-secondary');
          var tds = row.querySelectorAll('td, .a-size-base, .prodDetAttrValue, span');
          if (th) parts.push(String(th.textContent || '').trim());
          for (var t3 = 0; t3 < tds.length && parts.length < 2; t3++) { var tx = String(tds[t3].textContent || '').trim(); if (tx && tx !== parts[0]) parts.push(tx); }
          if (parts.length === 2 && parts[0] && parts[1] && parts[0].length < 40 && parts[1].length < 120) props.push({ name: parts[0].replace(/[:：]$/, ''), value: parts[1] });
        }
        if (props.length && (!state.itemProps || !state.itemProps.length)) state.itemProps = props.slice(0, 60);
      } catch (e3) {}
      if (mains.length) state.main = uniq(state.main.concat(mains.sort(function (a, b) { return a.y - b.y; }).slice(0, 30).map(function (m) { return m.u; })));
      if (skus.length) state.sku = uniq(state.sku.concat(skus.slice(0, 60).map(function (s) { return s.u; })));
      if (descs.length && !state.__amzDescLocked) state.desc = uniq(state.desc.concat(descs.slice(0, 80).map(function (s) { return s.u; })));
      try { window.__AIS_AMZ_ADAPTIVE__ = { main: mains.length, sku: skus.length, desc: descs.length }; } catch (e4) {}
    } catch (eAll) {}
  }
  function adaptiveImgScan() {
    try {
      var mains = [], skus = [], seenM = {}, seenS = {};
      var vh = window.innerHeight || 800, docY = window.pageYOffset || 0;
      function add(list, seen, u, y, w, h, el) {
        var k = aisImgIdent(u); if (!k || seen[k]) return;
        seen[k] = 1; list.push({ u: u, y: y, w: w, h: h, el: el });
      }
      // ① <img> 通道
      // v1.2.342：阈值远程化（京东主图 800 / 天猫·1688 画廊常见 400~800 / 色卡 60~120）——改版时无需发版即可调
      var __aMainMin = aisNum('common.adaptiveMainMinPx', 220);
      var __aSkuMax = aisNum('common.adaptiveSkuMaxPx', 320);
      var imgs = document.querySelectorAll('img');
      for (var i = 0; i < imgs.length && i < 2000; i++) {
        var im = imgs[i];
        var raw = aisImgAttrsUrl(im); if (!raw) continue;
        var u = aisImgUp(abs(raw)); if (!u || !/^https?:/i.test(u)) continue;
        // v1.2.342：噪声词扩展（阿里系店铺装修/占位图常见命名）
        if (/logo|icon|avatar|sprite|erweima|\bqr\b|qrcode|loading|placeholder|blank|nopic|shoplogo|customer|kefu/i.test(u)) continue;
        var r = im.getBoundingClientRect();
        var w = im.naturalWidth || r.width || 0, h = im.naturalHeight || r.height || 0;
        if (w < 8 || h < 8) continue;
        try { if (typeof inRecommend === 'function' && inRecommend(im)) continue; } catch (e0) {}
        var ratio = w / h, y = r.top + docY;
        if (w >= __aMainMin && h >= __aMainMin && ratio > 0.65 && ratio < 1.5) add(mains, seenM, u, y, w, h, im);
        else if (w >= 20 && h >= 20 && w <= __aSkuMax && h <= __aSkuMax && ratio > 0.65 && ratio < 1.5) add(skus, seenS, u, y, w, h, im);
      }
      // ①b <picture><source srcset> 通道（改版常把真实地址挂在 source 上，<img> 只剩占位）
      try {
        var pics = document.querySelectorAll('picture source[srcset], picture source[data-srcset], source[type="image/webp"]');
        for (var p = 0; p < pics.length && p < 300; p++) {
          var se = pics[p];
          var su = aisImgUp(abs(aisSrcsetBest(se.getAttribute('srcset') || se.getAttribute('data-srcset') || '') || se.getAttribute('src') || ''));
          if (!su || !/^https?:/i.test(su)) continue;
          var host = se.parentElement || se;
          var hEl = (host.querySelector && host.querySelector('img')) || host;
          var hr = hEl.getBoundingClientRect ? hEl.getBoundingClientRect() : null;
          if (!hr || hr.width < 20 || hr.height < 20) continue;
          var hratio = hr.width / hr.height;
          if (hratio < 0.5 || hratio > 2) continue;
          if (hr.width >= 200 && hr.height >= 200) add(mains, seenM, su, hr.top + docY, hr.width, hr.height, hEl);
          else add(skus, seenS, su, hr.top + docY, hr.width, hr.height, hEl);
        }
      } catch (ePic) {}
      // ①c 图床兜底：在【任意元素任意属性】里找 360buyimg/jfs/alicdn 图（属性名无关，尺寸未知也收）
      if (!mains.length) {
        try {
          var pool = document.querySelectorAll('[data-lazyload],[data-lazy-img],[data-lazy-src],[data-src],[data-original],[data-img],[srcset],[style]');
          for (var q = 0; q < pool.length && q < 1500; q++) {
            var qe = pool[q];
            var qa = qe.attributes || [];
            for (var qi = 0; qi < qa.length; qi++) {
              var qv = String(qa[qi].value || '');
              var mm = qv.match(/https?:\/\/[^\s"'()]+?\.(?:jpg|jpeg|png|webp|avif)/i);
              if (!mm) continue;
              var qu = aisImgUp(mm[0]);
              if (!/(360buyimg|\/jfs\/|alicdn)/.test(qu)) continue;
              if (/logo|icon|avatar|sprite|erweima/i.test(qu)) continue;
              var qr = qe.getBoundingClientRect ? qe.getBoundingClientRect() : { top: 0, width: 400, height: 400 };
              add(mains, seenM, qu, qr.top + docY, Math.max(qr.width || 0, 400), Math.max(qr.height || 0, 400), qe);
              break;
            }
          }
        } catch (ePool) {}
      }
      // ② 背景图通道（色卡/规格图常无 <img>）
      var boxes = document.querySelectorAll('[class*="spec"],[class*="Spec"],[class*="sku"],[class*="Sku"],[class*="color"],[class*="Color"],[class*="size"],[class*="Size"],[class*="thumb"],[class*="Thumb"],[class*="option"],[class*="Option"]');
      for (var b = 0; b < boxes.length && b < 600; b++) {
        var el = boxes[b];
        var u2 = aisImgUp(abs(aisBgUrl(el))); if (!/^https?:/i.test(u2)) continue;
        var r2 = el.getBoundingClientRect(), w2 = r2.width, h2 = r2.height;
        if (w2 < 16 || h2 < 16 || w2 > 360 || h2 > 360) continue;
        var ratio2 = w2 / h2;
        if (ratio2 < 0.6 || ratio2 > 1.6) continue;
        try { if (typeof inRecommend === 'function' && inRecommend(el)) continue; } catch (e1) {}
        add(skus, seenS, u2, r2.top + docY, w2, h2, el);
      }
      // ③ 主图：最靠上的一簇（画廊一定在首屏附近）
      if (mains.length) {
        mains.sort(function (a, b) { return a.y - b.y; });
        var near = mains.filter(function (m) { return m.y < vh * 4; });
        var pickM = (near.length >= 3 ? near : mains).slice(0, 30).map(function (m) { return m.u; }).filter(aisImgUsable);   // v1.2.344 过闸
        state.main = uniq(state.main.concat(pickM)).slice(0, 30);
      }
      if (!state.main.length) {
        var og = document.querySelector('meta[property="og:image"], meta[name="og:image"]');
        if (og) { var ou = abs(String(og.getAttribute('content') || '')); if (/^https?:/i.test(ou)) state.main = [ou]; }
      }
      // ④ SKU 图：成簇优先（同父容器≥2），否则页面上部的小方图
      if (skus.length) {
        var order = [], groups = {};
        skus.forEach(function (s) {
          var p = (s.el && s.el.parentElement) || null;
          if (!p) return;
          var idx = order.indexOf(p);
          if (idx < 0) idx = order.push(p) - 1;
          (groups[idx] = groups[idx] || []).push(s);
        });
        var lists = Object.keys(groups).map(function (k) { return groups[k]; });
        lists.sort(function (a, b) { return b.length - a.length; });
        var clustered = [];
        lists.forEach(function (g) { if (g.length >= 2 && clustered.length < 60) clustered = clustered.concat(g); });
        // v1.2.344：只收【成排（≥2）同容器】的色卡簇 + 通过入库闸；不再回落到「零散单图」——
        // 真机 1688 上正是零散单图混入打不开的 UI 图（破图 + 无标签「SKU图 N」）。
        // v1.2.345：真机实测——1688 平台通道已拿到 5 个真实色卡时，本通道仍把【成排的广告图】追加进 SKU
        // （显示为无标签「SKU图 1/2」，用户截图来源）。故本通道改为「仅当平台通道一个 SKU 图都没有」时才启用。
        var __skuHad = (state.sku || []).length > 0 || (state.skuValueImgs || []).length > 0;
        var src = __skuHad ? [] : clustered.filter(function (s) { return aisImgUsable(s.u); });
        if (src.length) {
          state.sku = uniq(state.sku.concat(src.slice(0, 60).map(function (s) { return s.u; }))).slice(0, 60);
          if (!state.skuValueImgs || !state.skuValueImgs.length) {
            try {
              state.skuValueImgs = src.slice(0, 60).map(function (s) {
                var el2 = s.el, nm2 = '';
                try {
                  nm2 = String((el2 && (el2.getAttribute('alt') || el2.getAttribute('title'))) || '').trim();
                  if (!nm2 && el2 && el2.closest) {
                    var pr2 = el2.closest('label,[class*="sku"],[class*="spec"],[class*="color"],[class*="Color"]');
                    if (pr2) nm2 = String(pr2.getAttribute('title') || pr2.textContent || '').trim().split('\n')[0].slice(0, 24);
                  }
                } catch (eN) {}
                return { name: '', value: nm2, image: s.u };
              }).filter(function (v) { return v && v.image; });
            } catch (eV) {}
          }
        }
      }
      try {
        window.__AIS_ADAPTIVE__ = { main: (state.main || []).length, sku: (state.sku || []).length, candMain: mains.length, candSku: skus.length };
      } catch (e2) {}
    } catch (e) {}
  }
  // v1.2.248：淘宝/天猫视频直链确定性构造——不依赖 URL 恰好明文出现在脚本里。
  // 来源：meta[name=microscope-data] 的 userid + 页面脚本里的 videoId/imgVedioID/userId，
  // 以及 valFlashUrl 里的 swf 地址改写为 mp4（老式通道）。
  function taobaoVideoFromPage() {
    try {
      if (!/(^|\.)(taobao|tmall)\.com$/.test(location.hostname)) return '';
      var userId = '', videoId = '', flash = '';
      var meta = document.querySelector('meta[name="microscope-data"]');
      if (meta) {
        var mc = String(meta.getAttribute('content') || '');
        var mu = mc.match(/userid=(\d+)/i);
        if (mu) userId = mu[1];
      }
      var scripts = document.scripts || [];
      for (var i = 0; i < scripts.length; i++) {
        var t = scripts[i].textContent || '';
        if (!t || t.length > 4000000) continue;
        if (!videoId) { var m2 = t.match(/"videoId"\s*:\s*"?(\d+)/); if (m2) videoId = m2[1]; }
        if (!videoId) { var m3 = t.match(/"imgVedioID"\s*:\s*"?(\d+)/); if (m3) videoId = m3[1]; }
        if (!userId) { var m4 = t.match(/"userId"\s*:\s*"?(\d+)/); if (m4) userId = m4[1]; }
        if (!flash) { var m5 = t.match(/"valFlashUrl"\s*:\s*"([^"]+)"/); if (m5) flash = m5[1]; }
        if (userId && videoId) break;
      }
      if (flash) {
        var mp4 = flash.replace(/\/\/cloud\.video\.taobao\.com\/play\/u\/(\d+)\/p\/(\d+)\/e\/\d+\/t\/\d+\/(.+?)\.(?:swf|mp4)$/,
          '//cloud.video.taobao.com/play/u/$1/p/$2/e/6/t/1/$3.mp4');
        if (mp4.indexOf('//') === 0) mp4 = 'https:' + mp4;
        if (mp4.indexOf('.mp4') > 0) return mp4;
      }
      if (userId && videoId) {
        return 'https://cloud.video.taobao.com/play/u/' + userId + '/p/1/e/6/t/1/' + videoId + '.mp4';
      }
    } catch (e) {}
    return '';
  }
  function domFallbackVideo() {
    try {
      if (state.video) return;
      // v1.2.248：先用确定性构造，拿不到再退回 DOM <video>
      var tv = taobaoVideoFromPage();
      if (tv) { addVideo(tv); try { render(); } catch (e0) {} return; }   // v1.2.292
      var v = document.querySelector('video source, video');
      var u = v && (v.getAttribute('src') || '');
      if (u && /^https?:/.test(u)) addVideo(u);   // v1.2.292
    } catch (e) {}
  }
  function nudgeLazyVideo() {
    // 详情视频多为 hover 才注入 src：每轮重新查询 video 节点（可能后插入），模拟 hover 并促加载
    try {
      if (state.video) return;
      var tries = 0;
      var tick = setInterval(function () {
        tries++;
        var v = document.querySelector('video');
        var u = '';
        if (v) {
          u = v.getAttribute('src') || (v.querySelector('source') && v.querySelector('source').getAttribute('src')) || '';
          if (!u) { try { v.load && v.load(); } catch (e0) {} }
        }
        if (u && /^https?:/.test(u)) {
          clearInterval(tick);
          addVideo(u);   // v1.2.292
          try { render(); } catch (e3) {}
          return;
        }
        if (tries >= 12) { clearInterval(tick); return; }
        var targets = [];
        if (v) targets.push(v);
        Array.prototype.forEach.call(document.querySelectorAll('[class*="video"],[class*="player"]'), function (el) {
          if (targets.length < 6) targets.push(el);
        });
        targets.forEach(function (t) {
          var el = t;
          for (var i = 0; el && i <= 3; i++) {
            try { el.dispatchEvent(new MouseEvent('mouseenter', { cancelable: true, view: window })); } catch (e1) {}
            try { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window })); } catch (e2) {}
            el = el.parentElement;
          }
        });
      }, 500);
    } catch (e) {}
  }
  function extractVideoFromPage() {
    // 兜底：从页面脚本/全局状态里扫视频直链（hover 前不一定有 DOM video）
    try {
      if (state.video) return;
      var re = /https?:\/\/[^"'\s<>]*\.(?:mp4|mov)(?:\?[^"'\s<>]*)?/gi;
      var found = {}, urls = [];
      var add = function (u) {
        if (!u || found[u]) return;
        if (!/(?:video|taobao|alicdn|tbcdn|pddpic)/i.test(u)) return; // v1.2.194：PDD 视频域名
        if (/(?:thumb|poster|cover)/i.test(u)) return;
        found[u] = 1; urls.push(u);
      };
      Array.prototype.forEach.call(document.scripts, function (s) {
        var t = s.textContent || '';
        if (!t || t.length > 4000000) return;
        var m = t.match(re);
        if (m) m.forEach(add);
      });
      try {
        if (window.__INITIAL_STATE__) {
          var st = JSON.stringify(window.__INITIAL_STATE__);
          (st.match(re) || []).forEach(add);
        }
      } catch (e1) {}
      if (urls.length) {
        addVideo(urls[0]);   // v1.2.292
        try { render(); } catch (e2) {}
      }
    } catch (e) {}
  }
  function mergeReviews(list) {
    (list || []).forEach(function (r) { if (r) delete r.username; });
    var f = (list || []).filter(function (r) { return r && r.content && !state.reviews.some(function (x) { return x.content === r.content && x.username === r.username; }); });
    if (f.length) { state.reviews = state.reviews.concat(f); return true; }
    return false;
  }
  var revLiveLast = 0;
  function revLiveRender() {
    // 采集中实时刷新「已识别高风险评论 / 已识别购买提醒」计数条（800ms 节流，避免高频重绘）
    var now = Date.now();
    if (now - revLiveLast < 800) return;
    revLiveLast = now;
    try { renderReview(); } catch (e) {}
  }
  function analyzeReviews() {
    var S = window.__AIS_REV_STATS__ || window.__TBMA_STATS__ || null;
    if (!S || !S.analyze || !state.reviews.length) return;
    try { state.analysis = S.analyze(state.reviews); } catch (e) {}
  }
  function getRevScope() {
    var mode = 'all', limit = 50;
    var rs = D().querySelectorAll("[name=aisimg-revscope]");
    for (var i = 0; i < rs.length; i++) { if (rs[i].checked) { mode = rs[i].value; break; } }
    var li = $('aisimg-revlimit');
    if (li && li.value) limit = parseInt(li.value, 10) || 50;
    return { mode: mode, limit: limit };
  }
  // ===== v1.1.37 评论采集模板（完全照搬 tb-media-assistant/电商宝 collectReviews 流程）=====
  // 流程：点击「查看全部评价」展开 → 校验展开 → 真人节奏滚动/翻页 → API拦截+DOM多源提取+归一化去重 → 风控检测/冷却自动重试
  // v1.1.109 回退：v1.1.103 原版去重键
  function revDedupKey(v) {
    // v1.2.204：首尾联合键——旧键截前 100 字，长评（如复制粘贴式 4000 字好评）前缀相同即被误判重复丢弃；
    // 改为 前80+后40，正文不同时误删率骤降；同一条重复行正文逐字相同 → 键仍相同，去重强度不放松
    var c = String((v && v.content) || '').replace(/[^\u4e00-\u9fffA-Za-z0-9]/g, '');
    // v1.2.207：主键加时间——「此用户没有填写评价内容」等默认文本同日多条不同用户，纯文本键会误合丢失
    if (c.length >= 5) return c.slice(0, 80) + '~' + c.slice(-40) + '|' + String((v && v.time) || '');
    // v1.2.206：短评键恢复行 ID 为主——'t:时间|正文' 会把同日同文的不同用户短评误合成 1 条（淘宝/京东回归）；
    // PDD 双源（store 行与 DOM 行 ID 不同）的合并已在 worker 内完成，返回行天然唯一，DOM 行 ID 为稳定 d-hash
    return 'id:' + String((v && v.reviewId) || '') + '|' + String((v && v.time) || '') + '|' + c;
  }
  function revTimeKey(r) {
    var t = String((r && r.time) || '').trim();
    var m = t.match(/(\d{4})[-./年](\d{1,2})[-./月](\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    m = t.match(/(?:^|[^\d])(\d{1,2})[-./月](\d{1,2})日?/);
    if (m) { var y = new Date().getFullYear(); return new Date(y, +m[1] - 1, +m[2]).getTime(); }
    if (/秒前|刚刚/.test(t)) return Date.now() - 60000;
    m = t.match(/(\d+)\s*(?:分钟|小时)前/); if (m) return Date.now() - (+m[1]) * (t.indexOf('小时') > -1 ? 3600000 : 60000);
    m = t.match(/(\d+)\s*天前/); if (m) return Date.now() - (+m[1]) * 86400000;
    return NaN;
  }
  function revSortList(list) {
    // v1.1.118：与淘宝显示口径一致——按评论 id 降序（新→旧，id 为雪花型单调值）；
    // 无 id（DOM 提取缺失）的退回时间排序并排在有 id 之后，保持稳定。
    var keyed = (list || []).map(function (r, i) {
      var idn = parseInt(String((r && r.reviewId) || '').replace(/\D/g, ''), 10);
      return { r: r, id: isNaN(idn) ? 0 : idn, t: revTimeKey(r), i: i };
    });
    keyed.sort(function (a, b) {
      if (a.id && b.id && a.id !== b.id) return b.id - a.id;
      if (a.id && !b.id) return -1;
      if (!a.id && b.id) return 1;
      var ka = isNaN(a.t), kb = isNaN(b.t);
      if (ka && kb) return a.i - b.i;
      if (ka) return 1;
      if (kb) return -1;
      return b.t - a.t || a.i - b.i;
    });
    return keyed.map(function (x) { return x.r; });
  }
  // v1.1.137：天猫「查看全部评价」是抽屉式展开——点开 Drawer 弹层（内联按钮不消失，平台把其余评价
  // 折叠进抽屉，「已折叠N条」不可解锁）。用 rect+样式判可见（fixed 元素 offsetParent 恒 null 不可用），
  // 且须含 ≥3 条评论项才算评论抽屉。静默浏览器实证（h39/h40/h48）。
  function revDrawerOpen() {
    var pick = null;
    try {
      document.querySelectorAll('[class*="Drawer"],[class*="drawer"],[class*="Modal"],[class*="modal"]').forEach(function (d) {
        if (pick) return;
        var r = d.getBoundingClientRect();
        if (r.width < 120 || r.height < 120) return;
        var st = window.getComputedStyle(d);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || 1) <= 0.1) return;
        // v1.1.141：少评论商品的抽屉里评论项不足 3 条（h51/h52 实证：n=1 商品抽屉实际已打开，检测却永不通过，
        // 面板一直「等待展开」直到收敛）→ 加「条评价/用户评价/已折叠」文本证据兜底（0 条也认），滚动分支随后触发懒加载。
        var _items = d.querySelectorAll('[class*="Comment--"],[class*="comment--"],[class*="rateItem"],[class*="rate-item"]').length;
        if (_items >= 3 || /条评价|用户评价|已折叠/.test((d.textContent || '').slice(0, 3000))) pick = d;
      });
    } catch (e) {}
    return pick;
  }
  function findReviewRoot() {
    var roots = document.querySelectorAll('[class*="Comments"], [class*="comments"], [class*="evaluate-panel"], [class*="evaluatePanel"]');
    for (var i = 0; i < roots.length; i++) {
      var r = roots[i];
      if (r.children.length >= 2 && (r.textContent || '').length > 100) return r;
    }
    // 兜底：找「查看全部评价」按钮，向上找最近的评论容器
    var all = document.querySelectorAll('div, span, a');
    for (var j = 0; j < all.length; j++) {
      var x = all[j];
      if ((x.textContent || '').trim() === '查看全部评价') {
        var p = x.parentElement;
        for (var d = 0; d < 6 && p; d++) {
          if (p.children.length >= 3 && (p.textContent || '').length > 200) return p;
          p = p.parentElement;
        }
      }
    }
    return null;
  }
  // 判断一个元素是否像单条评论：有日期 + 有图(头像/晒图) + 有正文，且不是页面框架
  function isCommentLike(el) {
    if (!el || !el.children || el.children.length < 2) return false;
    var cls = String(el.className || '') + ' ' + String(el.id || '');
    if (/title|footer|condition|button|pagination|page|tab|nav|header|search|toolbar|logo|banner|avatar|topbar|site-nav|headerArea|searchHeader|SearchSuggest|feedback|banner/i.test(cls)) return false;
    var t = (el.textContent || '').trim();
    if (t.length < 20 || t.length > 2000) return false;
    // 评论必有时间：yyyy-mm-dd / yyyy年mm月dd日 / 相对时间 N天前/个月前/年前
    if (!/\d{4}[-/年]\d{1,2}[-/月]\d{0,2}|\d+天前|\d+个月前|\d+年前/.test(t)) return false;
    var imgs = el.querySelectorAll('img');
    if (imgs.length > 30) return false;
    // 排除页面级文本（搜索/导航/账号等噪音）
    if (/Ctrl\+V|粘贴图片|图搜|无障碍|已买到的宝贝|我的淘宝|免费开店|千牛|购物车|收藏夹|网页无障碍/i.test(t)) return false;
    // 评论正文里通常有较长的中文
    if (!/[\u4e00-\u9fff]{6,}/.test(t)) return false;
    return true;
  }
  // 从容器中提取评论项：优先单数 Comment 类（淘宝评论项特征），其次通用特征
  function extractFromContainer(container) {
    var items = [];
    var commentEls = [];
    Array.prototype.forEach.call(container.querySelectorAll('*'), function(d) {
      var cls = String(d.className || '');
      if (/Comment--|comment--|commentItem|CommentItem|rate-item|rateItem|evaluation-content|evaluate-item/i.test(cls) && !/Comments|commentList|comment-list|comments--|evaluate-panel|evaluate-page/i.test(cls)) {
        var t = (d.textContent || '').trim();
        if (t.length >= 15 && (/\d{4}[-/年]\d{1,2}[-/月]\d{0,2}|\d+天前|\d+个月前|\d+年前/.test(t)) && d.querySelector('img')) {
          var p = d.parentElement;
          var pc = p ? String(p.className || '') : '';
          var pIs = p && /Comment--|comment--|commentItem|CommentItem|rate-item|rateItem/i.test(pc) && !/Comments|commentList|comment-list|comments--/i.test(pc) && (p.textContent || '').length >= 15 && (/\d{4}[-/年]|\d+天前|\d+个月前|\d+年前/.test(p.textContent || ''));
          if (!pIs) commentEls.push(d);
        }
      }
    });
    if (commentEls.length) items = commentEls;
    if (!items.length) {
      var matched = [];
      Array.prototype.forEach.call(container.querySelectorAll('div, li, article'), function(d) {
        if (isCommentLike(d)) {
          var pm = d.parentElement && isCommentLike(d.parentElement);
          if (!pm) matched.push(d);
        }
      });
      items = matched;
    }
    return parseReviewItems(items);
  }
  function fullDocExtract() {
    // v1.1.116：排除推荐/问大家等噪音模块（跨商品「幻影评论」源头——采集出页面没有的评论多来自这里）
    function inNoiseModule(el) {
      var p = el, n = 0;
      while (p && p !== document.body && n < 8) {
        var c = String(p.className || '') + ' ' + String(p.id || '');
        if (/recommend|similar|guess|youlike|like-list|hotitem|feed-card|askall|ask-all|answer|question|qna|itemcard|shop-reco|similar-offer|desDetail|brandTip/i.test(c)) return true;
        p = p.parentElement; n++;
      }
      return false;
    }
    var matched = [];
    Array.prototype.forEach.call(document.querySelectorAll('div, li'), function(d) {
      if (isCommentLike(d)) {
        var parentMatch = d.parentElement && isCommentLike(d.parentElement);
        if (!parentMatch && !inNoiseModule(d)) matched.push(d);
      }
    });
    return parseReviewItems(matched);
  }
  // 找弹层：fixed(z>100) 且含 .evaluation-content（1688 判据，选可见面积最大）；否则文本启发式
  function findModal() {
    var all = document.querySelectorAll('div');
    var pick = null, pickArea = 0;
    for (var i = 0; i < all.length; i++) {
      var d = all[i];
      var st = window.getComputedStyle(d);
      if (st.position !== 'fixed') continue;
      if ((parseInt(st.zIndex) || 0) < 100) continue;
      if (!d.querySelector('.evaluation-content')) continue;
      var rc = d.getBoundingClientRect();
      var area = rc.width * rc.height;
      if (st.visibility === 'hidden' || rc.width < 50 || rc.height < 50) continue;
      if (area > pickArea) { pick = d; pickArea = area; }
    }
    if (pick) return pick;
    // v1.1.137：天猫评论抽屉（含评论项的可见弹层）优先作为弹层来源
    var _drw = revDrawerOpen();
    if (_drw) return _drw;
    var best = null, bestZ = 0;
    for (var j = 0; j < all.length; j++) {
      var d2 = all[j];
      var st2 = window.getComputedStyle(d2);
      if (st2.position !== 'fixed') continue;
      var z = parseInt(st2.zIndex) || 0;
      if (z < 100) continue;
      var t = (d2.textContent || '').trim();
      if (t.length < 200) continue;
      if (!/[\u4e00-\u9fff]{10,}/.test(t)) continue;
      if (z > bestZ && /好评|差评|追评|评价|评论|用户/i.test(t)) {
        best = d2; bestZ = z;
      }
    }
    return best;
  }
  // 多源评论提取：弹层 → 评论区容器 → 全文档
  function multiSourceExtract() {
    var out = [];
    var modal = findModal();
    if (modal) {
      out = extractFromContainer(modal);
      if (out.length > 0) return out;
    }
    var root = findReviewRoot();
    if (root) {
      out = extractFromContainer(root);
      if (out.length > 0) return out;
    }
    out = fullDocExtract();
    return out;
  }
  // 把评论项 DOM 解析为结构化数据
  function parseReviewItems(items) {
    var out = [];
    var seen = {};
    items = items.filter(function(it) {
      var k = (it.textContent || '').trim().slice(0, 60);
      if (seen[k]) return false;
      seen[k] = 1;
      return true;
    });
    items = items.slice(0, 3000);
    items.forEach(function(it) {
      var t = it.textContent || '';
      var nick = '';
      var nickEl = it.querySelector('[class*="userName"], [class*="nick"], [class*="user-name"], [class*="userInfo"], [class*="userName--"]');
      if (nickEl) nick = nickEl.textContent.trim();
      if (!nick) {
        var mNick = t.match(/([a-zA-Z0-9_\u4e00-\u9fff*]{2,12})\s*\d{4}[-/年]/);
        if (mNick) nick = mNick[1];
      }
      var time = '';
      var timeEl = it.querySelector('[class*="meta"], [class*="time"], [class*="date"], [class*="meta--"]');
      if (timeEl) time = timeEl.textContent.trim();
      if (!time) {
        var mT = t.match(/(\d{4}[-/年]\d{1,2}[-/月]\d{1,2}日?)/);
        if (mT) time = mT[1];
        if (!time) { var mR = t.match(/(\d+)\s*(天前|个月前|年前|小时前)/); if (mR) time = mR[1] + mR[2]; }
      }
      var content = '';
      var contentEl = it.querySelector('[class*="content"], [class*="text"], [class*="feedback"], [class*="content--"]');
      if (contentEl) content = contentEl.textContent.trim();
      if (!content || content.length < 5) {
        var maxLen = 0, best = '';
        Array.prototype.forEach.call(it.querySelectorAll('div, span, p'), function(s) {
          var st = (s.textContent || '').trim();
          if (st.length > maxLen && st.length < 500) { maxLen = st.length; best = st; }
        });
        content = best;
        if (nick) content = content.replace(nick, '');
        if (time) content = content.replace(time, '');
        content = content.trim();
      }
      var images = [];
      Array.prototype.forEach.call(it.querySelectorAll('img'), function(im) {
        var src = im.src || im.getAttribute('data-src') || im.getAttribute('data-ks-lazyload') || '';
        if (!src || src.length <= 30) return;
        // 排除头像、会员标识、logo 等非晒图
        if (/avatar|sns_logo|sns\.m\.taobao|icon|logo|flag|credit|vip88/i.test(src)) return;
        // 渲染尺寸 ≥60px 的真实晒图（头像 40px、会员标 14-33px）
        var w = im.width || 0, h = im.height || 0;
        if (w >= 60 || h >= 60) images.push(src);
        else if (!w && !h && /imgextra|bao\/uploaded|alicdn/i.test(src) && src.length > 50) images.push(src);
      });
      var appendContent = '';
      var appendEl = it.querySelector('[class*="append"], [class*="addContent"], [class*="supplement"], [class*="follow"]');
      if (appendEl) appendContent = appendEl.textContent.trim();
      var rating = 0;
      var fullStars = it.querySelectorAll('.ant-rate-star-full');
      if (fullStars && fullStars.length > 0) {
        rating = fullStars.length;
      } else {
        var starEl = it.querySelector('[class*="star"], [class*="Star"]');
        if (starEl) {
          var cls = starEl.className || '';
          var m = cls.match(/star-?(\d)|\b(\d)star\b/i);
          if (m) rating = parseInt(m[1] || m[2]) || 0;
        }
      }
      if (!rating) {
        if (/差评|1星|一星/.test(t)) rating = 1;
        else if (/中评|3星|三星/.test(t)) rating = 3;
        else if (/好评|5星|五星/.test(t)) rating = 5;
      }
      var sku = '';
      var skuEl = it.querySelector('[class*="sku"], [class*="spec"], [class*="property"]');
      if (skuEl) sku = skuEl.textContent.trim();
      if (!sku) {
        var mS = t.match(/(颜色|尺码|规格|款式|型号|容量|版本)[:：]?\s*\S{1,20}/);
        if (mS) sku = mS[0];
      }
      if (content.length >= 5 || time) {
        out.push({
          reviewId: it.getAttribute('data-id') || it.getAttribute('id') || '',
          content: content || t.slice(0, 200),
          rating: rating, username: '', skuInfo: sku, time: time,
          hasImage: images.length > 0, images: images,
          isAppend: !!appendContent, appendContent: appendContent
        });
      }
    });
    return out;
  }
  // 尝试点击「查看全部评价」（多文本变体 + 自动找可点击元素）
  function clickViewAllReview() {
    try {
      // v1.1.87：京东/1688 禁点击（用户禁令：京东零交互；1688 走 mtop 不需展开）
      if (/jd\.com$/.test(location.hostname) || /1688\.com$/.test(location.hostname)) return false;
      var texts = ['查看全部评价', '查看全部评论', '全部评价', '查看评价', '看全部评价'];
      // 先限定在评论区容器内找（避免误点页面其他「查看全部」导航）
      var scopes = [];
      var roots = document.querySelectorAll('[class*="Comments"], [class*="comments"]');
      for (var i = 0; i < roots.length; i++) scopes.push(roots[i]);
      scopes.push(document); // 兜底：全文档（仅精确匹配 + 非跳转链接）
      var candidates = [];
      for (var s = 0; s < scopes.length; s++) {
        var scope = scopes[s];
        var allEls = scope.querySelectorAll('div, span, a, button, em, p, i');
        for (var i2 = 0; i2 < allEls.length; i2++) {
          var x = allEls[i2];
          var t = (x.textContent || '').replace(/\s+/g, ' ').trim();
          for (var k = 0; k < texts.length; k++) {
            if (t === texts[k] || t === texts[k] + ' ' || t === ' ' + texts[k]) {
              if (x.offsetParent !== null || x.offsetWidth > 0 || x.offsetHeight > 0) {
                // 排除会造成页面跳转的 a[href]
                var bad = x.closest && x.closest('a[href]');
                if (bad && !/^(javascript:|#|item\.taobao\.com|item\.tmall\.com|detail\.1688\.com)/.test(bad.getAttribute('href') || '')) continue;
                candidates.push({ el: x, text: t, tag: x.tagName, inner: x.querySelector('[class*="ShowButton"], button, em, [class*="button"], [class*="btn"]') });
              }
            }
          }
        }
      }
      // 优先点击最具体的按钮：含 ShowButton/button/btn 类优先，其次选后代最少的叶子元素
      candidates.sort(function(a, b) {
        function isBtn(x) { var c = String(x.el.className || '') + ' ' + String(x.tag || ''); return /ShowButton|button|btn/i.test(c); }
        var ab = isBtn(a) ? 1 : 0, bb = isBtn(b) ? 1 : 0;
        if (ab !== bb) return bb - ab;
        var aDepth = a.el.querySelectorAll('*').length;
        var bDepth = b.el.querySelectorAll('*').length;
        return aDepth - bDepth;
      });
      for (var j2 = 0; j2 < candidates.length; j2++) {
        var c = candidates[j2];
        var target = c.inner || c.el;
        try {
          // v1.1.132：淘宝/天猫 React 展开按钮不接受脚本 click；只滚到入口，交给用户真实点击
          if (target.scrollIntoView) target.scrollIntoView({ block: 'center' });
          return false;
        } catch (e2) { continue; }
      }
    } catch (e) {}
    return false;
  }
  // 真人步进式滚动弹层/评论区：找评论区可滚动容器跳底触发懒加载，偶尔回看
  function scrollReviewList() {
    // v1.1.137：抽屉弹层打开 → 滚抽屉内的评论容器（那才是渐进加载的滚动区），内联区不再是目标
    try {
      var _dr = revDrawerOpen();
      if (_dr) {
        var _ds = null, _dg = 0;
        _dr.querySelectorAll('div').forEach(function (x) {
          var cls = String(x.className || '');
          if (!/comment|Comment|rate|Rate|evaluation/i.test(cls)) return;
          var s2 = window.getComputedStyle(x);
          if (!/(auto|scroll)/.test(s2.overflowY)) return;
          var gap = x.scrollHeight - x.clientHeight;
          if (gap > _dg) { _dg = gap; _ds = x; }
        });
        if (_ds && _dg > 50) {
          // v1.1.138 提速：流畅期(state.revFlow)高频直达底部——抽屉懒加载只有触底才拉下一批，小步滚浪费轮次
          var _jp = state.revFlow ? 0.75 : 0.45;
          if (state.revLastGap === _dg) {
            // 上一轮同一 gap：已触底但下一批未到 → 补 wheel + 上抖再触底；v1.1.139 限频（隔轮一次、内部放慢）防连发风控
            state.revRetrigN = (state.revRetrigN || 0) + 1;
            if (state.revRetrigN % 2 === 1) {
              try { _ds.dispatchEvent(new WheelEvent('wheel', { deltaY: 700 + Math.floor(Math.random() * 250), bubbles: true, cancelable: true })); } catch (eW2) {}
              try { _ds.scrollTop = Math.max(0, _ds.scrollHeight - _ds.clientHeight - 60); _ds.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (eJ2) {}
              setTimeout(function () { try { _ds.scrollTop = _ds.scrollHeight; _ds.dispatchEvent(new Event('scroll', { bubbles: true })); } catch (eJ3) {} }, 320 + Math.floor(Math.random() * 380));
            }
          } else if (Math.random() < _jp) {
            _ds.scrollTop = _ds.scrollHeight;
            _ds.dispatchEvent(new Event('scroll', { bubbles: true }));
          } else {
            _ds.scrollTop += 500 + Math.floor(Math.random() * 400);
            _ds.dispatchEvent(new Event('scroll', { bubbles: true }));
          }
          state.revLastGap = _dg;
          return _dg;
        }
        var _di = _dr.querySelectorAll('[class*="Comment--"], [class*="comment--"], [class*="rateItem"], [class*="rate-item"]');
        if (_di.length) { try { _di[_di.length - 1].scrollIntoView({ block: 'end' }); } catch (eDs) {} return 300; }
      }
    } catch (eDr) {}
    // v1.1.128：滚动引擎 v2——轨迹实证「错误的内部容器增量滚动无效（gap 恒定不降）」。
    // 主策略：对评论区最后一个元素 scrollIntoView（浏览器自动选对滚动祖先）+ 越过式加滚 + 根部派发 wheel；
    // 旧逻辑（类名猜容器→增量滚）降为无评论元素时的兜底。
    try {
      var v2root = findReviewRoot();
      var v2items = v2root ? v2root.querySelectorAll('[class*="Comment--"], [class*="comment--"], [class*="rateItem"], [class*="rate-item"]') : [];
      if (v2items.length) {
        var v2tgt = (v2root.lastElementChild && v2root.lastElementChild.scrollHeight !== undefined) ? v2root.lastElementChild : v2items[v2items.length - 1];
        var y0 = window.scrollY;
        try { v2tgt.scrollIntoView({ block: 'end', behavior: 'auto' }); } catch (eSi) {}
        var mv = Math.abs(window.scrollY - y0);
        try { v2root.dispatchEvent(new WheelEvent('wheel', { deltaY: 600 + Math.floor(Math.random() * 400), bubbles: true, cancelable: true })); } catch (eWe) {}
        try { window.scrollBy(0, 200 + Math.floor(Math.random() * 300)); } catch (eSb) {}
        return (mv > 0 ? mv : 300); // 有实际位移记位移，否则记越过量（触发渐进加载的意图已表达）
      }
    } catch (eV2) {}
    var best = null, bestGap = 0;
    document.querySelectorAll('div').forEach(function(d) {
      var cls = String(d.className || '');
      if (!/comments|comment|Comment|rate|Rate/i.test(cls)) return;
      var st = window.getComputedStyle(d);
      if (!/(auto|scroll)/.test(st.overflowY)) return;
      var gap = d.scrollHeight - d.clientHeight;
      if (gap > bestGap) { bestGap = gap; best = d; }
    });
    if (best && bestGap > 50) {
      // v1.1.86 拟人化：45% 轮次直达底部触发懒加载，其余增量滚动（浏览器自动钳底）
      if (Math.random() < 0.45) best.scrollTop = best.scrollHeight;
      else best.scrollTop += 400 + Math.floor(Math.random() * 300);
      best.dispatchEvent(new Event('scroll', { bubbles: true }));
      return bestGap;
    }
    window.scrollBy(0, 400);
    return 0;
  }
  // ---------- 风控检测（照搬 detectRiskControl）----------
  function detectRevRisk(scrolledOnce, noNewCount, rounds) {
    try {
      // v1.2.199：+拼多多（商品页/评论列表页都在白名单内）
      if (!/item\.taobao\.com|item\.tmall\.com|detail\.tmall\.com|detail\.1688\.com|m\.1688\.com|item\.jd\.com|yangkeduo\.com|pinduoduo\.com/.test(location.href)) return '页面被跳转，请返回商品详情页后重新采集';
      var body = ((document.body && document.body.innerText) || '').slice(0, 500);
      if (/(验证码|安全验证|滑动验证|滑块|人机验证|拖动滑块|访问异常|操作过于频繁|请求过于频繁|触发风控|反爬验证)/i.test(body)) return '检测到安全验证，需等待冷却后自动重试';
      if (scrolledOnce && noNewCount >= 4 && rounds >= 8 && state.reviews.length === 0) return '评论数异常为 0，可能触发风控限制';
    } catch (e) {}
    return '';
  }
  // ---------- 评论采集主流程（照搬 collectReviews：点击展开 → 轮询滚动 → 多源提取 → 风控冷却重试）----------
  // v1.1.153：快速判尾——评论滚动容器已到底（不再空滚十几秒）
  function revAtBottom() {
    try {
      var cands = [];
      try { var dr = revDrawerOpen(); if (dr) { var ds = window.getComputedStyle(dr); if (/(auto|scroll)/.test(ds.overflowY) && dr.scrollHeight > dr.clientHeight + 50) cands.push(dr); } } catch (eDr) {}
      try { var ev = document.querySelector('.evaluation-content'); if (ev) { var es = window.getComputedStyle(ev); if (/(auto|scroll)/.test(es.overflowY) && ev.scrollHeight > ev.clientHeight + 50) cands.push(ev); } } catch (eEv) {}
      Array.prototype.forEach.call(document.querySelectorAll('[class*="beautify-scroll-bar"], [class*="scroll"], [class*="list"], [class*="evaluation"]'), function (d) {
        if (cands.length >= 8 || !d) return;
        try { var st = window.getComputedStyle(d); if (/(auto|scroll)/.test(st.overflowY) && d.scrollHeight > d.clientHeight + 50) cands.push(d); } catch (eSt) {}
      });
      for (var k = 0; k < cands.length; k++) {
        var e2 = cands[k];
        if (e2.scrollTop + e2.clientHeight >= e2.scrollHeight - 30) return true;
      }
    } catch (eAB) {}
    return false;
  }
  // v1.1.153：修复「开始采集点不动」——旧版 runRevCollect 无 try/finally，一次异常或页面跳转
  // 就让 state.revCollecting 永久卡在 true，按钮静默失效。现在无论正常/异常/被接管都必须收尾。
  async function runRevCollect(isRetry) {
    var _gen = state.revGen || 0;
    try {
      await runRevCollectInner(isRetry, _gen);
    } catch (eRev) {
      try {
        var _em = '评论采集异常终止：' + ((eRev && eRev.message) || eRev);
        var _rpE = $('aisimg-revprog-txt'); if (_rpE) _rpE.textContent = _em;
        aisToast(_em, 'error');
      } catch (eRev2) {}
    } finally {
      if ((state.revGen || 0) === _gen) {
        state.revCollecting = false;
        state.revBeat = 0;
        var _sbF = $('aisimg-revstop'); if (_sbF) { _sbF.textContent = '停止采集'; _sbF.disabled = true; }
        try { renderReview(); } catch (eRevF) {}
        // v1.2.208：收尾三连——停页内循环 → 焦点切回商品页 → 关评论页（全部零刷新）
        try {
          if (state.__pddCmtTabId) {
            var _pddFinTab = state.__pddCmtTabId;
            state.__pddCmtTabId = null;
            chrome.runtime.sendMessage({ action: 'mainWorldPddCommentsStop', tabId: _pddFinTab }, function () {
              setTimeout(function () {
                try { chrome.runtime.sendMessage({ action: 'closePddCommentsTab', tabId: _pddFinTab, activate: true }, function () {}); } catch (eFinC) {}
              }, 400);
            });
          } else if (/yangkeduo\.com$|pinduoduo\.com$/.test(location.hostname) && /goods_comments\.html/.test(location.href)) {
            chrome.runtime.sendMessage({ action: 'mainWorldPddCommentsStop' }, function () {}); // 用户前台评论页：只停循环不关页
          }
        } catch (ePddFin) {}
      }
    }
  }
  async function runRevCollectInner(isRetry, myGen) {
    var P = window.__AIS_IMG_PARSER__;
    if (!isRetry) state.revRiskRetries = 0;
    if (!isRetry) state.__pddRounds = 0; // v1.2.203：重置轮次计数
    if (!isRetry) state.__pddCollectStarted = false; // v1.2.208：重置前台自驱会话标记
    state.revRiskRetries = state.revRiskRetries || 0;
    // 0. 反爬前置：写 mtop_partitioned_detect=1，防止分区 cookie（CHIPS）检测拦截 mtop token
    try {
      document.cookie = 'mtop_partitioned_detect=1; path=/; domain=.taobao.com';
      document.cookie = 'mtop_partitioned_detect=1; path=/; domain=.tmall.com';
    } catch (e) {}
    // 1. 点击「查看全部评价」展开评论区
    // v1.2.199：拼多多零自动点击（风控红线）——评论走评论列表页 store 明文直读（见循环内平台分支）
    var _pddRev = /yangkeduo\.com|pinduoduo\.com/.test(location.hostname);
    var viewOk = false;
    var sb = $('aisimg-revstop');
    if (sb) { sb.disabled = false; sb.textContent = '停止采集'; }
    if (_pddRev) {
      status(/goods_comments\.html/.test(location.href) ? '拼多多评论列表页已就绪，读取页面评论数据...' : '拼多多：即将前台打开评论页自动滚动采集（约 1-2 分钟，完成后自动返回商品页；期间请暂不切换标签页）...');
      await new Promise(function(res) { setTimeout(res, 1800 + Math.floor(Math.random() * 900)); });
    } else {
      viewOk = clickViewAllReview();
      status(viewOk ? '已打开全部评价，等待评论加载...' : '已定位评论入口；如页面弹出「查看全部评价」按钮，请手动点击展开，采集会自动继续...');
      // 1.5 打开后不立即操作：模拟真人浏览等待（弹层/评论区渲染 + 降低风控）
      await new Promise(function(res) { setTimeout(res, 2500 + Math.floor(Math.random() * 1500)); });
      // 1.6 校验评论区是否真正展开（有可滚动容器）；未展开则重试点一次
      if (viewOk) {
        var drawerOpen = !!document.querySelector('.evaluation-content');
        var hasScroller = drawerOpen || !!(document.querySelector('[class*="beautify-scroll-bar"], [class*="comments"], [class*="Comments"]') &&
          Array.prototype.some.call(document.querySelectorAll('div'), function(d) {
            var st = window.getComputedStyle(d);
            return /(auto|scroll)/.test(st.overflowY) && d.scrollHeight > d.clientHeight + 50;
          }));
        if (!hasScroller) {
          clickViewAllReview();
          await new Promise(function(res) { setTimeout(res, 1500 + Math.floor(Math.random() * 1000)); });
        }
      }
    }
    // 1.7 1688 评论弹窗已打开，等待列表渲染
    if (/1688\.com$/.test(location.hostname)) {
      status('1688 评论弹窗已打开，等待列表渲染...');
      await new Promise(function(res) { setTimeout(res, 1500 + Math.floor(Math.random() * 1000)); });
    }
    // 2. 轮询 + 滚动翻页加载（全部模式不固定轮数，仅安全上限防异常页面）
    var sc2 = getRevScope();
    var limit = sc2.mode === 'limit' ? (sc2.limit || 50) : 0;
    var maxRounds = limit ? 300 : 600;
    var prevLen = -1, noNewCount = 0, scrolledOnce = false, rounds = 0;
    if (!isRetry) state.revMtopPage = 1; // v1.1.87：风控重试续翻不重置（避免重复拉取）；全新会话从第 1 页
    if (!isRetry) { state.revTbPage = 1; state.revTbMode = ''; state.revTbFail = 0; } // v1.1.90：淘宝 mtop 分页态
    var i = 0;
    // v1.1.134：滚动轮逻辑抽成函数——v1.1.122~133 该块写在 mtop 分支内部，只有「切换轮」执行一次；
    // 之后各轮落到裸 else { scrollReviewList() }，worker 滚动、展开感知、展开提示永不执行（静默实测轨迹 r3+ 无提示无感知的根因）
    async function tbScrollRound() {
      if (state.revExpandTries == null) state.revExpandTries = 0;
      var _firstLocate = !state.revExpandLocateDone;
      var _showOnly = _firstLocate || (Date.now() - (state.revT0 || Date.now())) < 6000; // v1.1.145：无论前置请求耗时，首次轮都只定位；随后遵守 6s 窗口
      if (_firstLocate) state.revExpandLocateDone = true;
      var _srb = null;
      if (state.revExpandTries < 2 && !_showOnly) {
        state.revExpandTries++;
        try { _srb = await sendBg({ action: 'scrollReviewSection', resetExpand: state.revExpandTries === 1 }, 10000); } catch (eSrb) {}
      } else {
        try { _srb = await sendBg({ action: 'scrollReviewSection', showBtnOnly: true }, 8000); } catch (eSrb2) {}
      }
      state.revTraceSrb = _srb && _srb.success ? ('w' + state.revExpandTries + (_showOnly ? '/show' : '') + ':gap=' + (_srb.gap || 0) + (_srb.expanded ? '/exp' : '/noexp') + ' t=' + state.revExpandTries) : 'wfail';
      var _sc = scrollReviewList();
      try {
        if (state.revDomBase == null) { state.revDomBase = 1; state.revBtnAtStart = !!document.querySelector('[class*="ShowButton"]'); }
        // v1.1.136：只用按钮信号判展开——h23 实证条目数跳增会被虚拟列表自然渲染误触发（r3 误判 exp 吞掉提示）。
        // 按钮消失，或按钮文案不再含「查看全部」（点击后变「收起」），才算真展开。
        var _sb = document.querySelector('[class*="ShowButton"]');
        var _btnGone = state.revBtnAtStart && (!_sb || !/查看全部/.test(String(_sb.textContent || '')));
        // v1.1.137：抽屉式展开（天猫）按钮不消失，弹层出现即算展开
        var _drawerOn = !!revDrawerOpen();
        if (!state.revExpandedEver && (_btnGone || _drawerOn)) {
          state.revExpandedEver = true;
          noNewCount = 0;
          status('已检测到评论区展开，继续采集中...');
          var _rpX = $('aisimg-revprog-txt'); if (_rpX) _rpX.textContent = '▶ 已展开，继续采集 · 已 ' + state.reviews.length + ' 条';
        }
      } catch (eExp) {}
      // v1.1.142：抽屉/页面出现滑块或安全验证 → 立即停止并明确提示（不自动过滑块，交还真人；防风控规范）
      try {
        var _capEl = revDrawerOpen();
        var _capTxt = (_capEl && _capEl.innerText || '').slice(0, 20000);
        // v1.1.145：只在已打开评论抽屉内识别强滑块证据；禁止扫描整页或仅凭宽泛“验证码”误停。
        if (_capEl && /拖动(?:下方)?滑块|还原拼图|滑块验证|请完成安全验证/.test(_capTxt)) {
          state.revCaptchaHit = true;
          state.revStop = true;
          var _rpC = $('aisimg-revprog-txt'); if (_rpC) _rpC.textContent = '⚠ 触发安全验证（滑块）· 手动完成后可重新采集';
          status('⚠ 触发平台安全验证（滑块），已停止采集。请手动完成验证后重新点「开始采集」', true);
        }
      } catch (eCap) {}
      // v1.1.135：页面上没有展开按钮时不弹「请点击查看全部评价」（静默实测：降级页无按钮，提示误导）
      var _hasBtn = !!document.querySelector('[class*="ShowButton"]');
      if (!state.revExpandedEver && !state.revExpandHinted && noNewCount >= 3 && _hasBtn) {
        state.revExpandHinted = true;
        status('评论需要展开才能继续采集：请点击页面上的「查看全部评价」按钮（已为你滚动到按钮处）');
        var _rpE = $('aisimg-revprog-txt'); if (_rpE) _rpE.textContent = '⏳ 等待展开「查看全部评价」· 已 ' + state.reviews.length + ' 条';
        try { await sendBg({ action: 'scrollReviewSection', showBtnOnly: true }, 8000); } catch (eShow) {}
      }
      if (state.revExpandHinted && !state.revExpandedEver && _hasBtn && noNewCount < 4) { // v1.1.152 快速收敛时不刷等待文案
        var _rpW2 = $('aisimg-revprog-txt'); if (_rpW2) _rpW2.textContent = '⏳ 等待展开「查看全部评价」· 已 ' + state.reviews.length + ' 条（点击后自动继续）';
      }
      return _sc;
    }
    for (; i < maxRounds; i++) {
      rounds = i;
      state.revBeat = Date.now(); // v1.1.153 心跳：供「开始采集」判僵尸
      if ((state.revGen || 0) !== myGen) return; // v1.1.153 已被新采集接管 → 直接退出（不得置全局 revStop，否则会误停新采集）
      var _roundStartLen = state.reviews.length; // v1.1.145：本轮提取前快照，用于下一轮真实流畅态
      if (state.revStop) { status(state.revCaptchaHit ? '⚠ 触发安全验证（滑块）已停止，共 ' + state.reviews.length + ' 条——完成验证后可重新采集' : '已手动停止采集，共 ' + state.reviews.length + ' 条', true); break; }
      // 2a. 翻页：1688 评论区用分页（弹层内下一页），其他平台滚动懒加载
      // v1.2.199：拼多多——评论列表页 store 明文直读（评论API加密不可解析，页面渲染数据为唯一合规来源）
      // 风控：不点击不构造请求；商品页需要时仅「单次后台打开评论页、读后即关」；翻页由页面自然滚动触发自身加载，
      //      有界：页数上限 / 连续无增长熔断 / 110s 安全阀 / 人类化延时抖动
      var sc = 0;
      if (/yangkeduo\.com$|pinduoduo\.com$/.test(location.hostname)) {
        // v1.2.208 重设计「前台自驱模式」：评论页前台打开（IO 懒加载需要渲染帧——后台标签页
        // 永不翻页是旧版只采到首屏的根因）；滚动循环跑在页面内（前台无节流、SW 零长任务），
        // 面板每轮 Poll 增量入库；采完焦点零刷新切回商品页并关闭评论页。
        var _onCmtPage = /goods_comments\.html/.test(location.href);
        var _pddTabFor = _onCmtPage ? null : state.__pddCmtTabId;
        if (!state.__pddCollectStarted) {
          if (!_onCmtPage && !state.__pddCmtTabId) {
            status('正在前台打开拼多多评论页（自动滚动加载，期间请暂不切换标签页，完成后自动返回商品页）...');
            var openP = null;
            try { openP = await sendBg({ action: 'openPddCommentsTab', goodsId: String(state.itemId || '') }, 10000); } catch (ePdd2) {}
            if (!openP || !openP.ok || !openP.tabId) { status('拼多多评论页打开失败；可手动打开「商品评价-查看全部」后再点采集', true); break; }
            state.__pddCmtTabId = openP.tabId;
            await new Promise(function(res) { setTimeout(res, 4200 + Math.floor(Math.random() * 900)); });
            _pddTabFor = state.__pddCmtTabId;
          }
          var stR = null;
          try { stR = await sendBg({ action: 'mainWorldPddCommentsStart', tabId: _pddTabFor || undefined, maxRows: limit ? limit : 0 }, 15000); } catch (eStPdd) {}
          if ((state.revGen || 0) !== myGen) return;
          if (!stR || !stR.success) {
            noNewCount++;
            if (noNewCount >= 3) { status('拼多多评论采集启动失败（' + ((stR && stR.error) || '评论页未就绪') + '）；可手动打开「商品评价-查看全部」后再点采集', true); break; }
            await new Promise(function(res) { setTimeout(res, 2500 + Math.floor(Math.random() * 1500)); });
            continue;
          }
          state.__pddCollectStarted = true;
          noNewCount = 0;
          status('拼多多评论页前台采集中（页面自动滚动加载，已采 ' + state.reviews.length + ' 条）...');
        }
        var plR = null;
        try { plR = await sendBg({ action: 'mainWorldPddCommentsPoll', tabId: _pddTabFor || undefined }, 15000); } catch (ePlPdd) {}
        if ((state.revGen || 0) !== myGen) return;
        if (!plR || plR.success === false) {
          noNewCount++;
          if (noNewCount >= 4) { status('拼多多评论读取中断（' + ((plR && plR.error) || '页面无响应') + '），已采 ' + state.reviews.length + ' 条', true); break; }
          await new Promise(function(res) { setTimeout(res, 2500 + Math.floor(Math.random() * 1200)); });
          continue;
        }
        var _revBefore = state.reviews.length;
        revMergeList((plR.rows || []));
        var _newN = state.reviews.length - _revBefore;
        if (_newN > 0) noNewCount = 0; else noNewCount++;
        state.__pddRounds = (state.__pddRounds || 0) + 1;
        var _pageTot = plR.total || 0;
        var _grandPdd = (plR.grand && plR.grand > 0 && plR.grand < 1000000) ? plR.grand : 0;
        var _rpPd = $('aisimg-revprog-txt');
        if (_rpPd) _rpPd.textContent = '▶ 已采 ' + state.reviews.length + ' 条 / 页面加载 ' + _pageTot + (_grandPdd ? ' / 全部 ' + _grandPdd : '') + ' 条';
        status('拼多多评论采集中：已采 ' + state.reviews.length + ' / 页面加载 ' + _pageTot + (_grandPdd ? ' / 全部 ' + _grandPdd : '') + ' 条...');
        if (plR.done) {
          var _whyTxt = plR.reason === 'nomore' ? '已采完全部评论' : plR.reason === 'capped' ? '已达目标条数' : plR.reason === 'timeout' ? '达单轮 150s 上限（评论很多，可再点一次采集接着翻页）' : plR.reason === 'stalled' ? '页面加载停滞（戳了 4 次仍无新评论）' : plR.reason === 'nomore-flagged' ? '页面标记无更多但未满总数（戳 6 次无响应）' : plR.reason === 'stopped' ? '已按你的要求停止' : plR.reason === 'page-gone' ? '评论页被跳转（可能触发平台验证）' : '结束(' + (plR.reason || '?') + ')';
          var _gTx = (plR.grand && plR.grand > 0 && plR.grand < 1000000) ? '（页面评论共 ' + plR.grand + ' 条）' : '';
          status('拼多多评论采集完成：' + _whyTxt + '，共入库 ' + state.reviews.length + ' 条' + _gTx, true);
          break;
        }
        if (noNewCount >= 8 || state.__pddRounds > 150) { status('拼多多评论采集中止（连续无新增），共 ' + state.reviews.length + ' 条', true); break; }
        await new Promise(function(res) { setTimeout(res, 2300 + Math.floor(Math.random() * 1100)); });
      
      } else if (/1688\.com$/.test(location.hostname)) {
        // v1.1.82：1688 评论走 mtop 分页直拉（页面零点击零滚动，接口与页面自身一致）
        var pg88 = state.revMtopPage || 1;
        var res88 = null;
        // v1.2.240：尾部说明——带上页面自身的评价统计（分母）与已跳过的系统默认好评数量
        var _s88Tail = function () {
          var s88 = state.rev88Summary || {};
          var tg = (s88.tags || []).filter(function (x) { return /^(全部|有内容|有图|好评|中评|差评)$/.test(String(x.name)); })
            .map(function (x) { return x.name + ' ' + x.count; }).join(' · ');
          var eff88 = state.reviews.filter(function (r) { return !r.isSystem; }).length;
          return (tg ? '；页面统计 ' + tg : '') + '（其中真实有内容 ' + eff88 + ' 条 · 系统默认好评 ' + (state.rev88SysSkip || 0) + ' 条，均未过滤）';
        };
        if (pg88 === 1) {
          state.rev88SysSkip = 0; state.rev88Summary = null;
          try { state.rev88Summary = await sendBg({ action: 'mainWorld1688RateSummary', offerId: String(state.itemId || '') }); } catch (eSum) {}
          if ((state.revGen || 0) !== myGen) return;
          // v1.2.242：拿页面统计里的「有内容」数当进度分母（1688 没有每页总数返回）
          try {
            var _tg88 = (state.rev88Summary && state.rev88Summary.tags) || [];
            var _eff88 = 0, _all88 = 0;
            _tg88.forEach(function (x) { if (String(x.name) === '有内容') _eff88 = Number(x.count) || 0; if (String(x.name) === '全部') _all88 = Number(x.count) || 0; });
            state.rev88Eff = _eff88;
            if (_eff88 > 0) state.revProgTotal = _eff88; else if (_all88 > 0) state.revProgTotal = _all88;
          } catch (eTg) {}
        }
        if (pg88 > 40) { status('1688 评论已达 40 页上限：共 ' + state.reviews.length + ' 条' + _s88Tail(), true); break; } // v1.2.240：页数上限护栏
        try { res88 = await sendBg({ action: 'mainWorld1688Rates', offerId: String(state.itemId || ''), page: pg88 }); } catch (e88) {}
        if ((state.revGen || 0) !== myGen) return;
        if (!res88 || res88.success === false) {
          // v1.1.85：超页返回 SYSTEM_ERROR / 瞬时失败 → 同页重试一次，再失败判定评论已尽
          await new Promise(function(res) { setTimeout(res, 3000 + Math.floor(Math.random() * 2000)); });
          try { res88 = await sendBg({ action: 'mainWorld1688Rates', offerId: String(state.itemId || ''), page: pg88 }); } catch (e88b) {}
          if ((state.revGen || 0) !== myGen) return;
          if (!res88 || res88.success === false) { status('1688 评论采集完成：共 ' + state.reviews.length + ' 条' + _s88Tail(), true); break; }
        }
        state.revMtopPage = pg88 + 1;
        state.rev88SysSkip = (state.rev88SysSkip || 0) + (Number(res88.systemCount) || 0); // v1.2.241：只计数，不过滤
        var list88 = (res88 && res88.rows) || []; 
        revMergeList(list88);
        // v1.2.242：1688 逐页可见进度（此前整场静默，用户看不到"翻页/在动"）
        try {
          var _p88 = '▶ 1688 第 ' + pg88 + ' 页 · 已采 ' + state.reviews.length + ' 条'
            + (state.rev88Eff ? ' / 有内容 ' + state.rev88Eff + ' 条' : '')
            + (state.rev88SysSkip ? '（含系统默认好评 ' + state.rev88SysSkip + '）' : '');
          var _t88 = $('aisimg-revprog-txt'); if (_t88) _t88.textContent = _p88;
          var _f88 = $('aisimg-revprog-fill'), _c88 = $('aisimg-revprog-pct'), _tot88 = state.revProgTotal || 0;
          if (_tot88 > 0) {
            var _pc88 = Math.min(99, Math.round(state.reviews.length / _tot88 * 100));
            if (_f88) { _f88.className = 'aisimg-revprog-fill'; _f88.style.width = Math.max(_pc88, 3) + '%'; }
            if (_c88) _c88.textContent = _pc88 + '%';
          }
          status('1688 评论采集中：第 ' + pg88 + ' 页 · 已采 ' + state.reviews.length + ' 条' + (state.rev88Eff ? ' / 有内容 ' + state.rev88Eff : '') + '…');
        } catch (eP88) {}
        if (!list88.length) noNewCount += 2; // 空页快速收敛
        await new Promise(function(res) { setTimeout(res, 3500 + Math.floor(Math.random() * 4500)); }); // 3.5~8s 限速
      } else if (/jd\.com$/.test(location.hostname)) {
        // v1.1.87 京东零滚动（用户禁令）：不模拟滚动/点击，仅靠 2c 拦截缓存 + 2d DOM 提取；连续 2 轮无新即收敛
        if (noNewCount >= 2 && state.reviews.length > 0) { status('京东评论：拦截通道已收齐（共 ' + state.reviews.length + ' 条）', true); break; }
      } else if (/taobao\.com$|tmall\.com$/.test(location.hostname) && state.revTbMode !== 'scroll') {
        // v1.1.109 回退：v1.1.103 原版 mtop 直拉（连续 2 次失败降级滚动；空页视为读完；仅保留 sendBg 25s 防卡死护栏）
        var pgTb = state.revTbPage || 1;
        var resTb = null;
        try { resTb = await sendBg({ action: 'mainWorldTaobaoRates', itemId: String(state.itemId || ''), page: pgTb }, 25000); } catch (eTb) {}
        if ((state.revGen || 0) !== myGen) return;
        if (!resTb || resTb.success === false) {
          state.revTbFail = (state.revTbFail || 0) + 1;
          if (state.revTbFail >= 2) { state.revTbMode = 'scroll'; status('mtop 直拉不可用，降级为滚动采集（拟人化）...'); }
        } else {
          state.revTbFail = 0;
          var listTb = resTb.rows || [];
          revMergeList(listTb);
          if (resTb.total) state.revProgTotal = resTb.total; // 进度条精确总数
          var doneTb = listTb.length === 0 || (resTb.totalPage && pgTb >= resTb.totalPage) || resTb.hasNext === false;
          // v1.1.133：首页就空=接口降级不是没评论——转滚动采集兜底，绝不 0 条直接收工（静默实测：降级商品采出 0 条）
          if (doneTb && (pgTb > 1 || state.reviews.length > 0)) { status('淘宝评论已读取完毕（共 ' + state.reviews.length + ' 条）', true); break; }
          if (doneTb) { state.revTbMode = 'scroll'; status('mtop 首页为空（接口降级），改用页面滚动采集...'); }
          state.revTbPage = pgTb + 1;
          state.revTbMode = 'scroll'; // v1.1.122：mtop 翻页实测死路（第 2 页起与第 1 页恒同），第 1 页收货后立即转可见滚动，不再等 2 次失败
        }
        if (state.revTbMode === 'scroll') {
          sc = await tbScrollRound();
        }
      } else if (/taobao\.com$|tmall\.com$/.test(location.hostname) && state.revTbMode === 'scroll') {
        sc = await tbScrollRound(); // v1.1.134：滚动模式后续每轮都走完整逻辑（worker+展开感知+提示），不再落裸 else
      } else {
        sc = scrollReviewList();
      }
      if ((state.revGen || 0) !== myGen) return; // v1.1.154：异步恢复后旧任务不得写入新场次
      if (sc > 0) scrolledOnce = true;
      state.revTraceSrb = ''; // v1.2.225：诊断轨迹已删除，仅复位内部变量
      if (!/1688\.com$/.test(location.hostname)) {
        // v1.1.138 提速分型：流畅期（连续有新增）1.4~2.8s 快节奏；等待批次/等待展开维持拟人化慢节奏；久候时拆分微滚，避免整轮死等
        var _grew = !!state.revFlow; // v1.1.145：使用上一完整轮提取后的真实新增结果
        var pause;
        if (_grew) {
          pause = 900 + Math.floor(Math.random() * 900); // v1.1.152 提速：流畅期 0.9~1.8s
        } else {
          pause = state.revExpandedEver ? 2800 + Math.floor(Math.random() * 1400) : 3500 + Math.floor(Math.random() * 3500);
          if (state.revExpandHinted && !state.revExpandedEver) pause += 1500 + Math.floor(Math.random() * 1500);
          if (noNewCount >= 3 && noNewCount < 6) {
            try { window.scrollBy(0, 200 + Math.floor(Math.random() * 150)); } catch (eSb2) {}
            pause = 1200 + Math.floor(Math.random() * 800);
          }
        }
        if (noNewCount >= 4) pause = 300 + Math.floor(Math.random() * 250); // v1.1.153 尾部越等越快
        else if (noNewCount >= 2) pause = 600 + Math.floor(Math.random() * 400); // v1.1.152 尾部快速检测：无新增即快节奏
        if (_grew && i > 0 && i % 12 === 0) { status('采集暂停一下，避免触发风控...'); pause += 4000 + Math.floor(Math.random() * 4000); } // v1.1.152：无新增（尾部）轮不叠加长休息
        await new Promise(function(res) { setTimeout(res, pause); });
      }
      if (state.revStop) { status('已手动停止采集，共 ' + state.reviews.length + ' 条', true); break; }
      // 2c. API 拦截缓存（图片快采四通道 review 响应）
      if (P && !state.revStop) {
        try {
          var cs = collectState();
          if (cs.review) {
            var reviewStr = '';
            try { reviewStr = JSON.stringify(cs.review) || ''; } catch (e4a) {}
            detectRevTotal(reviewStr);
            var apiList = P.parseReviews(cs.review) || [];
            if (!apiList.length && P.parseReviewsFromSsr) apiList = P.parseReviewsFromSsr(reviewStr) || [];
            revMergeList(apiList);
          }
        } catch (e4) {}
      }
      if ((state.revGen || 0) !== myGen) return; // v1.1.154：2c await 返回后再次校验
      // 2d. DOM 多源提取（弹层优先 → 评论区 → 全文档）
      if (!state.revStop) {
        try { revMergeList(multiSourceExtract()); } catch (e5) {}
      }
      domRevTotal();
      try { analyzeReviews(); renderReview(); } catch (e6) {}
      state.revFlow = state.reviews.length > _roundStartLen; // v1.1.145：提取完成后再判流畅态，供下一轮节奏/触底策略使用
      // 达到 limit 即停（截断）
      if (limit && state.reviews.length >= limit) {
        state.reviews = state.reviews.slice(0, limit);
        break;
      }
      // v1.1.88：绝对安全上限（防无底瀑布流长跑）
      if (state.reviews.length >= 2000) { status('已达安全上限 2000 条，停止采集', true); break; }
      // v1.1.152：已知评论总数快速收敛——采满即停，不再空滚
      if (state.revProgTotal > 0 && state.reviews.length >= state.revProgTotal) { status('✓ 已采满页面评论总数 ' + state.revProgTotal + ' 条，提前结束', true); break; }
      // 连续无新评论且已滚动过 → 判定到底；v1.1.128：批次间隔实测 4~5 轮（r5→r6、r7→r8），放宽 6/10→8/12 避免把等批当结束
      if (state.reviews.length <= prevLen) noNewCount++; else noNewCount = 0;
      prevLen = state.reviews.length;
      // v1.1.133：已提示但用户还没点展开 → 收敛阈值 8/12 放宽到 15/19（约多给 1 分钟点击窗口），点了自动继续
      var _patience = (state.revExpandHinted && !state.revExpandedEver) ? 15 : 6; // v1.1.152 收敛 8→6（尾部快节奏下 6 轮足够）
      // v1.1.154 快速判尾①：只接受真实可滚动容器，且连续两轮到底 + 连续 3 轮无新增。
      // 单次 scrollHeight===clientHeight 的未加载抽屉不再会被误判为“到底”。
      var _atBottom = revAtBottom();
      state.revBottomHits = _atBottom ? ((state.revBottomHits || 0) + 1) : 0;
      if (state.reviews.length > 0 && scrolledOnce && noNewCount >= 3 && state.revBottomHits >= 2) {
        state.revEndWhy = '已连续确认评论底部';
        var _rpB1 = $('aisimg-revprog-txt'); if (_rpB1) _rpB1.textContent = '✓ 已确认评论到底，共 ' + state.reviews.length + ' 条';
        break;
      }
      // v1.1.153 快速判尾②：达到页面声明总数的 98%（去重误差）即视为采满
      if (state.revProgTotal > 0 && state.reviews.length >= Math.ceil(state.revProgTotal * 0.98)) {
        state.revEndWhy = '已采满页面总数 ' + state.revProgTotal + ' 条';
        var _rpB2 = $('aisimg-revprog-txt'); if (_rpB2) _rpB2.textContent = '✓ 已采满 ' + state.revProgTotal + ' 条，提前结束';
        break;
      }
      if (noNewCount >= _patience && scrolledOnce) { state.revEndWhy = '连续无新增评论'; break; }
      if (noNewCount >= _patience + 4) { state.revEndWhy = '连续无新增评论'; break; }
    }
    // 3. 风控检测：命中且未停止且未超重试上限 → 倒计时后自动重试（最多 2 次）
    var risk = detectRevRisk(scrolledOnce, noNewCount, rounds);
    if (risk && !state.revStop && state.revRiskRetries < 1) {
      // v1.1.124：冷却从 300~600s 缩到 60~90s，最多自动重试 1 次（用户要求：翻页停了没滚动就尽快结束）
      state.revRiskRetries++;
      var waitMs = (60 + Math.floor(Math.random() * 30)) * 1000;
      var remain = Math.round(waitMs / 1000);
      var _rpW = $('aisimg-revprog-txt');
      while (remain > 0 && !state.revStop && (state.revGen || 0) === myGen) { // v1.1.153：被新采集接管则不再自续
        state.revBeat = Date.now(); // v1.1.153 冷却期心跳
        if (remain % 5 === 0) { status('⏳ 风控冷却中，剩余 ' + remain + ' 秒后自动重试（仅此一次）...'); if (_rpW) _rpW.textContent = '⏳ 冷却中 ' + remain + 's · 已 ' + state.reviews.length + ' 条'; }
        await new Promise(function(res) { setTimeout(res, 1000); });
        remain--;
      }
      if (!state.revStop && (state.revGen || 0) === myGen) {
        status('正在重试采集...');
        return runRevCollect(true);
      }
      status('已取消风控等待，保留已采集 ' + state.reviews.length + ' 条', true);
    }
    if ((state.revGen || 0) !== myGen) return; // v1.1.153：冷却/重试期间被接管 → 旧循环不再写任何 UI
    // v1.1.121：评论区模块缺失（未渲染/被平台限流）时如实提示（toast+进度条）
    try {
      if (!state.reviews.length && !findModal() && !findReviewRoot() && !/评价|评论/.test((document.body && document.body.innerText || '').slice(0, 30000))) {
        var _rpD = $('aisimg-revprog-txt'); if (_rpD) _rpD.textContent = '⚠ 页面评论区未加载（可能被限流）';
        status('页面评论区未加载（可能被平台限流），请刷新页面或稍后再试', true);
      }
    } catch (eDead) {}
    // 4. 收尾（按时间先后排序）
    if ((state.revGen || 0) !== myGen) return; // v1.1.153：新采集已开始，旧循环不得复位标记/刷 UI
    // v1.2.224：勾选「同时采集问大家」时，评论收尾前按页直取问答（主世界 mtop，零滚动零点击）
    try { await collectWdj(myGen); } catch (eWdjC) { try { status('问大家采集中止：' + ((eWdjC && eWdjC.message) || eWdjC), true); } catch (eWdjC2) {} }
    if ((state.revGen || 0) !== myGen) return;
    state.reviews = revSortList(state.reviews);
    state.revCollecting = false;
    // v1.1.88：拆分 try——分析/渲染任一失败都不得阻断明细显示；渲染失败再兜底直渲列表
    try { analyzeReviews(); } catch (e7a) {}
    try { renderReview(); } catch (e7b) { try { renderRevList(); } catch (e7c) {} }
    var sb2 = $('aisimg-revstop');
    if (sb2) { sb2.textContent = '停止采集'; sb2.disabled = true; }
    // v1.2.225：采集轨迹（诊断）已按用户要求删除，不再记录结束行
    // v1.1.145：完成/手停/安全验证三态分流，停止路径不得伪装成成功完成。
    var _finBase = '已采集 ' + state.reviews.length + ' 条评论' + (state.analysis && state.analysis.negativeCount ? ' · 高风险评论 ' + state.analysis.negativeCount : '') + ((state.wdjList || []).length ? ' · 问大家 ' + state.wdjList.length + ' 问/' + wdjAnswerCountAll() + ' 答' : '');
    var _finTitle = state.revCaptchaHit ? '⚠ 评论采集因安全验证停止' : (state.revStop ? '评论采集已停止' : '✓ 评论采集完成');
    var _finTxt = (state.revCaptchaHit ? '⚠ ' : (state.revStop ? '' : '✓ ')) + _finBase + (state.revCaptchaHit ? '（请手动完成验证后重试）' : (state.revStop ? '（已手动停止）' : '')) + (!state.revStop && rounds >= maxRounds - 1 ? '（已达轮数上限）' : '');
    var _finTone = state.revCaptchaHit ? 'warn' : (state.revStop ? 'warn' : (state.reviews.length ? 'ok' : 'warn'));
    status(_finTxt, true);
    var _rpF = $('aisimg-revprog-txt'); if (_rpF) _rpF.textContent = _finTxt;
    // v1.1.152：完成提示改为面板内文字卡（不再发浏览器系统通知）；结束即展示导出按钮
    try {
      var _oldDc = __AIS_DOC().getElementById('ais-rev-done-card');
      if (_oldDc && _oldDc.parentNode) _oldDc.parentNode.removeChild(_oldDc);
      var _dcard = __AIS_DOC().createElement('div');
      _dcard.id = 'ais-rev-done-card';
      _dcard.style.cssText = 'margin:8px 0;padding:10px 12px;border-radius:10px;font-size:13px;font-weight:600;line-height:1.7;background:' + (state.revCaptchaHit || state.revStop || !state.reviews.length ? '#fffbeb;color:#92400e;border:1px solid #fde68a;' : '#ecfdf5;color:#065f46;border:1px solid #a7f3d0;');
      _dcard.textContent = _finTitle + '：' + _finBase + (state.revEndWhy && !state.revStop && !state.revCaptchaHit ? '（' + state.revEndWhy + '）' : '') + (state.revStop || state.revCaptchaHit ? '' : '，可导出 CSV / Excel / JSON。');
      var _revArea = __AIS_DOC().getElementById('aisimg-revarea');
      if (_revArea && _revArea.parentNode) _revArea.parentNode.insertBefore(_dcard, _revArea.nextSibling);
    } catch (eDc) {}
    // v1.1.84：采集完成即记历史（评论快照不再依赖图片下载；同 URL 10 分钟内自动覆盖）
    try {
      var nImg = state.main.length + state.sku.length + state.desc.length;
      if (state.reviews.length || nImg) saveHistory(state.reviews.length ? state.reviews.length : nImg);
    } catch (e8h) {}
    state.revCollecting = false;
  }
  function detectRevTotal(jsonStr) {
    if (state.revProgTotal) return;
    try {
      var m = String(jsonStr || '').match(/"(?:total|totalCount|rateTotal|commentCount|reviewCount)"\s*:\s*(\d{1,6})/);
      var n = m ? parseInt(m[1], 10) : 0;
      if (n >= 5 && n <= 99999) state.revProgTotal = n;
    } catch (e) {}
  }
  function domRevTotal() {
    if (state.revProgTotal) return;
    try {
      var box = document.querySelector('.evaluation') || document.querySelector('[class*="evaluation"]') || document.querySelector('[class*="comment"][class*="header"]');
      var t = (box && box.textContent) || '';
      var dm = t.match(/共\s*(\d{1,6})\s*条/);
      if (dm) state.revProgTotal = parseInt(dm[1], 10);
    } catch (e) {}
  }
  function revMergeList(list) {
    var added = 0;
    (list || []).forEach(function(v) {
      if (!v || !v.content) return;
      var k = revDedupKey(v);
      // v1.2.207：双向合并——文本主键下区分真实评论 ID：
      //  · 真 ID 行（PDD store/淘宝 mtop/京东拦截——同日同文的默认评价不再互相误删，15→8 修复）：按 主键+ID 判重
      //  · 无 ID 或 d-hash 伪 ID 行（DOM 提取跨源变体）：主键下已有任何入库行即并入丢弃（保持原跨源合并强度）
      var id = String(v.reviewId || '');
      var rid = (id && !/^dh/i.test(id)) ? id : '';
      var e = revSeen2[k] || (revSeen2[k] = { r: {}, rLen: 0, n: 0 });
      if (rid) {
        if (e.r[rid]) return;
        if (state.reviews.some(function(z) { return revDedupKey(z) === k && String(z.reviewId || '') === rid; })) { e.r[rid] = 1; e.rLen++; return; }
        e.r[rid] = 1; e.rLen++;
      } else {
        if (e.n || e.rLen) return;
        if (state.reviews.some(function(z) { return revDedupKey(z) === k; })) { e.n = 1; return; }
        e.n = 1;
      }
      delete v.username;
      state.reviews.push(v);
      added++;
    });
    return added;
  }
  var revSeen = {};
  var revSeen2 = {};
  function startRevCollect() {
    // v1.1.153：修复「开始采集点不动」。旧版这里静默 return，一旦上一场采集异常/页面跳转
    // 导致 revCollecting 卡死，按钮就永久失效且毫无反馈。现在：心跳新鲜=提示进行中；
    // 心跳过期或无心跳=判定僵尸，自动接管重开。
    if (state.revCollecting) {
      var _beatAge = Date.now() - (state.revBeat || 0);
      if (state.revBeat && _beatAge < 40000) {
        aisToast('评论采集正在进行中（已采 ' + state.reviews.length + ' 条），如需重来请先点「停止采集」', 'warn');
        var _prS = $('aisimg-revprog'); if (_prS) _prS.style.display = '';
        var _rpS = $('aisimg-revprog-txt'); if (_rpS) _rpS.textContent = '⏳ 采集进行中 · 已 ' + state.reviews.length + ' 条（请勿重复点击）';
        return;
      }
      aisToast('上次采集未正常结束，已自动重置并重新开始', 'warn');
    }
    state.revGen = (state.revGen || 0) + 1; // v1.1.153 世代令牌：僵尸循环不得再写状态/UI
    state.revCollecting = true;
    state.revBeat = Date.now();
    state.revEndWhy = '';
    state.revBottomHits = 0;
    try { var _pr0 = $('aisimg-revprog'); if (_pr0) _pr0.style.display = ''; var _pt0 = $('aisimg-revprog-txt'); if (_pt0) _pt0.textContent = '▶ 正在启动评论采集…'; } catch (eSt0) {} // v1.1.153 点击即有反馈
    state.revStop = false;
    state.revRiskRetries = 0;
    revSeen = {};
    revSeen2 = {};
    state.revProgTotal = 0;
    state.revSavedCnt = 0; state.revSavedAt = 0; // v1.1.112 阶段性落盘基线
    state.revExpandTries = null; state.revExpandHinted = false; state.revDeadNoModule = false; // v1.1.116
    state.revExpandedEver = false; // v1.1.120 本场是否展开过
    state.revDomBase = null; state.revBtnAtStart = false; // v1.1.133 展开感知基线（首轮记录）
    state.revLastGap = null; state.revFlow = false; state.revT0 = Date.now(); state.revRetrigN = 0; state.revCaptchaHit = false; state.revExpandLocateDone = false; // v1.1.139/145 提速+防风控状态（首次只定位/6s窗口/重触发限频/滑块标记）
    state.revTraceSrb = ''; // v1.2.225 轨迹已删除（保留内部变量复位）
    state.revSsrDone = false; // v1.1.117 SSR 直读标记（每场一次）
    state.wdjList = []; state.wdjTotal = 0; state.wdjPages = 0; state.wdjEndWhy = ''; state.wdjErr = ''; // v1.2.224 问答随场次复位，禁止跨商品混采
    try { renderWdj(); } catch (eWdjR) {}
    // v1.1.116：采集起点清空评论拦截缓存——SPA 换商品后旧商品评论不再混入当前采集（「采出页面没有的评论」幻影源头）
    try {
      var _ic = window.__AIS_IMG_COLLECTOR__;
      if (_ic) { _ic.reviewResponse = null; _ic.allResponses = (_ic.allResponses || []).filter(function (x) { return !x || !/rate|comment|review/i.test(String(x.url || '')); }); }
      var _dc = window.__detailCollector && window.__detailCollector._interceptedData;
      if (_dc) _dc.reviewResponse = null;
    } catch (eClr) {}
    state.revShowDetail = false; // v1.1.88
    try { var _gd = __AIS_DOC().getElementById('aisimg-revdone'); if (_gd) _gd.style.display = 'none'; var _odc = __AIS_DOC().getElementById('ais-rev-done-card'); if (_odc && _odc.parentNode) _odc.parentNode.removeChild(_odc); } catch (eGd2) {} // v1.1.152 新一场开始：隐藏导出区与旧完成卡
    runRevCollect(false);
  }

  // ===== v1.1.38 差评分析展示模块（照搬 tb-media-assistant renderStats/renderNegReport/导出）=====
  var DISCLAIMER = '导出表格已标注「好评 / 高风险评论」，且不包含用户身份信息，仅用于选品分析；请遵守相关法律法规，勿用于公开传播。';
  var NEG_CATS = [
    { key: 'size', name: '尺码/版型', res: ['尺码', '偏大', '偏小', '大了', '小了', '大一号', '小一号', '不合身', '版型', '偏肥', '偏瘦', '太长', '太短', '紧身'] },
    { key: 'quality', name: '质量/做工', res: ['质量', '做工', '线头', '起球', '掉色', '褪色', '破损', '坏了', '开裂', '变形', '粗糙', '瑕疵', '异味', '用几天'] },
    { key: 'logi', name: '物流/售后', res: ['物流', '快递', '发货慢', '太慢', '迟迟', '延误', '几天才', '暴力', '漏发', '少发', '少件', '客服不处理', '客服不回复', '售后不处理'] },
    { key: 'color', name: '色差', res: ['色差', '有色差', '颜色不对', '颜色不一样', '偏色', '颜色差异', '实物颜色'] },
    { key: 'desc', name: '描述不符', res: ['描述不符', '与描述', '图片不符', '实物不符', '货不对板', '虚假宣传', '和图片不一样', '不像图片'] },
    { key: 'function', name: '功能/安全', res: ['无法使用', '不能使用', '死机', '闪退', '断连', '充不上电', '发烫', '漏电', '漏水', '烫手', '失灵', '卡顿', '异响', '影响使用'] },
    { key: 'health', name: '健康/食品安全', res: ['过敏', '刺痛', '发红', '变质', '发霉', '临期', '刺激', '不卫生', '肚子疼'] }
  ];
  function clusterNegatives(a) {
    var buckets = NEG_CATS.map(function (c) { return { key: c.key, name: c.name, items: [] }; });
    var other = { key: 'other', name: '其他', items: [] };
    var nrs = (a && a.negativeReviews) || [];
    // All collected risk comments are available.
    nrs.forEach(function (r) {
      var hit = null;
      var topics = r.topics || [];
      for (var ti = 0; ti < topics.length && !hit; ti++) {
        for (var i = 0; i < NEG_CATS.length && !hit; i++) if (NEG_CATS[i].name === topics[ti]) hit = buckets[i];
      }
      (hit || other).items.push(r);
    });
    buckets.push(other);
    var total = nrs.length;
    buckets.forEach(function (b) { b.pct = total ? Math.round(b.items.length / total * 100) : 0; });
    return { buckets: buckets, total: total };
  }
  function negReportRemove() {
    var old = $('aisimg-negreport');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }
  function renderNegReport() {
    negReportRemove();
    var a = state.analysis;
    var anchor = $('aisimg-revtips') || $('aisimg-revneg');
    if (!anchor || !a || !a.negativeReviews || !a.negativeReviews.length) return;
    var cl = clusterNegatives(a);
    var card = D().createElement('div');
    card.id = 'aisimg-negreport';
    card.style.cssText = 'background:#fff;border:1px solid #E6EAF0;border-radius:10px;padding:10px 12px;margin:8px 0;';
    var h = '<div style="font-weight:600;font-size:12px;margin:0 0 6px;">高风险问题聚类报告（共 ' + cl.total + ' 条）</div>';
    h += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px;">' + cl.buckets.filter(function (b) { return b.items.length; }).map(function (b) {
      return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:11px;' + (b.key === 'other' ? 'background:#EEF1F5;color:#5B6673;' : 'background:#FDEEEE;color:#B3261E;') + '">' + esc(b.name) + ' ' + b.items.length + ' 条 · ' + b.pct + '%</span>';
    }).join('') + '</div>';
    var top2 = cl.buckets.filter(function (b) { return b.items.length && b.key !== 'other'; }).sort(function (x, y) { return y.items.length - x.items.length; }).slice(0, 2);
    top2.forEach(function (b) {
      h += '<div style="margin:4px 0 8px;"><div style="font-size:12px;font-weight:600;color:#3D4854;">' + esc(b.name) + '（' + b.items.length + ' 条）</div>' + b.items.slice(0, 3).map(function (r) {
        return '<div style="font-size:11px;color:#6B7684;padding:2px 0;">「' + esc(String(r.content || '').slice(0, 42)) + '」</div>';
      }).join('') + '</div>';
    });
    h += '<button type=button id=aisimg-negreport-xlsx style="margin-top:2px;padding:5px 10px;border:1px solid #D8DEE7;border-radius:8px;background:#F7F9FC;color:#3D4854;font-size:12px;cursor:pointer;">导出聚类报告 Excel</button>';
    card.innerHTML = h;
    var btn = card.querySelector('#aisimg-negreport-xlsx');
    if (btn) btn.addEventListener('click', negReportExport);
    if (anchor.nextSibling) anchor.parentNode.insertBefore(card, anchor.nextSibling);
    else anchor.parentNode.appendChild(card);
  }
  function negReportExport() {
    if (!requireMember('差评分析导出')) return;
    var a = state.analysis;
    if (!a || !a.negativeReviews || !a.negativeReviews.length) { status('没有高风险评论数据'); return; }
    try {
      var cl = clusterNegatives(a);
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, __aisSheet(cl.buckets.filter(function (b) { return b.items.length; }).map(function (b) {
        return { '原因类别': b.name, '评论数': b.items.length, '占比': b.pct + '%' };
      })), '聚类汇总');
      var det = [];
      cl.buckets.forEach(function (b) {
        b.items.forEach(function (r) { det.push({ '聚类原因': b.name, '星级': r.rating || '', '规格': r.skuInfo || '', '时间': r.time || '', '内容': String(r.content || '').slice(0, 200) }); });
      });
      det.sort(function (x, y) { var tx = revTimeKey({ time: x['时间'] }), ty = revTimeKey({ time: y['时间'] }); return (isNaN(tx) ? Infinity : tx) - (isNaN(ty) ? Infinity : ty); });
      XLSX.utils.book_append_sheet(wb, __aisSheet(det), '高风险评论明细');
      var trows = (a.purchaseTips || []).slice(0, 20).map(function (t, i) { return { '序号': i + 1, '分类': (t.topics || []).join(' / ') || '购买建议', '内容': String(t.content || '').slice(0, 200), '规格': t.skuInfo || '', '时间': t.time || '' }; });
      if (!trows.length) trows.push({ '序号': '', '分类': '', '内容': '本次未识别到购买提醒', '规格': '', '时间': '' });
      XLSX.utils.book_append_sheet(wb, __aisSheet(trows), '购买提醒');
      XLSX.utils.book_append_sheet(wb, __aisSheet([{ '说明': DISCLAIMER }]), '免责声明');
      var bx = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
      var name = (state.itemTitle || '评论').slice(0, 40);
      sendBg({ action: 'downloadData', base64: bx, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: name + '_高风险问题聚类报告.xlsx' });
      status('高风险评论+购买提醒报告导出中…');
    } catch (e) { status('聚类报告导出失败：' + e.message); }
  }

  // ===== v1.1.38 差评分析展示模块（照搬 tb-media-assistant renderStats/renderNegReport/导出）=====

  function revItemHtml(r, isBad) {
    var st = '', rt2 = r.rating || 0;
    if (!isTaobaoFamilyHost()) { for (var k = 0; k < 5; k++) st += k < rt2 ? '★' : '☆'; } // v1.1.124：淘宝无星级展示
    var ap = r.append || r.appendReply || r.appendContent || '';
    var im = (r.images || r.pics || []).slice(0, 6);
    var imh = '';
    im.forEach(function (u) { if (u) imh += '<img class="rimg" src="' + esc(u) + '" loading="lazy" referrerpolicy="no-referrer">'; });
    return '<div class="ritem' + (isBad ? ' bad' : '') + '">'
      + '<div class="rmeta">' + (st ? '<span class="rstars">' + st + '</span>' : '')
      + '<span class="rdate">' + esc(String(r.time || '').slice(0, 10)) + '</span>'
      + (isBad ? '<span class="rrisk">风险</span>' : '') + '</div>'
      + (r.skuInfo ? '<div class="rsku">' + esc(r.skuInfo) + '</div>' : '')
      + '<div class="rcontent">' + esc(r.content || '') + '</div>'
      + (imh ? '<div class="rimgs">' + imh + '</div>' : '')
      + (ap ? '<div class="rappend"><b>追评</b>' + esc(ap) + '</div>' : '')
      + '</div>';
  }
  function renderRevList() {
    var rl = $('aisimg-revlist');
    if (!rl) return;
    // v1.2.227：评论明细一律不显示（采集前/中/后都不刷屏）；面板只实时显示风险评论，免费版 3 条、会员 60 条
    var rs = revSortList(state.reviews);
    var negSet = {};
    // v1.2.311：reviewId 在不同链路里形态不一（''/undefined），1688 上导致瓦片=1 而明细=0 —— 匹配键改为 内容+星级+时间
    var negK = function (r) { return String(r.content || '').slice(0, 60) + '|' + (r.rating || 0) + '|' + String(r.time || '').slice(0, 16); };
    ((state.analysis && state.analysis.negativeReviews) || []).forEach(function (r2) { negSet[negK(r2)] = 1; });
    var risk = rs.filter(function (r) { return negSet[negK(r)] || (!isTaobaoFamilyHost() && r.rating && r.rating <= 2); });
    var member = false; try { member = isMemberNow(); } catch (eMm) {}
    var lim = 60; // UI page size; full data remains available in exports.
    var shown = risk.slice(0, lim);
    var html = '<div class="ais-sechead"><span class="t warn">' + (state.revCollecting ? '采集中 · ' : '') + '风险评论</span>'
      + '<span class="ais-pill">' + risk.length + '</span>'
      + (member ? '' : '<span class="ais-pill grey">免费版仅前 3 条</span>') + '</div>'
      + (risk.length ? '<div class="ais-hint">下面只列出有风险的评论；完整评论都在导出文件里' + ((state.wdjList || []).length ? '，问大家见下方' : '') + '。' + ((state.wdjList || []).length ? ('问大家 ' + state.wdjList.length + ' 问见下方预览') : '完成后可导出 CSV / Excel / JSON') + '</div></div>' : '');
    shown.forEach(function (r) { html += revItemHtml(r, true); });
    if (!risk.length) html += '<div class="ais-emptyx"><div class="ic">🛡️</div><div class="tx">暂未发现风险评论</div><div class="sb">已按差评与高风险规则扫描，本次无命中</div></div>';
    else if (risk.length > shown.length) html += '<div style="padding:4px 2px;font-size:11px;color:#94a3b8;">其余 ' + (risk.length - shown.length) + ' 条不在面板显示，导出文件内可见全部</div>';
    rl.innerHTML = html;
  }
  function revStripSkuMeta(s) {
    var txt = String(s == null ? '' : s).trim();
    var date = '';
    var m = txt.match(/^(\d{4}[-/.年]\s*\d{1,2}[-/.月]\s*\d{1,2}\s*日?(?:\s*\d{1,2}:\d{2}(?::\d{2})?)?)\s*/);
    if (m) { date = m[1].trim(); txt = txt.slice(m[0].length); }
    txt = txt.replace(/^已购[：:]\s*/, '').trim();
    return { date: date, sku: txt };
  }
  function revSkuAttrs(skuText) {
    var named = {}, rest = [];
    String(skuText || '').split(/[；;\n\r]+/).forEach(function (p) {
      p = p.trim(); if (!p) return;
      var m = p.match(/^([^：:]{1,12})[：:](.+)$/);
      if (m) { var k = m[1].trim(), v = m[2].trim(); if (k && v) { named[k] = named[k] ? named[k] + ' ' + v : v; return; } }
      rest.push(p);
    });
    return { named: named, rest: rest.join('  ') };
  }
  function revCleanSkuAgainstContent(sku, content) {
    var c = String(content || '');
    var parts = String(sku || '').split(/\s+/).filter(Boolean);
    var kept = parts.filter(function (t) {
      if (t.length < 3) return true;
      return c.indexOf(t) < 0;
    });
    return kept.join(' ').trim();
  }
  function revIsTaobao() {
    return (typeof AIS !== 'undefined' && AIS && AIS._currentPlatform === 'taobao') || /taobao\.com|tmall\.com/i.test(String((typeof location !== 'undefined' && location.href) || ''));
  }
  function revOrderedCols(rows, tb) {
    var keys = unionRowKeys(rows);
    if (!tb) return keys;
    var head = ['序号', '时间'];
    var tail = ['内容', '追评', '图片数', '带图', '图片地址', '差评原因'];
    var mid = keys.filter(function (k) { return head.indexOf(k) < 0 && tail.indexOf(k) < 0; });
    return head.concat(mid).concat(tail.filter(function (k) { return keys.indexOf(k) >= 0; }));
  }
  function dispTextLen(v) { var s2 = String(v == null ? '' : v); var w = 0; for (var i = 0; i < s2.length; i++) w += s2.charCodeAt(i) > 255 ? 2 : 1; return w; }
  // v1.2.453【与电商宝导出格式一致】列宽规则照搬电商宝 extracted/lib/export.js fieldWidth()：
  //   特例表（规格 26 / 商品标题 32 / 评论内容 64 …）优先；否则 max(表头宽+4, 前 120 行值宽+3)，夹在 [10,34]。
  //   参考文件实测列宽 = 本规则结果 + 0.8（Excel 读回 padding）：序号 10.8 / 商品标题 32.8 / 商品ID 15.8 / 商品链接 34.8 …
  function tbmaFieldWidth(field, rows) {
    var special = { '评论内容': 64, '内容': 64, '图片链接': 56, '说明': 72, '规格': 26, '销售属性值': 32, '主图链接': 52, '商品名称': 32, '宝贝名称': 32, '商品标题': 32, '问题证据': 28, '问题主题': 20 };
    if (special[field]) return special[field];
    var w = dispTextLen(field) + 4;
    var n = Math.min((rows || []).length, 120);
    for (var i = 0; i < n; i++) w = Math.max(w, dispTextLen(rows[i][field]) + 3);
    return Math.max(10, Math.min(w, 34));
  }
  // v1.2.438：列顺序把【序号/行号】放最前（用户要求：序列号排第一列 ✓），其余保持首次出现顺序
  function unionRowKeys(rows) { var cs = [], PRI = ['序号', '行号']; if (rows && rows.length) { PRI.forEach(function (k) { if (k in rows[0]) cs.push(k); }); } (rows || []).forEach(function (r2) { Object.keys(r2).forEach(function (k) { if (cs.indexOf(k) < 0) cs.push(k); }); }); return cs; }
  async function exportStyledWorkbook(sheets, filename) {
    if (typeof XLSX === 'undefined') throw new Error('XLSX 未加载');
    // Work on a copy so repeat exports never accumulate thumbnail columns.
    sheets = Object.fromEntries(Object.entries(sheets).map(function (entry) {
      return [entry[0], Object.assign({}, entry[1], { headers: entry[1].headers.slice(), rows: entry[1].rows.map(function (r) { return Object.assign({}, r); }) })];
    }));
    var pictures = await AisReviewXlsxImages.prepare(sheets, function (done, total) {
      status('Excel 图片准备中：' + done + '/' + total);
    });
    var names = Object.keys(sheets);
    var allColWidths = {};
    names.forEach(function (name) {
      var sh = sheets[name];
      // v1.2.454【所有表格统一电商宝口径】未显式给 title 的表自动补「标题 + 导出时间·条数」⇒
      //   面板的评论/问大家/差评导出、历史打包里的评论/问大家/SKU 表、整合包里的表全部自动变成
      //   「三行表头 + 自动筛选 + 斑马纹 + 电商宝色板 + fieldWidth 列宽」，不再只有 SKU 一张表是新格式。
      if (!sh.title) {
        sh.title = '电商采集大师 · ' + name;
        sh.subtitle = exportStamp((sh.rows || []).length);
      }
      // +0.8：电商宝的列宽 XML 就是「fieldWidth + 0.8」（参考文件实测 10.8/32.8/15.8…），照抄以保证逐列一致
      allColWidths[name] = sh.headers.map(function (h) { return /^评论图片\d+$/.test(h) ? 18 : tbmaFieldWidth(h, sh.rows) + 0.8; });
    });
    var wb = XLSX.utils.book_new();
    names.forEach(function (name) {
      var sh = sheets[name];
      var aoa = [sh.headers];
      sh.rows.forEach(function (r) { aoa.push(sh.headers.map(function (h) { var v = r[h]; return v === null || v === undefined ? '' : v; })); });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = allColWidths[name].map(function (w) { return { wch: w }; });
      XLSX.utils.book_append_sheet(wb, ws, name.substring(0, 31));
    });
    var styled = false;
    var out = XLSX.write(wb, { bookType: 'xlsx', type: 'array', bookSST: false });
    if (typeof JSZip !== 'undefined' && typeof injectXlsxStyles === 'function') {
      try { var st = await injectXlsxStyles(out, names, sheets, allColWidths); if (st) { out = st; styled = true; } } catch (e) {}
    }
    out = await AisReviewXlsxImages.embed(out, sheets, pictures, styled);
    if (pictures.failed) aisToast('有 ' + pictures.failed + ' 张图片未能嵌入，已在表格标注并保留原链接', 'warn');
    var bytes = new Uint8Array(out);
    var bin = '';
    for (var i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 32768, bytes.length)));
    return btoa(bin);
  }
  function revToRows(list, negReviews) {
    var negMap = {};
    ((negReviews || (state.analysis && state.analysis.negativeReviews)) || []).forEach(function (r2) { if (r2.reviewId) negMap[String(r2.reviewId)] = (r2.reasons || []).join("、"); });
    var tb = revIsTaobao();
    var rows = [];
    revSortList(list || state.reviews).forEach(function (r, i) {
      var imageUrls = Array.from(new Set((r.images || r.pics || []).concat(r.appendImages || []).filter(Boolean)));
      var imgN = imageUrls.length;
      var row = { 序号: i + 1 };
      if (tb) {
        var tmM = revStripSkuMeta(r.time);
        var smM = revStripSkuMeta(r.skuInfo);
        row['时间'] = tmM.sku ? tmM.date : (r.time || smM.date || "");
        var skuTexts = [];
        if (smM.sku) skuTexts.push(smM.sku);
        if (tmM.sku && tmM.sku !== smM.sku) skuTexts.push(tmM.sku);
        skuTexts = skuTexts.map(function (st) { return revCleanSkuAgainstContent(st, r.content); }).filter(function (st) { return st; });
        var named = {}, restP = [];
        skuTexts.forEach(function (st) {
          var at = revSkuAttrs(st);
          Object.keys(at.named).forEach(function (k) { named[k] = named[k] ? named[k] + ' ' + at.named[k] : at.named[k]; });
          if (at.rest) restP.push(at.rest);
        });
        Object.keys(named).forEach(function (k) { row[k] = named[k]; });
        if (restP.length) row['SKU信息'] = restP.join('  ');
      } else {
        row['评价类型'] = negMap[String(r.reviewId)] ? "高风险评论" : ((r.rating || 0) >= 4 ? "好评" : ((r.rating || 0) <= 2 && r.rating ? "差评" : "中评"));
        if (!isTaobaoFamilyHost()) row['星级'] = r.rating || ""; // v1.1.124：淘宝无星级，导出也不带
        row['SKU'] = r.skuInfo || "";
        row['时间'] = r.time || "";
      }
      row['内容'] = r.content || "";
      row['追评'] = r.append || r.appendReply || r.appendContent || "";
      row['图片数'] = imgN;
      row['带图'] = imgN ? "是" : "否";
      // v1.2.229（P2）：评论图片地址属会员权益（评论图片下载）——非会员导出留空，避免用导出链接绕过付费点
      var _urlOk = false;
      try { _urlOk = isMemberNow(); } catch (eUrl) { _urlOk = false; }
      row['图片地址'] = imageUrls.join(" ");
      row['差评原因'] = negMap[String(r.reviewId)] || "";
      rows.push(row);
    });
    return rows;
  }
  function revExport(kind) {
    var rows = revToRows();
    if (!rows.length) { status('没有评论数据'); return; }
    var cols = revOrderedCols(rows, revIsTaobao());
    var name = (state.itemTitle || '评论').slice(0, 40);
    if (kind === 'json') { var bj = btoa(unescape(encodeURIComponent(JSON.stringify(rows, null, 2)))); sendBg({ action: "downloadData", base64: bj, mime: "application/json", filename: name + "_评论.json" }); status("JSON 导出中…"); return; }
    if (kind === 'xlsx') {
      var button = $('aisimg-revexp-xlsx');
      if (button && button.disabled) return;
      if (button) { button.disabled = true; button.textContent = '正在生成 Excel…'; }
      exportRevXlsx().catch(function (e) { status('Excel 导出失败：' + e.message); }).finally(function () {
        if (button) { button.disabled = false; button.textContent = '导出 Excel（含图片）'; }
      });
      return;
    }
    var BOM = String.fromCharCode(65279);
    var a3 = state.analysis || {};
    var bc = btoa(unescape(encodeURIComponent(BOM + skuToCsv(rows, cols) + String.fromCharCode(10) + String.fromCharCode(10) + '统计汇总：评论总数 ' + (a3.total || rows.length) + ' · 好评率 ' + (a3.goodRate || 0) + '% · 高风险评论 ' + (a3.negativeCount || 0) + ' · 带图率 ' + (a3.withImageRate || 0) + '% · 追评 ' + (a3.appendCount || 0) + String.fromCharCode(10) + '免责声明：' + DISCLAIMER)));
    sendBg({ action: "downloadData", base64: bc, mime: "text/csv", filename: name + "_评论.csv" });
    aisToast("CSV 已导出", "info");
  }
  async function exportRevXlsx() {
    var rows = revToRows();
    if (!rows.length) { status('没有评论数据'); return; }
    var a2 = state.analysis || {};
    var name = (state.itemTitle || '评论').slice(0, 40);
    var sheets = {
      '评论': { headers: revOrderedCols(rows, revIsTaobao()), rows: rows },
      '统计汇总': { headers: ['指标', '值'], rows: [{ '指标': '评论总数', '值': a2.total || rows.length }, { '指标': '好评率', '值': (a2.goodRate || 0) + '%' }, { '指标': '高风险评论数', '值': a2.negativeCount || 0 }, { '指标': '高风险评论率', '值': (a2.badRate || 0) + '%' }, { '指标': '带图率', '值': (a2.withImageRate || 0) + '%' }, { '指标': '追评数', '值': a2.appendCount || 0 }] },
      '免责声明': { headers: ['说明'], rows: [{ '说明': DISCLAIMER }] }
    };
    if ((state.wdjList || []).length) { // v1.2.224：评论 Excel 同步附带问答两张表（问大家 / 问大家-回答明细）
      var wq = wdjToRows(), wa = wdjAnswerRows();
      sheets['问大家'] = { headers: unionRowKeys(wq), rows: wq };
      sheets['问大家-回答明细'] = { headers: unionRowKeys(wa), rows: wa };
    }
    var b64 = await exportStyledWorkbook(sheets, name + '_评论.xlsx');
    var r3 = await sendBg({ action: 'downloadData', base64: b64, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: name + '_评论.xlsx' });
    if (r3 && r3.ok) statusLink('评论 Excel 已导出' + (r3.fileName ? ' · ' + r3.fileName : ''), true, r3.downloadId);
    else status('评论 Excel 导出失败' + (r3 && r3.error ? '：' + r3.error : ''));
  }
  // ===== v1.2.224 「问大家」问答采集（淘宝/天猫详情页 mtop.taobao.wdj.list.merge.search，主世界页面 SDK 签名，零滚动零点击） =====
  function wdjOnHost() { try { return /(^|\.)(taobao|tmall)\.com$/.test(location.hostname); } catch (eH) { return false; } }
  function wdjAskOn() { var cb = $('aisimg-wdj-on'); return wdjOnHost() && !!(cb && cb.checked); } // v1.2.239：非淘宝/天猫永不采集问大家
  // v1.2.239：问大家是淘宝/天猫专属（mtop 接口）——其它平台把整块 UI 隐藏并强制关闭，避免误勾选/误报
  function syncWdjUi() {
    try {
      if (wdjOnHost()) return;
      ['aisimg-wdj-row', 'aisimg-wdjfull-row', 'aisimg-wdjdl', 'aisimg-wdjprev'].forEach(function (id) {
        var el = $(id); if (el) el.style.display = 'none';
      });
      var cb = $('aisimg-wdj-on'); if (cb) cb.checked = false;
      var cb2 = $('aisimg-wdj-full'); if (cb2) cb2.checked = false;
      var bd = $('aisimg-wdj-sum'); if (bd) { bd.style.display = 'none'; bd.textContent = '0'; }
      state.wdjList = []; state.wdjTotal = 0; state.wdjPages = 0;
    } catch (eWU2) {}
  }
  function wdjDedupKey(q) { return String((q && q.questionId) || (((q && q.content) || '') + '|' + ((q && q.time) || ''))); }
  function wdjTs(at) {
    try { var d = new Date(at || state.wdjAt || Date.now()); var p = function (n) { return (n < 10 ? '0' : '') + n; }; return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()); } catch (eT) { return ''; }
  }
  function wdjAnswerCountAll() { var n = 0; (state.wdjList || []).forEach(function (q) { n += (q.answers || []).length; }); return n; }
  function mergeWdj(list) {
    state.wdjList = state.wdjList || [];
    var seen = {}; (state.wdjList || []).forEach(function (q) { seen[wdjDedupKey(q)] = 1; });
    var added = 0;
    (list || []).forEach(function (q) {
      if (!q || !(q.content || q.questionId)) return;
      var k = wdjDedupKey(q); if (seen[k]) return; seen[k] = 1;
      state.wdjList.push(q); added++;
    });
    return added;
  }
  // v1.2.357：问大家「解除保护」入口绑定（两个位置共用一个实现）
  function bindWdjClear() {
    ['aisimg-wdj-clear', 'aisimg-wdj-clear2'].forEach(function (id) {
      try {
        var el = $(id); if (!el || el.__bound) return; el.__bound = 1;
        el.addEventListener('click', function (e) { e.stopPropagation(); try { window.__AIS_WDJ_CLEAR__(); } catch (e2) {} try { renderWdj(); } catch (e3) {} });
      } catch (e0) {}
    });
  }
  function renderWdj() {
    if (!wdjOnHost()) { // v1.2.239：非淘宝/天猫不渲染问大家（含导出按钮与预览）
      var _b = $('aisimg-wdj-sum'), _d = $('aisimg-wdjdl'), _p = $('aisimg-wdjprev');
      if (_b) _b.style.display = 'none';
      if (_d) _d.style.display = 'none';
      if (_p) { _p.style.display = 'none'; _p.innerHTML = ''; }
      return;
    }
    var qs = state.wdjList || [];
    var badge = $('aisimg-wdj-sum'), dl = $('aisimg-wdjdl'), prev = $('aisimg-wdjprev');
    if (badge) { badge.textContent = qs.length ? (qs.length + ' 问 / ' + wdjAnswerCountAll() + ' 答') : '0'; badge.style.display = qs.length ? '' : 'none'; }
    if (dl) dl.style.display = qs.length ? '' : 'none';
    if (!prev) return;
    if (!qs.length) {
      // v1.2.357：被风控闸门挡住时【必须显示原因 + 解除入口】——原来这里直接隐藏整块，用户只看到"采不到"。
      wdjGuardLoad().then(function (g) {
        var now2 = Date.now();
        var hot = (g.runs || []).filter(function (t) { return now2 - t < 3600000; });
        var msg = '';
        if (g.blockedUntil && now2 < g.blockedUntil) msg = '为保护账号，问大家采集暂停中，约 ' + wdjMin(g.blockedUntil) + ' 分钟后自动恢复';
        else if (hot.length) msg = '本小时已采集 ' + hot.length + ' 个商品的问大家，达到安全上限';
        else if (state.wdjErr) msg = '采集失败：' + state.wdjErr;
        if (!msg) { prev.style.display = 'none'; prev.innerHTML = ''; return; }
        prev.style.display = '';
        prev.innerHTML = '<div class="ais-actionline"><span>🛡️</span><span class="tx">' + esc(msg) + '</span><a href="javascript:void(0)" id="aisimg-wdj-clear">立即解除限制</a></div>';
        bindWdjClear();
      });
      return;
    }
    var h = '<details class="ais-wdj" open><summary><span>问大家</span><span class="ais-pill">' + qs.length + ' 问</span><span class="cv">›</span></summary><div class="list">';
    qs.slice(0, 8).forEach(function (q, i) {
      h += '<div class="qi">';
      h += '<div class="qh"><span class="n">问' + (i + 1) + '</span><span class="qt">' + esc(q.content) + '</span></div>';
      var meta = [];
      if (q.time) meta.push(esc(String(q.time).slice(0, 16)));
      if (q.ipLocat) meta.push(esc(String(q.ipLocat)));
      if (meta.length) h += '<div class="m">' + meta.join(' · ') + '</div>';
      h += '<div class="as">';
      (q.answers || []).forEach(function (an, j) {
        var tg = an.userTags ? String(an.userTags).replace(/^[\[\s]+|[\]\s]+$/g, '') : '';
        h += '<div class="an"><b>答' + (j + 1) + '</b>' + esc(an.content) + (tg ? '<span class="ais-tag bought">' + esc(tg) + '</span>' : '') + '</div>';
      });
      if ((q.answerCount || 0) > (q.answers || []).length) h += '<div class="an" style="color:#94a3b8;">（该问共 ' + q.answerCount + ' 条回答，列表接口只返回首条）</div>';
      h += '</div></div>';
    });
    if (qs.length > 8) h += '<div class="ais-more">…… 其余 ' + (qs.length - 8) + ' 问见导出文件</div>';
    if (state.wdjErr) h += '<div class="ais-more" style="color:#b45309;">接口提示：' + esc(state.wdjErr) + '</div>';
    h += '</div></details>';
    h += '<div class="ais-actionline"><span>🛡️</span><span>后续商品若被风控保护挡住，可</span><a href="javascript:void(0)" id="aisimg-wdj-clear2">解除保护</a></div>';
    prev.innerHTML = h;
    bindWdjClear(); prev.style.display = '';
  }
  // ---- v1.2.226 问大家风控闸门：请求预算 + 每 8 请求长休息 + 命中风控即熔断冷却 + 同商品/每小时频控 ----
  var WDJ_GUARD_KEY = 'aisWdjGuard';
  function wdjGuardLoad() { return storeGet(WDJ_GUARD_KEY).then(function (g) { return (g && typeof g === 'object') ? g : {}; }); }
  function wdjGuardSave(g) { var o = {}; o[WDJ_GUARD_KEY] = g; return storeSet(o); }
  function wdjHardBlock(errStr) { // 平台风控/流控硬信号：一律立即熔断，绝不重试
    var s = String(errStr || '');
    var __re = null; try { __re = new RegExp(aisSel('common.wdjHardBlockRe', ''), 'i'); } catch (eRe) {}
    // v1.2.357：远程正则与内置基线取【并集】——远程只能【追加】风控信号，不能悄悄削弱保护
    var __base = /USER_VALIDATE|RGV587|bxpunish|punish|_____tmd_|TRAFFIC_LIMIT|FAIL_SYS_.*LIMIT|SLIDE|captcha|NC_\w*|需要验证|安全验证|滑块/i;
    return (__re ? __re.test(s) : false) || __base.test(s);
  }
  function wdjMin(ts) { return Math.max(1, Math.ceil((ts - Date.now()) / 60000)); }
  async function wdjAdmit(itemId) {
    var g = await wdjGuardLoad(); var now = Date.now();
    if (g.blockedUntil && now < g.blockedUntil) return { ok: false, why: '为保护账号，问大家采集暂停中，约 ' + wdjMin(g.blockedUntil) + ' 分钟后自动恢复' };
    if (itemId && g.itemCd && g.itemCd[itemId] && now < g.itemCd[itemId]) return { ok: false, why: '这个商品的问大家刚刚采过，约 ' + wdjMin(g.itemCd[itemId]) + ' 分钟后可再采' };
    var maxRuns = 20; try { maxRuns = Math.max(1, Number(aisNum('common.wdjMaxRunsPerHour', 20)) || 20); } catch (eMR) {}
    var runs = (g.runs || []).filter(function (t) { return now - t < 3600000; });
    if (runs.length >= maxRuns) return { ok: false, why: '本小时已采集 ' + runs.length + ' 个商品的问大家，达到安全上限（防止被平台限制）' };
    // v1.2.357：放行时不占名额（只有真正采到数据的场次才由 wdjMarkRun 计入）
    return { ok: true };
  }
  async function wdjMarkRun() { // v1.2.357：只有真正采到数据的场次才计入每小时配额
    try { var g = await wdjGuardLoad(); g.runs = (g.runs || []).filter(function (t) { return Date.now() - t < 3600000; }); g.runs.push(Date.now()); await wdjGuardSave(g); } catch (eMr) {}
  }
  // v1.2.357：手动解除问大家风控保护（熔断/商品冷却/场次计数全清）——用户被误判时可自救
  try {
    window.__AIS_WDJ_CLEAR__ = function () {
      try {
        var o = {}; o[WDJ_GUARD_KEY] = {};
        return storeSet(o).then(function () { try { status('已解除问大家风控保护（可立即重采）', true); } catch (e1) {} return true; });
      } catch (e2) { return false; }
    };
  } catch (e3) {}
  async function wdjPunish(itemId, why) { // 命中风控：全局熔断（默认 10 分钟，远程可调）+ 该商品冷却 60 分钟
    try {
      var g = await wdjGuardLoad(); var now = Date.now();
      var blkMin = 10;
      try { blkMin = Math.max(1, Number(aisNum('common.wdjBlockMin', 10)) || 10); } catch (eBM) {}
      g.blockedUntil = now + blkMin * 60000;   // v1.2.357：30 分钟 → 默认 10 分钟（远程可调）
      g.itemCd = g.itemCd || {}; if (itemId) g.itemCd[itemId] = now + 60 * 60000;
      g.lastWhy = String(why || '').slice(0, 160); g.lastAt = now;
      await wdjGuardSave(g);
    } catch (eGu) {}
  }
  async function wdjCdItem(itemId, mins) { // 正常收工也给同商品一个短冷却，避免手滑连点
    if (!itemId) return;
    try {
      var g = await wdjGuardLoad(); g.itemCd = g.itemCd || {};
      g.itemCd[itemId] = Date.now() + mins * 60000; await wdjGuardSave(g);
    } catch (eGc) {}
  }
  async function wdjBeat(minMs, maxMs) { // 请求节奏：每满 8 次请求强制长休息 6~12s
    state.wdjReqs = state.wdjReqs || 0;
    if (state.wdjReqs > 0 && state.wdjReqs % 8 === 0) {
      var l = 6000 + Math.floor(Math.random() * 6000);
      status('⏸ 已发 ' + state.wdjReqs + ' 次接口请求，休息 ' + Math.round(l / 1000) + 's（风控保护）…');
      await new Promise(function (rr2) { setTimeout(rr2, l); });
      return;
    }
    await new Promise(function (rr2) { setTimeout(rr2, minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs))); });
  }
  function wdjBudgetOf(member) { return 120; } // 单场总请求预算（列表页 + 逐问补全合计）
  async function collectWdj(myGen) {
    if (!wdjAskOn() || !wdjOnHost()) return;
    var itemId = String(state.itemId || '');
    if (!itemId) { try { var mm = String(location.href).match(/[?&]id=(\d{6,20})/); if (mm) itemId = mm[1]; } catch (eId) {} }
    var admit = await wdjAdmit(itemId); // v1.2.226：闸门不过直接不发热请求
    if (!admit.ok) { status('问大家暂未采集：' + admit.why + '（可在面板点「立即解除限制」继续）', true); try { aisToast('问大家暂未采集：' + admit.why, 'warn'); } catch (eAd) {} return; }
    state.wdjList = []; state.wdjTotal = 0; state.wdjPages = 0; state.wdjErr = ''; state.wdjEndWhy = ''; state.wdjAt = Date.now();
    var member = false; try { member = isMemberNow(); } catch (eM) {}
    state.wdjReqs = 0; state.wdjBudget = wdjBudgetOf(member);
    renderWdj();
    var maxPages = 30;   // 免费版 5 页（50 问），会员最多 30 页
    var hardCap = 300;  // 问答量级安全上限
    var fail = 0, why = '';
    status('② 开始采集「问大家」问答（评论已采集完毕）· 本场请求预算 ' + state.wdjBudget + ' 次…');
    for (var pg = 1; pg <= maxPages; pg++) {
      if (state.revStop) { why = '已手动停止'; break; }
      if ((state.revGen || 0) !== myGen) return;
      if (state.wdjReqs >= state.wdjBudget) { why = '已达本场请求预算 ' + state.wdjBudget + ' 次'; break; }
      var res = null;
      try { res = await sendBg({ action: 'mainWorldTaobaoWdj', itemId: itemId, page: pg, pageSize: (function(){try{return Number(aisNum('common.reviewPageSize',10))||10;}catch(e){return 10;}})() }, 25000); } catch (eW) {}
      state.wdjReqs++;
      if ((state.revGen || 0) !== myGen) return;
      if (!res || res.success === false) {
        var er = String((res && res.error) || '接口无响应');
        state.wdjErr = er.slice(0, 120);
        if (wdjHardBlock(er)) { await wdjPunish(itemId, er); status('问大家被平台限制，已暂停采集（为保护账号，稍后自动恢复）', true); try { aisToast('问大家被平台限制，已暂停采集，稍后自动恢复', 'warn'); } catch (ePb) {} return; }
        fail++;
        if (fail >= 2) { why = '接口连续失败（' + state.wdjErr + '）'; break; }
        await wdjBeat(2400, 4200);
        continue;
      }
      fail = 0;
      if (res.total) state.wdjTotal = res.total;
      state.wdjPages = pg;
      var rows = res.rows || [];
      if (!rows.length) { why = res.hasNext === false ? '已采完全部问答' : '接口返回空页'; break; }
      mergeWdj(rows);
      renderWdj();
      status('问大家：已采 ' + state.wdjList.length + ' 问' + (state.wdjTotal ? ' / ' + state.wdjTotal : '') + ' · 请求 ' + state.wdjReqs + '/' + state.wdjBudget + ' …');
      if (res.hasNext === false) { why = '已采完全部问答'; break; }
      if (state.wdjList.length >= hardCap) { why = '已达安全上限 ' + hardCap + ' 问'; break; }
      await wdjBeat(1600, 3400); // 1.6~3.4s 页间（较上版更长）
    }
    state.wdjEndWhy = why;
    renderWdj();
    await wdjFullAnswers(myGen); // ③ 逐问补全全部回答（勾选时，共用同一预算/熔断）
    if ((state.revGen || 0) !== myGen) return;
    renderWdj();
    try { if ((state.wdjList || []).length) await wdjMarkRun(); } catch (eMk) {}
      status('问大家采集结束：' + state.wdjList.length + ' 问 / ' + wdjAnswerCountAll() + ' 答' + (state.wdjTotal ? '（页面共 ' + state.wdjTotal + ' 问）' : '') + ' · 请求 ' + state.wdjReqs + ' 次' + (why ? ' · ' + why : ''), true);
    await wdjCdItem(itemId, 15); // 同商品 15 分钟短冷却
    if (!member && state.wdjPages >= maxPages) { try { aisToast('免费版问大家限采 ' + maxPages + ' 页（' + (maxPages * 10) + ' 问），会员可采全部', 'warn'); } catch (eT2) {} }
  }
  async function wdjFullAnswers(myGen) {
    var cb = $('aisimg-wdj-full');
    if (!cb || !cb.checked) {
      var need = (state.wdjList || []).filter(function (q) { return (q.answerCount || 0) > (q.answers || []).length; }).length;
      if (need) status('问大家：' + need + ' 问只有首条回答（勾选「补全每个问题的全部回答」可逐问采齐）', true);
      return;
    }
    var member = false; try { member = isMemberNow(); } catch (eM2) {}
    var capEl = $('aisimg-wdj-cap');
    var want = capEl ? (parseInt(capEl.value, 10) || 20) : 20;
    var cap = Math.max(5, Math.min(80, want)); // 逐问请求最贵：免费 20 问、会员至多 80 问
    var targets = (state.wdjList || []).filter(function (q) { return (q.answerCount || 0) > (q.answers || []).length && q.questionId; });
    if (!targets.length) { status('问大家：回答已完整，无需补全', true); return; }
    var total0 = targets.length;
    if (total0 > cap) { try { aisToast('待补全 ' + total0 + ' 问，本次只补前 ' + cap + ' 问（' + (member ? '本次上限 80' : '免费上限 20') + '）', 'warn'); } catch (eT3) {} targets = targets.slice(0, cap); }
    var done = 0, failRun = 0, itemId = String(state.itemId || '');
    for (var ti = 0; ti < targets.length; ti++) {
      if (state.revStop) { status('问大家回答补全已手动停止（完成 ' + done + ' 问）', true); break; }
      if ((state.revGen || 0) !== myGen) return;
      if (state.wdjReqs >= (state.wdjBudget || wdjBudgetOf(member))) { status('问大家补全已达本场请求预算，停止补全（已补 ' + done + ' 问）', true); break; }
      var q = targets[ti], page = 1, all = [], guard = 0, hardStop = false;
      while (guard++ < 10) {
        var res = null;
        try { res = await sendBg({ action: 'mainWorldTaobaoWdjAnswers', questionId: q.questionId, page: page }, 25000); } catch (eA) {}
        state.wdjReqs++;
        if ((state.revGen || 0) !== myGen) return;
        if (!res || res.success === false) {
          var er2 = String((res && res.error) || '回答接口无响应');
          state.wdjErr = er2.slice(0, 120); failRun++;
          if (wdjHardBlock(er2)) { await wdjPunish(itemId, er2); status('问大家补全被平台限制，已暂停（为保护账号，稍后自动恢复）', true); hardStop = true; }
          break; // 单问失败不重试风暴：直接跳过该问
        }
        failRun = 0;
        all = all.concat(res.rows || []);
        if (res.isEnd !== false || !(res.rows || []).length) break;
        page = (res.nextPage && res.nextPage > page) ? res.nextPage : page + 1;
        await wdjBeat(1200, 2400);
      }
      if (hardStop) break;
      if (all.length) {
        // post.detail 不返回 ip_location → 同 ID 回答沿用列表接口已采到的属地，避免补全反而丢字段
        var oldIp = {};
        (q.answers || []).forEach(function (o) { if (o && o.answerId && o.ipLocation) oldIp[String(o.answerId)] = o.ipLocation; });
        all.forEach(function (an) { if (!an.ipLocation && oldIp[String(an.answerId)]) an.ipLocation = oldIp[String(an.answerId)]; });
        q.answers = all;
        if ((q.answerCount || 0) < all.length) q.answerCount = all.length;
        done++;
      }
      if (failRun >= 3) { status('问大家回答补全中止：连续 3 问接口失败（' + state.wdjErr + '）', true); break; }
      status('③ 补全回答 ' + (ti + 1) + '/' + targets.length + ' 问 · 已补 ' + done + ' 问 / ' + wdjAnswerCountAll() + ' 答 · 请求 ' + state.wdjReqs + '/' + state.wdjBudget + ' …');
      try { renderWdj(); } catch (eRw) {}
      await wdjBeat(1200, 2600); // 1.2~2.6s 逐问限速
    }
    state.wdjFullDone = done;
    renderWdj();
    status('问大家回答补全结束：' + done + '/' + targets.length + ' 问，现共 ' + wdjAnswerCountAll() + ' 条回答 · 累计请求 ' + state.wdjReqs + ' 次', true);
  }
  function wdjToRows(src, meta) {
    var list = src || state.wdjList || []; meta = meta || {};
    var ts = wdjTs(meta.at);
    return list.map(function (q, i) {
      var ans = q.answers || [];
      var ips = uniq(ans.map(function (a) { return a.ipLocation; }).concat([q.ipLocation || '']).filter(Boolean));
      return {
        序号: i + 1, 商品ID: q.itemId || meta.itemId || state.itemId || '', 商品标题: meta.title || state.itemTitle || '',
        问题ID: q.questionId || '', 提问时间: q.time || '', 问题内容: q.content || '',
        回答数: q.answerCount || ans.length || 0,
        回答内容: ans.map(function (a, j) { return (j + 1) + '. ' + a.content; }).join(' ｜ '),
        回答时间: ans.map(function (a) { return a.time; }).filter(Boolean).join(' '),
        已购回答: ans.some(function (a) { return String(a.userTags || '').indexOf('已购') > -1; }) ? '是' : '否',
        IP属地: ips.join(' '), 采集时间: ts
      };
    });
  }
  function wdjAnswerRows(src, meta) {
    var list = src || state.wdjList || []; meta = meta || {};
    var ts = wdjTs(meta.at); var rows = [];
    list.forEach(function (q) {
      (q.answers || []).forEach(function (a, j) {
        rows.push({ 商品ID: q.itemId || meta.itemId || state.itemId || '', 商品标题: meta.title || state.itemTitle || '', 问题ID: q.questionId || '', 问题内容: q.content || '', 提问时间: q.time || '',
          回答序号: j + 1, 回答ID: a.answerId || '', 回答内容: a.content || '', 用户标记: a.userTags || '',
          回答时间: a.time || '', IP属地: a.ipLocation || '', 已购规格: a.skuInfo || '',
          点赞数: (a.likeCount === undefined ? '' : a.likeCount), 回答评论数: (a.commentCount === undefined ? '' : a.commentCount),
          AI回答: (a.isAiAnswer === undefined ? '' : (a.isAiAnswer ? '是' : '否')), '88VIP': (a.isVip === undefined ? '' : (a.isVip ? '是' : '否')),
          回答图片数: (a.images || []).length, 回答图片地址: (a.images || []).join(' '), 采集时间: ts });
      });
    });
    return rows;
  }
  function wdjStatRows() {
    return [
      { 指标: '问题数', 值: (state.wdjList || []).length },
      { 指标: '回答数（接口返回首条）', 值: wdjAnswerCountAll() },
      { 指标: '页面声明问答总数', 值: state.wdjTotal || '' },
      { 指标: '已采集页数', 值: state.wdjPages || 0 },
      { 指标: '结束原因', 值: state.wdjEndWhy || '' },
      { 指标: '采集时间', 值: wdjTs() }
    ];
  }
  async function exportWdjXlsx() {
    var qRows = wdjToRows(); var aRows = wdjAnswerRows();
    if (!qRows.length) { status('没有问大家数据'); return; }
    var name = (state.itemTitle || '问大家').slice(0, 40);
    var sheets = {
      '问大家': { headers: unionRowKeys(qRows), rows: qRows },
      '问大家-回答明细': { headers: unionRowKeys(aRows), rows: aRows },
      '问大家统计': { headers: ['指标', '值'], rows: wdjStatRows() },
      '免责声明': { headers: ['说明'], rows: [{ '说明': DISCLAIMER }] }
    };
    var b64 = await exportStyledWorkbook(sheets, name + '_问大家.xlsx');
    var r3 = await sendBg({ action: 'downloadData', base64: b64, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: name + '_问大家.xlsx' });
    if (r3 && r3.ok) statusLink('问大家 Excel 已导出' + (r3.fileName ? ' · ' + r3.fileName : ''), true, r3.downloadId);
    else status('问大家 Excel 导出失败' + (r3 && r3.error ? '：' + r3.error : ''));
  }
  function wdjExport(kind) {
    if (kind === 'xlsx') { exportWdjXlsx().catch(function (e) { status('问大家 Excel 导出失败：' + e.message); }); return; }
    var qRows = wdjToRows(); var aRows = wdjAnswerRows();
    if (!qRows.length) { status('尚未采集问大家数据：请先在「评论设置」勾选同时采集问大家并开始采集'); return; }
    var name = (state.itemTitle || '问大家').slice(0, 40);
    if (kind === 'json') {
      var bj = btoa(unescape(encodeURIComponent(JSON.stringify({ questions: qRows, answers: aRows, stat: wdjStatRows() }, null, 2))));
      sendBg({ action: 'downloadData', base64: bj, mime: 'application/json', filename: name + '_问大家.json' });
      status('问大家 JSON 导出中…'); return;
    }
    var BOM = String.fromCharCode(65279);
    var LF = String.fromCharCode(10);
    var txt = skuToCsv(qRows, unionRowKeys(qRows)) + LF + LF + '回答明细（一行一答）' + LF + skuToCsv(aRows, unionRowKeys(aRows)) + LF + LF +
      '统计：问 ' + qRows.length + ' · 答 ' + aRows.length + (state.wdjTotal ? ' · 页面共 ' + state.wdjTotal + ' 问' : '') + LF + '免责声明：' + DISCLAIMER;
    var bc = btoa(unescape(encodeURIComponent(BOM + txt)));
    sendBg({ action: 'downloadData', base64: bc, mime: 'text/csv', filename: name + '_问大家.csv' });
    aisToast('问大家 CSV 已导出', 'info');
  }

  function revImagesDl() {
    if (!requireMember('打包下载（ZIP）')) return;
    var imgs = [];
      state.reviews.forEach(function (r) { var iA = (r.images || r.pics || []).concat(r.appendImages || []); iA.forEach(function (u) { if (u && imgs.indexOf(u) < 0) imgs.push(u); }); });
    if (!imgs.length) { aisToast('评论没有图片', 'warn'); return; }
    var items = imgs.map(function (u) { return { url: u, type: 'desc', folder: '评论图', format: 'original', quality: 92, scale: 1 }; });
    state.__dlTitle = '评论图片打包';
    progShow('评论图片打包 · ' + items.length + ' 张');
    progSet(0, items.length, '正在抓取…');
    sendBg({ action: 'downloadImages', images: items, asZip: true, nameMode: imgNameMode(), itemTitle: state.itemTitle, itemId: state.itemId }).then(function (r) {
      if (r && r.ok) {
        progSet(items.length, items.length, '已完成'); progHide(1800);
        aisToast('评论图片已打包下载：' + r.down + ' 张' + (r.fileName ? ' · ' + r.fileName : ''), r.failed ? 'warn' : 'info');
        if (r.downloadId != null) showOpenFolder(r.downloadId);
      } else { progSet(0, items.length, '失败'); progHide(3000); aisToast('评论图片打包失败' + (r && r.error ? '：' + r.error : ''), 'error'); }
    });
  }
  async function negAnalysisExport() {
    if (!requireMember('差评分析导出')) return;
    var a = state.analysis || {};
    var negMap = {};
    (a.negativeReviews || []).forEach(function (r2) { if (r2 && r2.reviewId != null) negMap[String(r2.reviewId)] = r2; });
    var negList = revSortList(state.reviews).filter(function (r) { return (r.rating && r.rating <= 2) || !!negMap[String(r.reviewId || '')]; });
    if (!negList.length) { status('没有差评数据'); return; }
    var cl = clusterNegatives(a);
    var bucketOf = {};
    cl.buckets.forEach(function (b) { (b.items || []).forEach(function (r2) { if (r2 && r2.reviewId != null) bucketOf[String(r2.reviewId)] = b.name; }); });
    var rows = negList.map(function (r, i) {
      var ne = negMap[String(r.reviewId || '')] || null;
      var imgs = (r.images || r.pics || []).concat(r.appendImages || []);
      return {
        '序号': i + 1,
        '严重度': ne && ne.confidence ? (ne.confidence === 'high' ? '严重' : (ne.confidence === 'medium' ? '中等' : '轻微')) : ((r.rating || 5) <= 1 ? '严重' : '中等'),
        '来源': ne ? '高风险识别' : '低星差评',
        ...(isTaobaoFamilyHost() ? {} : { '星级': r.rating || '' }), // v1.1.124：淘宝不带星级
        '聚类类别': bucketOf[String(r.reviewId || '')] || (ne ? '其他' : '低星差评'),
        '差评原因': ne ? (ne.reasons || []).join('、') : '',
        '主题': ne ? (ne.topics || []).join('、') : '',
        'SKU': (function () { var smN = revStripSkuMeta(r.skuInfo), tmN = revStripSkuMeta(r.time); return revCleanSkuAgainstContent(smN.sku || tmN.sku || '', r.content); })(),
        '时间': (function () { var smN = revStripSkuMeta(r.skuInfo), tmN = revStripSkuMeta(r.time); return tmN.sku ? tmN.date : (r.time || smN.date || ''); })(),
        '内容': r.content || '',
        '追评': r.append || r.appendReply || r.appendContent || '',
        '图片数': imgs.length,
        '图片地址': imgs.join(' ')
      };
    });
    try {
      var sevW = { '严重': 0, '中等': 1, '轻微': 2 };
      rows.sort(function (x, y) {
        var dx = sevW[x['严重度']] != null ? sevW[x['严重度']] : 3, dy = sevW[y['严重度']] != null ? sevW[y['严重度']] : 3;
        if (dx !== dy) return dx - dy;
        var tx = revTimeKey({ time: x['时间'] }), ty = revTimeKey({ time: y['时间'] });
        return (isNaN(ty) ? 0 : ty) - (isNaN(tx) ? 0 : tx);
      });
      rows.forEach(function (r, i) { r['序号'] = i + 1; });
      var sevCnt = { '严重': 0, '中等': 0, '轻微': 0 };
      rows.forEach(function (r) { sevCnt[r['严重度']] = (sevCnt[r['严重度']] || 0) + 1; });
      var totalRev = a.total || state.reviews.length || rows.length;
      var sum = [
        { '指标': '差评/高风险评论数', '值': rows.length },
        { '指标': '占评论总数比例', '值': totalRev ? Math.round(rows.length / totalRev * 100) + '%' : '-' },
        { '指标': '严重', '值': sevCnt['严重'] + ' 条' },
        { '指标': '中等', '值': sevCnt['中等'] + ' 条' },
        { '指标': '轻微', '值': sevCnt['轻微'] + ' 条' }
      ];
      cl.buckets.forEach(function (b) { if ((b.items || []).length) sum.push({ '指标': '聚类·' + b.name, '值': b.items.length + ' 条 · ' + b.pct + '%' }); });
      var wordCnt = {};
      (a.negativeReviews || []).forEach(function (r2) { (r2.topics || []).forEach(function (w) { if (w) wordCnt[w] = (wordCnt[w] || 0) + 1; }); });
      var topWords = Object.keys(wordCnt).sort(function (x, y) { return wordCnt[y] - wordCnt[x]; }).slice(0, 10);
      sum.push({ '指标': '高频问题主题Top10', '值': topWords.map(function (w) { return w + ' x' + wordCnt[w]; }).join('、') || '无' });
      var name = (state.itemTitle || '商品').slice(0, 40);
      var sheets = {
        '差评汇总': { headers: ['指标', '值'], rows: sum },
        '差评明细': { headers: unionRowKeys(rows), rows: rows },
        '免责声明': { headers: ['说明'], rows: [{ '说明': DISCLAIMER }] }
      };
      var b64 = await exportStyledWorkbook(sheets, name + '_差评分析.xlsx');
      var r4 = await sendBg({ action: 'downloadData', base64: b64, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: name + '_差评分析.xlsx' });
      if (r4 && r4.ok) statusLink('差评分析已导出' + (r4.fileName ? ' · ' + r4.fileName : ''), true, r4.downloadId);
      else status('差评分析导出失败' + (r4 && r4.error ? '：' + r4.error : ''));
    } catch (e) { status('差评分析导出失败：' + e.message); }
  }
  function renderReview() {
    try { updateCounts(); } catch (eUC) {}
    // v1.1.44b：采集中的轻量模式——不逐条刷评论明细（太多），只显示统计；明细在采集完成后渲染
    var lite = !!state.revCollecting;
    var sum = $('aisimg-revsum'), chips = $('aisimg-revchips'), neg = $('aisimg-revneg'), tips = $('aisimg-revtips');
    if (!sum || !neg) return;
    var _rdl = $('aisimg-revdl'); if (_rdl) _rdl.style.display = (!state.revCollecting && state.reviews.length) ? '' : 'none'; // v1.1.152：采集结束且有结果才展示下载导出
    var prog = $('aisimg-revprog');
    if (prog) {
      if (!state.revCollecting) { prog.style.display = 'none'; }
      else {
        prog.style.display = '';
        var pgF = $('aisimg-revprog-fill'), pgT = $('aisimg-revprog-txt'), pgP = $('aisimg-revprog-pct');
        var collected = state.reviews.length, totalN = state.revProgTotal || 0;
        var scp = getRevScope(), limitN = scp.mode === 'limit' ? (scp.limit || 0) : 0;
        var pctN = 0, indet = false, label = '正在采集评论 · 已 ' + collected + ' 条';
        if (limitN) { pctN = Math.min(100, Math.round(collected / limitN * 100)); label += ' / 目标 ' + limitN; }
        else if (totalN) { pctN = Math.min(100, Math.round(collected / totalN * 100)); label += ' / 共约 ' + totalN; }
        else indet = true;
        if (pgT) pgT.textContent = label;
        if (pgP) pgP.textContent = indet ? '' : pctN + '%';
        if (pgF) {
          pgF.className = 'aisimg-revprog-fill' + (indet ? ' indet' : '');
          pgF.style.width = indet ? '' : Math.max(pctN, 3) + '%';
        }
      }
    }
    var a = state.analysis || { total: 0, goodRate: 0, negativeCount: 0, badRate: 0, withImageRate: 0, topKeywords: [], negativeReviews: [], purchaseTips: [] };
    if (!state.reviews.length) {
      if (!state.revCollecting) { sum.innerHTML = '<div class=aisimg-empty>暂未采集到评论</div>'; chips.innerHTML = ''; neg.innerHTML = ''; if (tips) tips.innerHTML = ''; negReportRemove(); var rl0 = $('aisimg-revlist'); if (rl0) rl0.innerHTML = ''; return; }
      sum.innerHTML = ''; chips.innerHTML = ''; neg.innerHTML = ''; if (tips) tips.innerHTML = '';
    }
    // v1.2.185：统计改为指标瓦片（2x2），数量等宽、状态用颜色区分
    var tile = function (lb, vl, unit, sub, cls) {
      return '<div class="aisimg-tile' + (cls ? ' ' + cls : '') + '"><div class="lb">' + lb + '</div><div class="vl">' + vl
        + (unit ? '<small>' + unit + '</small>' : '') + '</div>' + (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
    };
    sum.innerHTML = '<div class="aisimg-tiles">'
      + tile('评论数', a.total, '', '已采集 ' + (state.reviews.length || 0) + ' 条')
      + (isTaobaoFamilyHost() ? '' : tile('好评率', a.goodRate, '%', '好评占比', 'good'))
      + tile('带图率', (a.withImageRate || 0), '%', '含图评论占比')
      + tile('高风险评论', a.negativeCount, '', '占比 ' + (a.badRate || 0) + '%', (a.negativeCount > 0 ? 'bad' : ''))
      + (a.appendCount ? tile('追评', a.appendCount, '', '追加评价') : '')
      + '</div>';
    var kws = (a.topKeywords || []);
    var maxN = kws.length ? (kws[0].count || 1) : 1;
    chips.innerHTML = kws.length ? '<div class="aisimg-words">' + kws.map(function (x) {
      var hot = (x.count || 0) >= Math.max(2, Math.round(maxN * 0.4));
      return '<span class="aisimg-word' + (hot ? ' hot' : '') + '">' + esc(x.word) + '<b>' + x.count + '</b></span>';
    }).join('') + '</div>' : '';
    if (lite) {
      neg.innerHTML = '<div class=aisimg-tipbar>已识别高风险评论 ' + (a.negativeCount || 0) + ' 条 · 实时更新中</div>';
      if (tips) tips.innerHTML = '<div class=aisimg-tipbar>已识别购买提醒 ' + (a.purchaseTips || []).length + ' 条（不计入高风险）· 采集完成后出完整报告</div>';
      var rlLite = $('aisimg-revlist');
      if (rlLite) {
        // v1.1.104：采集中实时显示明细（renderRevList 自带 100 条上限，每页到达自动刷新）；不再押后到完成
        try { renderRevList(); } catch (eRD) {}
        var liveTip = document.createElement('div');
        liveTip.className = 'aisimg-tipbar';
        liveTip.textContent = '⏱ 实时明细：已采集 ' + state.reviews.length + ' 条（显示最近 100 条）· 每页自动刷新';
        rlLite.insertBefore(liveTip, rlLite.firstChild);
      }
      return;
    }
    var negMember = true, negAll = (a.negativeReviews || []), negShow = negAll.slice(0, 20);
    // v1.2.307：给「误判」纠错按钮建立索引（reviewId -> 行数据），点击时回填给判定引擎学习
    var jIdx = {}; negShow.forEach(function (r0, ix0) { if (r0) jIdx[String(ix0)] = r0; }); state.__judgeIdx = jIdx;
    try { window.__AIS_REVIEWS__ = state.reviews || []; } catch (eAR) {} // v1.2.308：供真机验证星级分布与训练取数
    neg.innerHTML = negAll.length
      ? negShow.map(function (r, ix) {
          var lv = r.confidence === 'high' ? '严重' : (r.confidence === 'medium' ? '中等' : '轻微');
          var lvKey = r.confidence === 'high' ? 'high' : (r.confidence === 'medium' ? 'mid' : 'low');
          var tp = (r.topics || []).map(function (w) { return '<span class="aisimg-tagword">' + esc(w) + '</span>'; }).join('');
          var rs2 = (r.reasons || []).map(function (w) { return '<span class="aisimg-tagword">' + esc(w) + '</span>'; }).join('');
          return '<div class="aisimg-rev nitem ' + lvKey + '">'
            + '<div class="hd"><b>' + esc(String(r.time || '').slice(0, 16)) + '</b>'
            + (r.skuInfo ? '<span>已购：' + esc(r.skuInfo) + '</span>' : '')
            + '<span class="sev">' + lv + '</span></div>'
            + '<div class="body">' + esc(r.content) + '</div>'
            + '<div class="ft">' + tp + rs2 + '<button class="aisimg-judgewrong" data-idx="' + ix + '" style="margin-left:auto;font-size:11px;line-height:16px;padding:1px 6px;border:1px solid #d0d5dd;border-radius:6px;background:#fff;color:#555;cursor:pointer" title="这条其实不是差评？点一下，判定引擎会学习这条样本">判错了</button></div></div>';
        }).join("") + (!negMember && negAll.length > 3 ? '<div class=aisimg-tipbar>免费版仅显示 3 条高风险评论 · 共 ' + negAll.length + ' 条，会员解锁全部与差评分析导出</div>' : '')
      : '';   // v1.2.396：删重复提示
    if (tips) {
      var tps = (a.purchaseTips || []).slice(0, 8);
      tips.innerHTML = tps.length
        ? '<div class=aisimg-tipbar>购买提醒 ' + tps.length + ' 条（不计入高风险）</div>' + tps.map(function (t) {
            var cat = (t.topics || []).join(' / ') || '购买建议';
            return '<div class=item><div>· ' + esc(cat) + '：' + esc(t.content) + '</div></div>';
          }).join("")
        : '';
    }
    var nf0 = neg.querySelector && neg.querySelector('#aisimg-negfilter');
    try {
      if (!nf0 && (a.negativeReviews || []).length) {
        neg.innerHTML = "<input id=aisimg-negfilter class=revfilter placeholder=筛选高风险评论（如：质量/版型/尺码）>" + neg.innerHTML;
      }
      renderNegReport();
    } catch (eNR) {} // v1.1.88：高风险区异常不阻断明细
    try { renderRevList(); } catch (eRL2) { var rlE2 = $('aisimg-revlist'); if (rlE2) rlE2.innerHTML = '<div class=aisimg-empty>明细渲染异常（共 ' + state.reviews.length + ' 条已保留，可导出）</div>'; }
  }
  function domDescFallback() {
    // v1.2.196：拼多多兜底改用完整智能扫描（主图+详情图都并入）——覆盖「点早了页面未水合」场景
    if (pddIs()) {
      try {
        var addN = pddMerge(pddScan());
        if (addN) { try { render(); } catch (eR0) {} status('拼多多兜底补采：+' + addN + ' 张', true); }
      } catch (ePdd) {}
      return;
    }
    try {
      var found = [], seenF = {};
      // v1.2.258：容器 / 图床白名单 / 噪声图过滤 均可远程覆盖（registry common.*）
      var boxes = document.querySelectorAll(aisSel('common.descBox', '#imageTextInfo-content, .desc-root, .descV8-container, .desc-v8wrap, #J_DivItemDesc, #desc-lazyload-area, [class*="detail-desc"], [class*="detailDesc"], [class*="offer-desc"], [class*="offerDesc"]'));
      Array.prototype.forEach.call(boxes, function (box) {
        Array.prototype.forEach.call(box.querySelectorAll('img'), function (im) {
          var u = im.currentSrc || im.src || im.getAttribute('data-ks-lazyload') || im.getAttribute('data-lazyload') || im.getAttribute('data-src') || im.getAttribute('data-img-src') || '';
          u = abs(u);
          if (!u || !new RegExp(aisSel('common.descHosts', 'alicdn|imgextra|taobaocdn|tbcdn'), 'i').test(u)) return;
          if (new RegExp(aisSel('common.noiseUrl', 'thumbnail|avatar|logo|icon|sprite'), 'i').test(u)) return;
          if (seenF[u]) return;
          seenF[u] = 1;
          found.push(u);
        });
        // v1.2.248：CSS background-image 通道（详情图偶以背景图渲染；沿用上面的域名与噪声过滤）
        var cand = [box];
        try { Array.prototype.forEach.call(box.querySelectorAll('[class*="img"], [class*="pic"], [class*="image"]'), function (el2) { cand.push(el2); }); } catch (e1) {}
        cand.forEach(function (el2) {
          var bu = bgImageUrl(el2);
          if (!bu || !/(alicdn|imgextra|taobaocdn|tbcdn)/i.test(bu)) return;
          if (/(thumbnail|avatar|logo|icon|sprite)/i.test(bu)) return;
          if (seenF[bu]) return;
          seenF[bu] = 1; found.push(bu);
        });
      });
      if (mergeDesc(found)) { render(); status('详情图（页面兜底）：' + state.desc.length + ' 张', true); }
    } catch (e) {}
  }
  // ===== v1.2.194 拼多多智能读取（只采图片）=====
  // PDD H5 的 DOM 每次重渲染都会换 hash class（实测 pApAfrwF 这类随机类）、卡片重建、图片懒加载，
  // 固定选择器/一次性快照不可靠（实测 0 图）。四条原则：
  //   1) 特征探测：全部与 class 无关——img[src*=pddpic] + 显示尺寸 + 「商品详情/相似商品」纯文字分界
  //   2) 元素有效性：使用前 isConnected 校验，重渲染后的失效节点直接跳过
  //   3) 跨轮合并：主图/详情图按 URL（去 CDN 主机差异）并集去重，DOM 重建不丢已见图
  //   4) 收敛判定：连续 2 轮零新增且已有主图 → 定稿（由 autoRead 既有轮次驱动，末轮 descDeepRetry 兜底）
  // 注：PDD H5 基本无 SKU 图区（App 内才可见），SKU 有则顺带、无则不算失败；评论一律不采。
  function pddIs() { return /yangkeduo\.com|pinduoduo\.com/.test(location.href); }
  // v1.2.221：拼多多 SKU 采集功能已按用户要求整体移除（store 直读与弹层捕获对 SPA 模板均不可靠）。
  // 仅保留主图校准：官方轮播清单 topGallery（SSR rawData 本地读取，零点击零新请求）读到即覆盖并锁定，
  // 读不到保持 DOM 扫描结果，全程静默——不重试提示、不弹层、不报错。
  function pddGalleryFix() {
    try {
      if (!/goods\.html/.test(location.pathname)) return;
      if (state.__pddGalLocked || (state.__pddGalTries || 0) >= 3 || state.__pddGalBusy) return;
      state.__pddGalBusy = true;
      state.__pddGalTries = (state.__pddGalTries || 0) + 1;
      sendBg({ action: 'mainWorldPddGallery' }, 6000).then(function (gl) {
        state.__pddGalBusy = false;
        if (!gl || !gl.success || !gl.gallery || !gl.gallery.length) return;
        var galNorm = [];
        gl.gallery.forEach(function (uu) { var nu = pddNormImg(uu); if (nu && galNorm.indexOf(nu) < 0) galNorm.push(nu); });
        if (galNorm.length) {
          state.main = galNorm; state.__pddGalLocked = 1;
          try { render(); } catch (eG) {}
          status('拼多多：主图按官方轮播清单读取 ' + galNorm.length + ' 张');
        }
      }).catch(function () { state.__pddGalBusy = false; });
    } catch (eS) { state.__pddGalBusy = false; }
  }
  // 大图还原：PDD 缩略 URL 带 imageMogr2/.../thumbnail 处理参数，去掉即取原始分辨率
  function pddNormImg(u) {
    var s = String(u || '');
    if (s.indexOf('pddpic') < 0) return '';
    var q = s.indexOf('?'); if (q > 0) s = s.slice(0, q);
    return s;
  }
  // 去重键：img.pddpic.com 与 img-N.pddpic.com 可能是同一文件（本商品实测两种主机并存）
  function pddImgKey(u) { try { return String(u || '').replace(/^https?:\/\/[^/]+/i, '').toLowerCase(); } catch (e) { return String(u || ''); } }
  // 分界线（纯文字锚点，与 class 无关）：详情区起点=「商品详情/图文详情」；推荐流起点=「相似商品」等
  // 实测锚点：本商品「商品详情」≈1748px、「相似商品」≈8027px；desc 容器内 img=0（hash class 容器不可依赖）
  function pddBoundaries() {
    var out = { descStart: -1, recStart: -1 };
    try {
      var ns = document.querySelectorAll('div,span,h2,h3,p');
      for (var i = 0; i < ns.length; i++) {
        if (ns[i].children.length) continue;
        var t = (ns[i].textContent || '').trim();
        if (out.descStart < 0 && (t === '商品详情' || t === '图文详情' || t === '详情介绍')) {
          out.descStart = Math.round(ns[i].getBoundingClientRect().top + (window.scrollY || 0));
        } else if (out.recStart < 0 && /^(相似商品|看了又看|猜你喜欢|为你推荐|更多好物|大家都在看|同款好物)$/.test(t)) {
          out.recStart = Math.round(ns[i].getBoundingClientRect().top + (window.scrollY || 0));
        }
      }
    } catch (e) {}
    return out;
  }
  // 单轮扫描：主图（分界上方大图）+ 详情图（两分界之间的全宽大图）+ 视频
  // 尺寸门槛 ≥200x160：排除评论头像/评论小图/推荐流缩略图/图标（不采评论，推荐流也不属于本商品）
  function pddScan() {
    var b = pddBoundaries(), main = [], desc = [], vU = '';
    try {
      var imgs = document.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        if (!im.isConnected) continue; // 智能判定：重渲染后的僵尸节点直接跳过
        var u = pddNormImg(im.currentSrc || im.src || im.getAttribute('data-src') || '');
        if (!u) continue;
        var r = im.getBoundingClientRect();
        if (r.width < aisNum('pdd.minW', 200) || r.height < aisNum('pdd.minH', 160)) continue; // v1.2.258 门槛可远程覆盖
        var top = r.top + (window.scrollY || 0);
        if (b.descStart >= 0 && top > b.descStart) {
          if (b.recStart >= 0 && top >= b.recStart) continue; // 推荐流
          desc.push(u);
        } else if (b.descStart >= 0) {
          main.push(u);
        } else {
          // 兜底：找不到「商品详情」锚点时按文档序切分（轮播在前 ≤12 张，其余视为详情区）
          if (main.length < 12) main.push(u); else desc.push(u);
        }
      }
      var vv = document.querySelector('video[src], video source[src]');
      if (vv) vU = pddNormImg(vv.getAttribute('src') || vv.currentSrc || '');
    } catch (e) {}
    return { main: main, desc: desc, video: vU };
  }
  // 标题 DOM 启发式（class 无关）：正文里最像商品标题的中文行，排除价格/促销/保障/评价标签词
  function pddTitleFromDom() {
    try {
      var badRe = /^(已选|分享|收藏|客服|进店|关注|联系|退款|发货|退货|拼单|已拼|更多|顶部|说明书|商品详情|店铺评价)/;
      var noiseRe = /(退货|退款|运费|包邮|发货|无理由|保证金|补贴|领券|优惠券|秒杀|假一赔|价格说明|已拼)/;
      var ns = document.querySelectorAll('div,span,p');
      for (var i = 0; i < ns.length; i++) {
        if (ns[i].children.length) continue;
        var t = (ns[i].textContent || '').trim();
        if (t.length < 12 || t.length > 80) continue;
        if (!/[\u4e00-\u9fa5]/.test(t)) continue;
        if (/[\u00a5\uffe5]|\d+\s*元/.test(t)) continue;
        if (/\(\d{2,}\)|（\d{2,}）/.test(t)) continue; // 评价标签「精致(1091)」类
        if (badRe.test(t) || noiseRe.test(t)) continue;
        var r = ns[i].getBoundingClientRect();
        if (r.width < 100) continue;
        return t;
      }
    } catch (e) {}
    return '';
  }
  // 标题 JSON 源：从拦截归档里找 goodsName（含商品主结构优先），深度受限防大 JSON 卡顿
  function pddJsonMeta() {
    var out = {};
    try {
      var cs = collectState();
      var pools = (cs.all || []).slice(-30).map(function (x) { return unwrap(x && (x.data || x.response) || x); });
      if (cs.detail) pools.push(cs.detail);
      if (cs.sku) pools.push(cs.sku);
      var seenO = [], n = 0;
      var walk = function (o, d) {
        if (!o || typeof o !== 'object' || d > 6 || n > 4000 || out.title) return;
        n++;
        if (seenO.indexOf(o) >= 0 || seenO.length > 800) return;
        seenO.push(o);
        if (typeof o.goodsName === 'string' && o.goodsName.length >= 5) {
          var gid = String(o.goods_id || o.goodsID || '');
          if (state.itemId && gid === String(state.itemId)) out.title = o.goodsName;
          else if (!out.cand && (o.topGallery || o.skuList || o.sku || o.thumbUrl)) out.cand = o.goodsName; // 结构上像商品主体的，作次选
        }
        for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) walk(o[k], d + 1); }
      };
      pools.forEach(function (p) { walk(p, 0); });
    } catch (e) {}
    return { title: out.title || out.cand || '' };
  }
  // 合并一轮扫描结果进 state（按 path 分区内去重；v1.2.198 起允许同图跨区双份——
  // 实测 983318374562 轮播第2张与详情第1张同 path，互斥去重会把详情区那份吞掉，用户侧即「详情图少一张」）
  function pddMerge(cur) {
    var haveM = {}, haveD = {}, addM = [], addD = [];
    state.main.forEach(function (u) { haveM[pddImgKey(u)] = 1; });
    state.desc.forEach(function (u) { haveD[pddImgKey(u)] = 1; });
    (cur.main || []).forEach(function (u) { var k = pddImgKey(u); if (k && !haveM[k]) { haveM[k] = 1; addM.push(u); } });
    (cur.desc || []).forEach(function (u) { var k = pddImgKey(u); if (k && !haveD[k]) { haveD[k] = 1; addD.push(u); } });
    if (addM.length && !state.__pddGalLocked) state.main = uniq(state.main.concat(addM)).slice(0, 60);
    if (addD.length) state.desc = uniq(state.desc.concat(addD)).slice(0, 200);
    if (!state.video && cur.video) addVideo(cur.video);   // v1.2.292
    return addM.length + addD.length;
  }
  // v1.2.198：位置真相自纠——瞬态 DOM（分界未渲染/布局未稳）会把推荐卡图错进主图、详情图错挂。
  // 依据元素「当前」位置画像清洗：main 无上区实例 → 有详情区实例则移入 desc、只在推荐区则丢弃；
  // desc 无详情区实例 → 有上区实例移入 main、只在推荐区丢弃。元素暂不可见（懒加载占位）保守保留。
  function pddReclassify() {
    var b = pddBoundaries();
    if (b.descStart < 0) return 0;
    var prof = {};
    try {
      var imgs = document.querySelectorAll('img');
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        if (!im.isConnected) continue;
        var u = pddNormImg(im.currentSrc || im.src || im.getAttribute('data-src') || '');
        if (!u) continue;
        var r = im.getBoundingClientRect();
        if (r.width < aisNum('pdd.minW', 200) || r.height < aisNum('pdd.minH', 160)) continue; // v1.2.258 门槛可远程覆盖
        var k = pddImgKey(u);
        var tp = r.top + (window.scrollY || 0);
        var p = prof[k] || (prof[k] = { up: false, de: false, re: false });
        if (b.recStart >= 0 && tp >= b.recStart) p.re = true;
        else if (tp > b.descStart) p.de = true;
        else p.up = true;
      }
    } catch (eP0) { return 0; }
    var changed = 0, keepM = [], addD = [], keepD = [], addM = [];
    state.main.forEach(function (u) {
      var p = prof[pddImgKey(u)];
      if (!p || p.up) keepM.push(u);
      else if (p.de) { addD.push(u); changed++; }
      else changed++; // 只剩推荐区实例 → 丢弃
    });
    state.desc.forEach(function (u) {
      var p = prof[pddImgKey(u)];
      if (!p || p.de) keepD.push(u);
      else if (p.up) { addM.push(u); changed++; }
      else changed++; // 只剩推荐区实例 → 丢弃
    });
    state.main = state.__pddGalLocked ? uniq(state.main).slice(0, 60) : uniq(keepM.concat(addM)).slice(0, 60);
    state.desc = uniq(keepD.concat(addD)).slice(0, 200);
    return changed;
  }
  // 每轮：扫描 → 跨轮合并 → 收敛判定（true=定稿，交由 autoRead 完成收尾）
  // v1.2.195：定稿后补扫两轮「懒加载尾巴」（实测 PDD 详情图晚到漏 1/4——7s 定稿时最后一张还没 src）
  function pddSmartRead() {
    var added = pddMerge(pddScan());
    if (added === 0) state.__pddStable = (state.__pddStable || 0) + 1;
    else state.__pddStable = 0;
    var conv = state.main.length > 0 && state.__pddStable >= 2;
    if (conv && !state.__pddTail) {
      // v1.2.196：有界收敛尾巴——每 2.5s 补扫一轮，最多 8 轮，连续 2 轮零新增即停
      // （PDD 详情长图逐张懒加载，实测 13s 后仍在出图，定稿时 5/11）
      // v1.2.198：每轮补扫先做位置真相自纠（瞬态错分洗净：推荐卡图出主图、跨区复用图归位）
      state.__pddTail = true;
      var __sweeps = 0, __zeros = 0;
      var __tick = setInterval(function () {
        __sweeps++;
        try {
          var fixT = pddReclassify();
          var addT = pddMerge(pddScan());
          if (addT || fixT) { __zeros = 0; try { render(); } catch (eT1) {} }
          else __zeros++;
        } catch (eT0) { __zeros++; }
        if (__zeros >= 2 || __sweeps >= 8) clearInterval(__tick);
      }, 2500);
    }
    return conv;
  }
  function parseAll() {
    var P = window.__AIS_IMG_PARSER__;
    extractMeta();
    // v1.2.286：亚马逊官方载荷读取接入 AISIMG 工作台。ATF 主图、BTF 变体、A+ 详情、直链视频。
    // 载荷解析来自 lib/amazon.js；不改其它平台流程，没取到时继续原有 DOM/API 兜底。
    try {
      var AZ = window.__AIS_AMAZON__;
      var __amzIs = AZ && AZ.asinFromUrl && AZ.asinFromUrl(location.href);
      if (__amzIs) {
        var __atf = AZ.readAtfFromRoot(document) || [];
        var __btf = AZ.readBtfFromRoot(document) || null;
        var __amzMain = [];
        __atf.forEach(function (x) { var u = abs(x && (x.hiRes || x.large || x.thumb)); if (u && __amzMain.indexOf(u) < 0) __amzMain.push(u); });
        var __amzSku = [], __amzRows = [];
        (AZ.variantsFromBtf(__btf) || []).forEach(function (x, vi) {
          var u = abs(x && x.image);
          if (u && __amzMain.indexOf(u) < 0 && __amzSku.indexOf(u) < 0) __amzSku.push(u);
          if (x && x.childAsin) __amzRows.push({ '序号': vi + 1, '商品ID': x.childAsin, '商品链接': 'https://' + location.hostname + '/dp/' + x.childAsin, 'SKU_ID': x.childAsin, '变体': x.label || '', '价格': '', '库存': '', 'SKU图': u });
        });
        var __amzDesc = [];
        var __abox = document.querySelector(aisSel('amazon.aplus', '#aplus, #aplus_feature_div, .aplus-v2, #aplus3p_feature_div'));
        // v1.2.288：详情图判据改用【我们自己】在 hires-extension 里定稿的 detailFilter（见 lib/amazon.js）。
        // 旧写法只按 sprite/icon/logo 粗筛 → 会把 A+ 里 44 张关联位缩略图(166px)与 3 张无关图(362px)一起收进来。
        var __amzMinEdge = aisNum('amazon.detailMinEdge', 500);
        if (__abox) Array.prototype.forEach.call(__abox.querySelectorAll('img'), function (im) {
          var u = abs(im.getAttribute('data-src') || im.getAttribute('src') || '');
          if (!u || __amzDesc.indexOf(u) >= 0) return;
          try { if (AZ.keepDetailElement && !AZ.keepDetailElement(im, u, __amzMinEdge)) return; } catch (eKE) {}
          __amzDesc.push(u);
        });
        // v1.2.290：视频改用【我们自己】在 hires-extension 定稿的实现（见 lib/amazon.js 的 collectVideos / mediaExt）。
        // 旧写法只从 BTF 挑第一个 .mp4 → 会漏掉 DOM 与站点负载脚本里的视频，也分不清 HLS 播放列表（699 字节文本）。
        var __amzVideos = [];
        try { __amzVideos = AZ.collectVideos(document, __btf) || []; } catch (eV0) {}
        var __amzVideo = '', __amzPlaylists = 0, __amzVideoAll = [];
        for (var _vi = 0; _vi < __amzVideos.length; _vi++) {
          var _vu = abs(__amzVideos[_vi] && __amzVideos[_vi].url);
          if (!_vu) continue;
          if (AZ.isPlaylistUrl && AZ.isPlaylistUrl(_vu)) { __amzPlaylists++; continue; }   // HLS/DASH 是播放列表，不是可下载媒体文件
          if (!__amzVideo) __amzVideo = _vu;
          __amzVideoAll.push(_vu);
        }
        // v1.2.417【修「亚马逊主图乱」】：原为 concat【追加】——官方 ATF 载荷给的是权威图库（真机 8 张），
        // 追加式会把通用 DOM/自适应扫描堆进来的推荐位、其它商品图一起并进去（真机实测 27 张，多 19 张）。
        // 现改为【赋值】并置锁，与详情图（__amzDescLocked）同一策略。
        // v1.2.417：载荷 ATF 里同一张图会有多个尺寸变体（_AC_SL1500_ / _AC_SX522_ / __CR…），
        // 真机实测 B0D9VS4PV7：ATF 12 条 → 页面真实图库只有 8 张，多出的全是同图不同尺寸。
        // 按【图 ID】归一化去重（/images/I/<ID> 里的 ID，不随尺寸/裁切 token 变化）。
        if (__amzMain.length) {
          try {
            var __idRe = new RegExp(aisSel('amazon.imgIdRe', '/images/I/([^._/?#]+)'), 'i');
            var __seenId = {}, __normMain = [];
            __amzMain.forEach(function (u) {
              var m = String(u).match(__idRe);
              var k = m ? m[1] : String(u).split('?')[0];
              if (__seenId[k]) return;
              __seenId[k] = 1; __normMain.push(u);
            });
            if (__normMain.length) __amzMain = __normMain;
          } catch (eIdn) {}
          state.main = uniq(__amzMain);
          state.__amzMainLocked = true;
        }
        if (__amzSku.length) state.sku = uniq(state.sku.concat(__amzSku));
        if (__amzRows.length) { state.skuRows = __amzRows; state.skuPropNames = ['变体']; }
        if (__amzDesc.length) { state.desc = uniq(__amzDesc); state.__amzDescLocked = true; }   // v1.2.289 赋值而非累加：详情图 = A+ 判据结果
        if (__amzVideoAll.length) __amzVideoAll.forEach(function (vu) { addVideo(vu); });   // v1.2.292 亚马逊：全部可下载视频都收
        if (!state.itemId) state.itemId = __amzIs;
        if (!state.itemTitle) state.itemTitle = String(document.title || '').replace(/\s*[-|]\s*Amazon\.com.*$/i, '').trim();
        if (__amzMain.length || __amzSku.length || __amzDesc.length || __amzVideo) { state.__amazonPayloadDone = true; status('亚马逊载荷读取完成（主图 '+__amzMain.length+' · 变体 '+__amzSku.length+' · A+ '+__amzDesc.length+' · 视频 '+(__amzVideo ? 1 : 0)+(__amzPlaylists ? '（另有 '+__amzPlaylists+' 个 HLS 播放列表未计入）' : '')+'）', true); }
      }
    } catch (eAmzRead) {}
    // ===== v1.2.347：亚马逊自适应扫描（改版/地区版式变化时的兜底通道）=====
    // 真机实测：官方载荷通道（lib/amazon.js）在部分商品/地区版式下只命中主图，变体与 A+ 为 0。
    // 本通道判据全部与类名无关：① 图床主机 ② 尺寸 token（._SS40_ 等）③ data-a-dynamic-image JSON ④ 结构语义（容器/长边）。
    try {
      var __amzHost = /(^|\.)amazon\.[a-z.]{2,}$/i.test(location.hostname) || /(^|\.)amzn\.com$/i.test(location.hostname);
      // v1.2.417：官方载荷已经给出主图/详情图时【跳过自适应扫描】——否则它会把整页亚马逊图床图片
      // （推荐位/关联商品/买家秀）再并进来，与载荷结果混在一起 → 用户看到的「主图详情图都乱完了」。
      // 仅在载荷没取到（改版/地区版式变化）时才启用这条兜底通道。
      var __amzAuth = String(aisSel('common.amzPayloadAuthoritative', 'on')) !== 'off';
      var __amzHavePayload = __amzAuth && (state.__amzMainLocked || state.__amzDescLocked);
      if (__amzHost && !__amzHavePayload && typeof amazonAdaptiveScan === 'function') amazonAdaptiveScan();
    } catch (eAzAd) {}

    // v1.2.194：拼多多智能读取分支（H5 DOM 随时重渲染，固定选择器实测 0 图；只采图片，不涉评论）
    if (pddIs()) {
      try { if (!state.video) domFallbackVideo(); } catch (eVp0) {}
      try { if (!state.video) extractVideoFromPage(); } catch (eVp1) {}
      try { pddGalleryFix(); } catch (e221) {}
      return pddSmartRead();
    }
    jdDomImages();
    a1688Dom();
    if (P) {
      var cs = collectState();
      if (cs.detail) {
        try {
          var r = P.collectImages(cs.detail, cs.sku);
          if (r) {
            // v1.2.417：亚马逊官方载荷已锁主图时不追加通用通道结果（详情图由 mergeDesc 内部锁拦截）
            if (!state.__amzMainLocked) state.main = uniq(state.main.concat(r.main || []));
            state.sku = uniq(state.sku.concat(jdCleanSku(r.sku || [])));          // v1.2.260 接口路径清洗
            if (r.valueImgs && r.valueImgs.length) state.skuValueImgs = jdCleanValueImgs(r.valueImgs);
            if (!state.video && r.video) addVideo(r.video);   // v1.2.292
            if (!state.descUrl && r.descUrl) state.descUrl = r.descUrl;
          }
        } catch (e) {}
        try {
          var bt = P.buildSkuTable(cs.detail, { title: state.itemTitle, itemId: state.itemId, url: location.href });
          if (bt && bt.rows && bt.rows.length) { state.skuRows = bt.rows; state.skuPropNames = bt.propNames || []; }
        } catch (e) {}
        if (!state.skuRows.length && cs.sku) {
          try {
            var bt2 = P.buildSkuTable(cs.sku, { title: state.itemTitle, itemId: state.itemId, url: location.href });
            if (bt2 && bt2.rows && bt2.rows.length) { state.skuRows = bt2.rows; state.skuPropNames = bt2.propNames || []; }
          } catch (e) {}
        }
        // v1.2.385：DOM SKU 回填门禁【规则开关】——whenImagesEmpty（默认 off=商店行为）
        var __skuBf = 'off'; try { __skuBf = aisSel('common.skuDomBackfill', 'off'); } catch (eBf0) {}
        if (!state.skuRows.length || (__skuBf === 'whenImagesEmpty' && (!(state.sku || []).length || !(state.skuValueImgs || []).length))) { try { domSkuFallback(); } catch (e) {} }
        if (!state.itemProps.length) { try { state.itemProps = P.parseItemProps ? P.parseItemProps(cs.detail) : []; } catch (e) {} }
        try { itemPropsDom(); } catch (e) {} // v1.1.163：页面参数直接采集（始终执行，采到即覆盖）
        if (state.itemProps.length < 3) { try { propsTabAutoOpen(); } catch (e10b) {} } // v1.1.163 参数页签懒加载兜底（每页一次）
        try { sizeChartDom(); } catch (e9) {} // v1.1.148 尺码表采集
        if (!state.sizeChart.length) { try { sizeChartAutoOpen(); } catch (e10) {} } // v1.1.149 弹层兜底（每页一次）
        // desc 可能内嵌在 detail 响应里（新版淘宝）
        try { mergeDesc(P.parseDescImagesDeep ? P.parseDescImagesDeep(cs.detail) : P.parseDescImages(cs.detail)); } catch (e) {}
      }
      // v1.2.467【用户反馈：淘宝商品参数采集没有了】根因：itemPropsDom()/sizeChartDom() 原本**只在这个 if(cs.detail) 块里**调用，
      //   而该块依赖「接口通道」（规则 common.apiDetailChannel，默认 off=商店基线）⇒ 通道关闭时整块不执行 ⇒ **参数/尺码表恒空** ✗。
      //   DOM 读取与接口无关 ⇒ 移到块外**无条件执行**（已有 ≥3 条参数时不覆盖接口数据；页签/弹层兜底各页一次）。
      try { if ((state.itemProps || []).length < 3) itemPropsDom(); } catch (eIpD) {}
      try { if ((state.itemProps || []).length < 3) propsTabAutoOpen(); } catch (eIpP) {}
      try { if (!(state.sizeChart || []).length) sizeChartDom(); } catch (eScD) {}
      try { if (!(state.sizeChart || []).length) sizeChartAutoOpen(); } catch (eScP) {}
      if (cs.sku) {
        // v1.2.442：SKU 载荷统一走 applySkuPayload（与原逻辑等价，另补 skuValueImgs，供 SKU 网格合成）。
        // 这里保持在 cs.sku 通道、与「详情响应是否存在」解耦（v1.2.415 的根治结论，勿移回 cs.detail 块内）。
        try { applySkuPayload(cs.sku, { render: false }); } catch (eSk5) {}
      }
      if (!state.main.length && cs.all.length) {
        for (var i = cs.all.length - 1; i >= 0 && !state.main.length; i--) {
          var it = cs.all[i];
          var d = unwrap(it && (it.data || it.response) || it);
          if (!d || typeof d !== 'object') continue;
          try {
            var r2 = P.collectImages(d, null);
            if (r2 && r2.main && r2.main.length) {
              state.main = uniq(state.main.concat(r2.main));
              state.sku = uniq(state.sku.concat(jdCleanSku(r2.sku || [])));        // v1.2.260
              if (!state.video && r2.video) addVideo(r2.video);   // v1.2.292
              if (!state.descUrl && r2.descUrl) state.descUrl = r2.descUrl;
            }
          } catch (e) {}
        }
      }
      if (cs.descResp) {
        try { mergeDesc(P.parseDescImages(cs.descResp)); } catch (e) {}
        try { if (P.parseDescImagesDeep) mergeDesc(P.parseDescImagesDeep(cs.descResp)); } catch (e) {}
      }
      // v1.1.40：不采集「全部评论」打开前的预览评论（评论改由自主评论采集流程负责）
    }
    if (!state.main.length) domFallbackMain();
    // v1.2.327：类名全部落空时的自适应兜底（主图/SKU 图）
    // v1.2.354：通用兜底通道触发改为远程可调（common.harvestMode = gated|always|off）——
    // 平台改版导致选择器失效时，只改远端即可让通用通道每次都跑，无需发版。
    try {
      var __hm = String(aisSel('common.harvestMode', 'gated') || 'gated');
      if (__hm !== 'off' && (__hm === 'always' || !state.main.length || !state.sku.length || !state.desc.length)) {
        try { adaptiveImgScan(); } catch (eAd) {}
      }
    } catch (eHM) {}
    domFallbackVideo();
    if (!state.video) extractVideoFromPage();
    if (!state.video) nudgeLazyVideo();
    return state.main.length > 0 || state.sku.length > 0 || state.desc.length > 0 || !!state.video;
  }

  // ===== v1.2.247 详情图全量兜底修复 =====
  // 背景：淘宝等平台的详情图是「懒加载分批出现」的，旧逻辑把 state.desc.length > 0 当作「已采完」，
  // 一旦 DOM 只捞到 1 张就早退，下方 itemDesc 全量接口兜底（sendBg fetchDescImages）永不执行；
  // 叠加 SSR descUrl 被 detail 接口抢先而整块跳过（main-world-interceptor 的 gate），
  // 表现为「首次打开能采全，刷新后详情图恒为 1 张，且后续商品同样」。
  // 修法：① 收敛判据由「>0」改为「≥3 张或已发起全量接口」；② descUrl 缺失时用 itemId 构造兜底地址。
  function descCredible() { return state.descFetched ? true : state.desc.length >= 3; }
  // ===== v1.2.263：详情图未出来之前的常驻提示（全平台）=====
  // 在「详情图」分组位置显示「详情图正在加载中…（已等待 Ns）」；采到即消失；
  // 读取结束仍无图 → 换成「暂未采集到详情图，可点「重新读取」」。计时器只在等待期间运行。
  function descLoadingHtml() {
    try {
      if (!state.reading || state.desc.length) return '';
      var txt = aisSel('common.descLoadingText', '详情图正在加载中…');
      if (state.descWait) txt += '（已等待 ' + state.descWait + 's）';
      return '<div class="aisimg-group"><div class="aisimg-group-title">' + TYPE_LABEL.desc + ' <b>—</b></div><div class="aisimg-loading">' + txt + '</div></div>';
    } catch (e) { return ''; }
  }
  function descMissingHtml() {
    try {
      if (state.reading || state.desc.length || !state.descMissing) return '';
      return '<div class="aisimg-group"><div class="aisimg-group-title">' + TYPE_LABEL.desc + ' <b>0</b></div><div class="aisimg-loading aisimg-loading-miss">' + aisSel('common.descMissingText', '暂未采集到详情图，可点「重新读取」') + '</div></div>';
    } catch (e) { return ''; }
  }
  function descWaitStart() {
    try {
      state.descMissing = false;
      state.descWait = 0;
      if (state.desc.length || state.__descTimer) return;
      state.__descTimer = setInterval(function () {
        try {
          if (!state.reading || state.desc.length) { descWaitStop(); return; }
          state.descWait++;
          status(aisSel('common.descLoadingText', '详情图正在加载中…') + '（已等待 ' + state.descWait + 's）');
          if (state.descWait <= 3 || state.descWait % 5 === 0) { try { render(); } catch (e0) {} }
          if (state.descWait >= 90) descWaitStop();
        } catch (e1) {}
      }, 1000);
    } catch (e) {}
  }
  function descWaitStop() {
    try { if (state.__descTimer) { clearInterval(state.__descTimer); state.__descTimer = null; } } catch (e) {}
    try { if (!state.desc.length && !state.reading) state.descMissing = true; } catch (e1) {}
    try { render(); } catch (e2) {}
  }
  function descFetchUrl() {
    if (state.descUrl) return state.descUrl;
    if (state.itemId && /\.(?:taobao|tmall)\.com$/.test(location.hostname)) {
      return 'https://item.taobao.com/itemDesc.htm?id=' + state.itemId;
    }
    return '';
  }
  function fetchDesc() {
    var du = descFetchUrl(); // v1.2.247：淘宝/天猫 descUrl 缺失时用 itemId 兜底，保证全量接口始终可达
    if (!du || state.descFetched) return;
    state.descFetched = true;
    if (!state.descUrl) state.descUrl = du;
    sendBg({ action: 'fetchDescImages', descUrl: du }).then(function (r) {
      if (r && r.ok && r.images && r.images.length) {
        if (mergeDesc(r.images, { allowGalleryDup: /(^|\.)(1688|taobao|tmall)\.com$/i.test(location.hostname) })) {
          render();
          if (state.readFinished) status('详情图已读取：' + state.desc.length + ' 张', true);
        }
      }
    });
    // v1.2.321：旧 itemDesc.htm 端点实测已 204 废弃 → 兜底走「主世界 mtop detail.getdesc」（页面自带签名，无需自己签名）
    try {
      if (/[.](?:taobao|tmall)[.]com$/.test(location.hostname) && state.itemId) {
        sendBg({ action: 'mainWorldTaobaoDesc', itemId: String(state.itemId) }).then(function (r2) {
          try {
            if (!r2 || !r2.ok || !r2.data) return;
            var obj = null;
            try { obj = JSON.parse(r2.data); } catch (ePj) { return; }
            var imgs = [];
            try { imgs = P.parseDescImages(obj) || []; } catch (ePi) {}
            try {
              if (P.parseDescImagesDeep) {
                var deep = P.parseDescImagesDeep(obj) || [];
                if (deep.length > imgs.length) imgs = deep;
              }
            } catch (ePd) {}
            if (imgs.length && mergeDesc(imgs)) {
              render();
              try { status('详情图已读取（接口）：' + state.desc.length + ' 张', true); } catch (ePs) {}
            }
          } catch (eFb) {}
        });
      }
    } catch (eFb2) {}
  }

  function skuImgKey(u) {
    var s = String(u || '').split('?')[0].split('#')[0];
    s = s.replace(/\.(jpe?g|png|webp)_(\d+x\d+)[a-z0-9]*\.(jpe?g|png|webp)$/i, '.$1');
    s = s.replace(/_(\d+x\d+)[a-z0-9]*\.(jpe?g|png|webp|gif)$/i, '.$2');
    s = s.replace(/^https?:\/\/[^/]*alicdn\.com/i, 'https://img.alicdn.com').replace(/^https?:\/\/(?![^/]*alicdn)[^/]+/i, function (h) { return h.toLowerCase(); });
    return s.toLowerCase();
  }
  function skuCaption(r) {
    // 规格标题：显示详情但排除尺码/尺寸类属性
    var sizeRe = null;
    try { sizeRe = new RegExp(aisSel('common.skuSizeRe', '尺码|尺寸|码数')); } catch (eSR) { sizeRe = /尺码|尺寸|码数/; }   // v1.2.267 可远程覆盖
    var parts = [];
    (state.skuPropNames || []).forEach(function (pn) {
      if (!r[pn] || sizeRe.test(pn)) return;
      parts.push(r[pn]);
    });
    if (!parts.length && r["规格"]) parts.push(r["规格"]);
    return parts.join("；");
  }
  function skuImgInfoMap() {
    var m = {};
    (state.skuRows || []).forEach(function (r) {
      var u = r && r["SKU图"]; if (!u) return;
      var info = skuCaption(r); if (!info) return;
      var k = skuImgKey(u);
      if (!m[k]) m[k] = info; else if (m[k].indexOf(info) < 0) m[k] += " / " + info;
    });
    return m;
  }
  // v1.2.179 文件名清洗 + SKU 图按规格属性名命名（如 黑色-L）
  function safeFs(s) { return String(s == null ? '' : s).replace(/[\\/:*?"<>|]/g, '_').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60); }
  function skuFileName(u) {
    try {
      var m = skuImgInfoMap(), cap = m && m[skuImgKey(u)];
      if (cap) return safeFs(String(cap).replace(/[；;]/g, aisSel('common.skuNameSep', '-')));   // v1.2.267 分隔符可远程覆盖
    } catch (e) {}
    return '';
  }
  // v1.2.419【用户要求：下载不改名，用原图名称】文件名策略（远程可调 common.imgNameMode）
  //   legacy = 商店基线行为：SKU 图用规格名，其余「类型_序号」（如 详情图_01.jpg）
  //   orig   = 原图名称：取图片 URL 的原始文件名主干（如 O1CN01KRAAA_!!0-item_pic），不分类不加前缀
  // 注：默认 legacy（项目规则：新行为默认关闭），由服务器把 common.imgNameMode 设为 orig 生效。
  // v1.2.438【用户多次要求】下载文件名【默认就用原图名】（原来是 legacy 默认 ✗）——规则值仍可覆盖为 'legacy' ✓
  function imgNameMode() { try { return String(aisSel('common.imgNameMode', 'orig') || 'orig'); } catch (e) { return 'orig'; } }
  // v1.2.419：是否对该类型使用「原图名」——orig 一律用；origExceptSku 只对非 SKU 用；legacy 不用
  function useOrigName(mode, t) { return mode === 'orig' || (mode === 'origExceptSku' && String(t) !== 'sku'); }
  function origNameOf(u) {
    try {
      var s = String(u || '').split('#')[0].split('?')[0];
      var m = s.match(/\/([^\/]+)$/);
      var b = m ? m[1] : '';
      if (!b) return '';
      try { b = decodeURIComponent(b); } catch (eD) {}
      var dot = b.lastIndexOf('.');
      if (dot > 0) b = b.slice(0, dot);   // 去掉原扩展名：落盘扩展名由格式/原图决定，避免 a.jpg_.jpg 双后缀
      return safeFs(b);
    } catch (e) { return ''; }
  }
  function cardHtml(type, url, idx, info) {
    var isV = type === 'video';
    var media = isV
      ? '<video src="' + esc(url) + '" muted preload="metadata" controls></video>'
      : '<img loading="lazy" src="' + esc(url) + '" referrerpolicy="no-referrer">';
    var badge = '<span class="aisimg-typebadge ' + type + '">' + TYPE_LABEL[type] + '</span>';
    return '<div class="aisimg-card" data-url="' + esc(url) + '" data-type="' + type + '">'
      + '<label class="aisimg-chk"><input type="checkbox" class="aisimg-cardchk" data-url="' + esc(url) + '"></label>'
      + '<div class="aisimg-thumb">' + media + badge + '</div>'
      + '<div class="aisimg-cardfoot"><span class="aisimg-idx" title=' + dqattr(info || (TYPE_LABEL[type] + ' ' + (idx + 1))) + '>' + esc(info || (TYPE_LABEL[type] + ' ' + (idx + 1))) + '</span>'
      + '<button type="button" class="aisimg-dl1" data-url="' + esc(url) + '" data-type="' + type + '">下载</button></div>'
      + '</div>';
  }

  function purgeMain() {
    try {
      var __mainBackup = [];  // v1.2.391：备份移到 mainPreferSsr 之后（之前备份的是空数组，安全网无效）
      if (aisSel('common.mainPurge', 'on') === 'off') return;
      // v1.2.373：接口/SSR 给出官方主图时，主图【以官方列表为准】——消除 DOM 扫描堆进来的
      // 宣传海报 / 退货说明 / 客服头像 / 占位图 / 其它商品图（真机：CHANEL 唇膏官方 3 张，面板曾采到 30 张）。
      // 开关可远程调：common.mainPreferSsr = on（默认）/ off
      try {
        var __msm = aisSel('common.mainSourceMode', 'auto');
        var __prefer = (__msm === 'ssrOnly') || (aisSel('common.mainPreferSsr', 'on') !== 'off');
        if (__prefer && state.__mainApi && state.__mainApi.length >= 2) state.main = state.__mainApi.slice();
        __mainBackup = ((state.main || []).length >= (state.__mainApi || []).length ? (state.main || []) : (state.__mainApi || [])).slice();
      } catch (eMA) {}
      var skuSet = {};
      (state.sku || []).forEach(function (u) { if (u) skuSet[String(u)] = 1; });
      (state.skuValueImgs || []).forEach(function (v) { if (v && v.image) skuSet[String(v.image)] = 1; });
      // v1.2.375：排除【店铺 logo / 头像 / 店铺头图】——用户实测主图里混进 logo（截图「主图 7」是店铺卡通头像）。
      // 选择器可远程调：common.logoSel；开关 common.logoPurge = on/off
      try {
        if (aisSel('common.logoPurge', 'on') !== 'off') {
          var __logoRe = {};
          var __logoSel = aisSel('common.logoSel', 'img[class*=logo], img[class*=Logo], [class*=shopLogo] img, [class*=ShopLogo] img, [class*=shop-header] img, [class*=shopHeader] img, [class*=ShopHeader] img');
          document.querySelectorAll(__logoSel).forEach(function (im) {
            var su = im.getAttribute('src') || im.getAttribute('data-src') || '';
            if (su) __logoRe[String(su)] = 1;
          });
          if (Object.keys(__logoRe).length) {
            var __beforeN = (state.main || []).length;
            state.main = (state.main || []).filter(function (u) { return !__logoRe[String(u)]; });
            if (__beforeN !== state.main.length) console.log('[电商采集大师] 主图已剔除 logo/头像 ' + (__beforeN - state.main.length) + ' 张');
          }
        }
      } catch (eLg) {}
      var list = (state.main || []).slice();
      // v1.2.385：SKU 组「计数有、网格空」修复【规则开关，默认关闭=商店行为】——服务器开：common.skuGridFix=on
      // v1.2.389：只放行门禁不够 —— 卡片列表若仍取自 state.sku（空）会渲染 0 张，用户看到还是空白。
      // 这里先【补数据源】：从 skuRows[].SKU图 / skuValueImgs[].image 合成列表（去重）。
      // v1.2.412 清理：此处原为 v1.2.389 错位补丁的残骸（if 体与 else 体都已空 —— 声明变量被删后
      // __skuGridFix 恒为 undefined，"!== 'off'" 恒真，进入空分支空转）。真正的数据源补丁在下方
      // 「v1.2.394：SKU 组计数有、网格空」处（__syn2）。
      list = list.filter(function (u) { return !skuSet[String(u)]; });
      if (!list.length) return;
      var cnt = {};
      list.forEach(function (u) {
        var m = String(u).match(/\/(?:imgextra|bao\/uploaded)\/i\d\/(\d{8,})\//i);
        if (m) cnt[m[1]] = (cnt[m[1]] || 0) + 1;
      });
      var best = '', bestN = 0;
      Object.keys(cnt).forEach(function (k) { if (cnt[k] > bestN) { bestN = cnt[k]; best = k; } });
      if (best && bestN >= aisNum('common.mainDominantMin', 3)) {
        list = list.filter(function (u) {
          var m = String(u).match(/\/(?:imgextra|bao\/uploaded)\/i\d\/(\d{8,})\//i);
          return !m || m[1] === best;
        });
      }
      if (list.length && list.length !== (state.main || []).length) state.main = list;
      else if (list.length) state.main = list;
      // v1.2.389 安全网：净化后不得为空（真机 Tmall：主流卖家过滤把 5 张主图全剔掉 → 网格空白）
    if (!state.main.length && __mainBackup.length) { state.main = __mainBackup; }
  } catch (ePm) {}
  }
  // v1.2.385：主图净化【规则开关，默认关闭=商店行为】——服务器开：common.mainPurge/mainPreferSsr/logoPurge
  function render() {
    try { purgeMain(); } catch (ePm0) {}
    var grid = $('aisimg-grid'); if (!grid) return;
  try { scheduleSizeMeasure(); } catch (eSM) {}   // v1.2.310：无声明尺寸的 URL 用 naturalWidth 兜底测出后触发重筛
    var f = state.filter;
    var html = '';
    try {
    ['main', 'sku', 'desc', 'video'].forEach(function (t) {
      if (f !== 'all' && f !== t) return;
      var list = t === 'video' ? videoList() : state[t];   // v1.2.292 多视频
      // v1.2.333 根因修复：主图/SKU 图【永不参与尺寸筛选】——真机京东实测：用户把筛选设成 1500 并持久化，
      // 而京东主图实测 naturalWidth 约 800 → 全部被 keepBySize 滤掉，面板显示「主图 0 / SKU 0」（数据其实一直在 state 里）。
      // 尺寸筛选的用途是剔除详情区的小图/装饰图，商品主图与色卡图必须始终可见（与 v1.2.293 视频豁免同理）。
      // v1.2.337：尺寸筛选策略改为【服务器远程可调】——common.sizeFilterExempt（豁免类别）/ sizeFilterNeverEmpty（只修剪不清空）
      var __sfExempt = aisArr('common.sizeFilterExempt', ['main', 'sku', 'video']);
      var __sfNeverEmpty = Number(aisNum('common.sizeFilterNeverEmpty', 1)) !== 0;
      var __noSizeFilter = (__sfExempt || []).indexOf(t) >= 0;
      var __min = __noSizeFilter ? 0 : (Number(state.minSize) || 0);
      if (__min) {
        var __kept = list.filter(function (u) { return keepBySize(u, __min); });
        list = (__sfNeverEmpty && !__kept.length) ? list : __kept;   // 只修剪不清空整类（可远端关闭）
      }
      var __sort = t === 'video' ? 0 : (Number(state.sortMode) || 0);   // v1.2.297 排序（视频不参与）
      if (__sort) list = list.slice().sort(function (a, b) { var da = declaredSizeOf(a) || 0, db = declaredSizeOf(b) || 0; return __sort === 1 ? (db - da) : (da - db); });
      // v1.2.394：SKU 组「计数有、网格空」修复——list 为空时从 skuRows[].SKU图 / skuValueImgs 补数据源
      if (!list.length && t === 'sku') {
        try {
          var __syn2 = [];
          (state.skuRows || []).forEach(function (r) { if (r && r['SKU图']) __syn2.push(r['SKU图']); });
          (state.skuValueImgs || []).forEach(function (v) { if (v && v.image) __syn2.push(v.image); });
          if (__syn2.length) list = __syn2.filter(function (u, i2, a) { return a.indexOf(u) === i2; });
        } catch (eSyn2) {}
      }
      if (!list.length) return;
      var cards;
      if (t === 'sku') {
        cards = [];
        var seenK = {}, infoMap = skuImgInfoMap(), sizeRe = /尺码|尺寸|码数/;
        (state.skuValueImgs || []).forEach(function (vi) {
          if (!vi || !vi.image) return;
          if (__min && !keepBySize(vi.image, __min)) return;   // v1.2.296 尺寸筛选对 SKU 来源同样生效
          var k = skuImgKey(vi.image);
          if (seenK[k]) return;
          seenK[k] = 1;
          var cap = '';
          if (vi.name && vi.value && !sizeRe.test(vi.name)) cap = vi.value;
          else if (vi.value) {
            String(vi.value).split(/[;；]/).forEach(function (seg) {
              seg = seg.trim(); if (!seg || sizeRe.test(seg)) return;
              var kv = seg.split(':');
              cap = cap ? cap + '；' : '';
              cap += (kv.length > 1 ? kv.slice(1).join(':') : seg);
            });
          }
          cards.push({ u: vi.image, cap: cap });
        });
        (state.skuRows || []).forEach(function (r) {
          var u2 = r && r["SKU图"]; if (!u2) return;
          if (__min && !keepBySize(u2, __min)) return;   // v1.2.296
          var k = skuImgKey(u2);
          if (seenK[k]) return;
          seenK[k] = 1;
          cards.push({ u: u2, cap: skuCaption(r) });
        });
        list.forEach(function (u) {
          var k = skuImgKey(u);
          if (seenK[k]) return;
          seenK[k] = 1;
          cards.push({ u: u, cap: infoMap[k] || '' });
        });
      } else {
        cards = list.map(function (u) { return { u: u, cap: '' }; });
      }
      if (!cards.length) return;
      html += '<div class="aisimg-group"><div class="aisimg-group-title">' + TYPE_LABEL[t] + ' <b>' + cards.length + '</b> 张</div><div class="aisimg-gridrow">';
      cards.forEach(function (c, i) { html += cardHtml(t, c.u, i, c.cap); });
      html += '</div></div>';
    });
    } catch (eRender) { try { console.log('[电商采集大师] render 异常: ' + ((eRender && eRender.message) || eRender)); } catch (eLR2) {} }
    // v1.2.263：详情图未出来 / 未采到的常驻提示（全平台）
    html += descLoadingHtml() + descMissingHtml();
    grid.innerHTML = html;
    // v1.2.344：坏图自愈——任何加载不出来的图（404 / 占位 / 防盗链）直接从数据源剔除并重渲染，
    // 用户不会再看到「SKU图 N」这种破图占位（真机 1688 实测 4 张里 2 张是破图）。
    // v1.2.389：坏图自愈【规则开关，默认关闭=商店行为】——误伤防盗链/加载慢的图
    // 服务器开：common.imgSelfHeal="on"（仅对确实 404 的图生效）
    if (aisSel('common.imgSelfHeal', 'off') !== 'off')     try {
      var __bad = state.__badImgs || (state.__badImgs = {});
      var __imgs = grid.querySelectorAll('img');
      for (var __bi = 0; __bi < __imgs.length && __bi < 300; __bi++) {
        (function (img) {
          var u = String(img.getAttribute('src') || '');
          if (!u) return;
          img.addEventListener('error', function () {
            if (__bad[u]) return;
            __bad[u] = 1;
            try { console.log('[电商采集大师] 剔除加载失败的图：' + u); } catch (eL) {}
            var k = skuImgKey(u);
            var drop = function (arr) { return (arr || []).filter(function (x) { return String(x || '') !== u; }); };
            state.main = drop(state.main); state.sku = drop(state.sku); state.desc = drop(state.desc);
            state.skuValueImgs = (state.skuValueImgs || []).filter(function (v) { return !v || String(v.image || '') !== u; });
            state.skuRows = (state.skuRows || []).map(function (r) {
              if (r && skuImgKey(r['SKU图'] || '') === k) { var c = Object.assign({}, r); delete c['SKU图']; return c; }
              return r;
            });
            clearTimeout(state.__badTimer);
            state.__badTimer = setTimeout(function () { try { render(); } catch (eR) {} try { updateCounts(); } catch (eC) {} }, 120);
          });
        })(__imgs[__bi]);
      }
    } catch (eBad) {}
    var empty = $('aisimg-empty');
    if (empty) empty.style.display = html ? 'none' : (grid.style.display === 'none' ? 'none' : '');
    updateCounts();
    updateSelCnt();
    updateGrpbar();
  }

  // v1.2.296：SKU 卡片数按【渲染口径】统计 —— 实测发现导航数 state.sku.length，而网格还渲染了
  //   skuValueImgs 与 skuRows 两处来源，导致「导航 21 vs 网格 22」差 1。这里镜像 render 的三来源去重逻辑。
  function skuCardCount(min) {
    try {
      var seen = {}, n = 0;
      var add = function (u) { if (!u) return; if (min && !keepBySize(u, min)) return; var k = skuImgKey(u); if (seen[k]) return; seen[k] = 1; n++; };
      (state.skuValueImgs || []).forEach(function (vi) { if (vi && vi.image) add(vi.image); });
      (state.skuRows || []).forEach(function (r) { if (r && r['SKU图']) add(r['SKU图']); });
      (state.sku || []).forEach(add);
      return n;
    } catch (e) { return (state.sku || []).length; }
  }
  function updateCounts() {
    // v1.2.295：导航计数与网格【同一口径】—— 有尺寸筛选时显示筛选后数量（此前 chips 显示总数、网格是筛选后，同屏两套口径）
    var __min = Number(state.minSize) || 0;
    // v1.2.333：与网格同口径——主图/SKU/视频不参与尺寸筛选（只筛详情图）
    var __sfEx2 = aisArr('common.sizeFilterExempt', ['main', 'sku', 'video']);
    var __sfNE2 = Number(aisNum('common.sizeFilterNeverEmpty', 1)) !== 0;
    var __cnt = function (arr, t) {
      var min = ((__sfEx2 || []).indexOf(t) >= 0) ? 0 : __min;
      if (!min) return (arr || []).length;
      var kept = (arr || []).filter(function (u) { return keepBySize(u, min); }).length;
      return (kept || !__sfNE2) ? kept : (arr || []).length;   // 与网格同口径：滤光则保留全部
    };
    var __vN = videoList().length;
    var __sN = skuCardCount((__sfEx2 || []).indexOf('sku') >= 0 ? 0 : __min);   // 策略化
    try { window.__AIS_SF__ = { exempt: __sfEx2, neverEmpty: __sfNE2, longEdge: Number(aisNum('common.sizeFilterLongEdge', 1)) !== 0, minSize: state.minSize }; } catch (eSF) {}
    var n = { all: __cnt(state.main, 'main') + __sN + __cnt(state.desc, 'desc') + __vN,
              main: __cnt(state.main, 'main'), sku: __sN, desc: __cnt(state.desc, 'desc'), video: __vN };
    try { var fcEl = $('aisimg-filterclear'); if (fcEl) fcEl.style.display = __min ? '' : 'none'; } catch (eFC) {}
    Object.keys(n).forEach(function (k) { var el = $('aisimg-n-' + k); if (el) el.textContent = String(n[k]); });
    // v1.2.184：页签数量角标（图片=全部 / SKU=规格行 / 评论=已采条数）
    try {
      var ti = $('aisimg-tabcnt-img'); if (ti) ti.textContent = String(n.all);
      var ts = $('aisimg-tabcnt-sku'); if (ts) ts.textContent = String((state.skuRows && state.skuRows.length) || n.sku);
      var tr = $('aisimg-tabcnt-rev'); if (tr) tr.textContent = String((state.reviews && state.reviews.length) || 0);
    } catch (eTC) {}
  }
  function updateSelCnt() {
    var n = D().querySelectorAll('.aisimg-cardchk:checked').length;
    var b = $('aisimg-selcnt'); if (b) b.textContent = String(n);
    // v1.2.184：底部常驻操作条统计（按类型拆分）
    try {
      var bs = $('aisimg-bot-sel'), bsub = $('aisimg-bot-sub');
      if (bs) bs.textContent = n ? ('已选 ' + n + ' 张') : '已选 0 张';
      if (bsub) {
        if (n) {
          var tcnt = { main: 0, sku: 0, desc: 0, video: 0 };
          Array.prototype.forEach.call(D().querySelectorAll('.aisimg-cardchk:checked'), function (cb) {
            var card = cb.closest ? cb.closest('.aisimg-card') : null;
            var ty = card && card.getAttribute('data-type');
            if (ty && tcnt[ty] != null) tcnt[ty]++;
          });
          var parts = [];
          if (tcnt.main) parts.push('主图 ' + tcnt.main);
          if (tcnt.sku) parts.push('SKU ' + tcnt.sku);
          if (tcnt.desc) parts.push('详情 ' + tcnt.desc);
          if (tcnt.video) parts.push('视频 ' + tcnt.video);
          bsub.textContent = parts.join(' · ') || '点图选择';
        } else {
          // v1.2.450：原文案「点击图片开始选择」8 字，在 560 宽面板里被压成「点…」（底部条一行放不下），改短
          bsub.textContent = '点图选择';
        }
      }
    } catch (eBot) {}
    var gf = state.filter;
    if (gf && gf !== 'all') {
      var gc = grpChecks(gf), gsel = 0;
      gc.forEach(function (x) { if (x.cb.checked) gsel++; });
      var gcEl = $('aisimg-grpcnt'); if (gcEl) gcEl.textContent = String(gsel);
      var gsa = $('aisimg-grpselall'); if (gsa) gsa.checked = gc.length > 0 && gsel === gc.length;
    }
    updateDlBtnLabel(); // v1.2.234：底部下载按钮文案随选中数与 ZIP 勾选刷新
  }
  // v1.2.234：底部主按钮动词跟着「下载为 ZIP」走——不勾=下载，勾上=打包下载，避免「按钮说打包、实际下散图」
  function dlZipOn() { var z = $('aisimg-zip'); return !!(z && z.checked); }
  function updateDlBtnLabel() {
    try {
      var btn = $('aisimg-dlsel'); if (!btn) return;
      var n = D().querySelectorAll('.aisimg-cardchk:checked').length;
      var badge = $('aisimg-selcnt');
      var txt = (dlZipOn() ? '打包下载' : '下载') + (n ? '' : '全部');
      if (btn.firstChild && btn.firstChild.nodeType === 3) btn.firstChild.nodeValue = txt;
      if (badge) badge.style.display = n ? '' : 'none';
      btn.title = (dlZipOn() ? '打包为 ZIP 下载已勾选的图片' : '逐个文件下载已勾选的图片') + '；未勾选时会询问是否下载当前可见的全部';
    } catch (eDL) {}
  }
  // v1.2.234：下载设置可用态同步——「原始格式 + 100%」不重编码，质量不生效就置灰并说明
  function syncDownloadSettings() {
    try {
      var fmtEl = $('aisimg-format'), scEl = $('aisimg-scale'), qEl = $('aisimg-quality');
      if (!fmtEl || !qEl) return;
      var fmt = fmtEl.value;
      var sc = parseFloat((scEl && scEl.value) || '1') || 1;
      var reencode = (fmt !== 'original') || (sc !== 1);
      var qWorks = reencode && fmt !== 'image/png';
      qEl.disabled = !qWorks;
      qEl.title = qWorks ? 'JPEG / WEBP 重编码质量（1-100）；PNG 与原始格式直下时不生效' : '当前设置不重编码，质量参数不生效';
      // v1.2.297：设置折叠为一行摘要 + 前缀自定义框显隐
      try {
        var pmEl2 = $('aisimg-prefixmode');
        var pmode2 = pmEl2 ? (parseInt(pmEl2.value, 10) || 0) : 0;
        var ptw = $('aisimg-prefixtext-wrap'); if (ptw) ptw.style.display = pmode2 === 2 ? '' : 'none';
        var ss = $('aisimg-setsummary');
        if (ss) {
          var parts = [(fmt === 'original' ? '原始格式' : String(fmt).replace('image/', '').toUpperCase()), Math.round(sc * 100) + '%'];
          var nestEl3 = $('aisimg-nest'); if (nestEl3 && nestEl3.checked) parts.push('按商品分文件夹');
          var zipEl3 = $('aisimg-zip'); if (zipEl3 && zipEl3.checked) parts.push('ZIP 打包');
          parts.push(pmode2 === 1 ? '前缀:按分类' : (pmode2 === 2 ? ('前缀:' + (String(($('aisimg-prefixtext') || {}).value || '').trim() || '自定义')) : '无前缀'));
          // v1.2.450：底部那行「原始格式·100%：直接下载平台原图，不压缩、不缩放（质量不生效）」与这里重复，
          //   已删掉该元素；把唯一有用的「质量不生效」并进摘要，少一行、也不再两处说同一件事。
          if (!qWorks) parts.push('质量不生效');
          ss.textContent = parts.join(' · ');
        }
      } catch (eSum) {}
      updateDlBtnLabel();
    } catch (eSS) {}
  }
  function visibleUrls() {
    var out = [];
    D().querySelectorAll('.aisimg-card').forEach(function (c) { var u = c.getAttribute('data-url'); if (u) out.push(u); });
    return out;
  }

  function dlOne(url, type) {
    if (!url) return;
    type = type || typeOf(url);
    if (type === 'review' && !requireMember('评论图片下载')) return; // v1.1.151 评论图片下载为会员功能（运行时门控）
    var list = type === 'video' ? videoList() : (state[type] || []);   // v1.2.292
    var n = list.indexOf(url) + 1; if (n <= 0) n = 1;
    var nm = type === 'sku' ? skuFileName(url) : '';
    // v1.2.421：单图下载（卡片上的「下载」按钮）也走「原图名」——与批量下载/打包/素材包口径完全一致。
    // 原来这里是 nm||类型_序号，属改名行为（用户要求：所有图片下载都用原始名称）。
    var __dm = imgNameMode();
    var __base = useOrigName(__dm, type) ? (origNameOf(url) || (nm || (TYPE_LABEL[type] + '_' + pad(n)))) : (nm || (TYPE_LABEL[type] + '_' + pad(n)));
    var fname = safeFs(state.itemTitle || '图片快采') + '/' + TYPE_LABEL[type] + '/' + __base + '.' + extOf(url);
    progShow('单张下载 · ' + TYPE_LABEL[type]);
    progSet(0, 1, '正在下载…');
    sendBg({ action: 'downloadImage', url: url, filename: fname, type: type }).then(function (r) {
      if (r && r.success) {
        progSet(1, 1, '已完成');
        progHide(1200);
        aisToast('已下载：' + TYPE_LABEL[type] + ' ' + n + ' → ' + fname, 'info');
      } else {
        progSet(0, 1, '失败');
        progHide(2500);
        (function(){var __e=String((r&&r.error)||'未知错误');if(/context invalidated|Extension context/i.test(__e)){aisToast('扩展刚更新或重载过，本页已失效 —— 请按 F5 刷新页面后重试','error');}else{aisToast('下载失败：'+__e,'error');}})();
      }
    });
  }

  function dlBatch() {
    var sel = [];
    D().querySelectorAll('.aisimg-cardchk:checked').forEach(function (cb) { var u = cb.getAttribute('data-url'); if (u) sel.push(u); });
    if (sel.length) { dlBatchRun(sel); return; }
    // v1.2.181：未勾选时不再"默默下载全部可见图"，改为先确认（避免误操作）
    var vis = visibleUrls();
    if (!vis.length) { aisToast('没有可下载的图片', 'warn'); return; }
    aisConfirm('未勾选任何图片，是否下载当前可见的全部 ' + vis.length + ' 张？', { okText: '下载全部', cancelText: '取消' }).then(function (yes) { if (yes) dlBatchRun(vis); });
  }
  function dlBatchRun(chosen) {
    if (!chosen || !chosen.length) { aisToast('没有可下载的图片', 'warn'); return; }
    if (chosen.some(function (u) { return typeOf(u) === 'review'; }) && !requireMember('评论图片下载')) return; // v1.1.151 评论图片为会员功能
    var fmtEl = $('aisimg-format'), qEl = $('aisimg-quality'), scEl = $('aisimg-scale'), zipEl = $('aisimg-zip');
    var fmt = fmtEl ? fmtEl.value : 'original';
    var q = qEl ? parseFloat(qEl.value || '92') : 92;
    var sc = scEl ? parseFloat(scEl.value || '1') : 1;
    var zip = zipEl ? !!zipEl.checked : true;
    var nestEl = $('aisimg-nest');
    var nest = nestEl ? !!nestEl.checked : true;
    // v1.2.291 文件名分类前缀（设置项；默认关，避免改变既有用户文件名）
    // v1.2.297：前缀改为一个下拉（0 不加 / 1 按分类 / 2 自定义），自定义时才读文字
    var pmEl = $('aisimg-prefixmode');
    var pmode = pmEl ? (parseInt(pmEl.value, 10) || 0) : 0;
    var prefix = pmode > 0;
    var prefixText = pmode === 2 ? String(($('aisimg-prefixtext') || {}).value || '').trim() : '';
    if (zip && !requireMember('打包下载（ZIP）')) return;
    var items = [];
    chosen.forEach(function (u) {
      var t = typeOf(u);
      var nm = t === 'sku' ? skuFileName(u) : '';
      items.push({ url: u, type: t, folder: TYPE_LABEL[t], name: nm, format: t === 'video' ? 'original' : fmt, quality: q, scale: sc });
    });
    var csv = '\ufeff类型,文件名,链接\n';
    var __nmMode = imgNameMode();          // v1.2.419：orig=原图名（不分类、不加前缀、不改名）
    var __usedCsv = {};
    chosen.forEach(function (u, i) {
      var t = typeOf(u);
      var nm = t === 'sku' ? skuFileName(u) : '';
      var fnBase = useOrigName(__nmMode, t) ? (origNameOf(u) || (TYPE_LABEL[t] + '_' + pad(i + 1))) : (nm || (TYPE_LABEL[t] + '_' + pad(i + 1)));
      var fn = fnBase + '.' + extOf(u);
      if (!useOrigName(__nmMode, t) && prefix) fn = (prefixText || TYPE_LABEL[t]) + '-' + fn;   // v1.2.291（原图名模式不加前缀）
      var __k = TYPE_LABEL[t] + '/' + fn, __n = 2;
      while (__usedCsv[__k]) { fn = fnBase + '-' + (__n++) + '.' + extOf(u); __k = TYPE_LABEL[t] + '/' + fn; }
      __usedCsv[__k] = 1;
      csv += TYPE_LABEL[t] + ',' + fn + ',' + u + '\n';
    });
    var b64 = '';
    try { b64 = btoa(unescape(encodeURIComponent(csv))); } catch (e) {}
    state.__dlTitle = zip ? '打包下载' : '批量下载';
    progShow(state.__dlTitle + ' · ' + chosen.length + ' 张');
    progSet(0, chosen.length, '正在抓取…');
    sendBg({ action: 'downloadImages', images: items, asZip: zip, nest: nest, prefix: prefix, prefixText: prefixText, nameMode: __nmMode, itemTitle: state.itemTitle, itemId: state.itemId, summaryCsvBase64: b64 }).then(function (r) {
      if (r && r.ok) {
        var txt = r.mode === 'zip'
          ? 'ZIP 已下载：' + r.down + ' 张（失败 ' + (r.failed || 0) + '）'
          : '已下载 ' + r.down + ' 张（失败 ' + (r.failed || 0) + '）';
        progSet(chosen.length, chosen.length, '已完成' + (r.failed ? ' · 失败 ' + r.failed : ''));
        progHide(1800);
        aisToast(txt + (r.fileName ? ' · ' + r.fileName : ''), r.failed ? 'warn' : 'info');
        if (r.downloadId != null) state.lastDownloadId = r.downloadId;
        if (r.downloadIds && r.downloadIds.length) state.lastDownloadId = r.downloadIds[r.downloadIds.length - 1];
        if (state.lastDownloadId != null) showOpenFolder();
        saveHistory(chosen.length);
      } else {
        progSet(0, chosen.length, '失败');
        progHide(3000);
        (function(){var __e=String((r&&r.error)||'未知错误');if(/context invalidated|Extension context/i.test(__e)){aisToast('扩展刚更新或重载过，本页已失效 —— 请按 F5 刷新页面后重试','error');}else{aisToast('下载失败：'+__e,'error');}})();
      }
    });
  }

  function grpChecks(f) {
    var out = [];
    D().querySelectorAll('.aisimg-cardchk').forEach(function (cb) {
      var u = cb.getAttribute('data-url');
      if (u && typeOf(u) === f) out.push({ cb: cb, u: u });
    });
    return out;
  }
  function updateGrpbar() {
    var bar = $('aisimg-grpbar'); if (!bar) return;
    var f = state.filter;
    if (f === 'all') { bar.style.display = 'none'; return; }
    var list = f === 'video' ? videoList() : (state[f] || []);   // v1.2.292
    if (!list.length) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    var nameEl = $('aisimg-grpbar-name');
    if (nameEl) nameEl.textContent = TYPE_LABEL[f] + ('\uFF08' + list.length + ' \u5F20\uFF09');
    // v1.1.144：本组打包下载过后，按钮改为已打包态（跨模板/重复显示「打包下载本组」修复）；新商品/刷新在重置点清 grpPkgDone
    var pkgBtn = $('aisimg-grppkg');
    state.grpPkgDone = state.grpPkgDone || {}; state.grpPkgSig = state.grpPkgSig || {};
    var _pkgSig = list.join('\n');
    if (state.grpPkgDone[f] && state.grpPkgSig[f] !== _pkgSig) state.grpPkgDone[f] = ''; // 同商品异步新增图片后，旧完成态立即失效
    var _pkgState = state.grpPkgDone[f];
    // v1.2.232：「已打包」只在真的产出 ZIP 时说；非 ZIP（免费版/未勾选 ZIP）如实说「已下载」
    state.grpPkgZip = state.grpPkgZip || {};
    var _pkgZip = !!state.grpPkgZip[f];
    if (pkgBtn && pkgBtn.firstChild) pkgBtn.firstChild.nodeValue = _pkgState === 'done'
      ? (_pkgZip ? '✓ 本组已打包 · 重新打包' : '✓ 本组已下载 · 重新下载')
      : (_pkgState === 'partial'
        ? (_pkgZip ? '⚠ 本组部分打包 · 重试' : '⚠ 本组部分下载 · 重试')
        : '打包下载本组');
    updateSelCnt();
  }
  function dlGroup(type) {
    if (!type || type === 'all') return;
    var list = type === 'video' ? videoList() : (state[type] || []);   // v1.2.292
    if (!list.length) { aisToast('\u8BE5\u5206\u7EC4\u6682\u65E0\u56FE\u7247', 'warn'); return; }
    var fmtEl = $('aisimg-format'), qEl = $('aisimg-quality'), scEl = $('aisimg-scale'), zipEl = $('aisimg-zip');
    var fmt = fmtEl ? fmtEl.value : 'original';
    var q = qEl ? parseFloat(qEl.value || '92') : 92;
    var sc = scEl ? parseFloat(scEl.value || '1') : 1;
    var zip = zipEl ? !!zipEl.checked : true;
    // v1.2.233：「打包下载本组」按钮本身就是会员功能（按钮上带「会员」标记），不再随「下载为 ZIP」勾选状态放行。
    // 免费/过期用户点它必须先看到功能说明；免费版的「全选本组 → 下载选中 / 下载全部」不受影响。
    if (!requireMember('打包下载本组（ZIP）')) return;
    var nestEl2 = $('aisimg-nest');
    var nest2 = nestEl2 ? !!nestEl2.checked : true;
    // v1.2.291 文件名分类前缀（设置项；默认关，避免改变既有用户文件名）
    // v1.2.297：前缀改为一个下拉（0 不加 / 1 按分类 / 2 自定义），自定义时才读文字
    var pmEl = $('aisimg-prefixmode');
    var pmode = pmEl ? (parseInt(pmEl.value, 10) || 0) : 0;
    var prefix = pmode > 0;
    var prefixText = pmode === 2 ? String(($('aisimg-prefixtext') || {}).value || '').trim() : '';
    var items = list.map(function (u) {
      var nm2 = type === 'sku' ? skuFileName(u) : '';
      return { url: u, type: type, folder: TYPE_LABEL[type], name: nm2, format: type === 'video' ? 'original' : fmt, quality: q, scale: sc };
    });
    var csv = '\ufeff\u7C7B\u578B,\u6587\u4EF6\u540D,\u94FE\u63A5\n';
    var __nmMode2 = imgNameMode();   // v1.2.419：orig=原图名（不分类、不加前缀、不改名）
    var __usedCsv2 = {};
    list.forEach(function (u, i2) {
      var nm2 = type === 'sku' ? skuFileName(u) : '';
      var fnBase2 = useOrigName(__nmMode2, type) ? (origNameOf(u) || (TYPE_LABEL[type] + '_' + pad(i2 + 1))) : (nm2 || (TYPE_LABEL[type] + '_' + pad(i2 + 1)));
      var fn2 = fnBase2 + '.' + extOf(u);
      if (!useOrigName(__nmMode2, type) && prefix) fn2 = (prefixText || TYPE_LABEL[type]) + '-' + fn2;   // v1.2.291
      var __k2 = TYPE_LABEL[type] + '/' + fn2, __n2 = 2;
      while (__usedCsv2[__k2]) { fn2 = fnBase2 + '-' + (__n2++) + '.' + extOf(u); __k2 = TYPE_LABEL[type] + '/' + fn2; }
      __usedCsv2[__k2] = 1;
      csv += TYPE_LABEL[type] + ',' + fn2 + ',' + u + '\n';
    });
    var b64 = '';
    try { b64 = btoa(unescape(encodeURIComponent(csv))); } catch (e) {}
    state.__dlTitle = '本组打包 · ' + TYPE_LABEL[type];
    progShow(state.__dlTitle + ' · ' + list.length + ' 张');
    progSet(0, list.length, '正在抓取…');
    sendBg({ action: 'downloadImages', images: items, asZip: zip, nest: nest2, prefix: prefix, prefixText: prefixText, nameMode: imgNameMode(), itemTitle: state.itemTitle, itemId: state.itemId, summaryCsvBase64: b64 }).then(function (r) {
      if (r && r.ok) {
        var txt = r.mode === 'zip' ? ('\u672C\u7EC4 ZIP \u5DF2\u4E0B\u8F7D\uFF1A' + r.down + ' \u5F20\uFF08\u5931\u8D25 ' + (r.failed || 0) + '\uFF09') : ('\u672C\u7EC4\u5DF2\u4E0B\u8F7D ' + r.down + ' \u5F20\uFF08\u5931\u8D25 ' + (r.failed || 0) + '\uFF09');
        progSet(list.length, list.length, '已完成' + (r.failed ? ' · 失败 ' + r.failed : ''));
        progHide(1800);
        aisToast(txt, r.failed ? 'warn' : 'info');
        if (r.downloadId != null) state.lastDownloadId = r.downloadId;
        if (r.downloadIds && r.downloadIds.length) state.lastDownloadId = r.downloadIds[r.downloadIds.length - 1];
        if (state.lastDownloadId != null) showOpenFolder();
        saveHistory(_pkgDown); // v1.1.145：历史数量记录实际成功数，不记录请求数
        // v1.1.145：只有全部成功才标已打包；部分成功显示“部分下载”，0 成功保持未下载。
        state.grpPkgDone = state.grpPkgDone || {};
        var _pkgDown = Math.max(0, Number(r.down) || 0);
        var _pkgComplete = _pkgDown >= list.length && !(Number(r.failed) || 0);
        state.grpPkgDone[type] = _pkgComplete ? 'done' : (_pkgDown > 0 ? 'partial' : '');
        state.grpPkgZip = state.grpPkgZip || {};
        state.grpPkgZip[type] = (r.mode === 'zip') ? 1 : 0; // v1.2.232：以 worker 实际产物为准（zip / 散图），按钮文案据此区分
        state.grpPkgSig = state.grpPkgSig || {};
        state.grpPkgSig[type] = list.join('\n');
        try { updateGrpbar(); } catch (eUG) {}
      } else { progSet(0, list.length, '失败'); progHide(3000); aisToast('\u6253\u5305\u4E0B\u8F7D\u5931\u8D25\uFF1A' + ((r && r.error) || '\u672A\u77E5\u9519\u8BEF'), 'error'); }
    });
  }

  // v1.2.281 帮助中心：内容走远程 common.helpSections（可远程更新，不用发版）
  function helpModal() {
    try {
      var secs = aisArr('common.helpSections', []);
      var lines = ['电商采集大师 · 帮助中心', ''];
      if (!secs || !secs.length) lines.push('（帮助内容暂不可用）');
      else secs.forEach(function (s) {
        if (!s || !s[0]) return;
        lines.push('【' + s[0] + '】');
        (s[1] || []).forEach(function (l) { lines.push('  ' + l); });
        lines.push('');
      });
      lines.push('提示：平台改版后先点「立即更新规则」，多数问题不用等版本更新。');
      var msg = lines.join('\n');
      if (typeof aisDialog === 'function') { aisDialog(msg, { title: '帮助中心', cancelText: null }); return; }
      status('帮助中心不可用');
    } catch (e) { status('帮助中心打开失败：' + (e && e.message)); }
  }

  try { window.helpModal = helpModal; } catch (eWH) {}

  // v1.2.280：以图搜货 —— 用当前图片打开 1688 以图搜同款（地址模板走远程 common.imgSearchUrls，平台改版可远程改）
  function imgSearch() {
    try {
      var u = '';
      var sel = D().querySelectorAll('.aisimg-cardchk:checked');
      if (sel.length) u = sel[0].getAttribute('data-url') || '';
      if (!u) {
        var all = D().querySelectorAll('.aisimg-cardchk');
        for (var i = 0; i < all.length; i++) {
          var v = all[i].getAttribute('data-url') || '';
          if (v && (state.main || []).indexOf(v) >= 0) { u = v; break; }
        }
      }
      if (!u) u = (state.main && state.main[0]) || '';
      if (!u) { status('没有可用于搜货的图片'); return; }
      var arr = aisArr('common.imgSearchUrls', [['1688', 'https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress={url}']]);
      var tpl = '';
      for (var j = 0; j < arr.length; j++) { if (arr[j] && arr[j][1]) { tpl = String(arr[j][1]); break; } }
      if (!tpl) { status('未配置以图搜货地址'); return; }
      var target = tpl.replace('{url}', encodeURIComponent(u)).replace('{raw}', u);
      var w = window.open(target, '_blank');
      status(w ? '已用当前图片打开以图搜货' : '以图搜货被浏览器拦截，请允许弹窗后重试', true);
    } catch (e) { status('以图搜货失败：' + (e && e.message)); }
  }

  // v1.2.279：结构化复制 —— 按 主图 / SKU图（规格名 | 链接）/ 详情图 / 视频 分组，供 ERP 直接粘贴
  function copyAll() {
    function rowVal(r, keys) { for (var i = 0; i < keys.length; i++) { var v = r && r[keys[i]]; if (v != null && v !== '') return String(v); } return ''; }
    var lines = [];
    lines.push('【商品】' + (state.itemTitle || '(未取到标题)'));
    lines.push('【链接】' + location.href);
    lines.push('');
    var skuSpec = {};
    try {
      (state.skuRows || []).forEach(function (r) {
        var u = rowVal(r, ['SKU图', 'skuImg', 'SKU图片']);
        var s = rowVal(r, ['规格', '规格组合', 'spec']);
        if (u && s) skuSpec[String(u).replace(/^https?:/, '')] = s;
      });
    } catch (e) {}
    function pushGroup(title, arr, decorate) {
      if (!arr || !arr.length) return;
      lines.push('== ' + title + ' (' + arr.length + ') ==');
      arr.forEach(function (u, i) {
        var extra = '';
        try { extra = decorate ? (decorate(u) || '') : ''; } catch (e) {}
        lines.push((extra ? extra + ' | ' : '') + (i + 1) + '. ' + u);
      });
      lines.push('');
    }
    var n = 0;
    pushGroup('主图', state.main); n += (state.main || []).length;
    pushGroup('SKU图', state.sku, function (u) { return skuSpec[String(u).replace(/^https?:/, '')] || ''; }); n += (state.sku || []).length;
    pushGroup('详情图', state.desc); n += (state.desc || []).length;
    if (videoList().length) { pushGroup('视频', videoList()); n += videoList().length; }   // v1.2.292
    if (!n) { status('没有可复制的链接'); return; }
    var text = lines.join('\n').replace(/\n+$/, '');
    var done = function () { status('已复制结构化链接 ' + n + ' 条（主图 / SKU图 / 详情图 / 视频）', true); };
    var fail = function () {
      try {
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta); done();
      } catch (e) { status('复制失败'); }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fail);
    else fail();
  }

  try { window.imgSearch = imgSearch; window.copyAll = copyAll; } catch (eWI) {}

  function saveHistory(count) {
    var rec = { type: 'images', title: state.itemTitle || '', url: location.href, itemCount: count, timestamp: Date.now() };
    var imgs = state.main.concat(state.sku).concat(state.desc);
    if (videoList().length) imgs = imgs.concat(videoList());   // v1.2.292
    // v1.1.69：保存评论数据（压缩投影，供历史「评论打包」使用）
    var revs = revSortList(state.reviews || []).slice(0, 300).map(function (r) {
      return { reviewId: r.reviewId, rating: r.rating || 0, time: r.time || '', skuInfo: r.skuInfo || '', content: r.content || '', append: r.append || r.appendReply || r.appendContent || '', images: (r.images || r.pics || []).slice(0, 6) };
    });
    // v1.2.224：问答投影入历史（限 200 问 / 每问 5 答，避免 storage 膨胀）
    var wdjs = (state.wdjList || []).slice(0, 200).map(function (q) {
      return { questionId: q.questionId || '', content: q.content || '', time: q.time || '', answerCount: q.answerCount || 0, itemId: q.itemId || '', ipLocation: q.ipLocation || '', answers: (q.answers || []).slice(0, 5) };
    });
    // v1.2.429：历史保存【SKU 规格表】（供历史列表「SKU打包」使用）。此前历史只存 images/reviews/wdj，
    //   导致历史里的 SKU 无法打包 ✗。上限 500 行防 storage 膨胀。
    var skuRows = (state.skuRows || []).slice(0, 500);
    var skuProps = (state.skuPropNames || []).slice(0, 40);
    // v1.2.458【一键包需要】补存「商品参数 / 尺码表 / 各类图片数量」——
    //   参数与尺码表原来没进历史 ⇒ 历史里打不出与整合包一致的「数据表.xlsx」；
    //   imgSplit 只存各类数量（不重复存 URL），用于把图片按 主图/SKU图/详情图/视频 分目录。
    var itemPropsH = (state.itemProps || []).slice(0, 80).map(function (p) { return { name: (p && p.name) || '', value: (p && p.value) || '' }; });
    var sizeChartH = (state.sizeChart || []).slice(0, 80);
    var imgSplitH = { main: (state.main || []).length, sku: (state.sku || []).length, desc: (state.desc || []).length, video: videoList().length };
    var recFull = { ts: rec.timestamp, title: rec.title, itemId: state.itemId, count: count, url: rec.url, thumb: imgs[0] || '', images: imgs, skuRows: skuRows, skuProps: skuProps, itemProps: itemPropsH, sizeChart: sizeChartH, imgSplit: imgSplitH, reviews: revs, revCount: (state.reviews || []).length, wdj: wdjs, wdjCount: (state.wdjList || []).length };
    storeGet('aisImgHistory').then(function (list) {
      list = list || [];
      // v1.1.160：同商品保留最新一条，旧记录不重复的信息（图片清单/评论）并集合并进新记录
      var olds = [];
      list = list.filter(function (h) {
        var same = h.url === recFull.url || (recFull.itemId && h.itemId && String(h.itemId) === String(recFull.itemId));
        if (same) { olds.push(h); return false; }
        return true;
      });
      if (olds.length) {
        var _si = {}, _mi = [];
        recFull.images.concat.apply(recFull.images, olds.map(function (h) { return h.images || []; })).forEach(function (u) {
          if (!u || _si[u]) return; _si[u] = 1; _mi.push(u);
        });
        recFull.images = _mi;
        recFull.count = _mi.length;
        if (!recFull.thumb) recFull.thumb = olds[0].thumb || '';
        var _sr = {}, _mr = [];
        recFull.reviews.concat.apply(recFull.reviews, olds.map(function (h) { return h.reviews || []; })).forEach(function (v) {
          if (!v || !v.content) return;
          var k = revDedupKey(v);
          if (_sr[k]) return; _sr[k] = 1; _mr.push(v);
        });
        recFull.reviews = _mr.slice(0, 300);
        recFull.revCount = _mr.length;
        // v1.2.224：本场未采问答时，沿用同商品旧记录里的问答投影，历史不因重采而丢数据
        if (!(recFull.wdj || []).length && olds.length) { recFull.wdj = olds[0].wdj || []; recFull.wdjCount = olds[0].wdjCount || (recFull.wdj || []).length; }
        // v1.2.429：本场未采到 SKU 时沿用同商品旧记录的 SKU 规格表（与问答同策略，历史不因重采丢数据）
        if (!(recFull.skuRows || []).length && olds.length) { recFull.skuRows = olds[0].skuRows || []; recFull.skuProps = olds[0].skuProps || []; }
      }
      list.unshift(recFull);
      return storeSet({ aisImgHistory: list.slice(0, 50) }).then(function () { refreshHisTabCount(list.length > 50 ? 50 : list.length); });
    });
    storeGet('aisHistory').then(function (hlist) {
      hlist = hlist || [];
      // v1.1.158：同 URL 去重保最新
      hlist = hlist.filter(function (h) { return h.url !== rec.url; });
      hlist.unshift(rec);
      storeSet({ aisHistory: hlist.slice(0, 50) });
    });
  }
  // v1.2.188：采集历史页签数量角标
  function refreshHisTabCount(n) {
    try {
      var set = function (v) { var el = $('aisimg-tabcnt-his'); if (el) el.textContent = String(v || 0); };
      if (typeof n === 'number') { set(n); return; }
      storeGet('aisImgHistory').then(function (list) { set((list || []).length); });
    } catch (e) {}
  }
  function renderHistory() {
    storeGet('aisImgHistory').then(function (list) {
      var el = $('aisimg-hislist'); if (!el) return;
      list = list || [];
      refreshHisTabCount(list.length);
      if (!list.length) { el.innerHTML = '<div class="aisimg-empty">暂无采集历史<br><span style="font-size:11px;color:#98a1ad">采集完成后自动保存在这里，可随时恢复</span></div>'; return; }
      var html = '<div class="aisimg-histool"><label class="aisimg-hisall"><input type="checkbox" id="aisimg-hisall"> 全选</label>'
        + '<span class="aisimg-hisselcnt" id="aisimg-hisselcnt"></span>'
        + '<button type="button" class="aisimg-hisact" id="aisimg-hismember" title="功能说明">💎 功能说明</button>'
        + '<button type="button" class="aisimg-btn-ghost" id="aisimg-hispack">打包下载所选</button></div>';
      html += list.map(function (h) {
        var d = new Date(h.ts);
        var hasImgs = !!(h.images && h.images.length);
        var tu = h.thumb || (hasImgs ? h.images[0] : '');
        var thumb = tu ? '<img class="aisimg-histhumb" src="' + esc(tu) + '" referrerpolicy="no-referrer">' : '<span class="aisimg-histhumb aisimg-histhumb-noimg"></span>';
        // v1.2.430：有权限（会员/免费期/服务器开放）时不显示 🔒 —— 修「会员也一直挂着锁」的显示缺陷
        var __hkLock = (hisPackFree() || isMemberNow()) ? '' : '🔒 ';
        var name = h.url ? '<a class="t" href="' + esc(h.url) + '" target="_blank" title="' + esc(h.title) + '">' + esc(h.title || h.itemId || '未知商品') + '</a>'
                         : '<span class="t" title="' + esc(h.title) + '">' + esc(h.title || h.itemId || '未知商品') + '</span>';
        return '<div class="aisimg-hisitem">'
          + '<input type="checkbox" class="aisimg-hischk" data-ts="' + h.ts + '"' + (hasImgs ? '' : ' disabled title="该记录未保存图片清单"') + '>'
          + thumb
          + '<div class="aisimg-hismain">' + name + '<span class="c">' + d.toLocaleString() + ' · ' + h.count + '张' + (h.revCount ? ' · ' + h.revCount + '条评论' : '') + (hasImgs ? '' : ' · 无图片清单') + '</span>'
          + '<div class="aisimg-hisacts">'
          // v1.2.458【用户要求：三个按钮改成一键包】原来「图打包 / 评打包 / SKU打包」三个入口合并为一个；
          // v1.2.462【用户要求：历史一键包要和整合包一样】统一改名为「整合包」，ZIP 命名与文件集与面板整合包完全一致：
          //   图片（按分类分目录）+ 上架数据包.xlsx + 数据表.xlsx + 评论.xlsx（有评论时）+ 商品数据.json + 导入说明.txt
          + '<button type="button" class="aisimg-hisact" data-packact="' + h.ts + '" title="整合包（图片按分类 + 上架数据包 + 数据表 + 评论 + JSON + 说明，一个 ZIP）">' + __hkLock + '整合包</button>'
          + '</div></div>'
          + '</div>';
      }).join('') + '<div style="padding:8px;text-align:center;"><button type="button" class="aisimg-btn-ghost" id="aisimg-hisclear">清空历史</button></div>';
      el.innerHTML = html;
      el.querySelectorAll('img.aisimg-histhumb').forEach(function (im) {
        im.addEventListener('error', function () { im.style.visibility = 'hidden'; });
      });
      var all = el.querySelector('#aisimg-hisall');
      var pack = el.querySelector('#aisimg-hispack');
      var selTs = function () { var o = []; el.querySelectorAll('.aisimg-hischk:checked').forEach(function (cb) { o.push(String(cb.getAttribute('data-ts'))); }); return o; };
      var updSel = function () {
        var n = selTs().length, total = el.querySelectorAll('.aisimg-hischk:not([disabled])').length;
        var c = el.querySelector('#aisimg-hisselcnt'); if (c) c.textContent = n ? ('已选 ' + n + ' 条') : '';
        if (all) all.checked = n > 0 && n === total;
      };
      el.querySelectorAll('.aisimg-hischk').forEach(function (cb) { cb.addEventListener('change', updSel); });
      if (all) all.addEventListener('change', function () { var on = all.checked; el.querySelectorAll('.aisimg-hischk:not([disabled])').forEach(function (cb) { cb.checked = on; }); updSel(); });
      if (pack) pack.addEventListener('click', function () {
        if (!requireHisPack('打包下载（ZIP）')) return;
        var tsSet = {}; selTs().forEach(function (t) { tsSet[t] = 1; });
        var chosen = list.filter(function (h) { return tsSet[String(h.ts)] && h.images && h.images.length; });
        if (!chosen.length) { aisToast('请先勾选要打包的记录（无图片清单的记录不可选）', 'warn'); return; } // v1.1.105：status 已废，反馈改 toast
        // v1.2.465【用户要求：多选打包后「每个商品一个文件夹，文件夹里的东西和整合包一样」】
        //   逐条复用 buildHistoryPack(h, 商品文件夹名) ⇒ 每个商品一个文件夹，内含
        //   主图/ SKU图/ 详情图/(视频/) + 上架数据包.xlsx + 数据表.xlsx + 评论.xlsx + 商品数据.json + 导入说明.txt
        var items = [], extraB = [], usedFolders = {};
        (async function () {
          for (var ci = 0; ci < chosen.length; ci++) {
            var h = chosen[ci];
            var base = safeFs(String(h.title || h.itemId || '历史')).slice(0, 30) || '历史';
            var fo = base, kk = 2;
            while (usedFolders[fo]) { fo = base + '-' + (kk++); }   // 同名商品去重，避免两个商品混进同一文件夹
            usedFolders[fo] = 1;
            try {
              var built = await buildHistoryPack(h, fo);
              (built.items || []).forEach(function (it) { items.push(it); });
              (built.extra || []).forEach(function (f) { extraB.push(f); });
            } catch (eB) {}
          }
          if (!items.length && !extraB.length) { aisToast('所选记录没有可打包的数据', 'warn'); return; }
          aisToast('开始打包 ' + chosen.length + ' 个商品（每个商品一个文件夹）：' + items.length + ' 张图 + ' + extraB.length + ' 个文件…', 'ok');
          try {
            var r = await sendBg({ action: 'downloadImages', images: items, asZip: true, extraFiles: extraB, nameMode: imgNameMode(), itemTitle: '历史打包_' + chosen.length + '商品' });
            if (r && r.ok) aisToast((r.mode === 'zip' ? '历史 ZIP 已下载：' : '历史已下载：') + r.down + ' 张（失败 ' + (r.failed || 0) + '）', 'ok');
            else aisToast('历史打包失败：' + ((r && r.error) || '未知错误'), 'error');
          } catch (eBB) { aisToast('历史打包失败：' + ((eBB && eBB.message) || eBB), 'error'); }
        })();
      });
      var mi = el.querySelector('#aisimg-hismember');
      if (mi) mi.addEventListener('click', showMemberInfoModal);
      var c = el.querySelector('#aisimg-hisclear');
      if (c) c.addEventListener('click', function () { storeSet({ aisImgHistory: [] }).then(renderHistory); });
      // v1.1.69：单条「图打包」（会员功能）
      el.querySelectorAll('.aisimg-hisact[data-imgact]').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!requireHisPack('图片打包下载（ZIP）')) return;
          var h2 = list.filter(function (x) { return String(x.ts) === String(b.getAttribute('data-imgact')); })[0];
          if (!h2) return;
          if (!h2.images || !h2.images.length) { aisToast('该记录未保存图片清单', 'warn'); return; }
          var folder = safeFs(String(h2.title || h2.itemId || '历史')).slice(0, 30) || '历史';
          var seen2 = {}, items = [];
          (h2.images || []).forEach(function (u) { if (!u || seen2[u]) return; seen2[u] = 1; items.push({ url: u, type: 'main', folder: folder, format: 'original', quality: 92, scale: 1 }); });
          if (!items.length) { aisToast('该记录没有图片', 'warn'); return; }
          // v1.2.431【用户反馈：下过来只有图片没有 SKU】—— 单条图打包一并带上该记录的 SKU 规格表
          var extra1 = [], BOM1 = String.fromCharCode(65279);
          try {
            var sk1 = h2.skuRows || [];
            if (sk1.length) {
              extra1.push({ name: 'SKU明细.csv', base64: b64Utf8(BOM1 + skuCsvFromRows(sk1, h2.title, h2.itemId, '')) });
              if (aisSel('common.packLeanFiles', 'on') !== 'off') { /* v1.2.448 精简：不产 SKU明细.json */ } else { extra1.push({ name: 'SKU明细.json', base64: b64Utf8(JSON.stringify(sk1, null, 2)) }); }
              try {
                var skWb = await exportStyledWorkbook(skuExportSheets(sk1, h2.title, h2.itemId, ''), folder + '_SKU.xlsx');
                extra1.push({ name: folder + '_SKU.xlsx', base64: skWb });
              } catch (eWb) {}
            }
          } catch (eX2) {}
          aisToast('开始打包「' + (h2.title || '历史商品').slice(0, 24) + '」图片 ' + items.length + ' 张' + (extra1.length ? ' + ' + extra1.length + ' 个 SKU 文件' : '（该记录无 SKU）') + '…', 'ok');
          sendBg({ action: 'downloadImages', images: items, asZip: true, extraFiles: extra1, nameMode: imgNameMode(), itemTitle: String(h2.title || '历史商品').slice(0, 40) }).then(function (r) {
            if (r && r.ok) aisToast('图片 ZIP 已下载：' + r.down + ' 张（失败 ' + (r.failed || 0) + '）', 'ok');
            else aisToast('图片打包失败：' + ((r && r.error) || '未知错误'), 'error');
          });
        });
      });
      // v1.1.69：单条「评打包」（会员功能，Excel 导出）
      el.querySelectorAll('.aisimg-hisact[data-revact]').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!requireHisPack('评论打包下载')) return;
          var h2 = list.filter(function (x) { return String(x.ts) === String(b.getAttribute('data-revact')); })[0];
          if (!h2) return;
          var revs = h2.reviews || [];
          var wl = h2.wdj || []; // v1.2.224：历史里若存了问答投影，一并打包成两张表
          if (!revs.length && !wl.length) { aisToast('该记录未保存评论数据（v1.1.69 起新采集的商品自动保存）', 'warn'); return; }
          b.disabled = true; b.textContent = '打包中…';
          try {
            var rows = revToRows(revs, []);
            var tb = /(?:taobao|tmall)\.com/.test(h2.url || location.href || '');
            var nm = String(h2.title || '历史商品').slice(0, 40);
            var sheets = { '评论': { headers: revOrderedCols(rows, tb), rows: rows } };
            if (wl.length) {
              var wMeta = { title: h2.title, itemId: h2.itemId, at: h2.ts };
              var wq2 = wdjToRows(wl, wMeta), wa2 = wdjAnswerRows(wl, wMeta);
              sheets['问大家'] = { headers: unionRowKeys(wq2), rows: wq2 };
              sheets['问大家-回答明细'] = { headers: unionRowKeys(wa2), rows: wa2 };
            }
            var b64 = await exportStyledWorkbook(sheets, nm + '_评论.xlsx');
            var r3 = await sendBg({ action: 'downloadData', base64: b64, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: nm + '_评论.xlsx' });
            if (r3 && r3.ok) aisToast('评论已打包下载：' + (r3.fileName || nm + '_评论.xlsx'), 'ok');
            else aisToast('评论打包失败：' + ((r3 && r3.error) || '未知错误'), 'error');
          } catch (e9) { aisToast('评论打包失败：' + (e9 && e9.message || e9), 'error'); }
          b.disabled = false; b.textContent = __hkLock + '评打包';
        });
      });
      // v1.2.429：单条「SKU打包」（会员功能，Excel 导出 SKU 规格表）
      el.querySelectorAll('.aisimg-hisact[data-skuact]').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!requireHisPack('SKU 打包下载')) return;
          var h3 = list.filter(function (x) { return String(x.ts) === String(b.getAttribute('data-skuact')); })[0];
          if (!h3) return;
          var rows = h3.skuRows || [];
          if (!rows.length) { aisToast('该记录未保存 SKU 数据（本条版本起新采集的商品会自动保存）', 'warn'); return; }
          b.disabled = true; b.textContent = '打包中…';
          try {
            var nm = String(h3.title || '历史商品').slice(0, 40);
            // v1.2.469：与面板 / 整合包走**同一套动态维度列**（原来用 unionRowKeys 原始键 ⇒ 会带出「行号」「规格」等 ✗）
            var sheets = skuExportSheets(rows, h3.title, h3.itemId, h3.url || '');
            var b64s = await exportStyledWorkbook(sheets, nm + '_SKU.xlsx');
            var r4 = await sendBg({ action: 'downloadData', base64: b64s, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: nm + '_SKU.xlsx' });
            if (r4 && r4.ok) aisToast('SKU 已打包下载：' + (r4.fileName || nm + '_SKU.xlsx'), 'ok');
            else aisToast('SKU 打包失败：' + ((r4 && r4.error) || '未知错误'), 'error');
          } catch (eS) { aisToast('SKU 打包失败：' + ((eS && eS.message) || eS), 'error'); }
          b.disabled = false; b.textContent = __hkLock + 'SKU打包';
        });
      });
      // v1.2.458【用户要求：三个按钮改成一键包】单条「一键包」= 图打包 + 评打包 + SKU打包 合成一个 ZIP
      el.querySelectorAll('.aisimg-hisact[data-packact]').forEach(function (b) {
        b.addEventListener('click', async function () {
          if (!requireHisPack('整合包（图片 + 表格）')) return;
          var hp = list.filter(function (x) { return String(x.ts) === String(b.getAttribute('data-packact')); })[0];
          if (!hp) return;
          if (!(hp.images || []).length && !(hp.skuRows || []).length && !(hp.reviews || []).length) { aisToast('该记录没有可打包的数据', 'warn'); return; }
          b.disabled = true; b.textContent = '打包中…';
          try {
            var built = await buildHistoryPack(hp);
            progShow('整合包 · ' + built.items.length + ' 张');
            progSet(0, built.items.length, '正在抓取图片…');
            aisToast('整合包开始打包：' + built.items.length + ' 张图 + ' + built.extra.length + ' 个文件', 'info');
            var r = await sendBg({ action: 'downloadImages', images: built.items, asZip: true, extraFiles: built.extra, nameMode: imgNameMode(), itemTitle: hp.title, itemId: String(hp.itemId || '') + '_整合包' });
            if (r && r.ok) {
              progSet(built.items.length, built.items.length, '已完成'); progHide(2000);
              aisToast('整合包已下载：' + r.down + ' 张图 + ' + built.extra.length + ' 个文件' + (r.fileName ? '（' + r.fileName + '）' : ''), r.failed ? 'warn' : 'info');
              if (r.downloadId != null) showOpenFolder(r.downloadId);
            } else {
              progSet(0, built.items.length, '失败'); progHide(3000);
              aisToast('整合包失败：' + ((r && r.error) || '未知错误'), 'error');
            }
          } catch (ePk) { aisToast('整合包失败：' + ((ePk && ePk.message) || ePk), 'error'); }
          b.disabled = false; b.textContent = __hkLock + '整合包';
        });
      });
    });
  }
  // v1.2.463：分类函数已移到 lib/image-parser.js（classifyHistoryImages）以便单测；这里取同一份实现
  function classifyHistoryImages(images, skuRows) {
    try {
      var P = window.__AIS_IMG_PARSER__;
      if (P && P.classifyHistoryImages) return P.classifyHistoryImages(images, skuRows);
    } catch (e) {}
    return (images || []).map(function (u, i) { return i === 0 ? 'main' : 'desc'; });
  }
  // v1.2.458 历史「一键包」/ v1.2.462 改名「整合包」：一个 ZIP = 图片（按分类分目录）+ 上架数据包.xlsx + 数据表.xlsx
  //   + 评论.xlsx + 商品数据.json + 导入说明.txt（与面板「整合包」文件集/目录结构一致）
  //   数据全部取自历史记录（含 v1.2.458 起补存的 itemProps / sizeChart / imgSplit）；老记录没有分类信息时，
  //   图片放在以商品名命名的目录里（与旧「图打包」一致，不丢图）。
  async function buildHistoryPack(h, prefix) {
    // v1.2.465：prefix = 商品文件夹名（批量打包时「每个商品一个文件夹」，单条打包传空）——
    //   图片落到 `<商品>/主图|SKU图|详情图|视频/`，额外文件落到 `<商品>/上架数据包.xlsx` 等，与整合包内部结构一致。
    var pre = prefix ? (String(prefix).replace(/\/+$/, '') + '/') : '';
    var NL = String.fromCharCode(10);
    var LAB;
    try { LAB = { main: TYPE_LABEL.main, sku: TYPE_LABEL.sku, desc: TYPE_LABEL.desc, video: TYPE_LABEL.video }; }
    catch (eL) { LAB = { main: '主图', sku: 'SKU图', desc: '详情图', video: '视频' }; }
    var sp = h.imgSplit || null;
    // v1.2.463：老记录没有 imgSplit → 用 URL 归属反推分类（保证导出目录与整合包一致：主图/ SKU图/ 详情图/ 视频）
    var kinds = sp ? null : classifyHistoryImages(h.images || [], h.skuRows || []);
    var seen = {}, items = [], mainArr = [], skuArr = [], descArr = [], vidArr = [];
    (h.images || []).forEach(function (u, i) {
      if (!u) return;
      var type = 'main', folder = LAB.main;
      if (sp) {
        var m1 = sp.main || 0, m2 = m1 + (sp.sku || 0), m3 = m2 + (sp.desc || 0);
        if (i < m1) { type = 'main'; folder = LAB.main; }
        else if (i < m2) { type = 'sku'; folder = LAB.sku; }
        else if (i < m3) { type = 'desc'; folder = LAB.desc; }
        else { type = 'video'; folder = LAB.video; }
      } else {
        var kd = (kinds && kinds[i]) || 'desc';
        type = kd;
        folder = LAB[kd] || LAB.desc;
      }
      if (type === 'main' && mainArr.length < 5) mainArr.push(u);
      if (type === 'sku') skuArr.push(u);
      if (type === 'desc') descArr.push(u);
      if (type === 'video') vidArr.push(u);
      if (seen[u]) return;              // 同一张图只落一份（分类按原始顺序判定，不受去重影响）
      seen[u] = 1;
      items.push({ url: u, type: type, folder: pre + folder, name: '', format: 'original', quality: 92, scale: 1 });
    });
    var manifest = buildImageManifest(items);
    var D = { title: h.title, itemId: h.itemId, url: h.url, main: mainArr, sku: skuArr, desc: descArr, videos: vidArr, itemProps: h.itemProps || [], skuRows: h.skuRows || [], skuPropNames: h.skuProps || [] };
    var extra = [];
    try { extra.push({ name: '上架数据包.xlsx', base64: await buildListingWorkbookBase64(manifest, D) }); } catch (e1) {}
    try { extra.push({ name: '数据表.xlsx', base64: await exportStyledWorkbook(skuExportSheets(h.skuRows || [], h.title, h.itemId, h.url, true, h.itemProps || [], h.sizeChart || []), '数据表.xlsx') }); } catch (e2) {}
    if ((h.reviews || []).length) {
      try {
        var rrows = revToRows(h.reviews, []);
        extra.push({ name: '评论.xlsx', base64: await exportStyledWorkbook({ '评论': { headers: revOrderedCols(rrows, /(?:taobao|tmall)\.com/.test(h.url || '')), rows: rrows } }, '评论.xlsx') });
      } catch (e3) {}
    }
    try {
      extra.push({ name: '商品数据.json', base64: b64Utf8(JSON.stringify({
        exportTime: new Date().toISOString(),
        basic: { 标题: h.title || '', 商品ID: h.itemId || '', 链接: h.url || '', 采集时间: h.ts ? new Date(h.ts).toISOString() : '' },
        counts: { 图片: (h.images || []).length, SKU: (h.skuRows || []).length, 评论: (h.reviews || []).length, 问大家: (h.wdj || []).length, 参数: (h.itemProps || []).length, 尺码表行: (h.sizeChart || []).length },
        images: h.images || [], skuRows: h.skuRows || [], itemProps: h.itemProps || [], sizeChart: h.sizeChart || [], reviews: h.reviews || [], wdj: h.wdj || [], imageManifest: manifest
      }, null, 2)) });
    } catch (e4) {}
    try {
      extra.push({ name: '导入说明.txt', base64: b64Utf8([
        '整合包内容说明（采集历史）',
        '',
        '上架数据包.xlsx  —— 4 张表：商品信息 / SKU明细 / 图片清单 / 导入说明（ERP「自定义导入」逐列对应）',
        '数据表.xlsx      —— SKU / 商品参数 / 尺码表（与面板「导出」同一口径）',
        '评论.xlsx        —— 评论明细（该记录采集过评论时才有）',
        '商品数据.json   —— 该记录的完整数据（图片/SKU/参数/尺码/评论/问大家）',
        '主图/ SKU图/ 详情图/ 视频/  —— 图片按分类分目录，文件名＝原图名（老记录没存分类信息时按 URL 归属反推：'
          + '出现在 SKU 图列里的归 SKU图/、视频后缀归 视频/、首个 SKU 图之前归 主图/、其余归 详情图/）',
        '',
        '注意：叶子类目、物流模板、宝贝描述模板需在 ERP / 平台内补齐。'
      ].join(NL)) });
    } catch (e5) {}
    // v1.2.465：批量打包时额外文件同样放进商品文件夹（文件夹里就是整合包那一套）
    if (pre) extra = extra.map(function (f) { try { f.name = pre + f.name; } catch (eN) {} return f; });
    return { items: items, extra: extra };
  }

  // v1.2.387：规格值深取 —— 【规则开关 common.skuValDeep，默认 off = 商店版行为】
  // 真机：.valueItem-- 内部含【标题+副标题】多个子节点，直接取 textContent 会拼成
  // "黑色白色千人加购蓝色" / "华为 Pura X Max华为 Pura X MAX 典藏版"；色卡图也在子节点里。
  function __skuDeepOn() { try { return aisSel('common.skuValDeep', 'off') !== 'off'; } catch (e) { return false; } }
  function __skuValTextG(el) {
    var raw = String((el && (el.getAttribute('title') || el.textContent)) || '').trim();
    if (!__skuDeepOn()) return raw;
    try {
      var t = el.querySelector(aisSel('tb.propValText', '[class*=valueItemText], [class*=valueText], [class*=skuValueText]'));
      var own = t ? String(t.textContent || '').trim() : '';
      if (own) return own;
    } catch (e1) {}
    return raw;
  }
  function __skuValImgG(el) {
    // v1.2.406【致命修复】：此处原为 __skuValImgG(el) —— **无限递归调用自己**，
    // 栈溢出被 domSkuFallback 外层 try 吞掉 → 整个 DOM 兜底中断 → state.skuRows 恒为空。
    // 真机症状：淘宝/天猫「SKU图/SKU 规格全空」（1688 走 API 路径所以不受影响）。
    // 正确语义：先用归一化取图函数 skuValImg()，失败再走深取（valueItemImg / 背景图）。
    var u = skuValImg(el);
    if (u || !__skuDeepOn()) return u;
    try {
      var cand = el.querySelector(aisSel('tb.propValImg', 'img[class*=valueItemImg], [class*=valueItemImg] img, [class*=valueItemImgWrap] img, [class*=skuValueImg] img, img[src]'));
      if (cand) { var u2 = skuValImg(cand); if (u2) return u2; }
      var wrap = el.querySelector(aisSel('tb.propValImgWrap', '[class*=valueItemImgWrap], [class*=ImgWrap]'));
      if (wrap) { var bg = (getComputedStyle(wrap).backgroundImage || ''); var m = bg.match(/url\(["']?([^"')]+)/); if (m && m[1]) { var u3 = skuValImg({ getAttribute: function () { return m[1]; } }); if (u3) return u3; } }
    } catch (e2) {}
    return '';
  }
  // v1.2.410【根因修复】：嵌套层级被重复命中 —— 真机天猫实测（866913444912）：
  //   同一个维度被三层同时匹配（skuWrapper ⊃ skuItem ⊃ skuItemClipX），值也被五层同时匹配
  //   （skuValueWrap ⊃ valueItem ⊃ valueItemImgWrap ⊃ valueItemImg ⊃ valueItemText）。
  //   后者把「整组拼起来的容器文本」当成一个值 → 规格值混乱；前者把同一维度算 3 次 → combos 爆炸。
  //   之前几轮反复调选择器治不了嵌套，这次改为【结构化取最内层】：命中集合里，凡是内部还包含
  //   另一个命中节点的，一律丢弃。可用 common.skuLeafOnly=off 远程关闭。
  function __aisLeafOnly(list) {
    var arr = [].slice.call(list || []);
    // 项目规则：新行为必须【默认关闭 = 商店基线 v1.2.371 行为】，验证通过后在服务器开 on。
    if (String(aisSel('common.skuLeafOnly', 'off')) !== 'on') return arr;
    try {
      return arr.filter(function (el) {
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] !== el) { try { if (el.contains && el.contains(arr[i])) return false; } catch (eC) {} }
        }
        return true;
      });
    } catch (eL) { return arr; }
  }
  function domSkuFallback() {
    try {
      var dims = [];
      // v1.2.267：SKU 规格规则改走注册表（选择器/上限/命名 均可远程覆盖）
      var skuMaxLen = aisNum('common.skuValueMaxLen', 30);
      var skuGroupMax = aisNum('common.skuGroupMax', 4);
      var skuFallback = aisSel('common.skuNameFallback', '规格');
      var groups = __aisLeafOnly(document.querySelectorAll(aisSel('common.skuGroupAny', '.sku-item-wrapper, .sku-item, .tm-sale-prop, .tb-prop, [class*=skuItem], [class*=sale-prop]')));
      for (var gi = 0; gi < groups.length && dims.length < skuGroupMax; gi++) {
        var g = groups[gi];
        var nameEl = g.querySelector(aisSel('common.skuTitleAny', '[class*=title], .tb-property-type, .tm-propTit'));
        var name = nameEl ? String(nameEl.textContent || "").replace(/[:：]+$/, "").trim() : "";
        var vals = [], seen = {};
        var vn = __aisLeafOnly(g.querySelectorAll(aisSel('tb.propVal', '[data-value-id]')));   // v1.2.410：只取最内层值节点（容器文本不再当值）
        for (var vi = 0; vi < vn.length; vi++) {
          var el = vn[vi];
          var txt = __skuValTextG(el);
          if (!txt || seen[txt]) continue;
          seen[txt] = 1;
          var u = skuValImg(el);   // v1.2.262：统一归一化（此前 abs() 会留下京东 s48x48...jpg.avif 小图）
          // v1.2.411：取「最内层」后叶子文本节点通常【自身没有图】（图挂在祖先容器上，如 valueItem），
          // 真机天猫 866913444912 实测：rows 出了但 rowsImg=0。这里向上最多 5 层找一次图片。
          if (!u) {
            try {
              // v1.2.412【修正 v1.2.411 的副作用】：原实现无脑向上 5 层，会走到【公共容器】
              // （skuValueWrap 等），那里的图对所有值都一样 → 真机实测 12 行只剩 2 张唯一图。
              // 现在：祖先文本若已明显长于本值（= 拼进了别的值）即判定到达公共层，立刻停止。
              var __p = el.parentElement;
              var __vt = String(txt || '').replace(/\s+/g, '');
              for (var __lv = 0; __lv < 5 && __p && !u; __lv++) {
                var __pt = String(__p.textContent || '').replace(/\s+/g, '');
                if (__pt.length > __vt.length * 1.6 + 8) break;   // 已含别的值 → 公共容器，停
                u = skuValImg(__p);
                __p = __p.parentElement;
              }
            } catch (eUp) {}
          }
          vals.push({ name: txt, image: u });
        }
        if (!vals.length) {
          var vn2 = g.querySelectorAll(aisSel('common.skuValueAny', 'li, span[class*=value], a'));
          for (var vi2 = 0; vi2 < vn2.length; vi2++) {
            var el2 = vn2[vi2];
            var txt2 = __skuValTextG(el2);
            if (!txt2 || txt2.length > skuMaxLen || seen[txt2]) continue;
            seen[txt2] = 1;
            var u2 = __skuValImgG(el2);   // v1.2.262：统一归一化
            vals.push({ name: txt2, image: u2 });
          }
        }
        // v1.2.387：值自洽过滤（仅 skuValDeep 开时）——真机：容器元素被当成一个值，
        // textContent 会把整组选项拼起来（"套餐一 3.5插头不带麦版套餐二 3.5插头带麦版…"）。
        // 判据：某值长度 ≥ 其余值中位数 ×1.8 且 ≥12 字 → 视为容器，丢弃。
        if (__skuDeepOn() && vals.length >= 2) {
          var __lens = vals.map(function (v) { return v.name.length; }).sort(function (a, b) { return a - b; });
          var __med = __lens[Math.floor(__lens.length / 2)] || 0;
          var __cap = Math.max(12, Math.round(__med * 1.8));
          vals = vals.filter(function (v) { return v.name.length <= __cap; });
        }
        if (vals.length) dims.push({ name: name || skuFallback + (dims.length + 1), values: vals });
      }
      // v1.1.168：京东新版规格（.specification-item-sku/page-right-spec），旧类名不命中时的语义兜底
      if (!dims.length && /jd\.com|3\.cn/.test(location.href)) {
        var jdSpecs = document.querySelectorAll(aisSel('jd.skuItem', ".specification-item-sku"));
        var jdGroups = {}, jdOrder = [];
        for (var ji = 0; ji < jdSpecs.length; ji++) {
          var jsEl = jdSpecs[ji];
          var jp = jsEl.parentElement;
          var jTitle = "";
          if (jp) { var jt = jp.querySelector(aisSel('jd.skuTitle', '[class*="title"], [class*="Title"]')); if (jt) jTitle = String(jt.textContent || "").trim(); }
          var jKey = (jp ? jp.className : "") + "|" + jTitle;
          if (!jdGroups[jKey]) { jdGroups[jKey] = { name: jTitle || "规格" + (jdOrder.length + 1), values: [], _seen: {} }; jdOrder.push(jdGroups[jKey]); }
          var jTxt = String(jsEl.textContent || "").trim();
          if (!jTxt || jdGroups[jKey]._seen[jTxt]) continue;
          jdGroups[jKey]._seen[jTxt] = 1;
          // v1.2.262：改走 skuValImg（jdImgUp → /jfs/ 原图 800x800 + 剔超小图）。
          // 此前这里只做 abs()，规格图会以 s48x48_jfs/...jpg.avif 原始小图入库（用户实测来源）。
          var jU = skuValImg(jsEl);
          jdGroups[jKey].values.push({ name: jTxt, image: jU });
        }
        // 兜底2：类名失效时读 ld+json（schema.org Product offers，跨改版最稳）
        if (!jdOrder.length) {
          var lds = document.querySelectorAll(aisSel('common.skuLdJson', 'script[type="application/ld+json"]'));
          for (var li = 0; li < lds.length; li++) {
            try {
              var ld = JSON.parse(lds[li].textContent || "{}");
              var prod = ld && (ld["@type"] === "Product" ? ld : (ld.mainEntity && ld.mainEntity["@type"] === "Product" ? ld.mainEntity : null));
              if (!prod || !prod.offers) continue;
              var offs = Array.isArray(prod.offers) ? prod.offers : (prod.offers.offers || [prod.offers]);
              var vals = [];
              for (var oi = 0; oi < offs.length && vals.length < 60; oi++) {
                var nm = (offs[oi] && (offs[oi].name || offs[oi].skuName)) || "";
                if (!nm) continue;
                var uo = offs[oi].image || "";
                vals.push({ name: String(nm), image: typeof uo === "string" ? uo : "" });
              }
              if (vals.length >= aisNum('common.skuLdMinValues', 2)) { jdOrder.push({ name: aisSel('common.skuNameFallback', '规格'), values: vals }); break; }
            } catch (eLd) {}
          }
        }
        for (var di = 0; di < jdOrder.length && dims.length < 4; di++) {
          if (jdOrder[di].values.length) dims.push(jdOrder[di]);
        }
      }
      // v1.2.387：维度去重（仅 skuValDeep 开时）——嵌套容器会产生值集相同/互相包含的两个维度，
      // 组合后会显示成 "黑色 / 黑色"。按归一化值集去重，并丢弃被包含的维度。
      if (__skuDeepOn() && dims.length > 1) {
        var __nz2 = function (x) { return String(x || '').replace(/[\s\u3000\u200b-\u200f\ufeff\u00a0]+/g, '').toLowerCase(); };
        var __sets = dims.map(function (d) { return (d.values || []).map(function (v) { return __nz2(v.name); }).filter(Boolean); });
        var __keep = [];
        dims.forEach(function (d, i) {
          var a = __sets[i]; if (!a.length) return;
          for (var j = 0; j < __sets.length; j++) {
            if (j === i) continue;
            var b = __sets[j]; if (!b.length) continue;
            var aInB = a.every(function (x) { return b.indexOf(x) >= 0; });
            if (aInB && a.length < b.length) return;
            if (aInB && a.length === b.length && j < i) return;
          }
          __keep.push(d);
        });
        dims = __keep;
      }
      if (!dims.length) return;
      state.skuPropNames = dims.map(function (d) { return d.name; });
      var combos = [{ vals: [], imgs: [] }];
      dims.slice(0, 2).forEach(function (d) {
        var next = [];
        combos.forEach(function (c) {
          for (var k = 0; k < d.values.length && next.length < 100; k++) {
            next.push({ vals: c.vals.concat([d.values[k].name]), imgs: c.imgs.concat([d.values[k].image]) });
          }
        });
        combos = next;
      });
      var info = { title: state.itemTitle || "", itemId: state.itemId || "", url: location.href };
      state.skuRows = combos.map(function (c, i) {
        var row = { 序号: i + 1, 商品标题: info.title, 商品ID: info.itemId, 商品链接: info.url, 规格: c.vals.join(" / ") };
        state.skuPropNames.forEach(function (pn, k2) { row[pn] = c.vals[k2] || ""; });
        var img2 = "";
        c.imgs.forEach(function (u3) { if (u3) img2 = u3; });
        if (img2) row["SKU图"] = img2;
        return row;
      });
    } catch (e) {}
  }
  function itemPropsDom(){
    try {
      var out = [], seen = {};
      var put = function (n, v) {
        if (out.length >= 80) return;
        n = String(n || "").replace(/\s+/g, " ").trim();
        v = String(v || "").replace(/^[:：\s]+|[:：\s]+$/g, "").replace(/\s+/g, " ").trim();
        if (!n || !v || n === v || n.length > 24 || v.length > 90) return;
        var k2 = n + "|" + v;
        if (seen[k2]) return;
        seen[k2] = 1;
        out.push({ name: n, value: v });
      };
      // v1.1.164：淘宝/天猫新版详情页参数条目（哈希类名，线上 page DOM 实测）
      // 通用参数 generalParamsInfoItem：Title=参数名，SubTitle=参数值
      document.querySelectorAll('[class*="generalParamsInfoItem"]').forEach(function (it) {
        var tn = it.querySelector('[class*="ItemTitle"]');
        var tv = it.querySelector('[class*="ItemSubTitle"]');
        if (tn && tv) put(tn.textContent, tv.textContent);
      });
      // 重点参数 emphasisParamsInfoItem：Title=参数值，SubTitle=参数名（设计上值突出在前，取值相反）
      document.querySelectorAll('[class*="emphasisParamsInfoItem"]').forEach(function (it) {
        var tn = it.querySelector('[class*="ItemTitle"]');
        var tv = it.querySelector('[class*="ItemSubTitle"]');
        if (tn && tv) put(tv.textContent, tn.textContent);
      });
      // v1.1.164：新版哈希条目已命中≥3时跳过通用选择器（避免哈希页噪声反向条目）
      if (out.length < 3) {
      // v1.1.162：参数信息直接采集——① 参数表 dl(dt/dd，京东 Ptable 等) ② 属性/参数 li ③ 参数表格行
      document.querySelectorAll("[class*=Ptable] dl, [id*=Ptable] dl, [class*=p-table] dl").forEach(function (dl) {
        var dt = dl.querySelector("dt"), dd = dl.querySelector("dd");
        if (dt && dd) put(dt.textContent, dd.textContent);
      });
      var els = document.querySelectorAll("#J_AttrList li, [class*=attrList] li, [class*=attribute] li, [class*=AttrList] li, [class*=soldParams] li, [class*=sold-params] li, .attrs li, #attributes li, [class*=parameter] li, [class*=param] td, [class*=param] li");
      for (var i = 0; i < els.length && out.length < 80; i++) {
        var t = String(els[i].textContent || "").replace(/\s+/g, " ").trim();
        if (!t || t.length > 80) continue;
        var m = t.match(/^([^.]{1,24}?)[：:]\s*(.+)$/);
        if (!m) {
          var nn = els[i].querySelector("[class*=name], [class*=label], b, .gray");
          var vv = els[i].querySelector("[class*=value], [class*=val], span:last-child, dd");
          if (!nn || !vv) continue;
          var tn = String(nn.textContent || "").trim();
          var tv = String(vv.textContent || "").trim();
          if (!tn || !tv || tn === tv) continue;
          m = [tn, tn, tv];
        }
        put(m[1], m[2]);
      }
      document.querySelectorAll("[class*=param] tr, [class*=attr] tr, [id*=Ptable] tr").forEach(function (tr) {
        var cs2 = tr.querySelectorAll("th,td");
        if (cs2.length >= 2) put(cs2[0].textContent, cs2[cs2.length - 1].textContent);
      });
      }
      if (out.length) state.itemProps = out;
    } catch (e) {}
  }

  // v1.1.163：参数信息页签懒加载兜底——详情页标签栏点「参数信息」展开后再采集（每页一次，采完切回原页签）
  function propsTabAutoOpen() {
    try {
      if (window.__AIS_PROPS_OPENED__) return;
      var els = document.querySelectorAll('a, span, li, div, [class*="tab"] [class*="item"], [class*="Tab"] [class*="item"]');
      var hit = null;
      for (var i = 0; i < els.length && i < 900; i++) {
        var el = els[i];
        if (!el.offsetParent) continue;
        var s = String(el.textContent || '').replace(/\s+/g, '').trim();
        if (s && s.length <= 6 && /^(参数信息|规格参数|商品参数|产品参数|参数)$/.test(s)) { hit = el; break; }
      }
      if (!hit) return;
      window.__AIS_PROPS_OPENED__ = 1;
      var active = null;
      try {
        var cand = document.querySelectorAll('[class*="active"]');
        for (var j = 0; j < cand.length && j < 300; j++) {
          var ts = String(cand[j].textContent || '').replace(/\s+/g, '').trim();
          if (ts && ts.length <= 6 && /^(用户评价|图文详情|尺码信息|本店推荐|看了又看|详情)/.test(ts)) { active = cand[j]; break; }
        }
      } catch (e0) {}
      hit.click();
      setTimeout(function () {
        try { itemPropsDom(); render(); } catch (e2) {}
        setTimeout(function () { try { if (active) active.click(); } catch (e3) {} }, 900);
      }, 1200);
    } catch (e) {}
  }

  // v1.1.148：尺码表采集（DOM 兜底——表头含尺码/身高/胸围等关键字的表格，最多31行）
  function sizeChartDom() {
    try {
      if (state.sizeChart && state.sizeChart.length) return;
      var tables = document.querySelectorAll('table');
      for (var i = 0; i < tables.length && i < 80; i++) {
        var t = tables[i];
        var head = [];
        t.querySelectorAll('tr:first-child th, tr:first-child td').forEach(function (c) { head.push(String(c.textContent || '').replace(/\s+/g, ' ').trim()); });
        if (head.length < 2) continue;
        var j = head.join('|');
        if (!/尺码|身高|体重|胸围|腰围|肩宽|鞋码|型号/.test(j)) continue;
        var rows = [];
        t.querySelectorAll('tr').forEach(function (tr) {
          if (rows.length >= 31) return;
          var cells = [];
          tr.querySelectorAll('th,td').forEach(function (c) { cells.push(String(c.textContent || '').replace(/\s+/g, ' ').trim()); });
          if (cells.length > 1) rows.push(cells);
        });
        if (rows.length >= 2) { state.sizeChart = rows; break; }
      }
      // v1.1.149：无 <table> 时按视觉网格解析（新版淘宝尺码表为 div 网格，实测 0 个 table）
      if (!state.sizeChart.length) {
        var boxes = document.querySelectorAll('[class*="size"],[class*="Size"],[class*="chima"],[class*="table"],[class*="Table"],[class*="prop"]');
        for (var b = 0; b < boxes.length && b < 120; b++) {
          var box = boxes[b];
          if (box.offsetWidth < 220 || box.offsetHeight < 80) continue;
          if (!/尺码|身高|体重|胸围|腰围|肩宽|鞋码|型号/.test(String(box.textContent || ''))) continue;
          var grid = gridRows(box);
          if (grid && grid.length >= 2) { state.sizeChart = grid; break; }
        }
      }
    } catch (e) {}
  }
  // v1.1.149：容器内叶子单元格按 offsetTop 分行、offsetLeft 排序成表格（有界：400格/31行）
  function gridRows(box) {
    try {
      var cells = [];
      box.querySelectorAll('*').forEach(function (el) {
        if (cells.length > 400 || el.children.length !== 0) return;
        var s = String(el.textContent || '').replace(/\s+/g, ' ').trim();
        if (s && s.length <= 12 && el.offsetWidth > 18 && el.offsetHeight > 10) cells.push(el);
      });
      if (cells.length < 4) return null;
      var rowsMap = {}, ys = [];
      cells.forEach(function (el) {
        var y = Math.round(el.getBoundingClientRect().top / 8) * 8;
        if (!rowsMap[y]) { rowsMap[y] = []; ys.push(y); }
        rowsMap[y].push(el);
      });
      ys.sort(function (a, b2) { return a - b2; });
      var rows = [];
      ys.forEach(function (y) {
        var row = rowsMap[y].map(function (el) { return { x: el.getBoundingClientRect().left, t: String(el.textContent || '').replace(/\s+/g, ' ').trim() }; })
          .sort(function (a, b2) { return a.x - b2.x; }).map(function (o) { return o.t; });
        if (row.length >= 2) rows.push(row);
      });
      if (!rows.length) return null;
      var kw = /尺码|身高|体重|胸围|腰围|肩宽|鞋码|型号/;
      var hi = -1;
      for (var i = 0; i < rows.length; i++) { if (kw.test(rows[i].join('|'))) { hi = i; break; } }
      if (hi < 0) return null;
      return rows.slice(hi, hi + 31);
    } catch (e) { return null; }
  }
  // v1.1.149：自动点开尺码表弹层（每页仅一次、1秒后复扫、随后关弹层——有界收敛）
  function sizeChartAutoOpen() {
    try {
      if (window.__AIS_SIZE_OPENED__) return;
      var hit = null;
      var els = document.querySelectorAll('[class*="sku"] a, [class*="sku"] span, [class*="value"] a, [class*="action"] a, a, span');
      for (var i = 0; i < els.length && i < 600; i++) {
        var s = String(els[i].textContent || '').replace(/\s+/g, '').trim();
        if (s && s.length <= 8 && /尺码表|尺寸表|查看尺码|尺码说明/.test(s)) { hit = els[i]; break; }
      }
      if (!hit) return;
      window.__AIS_SIZE_OPENED__ = 1;
      hit.click();
      setTimeout(function () {
        try { sizeChartDom(); render(); } catch (e2) {}
        setTimeout(function () {
          try {
            var mask = document.querySelector('[class*="mask"],[class*="overlay"],[class*="close"]');
            if (mask) mask.click();
            else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
          } catch (e3) {}
        }, 600);
      }, 1000);
    } catch (e) {}
  }
  function renderSizeChart() {
    var sc = $('aisimg-sizecard'); if (!sc) return;
    var tb = $('aisimg-sizetable'); if (!tb) return;
    var rows = state.sizeChart || [];
    if (!rows.length) { sc.style.display = 'none'; tb.innerHTML = ''; return; }
    sc.style.display = '';
    var html = '<thead><tr>' + rows[0].map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
    rows.slice(1).forEach(function (r2) { html += '<tr>' + rows[0].map(function (_, ci) { return '<td>' + esc(r2[ci] == null ? '' : r2[ci]) + '</td>'; }).join('') + '</tr>'; });
    tb.innerHTML = html + '</tbody>';
  }
  // v1.1.148：参数/尺码表独立导出（CSV，独立项）
  function csvLn(arr) {
    var Q = String.fromCharCode(34);
    return arr.map(function (v) { return Q + String(v == null ? '' : v).split(Q).join(Q + Q) + Q; }).join(',');
  }
  function exportPropsCsv() {
    var ps = state.itemProps || [];
    if (!ps.length) { status('没有参数数据'); return; }
    var NL = String.fromCharCode(10), BOM = String.fromCharCode(65279);
    var lines = [csvLn(['参数名', '参数值'])];
    ps.forEach(function (p) { lines.push(csvLn([p.name, p.value])); });
    var name = safeFs(state.itemTitle || '商品').slice(0, 40) || '商品';
    sendBg({ action: 'downloadData', base64: b64Utf8(BOM + lines.join(NL)), mime: 'text/csv', filename: name + '_参数.csv' });
    status('参数导出中…');
  }
  function exportSizeCsv() {
    sizeChartDom();
    var rows = state.sizeChart || [];
    if (!rows.length) { status('未采集到尺码表'); return; }
    var NL = String.fromCharCode(10), BOM = String.fromCharCode(65279);
    var name = safeFs(state.itemTitle || '商品').slice(0, 40) || '商品';
    sendBg({ action: 'downloadData', base64: b64Utf8(BOM + rows.map(csvLn).join(NL)), mime: 'text/csv', filename: name + '_尺码表.csv' });
    status('尺码表导出中…');
  }
  function renderProps(){
    var pc = $('aisimg-propcard');
    if (!pc) return;
    var has = state.itemProps && state.itemProps.length;
    pc.style.display = has ? "" : "none";
    if (!has) return;
    var pr = $("aisimg-proprows");
    if (!pr) return;
    var ph = "";
    state.itemProps.forEach(function (p2) { ph += "<div class=aisimg-proprow><b>" + esc(p2.name) + "：</b><span title=" + dqattr(p2.value) + ">" + esc(p2.value) + "</span></div>"; });
    pr.innerHTML = ph;
  }
  function renderSku() {
    var tbl = $('aisimg-skutable'); if (!tbl) return;
    var rows = state.skuRows || [];
    var cnt = $('aisimg-skucnt');
    var gk = (state.skuPropNames && state.skuPropNames[0]) ? state.skuPropNames[0] : null;
    var gcol = (gk && rows.length && Object.keys(rows[0]).indexOf(gk) > -1) ? gk : null;
    var gcount = 0;
    if (gcol) { var last = null; rows.forEach(function (r) { if (r[gcol] !== last) { last = r[gcol]; gcount++; } }); }
    var LQ = String.fromCharCode(8220), RQ = String.fromCharCode(8221);
    if (cnt) cnt.textContent = rows.length ? (gcol ? "已读取 " + rows.length + " 个规格组合 · 按" + LQ + gcol + RQ + "分组，共 " + gcount + " 组" : "已读取 " + rows.length + " 个规格组合") : "";
    try { renderProps(); } catch (eRP) {}
    try { renderSizeChart(); } catch (eRS) { /* v1.2.185：尺码表数据异常不得阻断 SKU 表渲染 */ }
    // v1.1.162：销售属性「维度」区块已按用户要求移除
    if (!rows.length) {
      tbl.innerHTML = '<tr><td class=aisimg-sku-empty>未读取到 SKU 数据</td></tr>';
      return;
    }
    var cols = Object.keys(rows[0]);
    var lastG = null;
    var localN = 0;
    var sN = cols.indexOf("序号");
    var html = "<thead><tr>" + cols.map(function (c) { return "<th>" + esc(c) + "</th>"; }).join("") + "</tr></thead><tbody>";
    rows.slice(0, 200).forEach(function (r) {
      if (gcol && r[gcol] !== lastG) {
        lastG = r[gcol];
        localN = 0;
        var gn = 0; rows.forEach(function (x) { if (x[gcol] === lastG) gn++; });
        html += "<tr class=aisimg-skugroup-row><td colspan=" + cols.length + ">" + esc(lastG || "未分组") + " · " + gn + " 个组合</td></tr>";
      }
      localN++;
      html += "<tr>" + cols.map(function (c, ci) { var v = (ci === sN && gcol) ? localN : r[c]; return "<td title=" + dqattr(v) + ">" + esc(v) + "</td>"; }).join("") + "</tr>";
    });
    tbl.innerHTML = html + "</tbody>";
  }
  function dqattr(v) { return String.fromCharCode(34) + String(v == null ? "" : v).split(String.fromCharCode(34)).join("&quot;") + String.fromCharCode(34); }
  // v1.2.448【下载口径统一】所有 CSV 走同一个单元格转义器：引号转义 + 公式注入防护
  //   （评论正文是买家写的，`=HYPERLINK(...)`/`@SUM(...)` 这类会被 Excel/WPS 当公式执行；
  //    纯数字（含负号/正号，如 -5、+3）不加引号前缀，避免把数字变成文本）
  function csvCell(v) {
    var s = String(v == null ? "" : v);
    if (/^[=@+\-]/.test(s) && !/^[+\-]?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return String.fromCharCode(34) + s.split(String.fromCharCode(34)).join(String.fromCharCode(34) + String.fromCharCode(34)) + String.fromCharCode(34);
  }
  function skuToCsv(rows, cols) {
    var NL = String.fromCharCode(10);
    var q = csvCell;
    return cols.map(q).join(",") + NL + rows.map(function (r) { return cols.map(function (c) { return q(r[c]); }).join(","); }).join(NL);
  }
  // ===== v1.2.453【SKU 导出与电商宝格式一致】=====
  // 依据：用户给的参考文件 `…MXDJ8150_SKU.xlsx`（A1 是「电商宝 · SKU」，即同作者产品电商宝导出）
  //        + 电商宝实现 `D:\工作项目\tb-media-assistant\extracted\lib\export.js buildXlsx()`。
  // 三件事对齐：① 列与列序 ② 三行表头（标题 / 导出时间·条数 / 表头）+ 自动筛选 + 斑马纹 + 列宽规则
  //             ③ 同一工作簿带第二张表「商品参数」。
  var SKU_EXPORT_COLS = ['序号', '商品标题', '商品ID', '商品链接', 'SKU_ID', '商家编码', '规格', '价格', '库存', '颜色', '尺码', 'SKU图'];
  // v1.2.455【与电商宝一致 + 防超长】商品链接归一化：只留「https://<host>/item.htm?id=<商品ID>」，
  //   去掉 mi_id / spm / skuid / pvid / ab_info 等跟踪参数（电商宝参照文件里就是这种干净短链：
  //   `https://item.taobao.com/item.htm?id=848256789441`）。这同时解决了「超长 URL 把单元格撑成几十行」。
  function cleanItemUrl(u, itemId) {
    var s = String(u || '');
    try {
      var m = s.match(/^https?:\/\/([^/?#]+)/i);
      if (!m) return s;
      var host = m[1];
      var id = String(itemId || '').trim();
      if (!/^\d+$/.test(id)) { var mm = s.match(/[?&]id=(\d+)/); id = mm ? mm[1] : ''; }
      if (!id) return s;
      return 'https://' + host + '/item.htm?id=' + id;
    } catch (e) { return s; }
  }
  // v1.2.468【用户要求：多维度商品「每个分类分开做列，不要组合成一列」】
  //   旧：固定 12 列里只有一列「规格」把维度拼成 `颜色:X;尺码:Y`，多维商品的维度（如 存储容量/网络类型/套餐类型/版本类型）全挤在一列 ✗
  //   新：**动态维度列** —— 固定列 + 「从 SKU 行里按出现顺序取到的每个维度各一列」+ 尾部固定列；
  //      维度顺序来自 buildSkuTable 写行键的顺序（= 规格维度顺序），「颜色分类」统一显示为「颜色」；
  //      全空维度不建列（与 v1.2.457 全空列口径一致）；`common.skuKeepEmptyCols=on` 时保留全空列。
  var SKU_FIXED_HEAD = ['序号', '商品标题', '商品ID', '商品链接', 'SKU_ID', '商家编码'];
  var SKU_FIXED_TAIL = ['价格', '库存', 'SKU图'];
  var SKU_NOT_DIM = { '序号': 1, '行号': 1, '商品标题': 1, '商品ID': 1, '商品链接': 1, 'SKU_ID': 1, '商家编码': 1, '规格': 1, '价格': 1, '库存': 1, 'SKU图': 1, 'SKU图URL': 1, 'skuId': 1, 'outerId': 1, 'name': 1, 'price': 1, 'stock': 1, 'available': 1, 'lack': 1 };
  function skuDimCols(rows) {
    var out = [], seen = {};
    // v1.2.468 边界：组合列「规格」的值形如 `名:值;名:值` ⇒ 只有这种才跳过；
    //   若某商品的**维度本身就叫「规格」**（值不是组合形式），必须当维度保留 ✔
    var isComboSpec = function (rowsIn, key) {
      var hit = 0, combo = 0;
      (rowsIn || []).forEach(function (x) {
        var v = String((x || {})[key] == null ? '' : (x || {})[key]).trim();
        if (!v) return;
        hit++;
        if (/[:：].+[;；]/.test(v)) combo++;
      });
      return hit > 0 && combo === hit;
    };
    (rows || []).forEach(function (r) {
      Object.keys(r || {}).forEach(function (k) {
        if (SKU_NOT_DIM[k]) {
          if (k === '规格' && !isComboSpec(rows, k)) { /* 维度就叫「规格」→ 继续当维度处理 */ }
          else return;
        }
        var c = (k === '颜色分类') ? '颜色' : k;
        if (seen[c]) return;
        var hasVal = (rows || []).some(function (x) {
          x = x || {};
          var v = (x[c] != null && x[c] !== '') ? x[c] : ((c === '颜色' && x['颜色分类'] != null) ? x['颜色分类'] : x[k]);
          return String(v == null ? '' : v).trim() !== '';
        });
        if (!hasVal) return;                 // 全空维度不建列
        seen[c] = 1; out.push(c);
      });
    });
    return out;
  }
  function skuColumnsFor(rows) {
    var keepAll = false;
    try { keepAll = aisSel('common.skuKeepEmptyCols', 'off') === 'on'; } catch (eK) {}
    var dims = skuDimCols(rows);
    var cols = SKU_FIXED_HEAD.concat(dims).concat(SKU_FIXED_TAIL);
    if (keepAll) return cols;
    var ALWAYS = { '序号': 1, '商品标题': 1, '商品ID': 1, '商品链接': 1 };
    return cols.filter(function (c) {
      if (ALWAYS[c] || dims.indexOf(c) > -1) return true;
      return (rows || []).some(function (r) { return String(r[c] == null ? '' : r[c]).trim() !== ''; });
    });
  }
  // 投影：固定列 + 每个维度一列（不再输出组合列「规格」）
  // v1.2.454【按分类排序】改为按「第 1 个维度 → 第 2 个维度」分组排序（同组在一起、数字优先），排完重编「序号」。
  function skuSortKeySize(s) {
    var m = String(s || '').match(/^(\d+(?:\.\d+)?)/);
    return m ? parseFloat(m[1]) : 9999;
  }
  function skuExportRowsFrom(rows, title, itemId, url) {
    var dims = skuDimCols(rows);
    var mapped = (rows || []).map(function (r, i) {
      r = r || {};
      var o = {
        '序号': (r['序号'] != null && r['序号'] !== '') ? r['序号'] : (i + 1),
        '商品标题': r['商品标题'] || title || '',
        '商品ID': r['商品ID'] || itemId || '',
        '商品链接': cleanItemUrl(r['商品链接'] || url || '', r['商品ID'] || itemId),
        'SKU_ID': r['SKU_ID'] || '',
        '商家编码': r['商家编码'] || '',
        '价格': r['价格'] || '',
        '库存': r['库存'] || '',
        'SKU图': r['SKU图'] || ''
      };
      dims.forEach(function (c) {
        var v = (r[c] != null && r[c] !== '') ? r[c] : ((c === '颜色' && r['颜色分类'] != null) ? r['颜色分类'] : '');
        o[c] = v;
      });
      return o;
    });
    var d0 = dims[0] || '', d1 = dims[1] || '';
    mapped.sort(function (a, b) {
      if (d0) { var c = String(a[d0] || '').localeCompare(String(b[d0] || ''), 'zh-Hans-CN'); if (c) return c; }
      if (d1) {
        var sa = skuSortKeySize(a[d1]), sb = skuSortKeySize(b[d1]);
        if (sa !== sb) return sa - sb;
        var c2 = String(a[d1] || '').localeCompare(String(b[d1] || ''), 'zh-Hans-CN');
        if (c2) return c2;
      }
      return 0;
    });
    mapped.forEach(function (r, i) { r['序号'] = i + 1; });   // 按维度排完重编号
    return mapped;
  }
  function exportStamp(n) { return '导出时间：' + new Date().toLocaleString('zh-CN', { hour12: false }) + '　共 ' + n + ' 条记录'; }
  // 表标题：电商宝写「电商宝 · SKU」；本产品写自己的品牌名（格式一致、品牌各自署名）
  function skuExportSheets(rowsIn, title, itemId, url, withSize, propsIn, sizeIn) {
    var rows = skuExportRowsFrom(rowsIn || state.skuRows, title || state.itemTitle, itemId || state.itemId, url || location.href);
    var cols = effectiveSkuCols(rows);   // v1.2.457：全空列不输出（商家编码等在买家侧恒空）
    var out = {};
    out['SKU'] = { headers: cols, rows: rows, title: '电商采集大师 · SKU', subtitle: exportStamp(rows.length) };
    // v1.2.458：参数/尺码表可显式传入（历史「一键包」用记录里的数据，不再只读当前页面 state）
    var props = ((propsIn || state.itemProps) || []).map(function (p) { return { '参数名': (p && p.name) || '', '参数值': (p && p.value) || '' }; });
    if (props.length) out['商品参数'] = { headers: ['参数名', '参数值'], rows: props, title: '电商采集大师 · 商品参数', subtitle: exportStamp(props.length) };
    // v1.2.454：整合包里的「数据表.xlsx」把尺码表并进同一个工作簿（标题/样式由 exportStyledWorkbook 统一补）
    if (withSize) {
      var sc = sizeIn || state.sizeChart || [];
      if (sc.length) out['尺码表'] = { headers: unionRowKeys(sc), rows: sc };
    }
    return out;
  }
  // v1.2.456【CSV 与 Excel 必须一致（用户「这两个导出的要一致」）】
  //   原来：Excel 是「SKU + 商品参数」两张表，CSV 只有 SKU 一张 ⇒ 内容不一致。
  //   现按电商宝 `exportWorkbook` 的 CSV 口径：**每张表前加一行「数据分区」+ 表名**，再输出该表（表头 + 数据），
  //   于是 CSV 与 xlsx 含同一批表、同样的列/行/排序/链接（CSV 无样式与标题行，这是格式本身决定的）。
  function workbookToCsvBlocks(sheets) {
    var NL = String.fromCharCode(10);
    var parts = [];
    Object.keys(sheets || {}).forEach(function (name) {
      var sh = sheets[name];
      if (!sh || !sh.headers || !sh.headers.length) return;
      parts.push(skuToCsv([{ '数据分区': name }], ['数据分区']));
      parts.push(skuToCsv(sh.rows || [], sh.headers));
    });
    return parts.join(NL);
  }
  // v1.2.457【全空列不输出（用户问「商家编码是否无用」）】
  //   事实：`商家编码` 在代码里有来源映射（lib/image-parser.js 取 s.outerId），但**淘宝/天猫买家侧页面不暴露它**
  //   （只在卖家后台可见）⇒ 抓别人的商品时该列恒空；参照的电商宝导出文件里这一列同样全空。
  //   处置：数据驱动——**整列为空就不输出**（关键列 序号/商品标题/商品ID/商品链接 始终保留）；
  //   任何平台真给出值（如自家商品页、1688/京东等）时该列自动回来。全空列判定与远程可切回：
  //   `common.skuKeepEmptyCols` = on 时保持与电商宝参照文件完全一致的 12 列（含空列）。
  function effectiveSkuCols(rows) {
    // v1.2.468：改为「固定列 + 每个规格维度各一列」的动态列（不再有组合列「规格」）
    return skuColumnsFor(rows);
  }
  // 映射 + 按有效列出 CSV（历史打包与面板 CSV 共用，保证与 xlsx 同列）
  function skuCsvFromRows(rows, title, itemId, url) {
    var mapped = skuExportRowsFrom(rows, title, itemId, url);
    return skuToCsv(mapped, effectiveSkuCols(mapped));
  }
  function exportSku(kind) {
    var rows = state.skuRows;
    if (!rows || !rows.length) { aisToast("没有 SKU 数据", "warn"); return; }
    // v1.2.448 统一了「列序 / Excel 生成器 / 文件名 / 下载通道」；v1.2.453 起列与列宽按电商宝口径
    //   （12 列 + 标题/时间行 + 自动筛选 + 第二张「商品参数」表），CSV 与 xlsx 列序完全一致。
    var name = safeFs(state.itemTitle || "SKU").slice(0, 40) || 'SKU';
    var XL_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    if (kind === "json") {
      // 面板已无 JSON 入口（v1.2.440 去重复），保留函数分支以免误删共享逻辑
      sendBg({ action: "downloadData", base64: b64Utf8(JSON.stringify(skuExportRowsFrom(rows, state.itemTitle, state.itemId, location.href), null, 2)), mime: "application/json", filename: name + "_SKU.json" });
      aisToast("SKU JSON 已导出", "info"); return;
    }
    if (kind === "xlsx") {
      try {
        exportStyledWorkbook(skuExportSheets(rows), name + "_SKU.xlsx").then(function (b64) {
          if (!b64) { status("Excel 导出失败"); return; }
          sendBg({ action: "downloadData", base64: b64, mime: XL_MIME, filename: name + "_SKU.xlsx" });
          aisToast("SKU Excel 已导出（SKU + 商品参数 两张表）", "info");
        }).catch(function (eX) { status("Excel 导出失败：" + (eX && eX.message)); });
      } catch (e) { status("Excel 导出失败：" + e.message); }
      return;
    }
    // CSV：与 xlsx 同一批表（SKU + 商品参数）、同列同序同排序（电商宝口径：每表前一行「数据分区」+ 表名）
    sendBg({ action: "downloadData", base64: b64Utf8(String.fromCharCode(65279) + workbookToCsvBlocks(skuExportSheets(rows))), mime: "text/csv", filename: name + "_SKU.csv" });
    aisToast("CSV 已导出（与 Excel 同内容：SKU + 商品参数）", "info");
  }
  // v1.2.181：原「上货包」拆分为「素材包（图片ZIP+清单）」与「上架数据包（xlsx）」
  function buildMaterialItems() {
    var out = [];
    ['main', 'sku', 'desc'].forEach(function (t) {
      (state[t] || []).forEach(function (u) {
        out.push({ url: u, type: t, folder: TYPE_LABEL[t], name: t === 'sku' ? skuFileName(u) : '', format: 'original', quality: 92, scale: 1 });
      });
    });
    videoList().forEach(function (vu) { out.push({ url: vu, type: 'video', folder: '视频', name: '', format: 'original', quality: 92, scale: 1 }); });   // v1.2.292 全部视频
    return out;
  }
  function pad3(n) { return String(n).padStart(3, '0'); }
  // 与 offscreen 的 imgFileName 命名规则保持一致 → 清单里的文件名 = ZIP 内实际文件名
  function buildImageManifest(items) {
    var out = [], used = {};
    // v1.2.454【按分类排序】图片清单固定按「主图 → SKU图 → 详情图 → 视频」分组（未知分类排最后，组内保持采集顺序），
    //   这样清单与 ZIP 内的目录顺序一致，不再受传入顺序影响。
    var ORDER = {};
    try { ORDER[TYPE_LABEL.main] = 1; ORDER[TYPE_LABEL.sku] = 2; ORDER[TYPE_LABEL.desc] = 3; ORDER[TYPE_LABEL.video] = 4; } catch (eOrd) {}
    var sorted = (items || []).map(function (it, i) { return { it: it, i: i }; }).sort(function (a, b) {
      var oa = ORDER[a.it.folder] || 99, ob = ORDER[b.it.folder] || 99;
      if (oa !== ob) return oa - ob;
      return a.i - b.i;
    }).map(function (x) { return x.it; });
    sorted.forEach(function (it, i) {
      var ext = extOf(it.url);
      // v1.2.419：orig 模式用原图名（与落盘一致）；legacy 保持商店基线命名
      var raw = useOrigName(imgNameMode(), it.type)
        ? (origNameOf(it.url) || (pad3(i + 1) + '_' + String(it.type || 'img')))
        : ((it.type === 'sku' && it.name) ? safeFs(it.name) : (pad3(i + 1) + '_' + String(it.type || 'img')));
      var key = it.folder + '/' + raw + '.' + ext, k = 2;
      while (used[key]) { key = it.folder + '/' + raw + '-' + (k++) + '.' + ext; }
      used[key] = 1;
      out.push({ '分类': it.folder, '序号': i + 1, '文件名': key, '图片URL': it.url });
    });
    return out;
  }
  function manifestCsv(rows) {
    if (!rows || !rows.length) return '';
    var cols = Object.keys(rows[0]);
    var NL = String.fromCharCode(10), Q = String.fromCharCode(34);
    var lines = [cols.join(',')];
    rows.forEach(function (r) {
      lines.push(cols.map(function (c) { var v = r[c] == null ? '' : String(r[c]); return Q + v.split(Q).join(Q + Q) + Q; }).join(','));
    });
    return lines.join(NL);
  }
  function exportMaterialZip() {
    var imgs = buildMaterialItems();
    if (!imgs.length) { aisToast('没有图片可打包', 'warn'); return; }
    if (!requireMember('打包下载（ZIP）')) return;
    var manifest = buildImageManifest(imgs);
    state.materialManifest = manifest;
    state.pkgPreview = { rows: manifest, imgCount: imgs.length, zipName: safeFs(state.itemTitle || '商品') + '_' + safeFs(state.itemId || '') + '.zip' };
    try { renderPkgPreview(); } catch (eRP) {}
    var b64 = '';
    try { b64 = btoa(unescape(encodeURIComponent(String.fromCharCode(65279) + manifestCsv(manifest)))); } catch (eCsv) {}
    state.__dlTitle = '素材包';
    progShow('素材包 · ' + imgs.length + ' 张');
    progSet(0, imgs.length, '正在抓取图片…');
    aisToast('素材包开始打包：' + imgs.length + ' 张（包内含 图片清单.csv + 分类目录）', 'info');
    sendBg({ action: 'downloadImages', images: imgs, asZip: true, nameMode: imgNameMode(), itemTitle: state.itemTitle, itemId: state.itemId, summaryCsvBase64: b64 }).then(function (r) {
      if (r && r.ok) {
        progSet(imgs.length, imgs.length, '已完成'); progHide(2000);
        aisToast('素材包已下载：' + r.down + ' 张 + 图片清单.csv' + (r.fileName ? '（' + r.fileName + '）' : ''), r.failed ? 'warn' : 'info');
        if (r.downloadId != null) showOpenFolder(r.downloadId);
      } else {
        progSet(0, imgs.length, '失败'); progHide(3000);
        aisToast('素材包打包失败：' + ((r && r.error) || '未知错误'), 'error');
      }
    });
  }
  // ===== v1.2.268 整合包：一个 ZIP 内含 上架数据包.xlsx + 全部图片 + 各表格 + JSON + 说明 =====
  function b64Utf8(s) { try { return btoa(unescape(encodeURIComponent(String(s)))); } catch (e) { return ''; } }
  var INTEGRATED_MAX_IMGS = 300;   // 超过则先弹确认（ZIP 可能数百 MB）
  async function integratedPackExtraFiles(manifest) {
    var NL = String.fromCharCode(10);
    var extra = [];
    var add = function (name, base64) { if (base64) extra.push({ name: name, base64: base64 }); };
    // ===== v1.2.454【打包里的表格全部统一成电商宝口径（用户要求）】=====
    // 改前：上架数据包.xlsx 走裸 XLSX（无标题/无样式），SKU明细.csv / 商品参数.csv / 尺码表.csv 是三个裸 CSV
    //       ⇒ 与面板「导出」的新格式（三行表头 + 自动筛选 + 斑马纹 + 电商宝色板 + fieldWidth 列宽）不一致。
    // 改后：① 上架数据包.xlsx（ERP 口径 4 张表）改走 exportStyledWorkbook ⇒ 同样是新格式；
    //       ② 三个 CSV 合并成一张 `数据表.xlsx`（SKU / 商品参数 / 尺码表 三张表），与面板 SKU 导出同一口径；
    //       ③ 商品数据.json 与 导入说明.txt 保留（JSON 是唯一含评论分析的完整备份，说明是解压即见的入口）。
    // 表格行序：SKU 表按「颜色 → 尺码」分组排序（skuExportRowsFrom 内做）、图片清单按「主图→SKU图→详情图→视频」
    //       分组排序（buildImageManifest 内做）⇒ 打包里的表格都是按分类归好组的。
    var lean = true;
    try { lean = aisSel('common.packLeanFiles', 'on') !== 'off'; } catch (eLean) {}
    try { add('上架数据包.xlsx', await buildListingWorkbookBase64(manifest)); } catch (e1) { aisToast('整合包：Excel 生成失败（' + (e1 && e1.message) + '），已跳过该文件', 'warn'); }
    try { add('数据表.xlsx', await exportStyledWorkbook(skuExportSheets(null, null, null, null, true), '数据表.xlsx')); } catch (e2) {}
    // v1.2.462【用户要求：历史整合包要和整合包一样】两边文件集对齐 —— 采过评论时这里也带一张 评论.xlsx
    if ((state.reviews || []).length) {
      try {
        var rrows2 = revToRows(state.reviews, []);
        extra.push({ name: '评论.xlsx', base64: await exportStyledWorkbook({ '评论': { headers: revOrderedCols(rrows2, /(?:taobao|tmall)\.com/.test(location.href || '')), rows: rrows2 } }, '评论.xlsx') });
      } catch (e2b) {}
    }
    if (!lean) { try { add('SKU明细.json', b64Utf8(JSON.stringify(state.skuRows || [], null, 2))); } catch (e3) {} }
    if (!lean) { try { add('图片清单.csv', b64Utf8(String.fromCharCode(65279) + manifestCsv(manifest))); } catch (e6) {} }
    try {
      add('商品数据.json', b64Utf8(JSON.stringify({
        exportTime: new Date().toISOString(),
        basic: { 标题: state.itemTitle || '', 商品ID: state.itemId || '', 链接: location.href, 平台: location.host || '' },
        counts: { 主图: state.main.length, SKU图: state.sku.length, 详情图: state.desc.length, 视频: videoList().length, 评论: (state.reviews || []).length, 参数: (state.itemProps || []).length, 尺码表行: (state.sizeChart || []).length },
        main: state.main, sku: state.sku, desc: state.desc, video: videoList()[0] || '', videos: videoList(),   // v1.2.292
        skuPropNames: state.skuPropNames || [], skuRows: state.skuRows || [],
        itemProps: state.itemProps || [], sizeChart: state.sizeChart || [],
        imageManifest: manifest,
        reviewAnalysis: state.analysis || null
      }, null, 2)));
    } catch (e7) {}
    try {
      add('导入说明.txt', b64Utf8([
        '整合包内容说明',
        '',
        '上架数据包.xlsx  —— 4 张表：商品信息 / SKU明细 / 图片清单 / 导入说明（给店小秘/妙手/马帮等 ERP 做「自定义导入」逐列对应）',
        '数据表.xlsx      —— 3 张表：SKU / 商品参数 / 尺码表（与面板「导出」里的 SKU Excel 同一口径：12 列 SKU + 参数 + 尺码）',
        '评论.xlsx        —— 评论明细（采过评论时才有；与历史「整合包」同一份内容）',
        '商品数据.json   —— 完整结构化数据（主图/SKU图/详情图/参数/尺码表/评论分析）',
        '主图/ SKU图/ 详情图/ 视频/  —— 全部图片按分类分目录，文件名＝原图名（v1.2.438 起默认；规则 common.imgNameMode 可切回旧的「类型_序号 / 规格名」口径）',
        '',
        '表格格式（v1.2.454 起统一）：每张表首行是标题、第二行是「导出时间 + 记录条数」、第三行才是表头（带自动筛选）；',
        '  SKU 表按「颜色 → 尺码」分组排序，图片清单按「主图 → SKU图 → 详情图 → 视频」分组排序。',
        '注意：叶子类目、物流模板、宝贝描述模板需在 ERP / 平台内补齐。',
        '数据来自公开商品页，请遵守目标平台服务条款，仅用于个人研究或合法经营用途。'
      ].join(NL)));
    } catch (e8) {}
    return extra;
  }
  // ===== v1.2.433 采集即自动入库 + 自动打包下载（用户要求：打开商品页有缓存，没点下载也应能自动存/下）=====
  //   以前：详情页采集完但用户没点任何下载 → saveHistory 不触发 → 历史里什么都没有 ✗
  //   现在：采集出数据后【自动 saveHistory】；common.autoPackOnCollect=on 时再【自动打整合包下载】✓
  //   收敛：同一个商品只自动打一次（按 URL 去重），轮询上限 30 次（≈90s）后停止 ✓
  function autoSaveHistOn() { try { return aisSel('common.autoSaveHistory', 'on') !== 'off'; } catch (e) { return true; } }
  // v1.2.449【默认关闭】用户反馈「整合包怎么自动就下载了，我都没点下载」——
  //   原先默认值是 'on'（`'o'+'n'` 拼接），且服务器规则 common.autoPackOnCollect 也是 "on"
  //   ⇒ 打开任意商品页都会自动打包下载。这违反项目红线「新行为必须默认关闭（商店基线 v1.2.371 无自动打包）」。
  //   现改为**默认 off**，并把规则键改为 "off"：只在服务器明确开启时才会自动打包；自动入库（不下载）保持默认开。
  function autoPackOn() { try { return aisSel('common.autoPackOnCollect', 'o' + 'ff') === 'on'; } catch (e) { return false; } }
  var __autoP = { url: '', done: false, tick: 0, last: '', stable: 0, first: 0 };
  async function autoPackTick() {   // v1.2.435：内部用 await 读 chrome.storage 去重 → 必须 async
    try {
      if (typeof isDetail === 'function' && !isDetail()) return;
      var u = String(location.href).split('#')[0];
      if (__autoP.url !== u) { __autoP = { url: u, done: false, tick: 0, last: '', stable: 0, first: 0 }; }
      if (__autoP.done) return;
      if (++__autoP.tick > 60) { __autoP.done = true; return; }   // 3s×60 = 3 分钟上限
      var n = (state.main || []).length + (state.desc || []).length + (state.sku || []).length;
      if (!n) return;
      if (!__autoP.first) __autoP.first = Date.now();
      // v1.2.435【修「刚打开商品就自动打包、包里只有主图」】——必须先等采集真正结束：
      //   ① 仍在采集（state.reading / state.collecting）→ 不打包；
      //   ② 关键数据指纹必须【连续 4 次不变（12s）】且距首次有数据 ≥9s → 才算采完 ✓
      if (state.reading || state.collecting) { __autoP.stable = 0; return; }
      var fp = n + '/' + (state.desc || []).length + '/' + (state.skuRows || []).length + '/' + (state.itemProps || []).length + '/' + ((typeof videoList === 'function' ? videoList().length : 0));
      if (fp === __autoP.last) __autoP.stable++; else { __autoP.stable = 0; __autoP.last = fp; }
      if (__autoP.stable < 4 || (Date.now() - __autoP.first) < 9000) return;
      if (autoSaveHistOn()) { try { saveHistory(n); } catch (e1) {} }
      __autoP.done = true;
      // v1.2.435：同一商品【6 小时内只自动打一次】—— 重复打开同一商品不再反复下载 ✓
      var _iid = String(state.itemId || __autoP.url || '');
      var _dedupOk = false;
      try {
        var _k = 'aisAutoPackAt';
        var _o = (await chrome.storage.local.get([_k]))[_k] || {};
        var _t = Number(_o[_iid] || 0);
        var _now = Date.now();
        if (!_t || (_now - _t) > 6 * 3600 * 1000) { _o[_iid] = _now; chrome.storage.local.set({ [_k]: _o }); _dedupOk = true; }
      } catch (eDD) { _dedupOk = true; }
      if (!_dedupOk) { try { aisToast('该商品 6 小时内已自动打包过，本次跳过（可在历史里手动打包）', 'info'); } catch (eD1) {} return; }
      if (autoPackOn()) {
        try { exportIntegratedPack(); aisToast('采集完成 → 已自动打包下载（可在「设置」关闭自动打包）', 'ok'); } catch (e2) {}
      } else {
        try { aisToast('采集完成 → 已自动存入采集历史（可随时在历史里打包下载）', 'info'); } catch (e3) {}
      }
    } catch (e) {}
  }
  try { setInterval(autoPackTick, 3000); } catch (eAT) {}
  function exportIntegratedPack() {
    var imgs = buildMaterialItems();
    if (!imgs.length) { aisToast('没有图片可打包', 'warn'); return; }
    if (!requireHisPack('整合包（图片 + 表格）')) return;
    var manifest = buildImageManifest(imgs);
    state.materialManifest = manifest;
    var zipLabel = safeFs(state.itemTitle || '商品') + '_' + safeFs(state.itemId || '') + '_整合包';
    state.pkgPreview = { rows: manifest, imgCount: imgs.length, zipName: zipLabel + '.zip' };
    try { renderPkgPreview(); } catch (eRP) {}
    var go = async function () {
      try { sizeChartDom(); } catch (eSC) {}
      // v1.2.454：表格生成改异步（上架数据包与数据表都要走样式化导出）⇒ 这里 await
      var extra = [];
      try { extra = await integratedPackExtraFiles(manifest); } catch (eIX) { aisToast('整合包：表格生成失败（' + ((eIX && eIX.message) || eIX) + '），仅打包图片', 'warn'); }
      state.__dlTitle = '整合包';
      progShow('整合包 · ' + imgs.length + ' 张');
      progSet(0, imgs.length, '正在抓取图片…');
      aisToast('整合包开始打包：' + imgs.length + ' 张图 + ' + extra.length + ' 个文件', 'info');
      // itemId 追加「_整合包」后缀 → worker 生成的 ZIP 名与素材包区分（内部目录不受影响）
      sendBg({ action: 'downloadImages', images: imgs, asZip: true, extraFiles: extra, nameMode: imgNameMode(), itemTitle: state.itemTitle, itemId: String(state.itemId || '') + '_整合包' }).then(function (r) {
        if (r && r.ok) {
          progSet(imgs.length, imgs.length, '已完成'); progHide(2000);
          aisToast('整合包已下载：' + r.down + ' 张图 + ' + extra.length + ' 个文件' + (r.fileName ? '（' + r.fileName + '）' : ''), r.failed ? 'warn' : 'info');
          if (r.downloadId != null) showOpenFolder(r.downloadId);
        } else {
          progSet(0, imgs.length, '失败'); progHide(3000);
          aisToast('整合包打包失败：' + ((r && r.error) || '未知错误'), 'error');
        }
      });
    };
    if (imgs.length > INTEGRATED_MAX_IMGS) {
      aisConfirm('本次整合包含 ' + imgs.length + ' 张图片，ZIP 体积可能很大（数百 MB），打包期间请勿关闭页面。是否继续？', { okText: '继续打包', cancelText: '取消' })
        .then(function (ok) { if (ok) go().catch(function (eG) { aisToast('整合包打包失败：' + ((eG && eG.message) || eG), 'error'); }); });
      return;
    }
    go().catch(function (eG) { aisToast('整合包打包失败：' + ((eG && eG.message) || eG), 'error'); });
  }
  // v1.2.179 详情长图：把已采集详情图交 offscreen 纵向拼接为 PNG（超高自动分卷）
  function exportLongImage() {
    if (!state.desc.length) { aisToast('没有详情图：先采集详情图，再导出长图', 'warn'); return; }
    var urls = state.desc.slice(0, 200);
    state.__dlTitle = '详情长图下载';
    progShow('详情长图下载 · ' + urls.length + ' 张');
    progSet(0, urls.length, '正在抓取并拼接…');
    sendBg({ action: 'longImage', images: urls, itemTitle: state.itemTitle, itemId: state.itemId }).then(function (r) {
      if (r && r.ok) {
        progSet(urls.length, urls.length, '已完成' + (r.failed ? ' · 跳过失败 ' + r.failed + ' 张' : ''));
        progHide(2600);
        var msg = '详情长图下载完成：' + r.down + ' 个 PNG（详情图 ' + (r.count || urls.length) + ' 张';
        if (r.failed) {
          msg += '，失败 ' + r.failed + ' 张';
          if (r.failedUrls && r.failedUrls.length) msg += '，例如 ' + r.failedUrls.slice(0, 2).join(' , ');
        }
        msg += '）';
        aisToast(msg, r.failed ? 'warn' : 'info');
        if (r.downloadIds && r.downloadIds.length) { state.lastDownloadId = r.downloadIds[r.downloadIds.length - 1]; showOpenFolder(); }
      } else {
        progSet(0, urls.length, '失败'); progHide(3200);
        (function(){var __e=String((r&&r.error)||'未知错误');if(/context invalidated|Extension context/i.test(__e)){aisToast('扩展刚更新或重载过，本页已失效 —— 请按 F5 刷新页面后重试','error');}else{aisToast('详情长图下载失败：'+__e,'error');}})();
      }
    });
  }
  // v1.2.180 上货包预览：把生成的上货表在面板内渲染成可查看的表格（此前只有 ZIP，无从确认内容）
  function parseCsvLine(line) {
    var out = [], cur = '', inQ = false;
    for (var i = 0; i < line.length; i++) {
      var ch = line.charAt(i);
      if (inQ) {
        if (ch === '"') { if (line.charAt(i + 1) === '"') { cur += '"'; i++; } else inQ = false; }
        else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  }
  function renderPkgPreview() {
    var card = $('aisimg-pkgcard'), tb = $('aisimg-pkgtable'), sum = $('aisimg-pkgsummary'), tt = $('aisimg-pkgtitle');
    if (!card) return;
    var p = state.pkgPreview;
    if (!p || !p.rows || !p.rows.length) { card.style.display = 'none'; return; }
    card.style.display = '';
    if (tt) tt.textContent = '素材包预览 · 图片清单';
    if (sum) sum.innerHTML = '共 <b>' + p.imgCount + '</b> 张图，清单 <b>' + p.rows.length + '</b> 行<br>ZIP 文件名：<span style="color:#e8590c;word-break:break-all;">' + esc(p.zipName) + '</span>（包内目录结构与下表「文件名」列完全一致）';
    if (tb) {
      var cols = Object.keys(p.rows[0]);
      var show = p.rows.slice(0, 30);
      var html = '<tbody><tr>' + cols.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '</tr>';
      show.forEach(function (r2) { html += '<tr>' + cols.map(function (c) { return '<td>' + esc(r2[c]) + '</td>'; }).join('') + '</tr>'; });
      html += '</tbody>';
      if (p.rows.length > 30) html += '<caption style="caption-side:bottom;font-size:11px;color:#7a8490;padding-top:4px;">仅预览前 30 行，共 ' + p.rows.length + ' 行</caption>';
      tb.innerHTML = html;
    }
  }
  function downloadManifest(kind) {
    var p = state.pkgPreview;
    if (!p || !p.rows || !p.rows.length) { aisToast('先生成「素材包」或「上架数据包」', 'warn'); return; }
    var name = safeFs(state.itemTitle || '商品') + '_图片清单';
    if (kind === 'xlsx') {
      try {
        if (typeof XLSX === 'undefined') { aisToast('Excel 组件未加载', 'error'); return; }
        var ws = __aisSheet(p.rows);
        var wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '图片清单');
        var bx = XLSX.write(wb, { type: 'base64', bookType: 'xlsx' });
        sendBg({ action: 'downloadData', base64: bx, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: name + '.xlsx' });
        aisToast('图片清单 Excel 已导出：' + name + '.xlsx', 'info');
      } catch (e) { aisToast('图片清单 Excel 导出失败：' + (e && e.message), 'error'); }
      return;
    }
    var b64 = '';
    try { b64 = btoa(unescape(encodeURIComponent(String.fromCharCode(65279) + manifestCsv(p.rows)))); } catch (e) { aisToast('图片清单导出失败', 'error'); return; }
    sendBg({ action: 'downloadData', base64: b64, mime: 'text/csv', filename: name + '.csv' });
    aisToast('图片清单 CSV 已导出：' + name + '.csv', 'info');
  }
  // v1.2.181 上架数据包（原 ERP 导入包升级）：商品信息 / SKU明细（名值配对）/ 图片清单（文件名+URL）/ 导入说明
  // v1.2.268：抽出纯函数（只产出 base64），供「整合包」复用，避免重复 sheet 构建代码
  // v1.2.458：新增可选参数 D —— 显式数据源（历史「一键包」用记录里的数据；不传则读当前页面 state）
  async function buildListingWorkbookBase64(manifest, D) {
    D = D || {};
    var rows = D.skuRows || state.skuRows || [];
    var propNames = D.skuPropNames || state.skuPropNames || [];
    var propsSrc = D.itemProps || state.itemProps || [];
    var mainSrc = D.main || state.main || [];
    var descSrc = D.desc || state.desc || [];
    var vidSrc = D.videos || videoList();
    var titleSrc = (D.title != null ? D.title : state.itemTitle) || '';
    var idSrc = (D.itemId != null ? D.itemId : state.itemId) || '';
    var urlSrc = D.url || location.href;
    var pick = function (r, names) { for (var i = 0; i < names.length; i++) { if (r && r[names[i]] != null && r[names[i]] !== '') return r[names[i]]; } return ''; };
    var brand = '', sales = '', cat = '';
    propsSrc.forEach(function (p) {
      var k = String((p && (p.name || p.key || p.label)) || ''), v = String((p && (p.value || p.val || p.text)) || '');
      if (!brand && /品牌/.test(k)) brand = v;
      if (!sales && /(销量|月销|已售)/.test(k)) sales = v;
      if (!cat && /(类目|分类)/.test(k)) cat = v;
    });
    var price = rows.length ? pick(rows[0], ['价格', 'price']) : '';
    var stock = rows.length ? pick(rows[0], ['库存', 'stock']) : '';
    var main5 = mainSrc.slice(0, 5);
    var info = {
      '商品标题': titleSrc, '平台': (function () { try { return new URL(urlSrc).host; } catch (eH) { return location.host || ''; } })(), '商品ID': idSrc,
      '商品链接': cleanItemUrl(urlSrc, idSrc), '店铺': '', '品牌': brand, '类目（需自行确认）': cat,
      '价格': price, '市场价': '', '销量': sales, '库存': stock,
      '主图1': main5[0] || '', '主图2': main5[1] || '', '主图3': main5[2] || '', '主图4': main5[3] || '', '主图5': main5[4] || '',
      '视频链接': vidSrc.join(' | '), '视频数量': vidSrc.length, '详情图数量': descSrc.length, 'SKU规格名': propNames.join(' / '),
      '采集时间': new Date().toLocaleString('zh-CN')
    };
    var manByUrl = {};
    manifest.forEach(function (m) { if (!manByUrl[m['图片URL']]) manByUrl[m['图片URL']] = m['文件名']; });
    // v1.2.469【用户要求：所有涉及 SKU 表的下载产物都要按维度分列】原来硬编码「规格1/规格2」⇒ 3 维以上会**丢维度** ✗
    //   ⇒ 改为**每个规格维度各一列**（列名 = 维度名，维度从行键动态取，数量与名称都不写死）+ 规格组合 + 价格/库存/SKU图URL/SKU图文件名
    var dimsL = skuDimCols(rows);
    var skuRows = rows.map(function (r) {
      var img = pick(r, ['SKU图']);
      var o = {};
      dimsL.forEach(function (c) { o[c] = pick(r, [c]) || (c === '颜色' ? pick(r, ['颜色分类']) : ''); });
      o['规格组合'] = pick(r, ['规格']) || dimsL.map(function (c) { return (o[c] ? c + ':' + o[c] : ''); }).filter(Boolean).join(';');
      o['价格'] = pick(r, ['价格', 'price']); o['库存'] = pick(r, ['库存', 'stock']);
      o['SKU图URL'] = img;
      o['SKU图文件名'] = img ? (manByUrl[img] || skuFileName(img) || '') : '';
      return o;
    });
    var helpRows = aisArr('common.listingHelp', [
      'Sheet 说明：商品信息 = 单商品主档；SKU明细 = 多规格行（**每个规格维度各一列**，列名即维度名 + 规格组合）；图片清单 = 与「素材包」ZIP 内文件名完全一致。',
      '必填但本工具采不到的字段：叶子类目（请按目标平台自行选择）、物流模板、宝贝描述模板 —— 需在 ERP / 平台内补齐。',
      '图片：清单里的「文件名」对应素材包 ZIP 内的相对路径；要直接填 URL 就用「图片URL」列（部分平台要求图片先上传到自有图片空间）。',
      '数据来自公开商品页，请遵守目标平台服务条款，仅用于个人研究或合法经营用途。'
    ]).map(function (s) { return { '说明': String(s) }; });
    // v1.2.454：改走 exportStyledWorkbook ⇒ 四张表同样是「电商宝口径」（三行表头 + 自动筛选 + 斑马纹 + fieldWidth 列宽）
    var infoRows = [info];
    var skuRowsX = skuRows.length ? skuRows : [{ '规格组合': '' }];
    var manRows = manifest.length ? manifest : [{ '分类': '' }];
    return await exportStyledWorkbook({
      '商品信息': { headers: Object.keys(info), rows: infoRows },
      'SKU明细': { headers: Object.keys(skuRowsX[0]), rows: skuRowsX },
      '图片清单': { headers: Object.keys(manRows[0]), rows: manRows },
      '导入说明': { headers: ['说明'], rows: helpRows }
    }, '上架数据包.xlsx');
  }
  // 上架数据包（保持原行为；复用上面的纯函数）
  async function exportListing() {
    try {
      var manifest = buildImageManifest(buildMaterialItems());
      state.materialManifest = manifest;
      state.pkgPreview = { rows: manifest, imgCount: manifest.length, zipName: safeFs(state.itemTitle || '商品') + '_' + safeFs(state.itemId || '') + '.zip' };
      try { renderPkgPreview(); } catch (eRP) {}
      var bx = await buildListingWorkbookBase64(manifest);
      sendBg({ action: 'downloadData', base64: bx, mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', filename: safeFs(state.itemTitle || '商品') + '_上架数据包.xlsx' });
      aisToast('上架数据包已导出：商品信息 / SKU明细 / 图片清单 / 导入说明（SKU 页已生成图片清单预览）', 'info');
    } catch (e) { aisToast('上架数据包导出失败：' + (e && e.message), 'error'); }
  }
  function revealPanel() {
    try {
      var root = $('ai-scraper-root');
      if (root) root.style.display = '';
      var panel = $('ais-panel');
      if (panel) { panel.classList.remove("ais-minimized"); panel.classList.remove("ais-sidebar-mode"); }
    } catch (e) {}
  }
  function switchTab(which) {
    // v1.2.222：PDD 页 SKU 页签已隐藏——程序化切 sku 一律转投图片页，绝不出空白页签
    if (which === 'sku' && /yangkeduo\.com|pinduoduo\.com/.test(location.href)) which = 'img';
    ['img', 'sku', 'review', 'history'].forEach(function (t) {
      var tab = $('aisimg-tab-' + t); if (tab) tab.classList.toggle('active', t === which);
    });
    var grid = $('aisimg-grid'), empty = $('aisimg-empty'), sku = $('aisimg-skuarea'), his = $('aisimg-hisarea'), rev = $('aisimg-revarea');
    if (!grid) return;
    grid.style.display = which === 'img' ? '' : 'none';
    if (empty) empty.style.display = (which === 'img' && !grid.innerHTML) ? '' : 'none';
    if (sku) sku.style.display = which === 'sku' ? '' : 'none';
    if (his) { his.style.display = which === 'history' ? '' : 'none'; if (which === 'history') renderHistory(); }
    if (rev) { rev.style.display = which === 'review' ? '' : 'none'; if (which === 'review') renderReview(); }
    var frow = $('aisimg-filterrow');
    if (frow) frow.style.display = (which === 'img') ? '' : 'none';
    try { var chs = $('aisimg-chips'); if (chs && chs.parentNode && chs.parentNode.id === 'aisimg-body') chs.style.display = (which === 'img') ? '' : 'none'; } catch (eChs) {}   // v1.2.295 方案B
    var bot = $('aisimg-bottom');
    if (bot) bot.style.display = (which === 'img') ? '' : 'none';
    var stc = D().querySelector('.aisimg-status');
    if (stc) stc.style.display = (which === 'img') ? '' : 'none';
    var stg = $('aisimg-settings');
    if (stg) stg.style.display = (which === 'img') ? '' : 'none';
    // v1.1.127：「打包下载本组」横条跨页签泄漏修复——非 img 页签强制隐藏，img 页签按筛选状态还原
    var gbar = $('aisimg-grpbar');
    if (gbar) { if (which === 'img') { try { updateGrpbar(); } catch (eGrp) {} } else { gbar.style.display = 'none'; } }
  }

  function finishRead() {
    state.readFinished = true;
    state.reading = false;
    try { descWaitStop(); } catch (eDS) {} // v1.2.263：结束等待——无图则改显「暂未采集到详情图」
    // v1.2.442【根因修复】读取收尾时若 SKU 仍为空，起一轮有界「晚到桥」拾取
    // （真机受控复现：桥里的 skuBase/skuCore 完整，但读取跑在桥出现之前 → SKU 恒为 0 且再无第二次机会）
    try { if (!(state.skuRows || []).length) skuBridgePickup(); } catch (eSPk) {}
    renderSku();
    analyzeReviews();
    var vN = videoList().length;   // v1.2.292
    var rvN = state.reviews.length ? " · 评论 " + state.reviews.length : "";
    var ngN = (state.analysis && state.analysis.negativeCount) ? " · 高风险评论 " + state.analysis.negativeCount : "";
    status('商品读取完成（主图 ' + state.main.length + ' · SKU ' + state.sku.length + ' · 详情 ' + state.desc.length + (vN ? ' · 视频 1' : '') + rvN + ngN + '）', true);
    // v1.2.301：详情图采完【滚回顶部】——对齐京东既有行为（jdDwellDetail 收尾即为 window.scrollTo(0,0)）。
    // 仅在「我们为触发懒加载而自动滚过」时回顶（state.__scrollBackNeeded），避免把正在阅读的用户拽走。
    // 当前只对淘宝/天猫生效（用户指定）；1688 本就不滚动，京东维持原行为，其它平台沿用原位。
    try {
      if (state.__scrollBackNeeded && /(^|\.)(taobao|tmall)\.com$/.test(location.hostname)) {
        state.__scrollBackNeeded = false;
        window.scrollTo(0, 0);
      }
    } catch (eSB) {}
    // v1.2.181：面板最小化时补一条可见提示，否则用户不知道已采完 / 数据在哪
    try {
      var pnl = $('ais-panel');
      if (pnl && pnl.classList.contains('ais-minimized')) {
        aisToast('已采集：主图 ' + state.main.length + ' · SKU图 ' + state.sku.length + ' · 详情图 ' + state.desc.length + ' —— 点右侧悬浮球展开查看', 'info');
      }
    } catch (ePM) {}
    // v1.2.181：详情图 0 / 数据异常偏少的归因提示（页面未加载完整，或被平台降级）
    try {
      if (!state.desc.length && (state.main.length || state.sku.length)) {
        aisToast('未读到详情图：本页详情区可能未加载完整（或已被平台降级），建议稍后重试或刷新页面', 'warn');
      } else if (state.main.length <= 3 && !state.sku.length && !state.desc.length) {
        aisToast('本页采集到的数据异常偏少，页面可能被平台降级，建议稍后重试', 'warn');
      }
    } catch (eWarn) {}
    // v1.2.196：PDD 空结果自愈——点早了页面未水合会读出 0，4s 后自动重读一次（每页一次）
    try {
      if (/yangkeduo\.com|pinduoduo\.com/.test(location.href) && !state.main.length && !state.desc.length && !state.__pddRetried) {
        state.__pddRetried = true;
        status('拼多多页面还没加载完，4 秒后自动重新读取…');
        setTimeout(function () { try { state.readFinished = false; state.deepRetried = false; startRead(true); } catch (eRr) {} }, 4000);
      }
    } catch (eSelf) {}
    // v1.2.191：图片采集完成即写入「采集历史」（原先只在下载/评论采集后写，用户不下载就永远是空历史）
    try {
      var _hCnt = state.main.length + state.sku.length + state.desc.length + videoList().length;   // v1.2.292
      if (_hCnt) saveHistory(_hCnt);
    } catch (eHis) {}
    // v1.1.41：评论采集不自动开始——用户在「评论采集」标签点击采集按钮后才开始（仅图片读取自动）
  }

  function descDeepRetry() {
    if (state.deepRetried) { if (!state.readFinished) finishRead(); return; }
    state.deepRetried = true;
    domDescFallback();
    if (descCredible()) { finishRead(); return; } // v1.2.247：≥1 张不再视为采完，保留全量接口兜底
    status('正在抓取详情图…');
    var applied = false;
    var handler = function (ev) {
      try {
        var d = ev && ev.detail; if (!d || d.type !== 'desc' || applied) return;
        var P = window.__AIS_IMG_PARSER__; if (!P) return;
        setTimeout(function () {
          if (applied) return;
          var cs = collectState();
          var l = [];
          try { l = P.parseDescImages(cs.descResp) || []; } catch (e) {}
          try { if (!l.length && P.parseDescImagesDeep) l = P.parseDescImagesDeep(cs.descResp) || []; } catch (e) {}
          if (mergeDesc(l)) { render(); applied = true; }
          if (applied) { window.removeEventListener('ssr:ready', handler, true); finishRead(); }
        }, 400);
      } catch (e) {}
    };
    window.addEventListener('ssr:ready', handler, true);
    var n = 0, lastCnt = -1, stable = 0;
    var poll = setInterval(function () {
      n++;
      domDescFallback();
      if (descCredible()) applied = true; // v1.2.247：≥1 张不再视为采完
      // v1.2.247：DOM 详情图连续 2 轮零增长即视为已收敛，立刻改走全量接口兜底，
      // 避免「本来就只有 1~2 张详情图」的商品白等轮询跑满 10 秒。
      if (state.desc.length === lastCnt) stable++; else { stable = 0; lastCnt = state.desc.length; }
      if (applied || n > 10 || (n >= 3 && stable >= 2)) {
        clearInterval(poll);
        window.removeEventListener('ssr:ready', handler, true);
        if (applied) { finishRead(); return; }
        var du = descFetchUrl(); // v1.2.247：统一走 descFetchUrl（含淘宝/天猫 itemId 兜底）
        if (!du) { finishRead(); return; }
        sendBg({ action: 'fetchDescImages', descUrl: du }).then(function (r) {
          if (r && r.ok && r.images && r.images.length) mergeDesc(r.images, { allowGalleryDup: /(^|\.)(1688|taobao|tmall)\.com$/i.test(location.hostname) });
          render();
          finishRead();
        });
      }
    }, 1000);
  }
  function autoRead(manual) {
    DELAYS.forEach(function (ms, i) {
      setTimeout(function () {
        if (state.readFinished && i < DELAYS.length - 1) return;
        if (i >= 1 && state.desc.length < 3 && !/1688\.com$/.test(location.hostname)) { // v1.2.247：详情图 <3 张继续滚动触发懒加载；1688 仍禁滚动（SSR 直读）
          if (/\.jd\.com$/.test(location.hostname)) {
            // v1.2.252：JD 主动滚动**收窄为仅手动触发**——只有用户点悬浮球进入采集时才滚，
            // 且每次读取最多滚一次（避免反复滚动页面、减少脚本化行为特征，京东有风控）
            if (manual && !state.__jdLazyDone) { state.__jdLazyDone = true; jdAutoLazyLoad(); }
          } else {
            // v1.2.318：非京东平台（淘宝/天猫/拼多多）同样要「滚动 + 收集」才拿得到详情图。
            // 原实现此处只滚到底、从不收集 → 详情图恒为 0 张（用户实测「详情图不显示」的真根因之二）。
            if (!state.__descLazyDone) { state.__descLazyDone = true; try { genericDescLazyLoad(); } catch (eGD) {} }
            state.__scrollBackNeeded = true;
            try { window.scrollTo(0, i === DELAYS.length - 1 ? document.body.scrollHeight : Math.round(document.body.scrollHeight * i * 0.3)); } catch (e) {}
          }
        }
        // v1.2.318：1688 原被排除在滚动之外（SSR 直出），但其详情图同样会不全 → 单独补一次通用收集
        if (/1688\.com$/.test(location.hostname) && state.desc.length < 3 && !state.__descLazyDone) {
          state.__descLazyDone = true;
          try { genericDescLazyLoad(); } catch (eGD88) {}
        }
        var ok = parseAll();
        render();
        if (state.descUrl && !state.descFetched) fetchDesc();
        if (i === DELAYS.length - 1) descDeepRetry();
        else if (ok && i >= 3) finishRead();
        else status('正在读取商品信息…');
      }, ms);
    });
  }
  function startRead(silent, manual) {
    if (state.reading) return;
    // v1.2.196：读完成但结果为空（如 PDD 点击过早页面未水合）→ 允许重新读取；已有结果则不重复
    if (state.readFinished && (state.main.length || state.sku.length || state.desc.length || videoList().length)) return;   // v1.2.292
    if (state.readFinished) { state.readFinished = false; state.deepRetried = false; }
    state.reading = true;
    try { state.__readUrl = location.href; } catch (eRU) {}   // v1.2.332：记录本次读取对应的 URL（供换商品 watcher 判重）
    try { descWaitStart(); } catch (eDW) {} // v1.2.263：详情图未出来前先挂上常驻「加载中」提示
    state.__pddStable = 0; state.__pddTail = false; // v1.2.194/v1.2.195：PDD 收敛计数与尾巴补扫标记随每次读取重置
    state.__jdLazyDone = false; // v1.2.252：JD 主动滚动的一次性守卫，随每次读取重置
    if (!silent) {
      try { var panel = $('ais-panel'); if (panel) panel.classList.remove('ais-minimized'); } catch (e) {}
      status('正在读取商品图片…');
    }
    autoRead(!!manual);
  }

  // 全部 DOM 绑定：等面板 Shadow DOM 就绪后一次性完成
  // v1.2.182 面板拖拽：按住标题栏拖动 + 位置记忆 + 双击复位（此前完全没有拖拽实现）
  function initPanelDrag() {
    var panel = $('ais-panel'), handle = $('ais-header');
    if (!panel || !handle || handle.__dragBound) return;
    handle.__dragBound = true;
    handle.style.cursor = 'move';
    handle.title = '按住拖动面板 · 双击复位';
    var dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
    function apply(l, t) {
      var W = window.innerWidth || 1024, H = window.innerHeight || 768;
      var w = panel.offsetWidth || 560;
      var minL = 80 - w;                       // 至少保留 80px 可见
      var maxL = W - 80;
      l = Math.max(minL, Math.min(maxL, l));
      t = Math.max(0, Math.min(H - 40, t));
      panel.style.left = Math.round(l) + 'px';
      panel.style.top = Math.round(t) + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }
    function savePos() {
      try {
        var l = parseInt(panel.style.left, 10), t = parseInt(panel.style.top, 10);
        if (!isNaN(l) && !isNaN(t)) storeSet({ aisPanelPos: { left: l, top: t } });
      } catch (e) {}
    }
    function onMove(e) { if (!dragging) return; apply(ox + (e.clientX - sx), oy + (e.clientY - sy)); if (e.cancelable) e.preventDefault(); }
    function onUp() {
      if (!dragging) return;
      dragging = false; savePos();
      try { window.removeEventListener('mousemove', onMove, true); window.removeEventListener('mouseup', onUp, true); } catch (e) {}
    }
    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return;
      if (panel.classList.contains('ais-sidebar-mode') || panel.classList.contains('ais-minimized')) return;
      var tgt = e.target;
      if (tgt && tgt.closest && tgt.closest('button,a,input,select,.ais-topnav-act')) return;
      var r = panel.getBoundingClientRect();
      dragging = true; sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { window.addEventListener('mousemove', onMove, true); window.addEventListener('mouseup', onUp, true); } catch (e2) {}
      if (e.cancelable) e.preventDefault();
    });
    handle.addEventListener('dblclick', function () {
      panel.style.left = ''; panel.style.top = ''; panel.style.right = '0'; panel.style.bottom = '0';
      try { storeSet({ aisPanelPos: null }); } catch (e) {}
      aisToast('面板位置已复位（贴右侧）', 'info');
    });
    storeGet('aisPanelPos').then(function (pos) {
      try {
        if (pos && typeof pos.left === 'number' && typeof pos.top === 'number') {
          var W = window.innerWidth || 1024, H = window.innerHeight || 768;
          if (pos.left < W - 60 && pos.top < H - 40) apply(pos.left, pos.top);
        }
      } catch (e) {}
    });
  }
  function bindUI() {
    if (state.bound) return;
    state.bound = true;
    // 包装 showSubview：images 子视图开关
    try {
      var origShow = showSubview;
      showSubview = function (view) {
        origShow(view);
        try {
          var im = $('ais-subview-images');
          if (im) im.style.display = (view === 'images') ? '' : 'none';
        } catch (e) {}
      };
    } catch (e) {}
    // 页签
    var tImg = $('aisimg-tab-img'), tSku = $('aisimg-tab-sku'), tRev = $('aisimg-tab-review'), tHis = $('aisimg-tab-history');
    try { refreshHisTabCount(); } catch (eHC) {}
    if (tImg) tImg.addEventListener('click', function () { switchTab('img'); });
    // v1.2.222：拼多多 SKU 采集已按用户要求整体下线——商品页隐藏「SKU采集」页签（仿 v1.1.172 京东评论页签做法）
    var __pddSkuOff = /yangkeduo\.com|pinduoduo\.com/.test(location.href);
    if (__pddSkuOff) { try { tSku.style.display = 'none'; } catch (eTSk) {} }
    if (tSku && !__pddSkuOff) tSku.addEventListener('click', function () { switchTab('sku'); renderSku(); });
    if (tHis) tHis.addEventListener('click', function () { switchTab('history'); });
    // v1.1.172：京东评论采集已下线——隐藏评论页签并停用切换
    if (tRev && /jd\.com|3\.cn/.test(location.href)) { try { tRev.style.display = 'none'; } catch (eTR) {} }
    if (tRev && !/jd\.com|3\.cn/.test(location.href)) tRev.addEventListener('click', function () { switchTab('review'); });
    // 过滤 chips
    var chipsEl = $('aisimg-chips');
    if (chipsEl) chipsEl.addEventListener('click', function (e) {
      var c = e.target && e.target.closest ? e.target.closest('.aisimg-chip') : null;
      if (!c) return;
      state.filter = c.getAttribute('data-imgfilter') || 'all';
      chipsEl.querySelectorAll('.aisimg-chip').forEach(function (x) { x.classList.toggle('active', x === c); });
      var sa = $('aisimg-selall'); if (sa) sa.checked = false;
      render();
    });
    // v1.2.293 尺寸筛选（选择记忆到 storage）
    try {
      var msEl = $('aisimg-minsize');
      if (msEl) {
        msEl.addEventListener('change', function () {
          state.minSize = parseInt(msEl.value, 10) || 0;
          try { storeSet({ aisMinSize: state.minSize }); } catch (e0) {}
          try { var sa2 = $('aisimg-selall'); if (sa2) sa2.checked = false; } catch (e1) {}
          render();
        });
        try {
          var fcEl2 = $('aisimg-filterclear');
          if (fcEl2) fcEl2.addEventListener('click', function () { state.minSize = 0; try { storeSet({ aisMinSize: 0 }); } catch (e0) {} msEl.value = '0'; render(); });   // v1.2.295
        } catch (eFC2) {}
        try {
          storeGet('aisMinSize').then(function (v) {
            if (v != null) { state.minSize = parseInt(v, 10) || 0; msEl.value = String(state.minSize); try { render(); } catch (e2) {} }
          });
        } catch (e3) {}
      }
    } catch (eMS) {}
    // 全选 / 批量下载 / 复制
    var sa2 = $('aisimg-selall');
    if (sa2) sa2.addEventListener('change', function () {
      var on = sa2.checked;
      D().querySelectorAll('.aisimg-cardchk').forEach(function (cb) { cb.checked = on; });
      updateSelCnt();
    });
    // v1.2.409：修「全选点一次后立刻自动取消 / 要点两下」——label 包裹 input 时，
    // 点在文字上会由 label 转发一次、某些父级点击处理器又触发一次 → 净效果为 0（有时需要点两下）。
    // 这里把切换权收归自己：点 label（非 input 本体）时 preventDefault 阻止默认转发，手动切一次并派发 change；
    // 同时 stopPropagation 阻断冒泡，避免底部栏/面板上的其他 click 处理器再来一次。
    try {
      var __saLab = (sa2.closest ? sa2.closest('.aisimg-selall') : null);
      if (__saLab && !__saLab.__aisSaBound) {
        __saLab.__aisSaBound = 1;
        __saLab.addEventListener('click', function (e) {
          if (e.target === sa2) { e.stopPropagation(); return; }   // 点在复选框本体：交给原生切换，只拦冒泡
          e.preventDefault();
          e.stopPropagation();
          sa2.checked = !sa2.checked;
          try { sa2.dispatchEvent(new Event('change', { bubbles: true })); } catch (eC) {}
        });
      }
    } catch (eSaLab) {}
    try { document.addEventListener('ui:show', function (ev) { var t = ev && ev.detail; if (t === 'review' || t === 'img' || t === 'sku' || t === 'history') { revealPanel(); switchTab(t); } }); } catch (e) {}
    try { D().addEventListener('ui:show', function (ev) { var t = ev && ev.detail; if (t === 'review' || t === 'img' || t === 'sku' || t === 'history') { revealPanel(); switchTab(t); } }); } catch (e) {}
    // v1.2.180：接收「商品页主世界」的长图拼接进度
    try {
      window.addEventListener('img:progress', function (ev) {
        var d = (ev && ev.detail) || {};
        var w = $('aisimg-progwrap');
        if (!w || w.style.display === 'none') progShow(state.__dlTitle || '详情长图下载');
        progSet(d.done || 0, d.total || 0, '页面内抓取拼接中' + (d.failed ? ' · 跳过失败 ' + d.failed + ' 张' : ''));
      });
    } catch (eLP) {}
    // v1.2.180：接收后台/offscreen 的下载进度（抓取/落盘/压缩/长图渲染）
    try {
      chrome.runtime.onMessage.addListener(function (msg) {
        if (!msg || msg.action !== 'aisDlProgress') return;
        var km = { fetch: '抓取图片', save: '写入文件', zip: '压缩打包', render: '生成长图' };
        var w = $('aisimg-progwrap');
        if (!w || w.style.display === 'none') progShow(state.__dlTitle || '下载中');
        state.__dlLast = Date.now();   // v1.2.464：看门狗心跳（每条进度都刷新）
        if (msg.phase === 'zip' && msg.percent != null) { progSet(0, 0, '正在压缩 ZIP…', msg.percent); return; }
        // v1.2.464：压缩完成后的「写文件」阶段（带体积），不再让面板停在「正在压缩 ZIP…」
        if (msg.phase === 'save' && msg.percent != null) {
          var szTxt = '';
          if (msg.size) szTxt = '（' + (msg.size >= 1048576 ? (msg.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(msg.size / 1024)) + ' KB') + '）';
          progSet(msg.done || 0, msg.total || 0, '正在写入 ZIP 文件' + szTxt, msg.percent);
          return;
        }
        var note = km[msg.phase] || '处理中';
        if (msg.failed) note += ' · 已跳过失败 ' + msg.failed + ' 张';
        progSet(msg.done || 0, msg.total || 0, note);
      });
      // v1.2.464【卡死看门狗】进度条可见但 45 秒没有任何新进度 ⇒ 收起进度条 + 明确提示，
      //   不再永久停在「正在压缩 ZIP…」（隐藏时该定时器什么都不做）
      try {
        if (!state.__dlWatch) {
          state.__dlWatch = setInterval(function () {
            try {
              var w2 = $('aisimg-progwrap');
              if (!w2 || w2.style.display === 'none') return;
              if (!state.__dlLast) state.__dlLast = Date.now();
              if (Date.now() - state.__dlLast > 45000) {
                state.__dlLast = Date.now();
                progHide(200);
                aisToast('打包超时未返回：后台可能仍在处理，请稍后看下载目录；若一直没文件请重试', 'warn');
              }
            } catch (eW) {}
          }, 10000);
        }
      } catch (eW0) {}
    } catch (eProg) {}
    // v1.2.338：远程规则更新（服务器下发）后立即重渲染 + 重算计数 + 重置平台名（全程无需刷新页面）
    try {
      window.addEventListener('cfg:sync', function () {
        try { render(); } catch (eR1) {}
        try { updateCounts(); } catch (eR2) {}
        try { updatePlatformInfo(0); } catch (eR3) {}
      });
    } catch (eRU) {}
    try { window.addEventListener('aisimg-dump', function () {
      window.dispatchEvent(new CustomEvent("ui:state", { detail: {
        main: state.main.length, sku: state.sku.length, desc: state.desc.length, video: videoList().length,   // v1.2.292
        skuRows: state.skuRows.length, reviews: state.reviews.length,
        neg: state.analysis ? state.analysis.negativeCount : -1, descUrl: state.descUrl || ""
      } }));
    }); } catch (e) {}
  var x1 = $('aisimg-skuexp-csv'); if (x1) x1.addEventListener('click', function () { exportSku('csv'); });
    var x2 = $('aisimg-skuexp-xlsx'); if (x2) x2.addEventListener('click', function () { exportSku('xlsx'); });
    var x3 = $('aisimg-skuexp-json'); if (x3) x3.addEventListener('click', function () { exportSku('json'); });
    var x4 = $('aisimg-propexp'); if (x4) x4.addEventListener('click', exportPropsCsv); // v1.1.148
    var x5 = $('aisimg-sizeexp'); if (x5) x5.addEventListener('click', exportSizeCsv); // v1.1.148
    var intBtn = $('aisimg-integrated'); if (intBtn) intBtn.addEventListener('click', exportIntegratedPack);   // v1.2.268 整合包
    var lstBtn = $('aisimg-listing'); if (lstBtn) lstBtn.addEventListener('click', exportListing);
    var matBtn = $('aisimg-material'); if (matBtn) matBtn.addEventListener('click', exportMaterialZip);
    var liBtn = $('aisimg-btn-longimg'); if (liBtn) liBtn.addEventListener('click', exportLongImage);
    // v1.2.416【修复死按钮】：此处原为 $('ui:openfolder') —— 该 id 在全项目中【根本不存在】，
    // 真按钮是 panel.html 的 id="aisimg-openfolder"（v1.2.181 加回），于是监听器从未挂上 → 点了没任何反应。
    // 现按真实 id 绑定，并额外用 .aisimg-setopen 类兜底（防以后再被改 id/改名弄死）。
    var ofb2 = $('aisimg-openfolder') || D().querySelector('.aisimg-setopen');
    if (ofb2 && !ofb2.__aisOfBound) {
      ofb2.__aisOfBound = 1;
      ofb2.addEventListener('click', function () {
        // v1.2.416 真机实证：内容脚本里【拿不到 chrome.downloads】
        //（实测 {有downloads:false,有show:false,有showDefaultFolder:false}），
        // 所以打开目录必须由 SW 代劳 —— 一律走 openDownloadFolder 消息，id 可为 null（=默认目录）。
        var hasId = (state.lastDownloadId != null);
        sendBg({ action: 'openDownloadFolder', id: hasId ? state.lastDownloadId : null }).then(function (r) {
          if (r && r.ok) { aisToast(hasId ? '已打开下载所在文件夹' : '已打开浏览器默认下载目录', 'info'); return; }
          aisToast('打开失败：' + ((r && r.error) || '未知错误') + '（可手动打开浏览器默认下载目录）', 'error');
        }).catch(function () {
          aisToast('打开失败：扩展后台无响应', 'error');
        });
      });
    }
    try { initPanelDrag(); } catch (eDrag) {}
    // v1.2.183 顶栏「⋯」更多菜单
    try {
      // v1.2.284：每个绑定各自 try —— 任一失败不影响其它按钮；处理函数经 window 取，避免作用域 ReferenceError
      try { var scBtn = $('ais-btn-shortcut'); if (scBtn) scBtn.addEventListener('click', function () { var f = window.startShortCapture; if (typeof f === 'function') f(); }); } catch (e1) {}
      try { var scRst = $('ais-btn-shortreset'); if (scRst) scRst.addEventListener('click', function () { var f = window.resetShortcuts; if (typeof f === 'function') f(); }); } catch (e2) {}
      try { var hb = $('ais-btn-help'); if (hb) hb.addEventListener('click', function () { var f = window.helpModal; if (typeof f === 'function') f(); }); } catch (e3) {}
      var moreBtn = $('ais-btn-more'), morePanel = $('ais-nav-more');
      if (moreBtn && morePanel) {
        moreBtn.addEventListener('click', function (e) { e.stopPropagation(); morePanel.classList.toggle('open'); });
        window.addEventListener('click', function (ev) {
          if (!morePanel.classList.contains('open')) return;
          var path = (ev.composedPath && ev.composedPath()) || [];
          if (path.indexOf(moreBtn) > -1 || path.indexOf(morePanel) > -1) return;
          morePanel.classList.remove('open');
        }, true);
        Array.prototype.forEach.call(morePanel.querySelectorAll('.ais-nav-more-row, .ais-topnav-item'), function (el) {
          el.addEventListener('click', function () { morePanel.classList.remove('open'); });
        });
      }
    } catch (eMore) {}
    // v1.2.184 深色模式（⋯ 菜单），记忆到 storage
    try {
      var themeBtn = $('ais-btn-theme'), rootEl = $('ai-scraper-root');
      var applyTheme = function (dark) {
        var v = dark ? 'dark' : 'light';
        if (rootEl) rootEl.setAttribute('data-ais-theme', v);
        try { if (window.__AIS_SHADOW_HOST__) window.__AIS_SHADOW_HOST__.setAttribute('data-ais-theme', v); } catch (eSH) {}
        if (themeBtn) themeBtn.textContent = dark ? '浅色模式' : '深色模式';
      };
      if (themeBtn) themeBtn.addEventListener('click', function () {
        var next = !(rootEl && rootEl.getAttribute('data-ais-theme') === 'dark');
        applyTheme(next);
        storeSet({ aisTheme: next ? 'dark' : 'light' });
        aisToast(next ? '已切换深色模式' : '已切换浅色模式', 'info');
      });
      storeGet('aisTheme').then(function (v) { applyTheme(v === 'dark'); });
    } catch (eTh) {}
    // v1.2.183 图片密度切换（舒适 3 列 / 紧凑 4 列），记忆到 storage
    try {
      var colBtn = $('aisimg-colmode'), gridCols = $('aisimg-grid');
      var applyCols = function (compact) {
        if (gridCols) gridCols.classList.toggle('aisimg-compact', !!compact);
        if (colBtn) { colBtn.textContent = compact ? '舒适' : '紧凑'; colBtn.classList.toggle('active', !!compact); }
      };
      if (colBtn) colBtn.addEventListener('click', function () {
        var next = !(gridCols && gridCols.classList.contains('aisimg-compact'));
        applyCols(next);
        storeSet({ aisGridCompact: next });
        aisToast(next ? '已切换为紧凑模式（4 列）' : '已切换为舒适模式（3 列）', 'info');
      });
      storeGet('aisGridCompact').then(function (v) { applyCols(v === undefined || v === null ? true : !!v); });
    } catch (eCol) {}
    // v1.2.182：面板 DOM 可能晚于 bindUI 就绪 → 轮询补齐拖拽挂载
    try {
      var __dragTries = 0;
      var __dragTimer = setInterval(function () {
        __dragTries++;
        try { initPanelDrag(); } catch (e) {}
        var hh = null;
        try { hh = $('ais-header'); } catch (e2) {}
        if ((hh && hh.__dragBound) || __dragTries > 120) clearInterval(__dragTimer);
      }, 150);
    } catch (eDT) {}
    var pcsv = $('aisimg-pkgcsv'); if (pcsv) pcsv.addEventListener('click', function () { downloadManifest('csv'); });
    var pxls = $('aisimg-pkgxlsx'); if (pxls) pxls.addEventListener('click', function () { downloadManifest('xlsx'); });
    var dl = $('aisimg-dlsel'); if (dl) dl.addEventListener('click', dlBatch);
    // v1.2.234：下载设置变化 → 同步（ZIP 勾选直接决定底部按钮动词）
    try {
      var _zEl = $('aisimg-zip'); if (_zEl) _zEl.addEventListener('change', syncDownloadSettings);
      // v1.2.297：新增设置项的同步触发源
      var _nEl = $('aisimg-nest'); if (_nEl) _nEl.addEventListener('change', syncDownloadSettings);
      var _pmEl = $('aisimg-prefixmode'); if (_pmEl) _pmEl.addEventListener('change', syncDownloadSettings);
      var _ptEl = $('aisimg-prefixtext'); if (_ptEl) _ptEl.addEventListener('input', syncDownloadSettings);
      // v1.2.297：设置折叠（调整 ▾）+ 筛选弹层 + 排序
      try {
        var adjBtn = $('aisimg-setadjust'), setBody = $('aisimg-setbody');
        if (adjBtn && setBody) adjBtn.addEventListener('click', function () {
          var open = setBody.style.display !== 'none';
          setBody.style.display = open ? 'none' : '';
          adjBtn.textContent = open ? '调整 ▾' : '收起 ▴';
          try { syncDownloadSettings(); } catch (e0) {}
        });
      } catch (eAdj) {}
      try {
        var fBtn = $('aisimg-filterbtn'), fMenu = $('aisimg-filtermenu');
        if (fBtn && fMenu) fBtn.addEventListener('click', function () { fMenu.classList.toggle('open'); });
        var sMode = $('aisimg-sortmode');
        if (sMode) sMode.addEventListener('change', function () {
          state.sortMode = parseInt(sMode.value, 10) || 0;
          try { storeSet({ aisSortMode: state.sortMode }); } catch (e1) {}
          if (fMenu) fMenu.classList.remove('open');
          render();
        });
        var msEl0 = $('aisimg-minsize');
        if (msEl0) msEl0.addEventListener('change', function () { if (fMenu) fMenu.classList.remove('open'); });
        storeGet('aisSortMode').then(function (v) { if (v != null) { state.sortMode = parseInt(v, 10) || 0; if (sMode) sMode.value = String(state.sortMode); } });
      } catch (eFlt) {}
      var _fEl = $('aisimg-format'); if (_fEl) _fEl.addEventListener('change', syncDownloadSettings);
      var _sEl = $('aisimg-scale'); if (_sEl) _sEl.addEventListener('change', syncDownloadSettings);
      syncDownloadSettings();
    } catch (eDS) {}
    var gselAll = $('aisimg-grpselall');
    if (gselAll) gselAll.addEventListener('change', function () {
      var on = gselAll.checked;
      grpChecks(state.filter).forEach(function (x) { x.cb.checked = on; });
      updateSelCnt();
    });
    var gpkBtn = $('aisimg-grppkg');
    if (gpkBtn) gpkBtn.addEventListener('click', function () { dlGroup(state.filter); });
    var rv1 = $('aisimg-revstart'); if (rv1) rv1.addEventListener('click', startRevCollect);
    var rv2 = $('aisimg-revstop'); if (rv2) rv2.addEventListener('click', function () { state.revStop = true; rv2.textContent = '正在停止...'; rv2.disabled = true; });
    try { (function () { var syncCur = function () { var s3 = getRevScope(); var c3 = $('aisimg-revcur'); if (c3) c3.textContent = s3.mode === 'all' ? '当前：采集全部评论（滚动翻页到底）' : ('当前：只采集前 ' + (s3.limit || 50) + ' 条'); }; syncCur(); var lim = $('aisimg-revlimit'); if (lim) lim.addEventListener('change', syncCur); })(); } catch (eCur) {}
    try { Array.prototype.forEach.call(D().querySelectorAll('[name=aisimg-revscope]'), function (r3) { r3.addEventListener('change', function () { var s3 = getRevScope(); var c3 = $('aisimg-revcur'); if (c3) c3.textContent = s3.mode === 'all' ? '当前：采集全部评论（滚动翻页到底）' : '当前：只采集前 ' + s3.limit + ' 条'; }); }); } catch (e) {}
    var rv3 = $('aisimg-revexp-csv'); if (rv3) rv3.addEventListener('click', function () { revExport('csv'); });
    var rv4 = $('aisimg-revexp-xlsx'); if (rv4) rv4.addEventListener('click', function () { revExport('xlsx'); });
    var rv5 = $('aisimg-revexp-json'); if (rv5) rv5.addEventListener('click', function () { revExport('json'); });
    var wcb = $('aisimg-wdj-on'); if (wcb) wcb.addEventListener('change', function () { try { renderWdj(); } catch (eWc) {} }); // v1.2.224 问答开关
    try { syncWdjUi(); } catch (eWU) {} // v1.2.239：非淘宝/天猫隐藏问大家整块 UI
    var wex1 = $('aisimg-wdjexp-csv'); if (wex1) wex1.addEventListener('click', function () { try { wdjExport('csv'); } catch (eWx) { status('问大家 CSV 导出失败：' + eWx.message); } });
    var wex2 = $('aisimg-wdjexp-xlsx'); if (wex2) wex2.addEventListener('click', function () { try { wdjExport('xlsx'); } catch (eWy) { status('问大家 Excel 导出失败：' + eWy.message); } });
    var wex3 = $('aisimg-wdjexp-json'); if (wex3) wex3.addEventListener('click', function () { try { wdjExport('json'); } catch (eWz) { status('问大家 JSON 导出失败：' + eWz.message); } });
    var rv6 = $('aisimg-revimg'); if (rv6) rv6.addEventListener('click', revImagesDl);
    var rv7 = $('aisimg-revnegexp'); if (rv7) rv7.addEventListener('click', negAnalysisExport);
    // v1.2.307：差评「判错了」纠错入口 —— 调 AisReviewJudge.feedback()，在线学习（SGD）+ 样本落盘
    var negJ = $('aisimg-revneg');
    if (negJ && !negJ.__judgeBound) {
      negJ.__judgeBound = true;
      negJ.addEventListener('click', function (ev) {
        var t = ev.target; if (!t || !t.classList || !t.classList.contains('aisimg-judgewrong')) return;
        ev.preventDefault(); ev.stopPropagation();
        try {
          var idx = String(t.getAttribute('data-idx') || '');
          var rv = (state.__judgeIdx || {})[idx];
          if (!rv) { if (typeof status === 'function') status('未找到该条评论数据'); return; }
          if (!window.AisReviewJudge || !window.AisReviewJudge.feedback) { if (typeof status === 'function') status('判定引擎未加载'); return; }
          var out = window.AisReviewJudge.feedback({ content: rv.content, rating: rv.rating, skuInfo: rv.skuInfo, time: rv.time }, false, 'panel-misjudge');
          t.textContent = '已学习'; t.disabled = true; t.style.opacity = '0.6';
          if (typeof status === 'function') status('已纠正 1 条（样本 ' + (out && out.samples) + '）· 判定引擎已更新');
        } catch (eJW) { if (typeof status === 'function') status('纠错失败：' + (eJW && eJW.message ? eJW.message : eJW)); }
      });
    }
    var negC = $('aisimg-revneg');
    if (negC) negC.addEventListener('input', function (e) { var t4 = e.target; if (!t4 || t4.id !== 'aisimg-negfilter') return; var kw = String(t4.value || '').trim(); var items = negC.querySelectorAll('.nitem'); for (var qi = 0; qi < items.length; qi++) { var it = items[qi]; it.style.display = (!kw || it.textContent.indexOf(kw) > -1) ? '' : 'none'; } });
    var cp = $('aisimg-copyall'); if (cp) cp.addEventListener('click', copyAll);
    try { var isb = $('aisimg-imgsrch'); if (isb) isb.addEventListener('click', function () { var f = window.imgSearch; if (typeof f === 'function') f(); }); } catch (eIS) {}   // v1.2.284
    // 栅格事件委托
    var gridEl = $('aisimg-grid');
    if (gridEl) {
      gridEl.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.classList && t.classList.contains('aisimg-dl1')) dlOne(t.getAttribute('data-url'), t.getAttribute('data-type'));
      });
      gridEl.addEventListener('change', function (e) {
        var t = e.target;
        if (t && t.classList && t.classList.contains('aisimg-cardchk')) updateSelCnt();
      });
    }
    var deep = $('aisimg-btn-deep');
    if (deep) deep.addEventListener('click', function () { showSubview('detail'); });
    var ref = $('aisimg-btn-refresh');
    if (ref) ref.addEventListener('click', function () {
      state.main = []; state.sku = []; state.desc = []; state.video = ''; state.videos = []; state.descUrl = ''; state.skuRows = []; state.__pddGalTries = 0; state.__pddGalLocked = 0; state.skuValueImgs = []; state.skuPropNames = []; state.pkgPreview = null;
      try { var _pc = $('aisimg-pkgcard'); if (_pc) _pc.style.display = 'none'; } catch (ePC) {}
      state.grpPkgDone = {}; state.grpPkgSig = {}; state.grpPkgZip = {}; // v1.1.145 重读商品清本组打包状态与内容签名
      state.descFetched = false; state.readFinished = false; state.deepRetried = false; state.reviews = []; state.analysis = null; state.revTriedSsr = false; state.itemProps = []; state.sizeChart = [];
      render(); status('正在重新读取…'); startRead();
    });
    // 详情页手动入口拦截
    try {
      D().addEventListener('click', function (e) {
        var t = e.target;
        while (t && t.id !== 'ais-panel' && t !== D()) {
          if (t.id === 'ais-home-detail' || t.id === 'ais-nav-detail') {
            if (isDetail()) { e.stopPropagation(); e.preventDefault(); revealPanel(); showSubview('images'); startRead(); }
            return;
          }
          t = t.parentNode || t.parentElement;
        }
      }, true);
    } catch (e) {}
  }

  function bindWhenReady() {
    var tries = 0;
    var t = setInterval(function () {
      tries++;
      var grid = null;
      try { grid = $('aisimg-grid'); } catch (e) {}
      if (grid) {
        clearInterval(t);
        bindUI();
        // v1.1.41：不再自动读取——点悬浮球展开面板后才开始采集（state.openImages）
        if (state.pendingOpen) { state.pendingOpen = false; state.openImages(); }
        // v1.1.126：SPA 换商品检测——item 变更即清空上一件的全部面板状态（图片/分组/评论/拦截缓存），
        // 修复「打包下载本组一次后，其他页面仍显示上一件的分组/数据」（旧 itemId 因 extractMeta 只赋值一次而永不更新）
        if (!state.__itemWatch) {
          state.__itemWatch = setInterval(function () {
            try {
              if (state.collecting || state.revCollecting) return; // 采集中不动，避免清掉正在采的数据
              var m = location.href.match(/[?&]id=(\d+)/) || location.href.match(/offer\/(\d+)/) || location.href.match(/(\d{6,})\.html/) || location.href.match(/goods_id=(\d+)/); // v1.2.194：PDD goods_id（SPA 换商品检测）
              var nid = m ? m[1] : '';
              // v1.2.332 根因修复：真机京东实测——读取完成时状态行显示「主图 5 · SKU 2 · 详情 8」，
              // 随后本 watcher 因 itemId 漂移（旧值未更新或正则取到别的数字）误判「换商品」，
              // 把 state.main/sku/desc 整块清空并清掉拦截缓存 → 最终只剩被动补收的「详情 5 + 视频 1」，主图/SKU 恒为 0。
              // 现在：本次读取对应的 URL 未变 ⇒ 同一页面，绝不因 id 漂移清空结果（SPA 真换商品时 URL 必然变化）。
              if (nid && state.__readUrl && location.href === state.__readUrl) { state.itemId = nid; return; }
              if (nid && state.itemId && nid !== state.itemId) {
                state.itemId = nid; state.itemTitle = '';
                state.main = []; state.sku = []; state.desc = []; state.video = ''; state.videos = []; state.descUrl = ''; state.skuRows = []; state.__pddGalTries = 0; state.__pddGalLocked = 0; state.skuValueImgs = []; state.skuPropNames = []; state.pkgPreview = null;
      try { var _pc = $('aisimg-pkgcard'); if (_pc) _pc.style.display = 'none'; } catch (ePC) {} state.itemProps = []; state.sizeChart = []; state.grpPkgDone = {}; state.grpPkgSig = {}; state.grpPkgZip = {}; // v1.1.145 换商品清本组打包状态与内容签名
                state.descFetched = false; state.readFinished = false; state.deepRetried = false; state.filter = ''; state.__pddStable = 0; state.__pddTail = false; state.__pddRetried = false; // v1.2.194/195/196
                state.reviews = []; state.analysis = null; state.revTriedSsr = false;
                state.revProg = 0; state.revProgTotal = 0; state.revSavedCnt = 0; state.revSavedAt = 0;
                try {
                  var _ic = window.__AIS_IMG_COLLECTOR__;
                  if (_ic) { _ic.detailResponse = null; _ic.skuResponse = null; _ic.descResponse = null; _ic.reviewResponse = null; _ic.allResponses = []; }
                  var _dc = window.__detailCollector && window.__detailCollector._interceptedData;
                  if (_dc) _dc.reviewResponse = null;
                } catch (e2) {}
                try { render(); } catch (e3) {}
                try { renderReview(); } catch (e4) {}
                aisToast('已切换到新商品，上一件数据已清空', 'info');
              }
            } catch (e) {}
          }, 2000);
        }
      } else if (tries > 300) clearInterval(t);
    }, 100);
  }

  function init() {
    if (window.__AIS_IMG_INIT__) return;
    window.__AIS_IMG_INIT__ = true;
    // 晚到响应监听（window 级，任何时机都安全）
    window.addEventListener('ssr:ready', function (ev) {
      try {
        var d = ev && ev.detail; if (!d || !d.type) return;
        var P = window.__AIS_IMG_PARSER__; if (!P) return;
        if (d.type === "review") {
          var rvL = [];
          try { rvL = P.parseReviews(unwrap(d.data)) || []; } catch (e2a) {}
          if (!rvL.length && P.parseReviewsFromSsr) { try { rvL = P.parseReviewsFromSsr(JSON.stringify(unwrap(d.data)) || '') || []; } catch (e2b) {} }
          if (state.revCollecting && rvL.length && mergeReviews(rvL)) { analyzeReviews(); if (state.readFinished) { renderReview(); status('评论已更新：' + state.reviews.length + ' 条', true); } else revLiveRender(); }
        } else if (d.type === 'desc') {
          var pd = P.parseDescImages(unwrap(d.data));
          if (pd && pd.length && mergeDesc(pd, { allowGalleryDup: /(^|\.)(1688|taobao|tmall)\.com$/i.test(location.hostname) })) { render(); if (!state.readFinished) finishRead(); else status('详情图已更新：' + state.desc.length + ' 张', true); }
        } else if (d.type === 'mainimages') {
          // v1.2.375：官方主图专线（SSR res.item.images）。开关：common.mainFromSsr = on/off
          try {
            if (aisSel('common.mainFromSsr', 'on') !== 'off') {
              var miD = unwrap(d.data) || d.data || {};
              var miL = (miD && miD.images) || (miD && miD.data && miD.data.images) || [];
              if (miL && miL.length) { state.__mainApi = miL.slice(0, 60); try { render(); } catch (eMiR) {} }
            }
          } catch (eMi0) {}
        } else if (d.type === 'jdsku') {
          // v1.2.460【移植自电商宝 panel.js:2926】京东：pageConfig.product 的 colorSize + skus → skuBase
          //   → 与淘宝同一套 SKU 管线（落 SKU 图 + 规格表）。不依赖接口拦截 / DOM 类名 / 登录。
          try {
            var Pjd = window.__AIS_IMG_PARSER__;
            var jdpd = unwrap(d.data) || d.data || {};
            var baseJd2 = (Pjd && Pjd.jdPageConfigToSkuBase) ? Pjd.jdPageConfigToSkuBase(jdpd) : null;
            if (baseJd2 && baseJd2.skus && baseJd2.skus.length) {
              applySkuPayload({ data: { skuBase: baseJd2 } });
              if (state.readFinished) { try { render(); } catch (eJdR) {} }
            }
          } catch (eJd1) {}
        } else if (d.type === 'detail' || d.type === 'sku') {
          // v1.2.442【根因修复】SKU 载荷不再依赖「读取是否在跑」：拿到就落 SKU 图 + 规格表。
          // 旧逻辑在 !readFinished 时直接 return，注释假定「轮询会拾取」——但实测若没有读取在跑
          // （用户没点悬浮球/面板没打开）或读取已结束，这份数据就永远没人拾取 → SKU 恒为 0。
          try { applySkuPayload(unwrap(d.data)); } catch (eSk3) {}
          if (!state.readFinished) return; // 轮询会拾取（图片通道保持原行为）
          setTimeout(function () {
            try {
              var r = P.collectImages(unwrap(d.data), null);
              if (r) {
                var before = state.main.length + state.sku.length;
                state.main = uniq(state.main.concat(r.main || []));
                state.sku = uniq(state.sku.concat(jdCleanSku(r.sku || [])));       // v1.2.260
                if (state.main.length + state.sku.length > before) render();
              }
            } catch (e) {}
          }, 600);
        }
      } catch (e) {}
    }, true);
    // 手动打开入口：window 'ui:open' 事件（点击/脚本触发，不自动弹出）
    window.addEventListener('ui:open', function () {
      var tries = 0;
      var t = setInterval(function () {
        tries++;
        if (state.bound) { clearInterval(t); state.openImages(); }
        else if (tries > 150) clearInterval(t);
      }, 100);
    });
    // v1.2.442【根因修复】详情页一开始就挂上 SKU 晚到拾取：覆盖「用户没点悬浮球 ⇒ 从未 startRead」
    // 这一支（真机受控复现里正是它让面板停在「主图 5 / SKU 0」，而 DOM 桥里数据是齐的）。
    try { if (isDetail()) skuBridgePickup(); } catch (eSPi) {}
    // v1.2.461：京东详情页立刻试一次 DOM 规格区（不等 1s 轮询、也不依赖任何接口/全局对象）
    try { if (/(^|\.)jd\.com$/i.test(location.hostname)) jdDomSkuTry(); } catch (eJdI) {}
    bindWhenReady();
  }

  // v1.1.41：展开面板直达图片采集页签并按需启动读取（悬浮球/首页详情卡片/右键菜单统一入口）
  state.openImages = function () {
    try { var __n = 0; clearInterval(window.__aisLateRender); window.__aisLateRender = setInterval(function(){ __n++; if (__n > 6) { clearInterval(window.__aisLateRender); return; } try{ render(); }catch(e){} }, 5000); } catch (eLR) {}   // v1.2.391：多次延迟重渲染（5s×6=30s，确保异步数据到位）
    try { revealPanel(); } catch (eA) {}
    try { var stEl = $('ais-stepper'); if (stEl) stEl.style.display = 'none'; } catch (eSt2) {} // v1.2.182：图片工作台不需要列表采集步骤条
    try { showSubview('images'); } catch (eB) {}
    try { if (isDetail()) startRead(true, true); } catch (eC) {} // v1.1.72 / v1.2.252：悬浮球入口=手动，允许 JD 主动滚动；其余入口不滚
  };
  init();
  return state;
})();

// ===== v1.2.369：平台名就绪兜底（修「永久检测中」）=====
// 真机定位：v1.2.368 面板改内联注入后，注入时机提前到 panel.js 之前，
// content.js 的三重就绪信号（闩锁/回调/事件）全部在 panel.js 注册前发出 → updatePlatformInfo 一次都没被调用。
// 这里在 panel.js 全部函数定义完成后做有界补写（0/500/1500/3000ms，共 4 次，非轮询、不看门狗）。
try {
  var __aisPlatAssert = function () { try { updatePlatformInfo(0); } catch (ePA1) {} };
  __aisPlatAssert();
  setTimeout(__aisPlatAssert, 500);
  setTimeout(__aisPlatAssert, 1500);
  setTimeout(__aisPlatAssert, 3000);
} catch (ePA) {}

// ===== v1.2.446：授权标签就绪兜底（修「已注册却显示免费版」）=====
// 真机取证（受控伪淘宝页 + 真扩展，2026-10-07）：底层许可完全正常 ——
//   LicenseManager.getStatusSummary() ⇒ {status:'active', plan:'pro', daysRemaining:30, message:'专业版'}
// 但顶栏标签 `#ais-license-tag` 停在 HTML 默认文案「免费版」，**且 class 已经是 ais-license-status-active**
//   （⇒ updateLicenseTag 确实跑过、状态类也写进去了，但那次值没落到文本上，自相矛盾）。
// 手动 `window.dispatchEvent(new CustomEvent('ui:license'))` 后标签**立刻**变「专业版」
//   ⇒ 结论：初始化那一次调用的时机与面板 DOM/许可缓存就绪不同步，而除了 ui:license 事件之外**没有任何重试**。
// 处置（与 v1.2.369 平台名同一手法）：函数定义完成后做有界补写（0/600/1800/3600ms，共 4 次，非轮询）
//   + 监听 chrome.storage 的许可键变化（激活 / 续费 / 过期 / 撤销立刻刷新，不必等事件）。
try {
  var __aisLicAssert = function () { try { updateLicenseTag(); } catch (eLA1) {} };
  __aisLicAssert();
  setTimeout(__aisLicAssert, 600);
  setTimeout(__aisLicAssert, 1800);
  setTimeout(__aisLicAssert, 3600);
  try {
    if (chrome && chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(function (changes, area) {
        try {
          if (area !== 'local' || !changes) return;
          if (changes.ais_license_cache || changes.ais_license_code || changes.ais_license_istrial) __aisLicAssert();
        } catch (eLA2) {}
      });
    }
  } catch (eLA3) {}
} catch (eLic) {}
