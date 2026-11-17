#!/bin/zsh
# Снимка на месечния пост 1080×1350 с локалния Chrome (страницата се сервира от site/ на порт 8765).
# Употреба: scripts/render-post.sh <изход.png|изход.pdf> [данни.json] [още параметри, напр. n=5]
out=${1:?изходен файл}
url="http://localhost:8765/post.html?${2:+data=$2}${3:+&$3}"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Проверка, че страницата се рисува с правилните шрифтове (иначе спираме — по-добре без пост, отколкото грозен)
"$chrome" --headless=new --disable-gpu --virtual-time-budget=8000 --dump-dom "$url" 2>/dev/null | grep -q 'data-ready="1"' \
  || { echo "Постът не е готов (липсват данни или шрифтове, или текст излиза от рамката): $url" >&2; exit 1; }
# PDF-ът се прави от същата снимка: при печат Chrome не рисува стъклото (backdrop-filter) правилно.
png=$out; [[ $out == *.pdf ]] && png=$(mktemp -t post).png
# Снимаме по-висок прозорец и режем до 1350: при точен размер Chrome понякога не дорисува последните ~40px от фона
"$chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1080,1600 --virtual-time-budget=8000 --screenshot="$png" "$url" 2>/dev/null
python3 -c "
import sys
from PIL import Image
im = Image.open(sys.argv[1]).crop((0, 0, 1080, 1350))
if sys.argv[2].endswith('.pdf'): im.convert('RGB').save(sys.argv[2], resolution=72.0, quality=95)
else: im.save(sys.argv[2])" "$png" "$out" || { echo "Не успях да запиша $out" >&2; exit 1; }
[[ $png != $out ]] && rm -f "$png"
exit 0
