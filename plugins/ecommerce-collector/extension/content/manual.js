// === 手动选择模式 ===
class ManualSelector {
  constructor() {
    this.isActive = false;
    this.overlay = null;
    this.currentHighlight = null;
    this._onMouseMove = this._onMouseMove.bind(this);
    this._onClick = this._onClick.bind(this);
    this._onKeyDown = this._onKeyDown.bind(this);
  }
  enable() {
    if (this.isActive) return;
    this.isActive = true;
    this.overlay = document.createElement('div');
    this.overlay.className = 'ai-scraper-overlay';
    this.overlay.id = 'ai-scraper-overlay';
    document.body.appendChild(this.overlay);
    document.addEventListener('mousemove', this._onMouseMove);
    document.addEventListener('click', this._onClick, true);
    document.addEventListener('keydown', this._onKeyDown);
    this._showTooltip('点击选择数据区域，按 ESC 取消');
  }
  disable() {
    if (!this.isActive) return;
    this.isActive = false;
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    document.removeEventListener('mousemove', this._onMouseMove);
    document.removeEventListener('click', this._onClick, true);
    document.removeEventListener('keydown', this._onKeyDown);
    this._removeHighlight();
    this._removeTooltip();
  }
  _onMouseMove(e) {
    if (!this.isActive) return;
    var target = this._findBestContainer(e.target);
    if (target && target !== this.currentHighlight) {
      this._removeHighlight();
      this._addHighlight(target);
      this.currentHighlight = target;
    }
  }
  _onClick(e) {
    if (!this.isActive) return;
    e.preventDefault();
    e.stopPropagation();
    var target = this._findBestContainer(e.target);
    if (!target) return;
    var selector = this._generateSelector(target);
    var tagName = target.tagName.toLowerCase();
    var classes = Array.from(target.classList).join(', ');
    this._removeHighlight();
    target.classList.add('ai-scraper-highlight-selected');
    chrome.runtime.sendMessage({
      action: 'containerSelected',
      selector: selector,
      info: { tag: tagName, classes: classes, childCount: target.children.length, textPreview: target.textContent.trim().substring(0, 50) }
    });
    var self = this;
    setTimeout(function() { target.classList.remove('ai-scraper-highlight-selected'); }, 500);
    this.disable();
  }
  _onKeyDown(e) {
    if (e.key === 'Escape') { this.disable(); chrome.runtime.sendMessage({ action: 'manualSelectCancelled' }); }
  }
  _findBestContainer(el) {
    var current = el, depth = 0;
    while (current && current !== document.body && depth < 10) {
      var tag = current.tagName.toLowerCase();
      var childCount = current.children.length;
      if (childCount >= 3 && ['div','ul','ol','table','section','article','main','tbody'].indexOf(tag) !== -1) return current;
      current = current.parentElement;
      depth++;
    }
    return null;
  }
  _generateSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    var dataAttrs = Array.from(el.attributes).filter(function(a) { return a.name.indexOf('data-') === 0; });
    if (dataAttrs.length > 0) {
      var attr = dataAttrs[0];
      return '[' + attr.name + '=' + JSON.stringify(attr.value) + ']';
    }
    var tag = el.tagName.toLowerCase();
    var classes = Array.from(el.classList).filter(function(c) { return c.length < 30 && c.indexOf(':') === -1; }).slice(0, 2);
    if (classes.length > 0) return tag + '.' + classes.map(function(c) { return CSS.escape(c); }).join('.');
    var parent = el.parentElement;
    if (parent) {
      var siblings = Array.from(parent.children).filter(function(c) { return c.tagName === el.tagName; });
      if (siblings.length > 1) return tag + ':nth-of-type(' + (siblings.indexOf(el) + 1) + ')';
    }
    return tag;
  }
  _addHighlight(el) { el.classList.add('ai-scraper-highlight'); }
  _removeHighlight() {
    if (this.currentHighlight) { this.currentHighlight.classList.remove('ai-scraper-highlight'); this.currentHighlight = null; }
  }
  _showTooltip(text) {
    this._removeTooltip();
    var tooltip = document.createElement('div');
    tooltip.id = 'ai-scraper-tooltip';
    tooltip.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#1e1b4b;color:white;padding:12px 24px;border-radius:12px;font-size:14px;z-index:2147483647;box-shadow:0 8px 32px rgba(0,0,0,0.3);pointer-events:none;font-family:sans-serif;';
    tooltip.textContent = text;
    document.body.appendChild(tooltip);
  }
  _removeTooltip() {
    var existing = document.getElementById('ai-scraper-tooltip');
    if (existing) existing.remove();
  }
}
window.__manualSelector = new ManualSelector();
