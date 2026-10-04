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

use std::collections::HashMap;
use std::io::{self, Read};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

/// How long a connection waits for a host while none is ready. A swap's gap is the drain bound
/// (10 s) plus the new host's activation; past this a client is better off reconnecting.
pub const PARK_LIMIT: Duration = Duration::from_secs(45);

/// How long connecting to the current host may take: it is on loopback, so this only catches a
/// host that stopped accepting.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Default)]
struct Door {
    /// The current host's port, or None while there is no host to hand connections to.
    target: Option<u16>,
    /// Bumped every time the target changes or the door is cleared, so a connection that read the
    /// old target just before a swap does not slip through to the host being replaced.
    generation: u64,
    /// The client side of every relayed connection, to close them on a swap.
    conns: HashMap<u64, TcpStream>,
    next_id: u64,
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
}

impl FrontDoor {
    /// Binds `127.0.0.1:port` (0 picks a free one) and starts accepting. Connections wait until
    /// `point_at` names a host.
    pub fn open(port: u16, token: String) -> io::Result<FrontDoor> {
        let listener = TcpListener::bind(SocketAddr::from(([127, 0, 0, 1], port)))?;
        let port = listener.local_addr()?.port();
        let door = FrontDoor {
            port,
            token,
            shared: Arc::new(Shared { door: Mutex::new(Door::default()), changed: Condvar::new() }),
        };
        let me = door.clone();
        thread::spawn(move || {
            for conn in listener.incoming() {
                match conn {
                    Ok(stream) => {
                        let me = me.clone();
                        thread::spawn(move || me.relay(stream));
                    }
                    Err(e) => eprintln!("[keeper] front door accept failed: {e}"),
                }
            }
        });
        Ok(door)
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
        let conns: Vec<TcpStream> = match self.shared.door.lock() {
            Ok(mut d) => {
                d.generation += 1;
                d.conns.drain().map(|(_, s)| s).collect()
            }
            Err(_) => return 0,
        };
        for c in &conns {
            let _ = c.shutdown(Shutdown::Both);
        }
        conns.len()
    }

    /// Connections being relayed right now.
    pub fn open_connections(&self) -> usize {
        self.shared.door.lock().map(|d| d.conns.len()).unwrap_or(0)
    }

    /// Waits for a host, connects to it and copies bytes both ways until either side closes.
    fn relay(&self, client: TcpStream) {
        let deadline = Instant::now() + PARK_LIMIT;
        let (upstream, id) = loop {
            let Some((port, generation)) = self.wait_for_target(deadline) else {
                let _ = client.shutdown(Shutdown::Both);
                return;
            };
            let upstream = match TcpStream::connect_timeout(&SocketAddr::from(([127, 0, 0, 1], port)), CONNECT_TIMEOUT) {
                Ok(s) => s,
                Err(_) => {
                    // A host on its way out: wait for the door to move on, unless time is up
                    if Instant::now() >= deadline {
                        let _ = client.shutdown(Shutdown::Both);
                        return;
                    }
                    thread::sleep(Duration::from_millis(100));
                    continue;
                }
            };
            let Ok(registered) = client.try_clone() else { return };
            let Ok(mut d) = self.shared.door.lock() else { return };
            if d.generation != generation {
                // The door moved while this one was connecting: try again against the new target
                drop(d);
                let _ = upstream.shutdown(Shutdown::Both);
                continue;
            }
            let id = d.next_id;
            d.next_id += 1;
            d.conns.insert(id, registered);
            break (upstream, id);
        };
        let _ = client.set_nodelay(true);
        let _ = upstream.set_nodelay(true);
        let (Ok(c2), Ok(u2)) = (client.try_clone(), upstream.try_clone()) else {
            self.forget(id);
            return;
        };
        let back = thread::spawn(move || pump(u2, c2));
        pump(client, upstream);
        let _ = back.join();
        self.forget(id);
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

    fn forget(&self, id: u64) {
        if let Ok(mut d) = self.shared.door.lock() {
            d.conns.remove(&id);
        }
    }
}

/// Copies one direction until it ends, then closes both sockets so the other direction ends too.
fn pump(mut from: TcpStream, mut to: TcpStream) {
    let mut buf = [0u8; 16 * 1024];
    loop {
        match from.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if io::Write::write_all(&mut to, &buf[..n]).is_err() {
                    break;
                }
            }
        }
    }
    let _ = from.shutdown(Shutdown::Both);
    let _ = to.shutdown(Shutdown::Both);
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
}
