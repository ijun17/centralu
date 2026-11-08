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

/// Why "Apply now" is not offered with a keeper that cannot stop for an update: one of an earlier build than #1895 step 3, or
/// one that took its host over from another keeper (it does not hold that host's stdin)
pub(crate) const KEEPER_TOO_OLD_TO_UPDATE: &str = "The background keeper cannot stop the agent host for an update (it is of an earlier build, or took the host over from one). Restart it from the bar at the top, or quit Centralu completely and open it again.";

/// Why "Apply now" waits while the keeper's host is starting, restarting or failed: the keeper says it can stop a host for an
/// update only once that host has said so at its start
pub(crate) const HOST_NOT_UP_FOR_UPDATE: &str = "The agent host is not running yet. Try again once it is up.";

/// What the keeper's view says of a stop for an update (#1895 step 4, PR 3 review)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UpdateStop {
    /// No view yet
    Unknown,
    /// The keeper stops its host for an update and exits
    Stops,
    /// Not now: its host is not up, and the keeper knows only from a running host whether it can
    HostNotUp,
    /// It cannot: a keeper of an earlier build, or one that took its host over from one
    Cannot,
}

impl UpdateStop {
    pub(crate) fn of(view: Option<&KeeperView>) -> UpdateStop {
        match view {
            None => UpdateStop::Unknown,
            Some(v) if v.stops_for_update => UpdateStop::Stops,
            Some(v) if !matches!(v.status, HostStatus::Ready(_)) => UpdateStop::HostNotUp,
            Some(_) => UpdateStop::Cannot,
        }
    }

    /// Why "Apply now" is not offered, or None when it is
    pub(crate) fn refusal(self) -> Option<&'static str> {
        match self {
            UpdateStop::Stops => None,
            UpdateStop::Unknown => Some("not attached to the background keeper yet"),
            UpdateStop::HostNotUp => Some(HOST_NOT_UP_FOR_UPDATE),
            UpdateStop::Cannot => Some(KEEPER_TOO_OLD_TO_UPDATE),
        }
    }
}

/**
 * "Apply now" with a keeper (#1895 step 4, PR 3): the keeper stops the host for an update and exits, and the relaunched window
 * starts the new build's (`stops_for_update`, what `before_relaunch` asks). The keeper reports when the host is busy, so the
 * automatic mode waits for idle and applies by itself. A keeper of an earlier build than step 3 cannot stop that way, and no
 * window switches one any more: not offered, the build bar's restart into this build comes first. While the keeper's host is
 * not up it cannot say, and the reason says to wait rather than to restart the keeper.
 */
