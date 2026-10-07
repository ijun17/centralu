//! The app's side of the agent host.
//!
//! Tauri's role here is not a communication relay but **process supervision**
//! (docs/architecture.md §4). It gets the host's port and token to the UI and brings the host
//! back if it dies. The communication itself is done by the UI directly over WS — the reason dev
//! and prod share the same path.
//!
//! Two ways to get there (#280, option C step 1):
//!   - **Keeper** (release builds on unix): the app finds or launches the keeper — the
//!     `centralu-keeper` executable next to its own (#440), detached into its own session — and
//!     attaches to it over its control socket. The keeper holds the host, so quitting, crashing or replacing the app
//!     does not end the host unless background mode is off, in which case the keeper stops it the
//!     moment the last window detaches, as quitting always did.
//!   - **Direct** (`pnpm app:dev` and other debug builds, `CC_HOST_CMD`, non-unix targets): the
//!     app is the host's parent, exactly as before. `CC_USE_KEEPER=1` opts a debug build into
//!     the keeper path.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub use crate::host_proc::HostInfo;
use crate::host_proc::{self, HostLaunch, HostStatus, LaunchError, Launcher, StatusSink};

/// What the UI is told about the builds involved (`host_build`, and the `host-build` event).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBuild {
    /// `keeper` or `direct`.
    pub mode: &'static str,
    #[cfg(unix)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app: Option<crate::keeper::source::BuildSource>,
    #[cfg(unix)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<crate::keeper::source::BuildSource>,
    /// False when the running host is from a different build than this window: the UI offers to
    /// switch. None when it cannot be told (direct mode, or not attached yet).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub same_build: Option<bool>,
    /// The build of the keeper itself (#280 step 4). Absent for a keeper older than step 4.
    #[cfg(unix)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keeper: Option<crate::keeper::source::BuildSource>,
    /// False when the keeper is from another build than this window. Switching moves the keeper
    /// over too, without stopping anything. None when it cannot be told.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keeper_same_build: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
    /// The current or last blue-green swap (#280 step 3), as the keeper reports it.
    #[cfg(unix)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap: Option<crate::keeper::swap::SwapView>,
    /// Whether a swap hands agents over (step 2) or stops them, as the running host says.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keeps_agents: Option<bool>,
    /// A session working or waiting, a terminal or a command running: what a switch could cost.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub busy: Option<bool>,
    /// This window was started by "Apply now" (#352): the keeper held on through the relaunch and
    /// said so when this window attached. The window then applies the switch by itself when
    /// nothing can be lost.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub relaunched: bool,
}

/// Whether "Apply now" can relaunch this window into the update just installed (#352), and why
/// not when it cannot.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaunchInfo {
    pub ready: bool,
    /// Why not, in words the update line can show.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// The version now in this window's bundle on disk, when it can be read.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The bundle the relaunch starts from.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_path: Option<String>,
}

#[derive(Clone, Default)]
pub struct Supervisor {
    inner: Arc<Mutex<Choice>>,
    direct: host_proc::Supervisor,
    #[cfg(unix)]
    keeper: Arc<Mutex<Option<Arc<link::KeeperLink>>>>,
}

#[derive(Default, Clone, Copy, PartialEq)]
enum Choice {
    #[default]
    Undecided,
    Direct,
    #[cfg(unix)]
    Keeper,
}

struct TauriSink(AppHandle);

impl StatusSink for TauriSink {
    fn status(&self, status: &HostStatus) {
        emit(&self.0, status);
    }
}

fn emit(app: &AppHandle, status: &HostStatus) {
    let _ = app.emit("host-status", status);
}

/// The bundled host lives in the resource directory in a release build (F-0).
///
/// **Do not decide dev vs. prod by existence alone** — `tauri dev`'s resource_dir is
/// target/debug/, and once a release build has been made even once, a bundle stays copied there
/// too. If existence alone decided it, dev would launch that stale bundled host without CC_DEV,
/// so source edits would not take effect and it would grab the release app's data folder as
/// well. A dev build unconditionally uses the source host (docs/architecture.md §4 — dev runs
/// the source directly via tsx, plus CC_DEV=1).
fn bundled_host_dir(app: &AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    app.path()
        .resource_dir()
        .ok()
        .map(|d| d.join("resources/host"))
        .filter(|p| p.join("main.mjs").exists())
}

