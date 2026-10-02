//! The remote screen straight to the browser (F-18, 2026-10-03): a WebRTC data channel (str0m, UDP) next to the
//! gateway path. The page offers through the gateway — `screen.rtc {streamId, offer}` → `{answer}`, the only
//! signalling — and the answer carries this PC's candidates: one UDP socket per local address (host) and what a
//! STUN server sees of each (server reflexive). No TURN: where no direct path forms, the page stays on the gateway.
//! On the channel go the stream's frames exactly as on the gateway path (`[kind][flags][seq][data]`), cut into
//! 16 KB messages `[last u8][bytes]`; the page acks the frames it has shown as text `{"ack":seq}` (screen::ack, as
//! from the gateway). A viewer whose channel is more than QUEUE_MAX behind skips to the next keyframe (asked for).
//! Windows: inbound UDP needs a firewall rule — added once by the elevated runner; a limited runner offers no P2P.

use futures_util::future::join_all;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use str0m::change::SdpOffer;
use str0m::channel::ChannelId;
use str0m::net::{Protocol, Receive};
use str0m::{Candidate, Event, IceConnectionState, Input, Output, Rtc};
use tokio::net::UdpSocket;
use tokio::sync::mpsc;

/// what the page uses too (session.ts)
const STUN: &str = "stun.cloudflare.com:3478";
const CHUNK: usize = 16 * 1024;
const QUEUE_MAX: usize = 1024 * 1024;
const MAX_PEERS: usize = 8;
const CONNECT_WITHIN: Duration = Duration::from_secs(20);

struct Peer {
    stream: u32,
    tx: mpsc::UnboundedSender<Arc<Vec<u8>>>,
}

fn peers() -> &'static Mutex<Vec<Peer>> {
    static PEERS: OnceLock<Mutex<Vec<Peer>>> = OnceLock::new();
    PEERS.get_or_init(Default::default)
}

/// This runner can open direct connections (caps feature "p2p").
pub fn available() -> bool {
    #[cfg(windows)]
    return crate::proc_util::is_elevated();
    #[cfg(not(windows))]
    true
}

/// A frame of `stream` (as tagged for the gateway) to its direct viewers.
pub fn frame(stream: u32, payload: &[u8]) {
    let mut g = peers().lock().unwrap();
    if !g.iter().any(|p| p.stream == stream) {
        return;
    }
    let shared = Arc::new(payload.to_vec());
    g.retain(|p| p.stream != stream || p.tx.send(shared.clone()).is_ok());
}

/// The stream has ended: its direct viewers close.
pub fn close(stream: u32) {
    peers().lock().unwrap().retain(|p| p.stream != stream);
}

/// `screen.rtc`: answer the page's offer and start the peer.
pub async fn open(stream: u32, offer: &str) -> Result<Value, (i64, String)> {
    if !available() {
        return Err((-32030, "관리자 권한 없이 실행 중인 러너는 직접 연결(P2P)을 열지 않습니다".into()));
    }
    {
        let mut g = peers().lock().unwrap();
        g.retain(|p| !p.tx.is_closed());
        if g.len() >= MAX_PEERS {
            return Err((-32006, format!("직접 연결은 최대 {MAX_PEERS}개입니다")));
        }
    }
    let offer = SdpOffer::from_sdp_string(offer).map_err(|e| (-32602, format!("offer: {e}")))?;
    #[cfg(windows)]
    tokio::task::spawn_blocking(firewall).await.map_err(|e| (-32000, e.to_string()))??;
    let socks = bind_all().await;
    if socks.is_empty() {
        return Err((-32000, "UDP 소켓을 열 수 없습니다".into()));
    }
    let mut rtc = Rtc::builder().build(Instant::now());
    for (_, local) in &socks {
        if let Ok(c) = Candidate::host(*local, "udp") {
            rtc.add_local_candidate(c);
        }
    }
    for (base, mapped) in reflexive_all(&socks).await {
        if let Ok(c) = Candidate::server_reflexive(mapped, base, "udp") {
            rtc.add_local_candidate(c);
        }
    }
    let answer = rtc.sdp_api().accept_offer(offer).map_err(|e| (-32602, format!("offer: {e}")))?;
    let (tx, rx) = mpsc::unbounded_channel();
    peers().lock().unwrap().push(Peer { stream, tx });
    tokio::spawn(run(rtc, socks, rx, stream));
    Ok(json!({ "answer": answer.to_sdp_string() }))
}

