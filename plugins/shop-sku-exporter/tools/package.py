"""Build an install ZIP with manifest.json directly at its root."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path('/codex/browser/projectless/0011-chrome-sku-sku/output')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, help='Destination directory for ZIP and SHA256 files')
    args = parser.parse_args()
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    for path in [manifest['background']['service_worker'], 'dashboard.html',
                 *manifest['icons'].values(), *[p for s in manifest['content_scripts'] for p in s['js']]]:
        assert (ROOT / 'extension' / path).is_file(), f'Missing extension file: {path}'
    try:
        destination = args.output if args.output is not None else OUTPUT
        destination.mkdir(parents=True, exist_ok=True)
    except PermissionError:
        if args.output is not None:
            raise
        # Keep a reviewable build in scratch if the host delivery mount is absent.
        destination = ROOT / 'artifacts'
        destination.mkdir(exist_ok=True)
        print('NOTE: designated delivery directory is not writable; build retained in workspace artifacts.')
    name = f'shop-sku-exporter-v{manifest["version"]}.zip'
    archive = destination / name
    # Only ship runtime files in the installation package. Source/tests stay in
    # the repository, so no extra project/extension nesting confuses the picker.
    include = {p.relative_to(ROOT / 'extension').as_posix(): p.read_bytes()
               for p in (ROOT / 'extension').rglob('*') if p.is_file()}
    include['PRIVACY.md'] = (ROOT / 'PRIVACY.md').read_bytes()
    include['INSTALL.txt'] = ('店铺 SKU 采集 v' + manifest['version'] + '\n\n'
        '1. 将 ZIP 完整解压到一个单独文件夹。不要直接在压缩包中选择目录。\n'
        '2. 确认此文件夹中直接能看到 manifest.json、background.js 和 dashboard.html。\n'
        '3. Chrome 打开 chrome://extensions，开启开发者模式。\n'
        '4. 点击“加载已解压的扩展程序”，选择上面直接含 manifest.json 的文件夹。\n'
        '5. 登录淘宝／天猫，点击插件图标打开工作台。\n\n'
        '如果提示“清单文件缺失或不可读取”，通常是选中了上一级文件夹。\n'
        '本版 manifest.json 已放在安装包根目录，无需再找 extension 子文件夹。\n'
        '旧版 v1.0.0 的清单位于 shop-sku-exporter/extension/manifest.json。\n\n'
        '使用说明与源码：\n'
        'https://github.com/chandlerler/gpt/tree/codex/shop-sku-exporter-20261113/plugins/shop-sku-exporter\n'
        '价格依赖当前账号和优惠条件，未确认的到手价留空；真实店铺验收仍需在已登录的浏览器完成。\n'
        ).encode('utf-8-sig')
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for path, data in sorted(include.items()):
            info = zipfile.ZipInfo(path, (2026,11,13,0,0,0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            output.writestr(info, data)
    with zipfile.ZipFile(archive) as check:
        assert check.testzip() is None
        packaged = json.loads(check.read('manifest.json'))
        assert packaged == manifest
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (destination / (name + '.sha256')).write_text(f'{digest}  {name}\n')
    print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':digest,'files':len(include)},ensure_ascii=False))


if __name__ == '__main__':
    main()
