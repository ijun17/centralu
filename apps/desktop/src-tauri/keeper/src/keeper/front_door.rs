//! The front door (#280, option C step 3): one address every client uses, whichever host is current.
//!
//! The app's webview, a browser pointed at the keeper's host, and every Codex orchestrator bridge
//! connect here instead of to a host. The keeper forwards each connection, byte for byte, to the
//! current host's own port. When the host is swapped, the connections through the door are closed,
//! clients reconnect to the same address, and the door hands them to the new host.
//!
//! Why a byte relay and a token the keeper owns, rather than the keeper checking the token itself:
//!   - **The keeper parses nothing** (#280, "the keeper does three things only"). Checking the token
//!     would mean reading the WebSocket upgrade and the first frame, which ties the keeper to the
//!     host's protocol; a relay of bytes cannot be broken by a change to that protocol. The HTTP
//!     door (app views) rides the same relay for free.
//!   - **The token stays stable anyway.** The keeper makes one per keeper lifetime and hands it to
//!     every host it starts (`CC_HOST_TOKEN`), so the host checks the same token clients already
//!     hold, and the Origin rule still sees the browser's own header. A Codex bridge, which gets its
//!     address and token once when its thread starts, keeps working across every swap.
//!
//! The door listens on loopback only. Anyone on this machine can open a TCP connection to it, as
//! they can to a host today; what they cannot do without the token is get past the host's `hello`.
//! The token reaches clients only through the user-only control socket and the host's environment.
//!
//! While no host is ready (the gap between one host draining and the next one reporting ready), a
//! new connection is **held**, not refused: it waits up to `PARK_LIMIT` for a host, so a client
//! that reconnects at once lands on the new host as soon as it is up instead of failing and backing
//! off.

//!
//! **Handing the door over** (#280 step 4). The listener and every relayed connection outlive this
//! keeper: `freeze` parks every relay between two copies (no byte is in the keeper's hands then)
//! and returns duplicates of the listener and of both sockets of each relay, which the next keeper
//! adopts and goes on pumping. A client relayed through the door does not notice the keeper change
//! at all: its TCP connection to the door and the door's connection to the host are the same
//! sockets, now copied by another process. A rolled-back handoff `thaw`s the relays where they
//! stopped. Each relay is one thread polling both sockets (rather than one blocking thread per
//! direction, as in step 3) precisely so it can be stopped at a point where it holds nothing.

use std::collections::HashMap;
use std::io::{self, Read};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long a connection waits for a host while none is ready. A swap's gap is the drain bound
/// (10 s) plus the new host's activation; past this a client is better off reconnecting.
pub const PARK_LIMIT: Duration = Duration::from_secs(45);

/// How long connecting to the current host may take: it is on loopback, so this only catches a
/// host that stopped accepting.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// How often a relay and the accept loop look up from their sockets to see whether they are asked
/// to stop for a handoff. It bounds how long a freeze waits for an idle relay.
const TICK_MS: i32 = 50;
/// How long one side may refuse the relay's bytes before the connection is given up (#392).
///
/// The relay writes with blocking writes, and a peer that stops reading (a stopped Codex bridge,
/// any loopback client that hangs) blocked one forever: its thread, its descriptors and full socket
/// buffers stayed until the next swap, and every keeper handoff failed meanwhile, since a freeze
/// waits for each relay to finish its copy. A live client reads within this; the bridge reconnects
/// on its next call.
#[cfg(not(test))]
const STALL_LIMIT: Duration = Duration::from_secs(30);
#[cfg(test)]
const STALL_LIMIT: Duration = Duration::from_millis(300);

/// One relayed connection's sockets, kept so a swap can close them and a handoff can copy them.
struct Relay {
    client: TcpStream,
    /// None while the relay is still waiting for a host.
    upstream: Option<TcpStream>,
}

#[derive(Default)]
struct Door {
    /// The current host's port, or None while there is no host to hand connections to.
    target: Option<u16>,
    /// Bumped every time the target changes or the door is cleared, so a connection that read the
    /// old target just before a swap does not slip through to the host being replaced.
    generation: u64,
    /// Every relayed connection, to close them on a swap or copy them in a handoff.
    conns: HashMap<u64, Relay>,
    next_id: u64,
    /// Asked to stop all I/O for a handoff (step 4).
    frozen: bool,
    /// Relay threads alive, and how many of them have stopped for the freeze.
    active: usize,
    parked: usize,
    /// The accept loop has stopped for the freeze.
    accept_parked: bool,
}

