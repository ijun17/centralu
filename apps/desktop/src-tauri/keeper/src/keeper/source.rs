//! Where a host came from, and the per-build copy it runs from.
//!
//! The owner's requirement on #280: on 2026-10-03 the running app turned out to be the
//! build-output bundle that `pnpm app:open` opens in place, and the next `tauri build` rewrote
//! that bundle on disk while it ran. The host had its code in memory but still read the Codex
//! bridge, `schema.sql` and `app-template/` from the bundle on demand, so it could have mixed two
//! builds. A host started by the keeper therefore never runs from a bundle: the keeper copies
//! the bundle's `resources/host` folder to `<data>/hosts/<key>/` first and runs it from there.
//! Rebuilding, replacing or deleting the bundle afterwards cannot touch the running host.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

/// Where a host came from. Kept in the keeper's state, reported to every attached window, and
/// passed to the host (`CC_HOST_SOURCE`) so its `hello_ok` says the same.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BuildSource {
    /// The commit `bundle.mjs` stamped into `bundle-info.json` (`abc1234`, `abc1234-dirty`,
    /// `unknown`), or `dev` for a host run from source.
    pub commit: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub built_at: Option<String>,
    /// The app version (`0.1.0-beta.6`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    /// The WebSocket protocol version the host speaks (`PROTOCOL_VERSION`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<u32>,
    /// The app bundle the build came from (`/Applications/Centralu.app`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bundle_path: Option<String>,
    /// The host folder inside that bundle — what gets copied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_dir: Option<String>,
    /// The per-build copy the host actually runs from. Set by the keeper.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub copy_dir: Option<String>,
}

impl BuildSource {
    /// The identity two builds are compared by, and the name of the copy's folder.
    pub fn key(&self) -> String {
        build_key(&self.commit, self.built_at.as_deref())
    }

    /// Same build means same code, not same path: a fresh `tauri build` at the same path is a
    /// different build, and two installs of one release are the same one.
    pub fn same_build(&self, other: &BuildSource) -> bool {
        self.key() == other.key()
    }

    /// Reads `bundle-info.json` from a bundle's host folder.
    ///
    /// Lenient on purpose: a folder without the file still gets an identity (the main
    /// script's modification time), so it is never mistaken for a different build's copy.
    pub fn from_host_dir(host_dir: &Path, bundle_path: Option<String>, version: Option<String>) -> BuildSource {
        let info = fs::read_to_string(host_dir.join("bundle-info.json"))
            .ok()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok());
        let text = |k: &str| info.as_ref().and_then(|v| v.get(k)).and_then(|v| v.as_str()).map(str::to_string);
        let commit = text("commit").filter(|c| !c.trim().is_empty()).unwrap_or_else(|| "unknown".into());
        let built_at = text("builtAt").or_else(|| {
            fs::metadata(host_dir.join("main.mjs"))
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs().to_string())
        });
        let protocol_version = info
            .as_ref()
            .and_then(|v| v.get("protocolVersion"))
            .and_then(|v| v.as_u64())
            .map(|n| n as u32);
        BuildSource {
            commit,
            built_at,
            version,
            protocol_version,
            bundle_path,
            host_dir: Some(host_dir.to_string_lossy().to_string()),
            copy_dir: None,
        }
    }

    /// A host run from source by tsx (a debug build opted into the keeper). There is no bundle
    /// to copy, and every source run counts as the same build.
    pub fn dev() -> BuildSource {
        BuildSource { commit: "dev".into(), ..Default::default() }
    }
}

/**
 * The folder name for a build.
 *
 * A clean commit names its code exactly, so two builds of it share one copy. A `-dirty` or
 * `unknown` commit does not: two builds from the same dirty tree can hold different code, and
 * reusing the first copy for the second would run stale code under a name that looks right. Those
 * get the build time appended. Anything outside `[A-Za-z0-9._-]` is replaced, so a commit string
 * can never climb out of `hosts/`.
 */
