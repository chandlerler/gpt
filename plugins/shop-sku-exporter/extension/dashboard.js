import { downloadWorkbook } from './lib/xlsx.js';

const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;
const emptyState = () => ({ status: 'idle', phase: 'discover', discovery: {}, queue: [], rows: [], logs: [], settings: {} });
let state = emptyState();
let currentPage = 1;
let busy = false;
let toastTimer;
let refreshTimer;
let loadedSavedUrl = false;
const integer = new Intl.NumberFormat('zh-CN');
const money = new Intl.NumberFormat('zh-CN', { style: 'currency', currency: 'CNY', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const date = (value) => {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('zh-CN', { hour12: false });
};
const hasFinal = (row) => row.finalPrice !== null && row.finalPrice !== undefined && row.finalPrice !== '' && Number.isFinite(Number(row.finalPrice));
const displayPrice = (value) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) ? money.format(Number(value)) : '未确认';
const stringify = (value) => value == null || value === '' ? '—' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);

function toast(message, isError = false) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').classList.toggle('error', isError);
  $('toast').hidden = false;
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, isError ? 7500 : 4000);
}

async function send(type, payload = {}, message = '') {
  if (busy && type !== 'GET_STATE') return null;
  if (type !== 'GET_STATE') { busy = true; renderControls(); }
  try {
    const result = await chrome.runtime.sendMessage({ type, ...payload });
    if (!result?.ok) throw new Error(result?.error || '插件未能完成请求，请刷新页面重试。');
    if (result.state) {
      state = { ...emptyState(), ...result.state };
      if ((!loadedSavedUrl || !$('shop-url').value || type === 'SCAN_ACTIVE') && state.shopUrl) $('shop-url').value = state.shopUrl;
      loadedSavedUrl = true;
      render();
    }
    if (message) toast(message);
    return result;
  } catch (error) {
    toast(error.message || String(error), true);
    return null;
  } finally {
    if (type !== 'GET_STATE') { busy = false; renderControls(); }
  }
}

function renderControls() {
  const running = state.status === 'running';
  const resumable = ['paused', 'error'].includes(state.status) || (state.status === 'idle' && state.queue?.some((item) => item.status === 'pending'));
  const failures = state.queue?.some((item) => item.status === 'failed');
  $('start-button').disabled = busy || running;
  $('shop-url').disabled = running;
  $('scan-button').disabled = busy || running;
  $('pause-button').hidden = !running;
  $('resume-button').hidden = !resumable;
  $('retry-button').hidden = !failures || running;
  $('open-tab-button').hidden = !state.workerTabId;
  for (const id of ['pause-button', 'resume-button', 'retry-button', 'import-button', 'reset-button']) $(id).disabled = busy;
  $('import-button').disabled = busy || running;
  $('reset-button').disabled = busy || running;
  $('export-button').disabled = busy || !(state.rows?.length || state.queue?.length);
}

