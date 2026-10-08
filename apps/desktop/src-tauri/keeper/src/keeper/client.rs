//! The app's side of the control socket: find or launch the keeper, ask it things, and stay
//! attached to it.

use std::fs::OpenOptions;
use std::io::{self, BufRead, BufReader, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::os;

/// The longest line either side accepts. A view is a few hundred bytes; this only bounds a peer
/// that never sends a newline.
pub const MAX_LINE: u64 = 256 * 1024;

/// Reads one line, refusing one longer than `MAX_LINE`.
pub fn read_line<R: BufRead>(reader: &mut R) -> io::Result<Option<String>> {
    let mut buf = String::new();
    let n = io::Read::take(&mut *reader, MAX_LINE).read_line(&mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if !buf.ends_with('\n') && n as u64 >= MAX_LINE {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "line too long"));
    }
    Ok(Some(buf))
}

/// One request, one answer, then the connection closes.
pub fn request(sock: &Path, req: &Value, timeout: Duration) -> Result<Value, String> {
    let mut stream = UnixStream::connect(sock).map_err(|e| format!("cannot reach the keeper at {}: {e}", sock.display()))?;
    stream.set_read_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(timeout)).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_vec(req).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| format!("the keeper did not take the request: {e}"))?;
    let mut reader = BufReader::new(stream);
    let answer = read_line(&mut reader)
        .map_err(|e| format!("the keeper did not answer: {e}"))?
        .ok_or("the keeper closed the connection without answering")?;
    let v: Value = serde_json::from_str(&answer).map_err(|e| format!("the keeper's answer is not JSON: {e}"))?;
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        Ok(v)
    } else {
        Err(v.get("error").and_then(Value::as_str).unwrap_or("the keeper refused").to_string())
    }
}

/// Whether a keeper answers on this socket.
pub fn alive(sock: &Path) -> bool {
    request(sock, &json!({ "op": "status" }), Duration::from_secs(2)).is_ok()
}

/// A live attach connection. Its being open is what tells the keeper a window is attached;
/// closing it (or this process ending, however it ends) is the detach.
pub struct Attached {
    stream: UnixStream,
}

impl Attached {
    pub fn close(&self) {
        let _ = self.stream.shutdown(std::net::Shutdown::Both);
    }
}

/**
 * Attaches: sends `attach` with this app's build, returns the keeper's first answer, and then
 * hands every pushed line to `on_event` on a reader thread until the connection ends, when
 * `on_close` runs.
 */
pub fn attach(
    sock: &Path,
    build: Option<&super::source::BuildSource>,
    on_event: impl Fn(Value) + Send + 'static,
    on_close: impl FnOnce() + Send + 'static,
) -> Result<(Value, Attached), String> {
    let mut stream = UnixStream::connect(sock).map_err(|e| format!("cannot reach the keeper at {}: {e}", sock.display()))?;
    stream.set_read_timeout(Some(Duration::from_secs(10))).map_err(|e| e.to_string())?;
    stream.set_write_timeout(Some(Duration::from_secs(5))).map_err(|e| e.to_string())?;
    let mut line = serde_json::to_vec(&json!({
        "op": "attach",
        "protocol": super::KEEPER_PROTOCOL,
        "build": build,
    }))
    .map_err(|e| e.to_string())?;
    line.push(b'\n');
    stream.write_all(&line).map_err(|e| format!("the keeper did not take the attach: {e}"))?;
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let first = read_line(&mut reader)
        .map_err(|e| format!("the keeper did not answer the attach: {e}"))?
        .ok_or("the keeper closed the connection without answering")?;
    let first: Value = serde_json::from_str(&first).map_err(|e| format!("the keeper's answer is not JSON: {e}"))?;
    if first.get("ok").and_then(Value::as_bool) != Some(true) {
        return Err(first.get("error").and_then(Value::as_str).unwrap_or("the keeper refused the attach").to_string());
    }
    // From here on the connection only carries pushed events, and may be quiet for days.
    stream.set_read_timeout(None).map_err(|e| e.to_string())?;
    thread::spawn(move || {
        while let Ok(Some(line)) = read_line(&mut reader) {
            if let Ok(v) = serde_json::from_str::<Value>(&line) {
                on_event(v);
            }
        }
        on_close();
    });
    Ok((first, Attached { stream }))
}

/**
 * Launches a keeper detached from this process: its own session, stdin from `/dev/null`, stdout
 * and stderr appended to `log`. The child is reaped on a thread so a keeper that exits at once
 * (another one already holds the folder) does not linger as a zombie while the app runs.
 */
pub fn launch_detached(exe: &Path, args: &[String], env: &[(String, String)], log: &Path) -> io::Result<()> {
    let mut child = spawn_detached(exe, args, env, log)?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// `launch_detached` without the reaping thread: the caller waits on the child itself. The shell
/// does, to tell a keeper that exited at once from one that is still starting.
pub fn spawn_detached(exe: &Path, args: &[String], env: &[(String, String)], log: &Path) -> io::Result<std::process::Child> {
    // User-only, like everything else the keeper writes: the host's stderr lands here too.
    let out = OpenOptions::new().create(true).append(true).mode(0o600).open(log)?;
    let err = out.try_clone()?;
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null()).stdout(out).stderr(err);
    for (k, v) in env {
        cmd.env(k, v);
    }
    os::new_session(&mut cmd);
    cmd.spawn()
}

/// Waits up to `timeout` for a keeper just launched to answer on `sock`. A keeper that is still
/// stopping holds its lock until it exits; the new one waits for that lock, so this waits too.
pub fn wait_alive(sock: &Path, timeout: Duration) -> Result<(), String> {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        if alive(sock) {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(format!("the keeper did not answer within {}s (see keeper.log in the data folder)", timeout.as_secs()))
}

/// The `.app` the given executable lives in, or the executable itself off macOS.
pub fn bundle_of(exe: &Path) -> PathBuf {
    exe.ancestors()
        .find(|p| p.extension().map(|e| e == "app").unwrap_or(false))
        .map(Path::to_path_buf)
        .unwrap_or_else(|| exe.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_app_bundle_around_the_executable() {
        assert_eq!(
            bundle_of(Path::new("/Applications/Centralu.app/Contents/MacOS/centralu")),
            PathBuf::from("/Applications/Centralu.app")
        );
        assert_eq!(bundle_of(Path::new("/usr/bin/centralu")), PathBuf::from("/usr/bin/centralu"));
    }

    #[test]
    fn a_line_without_an_end_is_refused_past_the_cap() {
        let long = "x".repeat(MAX_LINE as usize + 10);
        let mut r = BufReader::new(long.as_bytes());
        assert!(read_line(&mut r).is_err());
        let mut ok = BufReader::new(&b"{\"ok\":true}\n"[..]);
        assert_eq!(read_line(&mut ok).unwrap().as_deref(), Some("{\"ok\":true}\n"));
    }
}