#[cfg_attr(not(unix), allow(dead_code))] // off unix the answer is always no, and nobody asks
fn use_keeper() -> bool {
    if std::env::var("CC_HOST_CMD").is_ok() || !cfg!(unix) {
        return false;
    }
    let opted_in = std::env::var("CC_USE_KEEPER").as_deref() == Ok("1");
    // The keeper has only ever run on macOS (#295). On Linux it compiles in CI but was never
    // started, and an AppImage unmounts its files when the app exits, which may take a
    // background keeper's executable with it. Until someone runs it there, Linux keeps the
    // direct host path unless CC_USE_KEEPER=1 asks for the keeper.
    if !cfg!(target_os = "macos") {
        return opted_in;
    }
    !cfg!(debug_assertions) || opted_in
}

impl Supervisor {
    pub fn new() -> Self {
        Self::default()
    }

    fn choice(&self) -> Choice {
        self.inner.lock().map(|c| *c).unwrap_or(Choice::Undecided)
    }

    pub fn info(&self) -> Option<HostInfo> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().and_then(|l| l.info()),
            _ => self.direct.info(),
        }
    }

    pub fn last_error(&self) -> Option<String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().and_then(|l| l.last_error()),
            _ => self.direct.last_error(),
        }
    }

    /// Starts supervising. The app still comes up even if this fails (the UI shows the status).
    pub fn start(&self, app: AppHandle) {
        let bundled = bundled_host_dir(&app);
        #[cfg(unix)]
        if use_keeper() {
            if let Ok(mut c) = self.inner.lock() {
                *c = Choice::Keeper;
            }
            let link = Arc::new(link::KeeperLink::new(bundled));
            if let Ok(mut k) = self.keeper.lock() {
                *k = Some(link.clone());
            }
            link.start(app);
            return;
        }
        if let Ok(mut c) = self.inner.lock() {
            *c = Choice::Direct;
        }
        self.direct.start(Arc::new(TauriSink(app)), direct_launcher(bundled));
    }

    /// Retry from the failure screen (#184).
    pub fn restart(&self, app: AppHandle) -> bool {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().map(|l| l.restart(app)).unwrap_or(false),
            _ => {
                let bundled = bundled_host_dir(&app);
                self.direct.restart(Arc::new(TauriSink(app)), direct_launcher(bundled))
            }
        }
    }

    /// Called when the app quits.
    ///
    /// Direct: stops the host, as always. Keeper: only detaches. The keeper applies background
    /// mode itself — with it off it stops the host now; with it on, the host keeps running.
    /// Either way the app does not wait: the keeper gives the host its grace period after the
    /// app is gone.
    pub fn shutdown(&self) {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => {
                if let Some(l) = self.link() {
                    l.detach();
                }
            }
            _ => self.direct.shutdown(),
        }
    }

    pub fn build(&self) -> HostBuild {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().map(|l| l.build()).unwrap_or_default(),
            _ => HostBuild { mode: "direct", ..Default::default() },
        }
    }

    /// Switches the host to this window's build with the keeper's blue-green swap (#280 step 3).
    /// Progress and failure arrive in `host-build` (`swap`).
    pub fn switch_build(&self) -> Result<(), String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().ok_or("not attached to a keeper")?.switch_build(),
            _ => Err("the host is not held by a keeper in this build".into()),
        }
    }

    pub fn background(&self) -> Result<bool, String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().ok_or("not attached to a keeper")?.background(),
            _ => Err("background mode needs the keeper, which this build does not use".into()),
        }
    }

    #[cfg_attr(not(unix), allow(unused_variables))] // `on` is for the keeper, which is unix-only
    pub fn set_background(&self, on: bool) -> Result<bool, String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().ok_or("not attached to a keeper")?.set_background(on),
            _ => Err("background mode needs the keeper, which this build does not use".into()),
        }
    }

    /// Whether "Apply now" can relaunch this window into the update just installed (#352). Only
    /// with the keeper: in direct mode the host is this process's child and a relaunch would stop
    /// every agent, exactly the quit the update is meant to avoid.
    pub fn relaunch_info(&self) -> RelaunchInfo {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().map(|l| l.relaunch_info()).unwrap_or_else(|| RelaunchInfo {
                reason: Some("not attached to the background keeper".into()),
                ..Default::default()
            }),
            _ => RelaunchInfo {
                reason: Some(
                    "This build holds the agent host itself, so relaunching would stop running agents. Quit and open Centralu again to finish."
                        .into(),
                ),
                ..Default::default()
            },
        }
    }

    /// Tells the keeper the window is about to relaunch (#352), so it holds the host and agents
    /// until the new window attaches, whatever background mode says. Errs when the keeper cannot
    /// (one older than #352 answers "unknown op").
    pub fn announce_relaunch(&self) -> Result<u64, String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().ok_or("not attached to a keeper")?.announce_relaunch(),
            _ => Err("the host is not held by a keeper in this build".into()),
        }
    }

    /// "Quit completely": tells the keeper to stop the host, everything it holds (agents,
    /// terminals, running commands) and itself, whatever background mode says. In direct mode
    /// quitting already does that.
    pub fn stop_agents(&self) -> Result<(), String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().ok_or("not attached to a keeper")?.stop(),
            _ => Ok(()),
        }
    }

    /// "Restart completely" (#387): stops the keeper as "Quit completely" does, but this window
    /// stays and starts a keeper of its own build. For a keeper of an older build that could not
    /// hand itself over: the fix for a failing handoff is in the sending keeper, which an update
    /// does not replace while it runs.
    pub fn restart_keeper(&self) -> Result<(), String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().ok_or("not attached to a keeper")?.restart_keeper(),
            _ => Err("the host is not held by a keeper in this build".into()),
        }
    }

    #[cfg(unix)]
    fn link(&self) -> Option<Arc<link::KeeperLink>> {
        self.keeper.lock().ok()?.clone()
    }
}

