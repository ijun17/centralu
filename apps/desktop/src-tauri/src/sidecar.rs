//! The agent-host sidecar supervisor.
//!
//! Tauri's role here is not a communication relay but **process supervision**
//! (docs/architecture.md §4). It launches the host, reads the port and token off its ready
//! line and hands them to the UI, and brings it back if it dies. The communication itself is
//! done by the UI directly over WS — the reason dev and prod share the same path.

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HostInfo {
    pub port: u16,
    pub token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum HostStatus {
    Starting,
    Ready(HostInfo),
    /// A restart is in progress (which attempt number this is).
    Restarting { attempt: u32 },
    /// Gave up trying to revive it — the UI has to tell the person.
    Failed { message: String },
}

#[derive(Default)]
struct Inner {
    child: Option<Child>,
    info: Option<HostInfo>,
    status_text: Option<String>,
    shutting_down: bool,
    /// A watcher thread is running. This flag is what stops restart (#184) from launching a
    /// second thread — if two of them alternate starting a host against the same data folder,
    /// they end up blocking each other's lock.
    running: bool,
    /// The last things the host said before it died (dogfooding: an installed build looked
    /// stuck on "Starting…" forever, and the real reason — another instance was holding the
    /// data — was something the host had spelled out plainly on stdout the whole time. The
    /// words were there; they just never reached the screen.)
    last_output: Vec<String>,
}

#[derive(Clone, Default)]
pub struct Supervisor {
    inner: Arc<Mutex<Inner>>,
}

/// The cap on restart backoff. Failing **consecutively** this many times is a problem a
/// person has to look at.
const MAX_RESTARTS: u32 = 5;

/// Once it has stayed up this long, a death is a new incident, not part of "a run of failed
/// launches".
///
/// If the counter were never reset, keeping the app open for days would eventually accumulate
/// five rare, unrelated crashes and the supervisor would give up entirely — the cap must only
/// apply to consecutive failures.
const STABLE_UPTIME: Duration = Duration::from_secs(30);

impl Supervisor {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn info(&self) -> Option<HostInfo> {
        self.inner.lock().ok()?.info.clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.inner.lock().ok()?.status_text.clone()
    }

    /// Launches the host and starts the watcher thread. The app still comes up even if this
    /// fails (the UI shows the status).
    pub fn start(&self, app: AppHandle) {
        if self.claim(false) {
            self.watch(app);
        }
    }

    /**
     * Starts again after giving up (#184 — Retry on the failure screen).
     *
     * The old Retry only reloaded the webview. The watcher thread had already ended once it
     * emitted `Failed`, and `start` was only ever called from setup, so even after the person
     * fixed the cause (closed another window, installed Node), the old message would show up
     * again after a 30-second wait. There was no way out short of force-quitting.
     *
     * Does nothing if a watcher is still running (mid-backoff) — that thread will produce an
     * answer soon. Returns true once one has started.
     */
    pub fn restart(&self, app: AppHandle) -> bool {
        if !self.claim(true) {
            return false;
        }
        self.watch(app);
        true
    }

    /// Claims the right to launch a watcher thread. Returns false if one is already running or
    /// the app is shutting down. When `forget_error` is set, clears the old failure message so
    /// a fresh attempt does not look like it failed instantly for the old reason.
    fn claim(&self, forget_error: bool) -> bool {
        let Ok(mut inner) = self.inner.lock() else {
            return false;
        };
        if inner.running || inner.shutting_down {
            return false;
        }
        inner.running = true;
        if forget_error {
            inner.status_text = None;
        }
        true
    }

    fn watch(&self, app: AppHandle) {
        let me = self.clone();
        // In a release build the bundled host lives in the resource directory (F-0).
        //
        // **Do not decide dev vs. prod by existence alone** — `tauri dev`'s resource_dir is
        // target/debug/, and once a release build has been made even once, a bundle stays
        // copied there too. If existence alone decided it, dev would launch that stale bundled
        // host without CC_DEV, so source edits would not take effect and it would grab the
        // release app's data folder as well. A dev build unconditionally uses the source host
        // (docs/architecture.md §4 — dev runs the source directly via tsx, plus CC_DEV=1).
        let bundled = if cfg!(debug_assertions) {
            None
        } else {
            app.path()
                .resource_dir()
                .ok()
                .map(|d| d.join("resources/host/main.mjs"))
                .filter(|p| p.exists())
        };
        thread::spawn(move || {
            // Clear the running flag no matter which path this ends on — otherwise Retry could
            // never launch a new one.
            let _running = Running(me.clone());
            // If Node is missing, retrying gets the same result every time — rather than
            // burning through five backoff rounds accumulating causeless failures, say right
            // away what is missing.
            if bundled.is_some() && std::env::var("CC_HOST_CMD").is_err() {
                if let Err(message) = resolve_node() {
                    me.set_error(&message);
                    emit(&app, HostStatus::Failed { message });
                    return;
                }
            }
            let mut attempt = 0u32;
            loop {
                if me.inner.lock().map(|i| i.shutting_down).unwrap_or(true) {
                    return;
                }
                emit(&app, if attempt == 0 { HostStatus::Starting } else { HostStatus::Restarting { attempt } });

                let started = std::time::Instant::now();
                match me.spawn_once(&app, bundled.as_deref()) {
                    Ok(code) => {
                        // A clean exit (the app itself requested it) ends the watcher.
                        if me.inner.lock().map(|i| i.shutting_down).unwrap_or(true) {
                            return;
                        }
                        // The last things the host said — if it died before ready, this is why.
                        let reason = me.take_last_output();
                        /*
                         * If another instance is holding the data, relaunching just gets the
                         * same answer — instead of cycling through five backoff rounds (about
                         * 15 seconds) showing "Starting…", show the person right away exactly
                         * the reason the host gave (what needs to be closed is spelled out in
                         * that message).
                         */
                        if reason.contains("already using this data") {
                            me.set_error(&reason);
                            emit(&app, HostStatus::Failed { message: reason });
                            return;
                        }
                        // If it stayed up long enough before dying, the earlier failure history
                        // no longer matters — start counting over from zero.
                        if started.elapsed() >= STABLE_UPTIME {
                            attempt = 0;
                        }
                        attempt += 1;
                        let msg = if reason.is_empty() {
                            format!("agent-host가 종료되었습니다 (code {code:?})")
                        } else {
                            format!("agent-host가 종료되었습니다 (code {code:?})\n{reason}")
                        };
                        if attempt > MAX_RESTARTS {
                            me.set_error(&msg);
                            emit(&app, HostStatus::Failed { message: msg });
                            return;
                        }
                    }
                    Err(e) => {
                        attempt += 1;
                        let msg = format!("agent-host를 시작하지 못했습니다: {e}");
                        if attempt > MAX_RESTARTS {
                            me.set_error(&msg);
                            emit(&app, HostStatus::Failed { message: msg });
                            return;
                        }
                    }
                }
                // Exponential backoff (capped at 5 seconds).
                thread::sleep(Duration::from_millis((200 * 2u64.pow(attempt.min(5))).min(5000)));
            }
        });
    }

    /// Runs the host once → parses its ready line → waits for it to exit. The return value is
    /// the exit code.
    fn spawn_once(&self, app: &AppHandle, bundled: Option<&Path>) -> Result<Option<i32>, String> {
        // Clear this before starting so it does not mix with the previous launch's last words.
        if let Ok(mut inner) = self.inner.lock() {
            inner.last_output.clear();
        }
        let (program, args) = host_command(bundled)?;
        let mut cmd = Command::new(&program);
        // Keeping stdin open as a pipe is **the whole trick that prevents orphans.**
        // Whatever reason the app dies for (including a crash or SIGKILL), this pipe closes,
        // and the host sees EOF and exits on its own. Relying only on a shutdown hook leaves a
        // zombie behind when the app is force-quit.
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        // A host launched from dev uses a **different data folder** than the release app.
        // If two hosts held the same folder, the session lists would get out of sync.
        if bundled.is_none() {
            cmd.env("CC_DEV", "1");
        }

        // Puts the child in a **process group where it is its own leader**.
        // The node launcher (tsx) spawns children of its own, so killing only the direct child
        // and not the whole group leaves the grandchild orphaned.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }

        let mut child = cmd.spawn().map_err(|e| format!("{program} 실행 실패: {e}"))?;

        let stdout = child.stdout.take().ok_or("stdout을 열 수 없습니다")?;

        if let Ok(mut inner) = self.inner.lock() {
            inner.child = Some(child);
        }

        // Waits for the ready line. On startup the host prints one line of
        // {"ready":true,"port":..,"token":".."}.
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&line) {
                if v.get("ready").and_then(|r| r.as_bool()) == Some(true) {
                    let info = HostInfo {
                        port: v.get("port").and_then(|p| p.as_u64()).unwrap_or(0) as u16,
                        token: v.get("token").and_then(|t| t.as_str()).unwrap_or("").to_string(),
                    };
                    if let Ok(mut inner) = self.inner.lock() {
                        inner.info = Some(info.clone());
                        inner.status_text = None;
                    }
                    emit(app, HostStatus::Ready(info));
                    continue;
                }
            }
            // Every other line is streamed to the log, but the last several are also kept —
            // if it dies before ready, these lines are the only cause of death on record.
            eprintln!("[agent-host] {line}");
            if let Ok(mut inner) = self.inner.lock() {
                if !line.trim().is_empty() {
                    inner.last_output.push(line.clone());
                    if inner.last_output.len() > 6 {
                        inner.last_output.remove(0);
                    }
                }
            }
        }

        // stdout closing means the process has ended.
        // wait() blocks — waiting while holding the lock would stall IPC (info queries) and
        // shutdown at the same time. Take the child out, release the lock, then wait.
        let mut child = {
            let mut guard = self.inner.lock().map_err(|_| "lock 실패")?;
            guard.info = None;
            guard.child.take()
        };
        let code = child
            .as_mut()
            .and_then(|c| c.wait().ok())
            .and_then(|s| s.code());
        Ok(code)
    }

    fn set_error(&self, msg: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.status_text = Some(msg.to_string());
        }
    }

    /// Takes and clears the last things a dead host said — so they do not mix with the next
    /// launch's words.
    fn take_last_output(&self) -> String {
        self.inner
            .lock()
            .map(|mut i| std::mem::take(&mut i.last_output).join("\n"))
            .unwrap_or_default()
    }

    /// Called when the app quits. Kills the sidecar **as a whole group** — no zombies left
    /// behind.
    pub fn shutdown(&self) {
        // The lock is only held while taking the child out. Sleeping 300ms or calling wait()
        // inside the lock would leave the watcher thread and IPC waiting on the same lock,
        // and shutdown would block on them and vice versa.
        let child = match self.inner.lock() {
            Ok(mut inner) => {
                inner.shutting_down = true;
                inner.info = None;
                inner.child.take()
            }
            Err(_) => None,
        };
        if let Some(mut child) = child {
            /*
             * Must not start by sending TERM to the whole group — measured (#57): on SIGTERM,
             * codex app-server dies instantly and leaves behind its lock file
             * (thread-writer-locks/<id>.lock), but on stdin EOF it removes the lock and exits
             * on its own within 18ms. A group-wide TERM takes away the host's disposeAll's
             * chance to close things via EOF and hits the codex children directly instead.
             *
             * So the order is reversed: TERM only the host → wait for the host's shutdown() to
             * clean up its sessions via EOF and close the database (up to 3 seconds — the old
             * 300ms used to finish off the process before its WAL checkpoint had completed).
             * The group-wide TERM and kill that follow are only a zombie-prevention backstop
             * that actually does anything when the host is stuck.
             */
            kill_pid(child.id());
            let mut waited_ms: u64 = 0;
            while waited_ms < 3000 {
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
                thread::sleep(Duration::from_millis(50));
                waited_ms += 50;
            }
            kill_group(child.id());
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// Clears `running` when the watcher thread ends. There are four `return` points, so this is
/// left to Drop.
struct Running(Supervisor);

impl Drop for Running {
    fn drop(&mut self) {
        if let Ok(mut inner) = self.0.inner.lock() {
            inner.running = false;
        }
    }
}

fn emit(app: &AppHandle, status: HostStatus) {
    let _ = app.emit("host-status", status);
}

/// SIGTERM to the single host process only — children (codex, etc.) are cleaned up by the
/// host itself via EOF (#57).
#[cfg(unix)]
fn kill_pid(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(format!("{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn kill_pid(_pid: u32) {}

/// SIGTERM to the whole process group (a negative pid means the group).
#[cfg(unix)]
fn kill_group(pid: u32) {
    let _ = Command::new("/bin/kill")
        .arg("-TERM")
        .arg(format!("-{pid}"))
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

/// In dev, this runs through the workspace's tsx; in a release build it runs the bundled host
/// through the system Node (F-0).
///
/// **Never goes through a package manager** — launching through the pnpm wrapper only kills
/// the wrapper, leaving the actual host (a grandchild) orphaned (confirmed by measurement).
fn host_command(bundled: Option<&Path>) -> Result<(String, Vec<String>), String> {
    if let Ok(cmd) = std::env::var("CC_HOST_CMD") {
        let mut parts = cmd.split_whitespace().map(String::from).collect::<Vec<_>>();
        if !parts.is_empty() {
            let program = parts.remove(0);
            return Ok((program, parts));
        }
    }

    // Release build: run the bundled host through the system Node (decision F-0a).
    // Node SEA was excluded from the dogfooding scope because native addons made it too
    // costly.
    if let Some(path) = bundled {
        return Ok((
            resolve_node()?,
            vec![
                path.to_string_lossy().to_string(),
                "--port".into(),
                "0".into(),
                "--watch-parent".into(),
            ],
        ));
    }

    // dev: runs the source directly through the workspace's tsx.
    // Marking it with CC_DEV makes the host use a **different data folder** than the release
    // app — the two can be running at once without the session lists getting mixed up.
    let root = workspace_root();
    Ok((
        format!("{root}/node_modules/.bin/tsx"),
        vec![
            format!("{root}/packages/agent-host/src/main.ts"),
            "--port".into(),
            "0".into(),
            "--watch-parent".into(),
        ],
    ))
}

/// The guidance shown to the person verbatim when Node cannot be found.
///
/// **A silent failure is the worst outcome.** It used to just run `"node"` bare when it
/// could not find it, which left only `No such file or directory`, and that raw text is
/// what showed up on screen. There was no way to tell apart Node truly being missing, Node
/// being present but not found, and the version being too low.
fn node_missing_message(looked: &[String]) -> String {
    format!(
        "Node.js를 찾지 못했습니다. Centralu는 Node {MIN_NODE_MAJOR} 이상이 필요합니다.\n\
         터미널에서 `node --version`으로 확인하고, 없으면 {INSTALL_NODE_HINT} 또는 \
         https://nodejs.org 에서 설치한 뒤 앱을 다시 시작하세요.\n\
         찾아본 곳: {}",
        looked.join(", ")
    )
}

/// Told to someone who has no Node at all, so it has to name a command they can actually
/// run. `brew` was hardcoded, which on Linux points at a package manager that is not
/// there — the one message whose whole job is to unblock a stuck user would have sent
/// them somewhere else.
#[cfg(target_os = "macos")]
const INSTALL_NODE_HINT: &str = "`brew install node`";
#[cfg(not(target_os = "macos"))]
const INSTALL_NODE_HINT: &str = "배포판의 패키지 관리자(예: `apt install nodejs`)";

#[cfg(target_os = "macos")]
const UPGRADE_NODE_HINT: &str = "`brew upgrade node`";
#[cfg(not(target_os = "macos"))]
const UPGRADE_NODE_HINT: &str = "배포판의 패키지 관리자";

/// The host bundle's esbuild target is node22 — below that, even the syntax breaks.
const MIN_NODE_MAJOR: u32 = 22;

/// Finding Node takes around one second because it launches the whole login shell. Since the
/// restart loop calls this every time, a successful find is cached. **A failed find is never
/// cached** (#184) — someone who installs Node after opening the app and presses Retry must
/// not be shown the old "not found" again.
static NODE: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Finds the **absolute path** to the Node the release build will use to run the host.
///
/// **Why a fixed path does not work (measured):** a `.app` launched from the GUI does not
/// inherit the login shell's PATH, and only gets
/// `/usr/bin:/bin:/usr/sbin:/sbin`. This used to only check the two Homebrew locations and
/// `/usr/bin`, but Node installed via nvm, mise or volta lives under the home directory, so
/// **the app would not start even on a Mac where Node was perfectly well installed.** The
/// claude and codex CLI lookups had already hit the same problem and were fixed to ask the
/// login shell (`packages/agent-host/src/env-path.ts`); only node was left using the old
/// approach.
fn resolve_node() -> Result<String, String> {
    remember_found(&NODE, || pick_node(probe_login_shell(), fallback_node_paths()))
}

/// Only caches a successful find. If it was not found, asks again next time.
fn remember_found(
    cache: &std::sync::OnceLock<String>,
    probe: impl FnOnce() -> Result<String, String>,
) -> Result<String, String> {
    if let Some(found) = cache.get() {
        return Ok(found.clone());
    }
    let found = probe()?;
    Ok(cache.get_or_init(|| found).clone())
}

/// The selection rule pulled out on its own, so it can be tested with neither a shell nor a
/// real filesystem.
///
/// Order: whatever the login shell knows about (the exact node the person already uses in a
/// terminal), then the common install locations. **Does not stop just because it is old** — a
/// Mac with nvm defaulting to v18 while Homebrew has v22 is common. But it carries forward the
/// fact that it hit an old one, and shows that as the reason if nothing newer turns up
/// ("needs an upgrade" is closer to what the person actually has to do than "not found").
fn pick_node(from_shell: Option<String>, fallbacks: Vec<String>) -> Result<String, String> {
    let mut looked = vec!["로그인 셸 PATH".to_string()];
    let mut ordered: Vec<String> = from_shell.into_iter().collect();

    for candidate in fallbacks {
        looked.push(candidate.clone());
        if Path::new(&candidate).exists() {
            ordered.push(candidate);
        }
    }

    let mut too_old: Option<String> = None;
    for path in ordered {
        match check_node_version(&path) {
            Ok(found) => return Ok(found),
            Err(why) => {
                too_old.get_or_insert(why);
            }
        }
    }

    Err(too_old.unwrap_or_else(|| node_missing_message(&looked)))
}

/// Asks the login shell where node is. It has to be interactive (-i) for .zshrc's nvm/mise
/// initialization to run.
///
/// Only the line carrying the marker is picked out, so it does not matter what else the shell
/// configuration prints.
fn probe_login_shell() -> Option<String> {
    use std::io::Read;

    let shell = std::env::var("SHELL").ok()?;
    if !Path::new(&shell).exists() {
        return None;
    }

    let mut cmd = Command::new(&shell);
    cmd.args(["-ilc", "command -p echo \"__CC_NODE__:$(command -v node)\""])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // So the shell's initialization script does not put up an interactive prompt.
        .env("TERM", "dumb")
        .env("CI", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }

    let mut child = cmd.spawn().ok()?;
    let pid = child.id();
    let stdout = child.stdout.take()?;

    // **Getting stuck here would fail the whole app's launch.** Shell configurations really do
    // sometimes wait forever (waiting on prompt input, for example), so this cuts it off on a
    // timer and kills the whole group.
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let mut buf = String::new();
        let _ = BufReader::new(stdout).read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    let out = match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(out) => out,
        Err(_) => {
            kill_group(pid);
            let _ = child.kill();
            let _ = child.wait();
            return None;
        }
    };
    let _ = child.wait();

    parse_probe_output(&out)
}

/// Pulls the path out of the marked line among whatever the shell printed.
fn parse_probe_output(out: &str) -> Option<String> {
    out.lines()
        .find_map(|l| l.trim().strip_prefix("__CC_NODE__:"))
        .map(str::trim)
        .filter(|p| !p.is_empty() && Path::new(p).exists())
        .map(str::to_string)
}

/// The fallback for when the shell cannot be used. Checks not just Homebrew but the common
/// locations of version managers too.
fn fallback_node_paths() -> Vec<String> {
    node_paths_under(&std::env::var("HOME").unwrap_or_default())
}

fn node_paths_under(home: &str) -> Vec<String> {
    let mut paths = vec![
        "/opt/homebrew/bin/node".to_string(),
        "/usr/local/bin/node".to_string(),
        "/opt/local/bin/node".to_string(),
        "/usr/bin/node".to_string(),
    ];
    if !home.is_empty() {
        paths.push(format!("{home}/.volta/bin/node"));
        paths.push(format!("{home}/.local/share/mise/shims/node"));
        paths.push(format!("{home}/.asdf/shims/node"));
        paths.push(format!("{home}/.local/bin/node"));
        // nvm keeps a separate directory per version — pick the highest one.
        paths.extend(nvm_versions(&format!("{home}/.nvm/versions/node")));
    }
    paths
}

/// `~/.nvm/versions/node/*/bin/node`, in descending version order.
///
/// The names look like `v22.3.1`, so a lexical sort would wrongly put v9 ahead of v22.
/// Compared as numbers instead.
fn nvm_versions(root: &str) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    let mut versions: Vec<(Vec<u32>, String)> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let parts = version_parts(&name);
            (!parts.is_empty()).then(|| (parts, format!("{root}/{name}/bin/node")))
        })
        .collect();
    versions.sort_by(|a, b| b.0.cmp(&a.0));
    versions.into_iter().map(|(_, p)| p).collect()
}

/// `v22.3.1` → `[22, 3, 1]`. An empty vector if it does not parse as numbers.
fn version_parts(raw: &str) -> Vec<u32> {
    let trimmed = raw.trim().trim_start_matches('v');
    let parts: Vec<u32> = trimmed.split('.').filter_map(|p| p.parse().ok()).collect();
    if parts.is_empty() {
        Vec::new()
    } else {
        parts
    }
}

/// Checks whether the Node that was found is actually a usable version.
///
/// **A too-low version and a missing one call for different actions from the person** — an
/// upgrade, not an install. So the messages are kept separate. If the version cannot be read,
/// it is let through (there is no basis for blocking it).
fn check_node_version(path: &str) -> Result<String, String> {
    let Ok(out) = Command::new(path).arg("--version").stdin(Stdio::null()).output() else {
        return Ok(path.to_string());
    };
    let raw = String::from_utf8_lossy(&out.stdout);
    let Some(&major) = version_parts(raw.trim()).first() else {
        return Ok(path.to_string());
    };
    if major < MIN_NODE_MAJOR {
        return Err(format!(
            "Node {MIN_NODE_MAJOR} 이상이 필요한데 {path}는 {}입니다.\n\
             {UPGRADE_NODE_HINT} 또는 nvm·mise로 {MIN_NODE_MAJOR} 이상을 켠 뒤 앱을 다시 시작하세요.",
            raw.trim()
        ));
    }
    Ok(path.to_string())
}

fn workspace_root() -> String {
    // Two levels up from src-tauri/ is apps/, three levels up is the workspace root.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .ancestors()
        .nth(3)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| ".".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Retry can relaunch a supervisor that has given up, and does not launch a second one on
    /// top of a running one (#184).
    #[test]
    fn a_supervisor_that_gave_up_can_be_claimed_again() {
        let sup = Supervisor::new();
        assert!(sup.claim(false), "처음 시작");
        assert!(!sup.claim(true), "감시 스레드가 도는 동안은 겹쳐 띄우지 않는다");

        // The watcher thread emitted Failed and ended.
        sup.set_error("agent-host가 종료되었습니다 (code Some(1))");
        drop(Running(sup.clone()));

        assert!(sup.claim(true), "끝난 뒤에는 다시 띄운다");
        assert_eq!(sup.last_error(), None, "새 시도가 옛 이유로 곧바로 실패해 보이면 안 된다");
    }

    #[test]
    fn no_restart_while_the_app_is_quitting() {
        let sup = Supervisor::new();
        sup.shutdown();
        assert!(!sup.claim(true));
    }

    /// Installing Node after the app is open and pressing Retry must trigger a fresh search
    /// (#184).
    #[test]
    fn a_missing_node_is_not_remembered_but_a_found_one_is() {
        let cache = std::sync::OnceLock::new();
        assert_eq!(
            remember_found(&cache, || Err("Node.js를 찾지 못했습니다".into())),
            Err("Node.js를 찾지 못했습니다".to_string())
        );
        assert_eq!(
            remember_found(&cache, || Ok("/opt/homebrew/bin/node".into())),
            Ok("/opt/homebrew/bin/node".to_string())
        );
        assert_eq!(
            remember_found(&cache, || panic!("찾은 것은 다시 묻지 않는다")),
            Ok("/opt/homebrew/bin/node".to_string())
        );
    }

    #[test]
    fn picks_the_marked_line_only() {
        // Only the marked line is checked, no matter what the shell configuration prints
        // (banners, warnings).
        let out = "Welcome to zsh!\n__CC_NODE__:/bin/sh\nsome trailing noise\n";
        assert_eq!(parse_probe_output(out), Some("/bin/sh".to_string()));
    }

    #[test]
    fn ignores_a_path_that_is_not_there() {
        // `command -v` can return an empty string (not installed) or a dead symlink.
        assert_eq!(parse_probe_output("__CC_NODE__:\n"), None);
        assert_eq!(parse_probe_output("__CC_NODE__:/nope/node\n"), None);
        assert_eq!(parse_probe_output("node not found\n"), None);
    }

    #[test]
    fn compares_versions_as_numbers_not_text() {
        // A lexical sort would make v9 > v22 and pick the old Node.
        assert!(version_parts("v22.3.1") > version_parts("v9.11.2"));
        assert_eq!(version_parts("v22.3.1"), vec![22, 3, 1]);
        assert_eq!(version_parts("lts/*"), Vec::<u32>::new());
        assert_eq!(version_parts(""), Vec::<u32>::new());
    }

    /// Sets up a script that pretends to be node and prints the given version.
    fn fake_node(version: &str, name: &str) -> String {
        let path = std::env::temp_dir().join(name);
        std::fs::write(&path, format!("#!/bin/sh\necho {version}\n")).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_string_lossy().to_string()
    }

    #[test]
    fn rejects_a_node_that_is_too_old() {
        // A low version is "needs an upgrade", not "missing" — the person has a different task.
        let path = fake_node("v20.11.1", "cc-test-node-old");
        let err = check_node_version(&path).unwrap_err();
        assert!(err.contains("이상이 필요한데"), "{err}");
        assert!(err.contains("v20.11.1"), "{err}");
    }

    #[test]
    fn accepts_a_node_that_is_new_enough() {
        let path = fake_node("v22.3.1", "cc-test-node-ok");
        assert_eq!(check_node_version(&path), Ok(path));
    }

    #[test]
    fn passes_when_the_version_cannot_be_read() {
        // No basis to block it, so it is not blocked (an unexpected output format).
        let path = fake_node("banana", "cc-test-node-weird");
        assert_eq!(check_node_version(&path), Ok(path));
    }

    /// Checks that this Mac's login shell's own node is actually picked out.
    ///
    /// A unit test alone cannot confirm "asks the shell instead of using a fixed path" — since
    /// that is the entire point of this fix, this touches the real thing once. Passes silently
    /// in an environment with no node (there is no basis to block it there).
    #[test]
    fn finds_the_node_this_shell_knows() {
        let Ok(shell) = std::env::var("SHELL") else { return };
        if !Path::new(&shell).exists() {
            return;
        }
        let Ok(out) = Command::new(&shell).args(["-ilc", "command -v node"]).output() else {
            return;
        };
        let expected = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if expected.is_empty() || !Path::new(&expected).exists() {
            return;
        }
        assert_eq!(probe_login_shell(), Some(expected.clone()));
        assert_eq!(resolve_node(), Ok(expected));
    }

    #[test]
    fn moves_on_when_the_shell_node_is_too_old() {
        // A Mac where nvm defaults to v18 but Homebrew has v22 — stopping here would fail to
        // launch even though a usable Node exists.
        let old = fake_node("v18.20.4", "cc-test-node-shell-old");
        let new = fake_node("v22.9.0", "cc-test-node-brew-new");
        assert_eq!(pick_node(Some(old), vec![new.clone()]), Ok(new));
    }

    #[test]
    fn explains_the_old_version_when_there_is_nothing_newer() {
        // If nothing newer ever turns up, say "old", not "missing" — the task is an upgrade,
        // not an install.
        let old = fake_node("v18.20.4", "cc-test-node-only-old");
        let err = pick_node(Some(old), vec!["/nope/node".into()]).unwrap_err();
        assert!(err.contains("v18.20.4"), "{err}");
        assert!(!err.contains("찾지 못했습니다"), "{err}");
    }

    #[test]
    fn reports_every_place_it_looked_when_nothing_is_there() {
        // Finding nothing anywhere is the moment the person is most stuck — list every place
        // that was checked.
        let err = pick_node(None, vec!["/nope/a/node".into(), "/nope/b/node".into()]).unwrap_err();
        assert!(err.contains("로그인 셸 PATH"), "{err}");
        assert!(err.contains("/nope/a/node") && err.contains("/nope/b/node"), "{err}");
    }

    #[test]
    fn falls_back_to_a_real_path_when_the_shell_says_nothing() {
        let ok = fake_node("v22.0.0", "cc-test-node-fallback");
        assert_eq!(pick_node(None, vec!["/nope/node".into(), ok.clone()]), Ok(ok));
    }

    #[test]
    fn looks_where_version_managers_actually_put_node() {
        // This used to be only the two Homebrew locations and /usr/bin — nvm, mise and volta
        // users got stuck here.
        let paths = node_paths_under("/home/tester");
        for expected in [
            "/opt/homebrew/bin/node",
            "/home/tester/.volta/bin/node",
            "/home/tester/.local/share/mise/shims/node",
            "/home/tester/.asdf/shims/node",
        ] {
            assert!(paths.iter().any(|p| p == expected), "{expected} 가 후보에 없다: {paths:?}");
        }
    }

    #[test]
    fn says_where_it_looked_when_there_is_no_node() {
        let msg = node_missing_message(&["로그인 셸 PATH".into(), "/opt/homebrew/bin/node".into()]);
        assert!(msg.contains("로그인 셸 PATH"));
        assert!(msg.contains("/opt/homebrew/bin/node"));
        assert!(msg.contains("22"));
    }
}
