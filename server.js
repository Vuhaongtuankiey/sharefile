const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { networkInterfaces } = require('os');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ADJECTIVES = ['Swift', 'Brave', 'Cool', 'Wise', 'Bold', 'Kind', 'Calm', 'Wild', 'Eager', 'Neat'];
const ANIMALS = ['Fox', 'Owl', 'Wolf', 'Bear', 'Hawk', 'Lion', 'Deer', 'Seal', 'Lynx', 'Crow'];
const COLORS = ['#6C63FF', '#FF6584', '#43B89C', '#FF8C42', '#4ECDC4', '#A78BFA', '#F59E0B', '#EF4444', '#10B981', '#3B82F6'];

function randomName() {
    const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
    const ani = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
    return `${adj} ${ani}`;
}

function randomColor() {
    return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// ─── MIME types for static serving ───────────────────────────────────────────

const MIME = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
};

// ─── Static file server ───────────────────────────────────────────────────────

const PUBLIC = path.join(__dirname, 'public');

const httpServer = http.createServer((req, res) => {
    let filePath = path.join(PUBLIC, req.url === '/' ? 'index.html' : req.url);
    const ext = path.extname(filePath);
    const mime = MIME[ext] || 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            // fallback to index.html for SPA
            fs.readFile(path.join(PUBLIC, 'index.html'), (e2, d2) => {
                if (e2) { res.writeHead(404); res.end('Not found'); return; }
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(d2);
            });
            return;
        }
        res.writeHead(200, { 'Content-Type': mime });
        res.end(data);
    });
});

// ─── WebSocket Signaling Server ───────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer });

// Single global room — all peers see each other.
// NOTE: IP-based rooms won't work on Render/reverse proxies because
// all clients appear to come from the same proxy IP.
const globalRoom = new Map();  // id -> { ws, id, name, color }
let nextId = 1;

function broadcast(message, excludeId) {
    globalRoom.forEach((peer) => {
        if (peer.id !== excludeId && peer.ws.readyState === 1 /* OPEN */) {
            peer.ws.send(JSON.stringify(message));
        }
    });
}

function getPeerList() {
    return [...globalRoom.values()].map(p => ({ id: p.id, name: p.name, color: p.color }));
}

wss.on('connection', (ws) => {
    const id = nextId++;
    const name = randomName();
    const color = randomColor();

    globalRoom.set(id, { ws, id, name, color });
    console.log(`[+] Peer ${id} "${name}" joined (${globalRoom.size} total)`);

    // Welcome: send own info + current peer list
    ws.send(JSON.stringify({ type: 'welcome', id, name, color, peers: getPeerList() }));

    // Notify everyone else
    broadcast({ type: 'peer-joined', peer: { id, name, color } }, id);

    // Relay WebRTC signaling messages (offer / answer / ice-candidate)
    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.to) {
            const target = globalRoom.get(msg.to);
            if (target && target.ws.readyState === 1) {
                target.ws.send(JSON.stringify({ ...msg, from: id }));
            }
        }
    });

    ws.on('close', () => {
        globalRoom.delete(id);
        console.log(`[-] Peer ${id} "${name}" left (${globalRoom.size} total)`);
        broadcast({ type: 'peer-left', id });
    });

    ws.on('error', (err) => console.error(`[!] Peer ${id} error:`, err.message));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`\n✅  LocalDrop running on http://0.0.0.0:${PORT}`);
    const ifaces = networkInterfaces();
    if (ifaces) {
        console.log(`\n📡  Your local addresses:`);
        Object.values(ifaces).flat().forEach(iface => {
            if (iface && iface.family === 'IPv4' && !iface.internal) {
                console.log(`    http://${iface.address}:${PORT}`);
            }
        });
    }
    console.log(`    http://localhost:${PORT}  (this machine)\n`);
});
