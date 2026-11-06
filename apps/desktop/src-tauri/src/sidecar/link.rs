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

/**
 * "Apply now" with a keeper (#1895 step 3). A keeper that stops for an update (`stops_for_update`) stops the host that way and
 * exits, and the relaunched window starts the new build's. An older keeper holds the host through the relaunch and the
 * relaunched window switches it, which stops the host for an update too unless that host hands its agents to the keeper
 * (`keepsAgents`). Either way the keeper reports when the host is busy, so the automatic mode can still wait for idle.
 */
pub(crate) fn with_keeper(info: RelaunchInfo, keeps_agents: Option<bool>, stops_for_update: bool) -> RelaunchInfo {
    let restarts_host = stops_for_update || keeps_agents != Some(true);
    RelaunchInfo { restarts_host, keeps_agents: !restarts_host, idle_reported: true, ..info }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #1895 step 3: "Apply now" restarts the host unless an older keeper's host hands its agents over, and the update line must say so
    #[test]
    fn apply_now_with_a_keeper_restarts_the_host_unless_an_older_one_keeps_its_agents() {
        let ready = RelaunchInfo { ready: true, ..Default::default() };
        let held = with_keeper(ready.clone(), Some(true), false);
        assert!(!held.restarts_host && held.keeps_agents, "an older keeper whose host hands its agents over: they keep going");
        for (keeps, stops_for_update) in [(Some(true), true), (Some(false), true), (None, true), (Some(false), false), (None, false)] {
            let stops = with_keeper(ready.clone(), keeps, stops_for_update);
            assert!(stops.restarts_host && !stops.keeps_agents, "{keeps:?} {stops_for_update}: the update stops the host");
            assert!(stops.idle_reported && stops.ready);
        }
    }

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

/// How long "Quit completely" waits for a keeper on its way out (a stop for an update under way, or a switch that stops
/// instead): the host's wait and its grace after TERM, the children's grace, and a margin for the keeper's exit
const QUIT_WAITS_FOR_THE_UPDATE_STOP: Duration = crate::host_proc::STOP_FOR_UPDATE_WAIT
    .saturating_add(crate::host_proc::STOP_GRACE)
    .saturating_add(centralu_keeper_core::keeper::children::STOP_GRACE)
    .saturating_add(Duration::from_secs(20));

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
    /// "Apply now" is waiting for the keeper to stop for an update (`stop_for_update`), which takes up to 25 s
    stopping_for_update: bool,
    /// "Quit completely" came during that stop: it waited for it to end, and the relaunch does not happen
    quit_after_stop: bool,
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
    /// This app's version, read at run time from the bundle's configuration (`package_info()`): git holds
    /// none, and the release stamps it into `tauri.conf.json` (#1501). The keeper is told it (`--app-version`).
    app_version: String,
    state: Mutex<LinkState>,
}

impl KeeperLink {
    pub fn new(facts: Facts, bundled: Option<PathBuf>, resources: Option<PathBuf>, app_version: String) -> Self {
        let plan = start_plan::plan(&facts);
        // A debug build opted into the keeper runs the source host and uses the dev data
        // folder, like its direct path.
        let dev = plan.dev;
        let host_dir = match plan.host {
            Some(Host::Named) => std::env::var(start_plan::KEEPER_HOST_SOURCE_ENV).ok().map(PathBuf::from),
            Some(Host::Bundle) => bundled,
            _ => None,
        };
        let app_build = super::relaunch::app_build(host_dir.as_deref(), &app_version);
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
            app_version,
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
        let keeps_agents = self.state.lock().ok().and_then(|st| st.view.as_ref().and_then(|v| v.keeps_agents));
        let info = super::relaunch::relaunch_info(&self.app_build, self.host_dir.as_deref().filter(|_| !self.dev));
        with_keeper(info, keeps_agents, self.stops_for_update())
    }

    /// Whether the keeper stops for an update and exits, as a keeper of #1895 step 3 says in its view
    pub fn stops_for_update(&self) -> bool {
        self.state.lock().ok().and_then(|st| st.view.as_ref().map(|v| v.stops_for_update)).unwrap_or(false)
    }

