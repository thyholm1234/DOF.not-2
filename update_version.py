# Brug: python update_version.py 1.2.3

import os
import sys
import re
from datetime import date

FILES = [
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
DATE = date.today().isoformat()

def version_line(ext):
    if ext == '.html':
        return f'<!-- Version: {VERSION} - {DATE} -->'
    elif ext == '.webmanifest' or ext == '.json':
        return f'// Version: {VERSION} - {DATE}'
    elif ext == '.css':
        return f'/* Version: {VERSION} - {DATE} */'
    else:
        return f'// Version: {VERSION} - {DATE}'

def update_file(filepath):
    ext = os.path.splitext(filepath)[1]
    if not os.path.exists(filepath):
        print("Filen findes ikke:", filepath)
        return
    with open(filepath, encoding='utf-8') as f:
        content = f.read()
    if ext == '.webmanifest':
        # Fjern ALLE version-linjer i toppen, både <!-- ... --> og // ...
        content = re.sub(r'^(<!-- Version:.*?-->\s*|// Version:.*?\n)+', '', content, flags=re.MULTILINE)
        new_content = content.lstrip()  # Ingen version-linje tilføjes!
    elif ext == '.html':
        new_content, n = re.subn(r'^<!-- Version:.*?-->\s*', version_line(ext) + '\n', content, count=1, flags=re.MULTILINE)
        if n == 0:
            new_content = version_line(ext) + '\n' + content
        # Tilføj eller opdater version-tags på .css, .js, .webmanifest
        def add_version_tag(match):
            url = match.group(1)
            # Fjern evt. eksisterende ?v=...
            url = re.sub(r'\?v=[\d\.]+', '', url)
            return f'{url}?v={VERSION}"'
        # <link rel="stylesheet" href="style.css">
        new_content = re.sub(
            r'(href="[^"]+\.(css|webmanifest))(?:\?v=[\d\.]+)?"',
            add_version_tag,
            new_content
        )
        # <script src="app.js"></script>
        new_content = re.sub(
            r'(src="[^"]+\.js)(?:\?v=[\d\.]+)?"',
            add_version_tag,
            new_content
        )
    elif ext == '.css':
        new_content, n = re.subn(r'^/\* Version:.*?\*/\s*', version_line(ext) + '\n', content, count=1, flags=re.MULTILINE)
        if n == 0:
            new_content = version_line(ext) + '\n' + content
    else:
        # Fjern alle version-linjer og gamle version-numre i toppen
        new_content = re.sub(
            r'^(// Version:.*?(\r?\n))+((\d+\.\d+\.\d+ - \d{4}-\d{2}-\d{2}\r?\n)*)',
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