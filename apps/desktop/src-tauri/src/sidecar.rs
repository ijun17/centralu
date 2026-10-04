//! The app's side of the agent host.
//!
//! Tauri's role here is not a communication relay but **process supervision**
//! (docs/architecture.md §4). It gets the host's port and token to the UI and brings the host
//! back if it dies. The communication itself is done by the UI directly over WS — the reason dev
//! and prod share the same path.
//!
//! Two ways to get there (#280, option C step 1):
//!   - **Keeper** (release builds on unix): the app finds or launches the keeper — this same
//!     executable as `centralu --keeper`, detached into its own session — and attaches to it over
//!     its control socket. The keeper holds the host, so quitting, crashing or replacing the app
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<bool>,
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

fn use_keeper() -> bool {
    if std::env::var("CC_HOST_CMD").is_ok() || !cfg!(unix) {
        return false;
    }
    !cfg!(debug_assertions) || std::env::var("CC_USE_KEEPER").as_deref() == Ok("1")
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

    /// Restarts the host from this window's build. Running turns are cut; the UI says so first.
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

    pub fn set_background(&self, on: bool) -> Result<bool, String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().ok_or("not attached to a keeper")?.set_background(on),
            _ => Err("background mode needs the keeper, which this build does not use".into()),
        }
    }

    /// "Quit and stop agents": tells the keeper to stop the host and itself, whatever background
    /// mode says. In direct mode quitting already does that.
    pub fn stop_agents(&self) -> Result<(), String> {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().ok_or("not attached to a keeper")?.stop(),
            _ => Ok(()),
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

#[cfg(unix)]
mod link {
    //! The app attached to a keeper.

    use super::*;
    use crate::host_proc::{backoff, MAX_RESTARTS, STABLE_UPTIME};
    use crate::keeper::{client, source::BuildSource, KeeperView, KEEPER_FLAG};
    use serde_json::{json, Value};
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[derive(Default)]
    struct LinkState {
        info: Option<HostInfo>,
        error: Option<String>,
        view: Option<KeeperView>,
        same_build: Option<bool>,
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
                background: st.view.as_ref().map(|v| v.background),
            }
        }

        fn launch_keeper(&self) -> std::io::Result<()> {
            let exe = std::env::current_exe()?;
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
            let env: Vec<(String, String)> = if self.dev { vec![("CC_DEV".into(), "1".into())] } else { Vec::new() };
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
            if let Ok(mut st) = self.state.lock() {
                st.same_build = same;
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
                let changed = st.view.as_ref().map(|v| v.status != view.status || v.source != view.source || v.background != view.background).unwrap_or(true);
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

        pub fn switch_build(&self) -> Result<(), String> {
            client::request(&self.sock, &json!({ "op": "switch", "source": self.app_build }), Duration::from_secs(10)).map(|_| ())
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

    #[test]
    fn a_supervisor_that_never_started_reports_direct_mode() {
        let sup = Supervisor::new();
        assert_eq!(sup.build().mode, "direct");
        assert!(sup.background().is_err(), "background mode is only offered with a keeper");
        assert!(sup.stop_agents().is_ok(), "quitting in direct mode already stops the agents");
    }
}
