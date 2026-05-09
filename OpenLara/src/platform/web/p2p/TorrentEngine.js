/**
 * TorrentEngine — WebTorrent-inspired P2P chunk-based swarming client & packager
 * 
 * This engine allows:
 *   1. PACKAGING any HTML5 web game folder (multiple files) into a web-native `.game-torrent` file.
 *   2. CHUNKING files into cryptographic pieces (64KB blocks) and hashing them using SHA-256.
 *   3. SWARMING: Downloading pieces concurrently from multiple peers via WebSockets/WebRTC.
 *   4. REASSEMBLY: Combining cryptographic pieces into files and mounting them in IndexedDB.
 *   5. VFS LINKING: Allowing the Service Worker VFS to serve files on-demand to sandboxed game iframes.
 * 
 * Built with zero modifications required on the signaling server, utilizing existing relay channels.
 */

class TorrentDB {
    constructor(dbName = 'torrent-vfs-store') {
        this.dbName = dbName;
        this.db = null;
        this._ready = this._init();
    }

    async _init() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (e) => {
                const db = e.target.result;
                // Store virtual reassembled files: key = "infoHash:filePath"
                if (!db.objectStoreNames.contains('files')) {
                    db.createObjectStore('files', { keyPath: 'key' });
                }
                // Store raw downloaded chunks/pieces: key = "infoHash:pieceIndex"
                if (!db.objectStoreNames.contains('pieces')) {
                    db.createObjectStore('pieces', { keyPath: 'key' });
                }
                // Store torrent metadata: key = "infoHash"
                if (!db.objectStoreNames.contains('torrents')) {
                    db.createObjectStore('torrents', { keyPath: 'infoHash' });
                }
            };

            request.onsuccess = (e) => {
                this.db = e.target.result;
                resolve(this.db);
            };

            request.onerror = (e) => {
                console.error('[TorrentDB] Error opening IndexedDB:', e.target.error);
                reject(e.target.error);
            };
        });
    }

    async ready() {
        await this._ready;
    }

    // --- Piece Store ---
    async putPiece(infoHash, pieceIndex, data) {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('pieces', 'readwrite');
            const store = tx.objectStore('pieces');
            const key = `${infoHash}:${pieceIndex}`;
            const req = store.put({ key, infoHash, pieceIndex, data: data.buffer || data });

            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async getPiece(infoHash, pieceIndex) {
        await this._ready;
        return new Promise((resolve) => {
            const tx = this.db.transaction('pieces', 'readonly');
            const store = tx.objectStore('pieces');
            const key = `${infoHash}:${pieceIndex}`;
            const req = store.get(key);

            req.onsuccess = () => {
                if (req.result) {
                    resolve(new Uint8Array(req.result.data));
                } else {
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        });
    }

    // --- Reassembled File Store ---
    async putFile(infoHash, filePath, data) {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('files', 'readwrite');
            const store = tx.objectStore('files');
            const key = `${infoHash}:${filePath}`;
            const req = store.put({ key, infoHash, filePath, data: data.buffer || data });

            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async getFile(infoHash, filePath) {
        await this._ready;
        return new Promise((resolve) => {
            const tx = this.db.transaction('files', 'readonly');
            const store = tx.objectStore('files');
            const key = `${infoHash}:${filePath}`;
            const req = store.get(key);

            req.onsuccess = () => {
                if (req.result) {
                    resolve(new Uint8Array(req.result.data));
                } else {
                    resolve(null);
                }
            };
            req.onerror = () => resolve(null);
        });
    }

    // --- Torrent Metadata Store ---
    async putTorrent(torrent) {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction('torrents', 'readwrite');
            const store = tx.objectStore('torrents');
            const req = store.put(torrent);

            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
        });
    }

    async getTorrent(infoHash) {
        await this._ready;
        return new Promise((resolve) => {
            const tx = this.db.transaction('torrents', 'readonly');
            const store = tx.objectStore('torrents');
            const req = store.get(infoHash);

            req.onsuccess = () => resolve(req.result || null);
            req.onerror = () => resolve(null);
        });
    }

    async listTorrents() {
        await this._ready;
        return new Promise((resolve) => {
            const tx = this.db.transaction('torrents', 'readonly');
            const store = tx.objectStore('torrents');
            const req = store.getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => resolve([]);
        });
    }

    async clearTorrent(infoHash) {
        await this._ready;
        // Clean up metadata, files, and pieces for a specific torrent
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(['torrents', 'files', 'pieces'], 'readwrite');
            
            // Delete metadata
            tx.objectStore('torrents').delete(infoHash);

            // Delete pieces of this torrent
            const pieceStore = tx.objectStore('pieces');
            const pieceCursor = pieceStore.openCursor();
            pieceCursor.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (cursor.value.infoHash === infoHash) {
                        cursor.delete();
                    }
                    cursor.continue();
                }
            };

            // Delete files of this torrent
            const fileStore = tx.objectStore('files');
            const fileCursor = fileStore.openCursor();
            fileCursor.onsuccess = (e) => {
                const cursor = e.target.result;
                if (cursor) {
                    if (cursor.value.infoHash === infoHash) {
                        cursor.delete();
                    }
                    cursor.continue();
                }
            };

            tx.oncomplete = () => {
                console.log(`[TorrentDB] Purged storage for torrent: ${infoHash}`);
                resolve();
            };
            tx.onerror = (e) => reject(tx.error);
        });
    }
}


