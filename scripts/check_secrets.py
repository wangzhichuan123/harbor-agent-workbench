"""Scan Git-tracked files and every ZIP member without printing secret values."""
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
patterns = [re.compile(rb'exam_[A-Za-z0-9_-]{20,}')]
files = subprocess.check_output(['git', 'ls-files', '-z']).decode('utf-8').split('\0')
findings = []
def scan(label, data):
    if (secret and secret.encode() in data) or any(pattern.search(data) for pattern in patterns):
        findings.append(label)
count = 0
for name in filter(None, files):
    if name == '.env' or (name.startswith('.env.') and name != '.env.example'):
        findings.append(name)
    with open(name, 'rb') as stream:
        data = stream.read()
    scan(name, data)
    if name.endswith('.zip'):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for member in archive.namelist():
                scan(name + ':' + member, archive.read(member))
    count += 1
if findings:
    print('FAIL: possible credential material in: ' + ', '.join(findings))
    sys.exit(1)
print('PASS: {} tracked files and ZIP contents scanned; no temporary credentials found.'.format(count))
