#!/bin/zsh
# Месечният пост за шофьорите (всеки понеделник): пресни данни → PNG + PDF в posts/<дата>/.
# Употреба: scripts/make-post.sh   → отпечатва пътищата до двата файла.
set -e
cd "${0:A:h}/.."
git pull -q --rebase --autostash

# Данните трябва да са от днес (след полунощ в понеделник), иначе пускаме робота и чакаме.
today=$(TZ=Europe/Sofia date +%F)
fresh() { python3 -c "
import json,sys
d=json.load(open('site/data/leaderboard.json'))
from datetime import datetime, timezone, timedelta
u=datetime.fromisoformat(d['updatedAt'].replace('Z','+00:00')).astimezone(timezone(timedelta(hours=2)))
sys.exit(0 if 'monthPost' in d and u.strftime('%F')>='$today' else 1)"; }
if ! fresh; then
  echo "Данните са стари — пускам робота…" >&2
  gh workflow run update.yml -R yellow333ad-cmyk/lobby-tv
  sleep 8
  id=$(gh run list -R yellow333ad-cmyk/lobby-tv -L 1 --event workflow_dispatch --json databaseId -q '.[0].databaseId')
  gh run watch "$id" -R yellow333ad-cmyk/lobby-tv --exit-status >/dev/null
  sleep 5; git pull -q --rebase --autostash
  fresh || { echo "Роботът не даде пресни данни" >&2; exit 1; }
fi

out="posts/$today"; mkdir -p "$out"
(cd site && exec python3 -m http.server 8765 >/dev/null 2>&1) & srv=$!
trap 'kill $srv 2>/dev/null' EXIT
sleep 1
scripts/render-post.sh "$out/post.png"
scripts/render-post.sh "$out/post.pdf"
python3 -c "
import json; m=json.load(open('site/data/leaderboard.json'))['monthPost']
print('Месец:', m['month'], '| период:', m['from'], '–', m['to'], '| финал' if m['final'] else '| остават %d дни' % m['daysLeft'],
      '| отзиви:', m['total'], '| +за седмицата:', m['weekGain'], '| шофьори:', m['drivers'])
print('Топ 3:', ', '.join('%s (%d)' % (p['car'], p['reviews']) for p in m['top'][:3]))"
echo "PNG: $PWD/$out/post.png"
echo "PDF: $PWD/$out/post.pdf"
