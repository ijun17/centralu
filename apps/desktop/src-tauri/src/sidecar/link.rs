//! The app attached to a keeper.

use super::*;
use crate::host_proc::{backoff, MAX_RESTARTS, STABLE_UPTIME};
use crate::keeper::{client, exe as keeper_exe, source::BuildSource, KeeperView};
use centralu_keeper_core::start_plan::{Shell, StartMode};
use serde_json::Value;
use std::sync::mpsc;
use std::time::{Duration, Instant};

/**
 * Whether the keeper the window is attached to is of the window's build, from the build the
 * keeper reports for itself (`keeper.build`, #280 step 4).
 *
 * A keeper that reports none is older than step 4: it cannot hand itself over, and ignores the
 * `keeper` a switch names. Until #461 the window could not tell such a keeper's build and left it
 * alone; now it counts as another build, so after the host moves the window offers "Restart
 * completely", which starts a keeper of its own build.
 */
pub(crate) fn keeper_same_build(keeper: Option<&BuildSource>, app: &BuildSource) -> bool {
    keeper.is_some_and(|b| b.same_build(app))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #461: a keeper that cannot say its build (older than #280 step 4) is another build, never
    /// "can't tell", so the window offers to restart it rather than leaving it be.
    #[test]
    fn a_keeper_that_reports_no_build_is_of_another_build() {
        let build = |commit: &str| BuildSource { commit: commit.into(), ..Default::default() };
        let app = build("aaaaaaa");
        assert!(keeper_same_build(Some(&build("aaaaaaa")), &app));
        assert!(!keeper_same_build(Some(&build("bbbbbbb")), &app));
        assert!(!keeper_same_build(None, &app));
    }

    /// The UI used to be told only when one of seven fields of the keeper's view changed, named one
    /// by one, so a field added to `HostBuild` but not to that list never reached it. Now any change
    /// to what the UI is given counts.
    #[test]
    fn the_ui_hears_of_any_change_to_the_build_and_of_nothing_else() {
        let build = HostBuild { mode: "keeper", busy: Some(false), ..Default::default() };
        let before = (HostStatus::Starting, build.clone());
        assert!(is_news(None, &HostStatus::Starting, &build), "the first view after an attach");
        assert!(!is_news(Some(&before), &HostStatus::Starting, &build));
        assert!(is_news(Some(&before), &HostStatus::Restarting { attempt: 1 }, &build));
        for changed in [
            HostBuild { busy: Some(true), ..build.clone() },
            HostBuild { relaunched: true, ..build.clone() },
            HostBuild { swap_to_this_build: Some(true), ..build.clone() },
            HostBuild { keeper_same_build: Some(false), ..build.clone() },
        ] {
            assert!(is_news(Some(&before), &HostStatus::Starting, &changed), "{changed:?}");
        }
    }
}

/// Whether the UI hears of a view: the first after an attach, or one whose status or build differs
/// from what the UI was last told.
fn is_news(before: Option<&(HostStatus, HostBuild)>, status: &HostStatus, after: &HostBuild) -> bool {
    before.is_none_or(|(was, built)| was != status || built != after)
}

#[derive(Default)]
struct LinkState {
    info: Option<HostInfo>,
    error: Option<String>,
    view: Option<KeeperView>,
    /// The status and the build the UI was last told from a view (`on_view`). None until the first
    /// view of an attachment: losing the keeper ends with `Restarting` or `Failed`, sent past this.
    told: Option<(HostStatus, HostBuild)>,
    same_build: Option<bool>,
    /// The keeper said this window is the one an announced relaunch started (#352). Kept for
    /// the window's life: a later re-attach (the keeper restarted) does not undo it.
    relaunched: bool,
    attached: Option<client::Attached>,
    running: bool,
    shutting_down: bool,
    /// The last start through the shell, for `HostBuild.shell`.
    shell: Option<crate::shell::Report>,
    /// The shell did not start a keeper once: every later start in this window's life is direct.
    shell_off: bool,
    /// What is shown of a refusal of signed content, and when: the shell's refusal of this window's content, and the keeper's
    /// of a switch this window sent (`refusal::Announcer`).
    announcer: crate::refusal::Announcer,
}

pub struct KeeperLink {
    /// What the window knew when it started, for asking the start plan again on every attempt.
    facts: Facts,
    dev: bool,
    /// Whether the data folder is the dev one: a dev plan, or `CC_DEV=1` in the environment.
    dev_data: bool,
    data: PathBuf,
    sock: PathBuf,
    host_dir: Option<PathBuf>,
    app_build: BuildSource,
    /// The window's resource folder, where the shell and the signed content are carried.
    resources: Option<PathBuf>,
    state: Mutex<LinkState>,
}

