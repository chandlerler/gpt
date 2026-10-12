"""Browser workflow tests with real DOM/Canvas/ZIP and simulated Chrome APIs.

This is deliberately NOT an installed-extension end-to-end test. The onboarding
machine's administrator policy prohibits loading unpacked browser extensions.
All product pages/media are local fixtures; no external network requests are sent.
"""
import asyncio
from datetime import datetime, timezone
import json
import mimetypes
import os
from pathlib import Path
import shutil
import struct
import zlib
import zipfile

from playwright.async_api import async_playwright

ROOT = Path(__file__).resolve().parents[1]
EXTENSION = ROOT / 'extension'
RESULTS = ROOT / 'test-results'


def png(width, height):
    def chunk(kind, data):
        return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
    row = b'\x00' + b''.join(bytes((x % 256, (x * 7) % 256, 130)) for x in range(width))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0))
            + chunk(b'IDAT', zlib.compress(row * height)) + chunk(b'IEND', b''))


def product_html(product_id):
    res = {'item': {'itemId': str(product_id)}, 'componentsVO': {'headImageVO': {
        'images': ['https://img.alicdn.com/main.png']}}, 'skuBase': {'props': [
        {'pid': 1, 'values': [{'vid': 2, 'name': '红色', 'image': 'https://img.alicdn.com/sku.png'}]}]}}
    data = json.dumps({'loaderData': {'home': {'data': {'res': res}}}}, ensure_ascii=False)
    return f'''<!doctype html><html><head><meta charset="utf-8"><title>测试商品 {product_id}</title>
      <style>body{{margin:0}} img{{display:block;max-width:500px}} #imageTextInfo-content{{width:600px}}</style>
      <script>window.__ICE_APP_CONTEXT__ = {data};</script></head><body>
      <div id="picGalleryEle"><div class="thumbnails--fixture"><img src="https://img.alicdn.com/main.png"></div></div>
      <div id="imageTextInfo-content"><img src="https://img.alicdn.com/detail.png"></div>
      </body></html>'''


