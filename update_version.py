# Brug: python update_version.py 1.2.3

import os
import sys
import re
from datetime import datetime

FILES = [
    "web/advanced.html",
    "web/advanced.js",
    "web/app.js",
    "web/index.html",
    "web/manifest.webmanifest",
    "web/opretbruger.html",
    "web/settings.html",
    "web/style.css",
    "web/sw.js",
    "web/threads.js",
    "web/traad.html",
    "web/traad.js"
]

VERSION = sys.argv[1] if len(sys.argv) > 1 else '1.0.0'
now = datetime.now()
DATE = now.strftime('%Y-%m-%d %H.%M.%S')

def version_line(ext):
    copyright_line = "© Christian Vemmelund Helligsø"
    if ext == '.html':
        return f'<!-- Version: {VERSION} - {DATE} -->\n<!-- {copyright_line} -->'
    elif ext == '.webmanifest' or ext == '.json':
        return f'// Version: {VERSION} - {DATE}\n// {copyright_line}'
    elif ext == '.css':
        return f'/* Version: {VERSION} - {DATE} */\n/* {copyright_line} */'
    else:
        return f'// Version: {VERSION} - {DATE}\n// {copyright_line}'

def update_file(filepath):
    ext = os.path.splitext(filepath)[1]
    if not os.path.exists(filepath):
        print("Filen findes ikke:", filepath)
        return
    with open(filepath, encoding='utf-8') as f:
        content = f.read()
    if ext == '.webmanifest':
        content = re.sub(r'^(<!-- Version:.*?-->\s*|// Version:.*?\n)+', '', content, flags=re.MULTILINE)
        new_content = version_line(ext) + '\n' + content.lstrip()
    elif ext == '.html':
        new_content, n = re.subn(r'^<!-- Version:.*?-->\s*(<!--.*?-->\s*)?', version_line(ext) + '\n', content, count=1, flags=re.MULTILINE)
        if n == 0:
            new_content = version_line(ext) + '\n' + content
        def add_version_tag(match):
            url = match.group(1)
            url = re.sub(r'\?v=[\d\.]+', '', url)
            return f'{url}?v={VERSION}"'
        new_content = re.sub(
            r'(href="[^"]+\.(css|webmanifest))(?:\?v=[\d\.]+)?"',
            add_version_tag,
            new_content
        )
        new_content = re.sub(
            r'(src="[^"]+\.js)(?:\?v=[\d\.]+)?"',
            add_version_tag,
            new_content
        )
    elif ext == '.css':
        new_content, n = re.subn(r'^/\* Version:.*?\*/\s*(/\*.*?\*/\s*)?', version_line(ext) + '\n', content, count=1, flags=re.MULTILINE)
        if n == 0:
            new_content = version_line(ext) + '\n' + content
    else:
        new_content = re.sub(
            r'^(// Version:.*?(\r?\n))+((//.*?(\r?\n))*)',
            '',
            content,
            flags=re.MULTILINE
        )
        new_content = version_line(ext) + '\n' + new_content
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print('Opdateret:', filepath)

if __name__ == '__main__':
    for file in FILES:
        update_file(os.path.join(os.path.dirname(__file__), file))
    print('Færdig!')
