use super::node::*;
#[cfg(unix)]
use crate::os::{pid_alive, probe_login_shell, signal_target};
use crate::os::parse_probe_output;
use crate::start_plan::Os;
use super::*;
use std::io::BufReader;

/**
 * `kill_group` reaches the whole group the host leads and nothing outside it (#350). It used to
 * run `/bin/kill -TERM -<pid>`, which procps-ng 4.0.4 (Ubuntu 24.04) turns into a signal to the
 * group named by the pid's first digit: there the leader and its child below survived, and a
 * pid starting with 1 sent SIGTERM to every process of the user, this test's runner included.
 * macOS's `kill` reads the argument as a group, so only a Linux run tells the two apart.
 */
#[cfg(unix)]
#[test]
fn kill_group_signals_the_group_the_pid_leads_and_nothing_else() {
    use std::io::BufRead;
    use std::os::unix::process::{CommandExt, ExitStatusExt};

    // A leader of a group of its own with a child in that group, and a bystander in another.
    let mut leader = Command::new("/bin/sh")
        .args(["-c", "sleep 60 & echo $!; wait"])
        .stdout(Stdio::piped())
        .process_group(0)
        .spawn()
        .unwrap();
    let mut bystander = Command::new("sleep").arg("60").process_group(0).spawn().unwrap();
    let mut line = String::new();
    BufReader::new(leader.stdout.take().unwrap()).read_line(&mut line).unwrap();
    let member: u32 = line.trim().parse().unwrap();

    kill_group(leader.id());

    let end = Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(st) = leader.try_wait().unwrap() {
            break Some(st);
        }
        if Instant::now() > end {
            break None;
        }
        thread::sleep(Duration::from_millis(20));
    };
    // Reparented once its shell ended, so it is reaped by whoever adopts it.
    while pid_alive(member) && Instant::now() < end {
        thread::sleep(Duration::from_millis(20));
    }
    let member_gone = !pid_alive(member);
    let bystander_running = bystander.try_wait().unwrap().is_none();
    if status.is_none() {
        let _ = leader.kill();
        let _ = leader.wait();
    }
    if !member_gone {
        // SAFETY: a plain syscall to the test's own grandchild.
        unsafe { libc::kill(member as i32, libc::SIGKILL) };
    }
    let _ = bystander.kill();
    let _ = bystander.wait();

    assert_eq!(status.and_then(|s| s.signal()), Some(libc::SIGTERM), "the group's leader got no SIGTERM");
    assert!(member_gone, "the leader's child in the same group is still running");
    assert!(bystander_running, "a process outside the group was signalled");
}

/// The numbers `kill(2)` reads as something other than one process or one group are never
/// signalled: 0 is the caller's own group, -1 is everyone, and a pid past `i32::MAX` would turn
/// negative (#350).
#[cfg(unix)]
#[test]
fn signals_go_only_to_a_real_pid_or_group() {
    assert_eq!(signal_target(0), None);
    assert_eq!(signal_target(1), None);
    assert_eq!(signal_target(i32::MAX as u32 + 1), None);
    assert_eq!(signal_target(u32::MAX), None);
    assert_eq!(signal_target(2), Some(2));
    assert_eq!(signal_target(12345), Some(12345));
}

/// The dev host runs the source from the workspace root; moving this crate (#440) moved the
/// root one folder further up.
#[test]
fn the_workspace_root_is_the_repository_root() {
    assert!(Path::new(&workspace_root()).join("pnpm-workspace.yaml").is_file(), "{}", workspace_root());
}

/// A store a newer Centralu wrote is reported at once, like a lock conflict; a plain crash is
/// still retried (#292).
#[test]
fn a_store_too_new_is_final_like_a_lock_conflict() {
    assert!(is_final_refusal("[agent-host] Another Centralu is already using this data (pid 42)."));
    assert!(is_final_refusal(
        "[agent-host] This data was written by a newer Centralu.\n  It can be read from store version 45 on"
    ));
    assert!(!is_final_refusal("agent-host exited (code Some(1))\nTypeError: x is undefined"));
    let too_new = "[agent-host] This data was written by a newer Centralu.";
    assert_eq!(after_exit(0, Duration::ZERO, false, too_new, Some(1)), AfterExit::GiveUp(too_new.into()));
}

