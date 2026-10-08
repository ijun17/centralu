//! How the host starts: one decision, from what a process knows about itself, to one `StartMode`
//! with its reason. docs/agent-host.md §4.0 lists every row this function returns, per platform; the
//! table test below holds those rows.
//!
//! Before this module the decision was spread over `use_keeper()` and `shell_resources()` in the
//! window, the keeper executable's `exec_target`, `debug_assertions` at several sites and five
//! environment variables read where they were used. Now every start site reads its facts
//! (`Facts::window`, `Facts::keeper_flag`), asks `plan`, and does what the answer says.
//!
//! What it does not decide, because each is already its own table-tested decision and is the
//! outcome of an attempt rather than a fact known beforehand:
//!   - what the shell does once it is opened: install or keep (`shell::install::plan` in the window),
//!     whether the carried shell is pinned, and why it refused (`shell::start::start`). The window
//!     tells this plan only whether the shell already failed to start a keeper in its life
//!     (`Shell::FellBack`), after which every start is direct;
//!   - which way a keeper hands itself over (`server::content_route` in the keeper: from verified
//!     content, or to the executable a window names);
//!   - `centralu serve` and the npm launcher, which start the host from Node
//!     (`packaging/npm/centralu/bin/`), listed in the same table.
//!
//! Pure: no environment, no files, no `cfg!`. `Env::current`, `Os::current` and `Build::current` are
//! the only readers of those, and the call sites hand their answers in.

/// The operating system, as far as starting the host goes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    MacOs,
    /// Linux, and any other unix: the keeper compiles there, but only runs when asked for.
    Linux,
    /// Windows, and anything else that is not unix: there is no keeper.
    Windows,
}

impl Os {
    pub fn current() -> Os {
        if cfg!(target_os = "macos") {
            Os::MacOs
        } else if cfg!(unix) {
            Os::Linux
        } else {
            Os::Windows
        }
    }

    /// Whether the release signs the content a keeper runs from here (`<data>/content/<version>/`).
    /// Only macOS's does (`scripts/release-npm.mts`): a Linux window copies the keeper and host its
    /// AppImage carries without a signature to check (runtime-unification plan §8, decision 1).
    pub fn signs_content(self) -> bool {
        self == Os::MacOs
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Build {
    /// `debug_assertions`: `pnpm app:dev`, `cargo run`, the keeper scripts' `cargo build`.
    Debug,
    Release,
}

impl Build {
    pub fn current() -> Build {
        if cfg!(debug_assertions) {
            Build::Debug
        } else {
            Build::Release
        }
    }
}

/// A variable that names something: absent, present but naming nothing usable, or naming something.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Var {
    #[default]
    Unset,
    /// Present, but empty or only whitespace (or, for `CC_KEEPER_HOST_SOURCE`, not unicode).
    Blank,
    Set,
}

/// The environment variables that change how the host starts, as read once.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Env {
    /// `CC_HOST_CMD`: the host's command line, split on whitespace. Any value, even a blank one,
    /// keeps the window the host's parent; only a non-blank one replaces the host it runs.
    pub host_cmd: Var,
    /// `CC_USE_KEEPER=1`: a debug build, or Linux, uses the keeper.
    pub use_keeper: bool,
    /// `CC_KEEPER_HOST_SOURCE`: the host folder a keeper runs (the keeper scripts' way of naming the
    /// repository's freshly bundled host). Any value keeps the window from going through the shell;
    /// only a non-blank one replaces the host.
    pub keeper_host_source: Var,
    /// `CC_SHELL_UNPINNED=1`: open a shell the window carries unpinned anyway (`shell` module docs).
    pub shell_unpinned: bool,
    /// `CC_KEEPER_IN_PROCESS` (any value): set by a debug window on the keeper it starts.
    pub keeper_in_process: bool,
}

/// Names of the variables `Env` reads, for the sites that set them on a child.
pub const HOST_CMD_ENV: &str = "CC_HOST_CMD";
pub const USE_KEEPER_ENV: &str = "CC_USE_KEEPER";
pub const KEEPER_HOST_SOURCE_ENV: &str = "CC_KEEPER_HOST_SOURCE";
pub const SHELL_UNPINNED_ENV: &str = "CC_SHELL_UNPINNED";
pub const KEEPER_IN_PROCESS_ENV: &str = "CC_KEEPER_IN_PROCESS";

impl Env {
    pub fn current() -> Env {
        Env {
            host_cmd: text_var(HOST_CMD_ENV),
            use_keeper: std::env::var(USE_KEEPER_ENV).as_deref() == Ok("1"),
            keeper_host_source: os_var(KEEPER_HOST_SOURCE_ENV),
            shell_unpinned: std::env::var(SHELL_UNPINNED_ENV).as_deref() == Ok("1"),
            keeper_in_process: std::env::var_os(KEEPER_IN_PROCESS_ENV).is_some(),
        }
    }
}

/// A variable read as text: one that is not unicode counts as absent (`std::env::var` errs).
fn text_var(name: &str) -> Var {
    match std::env::var(name) {
        Ok(v) if v.trim().is_empty() => Var::Blank,
        Ok(_) => Var::Set,
        Err(_) => Var::Unset,
    }
}