function render() {
  const queue = state.queue || [];
  const rows = state.rows || [];
  const processed = queue.filter((item) => ['done', 'failed', 'skipped'].includes(item.status)).length;
  const done = queue.filter((item) => item.status === 'done').length;
  const failures = queue.filter((item) => item.status === 'failed').length;
  const skipped = queue.filter((item) => item.status === 'skipped').length;
  const confirmed = rows.filter(hasFinal).length;
  const statusText = { idle: '等待开始', running: '正在采集', paused: '已暂停', completed: '队列已完成', error: '需要处理' };
  $('task-status').className = `status-badge ${Object.hasOwn(statusText, state.status) ? state.status : 'idle'}`;
  $('task-status').replaceChildren(document.createElement('i'), document.createTextNode(statusText[state.status] || '等待开始'));
  $('metric-items').textContent = integer.format(queue.length);
  $('metric-item-note').textContent = state.shopName || (queue.length ? '已去重的商品链接' : '等待获取店铺商品');
  $('metric-done').replaceChildren(document.createTextNode(integer.format(processed)), Object.assign(document.createElement('span'), { textContent: ` / ${integer.format(queue.length)}` }));
  $('metric-fail-note').textContent = queue.length ? `成功 ${integer.format(done)}${failures ? ` · 失败 ${integer.format(failures)}` : ''}${skipped ? ` · 跳过 ${integer.format(skipped)}` : ''}` : '暂无失败记录';
  $('metric-skus').textContent = integer.format(rows.length);
  $('metric-prices').textContent = integer.format(confirmed);
  $('metric-price-note').textContent = rows.length ? `${integer.format(rows.length - confirmed)} 条到手价待确认` : '仅统计明确对应 SKU 的价格';
  $('row-count').textContent = integer.format(rows.length);
  const discovery = state.discovery || {};
  const title = state.status === 'running' ? state.phase === 'discover' ? '正在发现店铺商品' : '正在逐个读取商品 SKU' : state.status === 'paused' ? '任务已暂停，可随时继续' : state.status === 'completed' ? '当前队列已处理完成' : state.status === 'error' ? '任务需要处理后继续' : queue.length ? '商品已加入队列，准备采集' : '准备就绪，等待开始';
  $('progress-title').textContent = title;
  $('progress-note').textContent = queue.length ? `已读取 ${discovery.pages || 0} 个列表页 · 已处理 ${processed} / ${queue.length} 件商品${failures ? ` · ${failures} 件失败，可单独重试` : ''}` : '采集时请保持浏览器开启，数据会自动保存在本地。';
  const percent = queue.length ? Math.round(processed / queue.length * 100) : 0;
  $('progress-bar').style.width = `${percent}%`;
  $('progress-bar').parentElement.setAttribute('aria-valuenow', String(percent));
  $('progress-bar').parentElement.setAttribute('aria-valuetext', `已处理 ${processed} 件，共发现 ${queue.length} 件商品`);
  const expected = discovery.expectedTotal != null ? ` / 页面标示约 ${discovery.expectedTotal} 件` : '';
  $('coverage-note').textContent = `覆盖范围：${discovery.note || (discovery.complete ? '已到达可识别的列表末页，仍请核对商品总数' : queue.length || state.status !== 'idle' ? '尚未确认全店覆盖' : '尚未开始')}${expected}`;
  $('updated-note').textContent = state.updatedAt ? `保存于 ${date(state.updatedAt)}` : '自动保存';
  $('pause-reason').hidden = !state.pauseReason;
  $('pause-reason').textContent = state.pauseReason || '';
  renderControls();
  renderTable();
  renderLogs();
}

function filteredRows() {
  const query = $('search').value.trim().toLocaleLowerCase();
  const filter = $('price-filter').value;
  return (state.rows || []).filter((row) => {
    if (filter === 'confirmed' && !hasFinal(row)) return false;
    if (filter === 'unknown' && hasFinal(row)) return false;
    return !query || [row.title, row.itemId, row.skuId, row.specs, row.properties, row.shopName].map(stringify).join(' ').toLocaleLowerCase().includes(query);
  });
}

function safeItemUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && /(^|\.)(taobao|tmall)\.com$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

function cell(text, className = '') {
  const td = document.createElement('td');
  td.className = className;
  if (text !== undefined) td.textContent = text;
  return td;
}