    /// "Apply now" (#1895 step 3): the keeper stops the host for an update and exits, and this window stops attaching, so it
    /// starts no keeper of its own build behind the relaunch. Returns once the keeper is gone. Err, in words that follow "Not
    /// relaunched:", when the keeper refused (it stopped nothing, and this window attaches on as before) or a quit came
    /// meanwhile (`stop`: the relaunch must not undo it).
    pub fn stop_for_update(&self) -> Result<(), String> {
        let keeper_pid = self.state.lock().ok().and_then(|st| st.view.as_ref().map(|v| v.keeper.pid));
        if let Ok(mut st) = self.state.lock() {
            st.shutting_down = true;
            st.stopping_for_update = true;
        }
        let asked = client::stop_for_update(&self.sock);
        let refused = match &asked {
            Ok(_) => None,
            // Refused, and still answering: it stopped nothing
            Err(e) if client::alive(&self.sock) => Some(e.clone()),
            // No answer, but its socket is gone: it is on its way out (it removes the socket first), so the relaunch goes on
            // once it has, rather than leave this window with neither a keeper nor a host
            Err(e) => {
                eprintln!("[window] the keeper did not answer the stop for an update ({e}); relaunching once it has exited");
                None
            }
        };
        // It answers just before it exits: the next keeper waits for its lock, but the relaunch need not race it
        if let (Some(pid), None) = (keeper_pid, &refused) {
            let wait = if asked.is_ok() { Duration::from_secs(5) } else { crate::host_proc::STOP_FOR_UPDATE_WAIT };
            crate::host_proc::wait_until(wait, || !centralu_keeper_core::os::pid_alive(pid));
        }
        let quit = {
            let Ok(mut st) = self.state.lock() else { return Err("the window's state is unreadable".into()) };
            st.stopping_for_update = false;
            if refused.is_some() && !st.quit_after_stop {
                st.shutting_down = false;
            }
            st.quit_after_stop
        };
        if quit {
            return Err("Centralu is quitting".into());
        }
        match refused {
            Some(e) => Err(format!("{e}; nothing was stopped")),
            None => Ok(()),
        }
    }

