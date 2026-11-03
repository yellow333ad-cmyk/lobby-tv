#!/bin/zsh
# Снимка на слайда в 1920×1080 с локалния Chrome (за преглед на дизайна).
# Употреба: scripts/render-slide.sh <изход.png>
out=${1:?изходен файл}
url="http://localhost:8765/?mode=slide"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --disable-gpu --hide-scrollbars \
  --window-size=1920,1080 --virtual-time-budget=6000 --screenshot="$out" "$url" 2>/dev/null