function renderTable() {
  const rows = filteredRows();
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  currentPage = Math.min(currentPage, totalPages);
  const start = (currentPage - 1) * PAGE_SIZE;
  const fragment = document.createDocumentFragment();
  for (const row of rows.slice(start, start + PAGE_SIZE)) {
    const tr = document.createElement('tr');
    const product = cell();
    const url = safeItemUrl(row.url);
    const name = document.createElement(url ? 'a' : 'span');
    name.className = 'product-title';
    name.textContent = row.title || '未识别商品名称';
    name.title = row.title || '';
    if (url) { name.href = url; name.target = '_blank'; name.rel = 'noopener noreferrer'; }
    const id = document.createElement('div');
    id.className = 'cell-secondary';
    id.textContent = `ID ${row.itemId || '未识别'}`;
    product.append(name, id);
    const sku = cell();
    const spec = document.createElement('div');
    spec.className = 'sku-specs';
    spec.textContent = row.specs ? stringify(row.specs) : '规格未识别';
    const skuId = document.createElement('div');
    skuId.className = 'cell-secondary';
    skuId.textContent = `SKU ${row.skuId || '未识别'}`;
    sku.append(spec, skuId);
    const price = cell(undefined, 'numeric');
    const priceSpan = document.createElement('span');
    priceSpan.textContent = displayPrice(row.price);
    if (priceSpan.textContent === '未确认') priceSpan.className = 'unknown';
    price.append(priceSpan);
    const final = cell(undefined, 'numeric final-price');
    const finalSpan = document.createElement('span');
    finalSpan.textContent = displayPrice(row.finalPrice);
    if (!hasFinal(row)) finalSpan.className = 'unknown';
    final.append(finalSpan);
    const status = cell();
    const pill = document.createElement('span');
    pill.className = `price-pill${hasFinal(row) ? ' confirmed' : ''}`;
    pill.textContent = hasFinal(row) ? '已识别 · 需核对条件' : '到手价待确认';
    pill.title = [row.priceStatus, row.promotion, row.priceSource].filter(Boolean).map(stringify).join(' / ');
    status.append(pill);
    const stock = cell(row.stock == null || row.stock === '' ? '—' : stringify(row.stock), 'numeric');
    stock.title = row.availability || '库存为页面披露值';
    const detail = cell();
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'row-detail';
    button.textContent = '↗';
    button.title = '查看价格来源和优惠条件';
    button.setAttribute('aria-label', `查看 SKU ${row.skuId || row.itemId || ''} 明细`);
    button.addEventListener('click', () => openDetails(row));
    detail.append(button);
    tr.append(product, sku, price, final, status, stock, detail);
    fragment.append(tr);
  }
  $('table-body').replaceChildren(fragment);
  $('empty-state').hidden = rows.length > 0;
  $('empty-state').querySelector('h3').textContent = (state.rows || []).length ? '没有找到匹配的 SKU' : '你的商品明细，将在这里展开';
  $('empty-state').querySelector('p').textContent = (state.rows || []).length ? '尝试更换关键词或价格状态筛选条件。' : '输入店铺链接开始采集，或读取已打开的店铺页面。';
  $('table-info').textContent = rows.length ? `显示 ${integer.format(start + 1)}–${integer.format(Math.min(start + PAGE_SIZE, rows.length))} 条，共 ${integer.format(rows.length)} 条${rows.length !== (state.rows || []).length ? `（全部 ${(state.rows || []).length} 条）` : ''} · 导出包含全部采集数据` : '暂无数据';
  $('page-number').textContent = `${currentPage} / ${totalPages}`;
  $('prev-page').disabled = currentPage <= 1;
  $('next-page').disabled = currentPage >= totalPages;
}

function renderLogs() {
  const logs = (state.logs || []).slice(-100).reverse();
  $('log-count').textContent = logs.length ? `最近 ${logs.length} 条` : '最近 100 条';
  const fragment = document.createDocumentFragment();
  for (const entry of logs) {
    const li = document.createElement('li');
    li.className = ['warn', 'error'].includes(entry.level) ? `log-${entry.level}` : '';
    const time = document.createElement('time');
    const d = new Date(entry.time);
    time.textContent = Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('zh-CN', { hour12: false });
    time.title = date(entry.time);
    const message = document.createElement('span');
    message.className = 'log-message';
    message.textContent = entry.message || '';
    li.append(time, message);
    fragment.append(li);
  }
  if (!logs.length) {
    const li = document.createElement('li');
    li.className = 'log-empty';
    li.textContent = '任务开始后，这里会显示翻页、采集和异常记录。';
    fragment.append(li);
  }
  $('logs').replaceChildren(fragment);
}

