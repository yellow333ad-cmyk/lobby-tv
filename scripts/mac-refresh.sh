#!/bin/zsh
# Резервно обновяване от Mac-а: GitHub често пуска своя график с часове закъснение,
# затова на всеки час между 7 и 22 ч. казваме на GitHub да пусне робота веднага.
# Работи само докато Mac-ът е включен; ако е заспал, launchd го пуска веднъж при събуждане.
# Инсталиран като ~/Library/LaunchAgents/com.yellow.lobby-tv.refresh.plist
# Спиране: launchctl bootout gui/$(id -u)/com.yellow.lobby-tv.refresh
h=$(date +%H)
(( 10#$h >= 7 && 10#$h <= 22 )) || exit 0
echo "$(date '+%F %T') пускам робота"
/Users/frazer/.local/bin/gh workflow run update.yml -R yellow333ad-cmyk/lobby-tv
