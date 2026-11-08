//! The front door (#280, option C step 3): one address every client uses, whichever host is current.
//!
//! The app's webview, a browser pointed at the keeper's host, and every Codex orchestrator bridge
//! connect here instead of to a host. The keeper forwards each connection, byte for byte, to the
//! current host's own port. When the host restarts (a crash), its connections end, clients reconnect to
//! the same address, and the door hands them to the new host run.
//!
//! Why a byte relay and a token the keeper owns, rather than the keeper checking the token itself:
//!   - **The keeper parses nothing** (#280, "the keeper does three things only"). Checking the token
//!     would mean reading the WebSocket upgrade and the first frame, which ties the keeper to the
//!     host's protocol; a relay of bytes cannot be broken by a change to that protocol. The HTTP
//!     door (app views) rides the same relay for free.
//!   - **The token stays stable anyway.** The keeper makes one per keeper lifetime and hands it to
//!     every host it starts (on the host's stdin, #538), so the host checks the same token clients already
//!     hold, and the Origin rule still sees the browser's own header. A Codex bridge, which gets its
//!     address and a credential derived from this token once when its thread starts, keeps working
//!     across every host restart (the host's `transport/bridge-token.ts`, #382).
//!
//! The door listens on loopback only. Anyone on this machine can open a TCP connection to it, as
//! they can to a host today; what they cannot do without the token is get past the host's `hello`.
//! The token reaches clients only through the user-only control socket and the host's environment.
//!
//! While no host is ready (the gap between one host run ending and the next one reporting ready), a
//! new connection is **held**, not refused: it waits up to `PARK_LIMIT` for a host, so a client
//! that reconnects at once lands on the new host as soon as it is up instead of failing and backing
//! off.
//!
//! Each relay is one thread polling both sockets, with a bound on how long either side may refuse its
//! bytes (`STALL_LIMIT`).


use std::io::{self, Read};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use super::accept::{self, AcceptErrors};

/// How long a connection waits for a host while none is ready: a host restarting comes back within this; past it a client
/// is better off reconnecting.
pub const PARK_LIMIT: Duration = Duration::from_secs(45);

/// How long connecting to the current host may take: it is on loopback, so this only catches a
/// host that stopped accepting.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// How long one side may refuse the relay's bytes before the connection is given up (#392).
///
/// The relay writes with blocking writes, and a peer that stops reading (a stopped Codex bridge,
/// any loopback client that hangs) blocked one forever: its thread, its descriptors and full socket
/// buffers stayed for the keeper's life. A live client reads within this; the bridge reconnects
/// on its next call.
#[cfg(not(test))]
const STALL_LIMIT: Duration = Duration::from_secs(30);
#[cfg(test)]
const STALL_LIMIT: Duration = Duration::from_millis(300);

/// The most connections the door relays at once; one past it is closed as it is accepted (#840
/// item 3). Each relay holds two descriptors and a thread, and anyone on this machine can connect to
/// the door: without a bound, a client opening connections in a loop ran the keeper out of
/// descriptors, and with them every agent, terminal and window it serves. A window, its app views and
/// every Codex bridge together use a few dozen.
#[cfg(not(test))]
const MAX_RELAYS: usize = 1024;
#[cfg(test)]
const MAX_RELAYS: usize = 16;

#[derive(Default)]
struct Door {
    /// The current host's port, or None while there is no host to hand connections to.
    target: Option<u16>,
    /// Bumped every time the target changes, so a connection that read the old target just before
    /// a restart does not slip through to the host run that ended.
    generation: u64,
    /// Relay threads alive, connected to a host or still waiting for one. Each holds its two sockets and nothing else
    /// does (#840 item 3: a table that duplicated them held four descriptors per relay).
    active: usize,
}

struct Shared {
    door: Mutex<Door>,
    changed: Condvar,
}

#[derive(Clone)]
pub struct FrontDoor {
    port: u16,
    token: String,
    shared: Arc<Shared>,
    listener: Arc<TcpListener>,
}