/// A variable whose presence counts whatever it holds: one that is not unicode is present but blank.
fn os_var(name: &str) -> Var {
    match (std::env::var_os(name), std::env::var(name)) {
        (None, _) => Var::Unset,
        (Some(_), Ok(v)) if !v.trim().is_empty() => Var::Set,
        (Some(_), _) => Var::Blank,
    }
}

/// Which process is deciding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Who {
    /// The window (`centralu`), starting its host or the keeper that holds it.
    Window,
    /// The window's executable started as `centralu --keeper ...`: by a debug window, by a window
    /// whose bundle has no `centralu-keeper`, or by a keeper of 0.1.0-beta.11 or earlier handing
    /// itself over to this build (and a window of before #440 starting its keeper).
    KeeperFlag,
}

/// The shell, as far as this window has seen it (macOS release builds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Shell {
    /// Not opened yet, or it started every keeper so far.
    #[default]
    Untried,
    /// It did not start a keeper once (refused, not carried, unpinned, no report, …): every later
    /// start in this window's life is direct (thin-shell plan §10.2).
    FellBack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Facts {
    pub who: Who,
    pub os: Os,
    pub build: Build,
    pub env: Env,
    /// `resources/host/main.mjs` is in the window's resource folder. A debug build ignores it
    /// (`Plan::dev`).
    pub bundled_host: bool,
    /// A keeper answers on `<data>/keeper.sock`.
    pub keeper_answering: bool,
    pub shell: Shell,
    /// `centralu-keeper` is next to the window's executable (and is not that executable).
    pub keeper_beside: bool,
}

impl Facts {
    /// The window's facts on this platform and build, before it has looked for a keeper.
    pub fn window(env: Env, bundled_host: bool) -> Facts {
        Facts {
            who: Who::Window,
            os: Os::current(),
            build: Build::current(),
            env,
            bundled_host,
            keeper_answering: false,
            shell: Shell::Untried,
            keeper_beside: false,
        }
    }

    /// The facts of `centralu --keeper` on this platform and build.
    pub fn keeper_flag(keeper_in_process: bool, keeper_beside: bool) -> Facts {
        Facts {
            who: Who::KeeperFlag,
            keeper_beside,
            ..Facts::window(Env { keeper_in_process, ..Env::default() }, false)
        }
    }
}

/// Who holds the host, and how that holder is started.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StartMode {
    /// The window is the host's parent; there is no keeper. Quitting stops the host.
    Direct,
    /// A keeper already answers: the window attaches to it and starts nothing.
    Attach,
    /// The window opens the shell through LaunchServices, and the shell starts `centralu-keeper` from
    /// the verified content (`<data>/content/<version>/`), so macOS judges it as the shell.
    ThroughShell {
        /// `CC_SHELL_UNPINNED=1`: open a shell the window carries unpinned anyway.
        allow_unpinned: bool,
    },
    /// The window starts `centralu-keeper` next to its own executable (from the `centralu --keeper`
    /// side: `exec`s into it, same pid, arguments and descriptors).
    KeeperBeside,
    /// The window copies the `centralu-keeper` beside it and its bundled host into
    /// `<data>/content/<version>/` and starts the keeper from the copy, so nothing long-lived runs
    /// from the AppImage's mount (lesson FI4; Linux releases). Not verified: the release signs no
    /// Linux content yet. A copy that fails falls back to `KeeperBeside`.
    Keeper,
    /// The window's own executable runs the keeper (`centralu --keeper`), because no
    /// `centralu-keeper` is beside it: a bundle someone assembled by hand.
    KeeperInWindowExe,
    /// A debug window starts its own executable with `--keeper` and `CC_KEEPER_IN_PROCESS=1`, which
    /// then runs the keeper itself rather than `exec` a `centralu-keeper` that may be older code.
    KeeperInProcess,
}

impl StartMode {
    /// Whether a keeper holds the host.
    pub fn keeper(self) -> bool {
        self != StartMode::Direct
    }
}

/// Which host code the window's build runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Host {
    /// `CC_HOST_CMD`'s command line.
    Command,
    /// The bundled host (`resources/host/main.mjs`) through the system Node; under a keeper, from its
    /// per-build copy or the verified content.
    Bundle,
    /// The folder `CC_KEEPER_HOST_SOURCE` names.
    Named,
    /// The source, through the workspace's tsx, with `CC_DEV=1`.
    Source,
}

/// Why this mode, in a word the table and the tests use, and in words (`text`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    HostCommand,
    NoKeeperHere,
    KeeperOptIn,
    DebugDirect,
    KeeperAnswers,
    MacRelease,
    ShellFellBack,
    HostSourceNamed,
    NoBundledHost,
    NoShellHere,
    NoKeeperBeside,
    DebugKeeper,
    InProcessAsked,
    ExecBeside,
}

