import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('installation ZIP has a root manifest and every referenced runtime dependency', () => {
  const output = mkdtempSync(join(tmpdir(), 'shop-sku-package-'));
  try {
    execFileSync('python', ['tools/package.py', '--output', output], { cwd: root, encoding: 'utf8' });
    const result = JSON.parse(execFileSync('python', ['-c', String.raw`
import hashlib, json, re, sys, zipfile
from pathlib import Path
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote

output = Path(sys.argv[1])
archives = list(output.glob('shop-sku-exporter-v*.zip'))
assert len(archives) == 1, 'Expected exactly one installation archive'
archive = archives[0]
with zipfile.ZipFile(archive) as z:
    names = set(z.namelist())
    assert 'manifest.json' in names, 'Chrome must find manifest.json at selected extraction root'
    assert not any(name.startswith(('extension/', 'tests/', 'tools/', 'shop-sku-exporter/')) for name in names), 'Installation archive must not be nested in a source project'
    assert z.testzip() is None
    extracted = output / 'clean-install'
    z.extractall(extracted)

manifest = json.loads((extracted / 'manifest.json').read_text())
assert manifest['manifest_version'] == 3
assert manifest['background']['type'] == 'module'
checked = set()

def check(source, reference):
    parts = urlsplit(reference)
    if parts.scheme or reference.startswith(('#', '//')):
        return
    path = (source.parent / unquote(parts.path)).resolve()
    assert path.is_relative_to(extracted.resolve()), f'Runtime path escapes extension: {reference}'
    assert path.is_file(), f'Missing dependency from {source.name}: {reference}'
    checked.add(path.relative_to(extracted.resolve()).as_posix())

base = extracted / 'manifest.json'
references = [manifest['background']['service_worker']]
references += list(manifest.get('icons', {}).values())
action = manifest.get('action', {})
icon = action.get('default_icon', {})
references += list(icon.values()) if isinstance(icon, dict) else [icon]
if action.get('default_popup'):
    references.append(action['default_popup'])
for content in manifest.get('content_scripts', []):
    references += content.get('js', []) + content.get('css', [])
for reference in references:
    check(base, reference)

class Assets(HTMLParser):
    def __init__(self, source):
        super().__init__()
        self.source = source
    def handle_starttag(self, tag, attrs):
        data = dict(attrs)
        if tag in ['script', 'img'] and data.get('src'):
            check(self.source, data['src'])
        if tag == 'link' and data.get('href'):
            check(self.source, data['href'])

for source in extracted.rglob('*.html'):
    Assets(source).feed(source.read_text())
for source in extracted.rglob('*.js'):
    text = source.read_text()
    references = re.findall(r'''(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]''', text)
    references += re.findall(r'''chrome\.runtime\.getURL\(\s*['"]([^'"]+)['"]''', text)
    for reference in references:
        check(source if reference.startswith('.') else base, reference)

digest = hashlib.sha256(archive.read_bytes()).hexdigest()
assert (output / (archive.name + '.sha256')).read_text().split()[0] == digest
print(json.dumps({'version': manifest['version'], 'checked': sorted(checked), 'files': len(names)}))
`, output], { encoding: 'utf8' }));
    assert.match(result.version, /^\d+\.\d+\.\d+$/);
    for (const dependency of ['background.js', 'observer.js', 'dashboard.html', 'dashboard.js', 'dashboard.css', 'lib/core.js', 'lib/extract.js', 'lib/xlsx.js']) {
      assert.ok(result.checked.includes(dependency), `Checked packaged dependency: ${dependency}`);
    }
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});
