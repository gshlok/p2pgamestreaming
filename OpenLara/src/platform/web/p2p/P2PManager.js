/**
 * P2PManager — Core peer-to-peer asset streaming orchestrator
 * 
 * Manages WebSocket signaling connection, WebRTC DataChannel connections
 * to peers, and coordinates asset fetching with fallback to origin.
 * 
 * Architecture:
 *   Browser  ←→  Signaling Server (WebSocket)  ←→  Browser
 *   Browser  ←→  Peer (WebRTC DataChannel)      ←→  Browser
 * 
 * The signaling server is used only for peer discovery and WebRTC handshake.
 * Actual asset data flows directly between peers via DataChannels.
 */
class P2PManager {
    constructor(options = {}) {
        this.peerId = options.peerId || 'peer_' + Math.random().toString(36).substr(2, 8);
        this.signalingUrl = options.signalingUrl || this._autoDetectSignalingUrl();
        this.peerTimeout = options.peerTimeout || 2500;  // ms to wait for peer response before origin fallback

        // CRITICAL: Use the original fetch for origin fallback to avoid
        // infinite recursion with the bootstrap's fetch wrapper.
        this._originalFetch = options.originalFetch || window.fetch.bind(window);
        this._originFetchesInFlight = options.originFetchesInFlight || new Set();

        // State
        this.ws = null;
        this.connected = false;
        this.peers = new Map();           // Map<peerId, { assets: Set, connection, channels, info }>
        this.localAssets = new Set();      // Set<assetName> — what we have cached
        this.assetHashes = new Map();      // Map<assetName, sha256Hash>
        this.pendingRequests = new Map();  // Map<assetName, { resolve, reject, timeout }>
        this.peerConnections = new Map();  // Map<peerId, RTCPeerConnection>
        this.dataChannels = new Map();     // Map<peerId, RTCDataChannel>
        this.webrtcSupported = typeof RTCPeerConnection !== 'undefined';

        // Metrics
        this.metrics = {
            fromPeers: 0,
            fromOrigin: 0,
            bytesFromPeers: 0,
            bytesFromOrigin: 0,
            transfers: [],               // { assetName, source, peerId, size, duration, timestamp }
            startTime: Date.now()
        };

        // Cache
        this.cache = new AssetCache();

        // Callbacks (overlay hooks into these)
        this.onPeerListChanged = null;
        this.onTransfer = null;
        this.onMetricsUpdate = null;

        // Incoming asset data reassembly
        this._incomingChunks = new Map();  // Map<assetName, { chunks: [], totalSize, received }>

        this._heartbeatTimer = null;
    }

    _autoDetectSignalingUrl() {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${proto}//${location.host}/ws`;
    }

    // -----------------------------------------------------------------------
    // Connection lifecycle
    // -----------------------------------------------------------------------

    async connect() {
        await this.cache.ready();

        // Populate local assets from cache
        const cached = await this.cache.listAssets();
        for (const name of cached) {
            this.localAssets.add(name);
        }

        return new Promise((resolve, reject) => {
            console.log(`[P2P] Connecting to signaling server: ${this.signalingUrl}`);
            this.ws = new WebSocket(this.signalingUrl);

            this.ws.onopen = () => {
                this.connected = true;
                console.log(`[P2P] Connected as ${this.peerId}`);

                // Register with signaling server
                this._send({
                    type: 'register',
                    peerId: this.peerId,
                    assets: Array.from(this.localAssets),
                    info: {
                        userAgent: navigator.userAgent.slice(0, 50),
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
                this._handleSignalingMessage(JSON.parse(event.data));
            };

            this.ws.onclose = () => {
                this.connected = false;
                clearInterval(this._heartbeatTimer);
                console.log('[P2P] Disconnected from signaling server');
            };

            this.ws.onerror = (err) => {
                console.error('[P2P] WebSocket error:', err);
                reject(err);
            };
        });
    }

    disconnect() {
        clearInterval(this._heartbeatTimer);
        for (const [, pc] of this.peerConnections) {
            pc.close();
        }
        this.peerConnections.clear();
        this.dataChannels.clear();
        if (this.ws) {
            this.ws.close();
        }
        this.connected = false;
    }

    isConnected() {
        return this.connected && this.ws && this.ws.readyState === WebSocket.OPEN;
    }

    _send(msg) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(msg));
        }
    }

