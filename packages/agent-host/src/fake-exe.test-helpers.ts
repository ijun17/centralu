import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * A stand-in for a program the code under test starts by name (`ssh`, `gh`): a Node script that
 * logs its arguments and answers, put where `spawn('ssh')` finds it.
 *
 * On POSIX that is the script itself, with a `#!/usr/bin/env node` line. Windows starts neither a
 * `#!` script nor a `.cmd` without a shell, and a Node binary under another name cannot stand in:
 * node reads `-T` as one of its own options before any script runs. So on Windows the file is a
 * real `.exe`, a small launcher compiled once with the C# compiler every Windows has
 * (`csc.exe`, .NET Framework 4), that starts `node script args…` on the same standard handles and
 * puts it in a job object that dies with the launcher. A test that kills the launcher (as the code
 * under test kills ssh) therefore ends the script too, and the exit code passes through.
 *
 * The script is CommonJS and may `return` at top level, as the ones in the tests did.
 */

const LAUNCHER_CS = String.raw`
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class Launcher {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, int mask, int flags);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessW(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, int flags, IntPtr env, string cwd, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] static extern int WaitForSingleObject(IntPtr h, int ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out int code);

  // CommandLineToArgvW's rules, the ones node follows when it reads its own command line
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    for (int i = 0; i < a.Length; i++) {
      int slashes = 0;
      while (i < a.Length && a[i] == '\\') { slashes++; i++; }
      if (i == a.Length) { sb.Append('\\', slashes * 2); break; }
      if (a[i] == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
      else { sb.Append('\\', slashes); sb.Append(a[i]); }
    }
    return sb.Append('"').ToString();
  }

  static int Main(string[] args) {
    // <this exe>.target: the node binary on line 1, the script on line 2. Without one, this exe is a
    // node.exe in an archive (fakeNodeExe): the node binary is CC_FAKE_NODE, and there is no script
    var self = System.Reflection.Assembly.GetExecutingAssembly().Location;
    string node, script = null;
    if (File.Exists(self + ".target")) {
      var target = File.ReadAllLines(self + ".target");
      node = target[0];
      if (target.Length > 1 && target[1].Length > 0) script = target[1];
    } else node = Environment.GetEnvironmentVariable("CC_FAKE_NODE");
    if (node == null) { Console.Error.WriteLine("fake exe: no .target file and no CC_FAKE_NODE"); return 127; }
    var cmd = new StringBuilder(Quote(node));
    if (script != null) cmd.Append(' ').Append(Quote(script));
    foreach (var a in args) cmd.Append(' ').Append(Quote(a));

    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(si);
    si.dwFlags = 0x100; // STARTF_USESTDHANDLES
    si.hStdInput = GetStdHandle(-10); si.hStdOutput = GetStdHandle(-11); si.hStdError = GetStdHandle(-12);
    foreach (var h in new[] { si.hStdInput, si.hStdOutput, si.hStdError }) if (h != IntPtr.Zero && h != new IntPtr(-1)) SetHandleInformation(h, 1, 1);

    // The job ends the script with this launcher, however the launcher ends
    var job = CreateJobObject(IntPtr.Zero, null);
    var info = Marshal.AllocHGlobal(144); // JOBOBJECT_EXTENDED_LIMIT_INFORMATION on x64
    for (int i = 0; i < 144; i++) Marshal.WriteByte(info, i, 0);
    Marshal.WriteInt32(info, 16, 0x2000); // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    SetInformationJobObject(job, 9, info, 144);

    PROCESS_INFORMATION pi;
    // CREATE_SUSPENDED | CREATE_NO_WINDOW
    if (!CreateProcessW(null, cmd, IntPtr.Zero, IntPtr.Zero, true, 0x4 | 0x08000000, IntPtr.Zero, null, ref si, out pi)) {
      Console.Error.WriteLine("fake exe: cannot start " + cmd + " (error " + Marshal.GetLastWin32Error() + ")");
      return 127;
    }
    AssignProcessToJobObject(job, pi.hProcess);
    ResumeThread(pi.hThread);
    WaitForSingleObject(pi.hProcess, -1);
    int code; GetExitCodeProcess(pi.hProcess, out code);
    return code;
  }
}
`

let launcherCache: string | undefined

