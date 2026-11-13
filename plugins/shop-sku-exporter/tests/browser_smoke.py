"""Real Chromium DOM/download tests with synthetic storefronts and mocked Chrome APIs.

Also attempts native unpacked extension loading. A managed policy may block it;
that result is recorded separately and is never presented as a native E2E pass.
No real shop requests, credentials, checkout or coupons are used by this suite.
"""
import asyncio
import json
import mimetypes
import shutil
import tempfile
from pathlib import Path

from openpyxl import load_workbook
from playwright.async_api import async_playwright, TimeoutError as PlaywrightTimeoutError

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / 'extension'
RESULTS = ROOT / 'tests'
BASE = 'http://127.0.0.1:8765/extension/'
STORE = 'https://tongxincwyp.tmall.com/category.htm'
ITEM = 'https://detail.tmall.com/item.htm?id=1058281399231'


def fixture_state():
    return {
        'status': 'paused', 'phase': 'detail', 'shopUrl': STORE,
        'shopName': '模拟验收店铺（非真实采集）', 'shopId': '8888', 'sellerId': '9999',
        'workerTabId': 123,
        'discovery': {'pages': 2, 'expectedTotal': 3, 'complete': False,
                      'note': '模拟验收数据，尚未确认全店覆盖'},
        'queue': [{'itemId': '1058281399231', 'url': ITEM, 'status': 'done', 'error': ''},
                  {'itemId': '1058281399232', 'url': ITEM.replace('9231', '9232'),
                   'status': 'failed', 'error': '模拟：等待页面加载'}],
        'rows': [
            {'itemId': '1058281399231', 'skuId': '12345678901234567890', 'title': '模拟猫粮 · 500 克',
             'specs': '口味: 鸡肉 / 规格: 500 克', 'properties': {'口味': '鸡肉'},
             'price': 39.9, 'finalPrice': 29.9, 'originalPrice': 59.9, 'stock': 12,
             'availability': '有库存', 'priceSource': '模拟 SKU 明确价格字段',
             'promotion': '模拟：需领取 10 元券', 'priceStatus': '页面明确到手价',
             'url': ITEM, 'shopName': '模拟验收店铺（非真实采集）', 'capturedAt': '2026-11-13T08:00:00Z'},
            {'itemId': '1058281399231', 'skuId': '12345678901234567891', 'title': '模拟猫粮 · 500 克',
             'specs': '口味: 三文鱼 / 规格: 500 克', 'properties': {'口味': '三文鱼'},
             'price': 49.9, 'finalPrice': None, 'originalPrice': None, 'stock': 0,
             'availability': '无库存', 'priceSource': '模拟 SKU 页面售价',
             'promotion': '', 'priceStatus': '到手价未确认', 'url': ITEM,
             'shopName': '模拟验收店铺（非真实采集）', 'capturedAt': '2026-11-13T08:00:00Z'}],
        'logs': [{'time': '2026-11-13T08:00:00Z', 'level': 'info', 'message': '模拟验收：发现 2 个商品'},
                 {'time': '2026-11-13T08:00:05Z', 'level': 'warn', 'message': '模拟验收：1 个商品需要重试'}],
        'settings': {'delayMs': 5000, 'maxPages': 200, 'maxItems': 5000},
        'startedAt': '2026-11-13T08:00:00Z', 'updatedAt': '2026-11-13T08:00:10Z',
        'pauseReason': '模拟验收：已暂停，进度已保存。'
    }


MOCK = """(() => {
  const empty = () => ({status:'idle',phase:'discover',shopUrl:'',queue:[],rows:[],logs:[],settings:{},discovery:{}});
  window.__testState = empty(); window.__commands = []; const listeners=[];
  window.__setState = state => { window.__testState=state; for (const fn of listeners) fn({task:{newValue:state}},'local'); };
  window.chrome = {runtime:{sendMessage:async message => {
    window.__commands.push(message); let s=window.__testState;
    switch (message.type) {
      case 'START': s={...empty(), status:'running',shopUrl:message.url,settings:message.settings}; break;
      case 'PAUSE': s={...s,status:'paused',pauseReason:'模拟：用户暂停'}; break;
      case 'RESUME': s={...s,status:'running',pauseReason:''}; break;
      case 'RETRY_FAILED': s={...s,status:'running',queue:s.queue.map(q=>q.status==='failed'?{...q,status:'pending',error:''}:q)}; break;
      case 'IMPORT_URLS': s={...s,status:'paused',queue:[...s.queue,{itemId:'1058281399233',url:message.urls,status:'pending',error:''}]}; break;
      case 'SCAN_ACTIVE': s={...s,status:'paused',queue:[...s.queue,{itemId:'1058281399234',status:'pending'}]}; break;
      case 'RESET': s=empty(); break;
    }
    window.__testState=s; return {ok:true,state:s};
  }},storage:{onChanged:{addListener:fn=>listeners.push(fn)}}};
})();"""