pub fn build_key(commit: &str, built_at: Option<&str>) -> String {
    let clean = |s: &str| -> String {
        s.chars()
            .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
            .collect()
    };
    let mut key = clean(commit.trim());
    if key.is_empty() || key.chars().all(|c| c == '_') {
        key = "unknown".into();
    }
    if key == "dev" {
        return key;
    }
    let exact = key != "unknown" && !key.ends_with("-dirty");
    if !exact {
        let stamp: String = built_at.unwrap_or("").chars().filter(|c| c.is_ascii_digit()).collect();
        key = format!("{key}-{}", if stamp.is_empty() { "nostamp".into() } else { stamp });
    }
    key
}

pub fn hosts_dir(data: &Path) -> PathBuf {
    data.join("hosts")
}

/// Copies the build's host folder into `<data>/hosts/<key>/`, or reuses a complete copy that is
/// already there. Returns the copy's path.
///
/// The copy is written to a temporary folder and renamed into place, so a keeper that dies half
/// way leaves a `.tmp-*` folder (removed by the next cleanup), never a half copy under the
/// real name.
pub fn copy_into(data: &Path, src: &BuildSource) -> Result<PathBuf, String> {
    let from = src.host_dir.as_deref().ok_or("this build has no host folder to copy")?;
    let from = Path::new(from);
    if !from.join("main.mjs").is_file() {
        return Err(format!("no host in {} (main.mjs is missing)", from.display()));
    }
    let hosts = hosts_dir(data);
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(&hosts)
        .map_err(|e| format!("cannot create {}: {e}", hosts.display()))?;
    let key = src.key();
    let target = hosts.join(&key);
    if complete(&target) {
        return Ok(target);
    }
    let tmp = hosts.join(format!(".tmp-{key}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    copy_tree(from, &tmp).map_err(|e| format!("copying the host from {} failed: {e}", from.display()))?;
    if !complete(&tmp) {
        let _ = fs::remove_dir_all(&tmp);
        return Err(format!("the copy of {} is incomplete", from.display()));
    }
    let _ = fs::remove_dir_all(&target);
    fs::rename(&tmp, &target).map_err(|e| format!("cannot move the host copy into place: {e}"))?;
    Ok(target)
}

/// A copy counts once both the script and the build stamp are there. `bundle-info.json` is the
/// last thing `bundle.mjs` writes, and `copy_tree` copies it like any other file, so its presence
/// alone would not prove the rest arrived — but a copy only ever gets its real name through the
/// rename above, after `copy_tree` returned without an error.
fn complete(dir: &Path) -> bool {
    dir.join("main.mjs").is_file() && dir.join("bundle-info.json").is_file()
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
    fs::DirBuilder::new().mode(0o700).create(to)?;
    for entry in fs::read_dir(from)? {
        let entry = entry?;
        let kind = entry.file_type()?;
        let dest = to.join(entry.file_name());
        if kind.is_symlink() {
            std::os::unix::fs::symlink(fs::read_link(entry.path())?, &dest)?;
        } else if kind.is_dir() {
            copy_tree(&entry.path(), &dest)?;
        } else {
            // fs::copy keeps the permission bits: node-pty's spawn-helper must stay executable,
            // or every terminal dies with `posix_spawnp failed` (bundle.mjs checks the same bit).
            fs::copy(entry.path(), &dest)?;
        }
    }
    Ok(())
}

/// Which entries of `hosts/` to remove: every one not named in `keep` (the copy the running host
/// uses, and the copies a launch or a swap has claimed). Leftover temporary folders are from a
/// keeper that died mid-copy.
pub fn stale_copies(names: &[String], keep: &HashSet<String>) -> Vec<String> {
    names.iter().filter(|n| !keep.contains(n.as_str())).cloned().collect()
}

/// Removes every copy not named in `keep`. Returns what was removed. Only through `Copies`, which
/// decides `keep` while no copy can be made or claimed.
fn clean_copies(data: &Path, keep: &HashSet<String>) -> Vec<String> {
    let hosts = hosts_dir(data);
    let Ok(entries) = fs::read_dir(&hosts) else { return Vec::new() };
    let names: Vec<String> = entries.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
    let mut removed = Vec::new();
    for name in stale_copies(&names, keep) {
        let path = hosts.join(&name);
        // A temporary copy still being written belongs to a launch or swap in progress. Measured
        // (#280 step 4): a keeper that took over and was handed a switch started copying the new
        // build at once, and the cleanup its adopted host's ready line set off deleted that copy
        // under it ("No such file or directory"). One a dead keeper left behind goes once it is old.
        if name.starts_with(".tmp-") && in_progress(&path) {
            continue;
        }
        let gone = if path.is_dir() { fs::remove_dir_all(&path) } else { fs::remove_file(&path) };
        if gone.is_ok() {
            removed.push(name);
        }
    }
    removed
}

/// How long a temporary copy counts as still being written: copying a 20 MB host takes well
/// under a second; this only has to outlast a slow disk.
const COPY_IN_PROGRESS: std::time::Duration = std::time::Duration::from_secs(10 * 60);

fn in_progress(path: &Path) -> bool {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .map(|age| age < COPY_IN_PROGRESS)
        .unwrap_or(false)
}

/**
 * The per-build copies in `<data>/hosts/`, and which of them are spoken for (#368).
 *
 * A copy is in use from the moment a launch or a swap starts making it until a host runs from it,
 * and the cleanup a ready host sets off must not take it in between. Seen in CI (2026-10-05/06): a
 * keeper that had just taken over was handed a switch, copied build C into place, and the cleanup
 * its adopted host's ready line set off, keeping only that host's copy, deleted C's copy before
 * the swap started it ("Cannot find module .../hosts/handoff-C/main.mjs"). #325 had covered the
 * copy while it was a temporary folder, not after its rename.
 *
 * So every copy and every cleanup in a keeper goes through one lock:
 *   - `claim` makes or reuses a build's copy and holds it until the claim is dropped. A launch
 *     drops it once the keeper's state names the copy as the running host's, a swap once its new
 *     host is adopted or the swap gave up;
 *   - `clean` reads the copy to keep (the running host's) when it runs, not when it was asked
 *     for, and spares every claimed copy;
 *   - `freeze` (a keeper handoff) waits for a copy or cleanup in progress, then refuses both, so
 *     the outgoing keeper never touches `hosts/` while the incoming one may: after the commit it
 *     only exits, and after a rollback `thaw` lets it carry on.
 */
pub struct Copies {
    data: PathBuf,
    inner: Mutex<Held>,
}

#[derive(Default)]
struct Held {
    /// Folder name -> how many claims hold it
    claims: HashMap<String, usize>,
    frozen: bool,
}

/// A copy held for a launch or a swap. Dropping it gives the copy up (it stays on disk).
pub struct Claim<'a> {
    copies: &'a Copies,
    name: String,
    path: PathBuf,
    released: bool,
}

impl Copies {
    pub fn new(data: &Path) -> Copies {
        Copies { data: data.to_path_buf(), inner: Mutex::new(Held::default()) }
    }

    fn held(&self) -> MutexGuard<'_, Held> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Copies the build (or reuses its complete copy) and holds it. No cleanup removes it until the
    /// claim is dropped.
    pub fn claim(&self, src: &BuildSource) -> Result<Claim<'_>, String> {
        let mut held = self.held();
        if held.frozen {
            return Err("the keeper is handing itself over to another keeper".into());
        }
        let path = copy_into(&self.data, src)?;
        let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        *held.claims.entry(name.clone()).or_default() += 1;
        Ok(Claim { copies: self, name, path, released: false })
    }

    /// Removes every copy but the running host's (`keep`, read now) and the claimed ones. Returns
    /// what was removed; nothing while frozen.
    pub fn clean(&self, keep: impl FnOnce() -> Option<PathBuf>) -> Vec<String> {
        let held = self.held();
        if held.frozen {
            return Vec::new();
        }
        let mut names: HashSet<String> = held.claims.keys().cloned().collect();
        if let Some(name) = keep().and_then(|k| k.file_name().map(|n| n.to_string_lossy().to_string())) {
            names.insert(name);
        }
        clean_copies(&self.data, &names)
    }

    /// Stops all copying and cleaning for a keeper handoff, once what is in progress has finished.
    pub fn freeze(&self, wait: Duration) -> Result<(), String> {
        let deadline = Instant::now() + wait;
        loop {
            match self.inner.try_lock() {
                Ok(mut held) => {
                    held.frozen = true;
                    return Ok(());
                }
                Err(TryLockError::Poisoned(e)) => {
                    e.into_inner().frozen = true;
                    return Ok(());
                }
                Err(TryLockError::WouldBlock) => {}
            }
            if Instant::now() >= deadline {
                return Err("a host copy was still being written".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// The handoff was rolled back.
    pub fn thaw(&self) {
        self.held().frozen = false;
    }
}

impl Claim<'_> {
    pub fn path(&self) -> &Path {
        &self.path
    }

    fn release(&mut self, held: &mut Held) {
        if self.released {
            return;
        }
        self.released = true;
        if let Some(n) = held.claims.get_mut(&self.name) {
            *n -= 1;
            if *n == 0 {
                held.claims.remove(&self.name);
            }
        }
    }

    /// Gives the copy up and removes it (a swap whose build did not start), unless another claim
    /// still holds it or it is `except`, the running host's.
    pub fn discard(mut self, except: Option<&Path>) {
        let copies = self.copies;
        let mut held = copies.held();
        self.release(&mut held);
        if !held.frozen && !held.claims.contains_key(&self.name) && except != Some(self.path.as_path()) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

impl Drop for Claim<'_> {
    fn drop(&mut self) {
        if !self.released {
            let copies = self.copies;
            let mut held = copies.held();
            self.release(&mut held);
        }
    }
}

/// Background mode (#280, decision 1): whether closing the last window leaves the keeper and
/// the host running. Off by default.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    #[serde(default)]
    pub background: bool,
}

pub fn settings_path(data: &Path) -> PathBuf {
    data.join("keeper-settings.json")
}

/// A missing or unreadable file reads as the default (off): failing to read a preference must
/// never be the reason agents keep running unwatched.
pub fn load_settings(data: &Path) -> Settings {
    fs::read_to_string(settings_path(data))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_settings(data: &Path, settings: &Settings) -> io::Result<()> {
    write_private(&settings_path(data), &serde_json::to_vec_pretty(settings)?)
}

/// Writes a file only this user can read, atomically (temp file + rename).
pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let tmp = path.with_extension(format!("tmp-{}", std::process::id()));
    {
        use std::io::Write;
        let mut f = fs::OpenOptions::new().create(true).write(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(bytes)?;
        f.write_all(b"\n")?;
    }
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cc-keeper-src-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn fake_host(dir: &Path, commit: &str, built_at: &str) {
        fs::create_dir_all(dir.join("node_modules/node-pty/prebuilds")).unwrap();
        fs::write(dir.join("main.mjs"), format!("// {commit}")).unwrap();
        let helper = dir.join("node_modules/node-pty/prebuilds/spawn-helper");
        fs::write(&helper, "#!/bin/sh\n").unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(
            dir.join("bundle-info.json"),
            format!(r#"{{"commit":"{commit}","builtAt":"{built_at}","protocolVersion":1}}"#),
        )
        .unwrap();
    }

    #[test]
    fn a_clean_commit_is_its_own_key() {
        assert_eq!(build_key("3e742a93", Some("2026-10-04T07:56:33.816Z")), "3e742a93");
    }

    /// Two builds from one dirty tree can hold different code; sharing a copy would run the
    /// first one's code under the second one's name.
    #[test]
    fn a_dirty_or_unknown_build_is_told_apart_by_its_build_time() {
        assert_eq!(build_key("3e742a93-dirty", Some("2026-10-04T07:56:33.816Z")), "3e742a93-dirty-20261004075633816");
        assert_ne!(
            build_key("3e742a93-dirty", Some("2026-10-04T07:56:33.816Z")),
            build_key("3e742a93-dirty", Some("2026-10-04T08:00:00.000Z"))
        );
        assert_eq!(build_key("unknown", None), "unknown-nostamp");
        assert_eq!(build_key("", Some("1")), "unknown-1");
    }

    #[test]
    fn a_commit_string_cannot_climb_out_of_the_hosts_folder() {
        let key = build_key("../../etc", None);
        assert!(!key.contains('/') && !key.contains(".."), "{key}");
    }

    #[test]
    fn reads_the_build_stamp_from_the_bundle() {
        let dir = temp("read");
        fake_host(&dir, "abc1234", "2026-10-04T00:00:00Z");
        let src = BuildSource::from_host_dir(&dir, Some("/Applications/Centralu.app".into()), Some("0.1.0".into()));
        assert_eq!(src.commit, "abc1234");
        assert_eq!(src.protocol_version, Some(1));
        assert_eq!(src.bundle_path.as_deref(), Some("/Applications/Centralu.app"));
        assert_eq!(src.key(), "abc1234");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn same_build_compares_code_not_paths() {
        let a = BuildSource { commit: "abc".into(), bundle_path: Some("/Applications/Centralu.app".into()), ..Default::default() };
        let b = BuildSource { commit: "abc".into(), bundle_path: Some("/tmp/Centralu.app".into()), ..Default::default() };
        let c = BuildSource { commit: "def".into(), bundle_path: a.bundle_path.clone(), ..Default::default() };
        assert!(a.same_build(&b));
        assert!(!a.same_build(&c), "a fresh build at the same path is a different build");
    }

    /// The point of the copy: the host must keep running from files no rebuild can touch.
    #[test]
    fn the_copy_survives_the_bundle_being_rewritten_and_keeps_the_exec_bit() {
        let data = temp("copy-data");
        let bundle = temp("copy-bundle");
        fake_host(&bundle, "abc1234", "t1");
        let src = BuildSource::from_host_dir(&bundle, None, None);
        let copy = copy_into(&data, &src).unwrap();
        assert_eq!(copy, data.join("hosts/abc1234"));
        assert!(copy.join("main.mjs").is_file());
        let mode = fs::metadata(copy.join("node_modules/node-pty/prebuilds/spawn-helper")).unwrap().permissions().mode();
        assert!(mode & 0o111 != 0, "spawn-helper lost its exec bit: {mode:o}");

        // A rebuild rewrites the bundle in place.
        fs::write(bundle.join("main.mjs"), "// rewritten").unwrap();
        assert_eq!(fs::read_to_string(copy.join("main.mjs")).unwrap(), "// abc1234");
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&bundle);
    }

    #[test]
    fn a_complete_copy_is_reused_and_a_half_one_is_replaced() {
        let data = temp("reuse-data");
        let bundle = temp("reuse-bundle");
        fake_host(&bundle, "abc1234", "t1");
        let src = BuildSource::from_host_dir(&bundle, None, None);
        let copy = copy_into(&data, &src).unwrap();
        fs::write(copy.join("marker"), "kept").unwrap();
        assert!(copy_into(&data, &src).unwrap().join("marker").is_file(), "a complete copy is reused");

        fs::remove_file(copy.join("main.mjs")).unwrap();
        let again = copy_into(&data, &src).unwrap();
        assert!(again.join("main.mjs").is_file() && !again.join("marker").exists(), "a half copy is replaced");
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&bundle);
    }

    #[test]
    fn refuses_a_folder_with_no_host_in_it() {
        let data = temp("empty-data");
        let bundle = temp("empty-bundle");
        let src = BuildSource::from_host_dir(&bundle, None, None);
        assert!(copy_into(&data, &src).unwrap_err().contains("main.mjs"));
        let _ = fs::remove_dir_all(&data);
        let _ = fs::remove_dir_all(&bundle);
    }

    #[test]
    fn cleanup_keeps_only_the_running_copy() {
        let names = vec!["abc".to_string(), "def".to_string(), ".tmp-ghi-12".to_string()];
        let keep: HashSet<String> = ["def".to_string()].into();
        assert_eq!(stale_copies(&names, &keep), vec!["abc".to_string(), ".tmp-ghi-12".to_string()]);

        let data = temp("clean");
        for n in &names {
            fs::create_dir_all(hosts_dir(&data).join(n)).unwrap();
        }
        // A temporary copy left by a keeper that died long ago
        age(&hosts_dir(&data).join(".tmp-ghi-12"), 3600);
        let mut removed = Copies::new(&data).clean(|| Some(hosts_dir(&data).join("def")));
        removed.sort();
        assert_eq!(removed, vec![".tmp-ghi-12".to_string(), "abc".to_string()]);
        assert!(hosts_dir(&data).join("def").is_dir());
        let _ = fs::remove_dir_all(&data);
    }

    /// Sets a file's modification time `secs` into the past.
    fn age(path: &Path, secs: i64) {
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs() as i64;
        let t = libc::timeval { tv_sec: (now - secs) as libc::time_t, tv_usec: 0 };
        let c = std::ffi::CString::new(path.to_string_lossy().as_bytes()).unwrap();
        // SAFETY: a valid C string and two valid timevals.
        assert_eq!(unsafe { libc::utimes(c.as_ptr(), [t, t].as_ptr()) }, 0);
    }

    /// A copy being written right now is a launch or a swap in progress, not a leftover.
    #[test]
    fn cleanup_leaves_a_copy_being_written_alone() {
        let data = temp("clean-fresh");
        fs::create_dir_all(hosts_dir(&data).join(".tmp-next-7")).unwrap();
        fs::create_dir_all(hosts_dir(&data).join("old")).unwrap();
        assert_eq!(Copies::new(&data).clean(|| None), vec!["old".to_string()]);
        assert!(hosts_dir(&data).join(".tmp-next-7").is_dir());
        let _ = fs::remove_dir_all(&data);
    }

    /// Two builds' bundles, A (running) and C (being switched to), and a data folder.
    fn two_builds(name: &str) -> (PathBuf, BuildSource, BuildSource, PathBuf, PathBuf) {
        let data = temp(&format!("{name}-data"));
        let a = temp(&format!("{name}-a"));
        let c = temp(&format!("{name}-c"));
        fake_host(&a, "handoff-A", "t1");
        fake_host(&c, "handoff-C", "t2");
        let (a_src, c_src) = (BuildSource::from_host_dir(&a, None, None), BuildSource::from_host_dir(&c, None, None));
        (data, a_src, c_src, a, c)
    }

    /// The CI failure of #368, in order: a keeper that has just taken over runs a switch, which
    /// copies build C into place; then the cleanup its adopted host's ready line set off runs,
    /// with build A as the running host's copy. C's copy must still be there when the swap starts
    /// it ("Cannot find module .../hosts/handoff-C/main.mjs" when it was not).
    #[test]
    fn a_copy_a_swap_holds_survives_the_cleanup_a_ready_host_sets_off() {
        let (data, a_src, c_src, a, c) = two_builds("held");
        let copies = Copies::new(&data);
        let running = copies.claim(&a_src).unwrap().path().to_path_buf();

        let swap = copies.claim(&c_src).unwrap();
        let removed = copies.clean(|| Some(running.clone()));
        assert!(swap.path().join("main.mjs").is_file(), "the cleanup deleted the copy a swap holds (removed {removed:?})");
        assert!(running.join("main.mjs").is_file(), "the running host's copy is kept");
        assert!(removed.is_empty(), "{removed:?}");

        // Once nothing holds it and no host runs from it, it is unused like any other
        drop(swap);
        assert_eq!(copies.clean(|| Some(running.clone())), vec!["handoff-C".to_string()]);
        for d in [&data, &a, &c] {
            let _ = fs::remove_dir_all(d);
        }
    }

    /// The cleanup asks which copy the running host uses when it runs, not when it was set off: a
    /// swap may have adopted its new host in between, and the old answer names the old copy.
    #[test]
    fn the_cleanup_keeps_the_copy_the_host_runs_from_when_it_runs() {
        let (data, a_src, c_src, a, c) = two_builds("late");
        let copies = Copies::new(&data);
        let a_copy = copies.claim(&a_src).unwrap().path().to_path_buf();
        let running = Mutex::new(a_copy);
        // The swap adopts C's host (the keeper's state now names C's copy), then lets its claim go
        let swap = copies.claim(&c_src).unwrap();
        *running.lock().unwrap() = swap.path().to_path_buf();
        drop(swap);
        assert_eq!(copies.clean(|| Some(running.lock().unwrap().clone())), vec!["handoff-A".to_string()]);
        assert!(hosts_dir(&data).join("handoff-C/main.mjs").is_file());
        for d in [&data, &a, &c] {
            let _ = fs::remove_dir_all(d);
        }
    }

    /// A cleanup and a launch or swap in two threads, as in a keeper: whatever the interleaving, a
    /// claimed copy is complete for as long as it is held.
    #[test]
    fn a_claimed_copy_is_never_taken_by_a_concurrent_cleanup() {
        let (data, a_src, c_src, a, c) = two_builds("race");
        let copies = Copies::new(&data);
        let running = copies.claim(&a_src).unwrap().path().to_path_buf();
        let stop = std::sync::atomic::AtomicBool::new(false);
        std::thread::scope(|s| {
            s.spawn(|| {
                while !stop.load(std::sync::atomic::Ordering::SeqCst) {
                    copies.clean(|| Some(running.clone()));
                }
            });
            for i in 0..100 {
                let swap = copies.claim(&c_src).unwrap();
                std::thread::sleep(Duration::from_millis(1));
                let whole = swap.path().join("main.mjs").is_file();
                drop(swap);
                if !whole {
                    stop.store(true, std::sync::atomic::Ordering::SeqCst);
                    panic!("round {i}: the held copy was deleted");
                }
            }
            stop.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        for d in [&data, &a, &c] {
            let _ = fs::remove_dir_all(d);
        }
    }

    /// A swap whose build did not start removes its copy, unless another claim holds it or it is
    /// the copy the running host uses.
    #[test]
    fn a_discarded_copy_goes_unless_it_is_held_or_running() {
        let (data, _a_src, c_src, a, c) = two_builds("discard");
        let copies = Copies::new(&data);
        let first = copies.claim(&c_src).unwrap();
        let second = copies.claim(&c_src).unwrap();
        let path = first.path().to_path_buf();
        first.discard(None);
        assert!(path.join("main.mjs").is_file(), "another claim still holds it");
        second.discard(Some(&path));
        assert!(path.join("main.mjs").is_file(), "the running host's copy is never discarded");
        copies.claim(&c_src).unwrap().discard(None);
        assert!(!path.exists(), "an unheld copy of a build that did not start is removed");
        for d in [&data, &a, &c] {
            let _ = fs::remove_dir_all(d);
        }
    }

    /// A keeper handing itself over leaves `hosts/` alone from the freeze on: the incoming keeper
    /// may copy and clean as soon as it commits, while this one is still exiting.
    #[test]
    fn a_frozen_keeper_neither_copies_nor_cleans() {
        let (data, a_src, c_src, a, c) = two_builds("frozen");
        let copies = Copies::new(&data);
        let running = copies.claim(&a_src).unwrap().path().to_path_buf();
        drop(copies.claim(&c_src).unwrap());
        copies.freeze(Duration::from_secs(1)).unwrap();
        assert!(copies.clean(|| Some(running.clone())).is_empty());
        assert!(hosts_dir(&data).join("handoff-C").is_dir());
        assert!(copies.claim(&c_src).is_err(), "no copying while frozen");
        copies.thaw();
        assert_eq!(copies.clean(|| Some(running.clone())), vec!["handoff-C".to_string()]);
        for d in [&data, &a, &c] {
            let _ = fs::remove_dir_all(d);
        }
    }

    /// The freeze waits for a copy or cleanup in progress, and gives up (the handoff rolls back)
    /// rather than wait forever.
    #[test]
    fn the_freeze_waits_for_a_copy_in_progress() {
        let data = temp("freeze-wait");
        let copies = Copies::new(&data);
        let busy = copies.inner.lock().unwrap();
        std::thread::scope(|s| {
            let err = s.spawn(|| copies.freeze(Duration::from_millis(50))).join().unwrap();
            assert!(err.unwrap_err().contains("still being written"));
            let waiting = s.spawn(|| copies.freeze(Duration::from_secs(30)));
            drop(busy);
            waiting.join().unwrap().unwrap();
        });
        assert!(copies.held().frozen);
        let _ = fs::remove_dir_all(&data);
    }

    #[test]
    fn background_mode_is_off_unless_saved_on() {
        let data = temp("settings");
        assert!(!load_settings(&data).background, "off by default");
        fs::write(settings_path(&data), "not json").unwrap();
        assert!(!load_settings(&data).background, "an unreadable file reads as off");
        save_settings(&data, &Settings { background: true }).unwrap();
        assert!(load_settings(&data).background);
        let mode = fs::metadata(settings_path(&data)).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let _ = fs::remove_dir_all(&data);
    }
}