impl KeeperLink {
    pub fn new(facts: Facts, bundled: Option<PathBuf>, resources: Option<PathBuf>) -> Self {
        let plan = start_plan::plan(&facts);
        // A debug build opted into the keeper runs the source host and uses the dev data
        // folder, like its direct path.
        let dev = plan.dev;
        let host_dir = match plan.host {
            Some(Host::Named) => std::env::var(start_plan::KEEPER_HOST_SOURCE_ENV).ok().map(PathBuf::from),
            Some(Host::Bundle) => bundled,
            _ => None,
        };
        let exe = std::env::current_exe().unwrap_or_default();
        let app_build = match &host_dir {
            Some(dir) => BuildSource::from_host_dir(
                dir,
                Some(client::bundle_of(&exe).to_string_lossy().to_string()),
                Some(env!("CARGO_PKG_VERSION").to_string()),
            ),
            None => BuildSource::dev(),
        };
        let dev_data = dev || std::env::var("CC_DEV").as_deref() == Ok("1");
        let data = crate::keeper::data_dir_with(dev_data);
        KeeperLink {
            facts,
            dev,
            dev_data,
            sock: crate::keeper::socket_path(&data),
            data,
            host_dir,
            app_build,
            resources,
            state: Mutex::new(LinkState::default()),
        }
    }

    /// The start plan now: whether a keeper answers, and whether the shell already fell back.
    fn plan(&self, keeper_answering: bool) -> StartMode {
        let shell_off = self.state.lock().map(|s| s.shell_off).unwrap_or(true);
        let facts = Facts { keeper_answering, shell: if shell_off { Shell::FellBack } else { Shell::Untried }, ..self.facts };
        start_plan::plan(&facts).mode
    }

    pub fn info(&self) -> Option<HostInfo> {
        self.state.lock().ok()?.info.clone()
    }

    pub fn last_error(&self) -> Option<String> {
        self.state.lock().ok()?.error.clone()
    }

    pub fn build(&self) -> HostBuild {
        let Ok(st) = self.state.lock() else { return HostBuild::default() };
        self.build_of(&st)
    }

