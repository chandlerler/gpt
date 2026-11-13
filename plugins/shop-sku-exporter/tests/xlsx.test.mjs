import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildWorkbook } from '../extension/lib/xlsx.js';

// Use an independent ZIP/XML reader to exercise the file format, CRCs and
// decoded values rather than matching the writer's string implementation.
function inspect(bytes) {
  const result = spawnSync('python', ['-c', `
import sys, io, json, zipfile, xml.etree.ElementTree as ET
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())) as z:
    assert z.testzip() is None
    parsed = {p: ET.fromstring(z.read(p)) for p in z.namelist() if p.endswith('.xml') or p.endswith('.rels')}
    wb = parsed['xl/workbook.xml']
    sheets = []
    for i, name in enumerate(wb.find('s:sheets', ns)):
        root = parsed['xl/worksheets/sheet%d.xml' % (i + 1)]
        cells = {}
        for c in root.findall('.//s:sheetData/s:row/s:c', ns):
            t = c.attrib.get('t', '')
            v = c.find('s:v', ns)
            txt = c.find('s:is/s:t', ns)
            cells[c.attrib['r']] = {'type': t, 'value': txt.text if txt is not None else v.text if v is not None else None, 'formula': c.find('s:f', ns) is not None}
        sheets.append({'name': name.attrib['name'], 'cells': cells, 'filter': root.find('s:autoFilter', ns).attrib['ref'], 'pane': root.find('.//s:pane', ns).attrib})
    print(json.dumps({'files': z.namelist(), 'sheets': sheets}, ensure_ascii=False))
`], { input: bytes, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr.toString());
  return JSON.parse(result.stdout.toString());
}

test('exports valid ZIP and XML with three named sheets and frozen filters', () => {
  const data = inspect(buildWorkbook({ rows: [] }));
  assert.deepEqual(data.sheets.map(sheet => sheet.name), ['SKU明细', '商品清单', '采集说明']);
  assert.equal(data.sheets[0].filter, 'A1:T1');
  assert.equal(data.sheets[0].pane.state, 'frozen');
  assert.equal(data.sheets[0].pane.ySplit, '1');
  assert.equal(data.sheets[0].cells.J1.value, '页面明确到手价（元）');
});

test('preserves ID precision, zero prices, unknowns and plain text formulas', () => {
  const rows = [{
    itemId: '00012345678901234567890', skuId: '98765432109876543210',
    title: '=HYPERLINK("https://example.test", "x")',
    specs: '红色 & "大号" <M>\u0001\uFFFE\uD800', properties: { 颜色: '蓝色' },
    price: 0, finalPrice: null, originalPrice: 129.95, stock: 0,
    capturedAt: '2026-11-13T00:01:02Z'
  }, { itemId: 'b', price: '99', finalPrice: 0, stock: null }];
  const data = inspect(buildWorkbook({ rows }));
  const cells = data.sheets[0].cells;
  assert.equal(cells.D2.type, 'inlineStr');
  assert.equal(cells.D2.value, rows[0].itemId);
  assert.equal(cells.F2.value, rows[0].skuId);
  assert.equal(cells.E2.value, rows[0].title);
  assert.equal(cells.E2.formula, false);
  assert.equal(cells.G2.value, '红色 & "大号" <M>');
  assert.equal(cells.I2.value, '0');
  assert.equal(cells.J2.value, null);
  assert.equal(cells.K2.value, '129.95');
  assert.equal(cells.L2.value, '0');
  assert.equal(cells.I3.value, null);
  assert.equal(cells.J3.value, '0');
  assert.equal(cells.L3.value, null);
  assert.equal(cells.S2.value, '2026-11-13 08:01:02 +08:00');
  assert.equal(data.sheets[1].cells.D2.value, '1');
  assert.equal(data.sheets[1].cells.E2.value, '0');
  assert.equal(data.sheets[1].cells.E3.value, '1');
});

test('reports incomplete collection, item failures and unknown final-price counts', () => {
  const data = inspect(buildWorkbook({
    status: 'paused', discovery: { pages: 2, complete: false, note: '需要登录' },
    queue: [{ itemId: '1', status: 'done', url: 'https://item.taobao.com/item.htm?id=1' }, { itemId: '2', status: 'failed', error: '页面没有 SKU 数据' }],
    rows: [{ itemId: '1', finalPrice: null }, { itemId: '1', finalPrice: 20 }]
  }));
  assert.equal(data.sheets[1].cells.C3.value, '采集失败');
  assert.equal(data.sheets[1].cells.F3.value, '页面没有 SKU 数据');
  assert.equal(data.sheets[1].cells.D2.value, '2');
  const summary = data.sheets[2].cells;
  const entries = {};
  for (let i = 2; summary[`A${i}`]; i += 1) entries[summary[`A${i}`].value] = summary[`B${i}`].value;
  assert.equal(entries['未确认到手价的 SKU 行数'], '1');
  assert.match(entries['列表扫描状态'], /尚未完成/);
  assert.match(entries['运费与结算'], /不提交订单/);
  assert.match(entries['覆盖范围'], /不等于已证明全店/);
});

test('limits oversize cell text without corrupting Unicode', () => {
  const title = 'x'.repeat(32766) + '🛒';
  const data = inspect(buildWorkbook({ rows: [{ itemId: '1', title }] }));
  assert.equal(data.sheets[0].cells.E2.value, 'x'.repeat(32766));
});
