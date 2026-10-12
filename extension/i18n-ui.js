'use strict';
(function () {
  const select = document.getElementById('interfaceLanguage');
  const status = document.getElementById('languageStatus');
  DownloaderI18n.applyStatic(document);
  select.disabled = true;
  const controller = DownloaderI18n.createController({storage:chrome.storage.local});
  const say = key => DownloaderI18n.bind(status, 'textContent', () => DownloaderI18n.t(key));
  say('m_ae6f58aeae');
  controller.ready.then(result => {
    select.value = controller.choice; select.disabled = false;
    if (result.ok) DownloaderI18n.clear(status, 'textContent'); else say('m_18be4e2c2c');
  });
  select.addEventListener('change', async () => {
    const pending = controller.choose(select.value);
    say('m_737f187041');
    const result = await pending;
    if (result.current) say(result.ok ? 'm_678c6c8629' : 'm_c544fd2b45');
  });
  window.DownloaderLanguageUI = {controller};
})();