    // -----------------------------------------------------------------------
    // Signaling message handler
    // -----------------------------------------------------------------------

    _handleSignalingMessage(msg) {
        switch (msg.type) {
            case 'peer-list':
                for (const peer of msg.peers) {
                    this.peers.set(peer.peerId, {
                        assets: new Set(peer.assets || []),
                        info: peer.info || {}
                    });
                }
                console.log(`[P2P] Peer list: ${this.peers.size} peers`);
                if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
                break;

            case 'peer-joined':
                this.peers.set(msg.peer.peerId, {
                    assets: new Set(msg.peer.assets || []),
                    info: msg.peer.info || {}
                });
                console.log(`[P2P] Peer joined: ${msg.peer.peerId} (${this.peers.size} total)`);
                if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
                break;

            case 'peer-left':
                this.peers.delete(msg.peerId);
                this.peerConnections.get(msg.peerId)?.close();
                this.peerConnections.delete(msg.peerId);
                this.dataChannels.delete(msg.peerId);
                console.log(`[P2P] Peer left: ${msg.peerId} (${this.peers.size} remaining)`);
                if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
                break;

            case 'asset-update':
                if (this.peers.has(msg.peerId)) {
                    this.peers.get(msg.peerId).assets = new Set(msg.assets || []);
                }
                break;

            // WebRTC signaling
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

            // Incoming asset request from another peer
            case 'asset-request':
                this._handleAssetRequest(msg.from, msg.assetName);
                break;
        }
    }

