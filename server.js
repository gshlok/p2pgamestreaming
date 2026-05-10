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
const THROTTLED_EXTENSIONS = ['.PSX', '.PHD', '.TR2', '.TR4', '.SFX'];

const WEB_ROOT = __dirname;

// ---------------------------------------------------------------------------
// Express — Static File Server
// ---------------------------------------------------------------------------

const app = express();

// Request logging middleware
app.use((req, res, next) => {
    res.on('finish', () => {
        if (res.statusCode >= 400) {
            console.warn(`[HTTP] ${res.statusCode} ${req.method} ${req.url}`);
        } else {
            // console.log(`[HTTP] ${res.statusCode} ${req.method} ${req.url}`);
        }
    });
    next();
});

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
        // Cache-control: no caching during dev
        res.setHeader('Cache-Control', 'no-store');
    }
}));

// Serve levels
const LEVELS_ROOT = path.join(__dirname, 'Tomb-Raider-1-2-3-4-5-Map-viewer-and-levels');
app.use('/levels', express.static(LEVELS_ROOT, {
    setHeaders: (res, filePath) => {
        res.setHeader('Cache-Control', 'no-store');
    }
}));

// Fallback interceptor for missing optional OpenLara assets (CD audio tracks and missing loading screens)
// This prevents 404 errors in the console while allowing the game to proceed.
app.use((req, res, next) => {
    if (req.path.endsWith('.ogg') || req.path.endsWith('.PNG')) {
        return res.status(204).end(); // 204 No Content
    }
    next();
});

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket — Signaling Server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 50 * 1024 * 1024 }); // 50MB for asset relay

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

        // Log ALL messages for debugging
        if (msg.type !== 'heartbeat') {
            const logData = { ...msg };
            if (logData.data) logData.data = `[${logData.data.length} chars base64]`;
            console.log(`[WS-MSG] ${peerId || '?'} → ${msg.type}:`, JSON.stringify(logData).slice(0, 200));
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
                    console.log(`[ANNOUNCE] ${peerId} announcing ${newAssets.length} new assets: ${newAssets.join(', ')}`);
                    for (const a of newAssets) {
                        if (!peer.assets.includes(a)) {
                            peer.assets.push(a);
                        }
                    }
                    console.log(`[ANNOUNCE] ${peerId} total assets now: ${peer.assets.length} — [${peer.assets.join(', ')}]`);

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
            // WebRTC signaling relay
            // -----------------------------------------------------------
            case 'rtc-offer':
            case 'rtc-answer':
            case 'rtc-ice': {
                if (msg.to) {
                    sendTo(msg.to, {
                        type: msg.type,
                        from: peerId,
                        signal: msg.signal,
                        assetName: msg.assetName
                    });
                }
                break;
            }

            // -----------------------------------------------------------
            // Asset request (ask a specific peer or broadcast for an asset)
            // -----------------------------------------------------------
            case 'asset-request': {
                if (msg.to) {
                    // Targeted request to a specific peer
                    sendTo(msg.to, {
                        type: 'asset-request',
                        from: peerId,
                        assetName: msg.assetName
                    });
                } else {
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
                }
                break;
            }

            // -----------------------------------------------------------
            // WebSocket asset relay (peer sends asset data via WS to another peer)
            // -----------------------------------------------------------
            case 'ws-relay-asset': {
                if (msg.to) {
                    console.log(`[WS-RELAY] ${peerId} → ${msg.to}: ${msg.assetName} (${msg.size ? (msg.size / 1024).toFixed(1) + 'KB' : '?'})`);
                    sendTo(msg.to, {
                        type: 'ws-relay-asset',
                        from: peerId,
                        assetName: msg.assetName,
                        data: msg.data,
                        hash: msg.hash,
                        size: msg.size
                    });
                }
                break;
            }
            
            // -----------------------------------------------------------
            // Transfer event (for UI map visualization)
            // -----------------------------------------------------------
            case 'transfer-event': {
                broadcastExcept(peerId, msg);
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
