//! The direct path: the window starts the host as its own child.

use super::*;

/// The direct path's launch: the bundled host through the system Node, `CC_HOST_CMD`, or the
/// source through tsx — exactly what the app ran before the keeper existed. The plan's `host` says
/// which.
pub(super) fn direct_launcher(start: &Start) -> Launcher {
    let (host, dev, bundled) = (start.plan.host, start.plan.dev, start.bundled.clone());
    Arc::new(move || {
        let mut launch: HostLaunch = match (host, host_proc::host_cmd_override(), &bundled) {
            (Some(Host::Command), Some((program, args)), _) => HostLaunch { program, args, env: Vec::new(), token: None },
            (Some(Host::Bundle), _, Some(dir)) => host_proc::bundled_launch(&dir.join("main.mjs"), &[])?,
            _ => return Ok(host_proc::source_launch(&[])),
        };
        // A host launched from dev uses a **different data folder** than the release app.
        // If two hosts held the same folder, the session lists would get out of sync.
        if dev {
            launch.env.push(("CC_DEV".into(), "1".into()));
        }
        Ok::<_, LaunchError>(launch)
    })
}