/// The direct path's launch: the bundled host through the system Node, `CC_HOST_CMD`, or the
/// source through tsx — exactly what the app ran before the keeper existed.
fn direct_launcher(bundled: Option<PathBuf>) -> Launcher {
    Arc::new(move || {
        let mut launch: HostLaunch = if let Some((program, args)) = host_proc::host_cmd_override() {
            HostLaunch { program, args, env: Vec::new() }
        } else if let Some(dir) = &bundled {
            host_proc::bundled_launch(&dir.join("main.mjs"), &[])?
        } else {
            return Ok(host_proc::source_launch(&[]));
        };
        // A host launched from dev uses a **different data folder** than the release app.
        // If two hosts held the same folder, the session lists would get out of sync.
        if bundled.is_none() {
            launch.env.push(("CC_DEV".into(), "1".into()));
        }
        Ok::<_, LaunchError>(launch)
    })
}

/**
 * Whether relaunching starts a different build than this window (#352), from what is on disk now.
 *
 * - No bundle around the executable (`pnpm app:dev`, a bare binary): a relaunch starts the same
 *   build, and the update went to the installed app, not here.
 * - Nothing readable on disk where the build should be: the bundle is half replaced or gone, and a
 *   relaunch could start nothing at all.
 * - The same build on disk as this window: the update did not replace this bundle. This is the
 *   case of `pnpm app:open`, which runs the build output in place while `centralu install` writes
 *   `/Applications/Centralu.app`.
 */
#[cfg(unix)]
pub(crate) fn relaunch_decision(
    app: &crate::keeper::source::BuildSource,
    on_disk: Option<&crate::keeper::source::BuildSource>,
    in_bundle: bool,
    bundle: &str,
) -> RelaunchInfo {
    let not = |reason: String| RelaunchInfo { reason: Some(reason), bundle_path: Some(bundle.to_string()), ..Default::default() };
    if !in_bundle {
        return not("This window does not run from an app bundle, so relaunching would start the same build. Open the installed Centralu to finish.".into());
    }
    let Some(on_disk) = on_disk else {
        return not(format!("The app at {bundle} is incomplete right now, so relaunching could start nothing. Open Centralu again by hand."));
    };
    if on_disk.same_build(app) {
        return not(format!(
            "This window runs from {bundle}, which the update did not replace. Open the installed Centralu to use the new version."
        ));
    }
    RelaunchInfo { ready: true, reason: None, version: None, bundle_path: Some(bundle.to_string()) }
}

