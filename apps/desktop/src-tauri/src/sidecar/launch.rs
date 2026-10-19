//! The direct path: the window starts the host as its own child.

use super::*;
use centralu_keeper_core::serve_window::Pick;

/// The direct path's launch: the bundled host through the system Node, `CC_HOST_CMD`, or the
/// source through tsx — exactly what the app ran before the keeper existed. The plan's `host` says
/// which. On Windows with `centralu serve` installed in the data folder, the folder's serve host
/// through its launcher (`Host::Serve`, #1223).
pub(super) fn direct_launcher(start: &Start) -> Launcher {
    let (host, dev, bundled, serve, fallback) = (start.plan.host, start.plan.dev, start.bundled.clone(), start.serve.clone(), start.fallback.clone());
    Arc::new(move || {
        if let (Some(Host::Serve), Some(launcher)) = (host, &serve) {
            // A `serve --window` that ended before its ready line hands every later attempt to the bundled host (#1223 review)
            match (fallback.next(), &bundled) {
                (Pick::Bundle, Some(dir)) => {
                    let mut launch = host_proc::bundled_launch(&dir.join("main.mjs"), &[])?;
                    launch.env.push(started_by_app());
                    return Ok(launch);
                }
                _ => return Ok(serve_launch(launcher)),
            }
        }
        let mut launch: HostLaunch = match (host, host_proc::host_cmd_override(), &bundled) {
            (Some(Host::Command), Some((program, args)), _) => HostLaunch { program, args, env: Vec::new(), token: None },
            (Some(Host::Bundle), _, Some(dir)) => host_proc::bundled_launch(&dir.join("main.mjs"), &[])?,
            _ => {
                let mut source = host_proc::source_launch(&[]);
                source.env.push(started_by_app());
                return Ok(source);
            }
        };
        // Who started it, for host.lock: a second host on the folder names this window's (#1223)
        if host == Some(Host::Bundle) {
            launch.env.push(started_by_app());
        }
        // A host launched from dev uses a **different data folder** than the release app.
        // If two hosts held the same folder, the session lists would get out of sync.
        if dev {
            launch.env.push(("CC_DEV".into(), "1".into()));
        }
        Ok::<_, LaunchError>(launch)
    })
}

/// `CC_STARTED_BY=app`, which the host writes to host.lock (`takeLaunchEnv` in agent-host)
fn started_by_app() -> (String, String) {
    ("CC_STARTED_BY".into(), "app".into())
}

/// `<launcher> serve --window`: the folder's serve host, started in this sign-in when none runs, and its port and
/// token as a ready line (`runWindow` in the npm launcher's serve-window.mjs). The launcher is a `.cmd`, which Rust
/// starts through `cmd.exe` with its arguments escaped; these two need no escaping.
fn serve_launch(launcher: &std::path::Path) -> HostLaunch {
    HostLaunch { program: launcher.to_string_lossy().to_string(), args: vec!["serve".into(), "--window".into()], env: Vec::new(), token: None }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_serve_host_is_asked_for_through_the_launcher_with_no_token_of_the_window() {
        let l = serve_launch(std::path::Path::new("C:/Users/me/.centralu/remote/bin/centralu.cmd"));
        assert_eq!(l.program, "C:/Users/me/.centralu/remote/bin/centralu.cmd");
        assert_eq!(l.args, vec!["serve".to_string(), "--window".to_string()]);
        assert!(l.token.is_none());
        assert!(l.env.is_empty());
    }

    /// #1223's review: a `serve --window` attempt that ends before its ready line makes the next one the bundled host
    #[test]
    fn the_launcher_runs_the_bundled_host_after_a_serve_attempt_that_never_got_ready() {
        use centralu_keeper_core::start_plan::{Build, Env, Facts, Os, Shell};
        let facts = Facts { os: Os::Windows, build: Build::Release, env: Env::default(), bundled_host: true, keeper_answering: false, shell: Shell::Untried, serve_usable: true };
        let plan = start_plan::plan(&facts);
        assert_eq!(plan.host, Some(Host::Serve));
        let dir = std::env::temp_dir().join(format!("cc-launch-fallback-{}", std::process::id()));
        let start = Start {
            plan,
            facts,
            bundled: Some(dir.clone()),
            serve: Some(dir.join("centralu.cmd")),
            fallback: Arc::new(ServeFallback::default()),
            resources: None,
        };
        let launcher = direct_launcher(&start);
        let first = launcher().expect("a launch");
        assert_eq!(first.args, vec!["serve".to_string(), "--window".to_string()]);
        // No ready line came: the bundled host, said to be the window's
        let second = launcher().expect("a launch");
        assert!(second.args.iter().any(|a| a.ends_with("main.mjs")), "{second:?}");
        assert!(second.env.contains(&("CC_STARTED_BY".to_string(), "app".to_string())));
    }
}
