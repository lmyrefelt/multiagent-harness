#!/usr/bin/env bash
# godot-remote.sh — run Godot jobs for this project on the Linux render host.
#
# The repo lives only on this Mac. The render host keeps NO clone: every run
# ships a `git archive` snapshot of ONE exact commit over SSH, runs Godot there
# in a throw-away dir, copies the results back and deletes the dir.
#
# usage:
#   scripts/godot-remote.sh doctor                       # check the host is ready
#   scripts/godot-remote.sh <rev> check  [out-dir]       # import + load + qualification harnesses
#   scripts/godot-remote.sh <rev> export [out-dir]       # Web export (out/web/)
#   scripts/godot-remote.sh <rev> render [out-dir] [res://scenes/x.tscn ...]   # PNG per scene
#   scripts/godot-remote.sh <rev> browser [out-dir]      # Web export + Playwright specs in tests/browser_runner
#   scripts/godot-remote.sh <rev> serve                  # export + serve it on http://<host>:8090
#
# Config (env, or ~/.harness/config/godot-host.env):
#   GODOT_HOST      ssh target (default: godot-box — define it in ~/.ssh/config with the IP)
#   GODOT_BIN       godot binary on the host (default: godot)
#   GODOT_VERSION   required version prefix (default: read from project.godot, e.g. 4.7)
#   GODOT_TIMEOUT   seconds per job (default: 900)
#   GODOT_PORT      port for `serve` (default: 8090; 8067/8069 are reserved for the test jobs)
#   GODOT_PLAYWRIGHT_PATH  Playwright browsers dir on the host (default: /opt/playwright)
#   GODOT_NVM_DIR          nvm install on the host (default: /opt/nvm)
#   GODOT_DISPLAY / GODOT_XAUTHORITY  existing Ubuntu desktop session overrides
#
# Output dir (default .pi-session/qualify/manual/<sha12>/<job>/) gets:
#   revision.txt  log.txt  import.log  exit_code.txt  host.txt  PASSED.txt (only on success)  + job artifacts
# Exit: 0 pass · 1 job failed · 2 usage · 3 host/infra problem (unreachable, wrong Godot, ...)
set -uo pipefail

REPO=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "run inside the repo" >&2; exit 2; }
cd "$REPO"
CFG="$HOME/.harness/config/godot-host.env"
[ -f "$CFG" ] && . "$CFG"
HOST=${GODOT_HOST:-godot-box}
GBIN=${GODOT_BIN:-godot}
TIMEOUT=${GODOT_TIMEOUT:-900}
PORT=${GODOT_PORT:-8090}   # manual `serve` only - must not be a test port
PW_PATH=${GODOT_PLAYWRIGHT_PATH:-/opt/playwright}   # shared Playwright browsers on the host
NVM=${GODOT_NVM_DIR:-/opt/nvm}                     # shared nvm on the host
# Ubuntu desktop runs on :1 (GDM on :0). Default or override :0 to :1 per host configuration.
if [ "${GODOT_DISPLAY:-}" = ":0" ] || [ -z "${GODOT_DISPLAY:-}" ]; then
  GODOT_DISPLAY=":1"
fi
# Forward explicit display overrides as shell-quoted values, never as executable text.
DESKTOP_ENV=""
for desktop_key in GODOT_DISPLAY GODOT_XAUTHORITY; do
  if [ -n "${!desktop_key:-}" ]; then
    printf -v desktop_value '%q' "${!desktop_key}"
    DESKTOP_ENV+="export $desktop_key=$desktop_value"$'\n'
  fi
done
# Prepended to every remote script: node from nvm, Playwright browsers from PW_PATH.
HOSTENV="${DESKTOP_ENV}export NVM_DIR=$NVM PLAYWRIGHT_BROWSERS_PATH=$PW_PATH PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
[ -s $NVM/nvm.sh ] && . $NVM/nvm.sh >/dev/null 2>&1 && nvm use --silent default >/dev/null 2>&1 || true"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=20 -o TCPKeepAlive=yes "$HOST")
HERE=$(cd "$(dirname "$0")" && pwd)