/// The version in a bundle's `Info.plist` (`CFBundleShortVersionString`), read as text: Tauri
/// writes an XML plist, and this is for showing a version, so an unreadable one is just absent.
#[cfg(unix)]
pub(crate) fn bundle_version(bundle: &std::path::Path) -> Option<String> {
    let text = std::fs::read_to_string(bundle.join("Contents/Info.plist")).ok()?;
    plist_string(&text, "CFBundleShortVersionString")
}

#[cfg(unix)]
fn plist_string(text: &str, key: &str) -> Option<String> {
    let after = &text[text.find(&format!("<key>{key}</key>"))?..];
    let start = after.find("<string>")? + "<string>".len();
    let end = after[start..].find("</string>")?;
    let v = after[start..start + end].trim();
    (!v.is_empty() && v.len() <= 64).then(|| v.to_string())
}

#[cfg(unix)]
mod link {
    //! The app attached to a keeper.

    use super::*;
    use crate::host_proc::{backoff, MAX_RESTARTS, STABLE_UPTIME};
    use crate::keeper::{client, exe as keeper_exe, source::BuildSource, KeeperView, KEEPER_FLAG};
    use serde_json::{json, Value};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct LinkState {
        info: Option<HostInfo>,
        error: Option<String>,
        view: Option<KeeperView>,
        same_build: Option<bool>,
        /// The keeper said this window is the one an announced relaunch started (#352). Kept for
        /// the window's life: a later re-attach (the keeper restarted) does not undo it.
        relaunched: bool,
        attached: Option<client::Attached>,
        running: bool,
        shutting_down: bool,
    }

    pub struct KeeperLink {
        dev: bool,
        data: PathBuf,
        sock: PathBuf,
        host_dir: Option<PathBuf>,
        app_build: BuildSource,
        state: Mutex<LinkState>,
    }

    impl KeeperLink {
        pub fn new(bundled: Option<PathBuf>) -> Self {
            // A debug build opted into the keeper runs the source host and uses the dev data
            // folder, like its direct path.
            let dev = bundled.is_none();
            let host_dir = std::env::var("CC_KEEPER_HOST_SOURCE").ok().filter(|s| !s.trim().is_empty()).map(PathBuf::from).or(bundled);
            let exe = std::env::current_exe().unwrap_or_default();
            let app_build = match &host_dir {
                Some(dir) => BuildSource::from_host_dir(
                    dir,
                    Some(client::bundle_of(&exe).to_string_lossy().to_string()),
                    Some(env!("CARGO_PKG_VERSION").to_string()),
                ),
                None => BuildSource::dev(),
            };
            let data = crate::keeper::data_dir_with(dev || std::env::var("CC_DEV").as_deref() == Ok("1"));
            KeeperLink {
                dev,
                sock: crate::keeper::socket_path(&data),
                data,
                host_dir,
                app_build,
                state: Mutex::new(LinkState::default()),
            }
        }

        pub fn info(&self) -> Option<HostInfo> {
            self.state.lock().ok()?.info.clone()
        }

        pub fn last_error(&self) -> Option<String> {
            self.state.lock().ok()?.error.clone()
        }

        pub fn build(&self) -> HostBuild {
            let Ok(st) = self.state.lock() else { return HostBuild::default() };
            HostBuild {
                mode: "keeper",
                app: Some(self.app_build.clone()),
                host: st.view.as_ref().and_then(|v| v.source.clone()),
                same_build: st.view.as_ref().and_then(|v| v.source.as_ref()).map(|s| s.same_build(&self.app_build)).or(st.same_build),
                keeper: st.view.as_ref().and_then(|v| v.keeper.build.clone()),
                keeper_same_build: st.view.as_ref().and_then(|v| v.keeper.build.as_ref()).map(|b| b.same_build(&self.app_build)),
                background: st.view.as_ref().map(|v| v.background),
                swap: st.view.as_ref().and_then(|v| v.swap.clone()),
                keeps_agents: st.view.as_ref().and_then(|v| v.keeps_agents),
                busy: st.view.as_ref().map(|v| v.busy),
                relaunched: st.relaunched,
            }
        }