async def attempt_native(playwright, report):
    profile = tempfile.mkdtemp(prefix='shop-sku-native-', dir=RESULTS)
    context = None
    try:
        context = await playwright.chromium.launch_persistent_context(
            profile, executable_path=shutil.which('chromium'), headless=True,
            args=[f'--disable-extensions-except={EXTENSION}', f'--load-extension={EXTENSION}'])
        try:
            worker = next((w for w in context.service_workers if w.url.endswith('/background.js')), None)
            if worker is None:
                worker = await context.wait_for_event('serviceworker', predicate=lambda w: w.url.endswith('/background.js'), timeout=6000)
            loaded_manifest = await worker.evaluate('chrome.runtime.getManifest()')
            assert loaded_manifest['name'] == json.loads((EXTENSION / 'manifest.json').read_text())['name']
            report['native_extension'] = {'loaded': True, 'worker_url': worker.url,
                                          'note': 'Native extension loaded; workflow below still uses deterministic fixtures.'}
        except PlaywrightTimeoutError:
            policy_path = Path('/etc/chromium/policies/managed/extensions.json')
            policy = json.loads(policy_path.read_text()) if policy_path.exists() else {}
            report['native_extension'] = {
                'loaded': False, 'service_workers': len(context.service_workers),
                'extension_install_blocklist': policy.get('ExtensionInstallBlocklist'),
                'note': 'No extension service worker appeared within 6 seconds. Managed Chromium policy blocks all non-allowlisted extensions.'
                        if '*' in policy.get('ExtensionInstallBlocklist', []) else 'No extension service worker appeared within 6 seconds.'}
    except Exception as error:
        report['native_extension'] = {'loaded': False, 'error': str(error)}
    finally:
        if context:
            await context.close()
        shutil.rmtree(profile, ignore_errors=True)