pub(crate) fn with_keeper(info: RelaunchInfo, stop: UpdateStop) -> RelaunchInfo {
    match stop.refusal() {
        None => RelaunchInfo { restarts_host: true, idle_reported: true, ..info },
        Some(why) => RelaunchInfo { ready: false, reason: Some(why.into()), ..info },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// #1895 step 4, PR 3: "Apply now" stops the host for an update through the keeper, and only a keeper that can is
    /// offered it: an earlier one would be left holding the old host behind a relaunch nobody switches any more
    #[test]
    fn apply_now_is_offered_only_with_a_keeper_that_stops_for_an_update() {
        let ready = RelaunchInfo { ready: true, ..Default::default() };
        let stops = with_keeper(ready.clone(), UpdateStop::Stops);
        assert!(stops.ready && stops.restarts_host && stops.idle_reported);
        let old = with_keeper(ready.clone(), UpdateStop::Cannot);
        assert!(!old.ready && old.reason.as_deref() == Some(KEEPER_TOO_OLD_TO_UPDATE), "{old:?}");
        assert!(!with_keeper(ready, UpdateStop::Unknown).ready, "no view yet: nothing is known of the keeper");
    }

    /// Review: a keeper's host that is starting, restarting or failed reads "cannot stop for an update" in the view, since
    /// only a running host says it can. "Apply now" waits for it, rather than calling the keeper too old: a keeper of this
    /// build gets no bar to restart it from
    #[test]
    fn apply_now_waits_for_a_host_that_is_not_up_rather_than_calling_the_keeper_too_old() {
        let view = |status: HostStatus, stops_for_update: bool| KeeperView {
            keeper: crate::keeper::KeeperInfo { pid: 1, protocol: 1, version: "0.0.0".into(), started_at: 0, data_dir: String::new(), build: None },
            status,
            host_pid: None,
            source: None,
            background: false,
            attached: 1,
            busy: false,
            rights: None,
            stops_for_update,
        };
        assert_eq!(UpdateStop::of(None), UpdateStop::Unknown);
        for status in [HostStatus::Starting, HostStatus::Restarting { attempt: 1 }, HostStatus::Failed { message: "x".into() }] {
            assert_eq!(UpdateStop::of(Some(&view(status, false))), UpdateStop::HostNotUp);
        }
        let ready = HostStatus::Ready(HostInfo { port: 1, token: String::new() });
        assert_eq!(UpdateStop::of(Some(&view(ready.clone(), false))), UpdateStop::Cannot);
        assert_eq!(UpdateStop::of(Some(&view(ready, true))), UpdateStop::Stops);
        assert_eq!(UpdateStop::HostNotUp.refusal(), Some(HOST_NOT_UP_FOR_UPDATE));
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
            HostBuild { stops_for_update: Some(true), ..build.clone() },
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

/// How long a keeper this window launched gets to answer. It waits for the data folder's lock first, which a keeper on its way
/// out holds until it exits: after a restart into this build that stops a keeper of another build for an update, up to about
/// 25 s (the host's 15 s, its 3 s after TERM, and up to 6 s for the children an earlier keeper held). Then its own start
const KEEPER_ANSWERS_WITHIN: Duration = Duration::from_secs(40);

/// What "Quit completely" says while the keeper stops for an update ("Apply now", or a restart into this build): that stop leaves the turns it cut listed for the next start, so a quit now could not end them as a quit does
const QUIT_DURING_AN_UPDATE_STOP: &str = "Centralu is stopping for an update; quit again once it has relaunched";

#[derive(Default)]
struct LinkState {
    info: Option<HostInfo>,
    error: Option<String>,
    view: Option<KeeperView>,
    /// The status and the build the UI was last told from a view (`on_view`). None until the first
    /// view of an attachment: losing the keeper ends with `Restarting` or `Failed`, sent past this.
    told: Option<(HostStatus, HostBuild)>,
    same_build: Option<bool>,
    attached: Option<client::Attached>,
    running: bool,
    shutting_down: bool,
    /// "Apply now" is waiting for the keeper to stop for an update (`stop_for_update`), which takes up to about 25 s (`KEEPER_ANSWERS_WITHIN`); a quit is refused meanwhile
    stopping_for_update: bool,
    /// The last start through the shell, for `HostBuild.shell`.
    shell: Option<crate::shell::Report>,
    /// The shell did not start a keeper once: every later start in this window's life is direct.
    shell_off: bool,
    /// What is shown of the shell's refusal of this window's signed content, and when (`refusal::Announcer`).
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
            stops_for_update: st.view.as_ref().map(|v| v.stops_for_update),
            busy: st.view.as_ref().map(|v| v.busy),
            shell: st.shell.clone(),
        }
    }

    /// What "Apply now" would start (#352): Tauri's restart runs this window's own executable
    /// path again, inside the same bundle. `centralu install` replaced that bundle (`swapInto`
    /// in `swap.mjs`: the new one renamed in, the old one aside and deleted), so the path now names the new build — unless this window runs from a
    /// bundle the update did not touch (`pnpm app:open` opens the build output in place) or from
    /// no bundle at all (`pnpm app:dev`).
    pub fn relaunch_info(&self) -> RelaunchInfo {
        let info = super::relaunch::relaunch_info(&self.app_build, self.host_dir.as_deref().filter(|_| !self.dev));
        with_keeper(info, self.update_stop())
    }

    /// What the keeper's view says of a stop for an update, for "Apply now"
    pub(crate) fn update_stop(&self) -> UpdateStop {
        self.state.lock().map(|st| UpdateStop::of(st.view.as_ref())).unwrap_or(UpdateStop::Unknown)
    }

    /// Whether the keeper stops for an update and exits, as a keeper of #1895 step 3 or later says in its view. None before a view
    pub fn stops_for_update(&self) -> Option<bool> {
        self.state.lock().ok().and_then(|st| st.view.as_ref().map(|v| v.stops_for_update))
    }

    /// "Apply now" (#1895 step 3): the keeper stops the host for an update and exits, and this window stops attaching, so it
    /// starts no keeper of its own build behind the relaunch. Returns once the keeper is gone. Err, in words that follow "Not
    /// relaunched:", when the keeper refused (it stopped nothing, and this window attaches on as before). A quit meanwhile is
    /// refused (`stop`)
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
        {
            let Ok(mut st) = self.state.lock() else { return Err("the window's state is unreadable".into()) };
            st.stopping_for_update = false;
            if refused.is_some() {
                st.shutting_down = false;
            }
        };
        match refused {
            Some(e) => Err(format!("{e}; nothing was stopped")),
            None => Ok(()),
        }
    }

    /// The system is ending (macOS), or is not after all: the keeper tells the host on its stdin (#1970)
    pub fn system_ending(&self, cancelled: bool) -> Result<(), String> {
        client::system_ending(&self.sock, cancelled)
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
        let (exe, in_process) = match mode {
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
        let start = self.keeper_start(in_process);
        client::launch_detached(&exe, &start.args(), &start.env(), &start.log_path())
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
     * Shows a new refusal of this window's signed content by the shell in a native window, drawn here and not by the web UI
     * that the host feeds, once. Shows only: nothing it names is run, trusted or unlocked. Thread-safe to call from any view.
     */
    fn announce_refusals(&self, app: &AppHandle) {
        let (refusal, open) = {
            let Ok(mut st) = self.state.lock() else { return };
            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
            (st.announcer.next(now_ms), st.announcer.open_flag())
        };
        if let Some(r) = refusal {
            // The full sentence the shell gave is for the log; the dialog is built from the check, the file, the hashes and
            // this window's version only
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
            client::wait_alive(&self.sock, KEEPER_ANSWERS_WITHIN)?;
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
            // without being named here, and so is a change made between views (`shell`).
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

    pub fn background(&self) -> Result<bool, String> {
        client::background(&self.sock)
    }

    pub fn set_background(&self, on: bool) -> Result<bool, String> {
        client::set_background(&self.sock, on)
    }

    /**
     * "Quit completely". Refused while the keeper stops for an update: "Apply now" asked it (`stop_for_update`), or a restart
     * into this build did (`restart_keeper`: its socket gone, its process still running). That stop lists the
     * turns it cut for the next start and leaves no quit mark, so a quit could only end as it; the person quits again in the
     * relaunched window. A keeper already gone leaves nothing to stop. Any other failure leaves the window attaching.
     */
    pub fn stop(&self) -> Result<(), String> {
        {
            let Ok(mut st) = self.state.lock() else { return Err("the window's state is unreadable".into()) };
            let keeper_pid = st.view.as_ref().map(|v| v.keeper.pid);
            let leaving = !self.sock.exists() && keeper_pid.is_some_and(centralu_keeper_core::os::pid_alive);
            if st.stopping_for_update || leaving {
                return Err(QUIT_DURING_AN_UPDATE_STOP.into());
            }
            st.shutting_down = true;
        }
        let stopped = client::stop(&self.sock);
        if stopped.is_err() {
            if !client::alive(&self.sock) {
                return Ok(());
            }
            if let Ok(mut st) = self.state.lock() {
                st.shutting_down = false;
            }
        }
        stopped
    }

    /**
     * The build bar's restart into this build (#1895 step 4, PR 3), for a keeper or host of another build. A keeper that stops for
     * an update is asked to (`stop {forUpdate}`): this window's host continues the turns it cut and opens its terminals and Run
     * commands again, as after "Apply now". An earlier keeper gets a plain stop, which ends what it holds as "Quit completely"
     * does; the bar asks first before any plain stop. Which stop goes is read from the view now, not from the one the bar
     * planned with: a host that went down in between turns a planned stop for an update into a plain stop, which is harmless,
     * since such a keeper holds nothing once its host is gone (review). Either way this window stays: the attach loop (`run`) sees the
     * connection end when the keeper has exited and starts a keeper of this window's build. The keeper removes its socket before
     * it stops anything, so nothing reaches it on its way out, and the next one waits for its lock. Returns once the keeper took
     * the request: a stop for an update answers once its host is gone.
     */
    pub fn restart_keeper(&self) -> Result<(), String> {
        if self.stops_for_update() == Some(true) {
            client::stop_for_update(&self.sock)
        } else {
            client::stop(&self.sock)
        }
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
        /// Refuses it, and a plain stop too, and answers on, as a keeper mid-switch does
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
                    ("stop", false, Takes::Refuses) => serde_json::json!({ "ok": false, "error": "a build switch is under way" }),
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
        let asked: Vec<String> = ops.lock().unwrap().iter().filter(|op| *op != "status").cloned().collect();
        assert_eq!(asked, ["stop forUpdate"], "anything but the one stop for an update was asked");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * Review of #1895 step 3: a keeper stopping for an update that this window's "Apply now" did not ask for (now a restart into
     * this build) removes its socket and runs on for up to the stop's bound, with no `stopping_for_update` of this window's set. "Quit completely" then found no
     * socket and failed with no reason the person could act on, and the window, already marked shutting down, never attached
     * again. It is refused now, saying why, and the window attaches on.
     */
    #[test]
    fn a_quit_while_the_keeper_is_on_its_way_out_is_refused_and_says_why() {
        let dir = scratch("leaving");
        let link = link_to(&dir.join("keeper.sock"));
        let mut leaving = std::process::Command::new("/bin/sleep").arg("30").spawn().unwrap();
        link.state.lock().unwrap().view.as_mut().unwrap().keeper.pid = leaving.id();
        let quit = link.stop();
        let _ = leaving.kill();
        let _ = leaving.wait();
        assert_eq!(quit, Err(QUIT_DURING_AN_UPDATE_STOP.into()));
        assert!(!link.shutting_down(), "the window stopped attaching after a quit that did not happen");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * #1895 step 4, PR 3: the build bar's restart into this build asks a keeper that can for a stop for an update, so this
     * window's host continues the turns, and gives an earlier one the plain stop it understands. The window keeps attaching.
     */
    #[test]
    fn a_restart_into_this_build_stops_the_keeper_for_an_update_when_it_can() {
        for (stops_for_update, sent) in [(true, "stop forUpdate"), (false, "stop")] {
            let dir = scratch(&format!("restart-{stops_for_update}"));
            let ops = Arc::new(Mutex::new(Vec::new()));
            let sock = stand_in_keeper(&dir, Takes::StopsIn(0), ops.clone());
            let link = link_to(&sock);
            link.state.lock().unwrap().view.as_mut().unwrap().stops_for_update = stops_for_update;
            assert_eq!(link.restart_keeper(), Ok(()));
            assert_eq!(*ops.lock().unwrap(), [sent]);
            assert!(!link.shutting_down(), "the window stopped attaching, so no keeper of its build would start");
            let _ = std::fs::remove_dir_all(&dir);
        }
    }

    /// A quit the keeper refuses leaves the window open: it attaches on, rather than sit with no keeper until the app restarts
    #[test]
    fn a_quit_the_keeper_refuses_leaves_the_window_attaching() {
        let dir = scratch("unreachable");
        let sock = stand_in_keeper(&dir, Takes::Refuses, Arc::default());
        let link = link_to(&sock);
        assert!(link.stop().is_err());
        assert!(!link.shutting_down(), "the window stopped attaching after a quit that did not happen");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A keeper already gone (no socket, its process exited) leaves nothing to stop: the quit goes on
    #[test]
    fn a_quit_with_the_keeper_already_gone_goes_on() {
        let dir = scratch("gone");
        let link = link_to(&dir.join("keeper.sock"));
        assert_eq!(link.stop(), Ok(()));
        assert!(link.shutting_down(), "the window would start a keeper behind the quit");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /**
     * Review of #1895 step 3: "Quit completely" while "Apply now" has the keeper stopping for an update could only end as that
     * stop (the turns it cut continue at the next start, and no quit mark is left for a linked hub). It is refused at once,
     * nothing is sent to the keeper, and the relaunch goes on; the person quits in the relaunched window.
     */
    #[test]
    fn a_quit_during_the_stop_for_an_update_is_refused_and_the_relaunch_goes_on() {
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
        assert_eq!(link.stop(), Err(QUIT_DURING_AN_UPDATE_STOP.into()));
        assert!(asked_at.elapsed() < Duration::from_millis(500), "the quit waited for the stop");
        assert_eq!(applying.join().unwrap(), Ok(()), "the relaunch was called off");
        assert!(link.shutting_down(), "the window would start a keeper of its own build behind the relaunch");
        assert_eq!(ops.lock().unwrap().iter().filter(|op| *op == "stop").count(), 0, "a plain stop went to a keeper on its way out");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
