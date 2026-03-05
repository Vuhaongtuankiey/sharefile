/* =========================================================================
   LocalDrop — Frontend Application
   WebSocket signaling + WebRTC P2P file transfer
   ========================================================================= */

'use strict';

// ─── Constants ──────────────────────────────────────────────────────────────
const CHUNK_SIZE = 64 * 1024; // 64 KB per DataChannel chunk
const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ],
};

// ─── State ───────────────────────────────────────────────────────────────────
let myId = null;
let myName = null;
let myColor = null;
let socket = null;

// Map<peerId, RTCPeerConnection>
const peerConns = new Map();
// Map<peerId, RTCDataChannel>  (outgoing, for sending)
const dataChannels = new Map();

// Incoming transfer state (one at a time for simplicity)
let incoming = null;  // { from, fileName, fileSize, fileType, chunks, received }

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const peersContainer = $('peersContainer');
const myInfo = $('myInfo');
const myAvatar = $('myAvatar');
const myNameEl = $('myName');
const statusDot = $('statusDot');
const statusText = $('statusText');
const instructions = $('instructions');
const dropOverlay = $('dropOverlay');
const receiveModal = $('receiveModal');
const modalTitle = $('modalTitle');
const modalSubtitle = $('modalSubtitle');
const modalProgress = $('modalProgress');
const progressFill = $('progressFill');
const progressLabel = $('progressLabel');
const modalActions = $('modalActions');
const btnAccept = $('btnAccept');
const btnDecline = $('btnDecline');
const fileInput = $('fileInput');

// ─── Peer UI registry ─────────────────────────────────────────────────────────
const peerElements = new Map();  // peerId -> { el, bubbleEl, statusEl }

// ─── WebSocket connection ─────────────────────────────────────────────────────
function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    socket = new WebSocket(`${proto}://${location.host}`);

    socket.addEventListener('open', () => {
        setStatus('connected', 'Connected');
    });

    socket.addEventListener('close', () => {
        setStatus('disconnected', 'Disconnected — retrying…');
        peerElements.forEach((_, id) => removePeerUI(id));
        peerElements.clear();
        peerConns.forEach(pc => pc.close());
        peerConns.clear();
        dataChannels.clear();
        showEmpty();
        setTimeout(connect, 3000);
    });

    socket.addEventListener('error', () => { });

    socket.addEventListener('message', async (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        await handleSignal(msg);
    });
}

function send(obj) {
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(obj));
    }
}

// ─── Status ───────────────────────────────────────────────────────────────────
function setStatus(state, text) {
    statusDot.className = 'status-dot ' + state;
    statusText.textContent = text;
}