impl Reason {
    pub fn text(self) -> &'static str {
        match self {
            Reason::HostCommand => "CC_HOST_CMD is set: the window runs that host itself",
            Reason::NoKeeperHere => "the keeper is built on unix sockets, descriptor passing and flock; Windows has no keeper yet",
            // The keeper's scripts pass on Linux (the `keeper e2e (linux)` job), and it runs from a copy
            // out of the AppImage's mount (FI4), but the real window has never started it on a Linux
            // desktop (docs/spikes/2026-10-linux-keeper.md §7 items 2 and 3; plan step 4b).
            Reason::KeeperOptIn => {
                "on Linux the keeper only runs with CC_USE_KEEPER=1 until the window has run it on a Linux desktop"
            }
            Reason::DebugDirect => "a debug build is the host's parent unless CC_USE_KEEPER=1",
            Reason::KeeperAnswers => "a keeper already answers on keeper.sock",
            Reason::MacRelease => "a macOS release starts its keeper through the shell, which holds macOS permissions across updates",
            Reason::ShellFellBack => "the shell did not start a keeper earlier in this window's life",
            Reason::HostSourceNamed => "CC_KEEPER_HOST_SOURCE is set (the keeper scripts name a host with it), and the shell would not run that host",
            Reason::NoBundledHost => "this release build carries no bundled host, so it runs the source host like a debug build",
            Reason::NoShellHere => "only macOS has a shell; elsewhere the window starts the keeper",
            Reason::NoKeeperBeside => "no centralu-keeper next to the window's executable",
            Reason::DebugKeeper => "tauri dev builds only the window, so a centralu-keeper beside it may be older code",
            Reason::InProcessAsked => "CC_KEEPER_IN_PROCESS: a debug window asked for the keeper in its own executable",
            Reason::ExecBeside => "the window's executable turns into the centralu-keeper beside it",
        }
    }
}

/// The decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Plan {
    pub mode: StartMode,
    /// The host the window's build runs. `None` for `centralu --keeper`, whose command line names it.
    pub host: Option<Host>,
    /// The dev data folder and `CC_DEV=1`: a debug build, or a release with no bundled host.
    pub dev: bool,
    pub reason: Reason,
}

/// How the host starts, given `f`. docs/agent-host.md §4.0 is this function as a table.
pub fn plan(f: &Facts) -> Plan {
    let release = f.build == Build::Release;
    // Never decide dev or release by the bundle's existence alone: `tauri dev`'s resource folder is
    // target/debug/, and once a release build has been made a bundled host stays copied there too. A
    // debug build that ran it would miss source edits and take the release app's data folder.
    let dev = !(release && f.bundled_host);
    if f.who == Who::KeeperFlag {
        let (mode, reason) = if f.env.keeper_in_process {
            (StartMode::KeeperInProcess, Reason::InProcessAsked)
        } else if f.keeper_beside {
            (StartMode::KeeperBeside, Reason::ExecBeside)
        } else {
            (StartMode::KeeperInWindowExe, Reason::NoKeeperBeside)
        };
        return Plan { mode, host: None, dev, reason };
    }

    let direct = |reason| {
        let host = if f.env.host_cmd == Var::Set {
            Host::Command
        } else if dev {
            Host::Source
        } else {
            Host::Bundle
        };
        Plan { mode: StartMode::Direct, host: Some(host), dev, reason }
    };
    if f.env.host_cmd != Var::Unset {
        return direct(Reason::HostCommand);
    }
    match f.os {
        Os::Windows => return direct(Reason::NoKeeperHere),
        Os::Linux if !f.env.use_keeper => return direct(Reason::KeeperOptIn),
        Os::MacOs if !release && !f.env.use_keeper => return direct(Reason::DebugDirect),
        _ => {}
    }

    let host = Some(if f.env.keeper_host_source == Var::Set {
        Host::Named
    } else if dev {
        Host::Source
    } else {
        Host::Bundle
    });
    let keeper = |mode, reason| Plan { mode, host, dev, reason };
    if f.keeper_answering {
        return keeper(StartMode::Attach, Reason::KeeperAnswers);
    }
    // Why the shell does not start this keeper, if it does not.
    let no_shell = if f.os != Os::MacOs {
        Some(Reason::NoShellHere)
    } else if !release {
        Some(Reason::DebugKeeper)
    } else if f.env.keeper_host_source != Var::Unset {
        Some(Reason::HostSourceNamed)
    } else if dev {
        Some(Reason::NoBundledHost)
    } else if f.shell == Shell::FellBack {
        Some(Reason::ShellFellBack)
    } else {
        None
    };
    let Some(why) = no_shell else {
        return keeper(StartMode::ThroughShell { allow_unpinned: f.env.shell_unpinned }, Reason::MacRelease);
    };
    if !release {
        keeper(StartMode::KeeperInProcess, Reason::DebugKeeper)
    } else if f.keeper_beside && f.os == Os::Linux {
        keeper(StartMode::Keeper, why)
    } else if f.keeper_beside {
        keeper(StartMode::KeeperBeside, why)
    } else {
        keeper(StartMode::KeeperInWindowExe, Reason::NoKeeperBeside)
    }
}

#[cfg(test)]
mod tests;