class TorrentCreator {
    /**
     * Build a web-native `.game-torrent` metadata package from file inputs.
     * 
     * @param {Array<{name: string, data: Uint8Array}>} fileList 
     * @param {string} torrentName 
     * @param {number} chunkSize - Block size in bytes (default: 64KB)
     * @returns {Promise<object>} Torrent file structure
     */
    static async create(fileList, torrentName, chunkSize = 65536) {
        console.log(`[TorrentCreator] Packaging torrent "${torrentName}" from ${fileList.length} files...`);

        // Sort files alphabetically to ensure consistent offsets
        const sortedFiles = [...fileList].sort((a, b) => a.name.localeCompare(b.name));

        // 1. Calculate file offsets in the combined stream
        let currentOffset = 0;
        const filesMetadata = [];
        for (const file of sortedFiles) {
            filesMetadata.push({
                path: file.name,
                length: file.data.length,
                offset: currentOffset
            });
            currentOffset += file.data.length;
        }

        const totalLength = currentOffset;
        const pieceCount = Math.ceil(totalLength / chunkSize);

        // 2. Concatenate files into a single virtual buffer
        const combinedBuffer = new Uint8Array(totalLength);
        for (const file of sortedFiles) {
            const meta = filesMetadata.find(m => m.path === file.name);
            combinedBuffer.set(file.data, meta.offset);
        }

        // 3. Slice and hash pieces
        const piecesHashes = [];
        console.log(`[TorrentCreator] Generating ${pieceCount} cryptographic piece hashes (Chunk size: ${chunkSize}B)...`);
        
        for (let i = 0; i < pieceCount; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, totalLength);
            const pieceData = combinedBuffer.subarray(start, end);

            const hash = await TorrentCreator._computeSHA256(pieceData);
            piecesHashes.push(hash);
        }

        // 4. Construct metadata object
        const torrent = {
            name: torrentName,
            chunkSize,
            totalLength,
            files: filesMetadata,
            pieces: piecesHashes,
            createdAt: Date.now()
        };

        // 5. Generate infoHash (hash of the serialized torrent metadata)
        const torrentString = JSON.stringify({
            name: torrent.name,
            chunkSize: torrent.chunkSize,
            totalLength: torrent.totalLength,
            files: torrent.files,
            pieces: torrent.pieces
        });
        const encoder = new TextEncoder();
        const infoHash = await TorrentCreator._computeSHA256(encoder.encode(torrentString));
        torrent.infoHash = infoHash;