impl FrontDoor {
    /// Binds `127.0.0.1:port` (0 picks a free one) and starts accepting. Connections wait until
    /// `point_at` names a host.
    pub fn open(port: u16, token: String) -> io::Result<FrontDoor> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))?;
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let door = FrontDoor {
            port,
            token,
            shared: Arc::new(Shared { door: Mutex::new(Door::default()), changed: Condvar::new() }),
            listener: Arc::new(listener),
        };
        door.start_accepting();
        Ok(door)
    }

    fn start_accepting(&self) {
        let me = self.clone();
        thread::spawn(move || me.accept_loop());
    }

    fn accept_loop(&self) {
        let mut errors = AcceptErrors::new(log);
        let mut refused = 0u64;
        loop {
            let mut p = libc::pollfd { fd: self.listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            if unsafe { libc::poll(&mut p, 1, -1) } <= 0 {
                continue;
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    errors.accepted();
                    if self.relays() >= MAX_RELAYS {
                        // Logged once per run of refusals, not once per connection
                        if refused == 0 {
                            log(&format!("is relaying {MAX_RELAYS} connections, the most it takes; closing new ones until one ends"));
                        }
                        refused += 1;
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                    if refused > 0 {
                        log(&format!("takes connections again after closing {refused}"));
                        refused = 0;
                    }
                    // The listener is non-blocking for the poll; the relay wants blocking writes.
                    let _ = stream.set_nonblocking(false);
                    self.start_relay(stream);
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => thread::sleep(errors.failed(&e)),
            }
        }
    }

    /// Starts the thread that relays one connection. One the OS refuses is closed and forgotten,
    /// never a panic (`accept::spawn`).
    fn start_relay(&self, client: TcpStream) {
        // Counted before it starts, so the cap sees it at once
        if let Ok(mut d) = self.shared.door.lock() {
            d.active += 1;
        }
        let me = self.clone();
        // Refused: the socket goes with the closure.
        if let Err(e) = accept::spawn("keeper-relay", move || me.relay(client)) {
            log(&format!("could not start a relay: {e}"));
            self.forget();
        }
    }

    /// Relay threads alive, connected to a host or still waiting for one.
    fn relays(&self) -> usize {
        self.shared.door.lock().map(|d| d.active).unwrap_or(0)
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    pub fn token(&self) -> &str {
        &self.token
    }

    /// The WebSocket address clients are given.
    pub fn url(&self) -> String {
        format!("ws://127.0.0.1:{}", self.port)
    }

    /// Where new connections go: a host's port, or None to hold them until there is one.
    pub fn point_at(&self, target: Option<u16>) {
        if let Ok(mut d) = self.shared.door.lock() {
            if d.target != target {
                d.target = target;
                d.generation += 1;
            }
        }
        self.shared.changed.notify_all();
    }

    pub fn target(&self) -> Option<u16> {
        self.shared.door.lock().ok().and_then(|d| d.target)
    }

    /// Waits for a host, connects to it, then copies bytes both ways until either side closes.
    fn relay(&self, client: TcpStream) {
        if let Some(upstream) = self.connect_upstream(&client) {
            self.pump(&client, &upstream);
        }
        self.forget();
    }

    fn connect_upstream(&self, client: &TcpStream) -> Option<TcpStream> {
        let deadline = Instant::now() + PARK_LIMIT;
        loop {
            let Some((port, generation)) = self.wait_for_target(deadline) else {
                let _ = client.shutdown(Shutdown::Both);
                return None;
            };
            let upstream = match TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), CONNECT_TIMEOUT) {
                Ok(s) => s,
                Err(_) => {
                    // A host on its way out: wait for the door to move on, unless time is up
                    if Instant::now() >= deadline {
                        let _ = client.shutdown(Shutdown::Both);
                        return None;
                    }
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            let Ok(d) = self.shared.door.lock() else { return None };
            if d.generation != generation {
                // The door moved while this one was connecting: try again against the new target
                drop(d);
                let _ = upstream.shutdown(Shutdown::Both);
                continue;
            }
            return Some(upstream);
        }
    }

    /// One thread for both directions: poll, copy what is there.
    fn pump(&self, client: &TcpStream, upstream: &TcpStream) {
        // A write that cannot finish within the limit fails, and the relay ends like any other error
        let _ = client.set_write_timeout(Some(STALL_LIMIT));
        let _ = upstream.set_write_timeout(Some(STALL_LIMIT));
        let _ = client.set_nodelay(true);
        let _ = upstream.set_nodelay(true);
        let mut buf = [0u8; 16 * 1024];
        'outer: loop {
            let mut fds = [
                libc::pollfd { fd: client.as_raw_fd(), events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: upstream.as_raw_fd(), events: libc::POLLIN, revents: 0 },
            ];
            // SAFETY: two valid pollfds.
            let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) };
            if n < 0 {
                if io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            for (i, p) in fds.iter().enumerate() {
                if p.revents == 0 {
                    continue;
                }
                let (mut from, mut to) = if i == 0 { (client, upstream) } else { (upstream, client) };
                match from.read(&mut buf) {
                    Ok(0) | Err(_) => break 'outer,
                    Ok(k) => {
                        if io::Write::write_all(&mut to, &buf[..k]).is_err() {
                            break 'outer;
                        }
                    }
                }
            }
        }
        // One side ended: close both, so the other side's peer sees it too.
        let _ = client.shutdown(Shutdown::Both);
        let _ = upstream.shutdown(Shutdown::Both);
    }

    fn wait_for_target(&self, deadline: Instant) -> Option<(u16, u64)> {
        let mut d = self.shared.door.lock().ok()?;
        loop {
            if let Some(port) = d.target {
                return Some((port, d.generation));
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            d = self.shared.changed.wait_timeout(d, left).ok()?.0;
        }
    }

    fn forget(&self) {
        if let Ok(mut d) = self.shared.door.lock() {
            d.active = d.active.saturating_sub(1);
        }
        self.shared.changed.notify_all();
    }
}

fn log(msg: &str) {
    eprintln!("[keeper] front door {msg}");
}

/// A token for the door: 16 random bytes from the OS, as hex.
pub fn new_token() -> io::Result<String> {
    Ok(content_verify::hex(&crate::os::random_bytes::<16>()?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};

    /// A one-line echo server standing in for a host: answers every line with `<name>:<line>`.
    fn fake_host(name: &'static str) -> (u16, TcpListener) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        let accept = l.try_clone().unwrap();
        thread::spawn(move || {
            for s in accept.incoming().flatten() {
                thread::spawn(move || {
                    let mut r = io::BufReader::new(s.try_clone().unwrap());
                    let mut w = s;
                    let mut line = String::new();
                    while io::BufRead::read_line(&mut r, &mut line).map(|n| n > 0).unwrap_or(false) {
                        let _ = w.write_all(format!("{name}:{line}").as_bytes());
                        line.clear();
                    }
                });
            }
        });
        (port, l)
    }

    fn ask(s: &mut TcpStream, what: &str) -> io::Result<String> {
        s.write_all(format!("{what}\n").as_bytes())?;
        let mut r = io::BufReader::new(s.try_clone()?);
        let mut line = String::new();
        io::BufRead::read_line(&mut r, &mut line)?;
        Ok(line.trim().to_string())
    }

    fn connect(door: &FrontDoor) -> TcpStream {
        let s = TcpStream::connect(("127.0.0.1", door.port())).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        s
    }

    /// An echo host that holds one descriptor per connection (no reader clone), so a test can count
    /// what the door itself holds.
    fn lean_host() -> u16 {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            for s in l.incoming().flatten() {
                thread::spawn(move || {
                    let mut b = [0u8; 256];
                    while let Ok(n) = (&s).read(&mut b) {
                        if n == 0 || (&s).write_all(&b[..n]).is_err() {
                            break;
                        }
                    }
                });
            }
        });
        port
    }

    /// Descriptors this process has open.
    fn open_descriptors() -> usize {
        std::fs::read_dir("/dev/fd").map(|d| d.count()).unwrap_or(0)
    }

    /// A connection relayed and answered: its relay is up with both sockets.
    fn relayed(door: &FrontDoor) -> TcpStream {
        let mut c = connect(door);
        c.write_all(b"x").unwrap();
        let mut b = [0u8; 1];
        c.read_exact(&mut b).unwrap();
        c
    }

    /// #840 item 3: a relay holds one descriptor per socket. Each socket was also duplicated for the
    /// door's table, four per relay, so far fewer clients ran the keeper out of descriptors. Counted
    /// in a process of its own, where no other test opens anything meanwhile.
    #[test]
    fn a_relay_holds_one_descriptor_per_socket() {
        if crate::keeper::accept::few_descriptors::rerun("keeper::front_door::tests::a_relay_holds_one_descriptor_per_socket").is_some() {
            return;
        }
        let host = lean_host();
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(Some(host));
        let warm = relayed(&door);
        let before = open_descriptors();
        let n = 10;
        let clients: Vec<TcpStream> = (0..n).map(|_| relayed(&door)).collect();
        let per_relay = (open_descriptors() - before) as f64 / n as f64;
        drop(clients);
        drop(warm);
        // The test's client, the door's two sockets, the host's end
        assert!(per_relay <= 4.0, "{per_relay} descriptors per relayed connection");
    }

    /// #840 item 3: past `MAX_RELAYS` a new connection is closed as it comes, and once one ends the
    /// door takes them again.
    #[test]
    fn connections_past_the_cap_are_closed_until_one_ends() {
        let host = lean_host();
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(Some(host));
        let mut held: Vec<TcpStream> = (0..MAX_RELAYS).map(|_| relayed(&door)).collect();
        let mut over = connect(&door);
        let _ = over.write_all(b"x");
        let mut b = [0u8; 1];
        assert!(matches!(over.read(&mut b), Ok(0) | Err(_)), "a connection past the cap was relayed");
        held.pop();
        let end = Instant::now() + Duration::from_secs(5);
        while door.relays() >= MAX_RELAYS && Instant::now() < end {
            thread::sleep(Duration::from_millis(10));
        }
        let mut again = connect(&door);
        again.write_all(b"y").unwrap();
        again.read_exact(&mut b).unwrap();
        assert_eq!(&b, b"y");
    }

    #[test]
    fn relays_bytes_to_the_current_host_unchanged() {
        let (a, _ka) = fake_host("A");
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(Some(a));
        let mut c = connect(&door);
        assert_eq!(ask(&mut c, "hello").unwrap(), "A:hello");
    }

    /// A host restart: the door moves to the new run's port, and a client connecting again to the same address reaches it.
    #[test]
    fn after_a_restart_the_same_address_reaches_the_new_host_run() {
        let (a, _ka) = fake_host("A");
        let (b, _kb) = fake_host("B");
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(Some(a));
        let mut old = connect(&door);
        assert_eq!(ask(&mut old, "1").unwrap(), "A:1");
        door.point_at(Some(b));
        let mut again = connect(&door);
        assert_eq!(ask(&mut again, "3").unwrap(), "B:3");
    }

    /// A client that stops reading does not hold its relay forever (#392).
    #[test]
    fn a_client_that_stops_reading_is_let_go() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        thread::spawn(move || {
            for mut s in l.incoming().flatten() {
                // A host with a lot to say
                thread::spawn(move || while s.write_all(&[b'x'; 64 * 1024]).is_ok() {});
            }
        });
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(Some(port));
        let c = connect(&door);
        // Read the host's first bytes, so the relay is known to exist and to be copying before
        // the wait for it to go. `connect` returns before the door accepts; checking at once saw no
        // relay yet and passed whether or not a stalled one is let go, and failed when the accept
        // landed between that check and the assert (#368).
        let mut first = [0u8; 1];
        io::Read::read_exact(&mut &c, &mut first).unwrap();
        assert_eq!(door.relays(), 1);
        let t0 = Instant::now();
        while door.relays() > 0 && t0.elapsed() < Duration::from_secs(10) {
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(door.relays(), 0, "the relay still holds a client that never reads");
        drop(c);
    }

    /// A client that reconnects during the gap waits for the next host instead of failing.
    #[test]
    fn a_connection_made_while_no_host_is_ready_is_held_until_one_is() {
        let (b, _kb) = fake_host("B");
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(None);
        let mut c = connect(&door);
        let d2 = door.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            d2.point_at(Some(b));
        });
        let t0 = Instant::now();
        assert_eq!(ask(&mut c, "x").unwrap(), "B:x");
        assert!(t0.elapsed() >= Duration::from_millis(250));
    }

    #[test]
    fn listens_on_loopback_only() {
        let door = FrontDoor::open(0, "t".into()).unwrap();
        assert!(door.url().starts_with("ws://127.0.0.1:"));
        assert_eq!(new_token().unwrap().len(), 32);
        assert_ne!(new_token().unwrap(), new_token().unwrap());
    }

    /// #840 item 3, the door's half: out of descriptors, the accept loop came straight back to the
    /// connection waiting in the queue, a core spinning and a log line each time. It pauses now, and
    /// relays again once a descriptor is free.
    #[test]
    fn a_door_out_of_descriptors_pauses_accepting_instead_of_spinning() {
        let Some(stderr) =
            super::super::accept::few_descriptors::rerun("keeper::front_door::tests::a_door_out_of_descriptors_pauses_accepting_instead_of_spinning")
        else {
            let (a, _ka) = fake_host("A");
            let door = FrontDoor::open(0, "t".into()).unwrap();
            door.point_at(Some(a));
            use super::super::accept::few_descriptors::{exhaust, Spare};
            let waiting = Spare::new(libc::AF_INET);
            let held = exhaust(64);
            // Linux leaves it in the listen queue; macOS drops it with the failed accept.
            let _waiting = waiting.connect_tcp(door.port());
            thread::sleep(Duration::from_secs(1));
            drop(held);
            let mut c = connect(&door);
            assert_eq!(ask(&mut c, "hello").unwrap(), "A:hello", "relayed once a descriptor was free");
            return;
        };
        super::super::accept::few_descriptors::assert_accepts_paused(&stderr, "the door");
    }
}
