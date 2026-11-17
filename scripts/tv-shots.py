#!/usr/bin/env python3
"""Кадри от пробната страница за телевизора (site/v2.html) в 1920×1080 с локалния Chrome.

  scripts/tv-shots.py ИЗХОДНА_ПАПКА име=заявка [име=заявка ...] [--sheet файл.png] [--cols 4] [--page v2.html]

Пример:  scripts/tv-shots.py /tmp/out week="mode=week&t=8&data=demo-data/tv-mid.json&today=2026-11-19"
Всеки кадър се проверява: страницата трябва да каже data-ready="1" (нищо не излиза от рамката, няма грешки).
"""
import os, subprocess, sys, tempfile, socket, time, re
from concurrent.futures import ThreadPoolExecutor
from PIL import Image, ImageDraw

CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8765

def serve():
    s = socket.socket()
    busy = s.connect_ex(('127.0.0.1', PORT)) == 0
    s.close()
    if busy: return None
    p = subprocess.Popen([sys.executable, '-m', 'http.server', str(PORT)], cwd=os.path.join(ROOT, 'site'), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    return p

def shot(args):
    name, query, out, page = args
    url = f'http://localhost:{PORT}/{page}?{query}'
    png = os.path.join(out, name + '.png')
    with tempfile.TemporaryDirectory() as prof:
        base = [CHROME, '--headless=new', '--disable-gpu', '--hide-scrollbars', f'--user-data-dir={prof}', '--window-size=1920,1080', '--virtual-time-budget=6000']
        dom = subprocess.run(base + ['--dump-dom', url], capture_output=True, text=True).stdout
        subprocess.run(base + [f'--screenshot={png}', url], capture_output=True)
    ready = re.search(r'data-ready="([^"]*)"', dom)
    err = re.search(r'data-err="([^"]*)"', dom)
    return name, png, (ready.group(1) if ready else 'no ready flag'), (err.group(1) if err else '')

def main():
    a = sys.argv[1:]
    opt = {'--sheet': None, '--cols': '4', '--page': 'v2.html'}
    for k in list(opt):
        if k in a:
            i = a.index(k); opt[k] = a[i + 1]; del a[i:i + 2]
    out = a[0]; os.makedirs(out, exist_ok=True)
    jobs = [(x.split('=', 1)[0], x.split('=', 1)[1], out, opt['--page']) for x in a[1:]]
    srv = serve()
    try:
        with ThreadPoolExecutor(6) as ex: res = list(ex.map(shot, jobs))
    finally:
        if srv: srv.terminate()
    bad = 0
    for name, png, ready, err in res:
        ok = ready == '1' and not err
        bad += not ok
        print(('OK   ' if ok else 'FAIL ') + name + ('' if ok else f'  ready={ready} err={err}'))
    if opt['--sheet']:
        cols = int(opt['--cols']); w, h = 640, 360
        rows = (len(res) + cols - 1) // cols
        sheet = Image.new('RGB', (cols * (w + 8) + 8, rows * (h + 30) + 8), '#2a2a2a')
        d = ImageDraw.Draw(sheet)
        for i, (name, png, ready, err) in enumerate(res):
            x, y = 8 + (i % cols) * (w + 8), 8 + (i // cols) * (h + 30)
            if os.path.exists(png): sheet.paste(Image.open(png).convert('RGB').resize((w, h), Image.LANCZOS), (x, y + 22))
            d.text((x + 2, y + 4), name + ('' if ready == '1' else '  [' + ready[:60] + ']'), fill='#fff' if ready == '1' else '#f66')
        sheet.save(opt['--sheet'])
    sys.exit(1 if bad else 0)

if __name__ == '__main__':
    main()
