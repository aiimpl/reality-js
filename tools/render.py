# 使い方: python tools/render.py 出力ディレクトリ 時刻... | --range 開始 終了 fps
# ブラウザが落ちても、できたコマは飛ばして続きから描く
import sys, os, time, base64
from playwright.sync_api import sync_playwright

out = sys.argv[1]
if sys.argv[2] == '--range':
    a, b, fps = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
    times = [a + i / fps for i in range(int(round((b - a) * fps)))]
    names = [f'{i:05d}.png' for i in range(len(times))]
else:
    times = [float(x) for x in sys.argv[2:]]
    names = [f't{t:05.2f}.png' for t in times]
os.makedirs(out, exist_ok=True)
url = os.environ.get('URL', 'http://127.0.0.1:8791/index.html?render')
todo = [(t, n) for t, n in zip(times, names) if not os.path.exists(os.path.join(out, n))] if sys.argv[2] == '--range' else list(zip(times, names))
t0 = time.time(); done = 0
with sync_playwright() as p:
    for attempt in range(20):
        if not todo: break
        try:
            b = p.chromium.launch(channel='chrome', headless=False,
                                  args=['--window-position=-2400,0', '--ignore-gpu-blocklist'])
            pg = b.new_page(viewport={'width': 1920, 'height': 1080}, device_scale_factor=1)
            pg.on('console', lambda m: print('console:', m.text[:400]) if '404' not in m.text else None)
            pg.on('pageerror', lambda e: print('pageerror:', e))
            pg.goto(url)
            pg.wait_for_function('window.ready === true', timeout=60000)
            k = 0
            while todo and k < 80:          # 80コマごとにブラウザを作り直す
                t, n = todo[0]
                pg.evaluate(f'window.renderAt({t})')
                data = pg.evaluate("document.querySelector('canvas').toDataURL('image/png')")
                open(os.path.join(out, n), 'wb').write(base64.b64decode(data.split(',')[1]))
                todo.pop(0); done += 1; k += 1
            b.close()
        except Exception as e:
            print('retry:', str(e)[:120])
            try: b.close()
            except Exception: pass
print('frames', done, 'left', len(todo), 'sec/frame %.2f' % ((time.time() - t0) / max(1, done)))