    // -----------------------------------------------------------------------
    // WebRTC DataChannel management
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
            console.log(`[P2P] DataChannel open with ${remotePeerId}`);
            this.dataChannels.set(remotePeerId, channel);
        };

        channel.onmessage = (event) => {
            this._handleDataChannelMessage(remotePeerId, event.data);
        };

        channel.onclose = () => {
            console.log(`[P2P] DataChannel closed with ${remotePeerId}`);
            this.dataChannels.delete(remotePeerId);
        };

        channel.onerror = (err) => {
            console.error(`[P2P] DataChannel error with ${remotePeerId}:`, err);
        };
    }

    async _createOfferTo(remotePeerId, assetName) {
        const pc = this._createPeerConnection(remotePeerId);

        // Create data channel for asset transfer
        const channel = pc.createDataChannel('assets', {
            ordered: true
        });
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
            } catch (e) {
                console.warn(`[P2P] ICE candidate error from ${from}:`, e.message);
            }
        }
    }

    // -----------------------------------------------------------------------
    // DataChannel message handling (binary transfer protocol)
    // -----------------------------------------------------------------------

    /**
     * Protocol:
     *   Request:  JSON string { type: "request", assetName: "level/1/LEVEL2.PSX" }
     *   Response header: JSON string { type: "asset-header", assetName, size, hash }
     *   Response data: ArrayBuffer (the raw asset binary)
     *   
     * For simplicity in the hackathon, we send the entire asset in one message
     * (WebRTC DataChannels handle chunking internally via SCTP).
     */
    _handleDataChannelMessage(fromPeerId, data) {
        if (typeof data === 'string') {
            const msg = JSON.parse(data);

            if (msg.type === 'request') {
                // Another peer is requesting an asset from us
                this._serveAsset(fromPeerId, msg.assetName);
            } else if (msg.type === 'asset-header') {
                // Prepare to receive binary data
                this._incomingChunks.set(msg.assetName, {
                    hash: msg.hash,
                    size: msg.size,
                    fromPeerId,
                    startTime: Date.now()
                });
            }
        } else if (data instanceof ArrayBuffer) {
            // Binary data — match it to a pending header
            this._handleBinaryData(fromPeerId, data);
        }
    }

    async _serveAsset(toPeerId, assetName) {
        const cached = await this.cache.get(assetName);
        if (!cached) {
            console.warn(`[P2P] Peer ${toPeerId} requested ${assetName} but we don't have it`);
            return;
        }

        const channel = this.dataChannels.get(toPeerId);
        if (!channel || channel.readyState !== 'open') {
            console.warn(`[P2P] No open channel to ${toPeerId}`);
            return;
        }

        console.log(`[P2P] Serving ${assetName} (${(cached.size / 1024).toFixed(1)}KB) to ${toPeerId}`);

        const startTime = Date.now();

        // Send header
        channel.send(JSON.stringify({
            type: 'asset-header',
            assetName,
            size: cached.size,
            hash: cached.hash
        }));

        // Send binary data
        channel.send(cached.data.buffer);

        // Record Upload Transfer
        const duration = Date.now() - startTime;
        this._recordTransfer(assetName, 'upload', toPeerId, cached.size, duration);
    }

    _handleBinaryData(fromPeerId, buffer) {
        // Find the pending header that matches this peer
        for (const [assetName, info] of this._incomingChunks) {
            if (info.fromPeerId === fromPeerId) {
                const data = new Uint8Array(buffer);
                const duration = Date.now() - info.startTime;

                console.log(`[P2P] Received ${assetName} (${(data.length / 1024).toFixed(1)}KB) from ${fromPeerId} in ${duration}ms`);

                // Resolve the pending request
                const pending = this.pendingRequests.get(assetName);
                if (pending) {
                    clearTimeout(pending.timeout);
                    pending.resolve({
                        data,
                        source: 'peer',
                        peerId: fromPeerId,
                        hash: info.hash,
                        duration
                    });
                    this.pendingRequests.delete(assetName);
                }

                this._incomingChunks.delete(assetName);
                return;
            }
        }

        console.warn(`[P2P] Received unexpected binary data from ${fromPeerId}`);
    }

    // -----------------------------------------------------------------------
    // Asset request from another peer (signaling-based)
    // -----------------------------------------------------------------------

    async _handleAssetRequest(fromPeerId, assetName) {
        if (!this.localAssets.has(assetName)) return;

        // Ensure we have a DataChannel to this peer
        if (!this.dataChannels.has(fromPeerId) || this.dataChannels.get(fromPeerId).readyState !== 'open') {
            // Need to establish connection first
            await this._createOfferTo(fromPeerId, assetName);

            // Wait for channel to open
            await new Promise((resolve) => {
                const check = setInterval(() => {
                    const ch = this.dataChannels.get(fromPeerId);
                    if (ch && ch.readyState === 'open') {
                        clearInterval(check);
                        resolve();
                    }
                }, 100);
                // Timeout after 5s
                setTimeout(() => { clearInterval(check); resolve(); }, 5000);
            });
        }

        this._serveAsset(fromPeerId, assetName);
    }

    // -----------------------------------------------------------------------
    // Main API: fetchAsset
    // -----------------------------------------------------------------------

    /**
     * Fetch an asset — tries peers first, falls back to origin.
     * 
     * @param {string} assetName - e.g., "level/1/LEVEL2.PSX"
     * @returns {Promise<{data: Uint8Array, source: string, peerId?: string}>}
     */
    async fetchAsset(assetName) {
        // DEDUP: If this exact asset is already being fetched, wait on the
        // existing promise instead of spawning another origin request.
        if (this._inflight && this._inflight.has(assetName)) {
            console.log(`[P2P] Dedup: waiting on in-flight request for ${assetName}`);
            return this._inflight.get(assetName);
        }

        const promise = this._doFetchAsset(assetName);

        // Track in-flight
        if (!this._inflight) this._inflight = new Map();
        this._inflight.set(assetName, promise);
        promise.finally(() => this._inflight.delete(assetName));

        return promise;
    }

    async _doFetchAsset(assetName) {
        const startTime = Date.now();

        // 1. Check local cache first
        const cached = await this.cache.get(assetName);
        if (cached) {
            this._recordTransfer(assetName, 'cache', null, cached.size, 0);
            return { data: cached.data, source: 'cache' };
        }

        // 2. Find peers who have this asset
        const peersWithAsset = [];
        for (const [peerId, peer] of this.peers) {
            if (peer.assets.has(assetName)) {
                peersWithAsset.push(peerId);
            }
        }

        // 3. Try to get from a peer
        if (peersWithAsset.length > 0) {
            try {
                let result = null;
                if (this.webrtcSupported) {
                    result = await this._fetchFromPeer(assetName, peersWithAsset);
                }

                // If WebRTC is unsupported or failed, try WebSocket fallback!
                if (!result) {
                    for (const peerId of peersWithAsset) {
                        result = await this._fetchFromPeerViaWS(assetName, peerId);
                        if (result) break;
                    }
                }

                if (result) {
                    // Verify integrity if we have a known hash
                    const knownHash = this.assetHashes.get(assetName);
                    if (knownHash && result.hash !== knownHash) {
                        console.warn(`[P2P] Hash mismatch for ${assetName}! Falling back to origin.`);
                    } else {
                        // Cache it
                        const cacheEntry = await this.cache.put(assetName, result.data, 'peer');
                        this.localAssets.add(assetName);
                        this.assetHashes.set(assetName, cacheEntry.hash);

                        // Announce to other peers
                        this.announceAsset(assetName);

                        const duration = Date.now() - startTime;
                        this._recordTransfer(assetName, 'peer', result.peerId, result.data.length, duration);
                        return { data: result.data, source: 'peer', peerId: result.peerId };
                    }
                }
            } catch (e) {
                console.warn(`[P2P] Peer fetch failed for ${assetName}:`, e.message);
            }
        }

        // 4. Fallback to origin
        try {
            const data = await this._fetchFromOrigin(assetName);
            const cacheEntry = await this.cache.put(assetName, data, 'origin');
            this.localAssets.add(assetName);
            this.assetHashes.set(assetName, cacheEntry.hash);

            // Announce to other peers
            this.announceAsset(assetName);

            const duration = Date.now() - startTime;
            this._recordTransfer(assetName, 'origin', null, data.length, duration);
            return { data, source: 'origin' };
        } catch (e) {
            console.error(`[P2P] Origin fetch also failed for ${assetName}:`, e.message);
            throw e;
        }
    }

    /**
     * Try fetching from peers via WebRTC DataChannel
     */
    async _fetchFromPeer(assetName, peerIds) {
        // Try the first available peer
        for (const peerId of peerIds) {
            try {
                // Check if we already have an open channel
                let channel = this.dataChannels.get(peerId);

                if (!channel || channel.readyState !== 'open') {
                    // Establish connection
                    await this._createOfferTo(peerId, assetName);

                    // Wait for channel to open (with timeout)
                    channel = await new Promise((resolve, reject) => {
                        const timeout = setTimeout(() => reject(new Error('Channel open timeout')), 5000);
                        const check = setInterval(() => {
                            const ch = this.dataChannels.get(peerId);
                            if (ch && ch.readyState === 'open') {
                                clearInterval(check);
                                clearTimeout(timeout);
                                resolve(ch);
                            }
                        }, 50);
                    });
                }

                // Send request and wait for response
                return await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        this.pendingRequests.delete(assetName);
                        reject(new Error(`Peer ${peerId} timeout`));
                    }, this.peerTimeout);

                    this.pendingRequests.set(assetName, { resolve, reject, timeout });

                    channel.send(JSON.stringify({ type: 'request', assetName }));
                });
            } catch (e) {
                console.warn(`[P2P] Failed to fetch ${assetName} from ${peerId}:`, e.message);
                continue;
            }
        }
        return null;
    }

    /**
     * Fetch from origin server (normal HTTP)
     * Uses _originalFetch to bypass the bootstrap's fetch wrapper
     * and avoid infinite recursion.
     */
    async _fetchFromOrigin(assetName) {
        // Register this URL so the bootstrap wrapper lets it pass through
        // even if _originalFetch somehow routes back through window.fetch
        this._originFetchesInFlight.add(assetName);
        try {
            const response = await this._originalFetch(assetName, { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${response.status}: ${assetName}`);
            const buffer = await response.arrayBuffer();
            return new Uint8Array(buffer);
        } finally {
            this._originFetchesInFlight.delete(assetName);
        }
    }

    /**
     * Announce that we now have a new asset
     */
    announceAsset(assetName) {
        this.localAssets.add(assetName);
        if (this.isConnected()) {
            this._send({
                type: 'asset-announce',
                peerId: this.peerId,
                assets: [assetName]
            });
        }
    }

    // -----------------------------------------------------------------------
    // Metrics
    // -----------------------------------------------------------------------

    _recordTransfer(assetName, source, peerId, size, duration) {
        const transfer = {
            assetName,
            source,
            peerId,
            size,
            duration,
            timestamp: Date.now()
        };

        this.metrics.transfers.push(transfer);

        if (source === 'peer') {
            this.metrics.fromPeers++;
            this.metrics.bytesFromPeers += size;
        } else if (source === 'origin') {
            this.metrics.fromOrigin++;
            this.metrics.bytesFromOrigin += size;
        } else if (source === 'upload') {
            if (!this.metrics.bytesUploaded) {
                this.metrics.bytesUploaded = 0;
                this.metrics.uploadsCount = 0;
            }
            this.metrics.bytesUploaded += size;
            this.metrics.uploadsCount++;
        }
        // 'cache' doesn't count towards transfer metrics

        if (this.onTransfer) this.onTransfer(transfer);
        if (this.onMetricsUpdate) this.onMetricsUpdate(this.getMetrics());
    }

    getMetrics() {
        const total = this.metrics.fromPeers + this.metrics.fromOrigin;
        return {
            peersConnected: this.peers.size,
            fromPeers: this.metrics.fromPeers,
            fromOrigin: this.metrics.fromOrigin,
            peerPercent: total > 0 ? Math.round((this.metrics.fromPeers / total) * 100) : 0,
            originPercent: total > 0 ? Math.round((this.metrics.fromOrigin / total) * 100) : 0,
            bytesFromPeers: this.metrics.bytesFromPeers,
            bytesFromOrigin: this.metrics.bytesFromOrigin,
            bytesSaved: this.metrics.bytesFromPeers,
            bytesUploaded: this.metrics.bytesUploaded || 0,
            uploadsCount: this.metrics.uploadsCount || 0,
            totalTransfers: total,
            recentTransfers: this.metrics.transfers.slice(-10),
            localAssetCount: this.localAssets.size,
            uptime: Date.now() - this.metrics.startTime
        };
    }

    /**
     * Try fetching from a peer via the signaling server WebSocket channel (robust HTTP fallback)
     */
    async _fetchFromPeerViaWS(assetName, peerId) {
        console.log(`[P2P] WebRTC failed or unsupported. Trying WebSocket fallback to fetch ${assetName} from ${peerId}`);
        const startTime = Date.now();
        try {
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingRequests.delete(assetName);
                    reject(new Error(`WS fallback timeout for ${assetName} from ${peerId}`));
                }, this.peerTimeout + 2500); // Allow extra time for base64 serialization

                this.pendingRequests.set(assetName, { resolve, reject, timeout });

                this._send({
                    type: 'ws-transfer-request',
                    to: peerId,
                    assetName
                });
            });
        } catch (e) {
            console.warn(`[P2P] WebSocket fallback fetch failed:`, e.message);
            return null;
        }
    }

    /**
     * Handle incoming WebSocket transfer request from another peer
     */
    async _handleWSTransferRequest(fromPeerId, assetName) {
        console.log(`[P2P] Received WebSocket transfer request from ${fromPeerId} for ${assetName}`);
        const cached = await this.cache.get(assetName);
        if (!cached) {
            console.warn(`[P2P] Peer requested ${assetName} via WS but we do not have it`);
            return;
        }

        const startTime = Date.now();
        // Stack-safe ArrayBuffer to Base64 serialization
        const bytes = new Uint8Array(cached.data);
        let binary = '';
        const len = bytes.byteLength;
        for (let i = 0; i < len; i += 8192) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
        }
        const base64Data = btoa(binary);

        this._send({
            type: 'ws-transfer-response',
            to: fromPeerId,
            assetName,
            data: base64Data,
            size: cached.size,
            hash: cached.hash
        });

        // Record Upload Transfer
        const duration = Date.now() - startTime;
        this._recordTransfer(assetName, 'upload', fromPeerId, cached.size, duration);
    }

    /**
     * Handle incoming WebSocket transfer response
     */
    _handleWSTransferResponse(msg) {
        const pending = this.pendingRequests.get(msg.assetName);
        if (!pending) return;

        this.pendingRequests.delete(msg.assetName);
        clearTimeout(pending.timeout);

        try {
            // Decode base64
            const binaryString = atob(msg.data);
            const len = binaryString.length;
            const bytes = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                bytes[i] = binaryString.charCodeAt(i);
            }

            pending.resolve({
                data: bytes,
                hash: msg.hash,
                peerId: msg.from
            });
        } catch (e) {
            pending.reject(e);
        }
    }

    _getPeerSummary() {
        const summary = [];
        for (const [id, peer] of this.peers) {
            summary.push({
                peerId: id,
                assetCount: peer.assets.size,
                hasChannel: this.dataChannels.has(id)
            });
        }
        return summary;
    }
}

// Export
if (typeof window !== 'undefined') {
    window.P2PManager = P2PManager;
}