#[test]
fn counts_consecutive_failures_and_gives_up_after_five() {
    let quick = Duration::from_secs(1);
    assert_eq!(after_exit(0, quick, false, "", Some(1)), AfterExit::Retry { attempt: 1 });
    assert_eq!(after_exit(4, quick, false, "", Some(1)), AfterExit::Retry { attempt: 5 });
    match after_exit(5, quick, false, "boom", Some(1)) {
        AfterExit::GiveUp(m) => assert!(m.contains("boom") && m.contains("Some(1)"), "{m}"),
        other => panic!("expected to give up, got {other:?}"),
    }
}

#[test]
fn a_death_after_a_stable_run_starts_the_count_over() {
    assert_eq!(after_exit(5, STABLE_UPTIME, false, "", None), AfterExit::Retry { attempt: 1 });
}

#[test]
fn another_owner_of_the_data_is_reported_at_once() {
    let reason = "[agent-host] Another Centralu is already using this data (pid 7).";
    assert_eq!(after_exit(0, Duration::ZERO, false, reason, Some(1)), AfterExit::GiveUp(reason.into()));
}

/// The keeper's build switch stops the host on purpose; that exit must not count as a
/// crash, or five switches in a row would leave the person with "gave up".
#[test]
fn a_deliberate_bounce_starts_again_without_counting() {
    assert_eq!(after_exit(5, Duration::ZERO, true, "anything", Some(0)), AfterExit::Again);
}

#[test]
fn backoff_doubles_and_stops_at_five_seconds() {
    assert_eq!(backoff(1), Duration::from_millis(400));
    assert_eq!(backoff(2), Duration::from_millis(800));
    assert_eq!(backoff(9), Duration::from_millis(5000));
}

