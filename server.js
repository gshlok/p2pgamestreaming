/**
 * P2P Game Asset Streaming — Signaling Server
 * 
 * Serves the OpenLara WebGL build as static files and provides
 * WebSocket-based signaling for peer discovery and WebRTC handshake.
 * 
 * Features:
 *   - Static file serving for game assets
 *   - Artificial origin throttling (--throttle flag or THROTTLE env)
 *   - WebSocket peer registry with heartbeats
 *   - WebRTC signaling relay (offer/answer/ICE)
 *   - Asset ownership broadcast
 * 
 * Usage:
 *   node server.js                    # Normal mode
 *   node server.js --throttle         # With artificial 500ms latency on asset files
 *   THROTTLE_MS=1000 node server.js   # Custom throttle delay
 */

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const THROTTLE_ENABLED = process.argv.includes('--throttle') || !!process.env.THROTTLE_MS;
const THROTTLE_MS = parseInt(process.env.THROTTLE_MS || '800', 10);
const HEARTBEAT_INTERVAL = 5000;   // ms between heartbeat checks
const PEER_TIMEOUT = 15000;        // ms before peer is considered dead

// Asset file extensions that get throttled (to make P2P visibly faster)
const THROTTLED_EXTENSIONS = ['.PSX', '.PHD', '.TR2', '.TR4', '.SFX', '.ogg', '.mp3', '.wav', '.PNG', '.RAW', '.BMP', '.data', '.wad', '.pk3', '.lmp'];

const WEB_ROOT = path.join(__dirname, 'OpenLara', 'src', 'platform', 'web');

// ---------------------------------------------------------------------------
// Express — Static File Server
// ---------------------------------------------------------------------------

const app = express();

// Artificial throttle middleware for asset files
if (THROTTLE_ENABLED) {
    app.use((req, res, next) => {
        const ext = path.extname(req.path).toUpperCase() || path.extname(req.path);
        if (THROTTLED_EXTENSIONS.some(e => ext === e.toUpperCase())) {
            // Add artificial delay to simulate slow/distant CDN
            console.log(`[THROTTLE] ${req.path} — delaying ${THROTTLE_MS}ms`);
            setTimeout(next, THROTTLE_MS);
        } else {
            next();
        }
    });
}

// Serve the OpenLara web build
app.use(express.static(WEB_ROOT, {
    setHeaders: (res, filePath) => {
        // CORS headers for cross-origin isolation (needed for SharedArrayBuffer in some configs)
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        // Cache-control: no caching during dev
        res.setHeader('Cache-Control', 'no-store');

        if (filePath.endsWith('.wasm')) {
            res.type('application/wasm');
        }
    }
}));

// Serve levels
const LEVELS_ROOT = path.join(__dirname, 'Tomb-Raider-1-2-3-4-5-Map-viewer-and-levels');
app.use('/levels', express.static(LEVELS_ROOT, {
    setHeaders: (res, filePath) => {
        res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
        res.setHeader('Cache-Control', 'no-store');
    }
}));

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket — Signaling Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' });

/**
 * Peer registry
 * Map<peerId, { ws, assets: string[], lastSeen: number, info: object }>
 */
const peers = new Map();

function broadcastPeerList() {
    const peerList = [];
    for (const [id, peer] of peers) {
        peerList.push({
            peerId: id,
            assets: peer.assets,
            info: peer.info || {}
        });
    }

    const msg = JSON.stringify({ type: 'peer-list', peers: peerList });
    for (const [, peer] of peers) {
        if (peer.ws.readyState === 1) { // WebSocket.OPEN
            peer.ws.send(msg);
        }
    }
}

function broadcastExcept(excludeId, message) {
    const msg = typeof message === 'string' ? message : JSON.stringify(message);
    for (const [id, peer] of peers) {
        if (id !== excludeId && peer.ws.readyState === 1) {
            peer.ws.send(msg);
        }
    }
}

function sendTo(peerId, message) {
    const peer = peers.get(peerId);
    if (peer && peer.ws.readyState === 1) {
        peer.ws.send(typeof message === 'string' ? message : JSON.stringify(message));
    }
}