// ─── Signaling handler ────────────────────────────────────────────────────────
async function handleSignal(msg) {
    switch (msg.type) {

        case 'welcome':
            myId = msg.id;
            myName = msg.name;
            myColor = msg.color;
            myAvatar.style.background = myColor;
            myAvatar.textContent = initials(myName);
            myNameEl.textContent = myName;
            myInfo.style.opacity = '1';
            // Add existing peers
            (msg.peers || []).forEach(p => { if (p.id !== myId) addPeer(p); });
            updateInstructions();
            break;

        case 'peer-joined':
            if (msg.peer.id !== myId) {
                addPeer(msg.peer);
                toast(`${msg.peer.name} joined`, 'info');
                updateInstructions();
            }
            break;

        case 'peer-left':
            removePeerUI(msg.id);
            peerConns.get(msg.id)?.close();
            peerConns.delete(msg.id);
            dataChannels.delete(msg.id);
            toast('A peer disconnected', 'info');
            updateInstructions();
            break;

        // WebRTC signaling relayed from remote peer
        case 'offer':
            await handleOffer(msg.from, msg.offer);
            break;

        case 'answer':
            await peerConns.get(msg.from)?.setRemoteDescription(new RTCSessionDescription(msg.answer));
            break;

        case 'ice-candidate':
            if (msg.candidate) {
                try { await peerConns.get(msg.from)?.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
                catch { }
            }
            break;
    }
}

// ─── Peer UI ──────────────────────────────────────────────────────────────────
function addPeer(peer) {
    if (peerElements.has(peer.id)) return;

    // Remove empty state
    document.querySelector('.empty-state')?.remove();

    const el = document.createElement('div');
    el.className = 'peer';
    el.id = `peer-${peer.id}`;
    el.innerHTML = `
    <div class="peer-bubble" id="bubble-${peer.id}" style="background:${peer.color}; color:#fff;">
      <div class="pulse-ring" style="color:${peer.color}"></div>
      <div class="pulse-ring" style="color:${peer.color}"></div>
      <div class="pulse-ring" style="color:${peer.color}"></div>
      ${initials(peer.name)}
    </div>
    <div class="peer-name">${escHtml(peer.name)}</div>
    <div class="peer-status" id="status-${peer.id}"></div>
  `;

    const bubbleEl = el.querySelector(`#bubble-${peer.id}`);
    const statusEl = el.querySelector(`#status-${peer.id}`);

    // Click to send file
    el.addEventListener('click', () => pickAndSend(peer.id, peer.name));

    // Drag-and-drop onto bubble
    el.addEventListener('dragover', (e) => { e.preventDefault(); bubbleEl.classList.add('dragover'); });
    el.addEventListener('dragleave', () => bubbleEl.classList.remove('dragover'));
    el.addEventListener('drop', (e) => {
        e.preventDefault();
        bubbleEl.classList.remove('dragover');
        const files = [...e.dataTransfer.files];
        if (files.length) sendFileToPeer(peer.id, peer.name, files[0]);
    });

    peersContainer.appendChild(el);
    peerElements.set(peer.id, { el, bubbleEl, statusEl });
}

function removePeerUI(id) {
    peerElements.get(id)?.el.remove();
    peerElements.delete(id);
    if (peerElements.size === 0) showEmpty();
}

function showEmpty() {
    if (!document.querySelector('.empty-state')) {
        peersContainer.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1">
          <circle cx="12" cy="12" r="10"/>
          <path d="M8 12h8M12 8v8"/>
        </svg>
        <h3>No peers found</h3>
        <p>Open this page on another device connected to the same WiFi network.</p>
      </div>`;
    }
}

function updateInstructions() {
    const count = peerElements.size;
    if (count === 0) {
        instructions.textContent = 'Open this app on another device on the same WiFi…';
    } else {
        instructions.textContent = count === 1
            ? 'Click or drag a file onto a peer to send it 🚀'
            : `${count} peers found — click or drop a file to share`;
    }
}

function setPeerStatus(id, text) {
    const entry = peerElements.get(id);
    if (entry) entry.statusEl.textContent = text;
}

// ─── File picking ─────────────────────────────────────────────────────────────
function pickAndSend(peerId, peerName) {
    fileInput.onchange = () => {
        const files = [...fileInput.files];
        if (files.length) sendFileToPeer(peerId, peerName, files[0]);
        fileInput.value = '';
    };
    fileInput.click();
}

// ─── WebRTC connection setup ──────────────────────────────────────────────────
function getOrCreatePC(peerId) {
    if (peerConns.has(peerId)) return peerConns.get(peerId);

    const pc = new RTCPeerConnection(RTC_CONFIG);
    peerConns.set(peerId, pc);

    pc.addEventListener('icecandidate', (ev) => {
        send({ type: 'ice-candidate', to: peerId, candidate: ev.candidate });
    });

    pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed') {
            pc.close();
            peerConns.delete(peerId);
            dataChannels.delete(peerId);
        }
    });

    // Remote DataChannel (receiver side)
    pc.addEventListener('datachannel', (ev) => {
        setupReceiveChannel(ev.channel);
    });

    return pc;
}

// ─── SEND ─────────────────────────────────────────────────────────────────────
async function sendFileToPeer(peerId, peerName, file) {
    const pc = getOrCreatePC(peerId);

    // Create DataChannel for this transfer
    const channel = pc.createDataChannel('file-transfer');
    dataChannels.set(peerId, channel);

    channel.binaryType = 'arraybuffer';

    channel.addEventListener('open', () => {
        // Send metadata header first (JSON string)
        const meta = JSON.stringify({
            type: 'meta',
            name: file.name,
            size: file.size,
            fileType: file.type || 'application/octet-stream',
        });
        channel.send(meta);

        // Start chunked send
        let offset = 0;
        const reader = new FileReader();

        const readNextChunk = () => {
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        };

        reader.onload = (ev) => {
            channel.send(ev.target.result);
            offset += ev.target.result.byteLength;
            const pct = Math.round((offset / file.size) * 100);
            setPeerStatus(peerId, `Sending… ${pct}%`);
            updatePeerRing(peerId, pct);
            if (offset < file.size) {
                // Throttle if buffer is large
                if (channel.bufferedAmount > CHUNK_SIZE * 4) {
                    channel.onbufferedamountlow = () => {
                        channel.onbufferedamountlow = null;
                        readNextChunk();
                    };
                    channel.bufferedAmountLowThreshold = CHUNK_SIZE * 2;
                } else {
                    readNextChunk();
                }
            } else {
                // Done
                channel.send(JSON.stringify({ type: 'done' }));
                setPeerStatus(peerId, '✓ Sent!');
                updatePeerRing(peerId, -1);
                toast(`Sent "${file.name}" to ${peerName}`, 'success');
                setTimeout(() => setPeerStatus(peerId, ''), 3000);
            }
        };

        readNextChunk();
    });

    channel.addEventListener('error', () => {
        setPeerStatus(peerId, '⚠ Error');
        toast('Transfer failed', 'error');
        setTimeout(() => setPeerStatus(peerId, ''), 3000);
    });

    // Create and send offer
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    send({ type: 'offer', to: peerId, offer: pc.localDescription });

    setPeerStatus(peerId, 'Connecting…');
    toast(`Sending "${file.name}" to ${peerName}…`, 'info');
}

// ─── OFFER received (receiver side) ──────────────────────────────────────────
async function handleOffer(fromId, offer) {
    const pc = getOrCreatePC(fromId);
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    send({ type: 'answer', to: fromId, answer: pc.localDescription });
}

// ─── RECEIVE DataChannel ──────────────────────────────────────────────────────
function setupReceiveChannel(channel) {
    channel.binaryType = 'arraybuffer';

    let meta = null;
    let chunks = [];
    let received = 0;
    let accepted = false;
    let doneReceived = false;
    let pendingChunks = [];

    function completeTransfer() {
        if (!meta || !accepted || !doneReceived) return;
        // Reassemble and download
        try {
            const blob = new Blob(chunks, { type: meta.fileType });
            const fileName = meta.name;
            triggerDownload(blob, fileName);
            closeReceiveModal();
            toast(`✓ Received "${fileName}"`, 'success');
        } catch (err) {
            console.error('Download error:', err);
            toast('Error saving file', 'error');
            closeReceiveModal();
        }
        meta = null; chunks = []; received = 0;
        doneReceived = false;
    }

    channel.addEventListener('message', (ev) => {
        // JSON messages (meta / done)
        if (typeof ev.data === 'string') {
            let msg;
            try { msg = JSON.parse(ev.data); } catch { return; }

            if (msg.type === 'meta') {
                meta = msg;
                chunks = [];
                received = 0;
                accepted = false;
                doneReceived = false;
                pendingChunks = [];
                showReceiveModal(msg, channel, () => {
                    accepted = true;
                    // Flush any chunks that arrived before accept
                    pendingChunks.forEach(c => {
                        chunks.push(c);
                        received += c.byteLength;
                        updateReceiveProgress(received, meta.size);
                    });
                    pendingChunks = [];
                    // If done already arrived while we were waiting for accept
                    if (doneReceived) {
                        completeTransfer();
                    }
                });

            } else if (msg.type === 'done') {
                doneReceived = true;
                completeTransfer();
            }
            return;
        }

        // ArrayBuffer chunk
        const chunk = ev.data;
        if (!meta) return;

        if (!accepted) {
            pendingChunks.push(chunk);
            return;
        }

        chunks.push(chunk);
        received += chunk.byteLength;
        updateReceiveProgress(received, meta.size);

        // Fallback: if all bytes received, mark done
        if (received >= meta.size && !doneReceived) {
            doneReceived = true;
            completeTransfer();
        }
    });

    channel.addEventListener('error', () => {
        closeReceiveModal();
        toast('Incoming transfer failed', 'error');
    });
}

// ─── Reliable download helper ────────────────────────────────────────────────
function triggerDownload(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    // Clean up after short delay
    setTimeout(() => {
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }, 5000);
}

// ─── Receive modal ────────────────────────────────────────────────────────────
let onAcceptCb = null;

function showReceiveModal(meta, channel, onAccept) {
    const sizeFmt = formatBytes(meta.size);
    modalTitle.textContent = `"${meta.name}"`;
    modalSubtitle.textContent = `${sizeFmt} — Accept to receive`;
    modalProgress.style.display = 'none';
    modalActions.style.display = 'flex';
    progressFill.style.width = '0%';
    progressLabel.textContent = '0%';
    receiveModal.style.display = 'flex';

    onAcceptCb = onAccept;

    btnDecline.onclick = () => {
        channel.close();
        receiveModal.style.display = 'none';
        toast('Transfer declined', 'info');
    };

    btnAccept.onclick = () => {
        modalActions.style.display = 'none';
        modalProgress.style.display = 'block';
        modalSubtitle.textContent = 'Receiving…';
        if (onAcceptCb) { onAcceptCb(); onAcceptCb = null; }
    };
}

function updateReceiveProgress(received, total) {
    const pct = Math.round((received / total) * 100);
    progressFill.style.width = pct + '%';
    progressLabel.textContent = pct + '%';
}

function closeReceiveModal() {
    receiveModal.style.display = 'none';
    onAcceptCb = null;
}

// ─── Progress ring on peer bubble ─────────────────────────────────────────────
function updatePeerRing(peerId, pct) {
    const entry = peerElements.get(peerId);
    if (!entry) return;
    const bubble = entry.bubbleEl;

    let svg = bubble.querySelector('.progress-ring-svg');

    if (pct < 0) {
        // Remove ring
        svg?.remove();
        return;
    }

    if (!svg) {
        const r = 63;
        const circ = 2 * Math.PI * r;
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'progress-ring-svg');
        svg.setAttribute('viewBox', '0 0 140 140');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('class', 'progress-ring-circle');
        circle.setAttribute('cx', '70');
        circle.setAttribute('cy', '70');
        circle.setAttribute('r', String(r));
        circle.setAttribute('stroke-dasharray', `${circ} ${circ}`);
        circle.setAttribute('stroke-dashoffset', String(circ));
        circle.dataset.circ = circ;
        svg.appendChild(circle);
        bubble.appendChild(svg);
    }

    const circle = svg.querySelector('.progress-ring-circle');
    const circ = parseFloat(circle.dataset.circ);
    circle.setAttribute('stroke-dashoffset', String(circ - (pct / 100) * circ));
}

// ─── Drag-and-drop on window ──────────────────────────────────────────────────
let dragTarget = null;

document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dropOverlay.classList.add('active');
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('dragleave', (e) => {
    if (!e.relatedTarget || e.relatedTarget === document.body) {
        dropOverlay.classList.remove('active');
    }
});
document.addEventListener('drop', (e) => {
    e.preventDefault();
    dropOverlay.classList.remove('active');
});

// ─── Toast ────────────────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
    const tc = $('toastContainer');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    tc.appendChild(el);
    setTimeout(() => {
        el.classList.add('exit');
        el.addEventListener('animationend', () => el.remove());
    }, 3500);
}

// ─── Utility ──────────────────────────────────────────────────────────────────
function initials(name) {
    return name.split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
}

function escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 ** 3) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 ** 3)).toFixed(2) + ' GB';
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
showEmpty();
connect();