        /// What "Apply now" would start (#352): Tauri's restart runs this window's own executable
        /// path again, inside the same bundle. `centralu install` replaced that bundle (`rmSync`,
        /// then `ditto`), so the path now names the new build — unless this window runs from a
        /// bundle the update did not touch (`pnpm app:open` opens the build output in place) or from
        /// no bundle at all (`pnpm app:dev`).
        pub fn relaunch_info(&self) -> RelaunchInfo {
            let exe = std::env::current_exe().unwrap_or_default();
            let bundle = client::bundle_of(&exe);
            let in_bundle = bundle != exe;
            let on_disk = self
                .host_dir
                .as_ref()
                .filter(|d| !self.dev && d.join("main.mjs").is_file() && exe.is_file())
                .map(|d| BuildSource::from_host_dir(d, Some(bundle.to_string_lossy().to_string()), None));
            let mut info = super::relaunch_decision(&self.app_build, on_disk.as_ref(), in_bundle, &bundle.to_string_lossy());
            if info.ready {
                info.version = super::bundle_version(&bundle);
            }
            info
        }

        pub fn announce_relaunch(&self) -> Result<u64, String> {
            let v = client::request(&self.sock, &json!({ "op": "relaunching" }), Duration::from_secs(5)).map_err(|e| {
                if e.contains("unknown op") {
                    "the background keeper is from an older build and cannot hold the agents through a relaunch".to_string()
                } else {
                    e
                }
            })?;
            Ok(v.get("graceSecs").and_then(Value::as_u64).unwrap_or(0))
        }

        fn launch_keeper(&self) -> std::io::Result<()> {
            // The keeper executable next to this one (#440), or this one with `--keeper` when there is
            // none. A debug build always runs it in its own executable: `tauri dev` does not rebuild
            // `centralu-keeper`, so the one beside it may be older code (keeper::exe).
            let me = std::env::current_exe()?;
            let exe = if cfg!(debug_assertions) { me } else { keeper_exe::to_start(&me) };
            // The legacy folder moves before this creates the new one (keeper::prepare_default_dir).
            let _ = crate::keeper::prepare_default_dir(&self.data, self.dev || std::env::var("CC_DEV").as_deref() == Ok("1"));
            let _ = std::fs::create_dir_all(&self.data);
            let mut args = vec![KEEPER_FLAG.to_string(), "--data-dir".into(), self.data.to_string_lossy().to_string()];
            if let Some(dir) = &self.host_dir {
                args.push("--host-source".into());
                args.push(dir.to_string_lossy().to_string());
            }
            if let Some(b) = &self.app_build.bundle_path {
                args.push("--bundle-path".into());
                args.push(b.clone());
            }
            args.push("--app-version".into());
            args.push(env!("CARGO_PKG_VERSION").into());
            let mut env: Vec<(String, String)> = if self.dev { vec![("CC_DEV".into(), "1".into())] } else { Vec::new() };
            if cfg!(debug_assertions) {
                env.push((keeper_exe::IN_PROCESS_ENV.into(), "1".into()));
            }
            client::launch_detached(&exe, &args, &env, &self.data.join("keeper.log"))
        }

        pub fn start(self: &Arc<Self>, app: AppHandle) {
            {
                let Ok(mut st) = self.state.lock() else { return };
                if st.running || st.shutting_down {
                    return;
                }
                st.running = true;
                st.error = None;
            }
            let me = self.clone();
            std::thread::spawn(move || {
                me.run(&app);
                if let Ok(mut st) = me.state.lock() {
                    st.running = false;
                }
            });
        }

        /// Keeps the app attached: finds or launches the keeper, attaches, and on losing it
        /// (the keeper crashed or was stopped by someone else) starts over with backoff, by the
        /// same rules the app used for a crashed host.
        fn run(self: &Arc<Self>, app: &AppHandle) {
            let mut attempt = 0u32;
            loop {
                if self.shutting_down() {
                    return;
                }
                if attempt > 0 {
                    emit(app, &HostStatus::Restarting { attempt });
                }
                let started = Instant::now();
                let outcome = self.attach_once(app);
                if self.shutting_down() {
                    return;
                }
                if started.elapsed() >= STABLE_UPTIME {
                    attempt = 0;
                }
                attempt += 1;
                if attempt > MAX_RESTARTS {
                    let message = match outcome {
                        Err(e) => e,
                        Ok(()) => "lost the connection to the keeper".to_string(),
                    };
                    if let Ok(mut st) = self.state.lock() {
                        st.error = Some(message.clone());
                        st.info = None;
                    }
                    emit(app, &HostStatus::Failed { message });
                    return;
                }
                std::thread::sleep(backoff(attempt));
            }
        }