infra() { echo "INFRA: $*" >&2; exit 3; }

want_version() {
  [ -n "${GODOT_VERSION:-}" ] && { echo "$GODOT_VERSION"; return; }
  git show "$1:godot-project/project.godot" 2>/dev/null \
    | sed -n 's/^config\/features=PackedStringArray("\([0-9.]*\)".*/\1/p' | head -1
}

doctor() {
  echo "host: $HOST"
  "${SSH[@]}" true 2>/dev/null || infra "cannot ssh to '$HOST' (key auth, BatchMode). Add it to ~/.ssh/config."
  "${SSH[@]}" "bash -s" <<REMOTE
$HOSTENV
ok=0
v=\$($GBIN --version 2>/dev/null) && echo "godot: \$v" || { echo "MISSING: $GBIN"; ok=3; }
V=\$($GBIN --version 2>/dev/null | cut -d. -f1-3)
T=~/.local/share/godot/export_templates/\$V
[ -d "\$T" ] && echo "export templates: \$T" || { echo "MISSING: export templates folder \$T"; ok=3; }
for z in web_nothreads_debug.zip web_nothreads_release.zip web_debug.zip web_release.zip; do
  [ -f "\$T/\$z" ] && echo "  ok \$z" || { echo "  MISSING \$T/\$z"; ok=3; }
done
command -v xvfb-run >/dev/null && echo "xvfb-run: ok" || { echo "MISSING: xvfb-run (needed for render)"; ok=3; }
command -v python3 >/dev/null && echo "python3: ok" || echo "optional: python3 (for serve)"
command -v npx >/dev/null && echo "node: \$(node --version)" || { echo "MISSING: node/npm (needed for the browser/Playwright job)"; ok=3; }
echo "PLAYWRIGHT_BROWSERS_PATH=$PW_PATH  NVM_DIR=$NVM"
ls -d $PW_PATH/chromium* >/dev/null 2>&1 && echo "playwright browsers: \$(ls -d $PW_PATH/chromium* | xargs -n1 basename | tr '\n' ' ')" || { echo "MISSING: Chromium under $PW_PATH (PLAYWRIGHT_BROWSERS_PATH=$PW_PATH npx playwright install --with-deps chromium)"; ok=3; }
[ -r $PW_PATH ] || { echo "NOT READABLE by \$(whoami): $PW_PATH"; ok=3; }
command -v tar >/dev/null || { echo "MISSING: tar"; ok=3; }
df -h /tmp | tail -1
exit \$ok
REMOTE
  rc=$?
  want=$(want_version HEAD); echo "project wants Godot: ${want:-unknown}"
  [ $rc -eq 0 ] && echo "doctor: OK" || echo "doctor: NOT READY"
  exit $rc
}

[ "${1:-}" = "doctor" ] && doctor
[ $# -ge 2 ] || { sed -n '2,25p' "$0"; exit 2; }

SHA=$(git rev-parse --verify "$1^{commit}" 2>/dev/null) || { echo "unknown revision: $1" >&2; exit 2; }
JOB=$2; shift 2
case "$JOB" in check|export|render|browser|serve) ;; *) echo "unknown job: $JOB" >&2; exit 2;; esac
git cat-file -e "$SHA:godot-project/project.godot" 2>/dev/null || { echo "$SHA has no godot-project/" >&2; exit 2; }

