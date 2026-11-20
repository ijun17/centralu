//! What a starting host does to its store before it can answer (#2334, `StoreWork` in @cc/protocol), as it says it in
//! `host.lock`'s `store`. The window reads it while it waits for the host, so a copy of a large store or a long store step
//! shows as that instead of ending in "Could not start the agent host". The npm launcher's reader of the same record is
//! `storeWork` in serve-files.mjs, by the same rule for who wrote it (`isLockWriter`).

use std::path::Path;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

/// `{ doing, step, bytes, since }`: `doing` is `copy` or `update`; `since` is epoch milliseconds.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StoreWork {
    pub doing: String,
    pub step: u64,
    pub bytes: u64,
    pub since: u64,
}

/// host.lock as far as this reads it: who wrote it, and the work it says.
#[derive(Debug, Clone, PartialEq, Deserialize)]
struct Lock {
    pid: u32,
    started: Option<String>,
    at: Option<u64>,
    store: Option<StoreWork>,
}

/// How long a record whose writer cannot be identified (Windows will not say when another logon's process was created)
/// still counts as its writer's: as long as a start takes, the launcher's `STARTING_MAX_MS`.
const UNIDENTIFIED_MAX_MS: u64 = 120_000;
/// One tick of the Windows clock, which both `at` and a process's creation are read from.
const CLOCK_TICK_MS: u64 = 16;

/// What the last record's writer was found to be: the window asks every 400 ms, and on macOS and Linux each answer costs a
/// `ps`. Keyed by the record's `pid`, `started` and `at`.
static IDENTIFIED: Mutex<Option<((u32, Option<String>, Option<u64>), Option<bool>)>> = Mutex::new(None);

/// The store work `host.lock` in `data` says, while it names the process that wrote it.
pub fn read(data: &Path) -> Option<StoreWork> {
    let lock = parse(&std::fs::read_to_string(data.join("host.lock")).ok()?)?;
    let key = (lock.pid, lock.started.clone(), lock.at);
    let identified = {
        let mut known = IDENTIFIED.lock().ok()?;
        match known.as_ref() {
            Some((k, w)) if *k == key => *w,
            _ => {
                let w = writer(&lock, crate::os::pid_alive, crate::os::process_start_text, crate::os::process_created_ms, now_ms());
                *known = Some((key, w));
                w
            }
        }
    };
    believed(&lock, identified, crate::os::pid_alive(lock.pid), now_ms()).then_some(lock.store?)
}

/// The record, when it has a pid and work this build knows.
fn parse(text: &str) -> Option<Lock> {
    let lock: Lock = serde_json::from_str(text).ok()?;
    let doing = &lock.store.as_ref()?.doing;
    (doing == "copy" || doing == "update").then_some(lock)
}

/// Whether the live process the record names wrote it, as the launcher's `isWriter` tells it: by `started` where the
/// host recorded one (`ps`), else by being created no later than `at`. None when it lives but its creation cannot be read.
fn writer(lock: &Lock, alive: fn(u32) -> bool, start_text: fn(u32) -> Option<String>, created_ms: fn(u32) -> Option<u64>, now: u64) -> Option<bool> {
    if !alive(lock.pid) {
        return Some(false);
    }
    if let Some(started) = &lock.started {
        return Some(start_text(lock.pid).as_deref() == Some(started.as_str()));
    }
    let Some(at) = lock.at.filter(|&at| at <= now) else { return Some(false) };
    created_ms(lock.pid).map(|created| created <= at + CLOCK_TICK_MS)
}