        /// One attachment, from finding the keeper to losing it.
        fn attach_once(self: &Arc<Self>, app: &AppHandle) -> Result<(), String> {
            client::ensure(&self.sock, || self.launch_keeper(), Duration::from_secs(25))?;
            let (closed_tx, closed_rx) = mpsc::channel::<()>();
            let me = self.clone();
            let app2 = app.clone();
            let (first, attached) = client::attach(
                &self.sock,
                Some(&self.app_build),
                move |event| me.on_event(&app2, &event),
                move || {
                    let _ = closed_tx.send(());
                },
            )?;
            let same = first.get("sameBuild").and_then(Value::as_bool);
            let relaunched = first.get("relaunched").and_then(Value::as_bool) == Some(true);
            if let Ok(mut st) = self.state.lock() {
                st.same_build = same;
                st.relaunched |= relaunched;
                st.attached = Some(attached);
            }
            self.on_view(app, first.get("view"));
            let _ = closed_rx.recv();
            if let Ok(mut st) = self.state.lock() {
                st.attached = None;
                st.info = None;
                st.view = None;
            }
            Ok(())
        }

        fn on_event(&self, app: &AppHandle, event: &Value) {
            if event.get("event").and_then(Value::as_str) == Some("status") {
                self.on_view(app, event.get("view"));
            }
        }

        /// Turns the keeper's view into what the UI already understands: the same `host-status`
        /// events the direct path emits, plus `host-build` when the builds are known.
        fn on_view(&self, app: &AppHandle, view: Option<&Value>) {
            let Some(view) = view.and_then(|v| serde_json::from_value::<KeeperView>(v.clone()).ok()) else { return };
            let status = view.status.clone();
            let changed = {
                let Ok(mut st) = self.state.lock() else { return };
                let changed = st
                    .view
                    .as_ref()
                    .map(|v| {
                        v.status != view.status
                            || v.keeper != view.keeper
                            || v.source != view.source
                            || v.background != view.background
                            || v.swap != view.swap
                            || v.keeps_agents != view.keeps_agents
                            || v.busy != view.busy
                    })
                    .unwrap_or(true);
                match &status {
                    HostStatus::Ready(info) => {
                        st.info = Some(info.clone());
                        st.error = None;
                    }
                    HostStatus::Failed { message } => {
                        st.info = None;
                        st.error = Some(message.clone());
                    }
                    _ => st.info = None,
                }
                st.view = Some(view);
                changed
            };
            if changed {
                emit(app, &status);
                let _ = app.emit("host-build", self.build());
            }
        }

        fn shutting_down(&self) -> bool {
            self.state.lock().map(|s| s.shutting_down).unwrap_or(true)
        }

        pub fn restart(self: &Arc<Self>, app: AppHandle) -> bool {
            let running = self.state.lock().map(|s| s.running).unwrap_or(false);
            if !running {
                // The link itself gave up (no keeper could be reached): try again from the top.
                self.start(app);
                return true;
            }
            if let Ok(mut st) = self.state.lock() {
                st.error = None;
            }
            client::request(&self.sock, &json!({ "op": "restart" }), Duration::from_secs(5))
                .ok()
                .and_then(|v| v.get("started").and_then(Value::as_bool))
                .unwrap_or(false)
        }

        /// Switches to this window's build. The keeper is handed this build's keeper executable, inside
        /// its bundle (#440), so that a keeper of another build first hands itself over to this build's
        /// keeper (#280 step 4): the program the bundle shipped, never a copy (#220). A keeper older than
        /// step 4 ignores the field and swaps only the host.
        pub fn switch_build(&self) -> Result<(), String> {
            let exe = std::env::current_exe().ok().map(|me| keeper_exe::to_start(&me));
            let mut req = json!({ "op": "switch", "source": self.app_build });
            if let Some(exe) = exe.filter(|_| !self.dev) {
                req["keeper"] = json!({ "exe": exe });
            }
            client::request(&self.sock, &req, Duration::from_secs(10)).map(|_| ())
        }