wss.on('connection', (ws, req) => {
    let peerId = null;

    ws.on('message', (rawData) => {
        let msg;
        try {
            msg = JSON.parse(rawData.toString());
        } catch (e) {
            console.error('[WS] Invalid JSON:', rawData.toString().slice(0, 100));
            return;
        }

        switch (msg.type) {
            // -----------------------------------------------------------
            // Peer registration
            // -----------------------------------------------------------
            case 'register': {
                peerId = msg.peerId;
                peers.set(peerId, {
                    ws,
                    assets: msg.assets || [],
                    lastSeen: Date.now(),
                    info: msg.info || {}
                });

                console.log(`[PEER] ${peerId} registered (${peers.size} total)`);

                // Send current peer list to the new peer
                const peerList = [];
                for (const [id, p] of peers) {
                    if (id !== peerId) {
                        peerList.push({ peerId: id, assets: p.assets, info: p.info });
                    }
                }
                ws.send(JSON.stringify({ type: 'peer-list', peers: peerList }));

                // Notify others
                broadcastExcept(peerId, {
                    type: 'peer-joined',
                    peer: { peerId, assets: msg.assets || [], info: msg.info || {} }
                });
                break;
            }

            // -----------------------------------------------------------
            // Heartbeat
            // -----------------------------------------------------------
            case 'heartbeat': {
                if (peerId && peers.has(peerId)) {
                    peers.get(peerId).lastSeen = Date.now();
                }
                break;
            }

            // -----------------------------------------------------------
            // Asset announcement (peer cached a new asset)
            // -----------------------------------------------------------
            case 'asset-announce': {
                if (peerId && peers.has(peerId)) {
                    const peer = peers.get(peerId);
                    const newAssets = msg.assets || [];
                    for (const a of newAssets) {
                        if (!peer.assets.includes(a)) {
                            peer.assets.push(a);
                        }
                    }

                    // Notify all other peers
                    broadcastExcept(peerId, {
                        type: 'asset-update',
                        peerId,
                        assets: peer.assets
                    });
                }
                break;
            }

            // -----------------------------------------------------------
            // WebRTC signaling relay & WebSocket transfer fallback
            // -----------------------------------------------------------
            case 'rtc-offer':
            case 'rtc-answer':
            case 'rtc-ice':
            case 'ws-transfer-request':
            case 'ws-transfer-response': {
                if (msg.to) {
                    sendTo(msg.to, {
                        type: msg.type,
                        from: peerId,
                        signal: msg.signal,
                        assetName: msg.assetName,
                        data: msg.data,
                        size: msg.size,
                        hash: msg.hash
                    });
                }
                break;
            }

            // -----------------------------------------------------------
            // Asset request (ask if any peer has an asset)
            // -----------------------------------------------------------
            case 'asset-request': {
                // Broadcast to all peers who have this asset
                for (const [id, peer] of peers) {
                    if (id !== peerId && peer.assets.includes(msg.assetName)) {
                        sendTo(id, {
                            type: 'asset-request',
                            from: peerId,
                            assetName: msg.assetName
                        });
                    }
                }
                break;
            }

            default:
                console.warn(`[WS] Unknown message type: ${msg.type}`);
        }
    });

    ws.on('close', () => {
        if (peerId) {
            peers.delete(peerId);
            console.log(`[PEER] ${peerId} disconnected (${peers.size} remaining)`);
            broadcastExcept(peerId, { type: 'peer-left', peerId });
        }
    });

    ws.on('error', (err) => {
        console.error(`[WS] Error for peer ${peerId}:`, err.message);
    });
});

// ---------------------------------------------------------------------------
// Heartbeat sweep — remove dead peers
// ---------------------------------------------------------------------------

setInterval(() => {
    const now = Date.now();
    for (const [id, peer] of peers) {
        if (now - peer.lastSeen > PEER_TIMEOUT) {
            console.log(`[PEER] ${id} timed out`);
            peer.ws.terminate();
            peers.delete(id);
            broadcastExcept(id, { type: 'peer-left', peerId: id });
        }
    }
}, HEARTBEAT_INTERVAL);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(PORT, '0.0.0.0', () => {
    const interfaces = require('os').networkInterfaces();
    let lanIP = 'localhost';
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                lanIP = iface.address;
                break;
            }
        }
    }

    console.log('');
    console.log('═══════════════════════════════════════════════════════');
    console.log('  P2P Game Asset Streaming — Signaling Server');
    console.log('═══════════════════════════════════════════════════════');
    console.log(`  Local:    http://localhost:${PORT}`);
    console.log(`  Network:  http://${lanIP}:${PORT}`);
    console.log(`  WS:       ws://${lanIP}:${PORT}/ws`);
    console.log('');
    console.log(`  Throttle: ${THROTTLE_ENABLED ? `ON (${THROTTLE_MS}ms delay on assets)` : 'OFF (use --throttle to enable)'}`);
    console.log(`  Serving:  ${WEB_ROOT}`);
    console.log('═══════════════════════════════════════════════════════');
    console.log('');
});