OUT=${1:-.pi-session/qualify/manual/${SHA:0:12}/$JOB}; [ $# -gt 0 ] && shift
SCENES=("$@")
mkdir -p "$OUT"; rm -f "$OUT/PASSED.txt"
echo "$SHA" > "$OUT/revision.txt"
RUN="/tmp/jv-run-${SHA:0:12}-$JOB-$$"
WANT=$(want_version "$SHA")

"${SSH[@]}" "mkdir -p $RUN/out" 2>/dev/null || infra "cannot ssh to '$HOST'"
trap '"${SSH[@]}" "rm -rf $RUN" >/dev/null 2>&1 || true' EXIT

# Ship the exact commit (only godot-project/) + the capture helper.
git archive --format=tar "$SHA" godot-project | "${SSH[@]}" "tar -x -C $RUN" || infra "upload failed"
"${SSH[@]}" "mkdir -p $RUN/godot-project/.jv_tools && cat > $RUN/godot-project/.jv_tools/capture_scenes.gd" \
  < "$HERE/godot/capture_scenes.gd" || infra "upload failed"

"${SSH[@]}" "cat > $RUN/.jv-desktop-session.py" \
  < "$HERE/godot/desktop_session.py" || infra "desktop helper upload failed"

SCENE_ARGS=""; for s in "${SCENES[@]+"${SCENES[@]}"}"; do SCENE_ARGS+=" $(printf %q "$s")"; done

# Progress heartbeat (2026-10-20): the remote job writes only to log.txt, so a
# 30-minute render looked exactly like a hung agent - to the agent (no output),
# to Herdr and to the watchdog. Every GODOT_PROGRESS_SECONDS (default 60) this
# prints one status line to stderr (the agent sees the job is alive) and
# refreshes .pi-session/activity/godot-<job>-<rev>.json (the watchdog's
# activity probe treats a heartbeat younger than 5 min as "working").
PROGRESS_SECS=${GODOT_PROGRESS_SECONDS:-60}
ACT_DIR="$REPO/.pi-session/activity"; mkdir -p "$ACT_DIR" 2>/dev/null || true
ACT_FILE="$ACT_DIR/godot-$JOB-${SHA:0:12}.json"
START_TS=$(date +%s)
progress() {
  local now el lines last
  now=$(date +%s); el=$((now - START_TS))
  lines=$( [ -f "$OUT/log.txt" ] && wc -l < "$OUT/log.txt" | tr -d ' ' )
  last=$(tail -n 1 "$OUT/log.txt" 2>/dev/null | tr -d '"\\' | tr -d '\000-\037' | cut -c1-160)
  printf '{"tool":"godot-remote","job":"%s","rev":"%s","state":"%s","started":%s,"updated":%s,"elapsed_s":%s,"step_budget_s":%s,"log":"%s","log_lines":%s,"last_line":"%s"}\n' \
    "$JOB" "${SHA:0:12}" "$1" "$START_TS" "$now" "$el" "$TIMEOUT" "$OUT/log.txt" "${lines:-0}" "$last" > "$ACT_FILE.tmp" 2>/dev/null \
    && mv -f "$ACT_FILE.tmp" "$ACT_FILE" 2>/dev/null
  [ "$1" = running ] && echo "[godot-remote] $JOB @${SHA:0:12} still running: ${el}s elapsed (per-step timeout ${TIMEOUT}s), log.txt ${lines:-0} lines; last: ${last:-<nothing yet>}" >&2
  return 0
}
progress started
( while sleep "$PROGRESS_SECS"; do progress running; done ) & PROGRESS_PID=$!
trap 'kill $PROGRESS_PID 2>/dev/null; "${SSH[@]}" "rm -rf $RUN" >/dev/null 2>&1 || true' EXIT

"${SSH[@]}" "bash -s" > "$OUT/log.txt" 2>&1 <<REMOTE
$HOSTENV
set -uo pipefail
cd $RUN
G=$GBIN
v=\$(\$G --version 2>/dev/null) || { echo "INFRA: godot binary '$GBIN' not found on host"; exit 3; }
echo "godot \$v on \$(hostname)" | tee out/host.txt
case "\$v" in ${WANT:-*}*) ;; *) echo "INFRA: host has Godot \$v, project needs ${WANT}"; exit 3;; esac
P="--path godot-project"
run() { echo "+ \$*"; timeout $TIMEOUT "\$@"; }
# Test servers bind fixed ports (8067 suites, 8069 release-bridge check - project contract).
# Free them before the job (a crashed earlier run may still hold them) and kill
# everything this job started when it ends, so no server outlives its run.
TEST_PORTS="${GODOT_TEST_PORTS:-8067 8069}"
free_ports() {
  for p in \$TEST_PORTS; do
    for pid in \$(ss -ltnpH "sport = :\$p" 2>/dev/null | grep -o 'pid=[0-9]*' | cut -d= -f2 | sort -u); do
      echo "freeing port \$p: killing stale pid \$pid (\$(ps -o args= -p \$pid 2>/dev/null | cut -c1-80))"
      kill \$pid 2>/dev/null; sleep 1; kill -9 \$pid 2>/dev/null || true
    done
    if ss -ltnH "sport = :\$p" 2>/dev/null | grep -q .; then echo "INFRA: port \$p is held by another user's process - free it on the host"; exit 3; fi
  done
}
cleanup() { pkill -P \$\$ 2>/dev/null; pkill -f "$RUN/" 2>/dev/null; free_ports >/dev/null 2>&1 || true; }
trap cleanup EXIT
free_ports
# First open: import resources so scripts/scenes resolve (exit code is unreliable here).
# The exit code proves nothing, so the RESULT is checked instead: every importable asset
# needs its .import file and every dest_files target. An incomplete import is a HOST
# problem (exit 3) - left silent it surfaces as dozens of misleading "clip missing" /
# "font not loaded" suite failures (CHANGE-0013 integrator-review-17 F23).
run \$G --headless \$P --import > out/import.log 2>&1; irc=\$?
checked=0; missing=0; sample=""
while IFS= read -r -d '' src; do
  checked=\$((checked+1))
  if [ ! -f "\$src.import" ]; then
    missing=\$((missing+1)); sample+=" \${src#godot-project/}(no .import)"; continue
  fi
  while IFS= read -r dest; do
    [ -n "\$dest" ] && [ ! -f "godot-project/\${dest#res://}" ] && { missing=\$((missing+1)); sample+=" \${dest#res://}"; }
  done < <(grep -h '^dest_files=' "\$src.import" | grep -o 'res://[^"]*')