/// The launcher's `isLockWriter`: an identified writer is believed, or not, by that; one that cannot be identified only
/// while the record is young. Believing it for as long as its pid lives kept the window on its copy screen for a stranger
/// that got the pid of a host ended in its work.
fn believed(lock: &Lock, identified: Option<bool>, alive: bool, now: u64) -> bool {
    alive
        && match identified {
            Some(w) => w,
            None => lock.at.is_some_and(|at| now.saturating_sub(at) < UNIDENTIFIED_MAX_MS),
        }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The record as the host writes it, which the host's, the launcher's and the window's tests read too.
    const FIXTURE: &str = include_str!("../../../../../../tooling/fixtures/host-lock-store-work.json");

    fn said() -> String {
        #[derive(Deserialize)]
        struct Fixture {
            record: String,
        }
        serde_json::from_str::<Fixture>(FIXTURE).expect("the fixture reads").record
    }

    fn live(_: u32) -> bool {
        true
    }
    fn no_start(_: u32) -> Option<String> {
        None
    }
    fn unreadable(_: u32) -> Option<u64> {
        None
    }

    #[test]
    fn the_work_the_host_says_is_read_with_who_wrote_it() {
        let lock = parse(&said()).expect("a record with store work");
        assert_eq!((lock.pid, lock.started.as_deref(), lock.at), (4242, None, Some(1_800_000_000_000)));
        assert_eq!(lock.store, Some(StoreWork { doing: "copy".into(), step: 76, bytes: 19_352_965_120, since: 1_800_000_001_000 }));
    }

    #[test]
    fn a_lock_without_work_or_with_work_of_another_kind_says_none() {
        assert_eq!(parse(r#"{"pid":4242,"started":null,"at":1}"#), None);
        assert_eq!(parse(&said().replace("\"copy\"", "\"index\"")), None);
        assert_eq!(parse("{\"pid\":42"), None);
    }

    #[test]
    fn a_writer_is_identified_by_its_start_or_by_being_created_by_the_time_it_wrote() {
        let lock = parse(&said()).unwrap();
        let at = lock.at.unwrap();
        assert_eq!(writer(&lock, live, no_start, |_| Some(1_800_000_000_000 - 5_000), at + 1), Some(true));
        // Created after it wrote: a process that got the pid of a host ended since
        assert_eq!(writer(&lock, live, no_start, |_| Some(1_800_000_000_000 + 180_000), at + 1), Some(false));
        assert_eq!(writer(&lock, live, no_start, unreadable, at + 1), None);
        assert_eq!(writer(&lock, |_| false, no_start, unreadable, at + 1), Some(false));
        let started = Lock { started: Some("Mon Jan  5 10:00:00 2026".into()), ..lock.clone() };
        assert_eq!(writer(&started, live, |_| Some("Mon Jan  5 10:00:00 2026".into()), unreadable, at + 1), Some(true));
        assert_eq!(writer(&started, live, |_| Some("Tue Jan  6 10:00:00 2026".into()), unreadable, at + 1), Some(false));
    }

    #[test]
    fn a_writer_that_cannot_be_identified_counts_only_while_its_record_is_young() {
        let lock = parse(&said()).unwrap();
        let at = lock.at.unwrap();
        assert!(believed(&lock, None, true, at + 1_000));
        // A host ended in its copy three minutes ago, its pid another logon's process's now
        assert!(!believed(&lock, None, true, at + 180_000));
        assert!(believed(&lock, Some(true), true, at + 180_000));
        assert!(!believed(&lock, Some(true), false, at + 1_000));
    }

    #[test]
    fn a_record_whose_process_is_gone_or_is_another_says_none() {
        let dir = std::env::temp_dir().join(format!("cc-store-work-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let now = now_ms();
        let record = |pid: u32, at: u64| said().replace("4242", &pid.to_string()).replace("1800000000000", &at.to_string());
        // A pid no process has: the largest a u32 holds
        std::fs::write(dir.join("host.lock"), record(u32::MAX, now)).unwrap();
        assert_eq!(read(&dir), None);
        // This process, written after it started: its writer
        std::fs::write(dir.join("host.lock"), record(std::process::id(), now)).unwrap();
        assert_eq!(read(&dir).map(|w| w.step), Some(76));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