struct Shared {
    door: Mutex<Door>,
    changed: Condvar,
    /// `door.frozen`, readable without the lock on every tick.
    frozen: AtomicBool,
}

#[derive(Clone)]
pub struct FrontDoor {
    port: u16,
    token: String,
    shared: Arc<Shared>,
    listener: Arc<TcpListener>,
}

/// What a frozen door hands to the next keeper: the listener and each relay's sockets.
pub struct DoorFreeze {
    pub listener: TcpListener,
    pub target: Option<u16>,
    pub relays: Vec<(TcpStream, Option<TcpStream>)>,
}

/// A door rebuilt from another keeper's, not running yet (nothing is read before `start`).
pub struct PendingDoor {
    door: FrontDoor,
    relays: Vec<(TcpStream, Option<TcpStream>)>,
}

impl PendingDoor {
    pub fn door(&self) -> &FrontDoor {
        &self.door
    }

    /// Starts accepting and pumping. Called once the handoff is committed.
    pub fn start(self) -> FrontDoor {
        for (client, upstream) in self.relays {
            let me = self.door.clone();
            let id = me.register(&client, upstream.as_ref());
            thread::spawn(move || me.relay(id, client, upstream));
        }
        self.door.start_accepting();
        self.door
    }
}

impl FrontDoor {
    /// Binds `127.0.0.1:port` (0 picks a free one) and starts accepting. Connections wait until
    /// `point_at` names a host.
    pub fn open(port: u16, token: String) -> io::Result<FrontDoor> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))?;
        let door = FrontDoor::from_listener(listener, token, None)?;
        door.start_accepting();
        Ok(door)
    }

    fn from_listener(listener: TcpListener, token: String, target: Option<u16>) -> io::Result<FrontDoor> {
        let port = listener.local_addr()?.port();
        listener.set_nonblocking(true)?;
        let door = Door { target, ..Default::default() };
        Ok(FrontDoor {
            port,
            token,
            shared: Arc::new(Shared { door: Mutex::new(door), changed: Condvar::new(), frozen: AtomicBool::new(false) }),
            listener: Arc::new(listener),
        })
    }

    /// Rebuilds a door another keeper froze (#280 step 4): the same listener, so the same port, the
    /// same token, the same target, and its relays, all idle until `PendingDoor::start`.
    pub fn adopt(f: DoorFreeze, token: String) -> io::Result<PendingDoor> {
        let door = FrontDoor::from_listener(f.listener, token, f.target)?;
        Ok(PendingDoor { door, relays: f.relays })
    }

    fn start_accepting(&self) {
        let me = self.clone();
        thread::spawn(move || me.accept_loop());
    }

    fn accept_loop(&self) {
        loop {
            if self.shared.frozen.load(Ordering::SeqCst) {
                self.park_accept();
            }
            let mut p = libc::pollfd { fd: self.listener.as_raw_fd(), events: libc::POLLIN, revents: 0 };
            // SAFETY: one valid pollfd.
            if unsafe { libc::poll(&mut p, 1, TICK_MS) } <= 0 {
                continue;
            }
            match self.listener.accept() {
                Ok((stream, _)) => {
                    // The listener is non-blocking for the poll; the relay wants blocking writes.
                    let _ = stream.set_nonblocking(false);
                    let id = self.register(&stream, None);
                    let me = self.clone();
                    thread::spawn(move || me.relay(id, stream, None));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {}
                Err(e) => eprintln!("[keeper] front door accept failed: {e}"),
            }
        }
    }

    /// Counts a relay thread before it starts, so a freeze waits for it too.
    fn register(&self, client: &TcpStream, upstream: Option<&TcpStream>) -> u64 {
        let Ok(mut d) = self.shared.door.lock() else { return 0 };
        let id = d.next_id;
        d.next_id += 1;
        d.active += 1;
        if let Ok(c) = client.try_clone() {
            d.conns.insert(id, Relay { client: c, upstream: upstream.and_then(|u| u.try_clone().ok()) });
        }
        id
    }

    /// Stops the accept loop while the door is frozen.
    fn park_accept(&self) {
        let Ok(mut d) = self.shared.door.lock() else { return };
        d.accept_parked = true;
        self.shared.changed.notify_all();
        while d.frozen {
            d = match self.shared.changed.wait(d) {
                Ok(d) => d,
                Err(_) => return,
            };
        }
        d.accept_parked = false;
    }

    /// Stops a relay thread while the door is frozen; the freeze counts the parked ones.
    fn park_relay(&self) {
        let Ok(mut d) = self.shared.door.lock() else { return };
        d.parked += 1;
        self.shared.changed.notify_all();
        while d.frozen {
            d = match self.shared.changed.wait(d) {
                Ok(d) => d,
                Err(_) => return,
            };
        }
        d.parked -= 1;
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

    /// Closes every connection relayed right now. Their clients see the socket close and connect
    /// again, to whichever host the door points at by then. Returns how many were closed.
    pub fn close_all(&self) -> usize {
        let conns: Vec<Relay> = match self.shared.door.lock() {
            Ok(mut d) => {
                d.generation += 1;
                d.conns.drain().map(|(_, r)| r).collect()
            }
            Err(_) => return 0,
        };
        for r in &conns {
            let _ = r.client.shutdown(Shutdown::Both);
            if let Some(u) = &r.upstream {
                let _ = u.shutdown(Shutdown::Both);
            }
        }
        conns.len()
    }

    /// Connections being relayed right now.
    pub fn open_connections(&self) -> usize {
        self.shared.door.lock().map(|d| d.conns.len()).unwrap_or(0)
    }

    /**
     * Stops all I/O for a keeper handoff and returns copies of the listener and every relay's
     * sockets. Waits up to `wait` for each relay to finish the copy it is in; a relay stuck on a
     * client that does not read fails the freeze (the handoff then rolls back).
     */
    pub fn freeze(&self, wait: Duration) -> Result<DoorFreeze, String> {
        let deadline = Instant::now() + wait;
        let mut d = self.shared.door.lock().map_err(|_| "front door lock poisoned")?;
        d.frozen = true;
        self.shared.frozen.store(true, Ordering::SeqCst);
        self.shared.changed.notify_all();
        while !(d.accept_parked && d.parked == d.active) {
            let Some(left) = deadline.checked_duration_since(Instant::now()) else {
                drop(d);
                self.thaw();
                return Err("a front door connection did not pause in time".into());
            };
            d = self.shared.changed.wait_timeout(d, left).map_err(|_| "front door lock poisoned")?.0;
        }
        let e = |e: io::Error| e.to_string();
        let mut relays = Vec::new();
        for r in d.conns.values() {
            relays.push((r.client.try_clone().map_err(e)?, r.upstream.as_ref().map(|u| u.try_clone()).transpose().map_err(e)?));
        }
        Ok(DoorFreeze { listener: self.listener.try_clone().map_err(e)?, target: d.target, relays })
    }

    /// Resumes a frozen door: the handoff was rolled back.
    pub fn thaw(&self) {
        if let Ok(mut d) = self.shared.door.lock() {
            d.frozen = false;
        }
        self.shared.frozen.store(false, Ordering::SeqCst);
        self.shared.changed.notify_all();
    }

    /// Waits for a host, connects to it, then copies bytes both ways until either side closes.
    fn relay(&self, id: u64, client: TcpStream, upstream: Option<TcpStream>) {
        let upstream = match upstream {
            Some(u) => Some(u),
            None => self.connect_upstream(id, &client),
        };
        if let Some(upstream) = upstream {
            self.pump(&client, &upstream);
        }
        self.forget(id);
    }

    fn connect_upstream(&self, id: u64, client: &TcpStream) -> Option<TcpStream> {
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
            let Ok(mut d) = self.shared.door.lock() else { return None };
            if d.generation != generation {
                // The door moved while this one was connecting: try again against the new target
                drop(d);
                let _ = upstream.shutdown(Shutdown::Both);
                continue;
            }
            match d.conns.get_mut(&id) {
                Some(r) => r.upstream = upstream.try_clone().ok(),
                // Closed by a swap while connecting
                None => {
                    let _ = upstream.shutdown(Shutdown::Both);
                    return None;
                }
            }
            return Some(upstream);
        }
    }

    /// One thread for both directions: poll, copy what is there, and between copies look up for a
    /// freeze. A copy in progress is always finished first, so a parked relay holds no bytes.
    fn pump(&self, client: &TcpStream, upstream: &TcpStream) {
        // A write that cannot finish within the limit fails, and the relay ends like any other error
        let _ = client.set_write_timeout(Some(STALL_LIMIT));
        let _ = upstream.set_write_timeout(Some(STALL_LIMIT));
        let _ = client.set_nodelay(true);
        let _ = upstream.set_nodelay(true);
        let mut buf = [0u8; 16 * 1024];
        'outer: loop {
            if self.shared.frozen.load(Ordering::SeqCst) {
                self.park_relay();
            }
            let mut fds = [
                libc::pollfd { fd: client.as_raw_fd(), events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: upstream.as_raw_fd(), events: libc::POLLIN, revents: 0 },
            ];
            // SAFETY: two valid pollfds.
            let n = unsafe { libc::poll(fds.as_mut_ptr(), 2, TICK_MS) };
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
            if d.frozen {
                drop(d);
                self.park_relay();
                d = self.shared.door.lock().ok()?;
                continue;
            }
            if let Some(port) = d.target {
                return Some((port, d.generation));
            }
            let left = deadline.checked_duration_since(Instant::now())?;
            d = self.shared.changed.wait_timeout(d, left).ok()?.0;
        }
    }

    fn forget(&self, id: u64) {
        if let Ok(mut d) = self.shared.door.lock() {
            d.conns.remove(&id);
            d.active = d.active.saturating_sub(1);
        }
        self.shared.changed.notify_all();
    }
}