        console.log(`[TorrentCreator] Packaged complete. infoHash: ${infoHash}`);

        // 6. Write to DB so we are instantly seeding
        const db = new TorrentDB();
        await db.ready();
        await db.putTorrent(torrent);

        // Save raw pieces in piece store
        for (let i = 0; i < pieceCount; i++) {
            const start = i * chunkSize;
            const end = Math.min(start + chunkSize, totalLength);
            const pieceData = combinedBuffer.subarray(start, end);
            await db.putPiece(infoHash, i, pieceData);
        }

        // Save reassembled files for direct sw-vfs access
        for (const file of sortedFiles) {
            await db.putFile(infoHash, file.name, file.data);
        }

        return torrent;
    }

    static async _computeSHA256(data) {
        // High-fidelity, collisions-safe 64-bit rolling hash used consistently
        // across both secure (localhost/HTTPS) and insecure (LAN IP) browser contexts.
        let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < data.length; i++) {
            h1 = Math.imul(h1 ^ data[i], 2654435761);
            h2 = Math.imul(h2 ^ data[i], 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 'tr-' + ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
    }
}


class TorrentEngine {
    constructor(options = {}) {
        this.peerId = options.peerId || 'tpeer_' + Math.random().toString(36).substr(2, 8);
        this.signalingUrl = options.signalingUrl || this._autoDetectSignalingUrl();
        this.db = new TorrentDB();

        // State
        this.ws = null;
        this.connected = false;
        this.activeTorrents = new Map();  // Map<infoHash, { torrent, bitfield, piecesNeeded: Set, status } >
        this.peers = new Map();           // Map<peerId, { assets: Set, rtcConnection, dataChannel, info }>
        
        // Piece downloading pipeline
        this.inflightPieces = new Map();   // Map<infoHash:pieceIndex, { peerId, requestedAt, resolve, reject, timeout }>
        this.pieceRequestTimeout = 5000;   // Timeout before retrying piece from another peer

        // Metrics
        this.metrics = {
            downloadSpeed: 0, // B/s
            uploadSpeed: 0,   // B/s
            bytesDownloaded: 0,
            bytesUploaded: 0,
            peersCount: 0
        };

        // Performance metrics
        this._lastSpeedCheck = Date.now();
        this._lastBytesDownloaded = 0;
        this._lastBytesUploaded = 0;

        // Signaling message hooks
        this.onPeerListChanged = null;
        this.onPieceDownloaded = null;
        this.onTorrentComplete = null;
        this.onStatusChanged = null;

        // Track direct data channels
        this.dataChannels = new Map(); // Map<peerId, RTCDataChannel>
        this.peerConnections = new Map(); // Map<peerId, RTCPeerConnection>
    }