async def main():
    report = {'scope': 'Real Chromium DOM and XLSX downloads with simulated shop pages and Chrome API mocks; not live-store verification.',
              'checks': [], 'unexpected_requests': [], 'browser_errors': []}
    check = report['checks'].append
    async with async_playwright() as playwright:
        await attempt_native(playwright, report)
        (RESULTS / 'browser-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
        browser = await playwright.chromium.launch(executable_path=shutil.which('chromium'), headless=True)
        context = await browser.new_context(accept_downloads=True, viewport={'width': 1440, 'height': 1080})

        async def route(request_route):
            url = request_route.request.url
            if url.startswith(BASE):
                path = (EXTENSION / url[len(BASE):].split('?', 1)[0]).resolve()
                if path.is_relative_to(EXTENSION) and path.is_file():
                    return await request_route.fulfill(body=path.read_bytes(), content_type=mimetypes.guess_type(path)[0] or 'text/plain')
            if url.startswith(STORE):
                page_two = 'pageNo=2' in url
                ids = ['1058281399232', '1058281399233'] if page_two else ['1058281399231', '1058281399232']
                links = ''.join(f'<a href="https://detail.tmall.com/item.htm?id={i}">商品 {i}</a>' for i in ids)
                next_control = '<span class="ui-page-next disabled">下一页</span>' if page_two else f'<a class="ui-page-next" href="{STORE}?pageNo=2">下一页</a>'
                html = f'''<!doctype html><meta charset="utf-8"><title>模拟店铺</title><p>共3件商品</p>
                  <script>window.__INIT_DATA__={{shop:{{shopId:'8888',sellerId:'9999',shopName:'模拟店铺'}}}};</script>
                  <div class="item-list">{links}</div><div class="recommend"><a href="https://detail.tmall.com/item.htm?id=9999999999999">店外推荐</a></div>
                  <div class="pagination">{next_control}</div>'''
                return await request_route.fulfill(body=html, content_type='text/html; charset=utf-8')
            if url.startswith(ITEM):
                data = {'loaderData': {'home': {'data': {'res': {
                    'item': {'itemId': '1058281399231', 'title': '模拟猫粮'},
                    'seller': {'shopId': '8888', 'userId': '9999', 'shopName': '模拟店铺'},
                    'skuBase': {'props': [{'pid': '1', 'name': '口味', 'values': [{'vid': '11', 'name': '鸡肉'}, {'vid': '12', 'name': '三文鱼'}]}],
                                'skus': [{'skuId': '1001', 'propPath': '1:11'}, {'skuId': '1002', 'propPath': '1:12'}]},
                    'skuCore': {'sku2info': {'0': {'price': {'priceText': '0.01'}},
                       '1001': {'price': {'priceText': '39.90'}, 'subPrice': {'priceTitle': '券后价', 'priceText': '29.90', 'priceDesc': '需领券'}, 'quantity': 12},
                       '1002': {'price': {'priceText': '49.90'}, 'quantity': 0}}}
                }}}}}
                html = '<!doctype html><meta charset="utf-8"><title>模拟猫粮</title><script>window.__ICE_APP_CONTEXT__ = ' + json.dumps(data) + ';</script><h1>模拟猫粮</h1>'
                return await request_route.fulfill(body=html, content_type='text/html; charset=utf-8')
            report['unexpected_requests'].append(url)
            await request_route.abort()

        await context.route('**/*', route)
        await context.add_init_script(MOCK)
        page = await context.new_page()
        page.on('pageerror', lambda error: report['browser_errors'].append(str(error)))
        await page.goto(BASE + 'dashboard.html')
        await page.wait_for_function("window.__commands.some(x=>x.type==='GET_STATE')")
        assert await page.locator('#metric-skus').inner_text() == '0'
        assert await page.locator('#export-button').is_disabled()
        assert await page.locator('#shop-url').input_value() == STORE
        check('Dashboard initializes with zero real rows, disabled export, and the user-provided store URL.')
        await page.screenshot(path=str(RESULTS / 'dashboard-empty.png'), full_page=True)

        await page.locator('#start-button').click()
        await page.wait_for_function("window.__commands.some(x=>x.type==='START')")
        assert await page.locator('#task-status').inner_text() == '正在采集'
        assert await page.locator('#start-button').is_disabled()
        start = await page.evaluate("window.__commands.find(x=>x.type==='START')")
        assert start['settings']['delayMs'] == 5000 and start['url'] == STORE
        await page.locator('#pause-button').click()
        assert await page.locator('#task-status').inner_text() == '已暂停'
        await page.locator('#resume-button').click()
        assert await page.locator('#task-status').inner_text() == '正在采集'
        await page.locator('#pause-button').click()
        check('Start/pause/resume controls send correct commands and follow returned state.')

        await page.locator('.tools-card details').evaluate('(el)=>el.open=true')
        await page.locator('#import-urls').fill(ITEM.replace('9231', '9233'))
        await page.locator('#import-button').click()
        assert await page.locator('#import-urls').input_value() == ''
        assert await page.locator('#metric-items').inner_text() == '1'
        check('Manual item-link import sends the link and refreshes queue state.')

        await page.evaluate('(state)=>window.__setState(state)', fixture_state())
        await page.wait_for_function("document.querySelector('#metric-skus').textContent==='2'")
        assert await page.locator('#metric-prices').inner_text() == '1'
        assert '尚未确认全店覆盖' in await page.locator('#coverage-note').inner_text()
        assert await page.locator('#table-body tr').count() == 2
        assert '未确认' in await page.locator('#table-body tr').nth(1).inner_text()
        assert '0' in await page.locator('#table-body tr').nth(1).locator('td').nth(5).inner_text()
        await page.locator('#search').fill('三文鱼')
        assert await page.locator('#table-body tr').count() == 1
        await page.locator('#search').fill('')
        await page.locator('#price-filter').select_option('confirmed')
        assert await page.locator('#table-body tr').count() == 1
        await page.locator('#price-filter').select_option('unknown')
        assert await page.locator('#table-body tr').count() == 1
        await page.locator('#price-filter').select_option('all')
        await page.locator('.row-detail').first.click()
        assert await page.locator('#row-dialog').is_visible()
        assert '需领取 10 元券' in await page.locator('#row-details').inner_text()
        await page.locator('#row-dialog .close-dialog').click()
        check('Storage updates render SKU rows; unknown prices, zero stock, search, price filters and source details work.')

        # Export ignores the table filter by design and preserves all observed rows.
        await page.locator('#price-filter').select_option('confirmed')
        async with page.expect_download() as download_info:
            await page.locator('#export-button').click()
        download = await download_info.value
        workbook_path = RESULTS / 'browser-export-simulated.xlsx'
        await download.save_as(workbook_path)
        workbook = load_workbook(workbook_path)
        assert workbook.sheetnames == ['SKU明细', '商品清单', '采集说明']
        sheet = workbook['SKU明细']
        assert sheet.max_row == 3
        headers = {cell.value: cell.column for cell in sheet[1]}
        assert sheet.cell(2, headers['SKU ID']).value == '12345678901234567890'
        assert sheet.cell(2, headers['页面明确到手价（元）']).value == 29.9
        assert sheet.cell(3, headers['页面明确到手价（元）']).value is None
        assert sheet.cell(3, headers['页面库存']).value == 0
        check('Browser download opens as a three-sheet XLSX; all rows exported despite filters, long IDs/blank price/zero stock preserved.')
        await page.locator('#price-filter').select_option('all')
        await page.evaluate("window.scrollTo({top:0,behavior:'instant'})")
        await page.screenshot(path=str(RESULTS / 'dashboard-simulated-data.png'), full_page=True)

        await page.locator('#retry-button').click()
        assert await page.locator('#task-status').inner_text() == '正在采集'
        assert await page.evaluate("window.__commands.at(-1).type") == 'RETRY_FAILED'
        await page.locator('#pause-button').click()
        await page.locator('#open-tab-button').click()
        assert await page.evaluate("window.__commands.at(-1).type") == 'OPEN_WORKER'
        await page.locator('#help-button').click()
        assert await page.locator('#help-dialog').is_visible()
        await page.locator('#help-dialog .close-dialog').click()
        check('Retry, open collection tab and help controls are wired and functional.')

        malicious = fixture_state()
        malicious['rows'][0]['title'] = '<img src=x onerror="window.__xss=1">'
        malicious['rows'][0]['url'] = 'javascript:window.__xss=1'
        await page.evaluate('(state)=>window.__setState(state)', malicious)
        await page.wait_for_function("document.querySelector('#table-body').textContent.includes('<img')")
        assert await page.locator('#table-body img').count() == 0
        assert await page.evaluate('window.__xss || null') is None
        assert await page.locator('#table-body tr').first.locator('a').count() == 0
        check('Untrusted title and javascript URL are displayed safely without executable HTML or links.')

        await page.set_viewport_size({'width': 780, 'height': 900})
        overflow = await page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,nodes:[...document.querySelectorAll("body *")].map(e=>({tag:e.tagName,cls:e.className,right:e.getBoundingClientRect().right})).filter(e=>e.right>innerWidth+2).slice(0,30)})')
        assert overflow['scroll'] <= overflow['width'] + 2, overflow
        check('Dashboard fits a 780 px viewport; table remains horizontally scrollable.')
        await page.set_viewport_size({'width': 1440, 'height': 1080})

        extract_source = (EXTENSION / 'lib/extract.js').read_text().split('\nexport async function parseDetail')[0]
        extract_source = extract_source.replace('export async function inspectPage', 'async function inspectPage', 1)
        shop_page = await context.new_page()
        await shop_page.goto(STORE)
        await shop_page.add_script_tag(content=extract_source + '\nwindow.__inspect=inspectPage;')
        first = await shop_page.evaluate("window.__inspect('shop')")
        assert len(first['itemLinks']) == 2 and first['expectedTotal'] == 3
        assert not any('9999999999999' in u for u in first['itemLinks'])
        assert first['nextUrl'] == STORE + '?pageNo=2'
        await shop_page.goto(first['nextUrl'])
        await shop_page.add_script_tag(content=extract_source + '\nwindow.__inspect=inspectPage;')
        second = await shop_page.evaluate("window.__inspect('shop')")
        assert second['hasMore'] is False
        assert len(set(first['itemLinks'] + second['itemLinks'])) == 3
        check('Real shop fixture DOM extracts product lists, excludes recommendations, detects next/disabled-last-page and deduplicates overlap.')
        await shop_page.goto(ITEM)
        await shop_page.add_script_tag(content=extract_source + '\nwindow.__inspect=inspectPage;')
        detail = await shop_page.evaluate("window.__inspect('detail')")
        assert detail['skuComplete'] and len(detail['rows']) == 2
        assert detail['rows'][0]['finalPrice'] == 29.9
        assert detail['rows'][1]['finalPrice'] is None
        assert detail['rows'][1]['stock'] == 0
        assert all(r['price'] != 0.01 for r in detail['rows'])
        check('Real product fixture DOM parses ICE context and SKU-specific prices without applying item minimum to each SKU.')
        await shop_page.evaluate("document.body.innerHTML='<div id=nc_1_wrapper>拖动滑块</div>'")
        blocked = await shop_page.evaluate("window.__inspect('detail')")
        assert blocked['blocked']
        check('Verification challenge DOM is detected for manual handling.')
        assert report['browser_errors'] == [], report['browser_errors']
        assert report['unexpected_requests'] == [], report['unexpected_requests']
        await context.close()
        await browser.close()
    report['passed'] = True
    (RESULTS / 'browser-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
