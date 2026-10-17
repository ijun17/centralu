//! The app's side of the agent host.
//!
//! Tauri's role here is not a communication relay but **process supervision**
//! (docs/architecture.md §4). It gets the host's port and token to the UI and brings the host
//! back if it dies. The communication itself is done by the UI directly over WS — the reason dev
//! and prod share the same path.
//!
//! Two ways to get there (#280, option C step 1); which one is `start_plan::plan`'s answer, and
//! docs/agent-host.md §4.0 lists it per platform:
//!   - **Keeper**: the app finds or launches the keeper — the `centralu-keeper` executable next to
//!     its own (#440), detached into its own session — and attaches to it over its control socket.
//!     A macOS release first asks the shell to start it (`crate::shell`, thin-shell plan §6): the
//!     shell holds macOS permissions across updates, and when it does not start a keeper the window
//!     starts one itself, as before, and says why. The keeper holds the host, so quitting, crashing
//!     or replacing the app does not end the host unless background mode is off, in which case the
//!     keeper stops it the moment the last window detaches, as quitting always did.
//!   - **Direct**: the app is the host's parent, exactly as before.

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use centralu_keeper_core::start_plan::{self, Env, Facts, Host, Plan};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

pub use crate::host_proc::HostInfo;
use crate::host_proc::{self, HostLaunch, HostStatus, LaunchError, Launcher, StatusSink};

mod launch;
#[cfg(unix)]
mod link;
#[cfg(unix)]
mod relaunch;

use launch::direct_launcher;
#[cfg(unix)]
use relaunch::{bundle_version, relaunch_decision};

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
    /// Whether that swap went to this window's build, by the keeper's rule (`SwapView::is_to`). Absent
    /// without a swap.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub swap_to_this_build: Option<bool>,
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
    /// How the last keeper start this window made went through the macOS shell (thin-shell plan §6):
    /// absent when it never tried (a keeper already answered, debug builds, Linux).
    #[cfg(unix)]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<crate::shell::Report>,
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

/// How this window starts its host: the start plan's answer, and what it needs from the window's
/// resource folder (`Contents/Resources` in the macOS bundle, where the shell and the signed content
/// are carried too).
struct Start {
    plan: Plan,
    #[cfg_attr(not(unix), allow(dead_code))] // only a keeper asks the plan again
    facts: Facts,
    /// The bundled host's folder (F-0), when the plan runs it. A debug build never does, though one
    /// may be there: `tauri dev`'s resource folder is target/debug/, where a release build leaves a
    /// bundled host behind (`Plan::dev`).
    bundled: Option<PathBuf>,
    #[cfg_attr(not(unix), allow(dead_code))]
    resources: Option<PathBuf>,
}

fn start_plan(app: &AppHandle) -> Start {
    let resources = app.path().resource_dir().ok();
    let found = resources.as_ref().map(|d| d.join("resources/host")).filter(|p| p.join("main.mjs").exists());
    let facts = Facts::window(Env::current(), found.is_some());
    let plan = start_plan::plan(&facts);
    Start { bundled: found.filter(|_| !plan.dev), plan, facts, resources }
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
        let start = start_plan(&app);
        #[cfg(unix)]
        if start.plan.mode.keeper() {
            if let Ok(mut c) = self.inner.lock() {
                *c = Choice::Keeper;
            }
            let link = Arc::new(link::KeeperLink::new(start.facts, start.bundled, start.resources));
            if let Ok(mut k) = self.keeper.lock() {
                *k = Some(link.clone());
            }
            link.start(app);
            return;
        }
        if let Ok(mut c) = self.inner.lock() {
            *c = Choice::Direct;
        }
        self.direct.start(Arc::new(TauriSink(app)), direct_launcher(&start));
    }

    /// Retry from the failure screen (#184).
    pub fn restart(&self, app: AppHandle) -> bool {
        match self.choice() {
            #[cfg(unix)]
            Choice::Keeper => self.link().map(|l| l.restart(app)).unwrap_or(false),
            _ => {
                let start = start_plan(&app);
                self.direct.restart(Arc::new(TauriSink(app)), direct_launcher(&start))
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




#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_direct_path_stays_the_default_for_debug_builds() {
        // `pnpm app:dev` must keep running the host as the app's own child, unchanged.
        if cfg!(debug_assertions) && std::env::var("CC_USE_KEEPER").is_err() && std::env::var("CC_HOST_CMD").is_err() {
            assert!(!start_plan::plan(&Facts::window(Env::current(), true)).mode.keeper());
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
