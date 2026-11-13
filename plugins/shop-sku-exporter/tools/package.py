"""Package an unpacked Chrome extension and its auditable source/tests."""
from pathlib import Path
import hashlib
import json
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = Path('/codex/browser/projectless/0011-chrome-sku-sku/output')


def main():
    manifest = json.loads((ROOT / 'extension/manifest.json').read_text())
    assert manifest['manifest_version'] == 3
    for path in [manifest['background']['service_worker'], 'dashboard.html',
                 *manifest['icons'].values(), *[p for s in manifest['content_scripts'] for p in s['js']]]:
        assert (ROOT / 'extension' / path).is_file(), f'Missing extension file: {path}'
    try:
        OUTPUT.mkdir(parents=True, exist_ok=True)
        destination = OUTPUT
    except PermissionError:
        # Keep a reviewable build in scratch if the host delivery mount is absent.
        destination = ROOT / 'artifacts'
        destination.mkdir(exist_ok=True)
        print('NOTE: designated delivery directory is not writable; build retained in workspace artifacts.')
    name = f'shop-sku-exporter-v{manifest["version"]}.zip'
    archive = destination / name
    include = []
    for folder in ['extension', 'tests', 'tools']:
        include.extend(p for p in (ROOT / folder).rglob('*') if p.is_file() and p.suffix in {'.js','.mjs','.json','.html','.css','.py','.png'} and '__pycache__' not in p.parts and (folder != 'tests' or p.suffix != '.png'))
    include.extend(ROOT / name for name in ['README.md','PRIVACY.md','VALIDATION.md','package.json'])
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for path in sorted(include):
            if path.exists():
                info = zipfile.ZipInfo('shop-sku-exporter/' + path.relative_to(ROOT).as_posix(), (2026,11,13,0,0,0))
                info.compress_type = zipfile.ZIP_DEFLATED
                info.external_attr = 0o100644 << 16
                output.writestr(info, path.read_bytes())
    with zipfile.ZipFile(archive) as check:
        assert check.testzip() is None
        packaged = json.loads(check.read('shop-sku-exporter/extension/manifest.json'))
        assert packaged == manifest
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (destination / (name + '.sha256')).write_text(f'{digest}  {name}\n')
    print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':digest,'files':len(include)},ensure_ascii=False))


if __name__ == '__main__':
    main()
