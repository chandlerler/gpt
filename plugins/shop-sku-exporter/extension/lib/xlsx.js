/**
 * Dependency-free OOXML workbook writer. Every non-numeric cell is an inline
 * string, so product IDs retain precision and untrusted text cannot be a formula.
 */
const encoder = new TextEncoder();
const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function xml(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function text(value) {
  if (value == null) return '';
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

function numeric(value) {
  // A blank or numeric-looking string is not an observed numeric value.
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function dateText(value) {
  if (value == null || value === '') return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return text(value);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date) + ' +08:00';
}

function columnName(index) {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

function stringCell(ref, value, style = 3) {
  // Excel limits a single cell to 32,767 UTF-16 code units.
  let content = text(value).slice(0, 32767);
  if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
  return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${xml(content)}</t></is></c>`;
}

function cell(ref, value, kind) {
  if (kind === 'money' || kind === 'number') {
    const n = numeric(value);
    if (n === null) return `<c r="${ref}" s="${kind === 'money' ? 2 : 4}"/>`;
    return `<c r="${ref}" s="${kind === 'money' ? 2 : 4}"><v>${n}</v></c>`;
  }
  return stringCell(ref, value);
}

function sheetXml(columns, rows) {
  if (rows.length > 1048575) throw new Error('单个工作表最多支持 1,048,575 条数据，请分批导出。');
  const last = `${columnName(columns.length - 1)}${rows.length + 1}`;
  const widths = columns.map((col, i) => `<col min="${i + 1}" max="${i + 1}" width="${col.width || 20}" customWidth="1"/>`).join('');
  const header = `<row r="1" ht="30" customHeight="1">${columns.map((col, i) => stringCell(`${columnName(i)}1`, col.title, 1)).join('')}</row>`;
  const body = rows.map((row, i) => `<row r="${i + 2}">${columns.map((col, j) => cell(`${columnName(j)}${i + 2}`, col.get ? col.get(row) : row[col.key], col.kind)).join('')}</row>`).join('');
  return `${XML}<worksheet xmlns="${NS}"><dimension ref="A1:${last}"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="24"/><cols>${widths}</cols><sheetData>${header}${body}</sheetData><autoFilter ref="A1:${last}"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/></worksheet>`;
}

const skuColumns = [
  { title: '店铺名称', key: 'shopName', width: 24 },
  { title: '店铺 ID', key: 'shopId', width: 21 },
  { title: '卖家 ID', key: 'sellerId', width: 21 },
  { title: '商品 ID', key: 'itemId', width: 23 },
  { title: '商品标题', key: 'title', width: 48 },
  { title: 'SKU ID', key: 'skuId', width: 25 },
  { title: 'SKU 规格', key: 'specs', width: 40 },
  { title: '规格属性明细', key: 'properties', width: 45 },
  { title: '页面售价（元）', key: 'price', kind: 'money', width: 19 },
  { title: '页面明确到手价（元）', key: 'finalPrice', kind: 'money', width: 24 },
  { title: '原价 / 划线价（元）', key: 'originalPrice', kind: 'money', width: 22 },
  { title: '页面库存', key: 'stock', kind: 'number', width: 15 },
  { title: '可售状态', key: 'availability', width: 19 },
  { title: '价格确认状态', key: 'priceStatus', width: 25 },
  { title: '价格来源', key: 'priceSource', width: 40 },
  { title: '优惠说明 / 条件', key: 'promotion', width: 55 },
  { title: '商品链接', key: 'url', width: 58 },
  { title: 'SKU 图片链接', key: 'imageUrl', width: 55 },
  { title: '采集时间（北京时间）', get: row => dateText(row.capturedAt), width: 30 },
  { title: '备注', key: 'note', width: 55 }
];

const statusLabels = { pending: '待采集', done: '已采集', failed: '采集失败', skipped: '已跳过', running: '采集中', idle: '未开始', paused: '已暂停', completed: '已结束', error: '异常' };
const queueColumns = [
  { title: '商品 ID', key: 'itemId', width: 23 },
  { title: '商品链接', key: 'url', width: 60 },
  { title: '采集状态', get: row => statusLabels[row.status] || row.status, width: 18 },
  { title: '导出 SKU 行数', key: 'skuCount', kind: 'number', width: 20 },
  { title: '明确到手价行数', key: 'finalCount', kind: 'number', width: 21 },
  { title: '错误 / 跳过原因', key: 'error', width: 65 }
];

function workbookSheets(state) {
  const rows = Array.isArray(state.rows) ? state.rows : [];
  const queue = Array.isArray(state.queue) ? state.queue : [];
  const discovery = state.discovery || {};
  const counts = new Map();
  for (const row of rows) {
    const id = text(row.itemId);
    const count = counts.get(id) || { skuCount: 0, finalCount: 0 };
    count.skuCount += 1;
    if (numeric(row.finalPrice) !== null) count.finalCount += 1;
    counts.set(id, count);
  }
  const goods = queue.map(item => ({ ...item, ...(counts.get(text(item.itemId)) || { skuCount: 0, finalCount: 0 }) }));
  // Retain rows whose source item is missing from a restored/imported queue.
  const queuedIds = new Set(queue.map(item => text(item.itemId)));
  for (const [itemId, count] of counts) {
    if (!queuedIds.has(itemId)) {
      goods.push({ itemId, url: rows.find(row => text(row.itemId) === itemId)?.url || '', status: 'done', ...count, error: '商品记录由 SKU 明细补充' });
    }
  }
  const finalCount = rows.filter(row => numeric(row.finalPrice) !== null).length;
  const details = [
    ['店铺', state.shopName || '未识别'],
    ['店铺链接', state.shopUrl || ''],
    ['任务状态', statusLabels[state.status] || state.status || '未知'],
    ['当前阶段', state.phase === 'discover' ? '发现店铺商品' : state.phase === 'detail' ? '采集 SKU 明细' : text(state.phase)],
    ['开始时间（北京时间）', dateText(state.startedAt)],
    ['最后更新时间（北京时间）', dateText(state.updatedAt)],
    ['导出时间（北京时间）', dateText(Date.now())],
    ['发现商品数', goods.length],
    ['已采集商品数', goods.filter(item => item.status === 'done').length],
    ['失败商品数', goods.filter(item => item.status === 'failed').length],
    ['跳过商品数', goods.filter(item => item.status === 'skipped').length],
    ['待采集商品数', goods.filter(item => item.status === 'pending').length],
    ['导出 SKU 行数', rows.length],
    ['有明确到手价的 SKU 行数', finalCount],
    ['未确认到手价的 SKU 行数', rows.length - finalCount],
    ['已扫描列表页数', discovery.pages ?? 0],
    ['页面报告的商品总数', discovery.expectedTotal ?? '页面未提供'],
    ['列表扫描状态', discovery.complete ? '已到达可检测的列表末页；不代表已验证全店覆盖' : '列表扫描尚未完成，或完整性未确认'],
    ['列表扫描说明', discovery.note || ''],
    ['暂停原因', state.pauseReason || ''],
    ['到手价口径', '仅记录页面或页面已加载数据中，明确对应此 SKU、并明确标为到手价 / 券后价的数值。空白表示无法确认；未用商品最低价代替 SKU 价格，也未推算优惠。'],
    ['账号与地区', '价格是采集时当前已登录账号、页面地区及购买资格下的观察结果，不保证其他账号、地区或时间一致。'],
    ['优惠条件', '会员、新人、领券、满减、购买数量等条件请见每行优惠说明；资格及实际优惠是否可用需在下单时确认。'],
    ['运费与结算', '未确认的运费、税费及结算页优惠不计入到手价；本插件不提交订单，导出价格不是最终结算承诺。'],
    ['覆盖范围', '商品数以成功发现的店铺列表为准。隐藏、下架、区域限制、未加载商品及未返回的 SKU 可能缺失；到达末页不等于已证明全店所有 SKU 均已采集。'],
    ['库存口径', '页面库存仅为页面返回的库存值或状态，不代表实时可购买库存。空白表示未提供。'],
    ['表格说明', '金额单位为人民币元；ID 按文本保存；未知金额 / 库存留空，0 保留为数值。商品标题和链接均按纯文本保存，不执行公式。'],
    ['数据保留', '导出仅包含采集结果及任务说明，不包含登录 Cookie、令牌或完整网络响应。']
  ].map(([label, value]) => ({ label, value }));
  return [
    { name: 'SKU明细', columns: skuColumns, rows },
    { name: '商品清单', columns: queueColumns, rows: goods },
    { name: '采集说明', columns: [{ title: '项目', key: 'label', width: 29 }, { title: '内容', key: 'value', width: 110 }], rows: details }
  ];
}

const styles = `${XML}<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="164" formatCode="0.00"/></numFmts><fonts count="2"><font><sz val="10"/><color rgb="FF23382F"/><name val="Microsoft YaHei"/><family val="2"/></font><font><b/><sz val="10"/><color rgb="FFFFFFFF"/><name val="Microsoft YaHei"/><family val="2"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF1D5B43"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function concat(chunks) {
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}

function zip(files) {
  const local = [];
  const directory = [];
  let offset = 0;
  const now = new Date();
  const year = Math.min(2107, Math.max(1980, now.getFullYear()));
  const dosDate = ((year - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  for (const [path, source] of files) {
    const name = encoder.encode(path);
    const bytes = encoder.encode(source);
    const crc = crc32(bytes);
    if (bytes.length > 0xFFFFFFFF || offset > 0xFFFFFFFF) throw new Error('导出数据超过 XLSX 打包大小限制，请分批导出。');
    const header = new Uint8Array(30);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034B50, true);
    hv.setUint16(4, 20, true);
    hv.setUint16(6, 0x0800, true); // UTF-8 filenames.
    hv.setUint16(10, dosTime, true);
    hv.setUint16(12, dosDate, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, bytes.length, true);
    hv.setUint32(22, bytes.length, true);
    hv.setUint16(26, name.length, true);
    local.push(header, name, bytes);
    const entry = new Uint8Array(46);
    const ev = new DataView(entry.buffer);
    ev.setUint32(0, 0x02014B50, true);
    ev.setUint16(4, 20, true);
    ev.setUint16(6, 20, true);
    ev.setUint16(8, 0x0800, true);
    ev.setUint16(12, dosTime, true);
    ev.setUint16(14, dosDate, true);
    ev.setUint32(16, crc, true);
    ev.setUint32(20, bytes.length, true);
    ev.setUint32(24, bytes.length, true);
    ev.setUint16(28, name.length, true);
    ev.setUint32(42, offset, true);
    directory.push(entry, name);
    offset += header.length + name.length + bytes.length;
  }
  const directorySize = directory.reduce((sum, chunk) => sum + chunk.length, 0);
  if (offset + directorySize > 0xFFFFFFFF || files.length > 65535) throw new Error('导出数据过大，请分批导出。');
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054B50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  return concat([...local, ...directory, end]);
}

export function buildWorkbook(state = {}) {
  const sheets = workbookSheets(state);
  const files = [
    ['[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`],
    ['_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`],
    ['xl/workbook.xml', `${XML}<workbook xmlns="${NS}" xmlns:r="${REL}"><bookViews><workbookView activeTab="0"/></bookViews><sheets>${sheets.map((sheet, i) => `<sheet name="${xml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`],
    ['xl/_rels/workbook.xml.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${REL}/styles" Target="styles.xml"/></Relationships>`],
    ['xl/styles.xml', styles],
    ...sheets.map((sheet, i) => [`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet.columns, sheet.rows)])
  ];
  return zip(files);
}

export function downloadWorkbook(state = {}) {
  const bytes = buildWorkbook(state);
  const blob = new Blob([bytes], { type: MIME });
  const url = URL.createObjectURL(blob);
  const name = text(state.shopName || '店铺SKU').replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').slice(0, 70).replace(/[. ]+$/, '') || '店铺SKU';
  const stamp = dateText(Date.now()).replace(/ \+08:00$/, '').replace(/[- :]/g, '');
  const filename = `${name}_SKU明细_${stamp}.xlsx`;
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  // Keep the URL alive long enough for Chrome to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return filename;
}