/** The compiled launcher, built once per machine and source in the temp folder */
function launcher(): string {
  if (launcherCache) return launcherCache
  const windir = process.env.SystemRoot || 'C:\\Windows'
  const csc = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  const folder = join(tmpdir(), `cc-fake-exe-${createHash('sha256').update(LAUNCHER_CS).digest('hex').slice(0, 12)}`)
  const exe = join(folder, 'launcher.exe')
  if (!existsSync(exe)) {
    mkdirSync(folder, { recursive: true })
    // Built under a name of its own, then renamed: two test files may build at the same time
    const unique = `${process.pid}-${Date.now()}`
    const src = join(folder, `launcher-${unique}.cs`)
    const tmp = join(folder, `launcher-${unique}.exe`)
    writeFileSync(src, LAUNCHER_CS)
    execFileSync(csc, ['/nologo', '/target:exe', '/platform:x64', `/out:${tmp}`, src], { stdio: 'pipe' })
    try {
      renameSync(tmp, exe)
    } catch {
      // another build won the race; theirs is as good
      rmSync(tmp, { force: true })
    }
    rmSync(src, { force: true })
  }
  return (launcherCache = exe)
}

/**
 * The launcher itself, to be a `node.exe` inside an archive: it runs the Node in `CC_FAKE_NODE` (the
 * environment of whoever runs it) with the arguments it was given. Windows only.
 */
export function fakeNodeExe(): Buffer {
  return readFileSync(launcher())
}

/**
 * Puts the program `name` into `dir`, running `source` (CommonJS, optional `#!` line) under Node.
 * Returns the path to hand to the code under test, or to find through a PATH that has `dir`:
 * `<dir>/<name>` on POSIX, `<dir>\<name>.exe` on Windows.
 */
export function fakeExe(dir: string, name: string, source: string): string {
  mkdirSync(dir, { recursive: true })
  if (process.platform !== 'win32') {
    const file = join(dir, name)
    writeFileSync(file, source.startsWith('#!') ? source : `#!/usr/bin/env node\n${source}`)
    chmodSync(file, 0o755)
    return file
  }
  const exe = join(dir, `${name}.exe`)
  const script = join(dir, `${name}.fake.cjs`)
  writeFileSync(script, source)
  copyFileSync(launcher(), exe)
  writeFileSync(`${exe}.target`, `${process.execPath}\n${script}\n`)
  return exe
}

/**
 * Removes a folder with fake programs in it. Windows keeps an `.exe` locked until the process that
 * ran it is gone, and a test that has just killed one gets EPERM on the first try.
 */
export function rmFakeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 50, retryDelay: 100 })
}

/**
 * Puts this Node into `dir` as `node` (a symlink; on Windows `node.exe`, a hard link or else a copy),
 * so a PATH made of `dir` alone finds Node and none of the other tools that live beside the machine's
 * own copy (Homebrew's `gh`, for one).
 */
export function linkNode(dir: string): void {
  mkdirSync(dir, { recursive: true })
  if (process.platform !== 'win32') return symlinkSync(process.execPath, join(dir, 'node'))
  const exe = join(dir, 'node.exe')
  try {
    linkSync(process.execPath, exe)
  } catch {
    // another volume, or a file system without hard links
    copyFileSync(process.execPath, exe)
  }
}

/**
 * What a Windows program needs of its environment to start at all (`SystemRoot` above all: without it
 * Winsock, crypto and most DLL loads fail), for a test that hands a child a minimal `env`. Nothing
 * elsewhere.
 */
export function windowsSystemEnv(): Record<string, string> {
  if (process.platform !== 'win32') return {}
  const out: Record<string, string> = {}
  for (const k of ['SystemRoot', 'windir', 'SystemDrive', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramData']) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * Makes git reachable on a PATH of `dir`, the folder of `linkNode` and nothing else the machine has:
 * returns the folders to add after them. On POSIX that is none: `dir` gets an `sh` wrapper around the real
 * git, so the folder git lives in (Homebrew's often holds the real `gh` too) is never on the PATH. On
 * Windows git's own folder comes last, after `dir`, where a fake `gh` beats any real one; a wrapper there
 * would be an exe starting Node for each of the hundreds of git calls a release test makes, and took
 * the suite from about one minute to six.
 */
export function gitWrapper(dir: string): string[] {
  if (process.platform !== 'win32') {
    const gitBin = join(execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim(), 'git')
    writeFileSync(join(dir, 'git'), `#!/bin/sh\nexec "${gitBin}" "$@"\n`)
    chmodSync(join(dir, 'git'), 0o755)
    return []
  }
  return [dirname(execFileSync('where.exe', ['git.exe'], { encoding: 'utf8' }).split(/\r?\n/)[0]!.trim())]
}