    /// The system is ending (macOS), or is not after all: the keeper tells the host on its stdin (#1970)
    pub fn system_ending(&self, cancelled: bool) -> Result<(), String> {
        client::system_ending(&self.sock, cancelled)
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
        let what = crate::keeper::carried::Carried { keeper: &keeper, host, version: &self.app_version };
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
        crate::refusal::Refusal::from_shell(reason, report.message.as_deref().unwrap_or(""), found, &self.app_version)
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
                    Some(self.app_version.as_str()),
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
            app_version: self.app_version.clone(),
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
        // A keeper that did not take this window for one (#1405, keeper/window_peer.rs) hands it the limited credential:
        // the window still works for everything everyday, and the log says why the rest is refused
        static SAID: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
        if view.rights.as_deref() == Some("limited") && matches!(status, HostStatus::Ready(_)) && !SAID.swap(true, std::sync::atomic::Ordering::Relaxed) {
            eprintln!("[window] the keeper gave this window the limited credential: it did not recognise this executable as a Centralu window");
        }
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
        let (mid_update, keeper_pid) = match self.state.lock() {
            Ok(mut st) => {
                st.shutting_down = true;
                st.quit_after_stop |= st.stopping_for_update;
                (st.stopping_for_update, st.view.as_ref().map(|v| v.keeper.pid))
            }
            Err(_) => (false, None),
        };
        if mid_update {
            // "Quit completely" while "Apply now" has the keeper stopping for an update, its socket already gone: the quit
            // waits for that stop to end, and `stop_for_update` then calls the relaunch off
            crate::host_proc::wait_until(QUIT_WAITS_FOR_THE_UPDATE_STOP, || self.state.lock().map(|s| !s.stopping_for_update).unwrap_or(true));
            // A keeper that refused that stop is still there, and this quit stops it
            if !client::alive(&self.sock) {
                return Ok(());
            }
        }
        let alive = |pid: u32| centralu_keeper_core::os::pid_alive(pid);
        let stopped = match client::stop(&self.sock) {
            // No answer, its socket gone, and the keeper still running: it is on its way out (a switch that stops for an update
            // instead of handing over removes the socket first, `handoff::give`), so the quit waits for it rather than fail
            Err(e) if !self.sock.exists() && keeper_pid.is_some_and(alive) => {
                let pid = keeper_pid.unwrap_or_default();
                crate::host_proc::wait_until(QUIT_WAITS_FOR_THE_UPDATE_STOP, || !alive(pid));
                if alive(pid) { Err(e) } else { Ok(()) }
            }
            other => other,
        };
        // A quit that failed leaves the window open, attaching on as before, and a later "Apply now" relaunching
        if stopped.is_err() {
            if let Ok(mut st) = self.state.lock() {
                st.shutting_down = false;
                st.quit_after_stop = false;
            }
        }
        stopped
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

/// "Apply now" against a keeper of #1895 step 3, with a stand-in keeper on a socket: what the window does when the keeper
/// refuses the stop for an update, does not answer it, or a quit comes while it runs
#[cfg(test)]
mod update_stop_tests {
    use super::*;
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixListener;
    use std::path::Path;

    /// How the stand-in keeper takes `stop {forUpdate}`
    #[derive(Clone, Copy)]
    enum Takes {
        /// Refuses it and answers on, as a keeper mid-switch does
        Refuses,
        /// Removes its socket and closes the connection without a word, as a keeper that went down mid-stop
        Vanishes,
        /// Removes its socket, takes `secs` to stop the host, then answers
        StopsIn(u64),
    }

    /// A stand-in keeper at `dir/keeper.sock`, with background mode on. Every op it was sent is pushed to `ops`
    fn stand_in_keeper(dir: &Path, takes: Takes, ops: Arc<Mutex<Vec<String>>>) -> PathBuf {
        let sock = dir.join("keeper.sock");
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock).unwrap();
        let path = sock.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { return };
                let mut line = String::new();
                if BufReader::new(s.try_clone().unwrap()).read_line(&mut line).is_err() {
                    continue;
                }
                let req: Value = serde_json::from_str(&line).unwrap_or_default();
                let op = req["op"].as_str().unwrap_or("").to_string();
                let for_update = req["forUpdate"] == serde_json::json!(true);
                ops.lock().unwrap().push(if for_update { "stop forUpdate".into() } else { op.clone() });
                let answer = match (op.as_str(), for_update, takes) {
                    ("stop", true, Takes::Refuses) => serde_json::json!({ "ok": false, "error": "a build switch is under way; apply the update once it has ended" }),
                    ("stop", true, Takes::Vanishes) => {
                        let _ = std::fs::remove_file(&path);
                        return;
                    }
                    ("stop", true, Takes::StopsIn(secs)) => {
                        let _ = std::fs::remove_file(&path);
                        std::thread::sleep(Duration::from_secs(secs));
                        let _ = s.write_all(b"{\"ok\":true}\n");
                        return;
                    }
                    ("settings", ..) => serde_json::json!({ "ok": true, "background": true }),
                    _ => serde_json::json!({ "ok": true }),
                };
                let _ = s.write_all(format!("{answer}\n").as_bytes());
            }
        });
        sock
    }

    /// A window's link to the keeper at `sock`, whose view says it stops for an update. Its pid is one that has exited
    fn link_to(sock: &Path) -> KeeperLink {
        let mut gone = std::process::Command::new("/usr/bin/true").spawn().unwrap();
        let _ = gone.wait();
        let view: KeeperView = serde_json::from_value(serde_json::json!({
            "keeper": { "pid": gone.id(), "protocol": 1, "version": "0.0.0", "startedAt": 0, "dataDir": "/tmp" },
            "status": { "state": "ready", "port": 1, "token": "t" },
            "background": true, "attached": 1, "busy": false, "stopsForUpdate": true,
        }))
        .unwrap();
        let mut link = KeeperLink::new(Facts::window(Env::current(), true, false), None, None, "0.0.0".into());
        link.sock = sock.to_path_buf();
        link.state.lock().unwrap().view = Some(view);
        link
    }

    fn scratch(name: &str) -> PathBuf {
        let dir = PathBuf::from(format!("/tmp/ccw-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Refused while the keeper still answers: nothing was stopped, the window says why and goes on attaching as before
    #[test]
    fn a_refused_stop_for_an_update_keeps_the_window_attached_and_says_why() {
        let dir = scratch("refused");
        let sock = stand_in_keeper(&dir, Takes::Refuses, Arc::default());
        let link = link_to(&sock);
        let e = link.stop_for_update().unwrap_err();
        assert!(e.contains("a build switch is under way") && e.contains("nothing was stopped"), "{e}");
        assert!(!link.shutting_down(), "the window stopped attaching to a keeper that is still there");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// No answer, and the socket is gone: the keeper is on its way out, so the relaunch goes on rather than leave the window
    /// with neither a keeper nor a host
    #[test]
    fn a_stop_for_an_update_with_no_answer_and_no_socket_goes_on_to_the_relaunch() {
        let dir = scratch("vanished");
        let sock = stand_in_keeper(&dir, Takes::Vanishes, Arc::default());
        let link = link_to(&sock);
        assert_eq!(link.stop_for_update(), Ok(()));
        assert!(link.shutting_down(), "the window would start a keeper of its own build behind the relaunch");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * Review of #1895 step 3: with background mode on, a refused stop for an update fell through to the relaunch (the check
     * meant for an older keeper that cannot hold on), so the relaunched window found the same keeper and nothing applied.
     * And the refusal said "With background mode off the running agents would stop", whatever the keeper's reason was.
     */
    #[test]
    fn apply_now_refused_by_the_keeper_does_not_relaunch_even_with_background_mode_on() {
        let dir = scratch("apply");
        let ops = Arc::new(Mutex::new(Vec::new()));
        let sock = stand_in_keeper(&dir, Takes::Refuses, ops.clone());
        let sup = Supervisor::default();
        *sup.inner.lock().unwrap() = Choice::Keeper;
        *sup.keeper.lock().unwrap() = Some(Arc::new(link_to(&sock)));
        let e = sup.before_relaunch().unwrap_err();
        assert!(e.starts_with("Not relaunched: a build switch is under way"), "{e}");
        assert!(!e.contains("background mode"), "{e}");
        assert!(!ops.lock().unwrap().iter().any(|op| op == "relaunching"), "an older keeper's path was taken too: {:?}", ops.lock().unwrap());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * Review of #1895 step 3: a switch whose keeper stops for an update instead of handing over removes its socket and runs
     * on for up to the stop's bound, with no stop for an update of this window's under way. "Quit completely" then found no
     * socket and failed, and the window, already marked shutting down, never attached again.
     */
    #[test]
    fn a_quit_while_the_keeper_is_on_its_way_out_waits_for_it_to_exit() {
        let dir = scratch("leaving");
        let link = link_to(&dir.join("keeper.sock"));
        let mut leaving = std::process::Command::new("/bin/sleep").arg("1").spawn().unwrap();
        link.state.lock().unwrap().view.as_mut().unwrap().keeper.pid = leaving.id();
        // Reaped as it ends, so its pid reads as gone
        let reaper = std::thread::spawn(move || leaving.wait());
        let asked_at = Instant::now();
        assert_eq!(link.stop(), Ok(()), "the quit failed");
        assert!(asked_at.elapsed() >= Duration::from_millis(500), "the quit did not wait for the keeper to exit");
        let _ = reaper.join();
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A quit that fails leaves the window open: it attaches on, rather than sit with no keeper until the app restarts
    #[test]
    fn a_quit_that_fails_leaves_the_window_attaching() {
        let dir = scratch("unreachable");
        let link = link_to(&dir.join("keeper.sock"));
        assert!(link.stop().is_err());
        assert!(!link.shutting_down(), "the window stopped attaching after a quit that did not happen");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * Review of #1895 step 3: "Quit completely" while the keeper stops for an update found its socket gone and failed, and the
     * relaunch went ahead. The quit now waits for that stop to end, sends nothing to a keeper already gone, and the relaunch
     * is called off.
     */
    #[test]
    fn a_quit_during_the_stop_for_an_update_waits_for_it_and_calls_the_relaunch_off() {
        let dir = scratch("quit");
        let ops = Arc::new(Mutex::new(Vec::new()));
        let sock = stand_in_keeper(&dir, Takes::StopsIn(1), ops.clone());
        let link = Arc::new(link_to(&sock));
        let applying = {
            let link = link.clone();
            std::thread::spawn(move || link.stop_for_update())
        };
        crate::host_proc::wait_until(Duration::from_secs(5), || ops.lock().unwrap().iter().any(|op| op == "stop forUpdate"));
        let asked_at = Instant::now();
        assert_eq!(link.stop(), Ok(()), "the quit failed");
        let waited = asked_at.elapsed();
        let applied = applying.join().unwrap();
        assert_eq!(applied, Err("Centralu is quitting".into()), "the relaunch would go on after the quit");
        assert!(waited >= Duration::from_millis(500), "the quit did not wait for the stop: {waited:?}");
        assert_eq!(ops.lock().unwrap().iter().filter(|op| *op == "stop").count(), 0, "a plain stop went to a keeper on its way out");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
