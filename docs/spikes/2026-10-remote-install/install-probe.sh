# Remote phase 3, probe: install the Centralu host on Linux without npm, sudo or build tools.
# docs/plans/remote-hub.md §10. Throwaway; kept so the measurement can be re-run.
#
# Run from the hub through `run-probe.mjs` (which sets ROOT, NODE_V, CENTRALU_V, MODE and LAUNCH
# first), or by hand in bash after setting them. Everything happens under $ROOT; CC_DATA_DIR points
# inside it. Prints one `STEP <name> <ms> <result>` line per measured step. Modes as in
# install-probe.ps1: install, serve, check, locks, stop, clean, plus `once` (install, sizes, serve, locks,
# clean in one session: WSL empties /tmp when the distro stops, about 15 s after its last client).
set -u
case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "STEP arch 0 FAIL $(uname -m)"; exit 1 ;; esac
DL="$ROOT/dl"
VER="$ROOT/remote/versions/$CENTRALU_V"
NODE_DIR="$ROOT/remote/node/v$NODE_V"
NODE="$NODE_DIR/bin/node"
CLI="$VER/node_modules/centralu/bin/centralu.mjs"
DATA="$ROOT/data"
PIDS="$ROOT/pids.txt"
export CC_DATA_DIR="$DATA"

now() { date +%s%3N; }
step() { # step <name> <command...>: runs it, prints STEP with its time and last output line
  name=$1; shift
  t0=$(now)
  if out=$("$@" 2>&1); then r=ok; else r=FAIL; fi
  echo "STEP $name $(( $(now) - t0 )) $r $(printf %s "$out" | tail -n 1)"
}
fetch() { # fetch <url> <file>: curl, else wget
  if command -v curl >/dev/null 2>&1; then curl -sSfL --retry 2 -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"
  else echo "neither curl nor wget"; return 1; fi
  echo "$(wc -c < "$2") bytes"
}
node_dl() {
  f="node-v$NODE_V-linux-$ARCH.tar.gz"
  fetch "https://nodejs.org/dist/v$NODE_V/$f" "$DL/$f" >/dev/null || return 1
  fetch "https://nodejs.org/dist/v$NODE_V/SHASUMS256.txt" "$DL/SHASUMS256.txt" >/dev/null || return 1
  (cd "$DL" && grep "  $f\$" SHASUMS256.txt | sha256sum -c --status) || { echo "sha256 mismatch"; return 1; }
  echo "$(wc -c < "$DL/$f") bytes, sha256 ok"
}
node_unpack() {
  t="$ROOT/remote/node/.partial"
  mkdir -p "$t" && tar -xzf "$DL/node-v$NODE_V-linux-$ARCH.tar.gz" -C "$t" --strip-components 1 && mv "$t" "$NODE_DIR" || return 1
  echo "$(du -sm "$NODE_DIR" | cut -f1) MB unpacked"
}
npm_pkg() { # npm_pkg <name> <dest>: the registry's tarball, checked against its integrity, unpacked
  meta=$(fetch_meta "$1") || return 1
  url=$(printf %s "$meta" | sed -n 's/.*"tarball":"\([^"]*\)".*/\1/p')
  want=$(printf %s "$meta" | sed -n 's/.*"integrity":"\(sha512-[^"]*\)".*/\1/p')
  f="$DL/$(printf %s "$1" | tr '@/' '__').tgz"
  fetch "$url" "$f" >/dev/null || return 1
  # The pinned Node is in place by now, so it hashes: no openssl or xxd needed
  have="sha512-$("$NODE" -e "process.stdout.write(require('crypto').createHash('sha512').update(require('fs').readFileSync(process.argv[1])).digest('base64'))" "$f")"
  [ "$have" = "$want" ] || { echo "integrity mismatch ($have vs $want)"; return 1; }
  mkdir -p "$2" && tar -xzf "$f" -C "$2" --strip-components 1 || return 1
  echo "$(wc -c < "$f") bytes, integrity ok"
}
fetch_meta() {
  if command -v curl >/dev/null 2>&1; then curl -sSfL "https://registry.npmjs.org/$1/$CENTRALU_V"
  else wget -q -O - "https://registry.npmjs.org/$1/$CENTRALU_V"; fi
}
native() {
  hostdir="$VER/node_modules/@centralu/linux-$ARCH/host"
  "$NODE" -e "const r=require('module').createRequire(process.argv[1]+'/x');const D=r('better-sqlite3');const d=new D(':memory:');const v=d.prepare('select sqlite_version() v').get().v;const p=r('node-pty');const t=p.spawn('/bin/sh',['-c','echo pty-ok'],{});let o='';t.onData(x=>o+=x);t.onExit(()=>{console.log('sqlite '+v+', abi '+process.versions.modules+', napi '+process.versions.napi+', pty '+(o.includes('pty-ok')?'ok':'no output'));process.exit(0)})" "$hostdir"
}
wait_up() {
  t0=$(now)
  while [ $(( $(now) - t0 )) -lt 30000 ]; do
    if "$NODE" "$CLI" serve --connection 2>/dev/null | grep -q '"hostRunning":true'; then echo "STEP serve-up-$1 $(( $(now) - t0 )) ok pid $2"; return 0; fi
    sleep 0.3
  done
  echo "STEP serve-up-$1 $(( $(now) - t0 )) FAIL pid $2"
}

