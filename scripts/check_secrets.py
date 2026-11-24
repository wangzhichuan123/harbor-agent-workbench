"""Scan Git-tracked files, ZIP members and optional history without printing keys."""
import io
import os
import re
import subprocess
import sys
import zipfile

secret = os.environ.get('AGENT_API_KEY', '')
if not secret and os.path.isfile('.env'):
    with open('.env', encoding='utf-8') as stream:
        for line in stream:
            if line.startswith('AGENT_API_KEY='):
                secret = line.strip().split('=', 1)[1].strip('"\'')
patterns = [re.compile(rb'exam_[A-Za-z0-9_-]{20,}'),
            re.compile(rb'\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}'),
            re.compile(rb'\b(?:ghp_|github_pat_)[A-Za-z0-9_]{25,}')]
files = subprocess.check_output(['git', 'ls-files', '-z']).decode('utf-8').split('\0')
findings = []
def scan(label, data):
    if (secret and secret.encode() in data) or any(pattern.search(data) for pattern in patterns):
        findings.append(label)
def scan_archive(label, data):
    if zipfile.is_zipfile(io.BytesIO(data)):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.namelist():
                scan(label + ':' + member, archive.read(member))
count = 0
for name in filter(None, files):
    if name == '.env' or (name.startswith('.env.') and name != '.env.example'):
        findings.append(name)
    with open(name, 'rb') as stream:
        data = stream.read()
    scan(name, data)
    if name.endswith('.zip'):
        scan_archive(name, data)
    count += 1
history_count = 0
if '--history' in sys.argv:
    objects = subprocess.check_output(['git', 'rev-list', '--objects', '--all']).decode('utf-8').splitlines()
    object_names = dict(line.partition(' ')[::2] for line in objects)
    ids = '\n'.join(object_names) + '\n'
    types = subprocess.check_output(['git', 'cat-file', '--batch-check=%(objectname) %(objecttype)'], input=ids.encode()).decode().splitlines()
    for entry in types:
        oid, kind = entry.split()
        if kind not in ('blob', 'commit'):
            continue
        label = 'history:' + oid[:12] + ':' + (object_names[oid] or kind)
        data = subprocess.check_output(['git', 'cat-file', kind, oid])
        scan(label, data)
        if kind == 'blob':
            scan_archive(label, data)
        history_count += 1
if findings:
    print('FAIL: possible credential material in: ' + ', '.join(findings))
    sys.exit(1)
print('PASS: {} tracked files, ZIP contents and {} history objects scanned; no credential matches found.'.format(count, history_count))
