//! FI4: what a Linux window carries is copied out of the AppImage before anything runs from it.

use std::cell::RefCell;
use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use super::super::content::{origin_of, version_dir, Origin};
use super::*;

struct Case {
    t: PathBuf,
}

impl Case {
    /// A temporary folder with a "mount" holding a keeper and a host of build `b1`.
    fn new(name: &str) -> Case {
        let t = std::env::temp_dir().join(format!("cc-carried-{name}-{}", std::process::id()));
        let _ = remove_content(&t);
        let mount = t.join("mount");
        fs::create_dir_all(mount.join("usr/bin")).unwrap();
        fs::create_dir_all(mount.join("host/node_modules/node-pty/build")).unwrap();
        fs::write(mount.join("usr/bin").join(KEEPER_EXE), "#!/bin/sh\necho keeper\n").unwrap();
        fs::set_permissions(mount.join("usr/bin").join(KEEPER_EXE), fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(mount.join("host/main.mjs"), "console.log('host')\n").unwrap();
        let helper = mount.join("host/node_modules/node-pty/build/spawn-helper");
        fs::write(&helper, "helper").unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o755)).unwrap();
        let c = Case { t };
        c.stamp("b1");
        c
    }
    fn stamp(&self, build: &str) {
        fs::write(self.host().join("bundle-info.json"), format!("{{\"commit\":\"{build}\"}}")).unwrap();
    }
    fn data(&self) -> PathBuf {
        self.t.join("data")
    }
    fn keeper(&self) -> PathBuf {
        self.t.join("mount/usr/bin").join(KEEPER_EXE)
    }
    fn host(&self) -> PathBuf {
        self.t.join("mount/host")
    }
    fn place(&self, replace: bool) -> (Result<PathBuf, Refusal>, Vec<String>) {
        let said = RefCell::new(Vec::new());
        let (keeper, host) = (self.keeper(), self.host());
        let r = place(&self.data(), &Carried { keeper: &keeper, host: &host, version: "0.2.0" }, replace, &|m: &str| {
            said.borrow_mut().push(m.to_string())
        });
        (r, said.into_inner())
    }
}

impl Drop for Case {
    fn drop(&mut self) {
        let _ = remove_content(&self.t);
    }
}

fn mode(p: &Path) -> u32 {
    fs::metadata(p).unwrap().permissions().mode() & 0o777
}

/// Changes a file of a read-only copy, keeping its size, as something that damaged it might: only
/// its hash tells.
fn damage(file: &Path) {
    let dir = file.parent().unwrap();
    fs::set_permissions(dir, fs::Permissions::from_mode(0o700)).unwrap();
    fs::set_permissions(file, fs::Permissions::from_mode(0o644)).unwrap();
    let upper = fs::read_to_string(file).unwrap().to_uppercase();
    fs::write(file, upper).unwrap();
}

#[test]
fn the_keeper_and_host_are_copied_into_content_read_only_with_their_exec_bits() {
    let c = Case::new("copy");
    let (dest, _) = c.place(true);
    let dest = dest.unwrap();
    assert_eq!(dest, version_dir(&c.data(), "0.2.0"));
    assert_eq!(fs::read(dest.join(KEEPER_EXE)).unwrap(), fs::read(c.keeper()).unwrap());
    assert_eq!(fs::read_to_string(dest.join("host/main.mjs")).unwrap(), "console.log('host')\n");
    assert_eq!(mode(&dest.join(KEEPER_EXE)), 0o555, "the keeper stays executable, and nothing is writable");
    assert_eq!(mode(&dest.join("host/node_modules/node-pty/build/spawn-helper")), 0o555);
    assert_eq!(mode(&dest.join("host/main.mjs")), 0o444);
    assert_eq!(mode(&dest), 0o555);
    assert_eq!(mode(&dest.join("host")), 0o555);
    assert!(dest.join(MANIFEST_NAME).is_file(), "the hashes are kept beside the copy");
    assert!(!dest.join(content_verify::SIGNATURE_NAME).exists(), "and nothing claims to be signed");
    // The keeper started from the copy knows it runs from an unsigned copy
    assert_eq!(origin_of(&dest.join(KEEPER_EXE), &c.data()), Origin::Content { dir: dest.clone(), version: "0.2.0".into(), signed: false });
    // Nothing half-made is left beside it
    let names: Vec<_> = fs::read_dir(content_root(&c.data())).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["0.2.0"]);
}