/// Inbound UDP for this program (Windows Defender Firewall would block it, or ask on the desktop): one rule, once.
#[cfg(windows)]
fn firewall() -> Result<(), (i64, String)> {
    use crate::proc_util::NoWindow;
    use std::os::windows::process::CommandExt;
    static DONE: OnceLock<bool> = OnceLock::new();
    let ok = *DONE.get_or_init(|| {
        let Ok(exe) = std::env::current_exe() else { return false };
        let netsh = |args: &str| std::process::Command::new("netsh").raw_arg(format!("advfirewall firewall {args}")).no_window().output().is_ok_and(|o| o.status.success());
        let program = format!("program=\"{}\"", exe.display());
        // a rule left by the program at another path follows it here
        if netsh("show rule name=aidev-runner-p2p") {
            return netsh(&format!("set rule name=aidev-runner-p2p new {program}"));
        }
        netsh(&format!("add rule name=aidev-runner-p2p dir=in action=allow protocol=UDP profile=any enable=yes {program}"))
    });
    if ok { Ok(()) } else { Err((-32000, "Windows 방화벽에 직접 연결(UDP) 규칙을 추가하지 못했습니다".into())) }
}

fn usable(ip: &IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => !v.is_loopback() && !v.is_link_local() && !v.is_unspecified(),
        IpAddr::V6(v) => !v.is_loopback() && !v.is_unspecified() && (v.segments()[0] & 0xffc0) != 0xfe80,
    }
}

/// One UDP socket per usable local address (at most 8).
async fn bind_all() -> Vec<(Arc<UdpSocket>, SocketAddr)> {
    let mut ips: Vec<IpAddr> = if_addrs::get_if_addrs().unwrap_or_default().into_iter().map(|i| i.ip()).filter(usable).collect();
    ips.dedup();
    let mut out = Vec::new();
    for ip in ips.into_iter().take(8) {
        if let Ok(s) = UdpSocket::bind(SocketAddr::new(ip, 0)).await {
            if let Ok(local) = s.local_addr() {
                out.push((Arc::new(s), local));
            }
        }
    }
    out
}

/// What the STUN server sees of each IPv4 socket, where it differs from the socket (NAT); 0.7 s at most.
async fn reflexive_all(socks: &[(Arc<UdpSocket>, SocketAddr)]) -> Vec<(SocketAddr, SocketAddr)> {
    let work = async {
        let Some(server) = tokio::net::lookup_host(STUN).await.ok().and_then(|mut a| a.find(SocketAddr::is_ipv4)) else { return vec![] };
        let asks = socks.iter().filter(|(_, l)| l.is_ipv4()).map(|(s, l)| async move { reflexive(s, server).await.filter(|m| m != l).map(|m| (*l, m)) });
        let mut found: Vec<(SocketAddr, SocketAddr)> = join_all(asks).await.into_iter().flatten().collect();
        found.dedup_by_key(|(_, m)| *m);
        found
    };
    tokio::time::timeout(Duration::from_millis(700), work).await.unwrap_or_default()
}

const MAGIC: u32 = 0x2112_A442;

/// A STUN binding request (RFC 5389) from `sock`; the mapped address of the answer.
async fn reflexive(sock: &UdpSocket, server: SocketAddr) -> Option<SocketAddr> {
    let mut req = [0u8; 20];
    req[1] = 1;
    req[4..8].copy_from_slice(&MAGIC.to_be_bytes());
    rand::Rng::fill(&mut rand::thread_rng(), &mut req[8..20]);
    sock.send_to(&req, server).await.ok()?;
    let mut buf = [0u8; 576];
    loop {
        let (n, from) = sock.recv_from(&mut buf).await.ok()?;
        if from == server && n >= 20 && buf[..2] == [1, 1] && buf[8..20] == req[8..20] {
            return mapped(&buf[20..n]);
        }
    }
}