/// A token for the door: 16 random bytes from the OS, as hex.
pub fn new_token() -> io::Result<String> {
    let mut bytes = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

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

    #[test]
    fn relays_bytes_to_the_current_host_unchanged() {
        let (a, _ka) = fake_host("A");
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(Some(a));
        let mut c = connect(&door);
        assert_eq!(ask(&mut c, "hello").unwrap(), "A:hello");
    }

    /// The swap: connections through the door are closed, and reconnecting to the same address
    /// reaches the new host.
    #[test]
    fn a_swap_closes_the_old_connections_and_the_same_address_reaches_the_new_host() {
        let (a, _ka) = fake_host("A");
        let (b, _kb) = fake_host("B");
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(Some(a));
        let mut old = connect(&door);
        assert_eq!(ask(&mut old, "1").unwrap(), "A:1");

        door.point_at(Some(b));
        assert_eq!(door.close_all(), 1);
        assert!(ask(&mut old, "2").map(|l| l.is_empty()).unwrap_or(true), "the old connection is closed");

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
        (&c).write_all(b"hi\n").unwrap();
        let t0 = Instant::now();
        while door.open_connections() > 0 && t0.elapsed() < Duration::from_secs(10) {
            thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(door.open_connections(), 0, "the relay still holds a client that never reads");
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

    /// The keeper handoff (#280 step 4): a connection relayed by one keeper's door goes on through
    /// the door the next keeper rebuilt from it, on the same socket, with nothing to reconnect; and
    /// the address stays the same for new connections.
    #[test]
    fn a_relayed_connection_survives_a_handoff_of_the_door() {
        let (a, _ka) = fake_host("H");
        let old = FrontDoor::open(0, "t".into()).unwrap();
        old.point_at(Some(a));
        let mut c = connect(&old);
        assert_eq!(ask(&mut c, "1").unwrap(), "H:1");

        let frozen = old.freeze(Duration::from_secs(3)).unwrap();
        assert_eq!(frozen.relays.len(), 1);
        assert_eq!(frozen.target, Some(a));
        let new = FrontDoor::adopt(frozen, old.token().to_string()).unwrap().start();
        assert_eq!(new.port(), old.port(), "the address never changes");

        assert_eq!(ask(&mut c, "2").unwrap(), "H:2", "the same client socket, now pumped by the new keeper");
        let mut fresh = connect(&new);
        assert_eq!(ask(&mut fresh, "3").unwrap(), "H:3", "new connections reach the new keeper's accept loop");
    }

    /// While frozen the door copies nothing, and what a client sent meanwhile is delivered after a
    /// rollback, not lost: the frozen keeper did not read it ahead.
    #[test]
    fn a_frozen_door_holds_bytes_and_a_thaw_delivers_them() {
        let (a, _ka) = fake_host("H");
        let door = FrontDoor::open(0, "t".into()).unwrap();
        door.point_at(Some(a));
        let mut c = connect(&door);
        assert_eq!(ask(&mut c, "1").unwrap(), "H:1");
        let _frozen = door.freeze(Duration::from_secs(3)).unwrap();
        c.set_read_timeout(Some(Duration::from_millis(400))).unwrap();
        assert!(ask(&mut c, "2").is_err(), "nothing is relayed while frozen");
        door.thaw();
        c.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let mut r = io::BufReader::new(c.try_clone().unwrap());
        let mut line = String::new();
        io::BufRead::read_line(&mut r, &mut line).unwrap();
        assert_eq!(line.trim(), "H:2");
    }

    #[test]
    fn listens_on_loopback_only() {
        let door = FrontDoor::open(0, "t".into()).unwrap();
        assert!(door.url().starts_with("ws://127.0.0.1:"));
        assert_eq!(new_token().unwrap().len(), 32);
        assert_ne!(new_token().unwrap(), new_token().unwrap());
    }
}
