// Local capabilities information; no purchase or activation form.
var LicenseModal = {
  show() {
    var message = '本地采集、评论图片、ZIP、整合包、差评分析和导出无需激活，不设到期时间或每日付费额度。原作者云服务未接入；各平台访问限制、采集限速与用户设置仍适用。';
    if (typeof aisAlert === 'function') return aisAlert(message, { type: 'info' });
    if (typeof window !== 'undefined') window.alert(message);
  }
};
if (typeof window !== 'undefined') window.LicenseModal = LicenseModal;
