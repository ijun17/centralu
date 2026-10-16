//! Ending children: an exited agent's group swept, and the keeper's own stop of everything left.

use super::*;

pub(super) struct Stopping {
    pub(super) phase: u8,
    pub(super) deadline: Instant,
    pub(super) done: Vec<mpsc::Sender<()>>,
    /// Every terminal's session (its shell's pid), running or not: each step signals every group in
    /// it, so a job the shell put in a group of its own ends with the stop too (#840 item 2).
    pub(super) sessions: Vec<i32>,
}

/**
 * The process group of an agent that has exited, still to be swept (#350's rule: only that group).
 *
 * An agent CLI starts helpers of its own (Claude Code's LSP tool runs a language server, which runs
 * `tsserver`; MCP servers from the user's config; shells) and they share its group, which `setsid`
 * made the agent's own. A CLI that ends without stopping them (killed after a timeout, crashed, or
 * just not cleaning up) left them running under launchd/init. So when an agent exits, its group gets
 * TERM at once and, `SWEEP_GRACE` later, KILL for whatever is still there (`proc::signal_leftovers`).
 * Ptys are not swept (only the keeper's own stop reaches every group in a terminal's session,
 * `Stopping::sessions`): the kernel hangs up a terminal's foreground group as its shell exits, and the
 * host ends a terminal's or a command's whole tree when it stops one (`kill-tree.ts`).
 */
pub(super) struct Sweep {
    pub(super) pgid: i32,
    pub(super) due: Instant,
}

impl Reactor {
    pub(super) fn collect_exits(&mut self) {
        for (pid, st) in self.watch.collect() {
            let Some((&n, c)) = self.children.iter_mut().find(|(_, c)| c.pid == pid && c.exit.is_none()) else {
                continue;
            };
            c.exit = Some(st);
            c.exited_at = Some(Instant::now());
            log(&format!("{} pid {pid} exited (code {:?}, signal {:?})", child_id(n), st.code, st.signal));
            if c.kind == Kind::Pipes {
                if proc::signal_leftovers(pid, libc::SIGTERM) {
                    log(&format!("{}: TERM to what it left in its process group", child_id(n)));
                }
                self.sweeps.push(Sweep { pgid: pid, due: Instant::now() + SWEEP_GRACE });
            }
            self.tell_hosts(&json!({ "event": "exit", "id": child_id(n), "code": st.code, "signal": st.signal }));
        }
    }

    /// KILL to the groups whose grace has run out; groups that emptied are forgotten.
    pub(super) fn sweep(&mut self) {
        let now = Instant::now();
        self.sweeps.retain(|s| {
            if !proc::group_exists(s.pgid) {
                return false;
            }
            if now < s.due {
                return true;
            }
            if proc::signal_leftovers(s.pgid, libc::SIGKILL) {
                log(&format!("KILL to what pid {} left in its process group", s.pgid));
            }
            false
        });
    }

    /// Whether the child whose pid this is still runs (not exited as far as this keeper knows).
    pub(super) fn is_running(&self, pid: i32) -> bool {
        self.children.values().any(|c| c.pid == pid && c.exit.is_none())
    }

    /// `sig` to every group in each terminal session (`proc::signal_session`).
    pub(super) fn signal_sessions(&self, sessions: &[i32], sig: i32) {
        for &sid in sessions {
            proc::signal_session(sid, sig, self.is_running(sid));
        }
    }

    pub(super) fn housekeeping(&mut self) {
        // A host asked to stop has finished once no control connection is left.
        if !self.host_stop_waiters.is_empty() && !self.conns.values().any(|c| matches!(c.role, Role::Control)) {
            for w in self.host_stop_waiters.drain(..) {
                let _ = w.send(());
            }
        }
        self.sweep();
        if let Some(mut s) = self.stopping.take() {
            let live: Vec<i32> = self.children.values().filter(|c| c.exit.is_none()).map(|c| c.pid).collect();
            let now = Instant::now();
            let given_up = s.phase >= 2 && now >= s.deadline;
            let sessions_left = s.sessions.iter().any(|&sid| proc::session_exists(sid, self.is_running(sid)));
            if (live.is_empty() && self.sweeps.is_empty() && !sessions_left) || given_up {
                if !live.is_empty() {
                    log(&format!("{} children did not exit after KILL", live.len()));
                }
                // Nothing runs after this keeper to sweep later: what agents left gets its KILL now,
                // and so does what is left in a terminal's session.
                for sw in self.sweeps.drain(..) {
                    proc::signal_leftovers(sw.pgid, libc::SIGKILL);
                }
                self.signal_sessions(&s.sessions, libc::SIGKILL);
                let _ = fs::remove_file(&self.shared.sock);
                for d in s.done.drain(..) {
                    let _ = d.send(());
                }
            } else {
                if now >= s.deadline {
                    let sig = if s.phase == 0 { libc::SIGTERM } else { libc::SIGKILL };
                    for pid in live {
                        let _ = proc::signal(pid, sig, true);
                    }
                    self.signal_sessions(&s.sessions, sig);
                    s.phase += 1;
                    s.deadline = now + Duration::from_secs(1);
                }
                self.stopping = Some(s);
            }
        }
        let exited: Vec<(Instant, u64)> =
            self.children.iter().filter_map(|(&n, c)| c.exited_at.map(|t| (t, n))).collect();
        if exited.len() > MAX_EXITED {
            let over = exited.len() - MAX_EXITED;
            let mut exited = exited;
            exited.sort();
            for (_, n) in exited.into_iter().take(over) {
                self.remove_child(n);
            }
        }
    }
}
