//! One start: verify, copy (or verify the copy already there), refuse a downgrade, start the keeper
//! from the copy, wait for it to answer.

use std::fs::{self, DirBuilder, OpenOptions};
use std::io::Write;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{Duration, Instant};

use centralu_keeper_core::keeper::{self as keeper, client, exe::Start, EXIT_ALREADY_RUNNING};
use content_verify::version::{check_not_downgrade, read_highest_seen, record_started, Rollback};
use content_verify::{read_verified_manifest, remove_content, verify_and_copy, verify_in_place, Error, Expect, Manifest, TrustedKey};

use crate::args::Args;
use crate::{Reason, Refusal, READY_TIMEOUT, SHELL_VERSION};

/// `<data>/content/`: one folder per app version, each a verified, read-only copy.
pub const CONTENT_DIR: &str = "content";
/// `<data>/content/highest-started`: the newest app version this data folder has started, the floor a
/// downgrade is measured against. Raised by every start, set by a rollback.
pub const FLOOR_FILE: &str = "highest-started";
/// Where in the content the host is, as the window's bundle lays it out.
pub const HOST_DIR: &str = "host";

pub fn content_root(data: &Path) -> PathBuf {
    data.join(CONTENT_DIR)
}

pub fn floor_path(data: &Path) -> PathBuf {
    content_root(data).join(FLOOR_FILE)
}

/// What the start depends on, so tests can give it their own keys and keeper.
pub struct Env {
    pub keys: Vec<TrustedKey>,
    pub platform: String,
    pub shell_version: u64,
    pub ready_timeout: Duration,
    /// Whether a keeper answers on this socket.
    pub alive: Box<dyn Fn(&Path) -> bool>,
}

impl Env {
    pub fn real(keys: Vec<TrustedKey>) -> Env {
        Env {
            keys,
            platform: content_verify::current_platform(),
            shell_version: SHELL_VERSION,
            ready_timeout: READY_TIMEOUT,
            alive: Box::new(client::alive),
        }
    }
}

/// A start that left a keeper answering.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Started {
    /// The version started, or none when a keeper already answered and nothing was started.
    pub app_version: Option<String>,
    pub content_dir: Option<PathBuf>,
    pub keeper_pid: Option<u32>,
    /// A keeper was already answering (before this start, or it won the race to the lock).
    pub already_running: bool,
}

impl Started {
    pub fn describe(&self) -> String {
        match (&self.app_version, &self.content_dir, self.keeper_pid) {
            (Some(v), Some(d), Some(pid)) if !self.already_running => {
                format!("started the keeper {v} (pid {pid}) from {}", d.display())
            }
            _ => "a keeper already answers; nothing to start".into(),
        }
    }
}

/// Appends one line to `<data>/keeper.log`, where the keeper and the host write too.
pub fn log(data: &Path, msg: &str) {
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).mode(0o600).open(data.join("keeper.log")) {
        let _ = writeln!(f, "[shell] {msg}");
    }
}

