#!/bin/zsh
# Render the round's stills. Usage: ./render_stills.sh <skin> <prefix>
# Each still: name | window size | query string. desk=1 paints a fake desktop
# behind the floating app (fixture-only).
skin=${1:-minimal}; pre=${2:-v4}
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
F="file://$PWD/fixture.html"
shot() { "$CH" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=2 ${=4} \
  --window-size=$2 --screenshot="$PWD/stills/${pre}_${skin}_$1.png" "$F?skin=$skin&$3" 2>/dev/null; }
shot cards        1100,1000 "desk=1&timeline=0&log=0"
shot panels       1100,1000 "desk=1"
shot compressed   1100,900  "desk=1&tlmode=compressed&menu=1"
shot stack        520,1100  "desk=1&layout=stack&tlmode=compressed&log=0"
shot dark         1100,900  "desk=1" "--force-dark-mode --blink-settings=preferredColorScheme=0"
shot fresh        1100,700  "desk=1&fresh=1"
shot gallery      1100,1500 "gallery=1"
ls -1 stills/${pre}_${skin}_*.png