    /// What `build` says for the state `st`.
    fn build_of(&self, st: &LinkState) -> HostBuild {
        HostBuild {
            mode: "keeper",
            app: Some(self.app_build.clone()),
            host: st.view.as_ref().and_then(|v| v.source.clone()),
            same_build: st.view.as_ref().and_then(|v| v.source.as_ref()).map(|s| s.same_build(&self.app_build)).or(st.same_build),
            keeper: st.view.as_ref().and_then(|v| v.keeper.build.clone()),
            keeper_same_build: st.view.as_ref().map(|v| keeper_same_build(v.keeper.build.as_ref(), &self.app_build)),
            background: st.view.as_ref().map(|v| v.background),
            swap: st.view.as_ref().and_then(|v| v.swap.clone()),
            swap_to_this_build: st.view.as_ref().and_then(|v| v.swap.as_ref()).map(|s| s.is_to(&self.app_build)),
            keeps_agents: st.view.as_ref().and_then(|v| v.keeps_agents),
            busy: st.view.as_ref().map(|v| v.busy),
            relaunched: st.relaunched,
            shell: st.shell.clone(),
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
        client::relaunching(&self.sock)
    }

    /// Starts a keeper the way the plan says (`mode`, never `Direct` or `Attach` here).
    fn launch_keeper(&self, mode: StartMode) -> std::io::Result<()> {
        let me = std::env::current_exe()?;
        // The legacy folder moves before this creates the new one (keeper::prepare_default_dir).
        let _ = crate::keeper::prepare_default_dir(&self.data, self.dev_data);
        let _ = std::fs::create_dir_all(&self.data);
        let mode = match mode {
            StartMode::ThroughShell { allow_unpinned } => {
                if self.through_shell(allow_unpinned) {
                    return Ok(());
                }
                // The shell fell back: the plan now says how the window starts it itself.
                self.plan(false)
            }
            m => m,
        };
        // The keeper executable next to this one (#440). A debug build always runs it in its own
        // executable: `tauri dev` does not rebuild `centralu-keeper`, so the one beside it may be
        // older code (keeper::exe).
        let mut copy = None;
        let (exe, in_process) = match mode {
            // From the copy of what this window carries, so that nothing long-lived runs from
            // the AppImage's mount (FI4); no keeper answers, so a stale copy may be replaced.
            // Without a copy, from beside this executable as before.
            StartMode::Keeper => match self.carried(true) {
                Some(dir) => {
                    let exe = dir.join(keeper_exe::KEEPER_EXE);
                    copy = Some(dir);
                    (exe, false)
                }
                None => (keeper_exe::beside(&me), false),
            },
            StartMode::KeeperInProcess => (me.clone(), true),
            // KeeperBeside, and a mode that never reaches here (Direct, Attach)
            _ => (keeper_exe::beside(&me), false),
        };
        // Until #461 the window's own executable ran the keeper when none was beside it
        if !in_process && !exe.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                format!("this bundle has no {} beside {}; reinstall Centralu", keeper_exe::KEEPER_EXE, me.display()),
            ));
        }
        let mut start = self.keeper_start(in_process);
        if let Some(dir) = copy {
            start.host_source = Some(dir.join(crate::keeper::content::HOST_DIR));
        }
        client::launch_detached(&exe, &start.args(), &start.env(), &start.log_path())
    }

    /**
     * Copies the keeper beside this executable and the bundled host into
     * `<data>/content/<version>/` (`keeper::carried`), for `StartMode::Keeper`. `replace`: no
     * keeper runs, so a copy there that is damaged or of another build may be replaced. `None`
     * when there is nothing to copy or the copy was refused; the reason is logged and the window
     * goes on as before the copy existed.
     */
    fn carried(&self, replace: bool) -> Option<PathBuf> {
        let me = std::env::current_exe().ok()?;
        let host = self.host_dir.as_deref()?;
        let keeper = keeper_exe::beside(&me);
        let what = crate::keeper::carried::Carried { keeper: &keeper, host, version: env!("CARGO_PKG_VERSION") };
        match crate::keeper::carried::place(&self.data, &what, replace, &|m: &str| eprintln!("[keeper] {m}")) {
            Ok(dir) => Some(dir),
            Err(r) => {
                eprintln!("[keeper] not running the keeper from a copy: {r}");
                None
            }
        }
    }

    /**
     * Asks the shell to start the keeper (macOS release builds, `crate::shell`). True when it did,
     * or a keeper answered meanwhile; false when the window should start one directly, which it
     * then does for the rest of its life. The reason is kept for `HostBuild.shell`, shown or only
     * logged as `Report::notify` says.
     */
    fn through_shell(&self, allow_unpinned: bool) -> bool {
        let Some(resources) = &self.resources else { return false };
        let world = crate::shell::Real::new(&self.data);
        let Some(report) = crate::shell::start_keeper(resources, &self.data, self.app_build.bundle_path.clone(), allow_unpinned, &world)
        else {
            return true;
        };
        let started = report.started;
        // Read before the report is stored: finding out why can take a moment (it hashes the content)
        let refusal = self.shell_refusal(resources, &report);
        if let Ok(mut st) = self.state.lock() {
            st.shell_off |= !started;
            st.shell = Some(report);
            st.announcer.shell_refused(refusal);
        }
        started
    }

    /**
     * The shell refused this window's content: a refusal to show in a native window (#634), when it is one about
     * verification and a release says so (`notify`). The shell's status carries a sentence and no hashes, and the
     * shell cannot change without asking every person for their permissions again, so the window reads its own
     * content again (`keeper::content::diagnose`: reads and hashes, starts nothing) to say which file or check failed.
     */
    fn shell_refusal(&self, resources: &std::path::Path, report: &crate::shell::Report) -> Option<crate::refusal::Refusal> {
        if report.started || !report.notify {
            return None;
        }
        let reason = report.reason.as_deref()?;
        let found = (reason == "content")
            .then(|| crate::keeper::content::diagnose(&self.data, &resources.join("content")))
            .flatten()
            .and_then(|r| Some(crate::refusal::Found { check: r.check?.to_string(), file: r.file, hashes: r.hashes, message: r.message }));
        crate::refusal::Refusal::from_shell(reason, report.message.as_deref().unwrap_or(""), found, env!("CARGO_PKG_VERSION"))
    }

    /**
     * Shows each new refusal of signed content in a native window, drawn here and not by the web UI that the host feeds:
     * the shell's refusal of this window's content, and the keeper's of a new build's (`swap.refused`). Each is shown
     * once. Shows only: nothing it names is run, trusted or unlocked. Thread-safe to call from any view.
     */
    fn announce_refusals(&self, app: &AppHandle) {
        let (refusal, open) = {
            let Ok(mut st) = self.state.lock() else { return };
            // Only a refusal of this window's own build, and only of a switch this window sent (`Announcer::we_asked`): the
            // keeper keeps the last swap's view for a window that attaches later, and any process of the user can ask it for
            // a switch of its own
            let seen = st.view.as_ref().and_then(|v| v.swap.as_ref()).filter(|s| s.is_to(&self.app_build)).map(|s| {
                let ended = matches!(s.phase, crate::keeper::swap::Phase::Done | crate::keeper::swap::Phase::Failed);
                // The version is this window's own, not whatever the request that asked for the switch said
                let refusal = crate::refusal::Refusal::from_swap(
                    s.refused.as_deref().filter(|_| s.phase == crate::keeper::swap::Phase::Failed),
                    s.refused_check.as_deref(),
                    s.refused_file.as_deref(),
                    s.refused_hashes.as_ref(),
                    s.message.as_deref(),
                    Some(env!("CARGO_PKG_VERSION")),
                    s.from.as_ref().and_then(|b| b.version.as_deref()),
                );
                crate::refusal::SwapSeen { started_at: s.started_at, ended, refusal }
            });
            st.announcer.view(seen);
            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            (st.announcer.next(now_ms), st.announcer.open_flag())
        };
        if let Some(r) = refusal {
            // The full sentence the shell or the keeper gave is for the log; the dialog is built from the check, the file,
            // the hashes and this window's version only
            // One line in the log, whatever the sentence holds (it is another process's text)
            let sentence: String = r.message.chars().map(|c| if c.is_control() { ' ' } else { c }).take(2_000).collect();
            crate::shell::log(&self.data, &format!("showing why signed content was refused ({}): {sentence}", r.reason));
            crate::refusal::show(app, crate::refusal::dialog(&r), crate::keeper::log_path(&self.data), open);
        }
    }

    /// How this window starts a keeper (and, in the same words, how the shell does: `keeper::exe::Start`).
    fn keeper_start(&self, in_process: bool) -> keeper_exe::Start {
        keeper_exe::Start {
            data_dir: self.data.clone(),
            host_source: self.host_dir.clone(),
            bundle_path: self.app_build.bundle_path.clone(),
            app_version: env!("CARGO_PKG_VERSION").into(),
            dev: self.dev,
            in_process,
        }
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
        let mode = self.plan(client::alive(&self.sock));
        if mode != StartMode::Attach {
            self.launch_keeper(mode).map_err(|e| format!("could not launch the keeper: {e}"))?;
            // The shell may have refused the content on the way: said now, not only once a keeper has attached
            self.announce_refusals(app);
            client::wait_alive(&self.sock, Duration::from_secs(25))?;
        }
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
            st.told = None;
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
            // Compared with what the UI was last told, whole: a field added to `HostBuild` is noticed
            // without being named here, and so is a change made between views (`shell`, `relaunched`).
            let after = self.build_of(&st);
            let news = is_news(st.told.as_ref(), &status, &after);
            if news {
                st.told = Some((status.clone(), after.clone()));
            }
            news.then_some(after)
        };
        if let Some(build) = changed {
            emit(app, &status);
            let _ = app.emit("host-build", build);
        }
        // Whether or not the UI heard of it: a refusal is shown by this process itself
        self.announce_refusals(app);
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
        client::restart_host(&self.sock).unwrap_or(false)
    }

    /// Switches to this window's build. The keeper is handed this build's keeper executable, inside
    /// its bundle (#440), so that a keeper of another build first hands itself over to this build's
    /// keeper (#280 step 4): the program the bundle shipped, never a copy (#220). A keeper older than
    /// step 4 ignores the field and swaps only the host; the window then offers "Restart
    /// completely" for it (`keeper_same_build`).
    pub fn switch_build(&self) -> Result<(), String> {
        let mut exe = std::env::current_exe().ok().map(|me| keeper_exe::beside(&me));
        let mut source = self.app_build.clone();
        // A Linux window names its copy, not its AppImage's mount, which goes when it quits
        // (FI4). A keeper answers and may run from that version's folder: never replaced here.
        if self.plan(false) == StartMode::Keeper {
            if let Some(dir) = self.carried(false) {
                let host = dir.join(crate::keeper::content::HOST_DIR);
                exe = Some(dir.join(keeper_exe::KEEPER_EXE));
                source.host_dir = Some(host.to_string_lossy().to_string());
            }
        }
        // Noted before the request: a refusal is shown only for a switch this window sent (`Announcer`)
        let at = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        if let Ok(mut st) = self.state.lock() {
            st.announcer.we_asked(at);
        }
        let sent = client::switch(&self.sock, &source, exe.as_deref().filter(|_| !self.dev));
        if sent.is_err() {
            if let Ok(mut st) = self.state.lock() {
                st.announcer.we_were_refused();
            }
        }
        sent
    }

    pub fn background(&self) -> Result<bool, String> {
        client::background(&self.sock)
    }

    pub fn set_background(&self, on: bool) -> Result<bool, String> {
        client::set_background(&self.sock, on)
    }

    pub fn stop(&self) -> Result<(), String> {
        if let Ok(mut st) = self.state.lock() {
            st.shutting_down = true;
        }
        client::stop(&self.sock)
    }

    /// Stops the keeper and everything it holds, like `stop`, but stays: the attach loop (`run`)
    /// sees the connection end when the keeper has exited, and starts a keeper from this
    /// window's own executable, with this window's host. The keeper removes its socket before it
    /// stops anything, so nothing reaches it on its way out, and the next one waits for its lock.
    pub fn restart_keeper(&self) -> Result<(), String> {
        client::stop(&self.sock)
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