/// XOR-MAPPED-ADDRESS (or MAPPED-ADDRESS) of a binding response's attributes, IPv4.
fn mapped(mut attrs: &[u8]) -> Option<SocketAddr> {
    let mut plain = None;
    while attrs.len() >= 4 {
        let (kind, len) = (u16::from_be_bytes([attrs[0], attrs[1]]), usize::from(u16::from_be_bytes([attrs[2], attrs[3]])));
        let v = attrs.get(4..4 + len)?;
        if v.len() >= 8 && v[1] == 1 {
            let port = u16::from_be_bytes([v[2], v[3]]);
            let ip = u32::from_be_bytes([v[4], v[5], v[6], v[7]]);
            match kind {
                0x0020 => return Some(SocketAddr::new(IpAddr::from((ip ^ MAGIC).to_be_bytes()), port ^ (MAGIC >> 16) as u16)),
                0x0001 => plain = Some(SocketAddr::new(IpAddr::from(ip.to_be_bytes()), port)),
                _ => {}
            }
        }
        attrs = attrs.get(4 + len.div_ceil(4) * 4..).unwrap_or_default();
    }
    plain
}

/// The channel's side of one peer: what waits to be written, and whether a keyframe is due.
struct Chan {
    id: Option<ChannelId>,
    queue: VecDeque<Vec<u8>>,
    queued: usize,
    need_key: bool,
    connected: bool,
}

impl Chan {
    /// A frame for the open channel.
    fn push(&mut self, frame: &[u8], stream: u32) {
        if frame.len() < 2 {
            return;
        }
        let key = frame[1] & 1 == 1;
        if !key && (self.need_key || self.queued > QUEUE_MAX) {
            if !self.need_key {
                self.need_key = true;
                crate::screen::key(stream);
            }
            return;
        }
        self.need_key = false;
        let n = frame.len().div_ceil(CHUNK);
        for (i, c) in frame.chunks(CHUNK).enumerate() {
            let mut m = Vec::with_capacity(c.len() + 1);
            m.push(u8::from(i + 1 == n));
            m.extend_from_slice(c);
            self.queued += m.len();
            self.queue.push_back(m);
        }
    }
}

/// Everything str0m has to say until its next deadline; None when the peer is over.
fn drain(rtc: &mut Rtc, socks: &[(Arc<UdpSocket>, SocketAddr)], ch: &mut Chan, stream: u32) -> Option<Instant> {
    loop {
        match rtc.poll_output().ok()? {
            Output::Timeout(t) => return Some(t),
            Output::Transmit(t) => {
                let s = socks.iter().find(|(_, l)| *l == t.source).unwrap_or(&socks[0]);
                let _ = s.0.try_send_to(&t.contents, t.destination);
            }
            Output::Event(e) => match e {
                Event::IceConnectionStateChange(IceConnectionState::Disconnected) | Event::ChannelClose(_) => return None,
                Event::Connected => ch.connected = true,
                Event::ChannelOpen(id, _) => {
                    // the first frame on the channel must be a keyframe
                    ch.id = Some(id);
                    ch.need_key = true;
                    crate::screen::key(stream);
                }
                Event::ChannelData(d) if !d.binary => {
                    if let Some(seq) = serde_json::from_slice::<Value>(&d.data).ok().and_then(|v| v.get("ack").and_then(Value::as_u64)) {
                        crate::screen::ack(&json!({ "streamId": stream, "seq": seq }));
                    }
                }
                _ => {}
            },
        }
    }
}

/// Writes what the channel takes (draining after each write); the next deadline, None when the peer is over.
fn pump(rtc: &mut Rtc, socks: &[(Arc<UdpSocket>, SocketAddr)], ch: &mut Chan, stream: u32) -> Option<Instant> {
    let mut deadline = drain(rtc, socks, ch, stream)?;
    while let (Some(id), Some(m)) = (ch.id, ch.queue.front()) {
        let Some(mut c) = rtc.channel(id) else { break };
        if !c.write(true, m).ok()? {
            break;   // the send buffer is full: the rest goes as acks come in
        }
        let n = m.len();
        ch.queue.pop_front();
        ch.queued -= n;
        deadline = drain(rtc, socks, ch, stream)?;
    }
    Some(deadline)
}

