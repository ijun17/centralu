//! The shell (docs/plans/thin-shell.md §3).
//!
//! A small app bundle, `<data>/shell/Centralu.app`, whose bytes do not change between releases, so
//! that macOS, which identifies an ad-hoc signed app by the hash of its code, keeps the permissions a
//! person granted it across updates. The window opens it through LaunchServices; it does five things
//! and exits:
//!
//! 1. takes the content folder and the data folder as arguments (`args`);
//! 2. verifies the content's signed manifest with the public keys built into it (`keys`);
//! 3. copies the verified files into `<data>/content/<version>/` and verifies the copy, or verifies
//!    the copy already there (`run::place`);
//! 4. refuses a version lower than the highest it has started, unless asked to roll back;
//! 5. starts the keeper from the copy, exactly as the window would (`keeper::exe::Start`), waits for
//!    it to answer on its socket, and exits.
//!
//! The keeper and everything it starts are judged by macOS as this app, also after it exits (the
//! measurement in docs/spikes/2026-10-thin-shell-tcc.md). It has no window, no network, no settings,
//! and knows nothing of the host.
//!
//! **No AppKit, no run loop.** "Not responding" is the window server's verdict on a process that is
//! connected to it and does not handle its events (Apple DTS, developer.apple.com/forums/thread/777284).
//! This binary links libSystem and libiconv and nothing else (`otool -L`; checked by
//! scripts/shell-integration.mts and the shell release workflow), so it cannot open a window server
//! connection and has no events to fall behind on; `LSUIElement` keeps it out of the Dock. What was
//! and was not measured: docs/plans/thin-shell.md §3.
//!
//! **How it reports.** Every start ends in one line on stderr, an exit code (`Reason::exit_code`), a
//! line in `<data>/keeper.log` and `<data>/shell-status.json` (`status`). A shell opened through
//! LaunchServices is not the window's child, so the window cannot see its exit code or its stderr; the
//! status file, matched by the nonce the window passed, is how it learns why a start was refused.

#![cfg(unix)]

pub mod args;
pub mod keys;
pub mod run;
pub mod status;

use std::time::Duration;

/// This shell's version: `CentraluShellVersion` in Info.plist, the entries of packaging/shell/shell.lock,
/// and what a manifest's `minShellVersion` is compared with. Raised only when the contract between the
/// window, the shell and the keeper changes, because every new shell version asks every person for
/// their permissions again (thin-shell.md §6.1, §7).
pub const SHELL_VERSION: u64 = 1;

/// The bundle id, the identity the permission prompt and System Settings show as "Centralu".
pub const BUNDLE_ID: &str = "app.centralu.agent";

/// How long a keeper may take to answer on its socket. The window allows its own keeper as long
/// (`client::ensure`, 25 s); a keeper answers in well under a second.
pub const READY_TIMEOUT: Duration = Duration::from_secs(25);

/// Why a start ended without a keeper. Each has an exit code and an id the status file carries.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    /// The arguments are missing, repeated, relative or unknown.
    Usage,
    /// The content is not what the project signed: a signature, the manifest, the platform, a file.
    Content,
    /// The content needs a newer shell than this one.
    ShellTooOld,
    /// The content is older than the newest version this data folder has started.
    Downgrade,
    /// The copy could not be written (disk full, permissions).
    Copy,
    /// The keeper could not be started at all.
    KeeperStart,
    /// The keeper exited before it answered.
    KeeperExited,
    /// The keeper did not answer within `READY_TIMEOUT`.
    KeeperTimeout,
}

impl Reason {
    pub fn id(self) -> &'static str {
        match self {
            Reason::Usage => "usage",
            Reason::Content => "content",
            Reason::ShellTooOld => "shell-too-old",
            Reason::Downgrade => "downgrade",
            Reason::Copy => "copy",
            Reason::KeeperStart => "keeper-start",
            Reason::KeeperExited => "keeper-exited",
            Reason::KeeperTimeout => "keeper-timeout",
        }
    }

    pub fn exit_code(self) -> i32 {
        match self {
            Reason::Usage => 2,
            Reason::Content => 10,
            Reason::ShellTooOld => 11,
            Reason::Downgrade => 12,
            Reason::Copy => 13,
            Reason::KeeperStart => 14,
            Reason::KeeperExited => 15,
            Reason::KeeperTimeout => 16,
        }
    }
}

/// A start that ended without a keeper, and the sentence the window shows for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refusal {
    pub reason: Reason,
    pub message: String,
}

impl Refusal {
    pub fn new(reason: Reason, message: impl Into<String>) -> Refusal {
        Refusal { reason, message: message.into() }
    }
}

/// The shell's whole life, from its command line to its exit code.
pub fn main_with(argv: &[String]) -> i32 {
    let parsed = args::parse(argv);
    let (data, nonce) = match &parsed {
        Ok(a) => (Some(a.data_dir.clone()), a.nonce.clone()),
        Err(_) => (args::data_dir_hint(argv), args::nonce_hint(argv)),
    };
    let outcome = parsed.and_then(|a| {
        let keys = keys::trusted_keys().map_err(|e| Refusal::new(Reason::Content, format!("the built-in keys are unreadable: {e}")))?;
        run::run(&a, &run::Env::real(keys))
    });
    if let Some(data) = &data {
        status::write(data, nonce.as_deref(), &outcome);
    }
    match outcome {
        Ok(started) => {
            let line = started.describe();
            eprintln!("centralu-shell: {line}");
            if let Some(d) = &data {
                run::log(d, &line);
            }
            0
        }
        Err(r) => {
            let line = format!("refused ({}): {}", r.reason.id(), r.message);
            eprintln!("centralu-shell: {line}");
            if r.reason == Reason::Usage {
                eprintln!("{}", args::USAGE);
            }
            if let Some(d) = &data {
                run::log(d, &line);
            }
            r.reason.exit_code()
        }
    }
}
