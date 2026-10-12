"""Build a deterministic, directly loadable extension ZIP; no dependencies needed."""
import hashlib
import json
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'extension'
DIST = ROOT / 'dist'
manifest = json.loads((SOURCE / 'manifest.json').read_text())
DIST.mkdir(exist_ok=True)
target = DIST / f'taobao-tmall-study-{manifest["version"]}.zip'
with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
    for path in sorted(SOURCE.rglob('*')):
        if not path.is_file():
            continue
        relative = path.relative_to(SOURCE)
        assert '_metadata' not in relative.parts
        entry = zipfile.ZipInfo(relative.as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
        entry.external_attr = 0o644 << 16
        entry.compress_type = zipfile.ZIP_DEFLATED
        archive.writestr(entry, path.read_bytes())
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
    assert json.loads(archive.read('manifest.json')) == manifest
    assert set(archive.namelist()) == {p.relative_to(SOURCE).as_posix() for p in SOURCE.rglob('*') if p.is_file()}
digest = hashlib.sha256(target.read_bytes()).hexdigest()
(DIST / 'SHA256SUMS').write_text(f'{digest}  {target.name}\n')
print(f'{target.name}: {target.stat().st_size} bytes\nSHA-256: {digest}')