pub fn run(a: &Args, env: &Env) -> Result<Started, Refusal> {
    // The window owns the data folder: it creates it, moves a pre-rename one first
    // (keeper::prepare_default_dir) and reads this start's status from it. A shell that created it
    // would have to know those rules too, in bytes that cannot change without a new shell version;
    // a shell that is asked to use a folder that is not there refuses instead.
    if !fs::metadata(&a.data_dir).map(|m| m.is_dir()).unwrap_or(false) {
        return Err(Refusal::new(Reason::Usage, format!("the data folder {} does not exist", a.data_dir.display())));
    }
    // Never start from, or replace, what is already under `<data>/content/`: a copy found not to
    // verify is removed before copying again (`place`), and that must not be the source itself.
    // As given (`args` refuses `..`) and resolved, so a symlink cannot hide it either.
    let resolved = |p: &Path| fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    if a.content.starts_with(content_root(&a.data_dir)) || resolved(&a.content).starts_with(content_root(&resolved(&a.data_dir))) {
        return Err(Refusal::new(
            Reason::Usage,
            format!("--content {} is inside the folder the shell copies into", a.content.display()),
        ));
    }
    log(
        &a.data_dir,
        &format!(
            "shell {SHELL_VERSION}{} (pid {}) asked to start {}{}",
            if crate::keys::TEST_BUILD { ", a test build" } else { "" },
            std::process::id(),
            a.content.display(),
            if a.rollback { ", rolling back on purpose" } else { "" }
        ),
    );
    let sock = keeper::socket_path(&a.data_dir);
    if (env.alive)(&sock) {
        return Ok(Started { app_version: None, content_dir: None, keeper_pid: None, already_running: true });
    }

    let expect = Expect { platform: env.platform.clone(), shell_version: Some(env.shell_version) };
    let (manifest, manifest_bytes) =
        read_verified_manifest(&a.content, &env.keys, &expect).map_err(|e| refusal(e, &a.content, Stage::Source))?;
    check_runnable(&manifest)?;

    let rollback = if a.rollback { Rollback::Allow } else { Rollback::Refuse };
    let floor = floor_path(&a.data_dir);
    // An unreadable floor is not a reason to refuse every start: only this user can write it, and
    // they could as well delete it. It is said in the log and replaced by the next start.
    let mut unreadable_floor = false;
    let highest = read_highest_seen(&floor).unwrap_or_else(|e| {
        log(&a.data_dir, &format!("ignoring an unreadable {}: {e}", floor.display()));
        unreadable_floor = true;
        None
    });
    check_not_downgrade(&manifest.app_version, highest.as_deref(), rollback).map_err(|e| {
        let message = match e {
            Error::Downgrade { candidate, highest } => format!(
                "Centralu {candidate} is older than {highest}, which has already run here; an older version starts only when rolled back on purpose"
            ),
            other => other.to_string(),
        };
        Refusal::new(Reason::Downgrade, message)
    })?;

    let dest = place(a, env, &expect, &manifest, &manifest_bytes)?;
    let exe = dest.join(keeper::exe::KEEPER_EXE);
    let start = Start {
        data_dir: a.data_dir.clone(),
        host_source: Some(dest.join(HOST_DIR)),
        bundle_path: a.bundle_path.clone(),
        app_version: manifest.app_version.clone(),
        dev: false,
        in_process: false,
    };
    log(&a.data_dir, &format!("starting the keeper from {}", exe.display()));
    let mut child = start
        .spawn(&exe)
        .map_err(|e| Refusal::new(Reason::KeeperStart, format!("could not start the keeper {}: {e}", exe.display())))?;
    let keeper_pid = child.id();
    let already_running = wait_ready(&mut child, &sock, &a.data_dir, env)?;
    // `Allow` writes the version whatever is there; an unreadable floor is overwritten the same way.
    let record = if unreadable_floor { Rollback::Allow } else { rollback };
    if let Err(e) = record_started(&floor, &manifest.app_version, record) {
        log(&a.data_dir, &format!("could not record {} as started: {e}", manifest.app_version));
    }
    Ok(Started {
        app_version: Some(manifest.app_version.clone()),
        content_dir: Some(dest),
        keeper_pid: Some(keeper_pid),
        already_running,
    })
}

/// The content must hold a keeper to start and a host for it to run.
fn check_runnable(m: &Manifest) -> Result<(), Refusal> {
    let has = |path: &str, exe: bool| m.files.iter().any(|f| f.path == path && (!exe || f.executable));
    if !has(keeper::exe::KEEPER_EXE, true) {
        return Err(Refusal::new(Reason::Content, format!("the content has no executable {}", keeper::exe::KEEPER_EXE)));
    }
    if !has(&format!("{HOST_DIR}/main.mjs"), false) {
        return Err(Refusal::new(Reason::Content, format!("the content has no {HOST_DIR}/main.mjs")));
    }
    Ok(())
}

