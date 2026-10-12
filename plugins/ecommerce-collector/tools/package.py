from pathlib import Path
import hashlib
import json
import zipfile

root = Path(__file__).resolve().parents[1]
ext = root / 'extension'
dist = root / 'dist'
dist.mkdir(exist_ok=True)
version = json.loads((ext / 'manifest.json').read_text())['version']
target = dist / ('ecommerce-collector-' + version + '.zip')
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as z:
    for f in sorted(ext.rglob('*')):
        if f.is_file():
            z.write(f, f.relative_to(ext))
    z.write(root / 'README.md', '说明.md')
with zipfile.ZipFile(target) as z:
    assert z.testzip() is None
    m = json.loads(z.read('manifest.json'))
    assert m['version'] == version
    assert not any(n.startswith('_metadata/') for n in z.namelist())
    for cs in m['content_scripts']:
        for name in cs['js'] + cs.get('css', []):
            assert name in z.namelist(), name
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(dist / 'SHA256SUMS').write_text(digest + '  ' + target.name + '\n')
print(json.dumps({'zip': str(target), 'bytes': target.stat().st_size, 'sha256': digest}))
