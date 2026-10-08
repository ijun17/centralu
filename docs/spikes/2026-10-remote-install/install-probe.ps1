# Remote phase 3, probe: install the Centralu host on Windows without npm, sudo or build tools.
# docs/plans/remote-hub.md §10. Throwaway; kept so the measurement can be re-run.
#
# Run from the hub through `run-probe.mjs` (which sets $Root, $NodeV, $CentraluV and $Mode, then sends
# this as -EncodedCommand), or by hand in PowerShell 5.1 after setting those four variables.
# Everything happens under $Root (a folder under %TEMP%); CC_DATA_DIR points inside it. Nothing
# else on the machine is touched. Prints one `STEP <name> <ms> <result>` line per measured step.
#
# Modes:
#   install   download, verify and unpack Node and the two Centralu packages; check the native modules
#   serve     start `centralu serve` from the install, in the background, and report when it answers
#   wmi       create the process $Cmd through WMI (outside this ssh session) and record its pid
#   check     print the connection line and whether the serve started by `serve` is still alive
#   locks     try to delete and rename the version folder while its node.exe runs
#   stop      stop the processes this probe started (by the pids it recorded), and only those
#   clean     stop, then remove $Root

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8

function Step($name, [scriptblock]$body) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try {
    $r = & $body
    "STEP $name $($sw.ElapsedMilliseconds) ok $r"
  } catch {
    "STEP $name $($sw.ElapsedMilliseconds) FAIL $($_.Exception.Message)"
  }
}

function HexToBase64($hex) {
  $bytes = New-Object byte[] ($hex.Length / 2)
  for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  [Convert]::ToBase64String($bytes)
}

$dl = Join-Path $Root 'dl'
$ver = Join-Path $Root "remote\versions\$CentraluV"
$nodeDir = Join-Path $Root "remote\node\v$NodeV"
$node = Join-Path $nodeDir 'node.exe'
$cli = Join-Path $ver 'node_modules\centralu\bin\centralu.mjs'
$data = Join-Path $Root 'data'
$pids = Join-Path $Root 'pids.txt'

function Fetch($url, $out) {
  & curl.exe -sSfL --retry 2 -o $out $url
  if ($LASTEXITCODE -ne 0) { throw "curl.exe exit $LASTEXITCODE for $url" }
  (Get-Item $out).Length
}

function NpmPackage($name, $dest) {
  $meta = Invoke-RestMethod "https://registry.npmjs.org/$name/$CentraluV"
  $file = Join-Path $dl (($name -replace '[@/]', '_') + '.tgz')
  $size = Fetch $meta.dist.tarball $file
  $have = 'sha512-' + (HexToBase64 (Get-FileHash -Algorithm SHA512 $file).Hash)
  if ($have -ne $meta.dist.integrity) { throw "integrity mismatch for $name" }
  New-Item -ItemType Directory -Force $dest | Out-Null
  & tar.exe -xzf $file -C $dest --strip-components 1
  if ($LASTEXITCODE -ne 0) { throw "tar.exe exit $LASTEXITCODE" }
  "$size bytes, integrity ok"
}