/// `<data>/content/<version>/`, verified: the copy already there when it verifies and was made from
/// the same signed manifest, else a new copy. Never runs anything from `a.content`.
fn place(a: &Args, env: &Env, expect: &Expect, manifest: &Manifest, manifest_bytes: &[u8]) -> Result<PathBuf, Refusal> {
    let root = content_root(&a.data_dir);
    DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&root)
        .map_err(|e| Refusal::new(Reason::Copy, format!("cannot create {}: {e}", root.display())))?;
    // `Version::parse` admits only digits, letters, dots and dashes, and digits first: never a path.
    let dest = root.join(&manifest.app_version);
    let reuse = |dest: &Path| -> Option<String> {
        match verify_in_place(dest, &env.keys, expect) {
            Ok((_, bytes)) if bytes == manifest_bytes => None,
            Ok(_) => Some("holds a differently signed manifest".to_string()),
            Err(e) => Some(format!("does not verify ({e})")),
        }
    };
    if fs::symlink_metadata(&dest).is_ok() {
        match reuse(&dest) {
            None => {
                log(&a.data_dir, &format!("{} verifies; starting from it", dest.display()));
                return Ok(dest);
            }
            Some(why) => {
                log(&a.data_dir, &format!("{} {why}; copying again", dest.display()));
                discard(&dest).map_err(|e| Refusal::new(Reason::Copy, format!("cannot remove {}: {e}", dest.display())))?;
            }
        }
    }
    match verify_and_copy(&a.content, &dest, &env.keys, expect) {
        Ok(copied) if copied == *manifest => {
            log(&a.data_dir, &format!("verified and copied {} files into {}", copied.files.len(), dest.display()));
            Ok(dest)
        }
        Ok(_) => {
            // The source changed between reading its manifest and copying it.
            let _ = remove_content(&dest);
            Err(Refusal::new(Reason::Content, format!("the content at {} changed while it was being copied", a.content.display())))
        }
        // Another shell copied the same version in the meantime: use its copy if it verifies.
        Err(Error::DestinationExists(_)) if reuse(&dest).is_none() => Ok(dest),
        Err(e) => Err(refusal(e, &a.content, Stage::Copy)),
    }
}

/// Removes a folder at `dest` this crate wrote, or whatever else is there (a symlink, a file).
fn discard(dest: &Path) -> std::io::Result<()> {
    let meta = fs::symlink_metadata(dest)?;
    if meta.is_dir() {
        remove_content(dest)
    } else {
        fs::remove_file(dest)
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Stage {
    /// Reading the window's content.
    Source,
    /// Copying it into the data folder.
    Copy,
}

fn refusal(e: Error, source: &Path, stage: Stage) -> Refusal {
    match e {
        Error::ShellTooOld { needed, have } => Refusal::new(
            Reason::ShellTooOld,
            format!("this version of Centralu needs a newer agent shell (version {needed}; the installed one is {have})"),
        ),
        Error::Io { ref context, .. } if stage == Stage::Copy && !reads_the_source(context) => {
            Refusal::new(Reason::Copy, format!("could not copy the content: {e}"))
        }
        Error::DestinationExists(_) => Refusal::new(Reason::Copy, format!("could not copy the content: {e}")),
        other @ (Error::Missing(_) | Error::Io { .. }) => {
            Refusal::new(Reason::Content, format!("the content at {} is incomplete or unreadable: {other}", source.display()))
        }
        other => Refusal::new(Reason::Content, format!("the content at {} is not what the project signed: {other}", source.display())),
    }
}

/// Whether an I/O failure was reading the window's content (a missing or unreadable file there is
/// the content's fault) rather than writing the copy (the data folder's). By the verifier's contexts.
fn reads_the_source(context: &str) -> bool {
    !context.starts_with("read back") && (context.starts_with("open ") || context.starts_with("read ") || context.starts_with("stat "))
}

/// Waits until a keeper answers on `sock`. True when the one answering is another keeper (ours
/// found the folder held, exit 3). Stops the keeper it started if it never answers, so the window's
/// own start (its fallback) is not kept waiting on the lock.
fn wait_ready(child: &mut Child, sock: &Path, data: &Path, env: &Env) -> Result<bool, Refusal> {
    let deadline = Instant::now() + env.ready_timeout;
    loop {
        if (env.alive)(sock) {
            return Ok(false);
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                if status.code() == Some(EXIT_ALREADY_RUNNING) && (env.alive)(sock) {
                    return Ok(true);
                }
                return Err(Refusal::new(
                    Reason::KeeperExited,
                    format!("the keeper exited before it answered ({}); see keeper.log in {}", exit_words(status), data.display()),
                ));
            }
            Ok(None) => {}
            Err(e) => return Err(Refusal::new(Reason::KeeperExited, format!("cannot tell whether the keeper still runs: {e}"))),
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            return Err(Refusal::new(
                Reason::KeeperTimeout,
                format!("the keeper did not answer within {}s and was stopped; see keeper.log in {}", env.ready_timeout.as_secs(), data.display()),
            ));
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

fn exit_words(status: std::process::ExitStatus) -> String {
    use std::os::unix::process::ExitStatusExt;
    match (status.code(), status.signal()) {
        (Some(c), _) => format!("exit code {c}"),
        (None, Some(s)) => format!("signal {s}"),
        _ => "no exit status".into(),
    }
}

#[cfg(test)]
mod tests;
