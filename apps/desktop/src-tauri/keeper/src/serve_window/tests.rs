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