enum Wake {
    Net(Vec<u8>, SocketAddr, SocketAddr),
    Frame(Arc<Vec<u8>>),
    Time,
    End,
}

async fn run(mut rtc: Rtc, socks: Vec<(Arc<UdpSocket>, SocketAddr)>, mut frames: mpsc::UnboundedReceiver<Arc<Vec<u8>>>, stream: u32) {
    let (net_tx, mut net) = mpsc::channel::<(Vec<u8>, SocketAddr, SocketAddr)>(512);
    let readers: Vec<_> = socks
        .iter()
        .map(|(s, local)| {
            let (s, local, tx) = (s.clone(), *local, net_tx.clone());
            tokio::spawn(async move {
                let mut buf = vec![0u8; 2048];
                while let Ok((n, from)) = s.recv_from(&mut buf).await {
                    if tx.send((buf[..n].to_vec(), from, local)).await.is_err() {
                        break;
                    }
                }
            })
        })
        .collect();
    let born = Instant::now();
    let mut ch = Chan { id: None, queue: VecDeque::new(), queued: 0, need_key: true, connected: false };
    while let Some(deadline) = pump(&mut rtc, &socks, &mut ch, stream) {
        if !ch.connected && born.elapsed() > CONNECT_WITHIN {
            break;
        }
        let wake = tokio::select! {
            p = net.recv() => p.map_or(Wake::End, |(d, from, to)| Wake::Net(d, from, to)),
            f = frames.recv() => f.map_or(Wake::End, Wake::Frame),
            _ = tokio::time::sleep_until(deadline.into()) => Wake::Time,
        };
        let input = match &wake {
            Wake::Net(d, source, destination) => match d.as_slice().try_into() {
                Ok(contents) => Input::Receive(Instant::now(), Receive { proto: Protocol::Udp, source: *source, destination: *destination, contents }),
                Err(_) => continue,
            },
            Wake::Frame(f) => {
                if ch.id.is_some() {
                    ch.push(f, stream);
                }
                continue;
            }
            Wake::Time => Input::Timeout(Instant::now()),
            Wake::End => break,
        };
        if rtc.handle_input(input).is_err() {
            break;
        }
    }
    rtc.disconnect();
    let _ = drain(&mut rtc, &socks, &mut ch, stream);
    for r in readers {
        r.abort();
    }
    drop(frames);
    peers().lock().unwrap().retain(|p| !p.tx.is_closed());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stun_mapped_address() {
        // XOR-MAPPED-ADDRESS 203.0.113.7:40000 after an unknown attribute of odd length (padded)
        let ip = u32::from_be_bytes([203, 0, 113, 7]) ^ MAGIC;
        let port = 40000u16 ^ 0x2112;
        let mut a = vec![0x80, 0x22, 0, 3, b'a', b'b', b'c', 0];
        a.extend_from_slice(&[0, 0x20, 0, 8, 0, 1]);
        a.extend_from_slice(&port.to_be_bytes());
        a.extend_from_slice(&ip.to_be_bytes());
        assert_eq!(mapped(&a), Some("203.0.113.7:40000".parse().unwrap()));
        assert_eq!(mapped(&[0, 0x20, 0, 8, 0, 1]), None, "cut short");
    }

    #[test]
    fn frames_are_cut_and_a_late_viewer_waits_for_a_keyframe() {
        let mut ch = Chan { id: None, queue: VecDeque::new(), queued: 0, need_key: true, connected: true };
        ch.push(&[4, 2, 0, 0, 0, 2], 999);
        assert!(ch.queue.is_empty(), "a delta frame before any keyframe");
        let key: Vec<u8> = [4, 3, 0, 0, 0, 3].into_iter().chain(std::iter::repeat_n(7, CHUNK * 2)).collect();
        ch.push(&key, 1);
        assert_eq!(ch.queue.iter().map(|m| (m[0], m.len())).collect::<Vec<_>>(), vec![(0, CHUNK + 1), (0, CHUNK + 1), (1, 7)]);
        assert_eq!(ch.queue.iter().flat_map(|m| m[1..].to_vec()).collect::<Vec<_>>(), key);
    }
}