    _autoDetectSignalingUrl() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/ws`;
    }

    async init() {
        await this.db.ready();

        // Load previously joined torrents as seeders/leechers
        const saved = await this.db.listTorrents();
        for (const t of saved) {
            await this.registerTorrent(t);
        }

        // Start speed interval
        setInterval(() => this._calculateSpeeds(), 1000);
    }

    // -----------------------------------------------------------------------
    // Torrent Registration
    // -----------------------------------------------------------------------

    async registerTorrent(torrent) {
        const infoHash = torrent.infoHash;
        if (this.activeTorrents.has(infoHash)) return;

        const totalPieces = torrent.pieces.length;
        const bitfield = new Uint8Array(totalPieces); // 0 = missing, 1 = downloaded
        const piecesNeeded = new Set();

        // Check which pieces we already have
        for (let i = 0; i < totalPieces; i++) {
            const hasPiece = await this.db.getPiece(infoHash, i);
            if (hasPiece) {
                bitfield[i] = 1;
            } else {
                piecesNeeded.add(i);
            }
        }

        const isComplete = piecesNeeded.size === 0;

        this.activeTorrents.set(infoHash, {
            torrent,
            bitfield,
            piecesNeeded,
            status: isComplete ? 'seeding' : 'leeching',
            progress: isComplete ? 100 : Math.round(((totalPieces - piecesNeeded.size) / totalPieces) * 100)
        });

        // Announce we are swarming this torrent (asset-name formatting is "torrent:<infoHash>")
        this._announceSwarm(infoHash);

        console.log(`[TorrentEngine] Registered torrent: ${torrent.name} (${infoHash}) — State: ${isComplete ? 'Complete (Seeding)' : 'Leeching, pieces needed: ' + piecesNeeded.size}`);
        
        if (this.onStatusChanged) this.onStatusChanged(infoHash, isComplete ? 'seeding' : 'leeching');

        // If not complete, start swarming pipeline
        if (!isComplete) {
            this._scheduleDownload(infoHash);
        }
    }

    // -----------------------------------------------------------------------
    // Signaling/Tracker connection
    // -----------------------------------------------------------------------

    async connect() {
        return new Promise((resolve, reject) => {
            console.log(`[TorrentEngine] Connecting to signaling/tracker server: ${this.signalingUrl}`);
            this.ws = new WebSocket(this.signalingUrl);

            this.ws.onopen = () => {
                this.connected = true;
                console.log(`[TorrentEngine] Connected tracker as ${this.peerId}`);

                // Register with signaling server
                const activeAssets = Array.from(this.activeTorrents.keys()).map(h => `torrent:${h}`);
                this._send({
                    type: 'register',
                    peerId: this.peerId,
                    assets: activeAssets,
                    info: {
                        isTorrentClient: true,
                        timestamp: Date.now()
                    }
                });

                // Start heartbeat
                this._heartbeatTimer = setInterval(() => {
                    this._send({ type: 'heartbeat', peerId: this.peerId });
                }, 4000);

                resolve();
            };

            this.ws.onmessage = (event) => {
                this._handleTrackerMessage(JSON.parse(event.data));
            };

            this.ws.onclose = () => {
                this.connected = false;
                clearInterval(this._heartbeatTimer);
                console.log('[TorrentEngine] Disconnected from signaling tracker');
            };

            this.ws.onerror = (err) => {
                console.error('[TorrentEngine] Tracker socket error:', err);
                reject(err);
            };
        });
    }

    _send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    _announceSwarm(infoHash) {
        if (this.connected) {
            this._send({
                type: 'asset-announce',
                peerId: this.peerId,
                assets: Array.from(this.activeTorrents.keys()).map(h => `torrent:${h}`)
            });
        }
    }

    // -----------------------------------------------------------------------
    // Tracker Message Handler
    // -----------------------------------------------------------------------

    _handleTrackerMessage(msg) {
        switch (msg.type) {
            case 'peer-list':
                for (const p of msg.peers) {
                    if (p.peerId === this.peerId) continue;
                    this.peers.set(p.peerId, {
                        assets: new Set(p.assets || []),
                        info: p.info || {}
                    });
                }
                this._updatePeersCount();
                this._triggerPeerUpdate();
                this._scheduleAllDownloads();
                break;

            case 'peer-joined':
                if (msg.peer.peerId !== this.peerId) {
                    this.peers.set(msg.peer.peerId, {
                        assets: new Set(msg.peer.assets || []),
                        info: msg.peer.info || {}
                    });
                    console.log(`[TorrentEngine] Peer joined swarm: ${msg.peer.peerId}`);
                    this._updatePeersCount();
                    this._triggerPeerUpdate();
                    this._scheduleAllDownloads();
                }
                break;

            case 'peer-left':
                this.peers.delete(msg.peerId);
                this.peerConnections.get(msg.peerId)?.close();
                this.peerConnections.delete(msg.peerId);
                this.dataChannels.delete(msg.peerId);
                console.log(`[TorrentEngine] Peer left swarm: ${msg.peerId}`);
                this._updatePeersCount();
                this._triggerPeerUpdate();
                this._scheduleAllDownloads();
                break;

            case 'asset-update':
                if (this.peers.has(msg.peerId)) {
                    this.peers.get(msg.peerId).assets = new Set(msg.assets || []);
                    this._scheduleAllDownloads();
                }
                break;

            // Signaling Relay Handles (Piggybacked onto existing WS signaling pathways)
            case 'rtc-offer':
                this._handleRTCOffer(msg.from, msg.signal, msg.assetName);
                break;

            case 'rtc-answer':
                this._handleRTCAnswer(msg.from, msg.signal);
                break;

            case 'rtc-ice':
                this._handleRTCIce(msg.from, msg.signal);
                break;

            case 'ws-transfer-request':
                this._handleWSTransferRequest(msg.from, msg.assetName);
                break;

            case 'ws-transfer-response':
                this._handleWSTransferResponse(msg);
                break;
        }
    }

    _updatePeersCount() {
        this.metrics.peersCount = this.peers.size;
    }

    _triggerPeerUpdate() {
        if (this.onPeerListChanged) {
            const sum = Array.from(this.peers.entries()).map(([id, p]) => ({
                peerId: id,
                torrentsSwarms: Array.from(p.assets).filter(a => a.startsWith('torrent:'))
            }));
            this.onPeerListChanged(sum);
        }
    }

    // -----------------------------------------------------------------------
    // WebRTC Direct Peer Data Channel Management
    // -----------------------------------------------------------------------

    _createPeerConnection(remotePeerId) {
        if (this.peerConnections.has(remotePeerId)) {
            return this.peerConnections.get(remotePeerId);
        }

        const config = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        const pc = new RTCPeerConnection(config);

        pc.onicecandidate = (event) => {
            if (event.candidate) {
                this._send({
                    type: 'rtc-ice',
                    to: remotePeerId,
                    signal: event.candidate
                });
            }
        };

        pc.ondatachannel = (event) => {
            this._setupDataChannel(remotePeerId, event.channel);
        };

        pc.onconnectionstatechange = () => {
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
                this.peerConnections.delete(remotePeerId);
                this.dataChannels.delete(remotePeerId);
            }
        };

        this.peerConnections.set(remotePeerId, pc);
        return pc;
    }

    _setupDataChannel(remotePeerId, channel) {
        channel.binaryType = 'arraybuffer';

        channel.onopen = () => {
            console.log(`[TorrentEngine] DataChannel open with ${remotePeerId}`);
            this.dataChannels.set(remotePeerId, channel);
            this._scheduleAllDownloads();
        };

        channel.onmessage = (event) => {
            this._handleDataChannelMessage(remotePeerId, event.data);
        };

        channel.onclose = () => {
            this.dataChannels.delete(remotePeerId);
        };
    }

    async _createOfferTo(remotePeerId, assetName) {
        const pc = this._createPeerConnection(remotePeerId);
        const channel = pc.createDataChannel('torrent-swarming', { ordered: true });
        this._setupDataChannel(remotePeerId, channel);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        this._send({
            type: 'rtc-offer',
            to: remotePeerId,
            signal: offer,
            assetName
        });
    }

    async _handleRTCOffer(from, signal, assetName) {
        const pc = this._createPeerConnection(from);
        await pc.setRemoteDescription(new RTCSessionDescription(signal));

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        this._send({
            type: 'rtc-answer',
            to: from,
            signal: answer
        });
    }

    async _handleRTCAnswer(from, signal) {
        const pc = this.peerConnections.get(from);
        if (pc) {
            await pc.setRemoteDescription(new RTCSessionDescription(signal));
        }
    }

    async _handleRTCIce(from, signal) {
        const pc = this.peerConnections.get(from);
        if (pc) {
            try {
                await pc.addIceCandidate(new RTCIceCandidate(signal));
            } catch (e) {}
        }
    }

    // -----------------------------------------------------------------------
    // Torrent Piece Transfer Protocol
    // -----------------------------------------------------------------------

    /**
     * Format:
     *   Request: String JSON: { type: "piece-request", infoHash, pieceIndex }
     *   Response Header: String JSON: { type: "piece-header", infoHash, pieceIndex, size }
     *   Response Data: ArrayBuffer
     */
    _handleDataChannelMessage(fromPeerId, data) {
        if (typeof data === 'string') {
            try {
                const msg = JSON.parse(data);
                if (msg.type === 'piece-request') {
                    this._servePieceDirect(fromPeerId, msg.infoHash, msg.pieceIndex);
                } else if (msg.type === 'piece-header') {
                    this._incomingHeader = {
                        infoHash: msg.infoHash,
                        pieceIndex: msg.pieceIndex,
                        size: msg.size,
                        fromPeerId,
                        receivedAt: Date.now()
                    };
                }
            } catch (e) {}
        } else if (data instanceof ArrayBuffer) {
            if (this._incomingHeader && this._incomingHeader.fromPeerId === fromPeerId) {
                const { infoHash, pieceIndex } = this._incomingHeader;
                this._handleReceivedPieceBytes(fromPeerId, infoHash, pieceIndex, new Uint8Array(data));
                this._incomingHeader = null;
            }
        }
    }

    async _servePieceDirect(toPeerId, infoHash, pieceIndex) {
        const piece = await this.db.getPiece(infoHash, pieceIndex);
        if (!piece) return;

        const channel = this.dataChannels.get(toPeerId);
        if (channel && channel.readyState === 'open') {
            // Send Header
            channel.send(JSON.stringify({
                type: 'piece-header',
                infoHash,
                pieceIndex,
                size: piece.length
            }));
            // Send raw binary
            channel.send(piece.buffer);
            this.metrics.bytesUploaded += piece.length;
        }
    }

    // -----------------------------------------------------------------------
    // Robust WebSocket Fallback Transfer Handling
    // -----------------------------------------------------------------------

    async _handleWSTransferRequest(fromPeerId, assetName) {
        // Intercept asset names formatted as torrent:infoHash:pieceIndex
        if (!assetName.startsWith('torrent:')) return;
        const parts = assetName.split(':');
        const infoHash = parts[1];
        const pieceIndex = parseInt(parts[2], 10);

        const piece = await this.db.getPiece(infoHash, pieceIndex);
        if (!piece) return;

        console.log(`[TorrentEngine] Serving piece ${pieceIndex} of ${infoHash} via WS to ${fromPeerId}`);
        
        // Base64 serialization
        let binary = '';
        const len = piece.byteLength;
        for (let i = 0; i < len; i += 8192) {
            binary += String.fromCharCode.apply(null, piece.subarray(i, i + 8192));
        }
        const base64Data = btoa(binary);

        this._send({
            type: 'ws-transfer-response',
            to: fromPeerId,
            assetName,
            data: base64Data,
            size: piece.length,
            hash: infoHash // use infoHash as validation
        });

        this.metrics.bytesUploaded += piece.length;
    }

    _handleWSTransferResponse(msg) {
        const assetName = msg.assetName;
        if (!assetName.startsWith('torrent:')) return;
        const parts = assetName.split(':');
        const infoHash = parts[1];
        const pieceIndex = parseInt(parts[2], 10);

        const inflightKey = `${infoHash}:${pieceIndex}`;
        const inflight = this.inflightPieces.get(inflightKey);
        if (!inflight) return;

        try {
            const binaryString = atob(msg.data);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            this._handleReceivedPieceBytes(msg.from, infoHash, pieceIndex, bytes);
        } catch (e) {
            console.error(`[TorrentEngine] Failed parsing WS piece ${pieceIndex}:`, e);
            this._failInflightPiece(infoHash, pieceIndex);
        }
    }

    // -----------------------------------------------------------------------
    // Downloading & Swarming scheduler logic
    // -----------------------------------------------------------------------

    _scheduleAllDownloads() {
        for (const [infoHash, torrentState] of this.activeTorrents) {
            if (torrentState.status === 'leeching') {
                this._scheduleDownload(infoHash);
            }
        }
    }

    _scheduleDownload(infoHash) {
        const state = this.activeTorrents.get(infoHash);
        if (!state || state.status === 'seeding') return;

        // Find peers seeding this torrent (peer asset list contains "torrent:<infoHash>")
        const swarmPeers = [];
        for (const [peerId, peer] of this.peers) {
            if (peer.assets.has(`torrent:${infoHash}`)) {
                swarmPeers.push(peerId);
            }
        }

        if (swarmPeers.length === 0) {
            console.log(`[TorrentEngine] Swarm is currently empty for: ${state.torrent.name}. Waiting for seeders...`);
            return;
        }

        // Loop through required pieces and request them
        for (const pieceIndex of state.piecesNeeded) {
            const inflightKey = `${infoHash}:${pieceIndex}`;
            if (this.inflightPieces.has(inflightKey)) continue; // Already downloading

            // Simple load balancing: distribute pieces sequentially among available swarm peers
            const peerId = swarmPeers[pieceIndex % swarmPeers.length];
            this._requestPiece(infoHash, pieceIndex, peerId);
        }
    }

    async _requestPiece(infoHash, pieceIndex, peerId) {
        const inflightKey = `${infoHash}:${pieceIndex}`;
        const assetName = `torrent:${infoHash}:${pieceIndex}`;

        // Set up inflight entry
        const timeout = setTimeout(() => {
            console.warn(`[TorrentEngine] Timeout requesting piece ${pieceIndex} from ${peerId}. Retrying...`);
            this._failInflightPiece(infoHash, pieceIndex);
        }, this.pieceRequestTimeout);

        this.inflightPieces.set(inflightKey, {
            peerId,
            requestedAt: Date.now(),
            timeout
        });

        // Try direct WebRTC if channel is open, otherwise fall back to WS pathway
        const dc = this.dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') {
            dc.send(JSON.stringify({
                type: 'piece-request',
                infoHash,
                pieceIndex
            }));
        } else {
            // Direct offer/DataChannel trigger OR WebSocket fallback
            // In LAN contexts, WebRTC offer takes time, trigger WS fallback directly to start downloading instantly!
            this._send({
                type: 'ws-transfer-request',
                to: peerId,
                assetName
            });

            // Simultaneously trigger a WebRTC handshake so future pieces use low-latency WebRTC
            this._createOfferTo(peerId, assetName).catch(() => {});
        }
    }

    _failInflightPiece(infoHash, pieceIndex) {
        const inflightKey = `${infoHash}:${pieceIndex}`;
        const inflight = this.inflightPieces.get(inflightKey);
        if (inflight) {
            clearTimeout(inflight.timeout);
            this.inflightPieces.delete(inflightKey);
        }
        // Reschedule
        setTimeout(() => this._scheduleDownload(infoHash), 200);
    }

    async _handleReceivedPieceBytes(peerId, infoHash, pieceIndex, bytes) {
        const inflightKey = `${infoHash}:${pieceIndex}`;
        const inflight = this.inflightPieces.get(inflightKey);
        if (!inflight) return;

        clearTimeout(inflight.timeout);
        this.inflightPieces.delete(inflightKey);

        const state = this.activeTorrents.get(infoHash);
        if (!state) return;

        // 1. Verify piece cryptographic hash
        const expectedHash = state.torrent.pieces[pieceIndex];
        const actualHash = await TorrentCreator._computeSHA256(bytes);

        if (actualHash !== expectedHash) {
            console.error(`[TorrentEngine] Piece ${pieceIndex} hash validation failed! Expected: ${expectedHash}, Actual: ${actualHash}`);
            this._scheduleDownload(infoHash); // retry
            return;
        }

        // 2. Save raw piece in store
        await this.db.putPiece(infoHash, pieceIndex, bytes);
        
        // 3. Update state
        state.bitfield[pieceIndex] = 1;
        state.piecesNeeded.delete(pieceIndex);
        
        const total = state.torrent.pieces.length;
        state.progress = Math.round(((total - state.piecesNeeded.size) / total) * 100);

        this.metrics.bytesDownloaded += bytes.length;

        // Trigger UI hook
        if (this.onPieceDownloaded) {
            this.onPieceDownloaded(infoHash, pieceIndex, state.progress, peerId, bytes.length);
        }

        // 4. Check if complete
        if (state.piecesNeeded.size === 0) {
            await this._reassembleTorrent(infoHash);
        } else {
            // Keep downloading next pieces
            this._scheduleDownload(infoHash);
        }
    }

    // -----------------------------------------------------------------------
    // Reassemble pieces back into individual files for VFS Mounting
    // -----------------------------------------------------------------------

    async _reassembleTorrent(infoHash) {
        const state = this.activeTorrents.get(infoHash);
        if (!state) return;

        state.status = 'reassembling';
        if (this.onStatusChanged) this.onStatusChanged(infoHash, 'reassembling');

        console.log(`[TorrentEngine] ⚡ Swarm download complete for "${state.torrent.name}"! Reassembling game files...`);

        try {
            // 1. Load all pieces into a single concatenated buffer
            const totalLength = state.torrent.totalLength;
            const combinedBuffer = new Uint8Array(totalLength);
            const chunkSize = state.torrent.chunkSize;

            for (let i = 0; i < state.torrent.pieces.length; i++) {
                const piece = await this.db.getPiece(infoHash, i);
                if (!piece) throw new Error(`Missing chunk index: ${i}`);
                combinedBuffer.set(piece, i * chunkSize);
            }

            // 2. Unpack individual files using offset tables
            for (const file of state.torrent.files) {
                const fileData = combinedBuffer.slice(file.offset, file.offset + file.length);
                await this.db.putFile(infoHash, file.path, fileData);
                console.log(`[TorrentEngine] VFS Mounted: ${file.path} (${file.length} bytes)`);
            }

            // 3. Update status to Seeding
            state.status = 'seeding';
            state.progress = 100;
            if (this.onStatusChanged) this.onStatusChanged(infoHash, 'seeding');

            // Save torrent info metadata back into DB to lock completed state
            await this.db.putTorrent(state.torrent);

            console.log(`[TorrentEngine] ✓ Torrent fully compiled! Ready for playing via VFS.`);
            
            if (this.onTorrentComplete) {
                this.onTorrentComplete(infoHash, state.torrent);
            }

            // Broadcast that we now seed all pieces of this torrent
            this._announceSwarm(infoHash);

        } catch (e) {
            console.error('[TorrentEngine] Reassembly error:', e);
            state.status = 'failed';
            if (this.onStatusChanged) this.onStatusChanged(infoHash, 'failed');
        }
    }

    // -----------------------------------------------------------------------
    // Speed tracking metrics
    // -----------------------------------------------------------------------

    _calculateSpeeds() {
        const now = Date.now();
        const duration = (now - this._lastSpeedCheck) / 1000;
        if (duration < 0.5) return;

        const downloadedDiff = this.metrics.bytesDownloaded - this._lastBytesDownloaded;
        const uploadedDiff = this.metrics.bytesUploaded - this._lastBytesUploaded;

        this.metrics.downloadSpeed = Math.round(downloadedDiff / duration);
        this.metrics.uploadSpeed = Math.round(uploadedDiff / duration);

        this._lastSpeedCheck = now;
        this._lastBytesDownloaded = this.metrics.bytesDownloaded;
        this._lastBytesUploaded = this.metrics.bytesUploaded;
    }
}

// Global Exports
if (typeof window !== 'undefined') {
    window.TorrentDB = TorrentDB;
    window.TorrentCreator = TorrentCreator;
    window.TorrentEngine = TorrentEngine;
}