switch ($Mode) {
  'install' {
    New-Item -ItemType Directory -Force $dl, $data | Out-Null
    "INFO ps $($PSVersionTable.PSVersion) os $([Environment]::OSVersion.Version) arch $env:PROCESSOR_ARCHITECTURE"
    $zip = "node-v$NodeV-win-x64.zip"
    Step 'node-download-curl' { Fetch "https://nodejs.org/dist/v$NodeV/$zip" (Join-Path $dl $zip) }
    Step 'node-download-iwr' {
      $o = Join-Path $dl "iwr-$zip"
      Invoke-WebRequest -UseBasicParsing "https://nodejs.org/dist/v$NodeV/$zip" -OutFile $o
      $n = (Get-Item $o).Length; Remove-Item $o; $n
    }
    Step 'node-sha256' {
      Fetch "https://nodejs.org/dist/v$NodeV/SHASUMS256.txt" (Join-Path $dl 'SHASUMS256.txt') | Out-Null
      $want = ((Get-Content (Join-Path $dl 'SHASUMS256.txt')) | Where-Object { $_ -match "  $([regex]::Escape($zip))$" }).Split(' ')[0]
      $have = (Get-FileHash -Algorithm SHA256 (Join-Path $dl $zip)).Hash.ToLower()
      if ($want -ne $have) { throw "sha256 mismatch: $have vs $want" }
      'match'
    }
    Step 'node-unzip-tar' {
      $t = Join-Path $Root 'remote\node\.partial'
      New-Item -ItemType Directory -Force $t | Out-Null
      & tar.exe -xf (Join-Path $dl $zip) -C $t --strip-components 1
      if ($LASTEXITCODE -ne 0) { throw "tar.exe exit $LASTEXITCODE" }
      Rename-Item $t $nodeDir
      $s = (Get-ChildItem -Recurse -File $nodeDir | Measure-Object Length -Sum).Sum
      "$([math]::Round($s / 1MB)) MB unpacked"
    }
    Step 'node-unzip-expand-archive' {
      $t = Join-Path $Root 'expand-test'
      Expand-Archive (Join-Path $dl $zip) -DestinationPath $t
      Remove-Item -Recurse -Force $t
      'for comparison only'
    }
    Step 'node-version' { & $node --version }
    Step 'pkg-shim' { NpmPackage 'centralu' (Join-Path $ver 'node_modules\centralu') }
    Step 'pkg-platform' { NpmPackage '@centralu/win32-x64' (Join-Path $ver 'node_modules\@centralu\win32-x64') }
    Step 'native-modules' {
      $hostDir = Join-Path $ver 'node_modules\@centralu\win32-x64\Centralu\resources\host'
      $js = "const r=require('module').createRequire(process.argv[1]+'/x');const D=r('better-sqlite3');const d=new D(':memory:');const v=d.prepare('select sqlite_version() v').get().v;const p=r('node-pty');const t=p.spawn('cmd.exe',['/c','echo pty-ok'],{});let o='';t.onData(x=>o+=x);t.onExit(()=>{console.log('sqlite '+v+', abi '+process.versions.modules+', napi '+process.versions.napi+', pty '+(o.includes('pty-ok')?'ok':'no output'));process.exit(0)})"
      & $node -e $js $hostDir
    }
    Step 'connection-cold' {
      $env:CC_DATA_DIR = $data
      & $node $cli serve --connection
    }
    $s = (Get-ChildItem -Recurse -File (Join-Path $Root 'remote') | Measure-Object Length -Sum).Sum
    "INFO remote folder $([math]::Round($s / 1MB)) MB"
  }
  'serve' {
    $env:CC_DATA_DIR = $data
    $how = if ($Launch) { $Launch } else { 'start-process' }
    $out = Join-Path $Root "serve-$how.err"
    if ($how -eq 'wmi') {
      # A process created by WMI is not a child of this ssh session
      $cmd = "cmd.exe /c set CC_DATA_DIR=$data&& `"$node`" `"$cli`" serve 2> `"$out`""
      $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd; CurrentDirectory = $Root }
      $p = $r.ProcessId
    } else {
      $p = (Start-Process -FilePath $node -ArgumentList "`"$cli`" serve" -RedirectStandardError $out -RedirectStandardOutput (Join-Path $Root 'serve.out') -WindowStyle Hidden -PassThru).Id
    }
    Add-Content $pids "$how $p"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    while ($sw.ElapsedMilliseconds -lt 30000) {
      $line = & $node $cli serve --connection 2>$null
      if ($line -match '"hostRunning":true') { break }
      Start-Sleep -Milliseconds 300
    }
    "STEP serve-up-$how $($sw.ElapsedMilliseconds) $(if ($line -match '"hostRunning":true') { 'ok' } else { 'FAIL' }) pid $p"
  }
  'wmi' {
    # Any command line, created by WMI so it outlives this ssh session (used to hold a WSL distro and
    # to start `centralu serve` inside it). Recorded like `serve`, so `stop` ends it
    $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $Cmd; CurrentDirectory = $Root }
    Add-Content $pids "wmi-cmd $($r.ProcessId)"
    "STEP wmi 0 $(if ($r.ReturnValue -eq 0) { 'ok' } else { 'FAIL' }) pid $($r.ProcessId)"
  }
  'check' {
    $env:CC_DATA_DIR = $data
    "STEP connection 0 ok $(& $node $cli serve --connection 2>$null)"
    if (Test-Path $pids) {
      foreach ($l in Get-Content $pids) {
        $how, $p = $l.Split(' ')
        $alive = [bool](Get-Process -Id $p -ErrorAction SilentlyContinue)
        "INFO $how pid $p alive $alive"
      }
    }
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Root) } | ForEach-Object { "PROC $($_.ProcessId) parent $($_.ParentProcessId) $($_.Name)" }
  }
  'locks' {
    Step 'delete-running-version' {
      $copy = "$ver.copy-test"
      Copy-Item -Recurse $ver $copy
      Remove-Item -Recurse -Force $copy
      try { Remove-Item -Recurse -Force (Join-Path $nodeDir 'node.exe'); 'node.exe deleted (unexpected)' } catch { "refused as expected: $($_.Exception.GetType().Name)" }
    }
    Step 'rename-running-node-dir' {
      try { Rename-Item $nodeDir "$nodeDir.aside"; Rename-Item "$nodeDir.aside" $nodeDir; 'renamed (folder of a running exe)' } catch { "refused: $($_.Exception.GetType().Name)" }
    }
    Step 'replace-pointer-file' {
      $cur = Join-Path $Root 'remote\current'
      Set-Content $cur $CentraluV
      $tmp = "$cur.tmp"
      Set-Content $tmp $CentraluV
      [IO.File]::Replace($tmp, $cur, $null)
      'replaced'
    }
  }
  { $_ -eq 'stop' -or $_ -eq 'clean' } {
    # Only the pids this probe recorded, and the processes whose command line names $Root
    if (Test-Path $pids) {
      foreach ($l in Get-Content $pids) {
        $how, $p = $l.Split(' ')
        Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
      }
    }
    Start-Sleep -Seconds 2
    Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($Root) } | ForEach-Object {
      "INFO stopping leftover $($_.ProcessId) $($_.Name)"
      Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($Mode -eq 'clean') {
      Start-Sleep -Seconds 1
      Remove-Item -Recurse -Force $Root
      "STEP clean 0 ok removed $Root"
    } else { 'STEP stop 0 ok' }
  }
}