sizes() {
  n="$NODE_DIR"
  echo "INFO node folder: $(du -sm "$n" | cut -f1) MB; bin/node $(du -sm "$n/bin/node" | cut -f1), include $(du -sm "$n/include" | cut -f1), lib/node_modules (npm, corepack) $(du -sm "$n/lib/node_modules" | cut -f1), share $(du -sm "$n/share" | cut -f1)"
  if command -v xz >/dev/null 2>&1; then
    t0=$(now); fetch "https://nodejs.org/dist/v$NODE_V/node-v$NODE_V-linux-$ARCH.tar.xz" "$DL/n.tar.xz" >/dev/null; t1=$(now)
    mkdir -p "$DL/x" && tar -xJf "$DL/n.tar.xz" -C "$DL/x"; t2=$(now)
    echo "INFO node .tar.xz: $(wc -c < "$DL/n.tar.xz") bytes, download $((t1 - t0)) ms, unpack $((t2 - t1)) ms (needs xz)"
    rm -rf "$DL/x" "$DL/n.tar.xz"
  fi
}

run() {
case "$1" in
  once)
    run install; sizes
    SERVE_PORT=${SERVE_PORT:-17176} LAUNCH=setsid run serve
    run check; run locks; run clean
    ;;
  install)
    mkdir -p "$DL" "$DATA"
    echo "INFO $(uname -srm) glibc $(ldd --version 2>/dev/null | head -n1 | sed 's/.* //') tools: $(for t in curl wget tar gzip xz sha256sum sha512sum openssl base64 xxd systemctl; do command -v $t >/dev/null 2>&1 && printf '%s ' $t; done)"
    step node-download node_dl
    step node-unpack node_unpack
    step node-version "$NODE" --version
    step pkg-shim npm_pkg centralu "$VER/node_modules/centralu"
    step pkg-platform npm_pkg "@centralu/linux-$ARCH" "$VER/node_modules/@centralu/linux-$ARCH"
    # What the AppImage costs a host-only install: the bytes a host-only package would save
    echo "INFO platform package: AppImage $(du -sm "$VER/node_modules/@centralu/linux-$ARCH/Centralu.AppImage" | cut -f1) MB, host $(du -sm "$VER/node_modules/@centralu/linux-$ARCH/host" | cut -f1) MB"
    step native-modules native
    step connection-cold "$NODE" "$CLI" serve --connection
    echo "INFO remote folder $(du -sm "$ROOT/remote" | cut -f1) MB"
    ;;
  serve)
    case "$LAUNCH" in
      setsid) setsid nohup "$NODE" "$CLI" serve ${SERVE_PORT:+--port "$SERVE_PORT"} >/dev/null 2>"$ROOT/serve-setsid.err" < /dev/null & p=$! ;;
      *) nohup "$NODE" "$CLI" serve ${SERVE_PORT:+--port "$SERVE_PORT"} >/dev/null 2>"$ROOT/serve-plain.err" < /dev/null & p=$! ;;
    esac
    echo "${LAUNCH:-plain} $p" >> "$PIDS"
    wait_up "${LAUNCH:-plain}" "$p"
    ;;
  check)
    echo "STEP connection 0 ok $("$NODE" "$CLI" serve --connection 2>/dev/null)"
    [ -f "$PIDS" ] && while read -r how p; do echo "INFO $how pid $p alive $(kill -0 "$p" 2>/dev/null && echo true || echo false)"; done < "$PIDS"
    ps -eo pid,ppid,pgid,sid,etimes,args | grep -F "$ROOT" | grep -v grep | sed 's/^/PROC /'
    ;;
  locks)
    step rename-running-node-dir sh -c "mv '$NODE_DIR' '$NODE_DIR.aside' && mv '$NODE_DIR.aside' '$NODE_DIR' && echo renamed"
    step switch-symlink sh -c "ln -sfn '$VER' '$ROOT/remote/.current.tmp' && mv -T '$ROOT/remote/.current.tmp' '$ROOT/remote/current' && readlink '$ROOT/remote/current'"
    ;;
  stop|clean)
    # Only the pids this probe recorded, then anything left whose command line names $ROOT
    [ -f "$PIDS" ] && while read -r how p; do kill "$p" 2>/dev/null; done < "$PIDS"
    sleep 2
    for p in $(ps -eo pid,args | grep -F "$ROOT/remote" | grep -v grep | awk '{print $1}'); do echo "INFO stopping leftover $p"; kill "$p" 2>/dev/null; done
    if [ "$1" = clean ]; then sleep 1; rm -rf "$ROOT" && echo "STEP clean 0 ok removed $ROOT"; else echo "STEP stop 0 ok"; fi
    ;;
esac
}
run "$MODE"
