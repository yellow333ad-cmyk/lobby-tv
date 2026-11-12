#!/bin/zsh
# Снимка на месечния пост 1080×1350 с локалния Chrome (страницата се сервира от site/ на порт 8765).
# Употреба: scripts/render-post.sh <изход.png|изход.pdf> [данни.json]
out=${1:?изходен файл}
url="http://localhost:8765/post.html${2:+?data=$2}"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
# Проверка, че страницата се рисува с правилните шрифтове (иначе спираме — по-добре без пост, отколкото грозен)
"$chrome" --headless=new --disable-gpu --virtual-time-budget=8000 --dump-dom "$url" 2>/dev/null | grep -q 'data-ready="1"' \
  || { echo "Постът не е готов (липсват данни или шрифтове): $url" >&2; exit 1; }
if [[ $out == *.pdf ]]; then
  "$chrome" --headless=new --disable-gpu --no-pdf-header-footer --virtual-time-budget=8000 --print-to-pdf="$out" "$url" 2>/dev/null
else
  "$chrome" --headless=new --disable-gpu --hide-scrollbars --window-size=1080,1350 --virtual-time-budget=8000 --screenshot="$out" "$url" 2>/dev/null
fi