#[test]
fn an_intact_copy_of_the_same_build_is_used_again_and_survives_its_source() {
    let c = Case::new("reuse");
    let first = c.place(true).0.unwrap();
    let ino = |p: &Path| std::os::unix::fs::MetadataExt::ino(&fs::metadata(p).unwrap());
    let before = ino(&first.join(KEEPER_EXE));
    let (again, said) = c.place(false);
    assert_eq!(again.unwrap(), first);
    assert_eq!(ino(&first.join(KEEPER_EXE)), before, "the same files, not a new copy");
    assert!(said.iter().any(|m| m.contains("intact")), "{said:?}");
    // The AppImage unmounted: the copy is all that runs, and it is whole
    remove_content(&c.t.join("mount")).unwrap();
    assert!(first.join("host/main.mjs").is_file() && first.join(KEEPER_EXE).is_file());
}

#[test]
fn a_damaged_copy_is_copied_again_only_when_nothing_may_run_from_it() {
    let c = Case::new("damaged");
    let dest = c.place(true).0.unwrap();
    damage(&dest.join("host/main.mjs"));
    // A keeper answers (a switch): it or its host may run from the folder, so it is left alone
    let (r, _) = c.place(false);
    assert_eq!(r.unwrap_err().reason, "in-use");
    assert_eq!(fs::read_to_string(dest.join("host/main.mjs")).unwrap(), "CONSOLE.LOG('HOST')\n", "nothing anything runs from is touched");
    // No keeper (a fresh start): copied again
    let (r, said) = c.place(true);
    assert_eq!(r.unwrap(), dest);
    assert_eq!(fs::read_to_string(dest.join("host/main.mjs")).unwrap(), "console.log('host')\n");
    assert!(said.iter().any(|m| m.contains("host/main.mjs") && m.contains("copying again")), "{said:?}");
}

#[test]
fn another_build_of_the_same_version_replaces_the_copy_only_when_nothing_may_run_from_it() {
    let c = Case::new("rebuilt");
    let dest = c.place(true).0.unwrap();
    c.stamp("b2");
    assert_eq!(c.place(false).0.unwrap_err().reason, "in-use");
    assert!(fs::read_to_string(dest.join("host/bundle-info.json")).unwrap().contains("b1"));
    c.place(true).0.unwrap();
    assert!(fs::read_to_string(dest.join("host/bundle-info.json")).unwrap().contains("b2"));
}

#[test]
fn what_cannot_be_copied_is_refused_with_nothing_left_behind() {
    let c = Case::new("refused");
    let data = c.data();
    let (keeper, host) = (c.keeper(), c.host());
    let quiet = |_: &str| {};
    let try_place = |keeper: &Path, host: &Path, version: &str| place(&data, &Carried { keeper, host, version }, true, &quiet);
    assert_eq!(try_place(&keeper, &host, "../escape").unwrap_err().reason, "content");
    assert_eq!(try_place(&keeper, &c.t.join("nowhere"), "0.2.0").unwrap_err().reason, "no-content");
    assert_eq!(try_place(&c.t.join("no-keeper"), &host, "0.2.0").unwrap_err().reason, "no-content");
    fs::remove_file(host.join("bundle-info.json")).unwrap();
    assert_eq!(try_place(&keeper, &host, "0.2.0").unwrap_err().reason, "no-content", "a host without its build stamp is not complete");
    c.stamp("b1");
    // A source inside the content folder (a copy of a copy) would be removed before it is read
    let dest = try_place(&keeper, &host, "0.2.0").unwrap();
    let r = try_place(&dest.join(KEEPER_EXE), &dest.join("host"), "0.2.1");
    assert_eq!(r.unwrap_err().reason, "content");
    let names: Vec<_> = fs::read_dir(content_root(&data)).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names, ["0.2.0"]);
}