done < <(find godot-project -path godot-project/.godot -prune -o -type f \( -iname '*.png' -o -iname '*.svg' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.webp' -o -iname '*.ttf' -o -iname '*.otf' -o -iname '*.woff' -o -iname '*.woff2' -o -iname '*.wav' -o -iname '*.ogg' -o -iname '*.mp3' \) -print0)
echo "import: exit \$irc, \$checked asset(s) checked, \$missing missing (log: import.log)"
if [ "\$missing" -gt 0 ]; then
  echo "INFRA: resource import incomplete (godot --import exit \$irc): \$missing imported file(s) missing:\$(echo "\$sample" | cut -c1-400)"
  tail -n 20 out/import.log
  exit 3
fi
rc=0
# Use the existing Ubuntu desktop (GNOME/KDE/etc.), with xvfb-run fallback if desktop is unprobed.
run_headed() {
  if python3 "$RUN/.jv-desktop-session.py" --diagnose; then
    run python3 "$RUN/.jv-desktop-session.py" "\$@"
  elif command -v xvfb-run >/dev/null 2>&1; then
    echo "headed qualification: fallback to host xvfb-run (desktop session unavailable)"
    run xvfb-run -a -s "-screen 0 1920x1080x24" "\$@"
  else
    run python3 "$RUN/.jv-desktop-session.py" "\$@"
  fi
}
case $JOB in
  check)
    out=\$(run \$G --headless \$P --quit 2>&1); echo "\$out"
    echo "\$out" | grep -E "SCRIPT ERROR|Parse Error|Failed to load|ERROR: .*res://" && rc=1
    if [ -f godot-project/tests/run_qualification.sh ]; then
      PATH="\$(dirname "\$(command -v \$G)"):\$PATH" JV_BROWSER_HEADED=1 run_headed bash godot-project/tests/run_qualification.sh || rc=1
    fi ;;
  export|serve)
    mkdir -p godot-project/export/web
    out=\$(run \$G --headless \$P --export-release Web 2>&1); r=\$?; echo "\$out"
    [ \$r -eq 0 ] && [ -f godot-project/export/web/index.html ] || rc=1
    cp -r godot-project/export/web out/web 2>/dev/null || true ;;
  render)
    run xvfb-run -a -s "-screen 0 1280x720x24" \$G --rendering-driver opengl3 --resolution 1280x720 \$P \
      -s res://.jv_tools/capture_scenes.gd ++ $RUN/out$SCENE_ARGS || rc=1
    n=\$(ls out/*.png 2>/dev/null | wc -l); echo "screenshots: \$n"
    [ "\$n" -gt 0 ] || { echo "FAIL: render produced no screenshots"; rc=1; } ;;
  browser)
    # Web export + the project's Playwright specs (tests/browser_runner) against it.
    BR=godot-project/tests/browser_runner
    [ -f \$BR/package.json ] || { echo "FAIL: no \$BR/package.json"; exit 1; }
    command -v npx >/dev/null || { echo "INFRA: node/npx not installed on host"; exit 3; }
    mkdir -p godot-project/export/web
    run \$G --headless \$P --export-debug Web > out/export.log 2>&1 || true
    [ -f godot-project/export/web/index.html ] || { echo "FAIL: Web export failed - see export.log"; tail -20 out/export.log; exit 1; }
    cd \$BR
    run npm ci --no-audit --no-fund || run npm install --no-audit --no-fund || { echo "INFRA: npm install failed"; exit 3; }
    (npm run serve > ../../../out/serve.log 2>&1 &) ; sleep 3
    JV_BROWSER_HEADED=1 PLAYWRIGHT_HTML_OPEN=never PLAYWRIGHT_HTML_REPORT=$RUN/out/playwright-report PLAYWRIGHT_JUNIT_OUTPUT_NAME=$RUN/out/results.xml run_headed npx playwright test --headed --reporter=line,junit,html \
      > $RUN/out/playwright.log 2>&1 || rc=1
    cat $RUN/out/playwright.log | tail -60
    cp -r test-results $RUN/out/ 2>/dev/null || true
    cd $RUN ;;
esac
exit \$rc
REMOTE
RC=$?
kill $PROGRESS_PID 2>/dev/null; wait $PROGRESS_PID 2>/dev/null; progress "done exit=$RC"

rsync -a -e "ssh -o BatchMode=yes" "$HOST:$RUN/out/" "$OUT/" 2>/dev/null \
  || "${SSH[@]}" "tar -C $RUN/out -cf - ." | tar -x -C "$OUT" 2>/dev/null || true
# A failure caused by the HOST (not the change) is reported as exit 3 -> runner `blocked`
# -> the owner, so it never costs the worker an implementation round.
HOST_PATTERNS='^INFRA:|EADDRINUSE|address already in use|could not serve on port|No export template found|Executable doesn.t exist at|browserType\.launch|Host system is missing dependencies|playwright install|Playwright not provisioned|Playwright-missing|node-missing|ENOSPC|No space left on device|godot: command not found|npx: command not found|xvfb-run: command not found|Cannot open display|Connection reset by peer|Broken pipe'
if [ "$RC" -ne 0 ] && [ "$RC" -ne 3 ]; then
  HITS=$(cat "$OUT"/log.txt "$OUT"/serve.log "$OUT"/playwright.log 2>/dev/null | grep -E -m5 "$HOST_PATTERNS" || true)
  if [ -n "$HITS" ]; then
    { echo "Classified as a HOST problem (exit $RC -> 3). Matching lines:"; echo "$HITS"; } > "$OUT/HOST_PROBLEM.txt"
    echo "host problem detected -> exit 3 (see HOST_PROBLEM.txt)"
    RC=3
  fi
fi
echo "$RC" > "$OUT/exit_code.txt"

if [ "$JOB" = serve ] && [ $RC -eq 0 ]; then
  SERVE=/tmp/jv-serve
  "${SSH[@]}" "pkill -f 'http.server $PORT' 2>/dev/null; rm -rf $SERVE && mkdir -p $SERVE && cp -r $RUN/out/web/. $SERVE/ \
    && cd $SERVE && (nohup python3 -m http.server $PORT >/dev/null 2>&1 &)" \
    && echo "serving ${SHA:0:12} at http://$(ssh -G "$HOST" | awk '/^hostname /{print $2}'):$PORT"
fi

[ $RC -eq 0 ] && date -u +%FT%TZ > "$OUT/PASSED.txt"
echo "$JOB ${SHA:0:12}: exit=$RC -> $OUT"
exit $RC
