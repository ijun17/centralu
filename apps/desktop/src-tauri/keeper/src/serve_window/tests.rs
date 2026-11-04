use super::*;
use crate::host_proc::{resolve_node, HostLaunch, Launcher, Supervisor};
use crate::start_plan::{plan, Build, Env, Facts, Host, Os, Shell};
use std::sync::Mutex;

/// What `serve --connection` prints, after whatever a login shell said first
fn line(takes: &str, protocol: u32) -> String {
    format!("some motd\r\n{{\"v\":1,\"port\":17176,\"token\":\"t\",\"version\":\"0.1.0\",\"protocolVersion\":{protocol},\"dataDir\":\"C:/d\",\"hostRunning\":true{takes}}}\r\n")
}

#[test]
fn reads_the_protocol_and_whether_it_takes_window_from_the_last_connection_line() {
    assert_eq!(
        parse_connection_line(&line(r#","takes":["from","window"]"#, 1)),
        Some(ServeLine { protocol_version: 1, takes_window: true })
    );
    // A serve from before --window: `takes` without it, or no `takes` at all (beta.28)
    assert_eq!(parse_connection_line(&line(r#","takes":["from"]"#, 1)).map(|l| l.takes_window), Some(false));
    assert_eq!(parse_connection_line(&line("", 1)).map(|l| l.takes_window), Some(false));
    assert_eq!(parse_connection_line("CENTRALU-NOT-FOUND\n"), None);
    assert_eq!(parse_connection_line(r#"{"v":2,"protocolVersion":1}"#), None);
    assert_eq!(parse_connection_line(""), None);
}

#[test]
fn uses_only_a_serve_that_takes_window_and_speaks_the_windows_protocol() {
    let ok = ServeLine { protocol_version: 2, takes_window: true };
    assert_eq!(choose(Some(&ok), Some(2)), ServeChoice::Use);
    assert_eq!(choose(Some(&ok), Some(1)), ServeChoice::ProtocolDiffers { serve: 2, window: 1 });
    assert_eq!(choose(Some(&ServeLine { protocol_version: 2, takes_window: false }), Some(2)), ServeChoice::NoWindow);
    assert_eq!(choose(None, Some(2)), ServeChoice::NoAnswer);
    assert_eq!(choose(Some(&ok), None), ServeChoice::WindowUnknown);
    for c in [ServeChoice::Use, ServeChoice::NoAnswer, ServeChoice::NoWindow, ServeChoice::WindowUnknown, ServeChoice::ProtocolDiffers { serve: 2, window: 1 }] {
        assert!(!c.text().is_empty());
    }
}

/// A packaged Windows window with serve installed in its data folder, the serve's answer read as the window reads it
fn windows_plan(serve_said: Option<&str>, window_protocol: u32) -> Option<Host> {
    let choice = choose(serve_said.and_then(parse_connection_line).as_ref(), Some(window_protocol));
    let f = Facts {
        os: Os::Windows,
        build: Build::Release,
        env: Env::default(),
        bundled_host: true,
        keeper_answering: false,
        shell: Shell::Untried,
        serve_usable: choice == ServeChoice::Use,
    };
    plan(&f).host
}

/// The review's cases: each one that cannot serve the window starts the bundled host, as before #1223
#[test]
fn an_older_serve_a_serve_on_another_protocol_and_one_that_did_not_answer_leave_the_window_its_bundled_host() {
    assert_eq!(windows_plan(Some(&line(r#","takes":["from","window"]"#, 1)), 1), Some(Host::Serve));
    assert_eq!(windows_plan(Some(&line(r#","takes":["from"]"#, 1)), 1), Some(Host::Bundle), "a serve from before --window");
    assert_eq!(windows_plan(Some(&line(r#","takes":["from","window"]"#, 2)), 1), Some(Host::Bundle), "another protocol");
    assert_eq!(windows_plan(None, 1), Some(Host::Bundle), "no answer");
}

#[test]
fn reads_the_windows_protocol_from_its_bundled_hosts_bundle_info() {
    let dir = std::env::temp_dir().join(format!("cc-bundle-info-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("bundle-info.json"), r#"{"commit":"c","protocolVersion":3}"#).unwrap();
    assert_eq!(bundle_protocol(&dir), Some(3));
    std::fs::write(dir.join("bundle-info.json"), "not json").unwrap();
    assert_eq!(bundle_protocol(&dir), None);
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(bundle_protocol(&dir), None);
}

#[test]
fn falls_back_for_good_after_a_serve_attempt_that_never_got_ready_and_not_after_one_that_did() {
    let f = ServeFallback::default();
    assert_eq!(f.next(), Pick::Serve);
    // It got ready, then its host went: the next attempt tries serve again
    f.ready();
    assert_eq!(f.next(), Pick::Serve);
    // This one ended before its ready line
    assert_eq!(f.next(), Pick::Bundle);
    assert!(f.fell_back());
    f.ready();
    assert_eq!(f.next(), Pick::Bundle, "for the rest of the window's life");
}

/// A launcher the window would start: `.cmd` on Windows, a shell script elsewhere, printing `out` after `wait_s`
fn fake_launcher(name: &str, out: &str, wait_s: u32) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("cc-serve-ask-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let node = resolve_node().expect("node for the test");
    let js = dir.join("say.js");
    std::fs::write(&js, format!("setTimeout(() => console.log({}), {})", serde_json::to_string(out).unwrap(), wait_s * 1000)).unwrap();
    if cfg!(windows) {
        let p = dir.join("centralu.cmd");
        std::fs::write(&p, format!("@\"{node}\" \"{}\"\r\n", js.display())).unwrap();
        p
    } else {
        let p = dir.join("centralu");
        std::fs::write(&p, format!("#!/bin/sh\nexec \"{node}\" \"{}\"\n", js.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }
}

#[test]
fn asks_the_launcher_for_its_connection_line_and_gives_up_on_one_that_hangs() {
    let said = line(r#","takes":["from","window"]"#, 1);
    let quick = fake_launcher("quick", said.trim(), 0);
    let out = ask_connection(&quick, Duration::from_secs(20)).expect("an answer");
    assert_eq!(parse_connection_line(&out).map(|l| l.takes_window), Some(true));

    let slow = fake_launcher("slow", "{}", 30);
    let t0 = Instant::now();
    assert_eq!(ask_connection(&slow, Duration::from_millis(800)), None);
    assert!(t0.elapsed() < Duration::from_secs(10), "it waited {:?}", t0.elapsed());
}

/// The review's third case end to end: `serve --window` ends before its ready line (here, a serve that refuses the
/// option), and the window's next attempt is its bundled host, which comes up
#[test]
fn a_serve_window_that_ends_before_its_ready_line_leaves_a_working_bundled_host() {
    struct Seen(Mutex<Vec<HostStatus>>);
    impl StatusSink for Arc<Seen> {
        fn status(&self, status: &HostStatus) {
            self.0.lock().unwrap().push(status.clone());
        }
    }
    let node = resolve_node().expect("node for the test");
    let fallback = Arc::new(ServeFallback::default());
    let launcher: Launcher = {
        let fallback = fallback.clone();
        let node = node.clone();
        Arc::new(move || {
            let script = match fallback.next() {
                // What a serve from before --window answers
                Pick::Serve => "process.stderr.write('unknown option for serve: --window\\n'); process.exit(2)",
                // The bundled host: its ready line, then it runs until its stdin ends
                Pick::Bundle => "console.log(JSON.stringify({ ready: true, port: 4242, token: 't' })); process.stdin.on('end', () => process.exit(0)); process.stdin.resume()",
            };
            Ok(HostLaunch { program: node.clone(), args: vec!["-e".into(), script.into()], env: Vec::new(), token: None })
        })
    };
    let seen = Arc::new(Seen(Mutex::new(Vec::new())));
    let sup = Supervisor::new();
    assert!(sup.start(Arc::new(FallbackSink { inner: seen.clone(), fallback: fallback.clone() }), launcher));
    let end = Instant::now() + Duration::from_secs(30);
    while sup.info().is_none() && Instant::now() < end {
        std::thread::sleep(Duration::from_millis(50));
    }
    let info = sup.info();
    sup.shutdown();
    assert_eq!(info.map(|i| i.port), Some(4242), "statuses: {:?}", seen.0.lock().unwrap());
    assert!(fallback.fell_back());
    assert!(seen.0.lock().unwrap().iter().any(|s| matches!(s, HostStatus::Ready(_))));
}

/// What `serve --stop` prints (`answerLine`), after whatever a login shell said first
fn stop_line(ok: bool, was_running: bool, message: &str) -> String {
    format!("some motd\r\n{{\"v\":1,\"stop\":{{\"ok\":{ok},\"wasRunning\":{was_running},\"message\":{}}}}}\r\n", serde_json::to_string(message).unwrap())
}

/// The answer for a folder held by another Centralu host, which serve leaves alone
const HELD_BY_OTHER: &str = r#"{"v":1,"stop":{"ok":true,"wasRunning":false,"heldByOther":true,"message":"centralu serve is not running for C:/d. It belongs to another Centralu host (pid 7), started by the app; not stopping it"}}"#;

#[test]
fn reads_serve_stops_answer_as_stopped_unless_it_says_the_host_is_still_there() {
    assert_eq!(parse_stop_line(&stop_line(true, true, "")), Ok(StopAnswer::Stopped));
    // Nothing ran when it looked: not a stop, since one may be starting
    assert_eq!(parse_stop_line(&stop_line(true, false, "no centralu serve has run for C:/d")), Ok(StopAnswer::NotRunning));
    assert_eq!(parse_stop_line(&stop_line(false, true, "the host is busy")), Err("the host is busy".to_string()));
    assert!(parse_stop_line(&stop_line(false, true, "")).is_err());
    // Held by another Centralu host: nothing was stopped, and the dialog says whose it is
    assert!(parse_stop_line(HELD_BY_OTHER).unwrap_err().contains("belongs to another Centralu host (pid 7)"));
    assert!(parse_stop_line("CENTRALU-NOT-FOUND\n").is_err());
    assert!(parse_stop_line("").is_err());
}

#[test]
fn stops_the_serve_host_through_the_launcher_and_reports_what_it_could_not_stop() {
    let stopped = fake_launcher("stop-ok", stop_line(true, true, "").trim(), 0);
    assert_eq!(stop_serve(&stopped, Duration::from_secs(20)), Ok(StopAnswer::Stopped));
    let refused = fake_launcher("stop-refused", stop_line(false, true, "the lock names pid 7, which centralu serve did not start").trim(), 0);
    assert_eq!(stop_serve(&refused, Duration::from_secs(20)), Err("the lock names pid 7, which centralu serve did not start".to_string()));
    let hung = fake_launcher("stop-hung", "{}", 30);
    assert_eq!(stop_serve(&hung, Duration::from_millis(800)), Err("centralu serve --stop gave no answer in time".to_string()));
    // A launcher that is not there never ran: it is said so, not that it gave no answer
    let gone = std::env::temp_dir().join(format!("cc-serve-stop-gone-{}", std::process::id())).join("centralu");
    assert!(stop_serve(&gone, Duration::from_secs(5)).unwrap_err().starts_with("centralu serve --stop could not be started"));
}

/// A launcher that records its arguments and `CENTRALU_STOP_BY` in `args.txt` beside it and answers `answer`: `.cmd` on Windows, a shell script elsewhere
fn recording_launcher(name: &str, answer: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("cc-serve-stop-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let marker = dir.join("args.txt");
    let _ = std::fs::remove_file(&marker);
    let launcher = if cfg!(windows) {
        let p = dir.join("centralu.cmd");
        std::fs::write(&p, format!("@echo off\r\necho %* %CENTRALU_STOP_BY%> \"{}\"\r\necho {answer}\r\n", marker.display())).unwrap();
        p
    } else {
        let p = dir.join("centralu");
        std::fs::write(&p, format!("#!/bin/sh\necho \"$@\" \"$CENTRALU_STOP_BY\" > '{}'\necho '{answer}'\n", marker.display())).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    };
    (launcher, marker)
}

/// A host whose attempt of this window has begun (`next`) and, when `ready`, said so
fn host_in(launcher: std::path::PathBuf, ready: bool) -> (ServeHost, Arc<ServeFallback>) {
    let fallback = Arc::new(ServeFallback::default());
    assert_eq!(fallback.next(), Pick::Serve);
    if ready {
        fallback.ready();
    }
    (ServeHost::new(launcher, fallback.clone()), fallback)
}

/// #1466: "Quit completely" in a window on the serve host did nothing, and left the host running
#[test]
fn quit_completely_on_the_serve_host_runs_serve_stop_as_a_quit_and_says_why_it_could_not() {
    let (launcher, marker) = recording_launcher("ok", r#"{"v":1,"stop":{"ok":true,"wasRunning":true}}"#);
    let (host, _) = host_in(launcher, true);
    assert_eq!(host.stop(), Ok(()));
    // `CENTRALU_STOP_BY=quit`: the mark a linked hub words as "by quitting Centralu there"
    assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "serve --stop quit");

    let (launcher, _) = recording_launcher("refused", r#"{"v":1,"stop":{"ok":false,"wasRunning":true,"message":"the host is busy"}}"#);
    let (host, _) = host_in(launcher, true);
    assert_eq!(host.stop(), Err("the host is busy".to_string()), "the dialog stays open and says why");

    // The folder is held by another Centralu host: nothing was stopped, so the window does not quit as if it had
    let (launcher, _) = recording_launcher("held", HELD_BY_OTHER);
    let (host, _) = host_in(launcher, true);
    assert!(host.stop().unwrap_err().contains("belongs to another Centralu host"));
}

#[test]
fn a_window_that_fell_back_to_its_own_host_stops_nothing_through_serve() {
    let (launcher, marker) = recording_launcher("fallback", r#"{"v":1,"stop":{"ok":true,"wasRunning":true}}"#);
    let (host, fallback) = host_in(launcher, false);
    fallback.next(); // the serve attempt ended before its ready line
    assert!(!host.active());
    assert_eq!(host.stop(), Ok(()));
    assert!(!marker.exists(), "the bundled host the window runs is stopped by quitting");
}

/// The review of #1964: a stop 0.7 s after `serve --window` began answered "not running", the host came up at 1.7 s and
/// kept running, and the window quit
#[test]
fn a_stop_while_the_serve_host_is_starting_waits_for_it_and_stops_it() {
    let (host, fallback) = host_in(std::path::PathBuf::from("unused"), false);
    assert!(fallback.starting());
    let ready = fallback.clone();
    let t = std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(300));
        ready.ready();
    });
    let asked_while_starting = Mutex::new(Vec::new());
    let r = host.stop_with(
        || {
            asked_while_starting.lock().unwrap().push(fallback.starting());
            Ok(StopAnswer::Stopped)
        },
        Duration::from_secs(20),
    );
    t.join().unwrap();
    assert_eq!(r, Ok(()));
    assert_eq!(*asked_while_starting.lock().unwrap(), vec![false], "asked once, after the attempt was ready");
}

#[test]
fn a_not_running_answer_given_as_an_attempt_began_is_asked_again() {
    let (host, fallback) = host_in(std::path::PathBuf::from("unused"), true);
    let asked = Mutex::new(0);
    let r = host.stop_with(
        || {
            let mut n = asked.lock().unwrap();
            *n += 1;
            if *n == 1 {
                // The window's supervisor began an attempt while serve --stop looked, and the host was not there yet
                fallback.next();
                let ready = fallback.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(200));
                    ready.ready();
                });
                Ok(StopAnswer::NotRunning)
            } else {
                Ok(StopAnswer::Stopped)
            }
        },
        Duration::from_secs(20),
    );
    assert_eq!(r, Ok(()));
    // Not running with nothing starting is a stop that needs none
    let (host, _) = host_in(std::path::PathBuf::from("unused"), true);
    assert_eq!(host.stop_with(|| Ok(StopAnswer::NotRunning), Duration::from_secs(20)), Ok(()));
}

#[test]
fn a_stop_gives_up_with_a_message_when_the_host_never_finishes_starting() {
    let (host, _) = host_in(std::path::PathBuf::from("unused"), false);
    let t0 = Instant::now();
    let r = host.stop_with(|| Ok(StopAnswer::NotRunning), Duration::from_millis(400));
    assert_eq!(r, Err("the host is still starting; try again in a moment".to_string()));
    assert!(t0.elapsed() < Duration::from_secs(10));
}

/// What the supervisor reports and stops is what the slot holds (`Supervisor::build`, `stop_agents`)
#[test]
fn the_slot_reports_serve_while_the_window_runs_on_it_and_stops_it() {
    let slot = ServeSlot::default();
    assert!(!slot.serving());
    assert_eq!(slot.stop(), Ok(()), "a window with a host of its own has nothing to stop through serve");
    let (launcher, marker) = recording_launcher("slot", r#"{"v":1,"stop":{"ok":true,"wasRunning":true}}"#);
    let (host, fallback) = host_in(launcher, true);
    slot.remember(Some(host));
    assert!(slot.serving());
    assert_eq!(slot.stop(), Ok(()));
    assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), "serve --stop quit");
    fallback.next();
    fallback.next(); // the serve attempt ended before its ready line: the bundled host
    assert!(!slot.serving());
    slot.remember(None);
    assert!(!slot.serving());
}
