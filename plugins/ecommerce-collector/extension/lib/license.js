// Compatibility API for the local distribution. No remote license requests.
var LicenseManager = {
  local: true,
  async getStatusSummary() { return { status: 'active', plan: 'local', message: '本地版', isTrial: false, unlimited: true }; },
  async getCachedLicense() { return { plan: 'local', code: '', features: this._getFeaturesByPlan(), unlimited: true }; },
  _getFeaturesByPlan() { return ['multi_page', 'batch_detail', 'excel_multi_sheet', 'publish_export', 'incremental', 'template_save', 'review_images', 'monitor', 'bi_export']; },
  async hasFeature(feature) { return this._getFeaturesByPlan().includes(feature); },
  async verify() { return { valid: true, local: true }; },
  async onlineRecheck() { return { checked: false, valid: true, local: true }; },
  async consumeQuota() { return { ok: true, unlimited: true, local: true }; },
  async getQuotaSummary() { return { unlimited: true, local: true }; },
  async isFreeDayNow() { return false; }
};
if (typeof window !== 'undefined') window.LicenseManager = LicenseManager;