/// The keeper handoff (#280 step 4): a host's stdout reader stops between two lines and hands
/// over every byte it read but did not deliver, the half line included; while frozen it reads
/// nothing more, and a thaw carries on where it stopped.
#[cfg(unix)]
#[test]
fn a_frozen_host_reader_hands_over_what_it_read_and_stops_between_lines() {
    use std::os::unix::net::UnixStream;
    let (r, mut w) = UnixStream::pair().unwrap();
    w.write_all(b"one\ntwo\nfour-five\nthr").unwrap();
    let out = HostOut::new(r.into(), Vec::new());
    let gate = out.gate();
    // The supervisor's thread: it hands each line on and waits until it is taken (a sink)
    let (tx, rx) = std::sync::mpsc::sync_channel::<String>(0);
    thread::spawn(move || {
        for line in out {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    let t = Duration::from_secs(2);
    assert_eq!(rx.recv_timeout(t).unwrap(), "one");
    // The reader now holds "two" for the sink. The freeze is asked for, and lands once the
    // sink takes it and the reader comes back for the next line.
    let freezer = thread::spawn(move || (gate.freeze(Duration::from_secs(2)), gate));
    thread::sleep(Duration::from_millis(100));
    assert_eq!(rx.recv_timeout(t).unwrap(), "two");
    let (held, gate) = freezer.join().unwrap();
    assert_eq!(held.unwrap(), b"four-five\nthr", "what the next keeper starts with: a whole line and a half one");
    w.write_all(b"ee\n").unwrap();
    assert!(rx.recv_timeout(Duration::from_millis(200)).is_err(), "nothing is delivered while frozen");
    gate.thaw();
    assert_eq!(rx.recv_timeout(t).unwrap(), "four-five");
    assert_eq!(rx.recv_timeout(t).unwrap(), "three");
}

#[test]
fn bouncing_with_no_host_running_does_nothing() {
    assert!(!Supervisor::new().bounce());
}

/// Retry can relaunch a supervisor that has given up, and does not launch a second one on
/// top of a running one (#184).
#[test]
fn a_supervisor_that_gave_up_can_be_claimed_again() {
    let sup = Supervisor::new();
    assert!(sup.claim(false), "starts for the first time");
    assert!(!sup.claim(true), "does not launch a second one while the watcher thread is running");

    // The watcher thread emitted Failed and ended.
    sup.set_error("agent-host exited (code Some(1))");
    drop(Running(sup.clone()));

    assert!(sup.claim(true), "launches again once it has ended");
    assert_eq!(sup.last_error(), None, "a fresh attempt must not look like it failed instantly for the old reason");
}

#[test]
fn no_restart_while_the_app_is_quitting() {
    let sup = Supervisor::new();
    sup.shutdown();
    assert!(!sup.claim(true));
}

/// Installing Node after the app is open and pressing Retry must trigger a fresh search
/// (#184).
#[test]
fn a_missing_node_is_not_remembered_but_a_found_one_is() {
    let cache = std::sync::OnceLock::new();
    assert_eq!(
        remember_found(&cache, || Err("could not find Node.js".into())),
        Err("could not find Node.js".to_string())
    );
    assert_eq!(
        remember_found(&cache, || Ok("/opt/homebrew/bin/node".into())),
        Ok("/opt/homebrew/bin/node".to_string())
    );
    assert_eq!(
        remember_found(&cache, || panic!("a successful find is not asked for again")),
        Ok("/opt/homebrew/bin/node".to_string())
    );
}

// The login-shell probe is unix-only, and its sample answer is a unix path.
#[cfg(unix)]
#[test]
fn picks_the_marked_line_only() {
    // Only the marked line is checked, no matter what the shell configuration prints
    // (banners, warnings).
    let out = "Welcome to zsh!\n__CC_NODE__:/bin/sh\nsome trailing noise\n";
    assert_eq!(parse_probe_output(out), Some("/bin/sh".to_string()));
}

#[test]
fn ignores_a_path_that_is_not_there() {
    // `command -v` can return an empty string (not installed) or a dead symlink.
    assert_eq!(parse_probe_output("__CC_NODE__:\n"), None);
    assert_eq!(parse_probe_output("__CC_NODE__:/nope/node\n"), None);
    assert_eq!(parse_probe_output("node not found\n"), None);
}

#[test]
fn compares_versions_as_numbers_not_text() {
    // A lexical sort would make v9 > v22 and pick the old Node.
    assert!(version_parts("v22.3.1") > version_parts("v9.11.2"));
    assert_eq!(version_parts("v22.3.1"), vec![22, 3, 1]);
    assert_eq!(version_parts("lts/*"), Vec::<u32>::new());
    assert_eq!(version_parts(""), Vec::<u32>::new());
}

/// Sets up a script that pretends to be node and prints the given version.
fn fake_node(version: &str, name: &str) -> String {
    // Windows cannot run a sh script; a batch file is what Rust's Command can start there.
    #[cfg(windows)]
    let (path, body) = (std::env::temp_dir().join(format!("{name}.cmd")), format!("@echo {version}\r\n"));
    #[cfg(not(windows))]
    let (path, body) = (std::env::temp_dir().join(name), format!("#!/bin/sh\necho {version}\n"));
    std::fs::write(&path, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    path.to_string_lossy().to_string()
}

#[test]
fn rejects_a_node_that_is_too_old() {
    // A low version is "needs an upgrade", not "missing" — the person has a different task.
    let path = fake_node("v20.11.1", "cc-test-node-old");
    let err = check_node_version(&path).unwrap_err();
    assert!(err.contains("or newer is required"), "{err}");
    assert!(err.contains("v20.11.1"), "{err}");
}

#[test]
fn accepts_a_node_that_is_new_enough() {
    let path = fake_node("v22.3.1", "cc-test-node-ok");
    assert_eq!(check_node_version(&path), Ok(path));
}

#[test]
fn passes_when_the_version_cannot_be_read() {
    // No basis to block it, so it is not blocked (an unexpected output format).
    let path = fake_node("banana", "cc-test-node-weird");
    assert_eq!(check_node_version(&path), Ok(path));
}

/// Checks that this Mac's login shell's own node is actually picked out.
///
/// A unit test alone cannot confirm "asks the shell instead of using a fixed path" — since
/// that is the entire point of this fix, this touches the real thing once. Passes silently
/// in an environment with no node (there is no basis to block it there).
#[cfg(unix)]
#[test]
fn finds_the_node_this_shell_knows() {
    let Ok(shell) = std::env::var("SHELL") else { return };
    if !Path::new(&shell).exists() {
        return;
    }
    let Ok(out) = Command::new(&shell).args(["-ilc", "command -v node"]).output() else {
        return;
    };
    let expected = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if expected.is_empty() || !Path::new(&expected).exists() {
        return;
    }
    assert_eq!(probe_login_shell(), Some(expected.clone()));
    assert_eq!(resolve_node(), Ok(expected));
}

#[test]
fn moves_on_when_the_shell_node_is_too_old() {
    // A Mac where nvm defaults to v18 but Homebrew has v22 — stopping here would fail to
    // launch even though a usable Node exists.
    let old = fake_node("v18.20.4", "cc-test-node-shell-old");
    let new = fake_node("v22.9.0", "cc-test-node-brew-new");
    assert_eq!(pick_node(Some(old), vec![new.clone()]), Ok(new));
}

#[test]
fn explains_the_old_version_when_there_is_nothing_newer() {
    // If nothing newer ever turns up, say "old", not "missing" — the task is an upgrade,
    // not an install.
    let old = fake_node("v18.20.4", "cc-test-node-only-old");
    let err = pick_node(Some(old), vec!["/nope/node".into()]).unwrap_err();
    assert!(err.contains("v18.20.4"), "{err}");
    assert!(!err.contains("Could not find"), "{err}");
}

#[test]
fn reports_every_place_it_looked_when_nothing_is_there() {
    // Finding nothing anywhere is the moment the person is most stuck — list every place
    // that was checked.
    let err = pick_node(None, vec!["/nope/a/node".into(), "/nope/b/node".into()]).unwrap_err();
    assert!(err.contains(first_look(Os::current())), "{err}");
    assert!(err.contains("/nope/a/node") && err.contains("/nope/b/node"), "{err}");
}

/// Windows (#14): Node discovery used to be the login shell plus unix folders under `$HOME`,
/// so a packaged Windows build could never find Node. These are the folders the installers
/// people actually use put it in.
#[test]
fn looks_where_windows_installers_put_node() {
    let env = |name: &str| {
        match name {
            "ProgramFiles" | "ProgramW6432" => Some("C:\\Program Files"),
            "LOCALAPPDATA" => Some("C:\\Users\\me\\AppData\\Local"),
            "NVM_SYMLINK" => Some("C:\\nvm4w\\nodejs"),
            "NVM_HOME" => Some("C:\\Users\\me\\AppData\\Local\\nvm"),
            "USERPROFILE" => Some("C:\\Users\\me"),
            _ => None,
        }
        .map(String::from)
    };
    let paths = windows_node_paths(env, |_| vec!["v22.3.1".into(), "v20.1.0".into()]);
    assert_eq!(
        paths,
        vec![
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Users\\me\\AppData\\Local\\Programs\\nodejs\\node.exe",
            "C:\\Users\\me\\AppData\\Local\\Volta\\bin\\node.exe",
            "C:\\nvm4w\\nodejs\\node.exe",
            "C:\\Users\\me\\AppData\\Local\\nvm\\v22.3.1\\node.exe",
            "C:\\Users\\me\\AppData\\Local\\nvm\\v20.1.0\\node.exe",
            "C:\\Users\\me\\scoop\\shims\\node.exe",
            "C:\\Users\\me\\scoop\\apps\\nodejs\\current\\node.exe",
            "C:\\Users\\me\\scoop\\apps\\nodejs-lts\\current\\node.exe",
        ],
        "ProgramFiles and ProgramW6432 name the same folder, so it is listed once"
    );
    assert!(windows_node_paths(|_| None, |_| Vec::new()).is_empty(), "nothing set, nothing guessed");
}

/// PATH comes first on Windows, but only its absolute entries: `.` or `bin` on PATH would be
/// resolved against the working directory, which could be a cloned repository.
#[test]
fn a_relative_path_entry_is_never_searched() {
    use std::path::PathBuf;
    let base = std::env::temp_dir();
    let dirs = vec![PathBuf::from("bin"), base.join("a"), base.join("b")];
    let found = first_on_path(dirs, "node.exe", |p| p.starts_with("bin") || p.starts_with(base.join("b")));
    assert_eq!(found, Some(base.join("b").join("node.exe").to_string_lossy().to_string()));
}

#[test]
fn falls_back_to_a_real_path_when_the_shell_says_nothing() {
    let ok = fake_node("v22.0.0", "cc-test-node-fallback");
    assert_eq!(pick_node(None, vec!["/nope/node".into(), ok.clone()]), Ok(ok));
}

#[test]
fn looks_where_version_managers_actually_put_node() {
    // This used to be only the two Homebrew locations and /usr/bin — nvm, mise and volta
    // users got stuck here.
    let paths = node_paths_under("/home/tester");
    for expected in [
        "/opt/homebrew/bin/node",
        "/home/tester/.volta/bin/node",
        "/home/tester/.local/share/mise/shims/node",
        "/home/tester/.asdf/shims/node",
    ] {
        assert!(paths.iter().any(|p| p == expected), "{expected} is not among the candidates: {paths:?}");
    }
}

#[test]
fn says_where_it_looked_when_there_is_no_node() {
    let msg = node_missing_message(&["login shell PATH".into(), "/opt/homebrew/bin/node".into()]);
    assert!(msg.contains("login shell PATH"));
    assert!(msg.contains("/opt/homebrew/bin/node"));
    assert!(msg.contains("22"));
}

/**
 * SU3: a host is stopped by TERM to its pid alone, a real grace, then TERM to its group, with its
 * stdin held open until the end. A group TERM first would hit codex directly (#57); EOF before
 * TERM would race the signal into a second `shutdown()`.
 *
 * The "host" is a shell that writes what reaches it: its own TERM (it ignores it, like a host
 * still shutting down), a group member's TERM, and EOF on stdin.
 */
#[cfg(unix)]
#[test]
fn a_host_is_stopped_pid_first_then_its_group_with_stdin_held() {
    let file = std::env::temp_dir().join(format!("cc-host-stop-order-{}", std::process::id()));
    let _ = std::fs::remove_file(&file);
    let script = r#"
        exec 3<&0
        ( trap '' TERM; read x <&3; echo eof >> "$F" ) &
        ( trap 'echo member-term >> "$F"; exit 0' TERM; while :; do sleep 0.05; done ) &
        trap 'echo leader-term >> "$F"' TERM
        echo ready >> "$F"
        while :; do sleep 0.05; done
    "#;
    let launch = HostLaunch {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), script.into()],
        env: vec![("F".into(), file.to_string_lossy().to_string())],
    };
    let mut child = spawn_host(&launch).unwrap();
    let read = || std::fs::read_to_string(&file).unwrap_or_default();
    let until = |what: &str| {
        let end = Instant::now() + Duration::from_secs(10);
        while !read().contains(what) && Instant::now() < end {
            std::thread::sleep(Duration::from_millis(20));
        }
    };
    until("ready");
    // Two seconds into the grace: only the host's pid has been asked, and stdin is still open.
    let during = {
        let file = file.clone();
        std::thread::spawn(move || {
            std::thread::sleep(STOP_GRACE - Duration::from_secs(1));
            std::fs::read_to_string(&file).unwrap_or_default()
        })
    };
    let started = Instant::now();
    stop_child(&mut child);
    let took = started.elapsed();
    let during = during.join().unwrap();
    until("member-term");
    until("eof");
    let lines: Vec<String> = read().lines().map(str::to_string).filter(|l| l != "ready").collect();
    let _ = std::fs::remove_file(&file);
    assert_eq!(lines.first().map(String::as_str), Some("leader-term"), "the host's pid first: {lines:?}");
    assert!(lines.iter().any(|l| l == "member-term"), "the group gets TERM in the end: {lines:?}");
    assert!(during.contains("leader-term"), "{during:?}");
    assert!(!during.contains("member-term"), "the group was signalled within the grace: {during:?}");
    assert!(!during.contains("eof"), "stdin was closed within the grace: {during:?}");
    assert!(took >= STOP_GRACE, "a real grace before the group: {took:?}");
}

/// SU5: Windows has no TERM. A host is asked to stop by closing its stdin, and one that then ends
/// is not waited out or killed (`findstr` reads stdin to its end, as a host with `--watch-parent`
/// does).
#[cfg(windows)]
#[test]
fn a_windows_host_is_asked_to_stop_by_closing_its_stdin() {
    let root = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into());
    let launch = HostLaunch { program: format!("{root}\\System32\\findstr.exe"), args: vec!["x".into()], env: vec![] };
    let mut child = spawn_host(&launch).unwrap();
    let started = Instant::now();
    stop_child(&mut child);
    assert!(started.elapsed() < STOP_GRACE, "stopped only after the grace: {:?}", started.elapsed());
}
