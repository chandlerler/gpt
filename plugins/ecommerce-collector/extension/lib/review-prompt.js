// Shadow DOM 桥接（与 panel.js 一致）
function __AIS_DOC() {
  return (typeof window !== 'undefined' && window.__AIS_SHADOW__) ? window.__AIS_SHADOW__ : document;
}
// 电商采集大师 - 商店评论引导模块
// 合规：仅提示，不挂钩功能，不诱导特定评分，不骚扰
// 3层触发时机：
//   Layer 1: 完成1次列表采集 → Toast轻提示（仅文字）
//   Layer 2: 完成5次采集 → 小弹窗（有"不感兴趣"）
//   Layer 3: 完成详情页发布导出 → 中弹窗（分享裂变提示 + 评价入口）

var ReviewPrompt = {
  // Chrome Web Store 扩展ID（上架后替换为真实ID）
  // 本地测试用占位，上架后修改
  STORE_URL: 'https://chromewebstore.google.com/detail/nmmdfjoabpmhoaakoiclkppaokddijle',

  // 存储键
  STORAGE_KEY: 'ais_review_prompt_state',

  // 触发阈值
  THRESHOLDS: {
    LAYER1_LIST_COUNT: 1,     // 第1层：完成N次列表采集后
    LAYER2_TOTAL_COUNT: 5,    // 第2层：累计N次采集后
    LAYER3_DETAIL_EXPORT: 1   // 第3层：完成详情导出后
  },

  // 冷却时间（防止短时间重复弹，24小时）
  COOLDOWN_MS: 24 * 60 * 60 * 1000,

  // 初始化状态
  async _getState() {
    return new Promise((resolve) => {
      chrome.storage.local.get([this.STORAGE_KEY], (result) => {
        const state = result[this.STORAGE_KEY] || {
          listCollectCount: 0,       // 列表采集次数
          detailCollectCount: 0,     // 详情采集次数
          totalCollectCount: 0,      // 总采集次数
          detailExportCount: 0,      // 详情导出次数
          layer1ShownAt: null,       // 第1层上次展示时间
          layer2ShownAt: null,       // 第2层上次展示时间
          layer3ShownAt: null,       // 第3层上次展示时间
          dismissed: false,          // 用户是否选择"不再提示"
          reviewDone: false          // 用户是否已去过商店评价（本地记录，不可靠）
        };
        resolve(state);
      });
    });
  },

  async _saveState(state) {
    return new Promise((resolve) => {
      const data = {};
      data[this.STORAGE_KEY] = state;
      chrome.storage.local.set(data, () => resolve());
    });
  },

  // === 外部调用接口 ===

  // 每次列表采集成功后调用
  async onListCollectSuccess(itemCount) {
    const state = await this._getState();
    if (state.dismissed || state.reviewDone) return;

    state.listCollectCount++;
    state.totalCollectCount++;
    await this._saveState(state);

    // Layer 1：首次成功采集 → Toast
    if (state.listCollectCount === this.THRESHOLDS.LAYER1_LIST_COUNT &&
        (!state.layer1ShownAt || (Date.now() - state.layer1ShownAt) > this.COOLDOWN_MS)) {
      state.layer1ShownAt = Date.now();
      await this._saveState(state);
      this._showToast(
        `采集完成！${itemCount ? '共 ' + itemCount + ' 条数据' : ''} 觉得好用的话，欢迎去商店留个评价 👍`,
        '去评价'
      );
    }

    // Layer 2：累计5次 → 弹窗
    if (state.totalCollectCount === this.THRESHOLDS.LAYER2_TOTAL_COUNT &&
        (!state.layer2ShownAt || (Date.now() - state.layer2ShownAt) > this.COOLDOWN_MS)) {
      state.layer2ShownAt = Date.now();
      await this._saveState(state);
      this._showSmallModal();
    }
  },

  // 每次详情页采集成功后调用
  async onDetailCollectSuccess() {
    const state = await this._getState();
    if (state.dismissed || state.reviewDone) return;

    state.detailCollectCount++;
    state.totalCollectCount++;
    await this._saveState(state);

    // 也计入总采集数，触发Layer 2
    if (state.totalCollectCount === this.THRESHOLDS.LAYER2_TOTAL_COUNT &&
        (!state.layer2ShownAt || (Date.now() - state.layer2ShownAt) > this.COOLDOWN_MS)) {
      state.layer2ShownAt = Date.now();
      await this._saveState(state);
      this._showSmallModal();
    }
  },


  // 用户主动点击"不再提示"
  async markDismissed() {
    const state = await this._getState();
    state.dismissed = true;
    await this._saveState(state);
  },

  // 模拟用户已评价（本地记录，点击"已评价"按钮）
  async markReviewed() {
    const state = await this._getState();
    state.reviewDone = true;
    await this._saveState(state);
  },

  // 打开商店页面（点击后记录为"已去评价"）
  async openStore() {
    try {
      await this.markReviewed();
    } catch(e) {}
    // 新标签页打开商店
    if (window.chrome && chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: this.STORE_URL });
    } else {
      window.open(this.STORE_URL, '_blank');
    }
  },

  // === UI 组件 ===

  // Layer 1：轻量 Toast
  _showToast(message, btnText) {
    this._removeExisting('#ais-review-toast');

    const toast = document.createElement('div');
    toast.id = 'ais-review-toast';
    toast.className = 'ais-review-toast';
    toast.innerHTML = `
      <span class="ais-review-toast-msg">${message}</span>
      <button class="ais-review-toast-btn">${btnText}</button>
      <button class="ais-review-toast-close" aria-label="关闭">×</button>
    `;

    __AIS_DOC().appendChild(toast);
    // 动画进入
    requestAnimationFrame(() => toast.classList.add('ais-review-toast-show'));

    toast.querySelector('.ais-review-toast-btn').onclick = () => {
      toast.classList.remove('ais-review-toast-show');
      setTimeout(() => toast.remove(), 300);
      this.openStore();
    };
    toast.querySelector('.ais-review-toast-close').onclick = () => {
      toast.classList.remove('ais-review-toast-show');
      setTimeout(() => toast.remove(), 300);
    };

    // 6秒后自动消失
    setTimeout(() => {
      if (toast.parentNode) {
        toast.classList.remove('ais-review-toast-show');
        setTimeout(() => toast.remove(), 300);
      }
    }, 6000);
  },

  // Layer 2：小弹窗
  _showSmallModal() {
    this._removeExisting('.ais-review-modal');

    const modal = document.createElement('div');
    modal.className = 'ais-review-modal ais-review-modal-small';
    modal.innerHTML = `
      <div class="ais-review-modal-mask"></div>
      <div class="ais-review-modal-box">
        <div class="ais-review-modal-header">
          <div class="ais-review-modal-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
          </div>
          <h3>帮 电商采集大师 写个评价？</h3>
        </div>
        <p class="ais-review-modal-desc">
          您的每一条评价都能帮助更多用户发现这个工具，
          <br>也能让我们有动力持续迭代更新 🙏
        </p>
        <div class="ais-review-modal-actions">
          <button class="ais-review-btn ais-review-btn-secondary ais-review-later">稍后再说</button>
          <button class="ais-review-btn ais-review-btn-primary ais-review-go">去商店写评价</button>
        </div>
        <button class="ais-review-dismiss-all">不再提示</button>
      </div>
    `;

    this._bindModalEvents(modal, true);
    __AIS_DOC().appendChild(modal);
    setTimeout(() => modal.classList.add('ais-review-modal-show'), 10);
  },

  // Layer 3：分享裂变弹窗
  // 绑定弹窗通用事件
  _bindModalEvents(modal, isSmall) {
    const mask = modal.querySelector('.ais-review-modal-mask');
    const laterBtn = modal.querySelector('.ais-review-later');
    const goBtn = modal.querySelector('.ais-review-go');
    const dismissBtn = modal.querySelector('.ais-review-dismiss-all');

    const close = () => {
      modal.classList.remove('ais-review-modal-show');
      setTimeout(() => modal.remove(), 250);
    };

    // 点击遮罩 = 稍后再说（不是关闭全部，合规）
    mask.onclick = () => close();

    if (laterBtn) laterBtn.onclick = () => close();

    if (goBtn) {
      goBtn.onclick = () => {
        close();
        this.openStore();
      };
    }

    if (dismissBtn) {
      dismissBtn.onclick = () => {
        if (confirm('确定不再显示评价提示了吗？')) {
          this.markDismissed();
          close();
        }
      };
    }

    // ESC 关闭
    const escHandler = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', escHandler);
      }
    };
    document.addEventListener('keydown', escHandler);
  },

  // 移除已存在的同类型弹窗
  _removeExisting(selector) {
    __AIS_DOC().querySelectorAll(selector).forEach(el => el.remove());
  }
};

if (typeof window !== 'undefined') {
  window.ReviewPrompt = ReviewPrompt;
}