async def main():
    RESULTS.mkdir(exist_ok=True)
    manifest = json.loads((EXTENSION / 'manifest.json').read_text())
    pages = {}
    failures = []
    unexpected_requests = []
    checks = []
    media = {'main.png': png(640, 480), 'sku.png': png(400, 400), 'detail.png': png(600, 1800)}
    async with async_playwright() as playwright:
        executable = os.environ.get('CHROMIUM_EXECUTABLE') or shutil.which('chromium')
        browser = await playwright.chromium.launch(executable_path=executable, headless=True)
        context = await browser.new_context(accept_downloads=True, viewport={'width': 700, 'height': 900})

        async def route(request_route):
            url = request_route.request.url
            if url.startswith('http://127.0.0.1:8765/extension/'):
                relative = url.split('/extension/', 1)[1].split('?', 1)[0]
                path = (EXTENSION / relative).resolve()
                if not path.is_relative_to(EXTENSION) or not path.is_file():
                    await request_route.fulfill(status=404, body='Missing fixture')
                    return
                await request_route.fulfill(body=path.read_bytes(), content_type=mimetypes.guess_type(str(path))[0] or 'application/octet-stream')
            elif url.startswith('https://item.taobao.com/item.htm?id='):
                await request_route.fulfill(body=product_html(url.split('id=')[1]), content_type='text/html')
            elif url.startswith('https://img.alicdn.com/') and url.rsplit('/', 1)[1] in media:
                await request_route.fulfill(body=media[url.rsplit('/', 1)[1]], content_type='image/png', headers={'Access-Control-Allow-Origin': '*'})
            else:
                unexpected_requests.append(url)
                await request_route.abort()
        await context.route('**/*', route)

        async def send_message(_source, tab_id, request):
            return await pages[tab_id].evaluate('''request => new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('fixture response timeout')), 80000);
                const reply = value => { clearTimeout(timeout); resolve(value); };
                for (const listener of window.fixtureListeners) listener(request, {id:'study-fixture'}, reply);
            })''', request)
        await context.expose_binding('fixtureTabMessage', send_message)
        tabs = []
        for tab_id, product_id in [(1, 123), (2, 456)]:
            page = await context.new_page()
            page.on('pageerror', lambda error: failures.append(str(error)))
            await page.add_init_script("window.fixtureListeners=[]; window.chrome={runtime:{id:'study-fixture',onMessage:{addListener:fn=>window.fixtureListeners.push(fn)}}};")
            url = f'https://item.taobao.com/item.htm?id={product_id}'
            await page.goto(url)
            for file in manifest['content_scripts'][0]['js']:
                await page.add_script_tag(path=EXTENSION / file)
            pages[tab_id] = page
            tabs.append({'id': tab_id, 'url': url, 'title': f'测试商品 {product_id}'})

        panel = await context.new_page()
        panel.on('pageerror', lambda error: failures.append(str(error)))
        await panel.add_init_script('window.fixtureManifest=' + json.dumps(manifest) + ';window.fixtureTabs=' + json.dumps(tabs) + ';')
        await panel.add_init_script(path=ROOT / 'tests/chrome-fixture.js')
        await panel.goto('http://127.0.0.1:8765/extension/popup.html')
        await panel.wait_for_function('!!window.DownloaderFlowUI && !document.querySelector("#interfaceLanguage").disabled')
        assert await panel.locator('#trialCard,#accessCard,#verifyBtn,#queueAccessBtn').count() == 0
        checks.append('panel initializes without payment UI or background authorization')

        # Stale states from the upstream build and a future clock must not gate downloads.
        await panel.evaluate('''() => chrome.storage.local.set({
          tbSevenDayTrialV1:{version:1,startedAt:1,lastSeenAt:1},
          tbLicenseV2:{version:2,status:'expired',key:'invalid-fixture',verifiedAt:0}
        })''')
        await panel.clock.set_system_time(datetime(2040, 1, 1, tzinfo=timezone.utc))
        await panel.locator('#scanBtn').click()
        await panel.wait_for_function('!scanInProgress && currentImages.length === 3', timeout=15000)
        await panel.wait_for_function('document.querySelector("#zipBtn").disabled === false')
        assert await panel.locator('.image-item').count() == 3
        checks.append('real fixture page collection finds main, SKU and detail images with an expired stored state and future date')

        async with panel.expect_download() as info:
            await panel.locator('#zipBtn').click()
        download = await info.value
        zip_path = RESULTS / 'single-product.zip'
        await download.save_as(zip_path)
        with zipfile.ZipFile(zip_path) as archive:
            names = archive.namelist()
            assert '主圖/主圖_001.png' in names
            assert 'SKU款式圖/SKU款式圖_001_红色.png' in names
            assert '詳情圖/詳情圖_001.png' in names
            assert len(json.loads(archive.read('素材清單.json'))['items']) == 3
        await panel.wait_for_function('!downloadInProgress')
        checks.append('single-product UI produces a readable ZIP containing all three real PNG files and a manifest')

        await panel.locator('#tabButton-settings').click()
        for locale in ['en', 'zh_TW', 'zh_CN']:
            await panel.locator('#interfaceLanguage').select_option(locale)
            await panel.wait_for_function('locale => DownloaderI18n.locale === locale', arg=locale)
            body = await panel.locator('body').inner_text()
            assert not any(word in body for word in ['US$5.99', '七天', '七天免費', 'Start trial', '[m_'])
        checks.append('all three interface languages render without payment prompts or missing message IDs')

        await panel.evaluate('''() => {
          for (const [id,value] of [['outputFormat','jpg'],['outputMaxEdge','800'],['outputSplitHeight','800'],['outputMaxKB','500']]) {
            const node=document.getElementById(id);node.value=value;node.dispatchEvent(new Event('change',{bubbles:true}));
          }
          const square=document.getElementById('outputSquare');square.checked=true;square.dispatchEvent(new Event('change',{bubbles:true}));
        }''')
        await panel.locator('#tabButton-media').click()
        async with panel.expect_download() as info:
            await panel.locator('#zipBtn').click()
        converted_path = RESULTS / 'converted-product.zip'
        await (await info.value).save_as(converted_path)
        with zipfile.ZipFile(converted_path) as archive:
            report = json.loads(archive.read('素材清單.json'))
            main_copy = next(x for x in report['items'] if x['category'] == '主圖')['copies'][0]
            detail_copies = next(x for x in report['items'] if x['category'] == '詳情圖')['copies']
            assert main_copy['width'] == main_copy['height'] == 640
            assert len(detail_copies) == 3
            for item in report['items']:
                for copy in item['copies']:
                    assert archive.read(copy['file'])[:3] == b'\xff\xd8\xff'
                    assert copy['bytes'] <= 500 * 1024
        await panel.wait_for_function('!downloadInProgress')
        checks.append('real Canvas conversion preserves originals, creates square JPGs, slices detail images and honors the size limit')

        await panel.locator('#tabButton-cards').click()
        await panel.locator('#bookCapture').click()
        await panel.locator('#bookName').fill('学习测试商品')
        await panel.locator('#bookSave').click()
        await panel.wait_for_function('!document.getElementById("bookExport").disabled')
        async with panel.expect_download() as info:
            await panel.locator('#bookExport').click()
        note_path = RESULTS / 'product-note.zip'
        await (await info.value).save_as(note_path)
        with zipfile.ZipFile(note_path) as archive:
            assert json.loads(archive.read('product-card.json'))['displayName'] == '学习测试商品'
            assert 'variant-mapping.csv' in archive.namelist()
        checks.append('product note UI saves and exports JSON and SKU mapping CSV')

        await panel.locator('#tabButton-queue').click()
        await panel.locator('#queueAddTabs').click()
        await panel.wait_for_function('document.querySelectorAll("#queueList > li").length === 2')
        batch_downloads = []
        panel.on('download', lambda download: batch_downloads.append(download))
        await panel.locator('#queueStart').click()
        await panel.wait_for_function('window.DownloaderQueueUI.getDiagnosticState().jobs.every(j=>j.status === "delivered")', timeout=25000)
        assert len(batch_downloads) == 2
        for index, download in enumerate(batch_downloads):
            await download.save_as(RESULTS / f'batch-{index + 1}.zip')
        checks.append('two-product queue completes without authorization calls and delivers two ZIP downloads')

        await panel.locator('#tabButton-settings').click()
        await panel.screenshot(path=RESULTS / 'settings.png', full_page=True)
        await panel.reload()
        await panel.wait_for_function('window.DownloaderQueueUI?.getDiagnosticState().jobs.length === 2')
        assert await panel.evaluate('window.DownloaderQueueUI.getDiagnosticState().jobs.every(j=>j.status === "delivered")')
        assert not failures, failures
        assert not unexpected_requests, unexpected_requests
        checks.append('queue persists after reload; no browser script errors or unexpected external requests')
        await browser.close()
    report = {'scope': 'Browser DOM/Canvas/ZIP integration with simulated Chrome APIs and fixture product pages; not installed-extension validation', 'passed': len(checks), 'checks': checks}
    (RESULTS / 'browser-results.json').write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    asyncio.run(main())