function openDetails(row) {
  const fields = [
    ['商品名称', row.title], ['店铺', row.shopName], ['商品 ID', row.itemId], ['SKU ID', row.skuId], ['SKU 规格', row.specs], ['原始属性', row.properties],
    ['页面价', displayPrice(row.price)], ['到手价', displayPrice(row.finalPrice)], ['划线 / 原价', displayPrice(row.originalPrice)], ['价格状态', row.priceStatus],
    ['价格来源', row.priceSource], ['优惠条件', row.promotion || '页面未提供可识别的优惠条件，请到商品页核对'], ['库存', row.stock], ['可售状态', row.availability],
    ['店铺 ID', row.shopId], ['卖家 ID', row.sellerId], ['采集时间', date(row.capturedAt)], ['备注', row.note], ['商品链接', row.url]
  ];
  const fragment = document.createDocumentFragment();
  for (const [label, value] of fields) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    const url = label === '商品链接' && safeItemUrl(value);
    if (url) {
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = url;
      dd.append(a);
    } else dd.textContent = stringify(value);
    fragment.append(dt, dd);
  }
  $('row-details').replaceChildren(fragment);
  $('row-dialog').showModal();
}

$('start-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!$('start-form').reportValidity()) return;
  if ((state.rows?.length || state.queue?.length) && !confirm('开始新任务会替换当前采集数据。请先导出需要保留的结果。继续新建任务吗？')) return;
  currentPage = 1;
  await send('START', {
    url: $('shop-url').value.trim(),
    settings: {
      delayMs: Math.max(3000, Number($('delay').value || 5) * 1000),
      maxPages: Number($('max-pages').value || 200),
      maxItems: Number($('max-items').value || 5000),
      expectedSellerId: $('seller-id').value.trim()
    }
  });
});
$('scan-button').addEventListener('click', () => send('SCAN_ACTIVE', {}, '已读取页面，查看采集队列与覆盖说明。'));
$('pause-button').addEventListener('click', () => send('PAUSE', {}, '已暂停，数据已保存。'));
$('resume-button').addEventListener('click', () => send('RESUME'));
$('retry-button').addEventListener('click', () => send('RETRY_FAILED'));
$('import-button').addEventListener('click', async () => {
  const urls = $('import-urls').value.trim();
  if (!urls) return toast('请先粘贴商品链接，每行一条。', true);
  const result = await send('IMPORT_URLS', { urls }, '商品链接已加入队列。');
  if (result) $('import-urls').value = '';
});
$('reset-button').addEventListener('click', async () => {
  if (!confirm('确定清空当前任务、SKU 明细与采集记录？请先导出需要保留的数据。')) return;
  const result = await send('RESET', {}, '当前任务已清空。');
  if (result) { $('shop-url').value = ''; currentPage = 1; render(); }
});
$('open-tab-button').addEventListener('click', () => send('OPEN_WORKER'));
$('export-button').addEventListener('click', async () => {
  try {
    $('export-button').disabled = true;
    await downloadWorkbook(state);
    toast('Excel 工作簿已生成，请查看浏览器下载。');
  } catch (error) { toast(`导出失败：${error.message || error}`, true); }
  finally { renderControls(); }
});
$('search').addEventListener('input', () => { currentPage = 1; renderTable(); });
$('price-filter').addEventListener('change', () => { currentPage = 1; renderTable(); });
$('prev-page').addEventListener('click', () => { currentPage--; renderTable(); });
$('next-page').addEventListener('click', () => { currentPage++; renderTable(); });
$('help-button').addEventListener('click', () => $('help-dialog').showModal());
document.querySelectorAll('.close-dialog').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog && event.offsetX >= 0 && event.offsetX < dialog.clientWidth && event.offsetY >= 0 && event.offsetY < dialog.clientHeight) return; if (event.target === dialog) dialog.close(); }));
document.querySelectorAll('.nav-item').forEach((link) => link.addEventListener('click', () => { document.querySelectorAll('.nav-item').forEach((item) => { item.classList.toggle('active', item === link); if (item === link) item.setAttribute('aria-current', 'location'); else item.removeAttribute('aria-current'); }); }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.task) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => send('GET_STATE'), 120);
});
render();
await send('GET_STATE');