        pub fn background(&self) -> Result<bool, String> {
            let v = client::request(&self.sock, &json!({ "op": "settings" }), Duration::from_secs(5))?;
            Ok(v.get("background").and_then(Value::as_bool).unwrap_or(false))
        }

        pub fn set_background(&self, on: bool) -> Result<bool, String> {
            let v = client::request(&self.sock, &json!({ "op": "set_background", "on": on }), Duration::from_secs(5))?;
            Ok(v.get("background").and_then(Value::as_bool).unwrap_or(on))
        }

        pub fn stop(&self) -> Result<(), String> {
            if let Ok(mut st) = self.state.lock() {
                st.shutting_down = true;
            }
            client::request(&self.sock, &json!({ "op": "stop" }), Duration::from_secs(5)).map(|_| ())
        }

        /// Stops the keeper and everything it holds, like `stop`, but stays: the attach loop (`run`)
        /// sees the connection end when the keeper has exited, and starts a keeper from this
        /// window's own executable, with this window's host. The keeper removes its socket before it
        /// stops anything, so nothing reaches it on its way out, and the next one waits for its lock.
        pub fn restart_keeper(&self) -> Result<(), String> {
            client::request(&self.sock, &json!({ "op": "stop" }), Duration::from_secs(5)).map(|_| ())
        }

        /// Detaches without asking for anything: the keeper decides what that means.
        pub fn detach(&self) {
            if let Ok(mut st) = self.state.lock() {
                st.shutting_down = true;
                st.info = None;
                if let Some(a) = st.attached.take() {
                    a.close();
                }
            }
        }
    }

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_direct_path_stays_the_default_for_debug_builds() {
        // `pnpm app:dev` must keep running the host as the app's own child, unchanged.
        if cfg!(debug_assertions) && std::env::var("CC_USE_KEEPER").is_err() && std::env::var("CC_HOST_CMD").is_err() {
            assert!(!use_keeper());
        }
    }

    /// #352: "Apply now" is only offered when relaunching starts the build the update installed.
    #[cfg(unix)]
    #[test]
    fn apply_now_relaunches_only_into_a_different_build_on_disk() {
        use crate::keeper::source::BuildSource;
        let build = |commit: &str| BuildSource { commit: commit.into(), ..Default::default() };
        let app = build("aaaaaaa");
        let ready = relaunch_decision(&app, Some(&build("bbbbbbb")), true, "/Applications/Centralu.app");
        assert!(ready.ready, "the bundle now holds another build: relaunching applies it");
        let same = relaunch_decision(&app, Some(&build("aaaaaaa")), true, "/x/target/release/bundle/macos/Centralu.app");
        assert!(!same.ready, "pnpm app:open: the update did not replace this bundle");
        assert!(same.reason.unwrap().contains("did not replace"));
        assert!(!relaunch_decision(&app, Some(&build("bbbbbbb")), false, "/x/centralu").ready, "no bundle: the same binary again");
        assert!(!relaunch_decision(&app, None, true, "/Applications/Centralu.app").ready, "nothing on disk to start");
    }

    #[cfg(unix)]
    #[test]
    fn reads_the_version_from_an_xml_plist() {
        let plist = "<dict>\n\t<key>CFBundleName</key>\n\t<string>Centralu</string>\n\t<key>CFBundleShortVersionString</key>\n\t<string>0.1.0-beta.11</string>\n</dict>";
        assert_eq!(plist_string(plist, "CFBundleShortVersionString").as_deref(), Some("0.1.0-beta.11"));
        assert_eq!(plist_string(plist, "CFBundleVersion"), None);
    }

    #[test]
    fn a_supervisor_that_never_started_reports_direct_mode() {
        let sup = Supervisor::new();
        assert_eq!(sup.build().mode, "direct");
        assert!(sup.background().is_err(), "background mode is only offered with a keeper");
        assert!(sup.stop_agents().is_ok(), "quitting in direct mode already stops the agents");
    }
}
