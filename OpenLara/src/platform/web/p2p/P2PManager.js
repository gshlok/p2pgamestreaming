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
        this.peerTimeout = options.peerTimeout || 5000;  // ms to wait for peer response before origin fallback (increased from 2500)

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

        // Track peers we are eagerly connecting to (to avoid duplicate offers)
        this._connectingPeers = new Set();
    }

    /**
     * Normalize an asset path to a consistent format (no leading slash, relative).
     */
    _normalize(path) {
        if (!path) return '';
        let n = path;
        // Strip origin prefix
        if (n.startsWith('http://') || n.startsWith('https://') || n.startsWith('//')) {
            try {
                const url = new URL(n, location.origin);
                n = url.pathname;
            } catch (e) {}
        }
        // Strip leading slash
        return n.replace(/^\//, '');
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
            this.localAssets.add(this._normalize(name));
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
                    assets: Array.from(this.localAssets).map(a => this._normalize(a)),
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
                        assets: new Set((peer.assets || []).map(a => this._normalize(a))),
                        info: peer.info || {}
                    });
                }
                console.log(`[P2P] Peer list: ${this.peers.size} peers`);
                if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());

                // EAGERLY pre-establish DataChannels with all known peers
                for (const peer of msg.peers) {
                    this._eagerConnect(peer.peerId);
                }
                break;

            case 'peer-joined':
                this.peers.set(msg.peer.peerId, {
                    assets: new Set((msg.peer.assets || []).map(a => this._normalize(a))),
                    info: msg.peer.info || {}
                });
                console.log(`[P2P] Peer joined: ${msg.peer.peerId} (${this.peers.size} total)`);
                if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());

                // EAGERLY pre-establish DataChannel with new peer
                this._eagerConnect(msg.peer.peerId);
                break;

            case 'peer-left':
                this.peers.delete(msg.peerId);
                this._connectingPeers.delete(msg.peerId);
                this.peerConnections.get(msg.peerId)?.close();
                this.peerConnections.delete(msg.peerId);
                this.dataChannels.delete(msg.peerId);
                console.log(`[P2P] Peer left: ${msg.peerId} (${this.peers.size} remaining)`);
                if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
                break;

            case 'asset-update':
                if (this.peers.has(msg.peerId)) {
                    this.peers.get(msg.peerId).assets = new Set((msg.assets || []).map(a => this._normalize(a)));
                    console.log(`[P2P] Peer ${msg.peerId} now has ${msg.assets.length} assets`);
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

            // Incoming asset request from another peer (via signaling)
            case 'asset-request':
                this._handleAssetRequest(msg.from, msg.assetName);
                break;

            // WebSocket relay: another peer is sending us asset data through the server
            case 'ws-relay-asset':
                this._handleWSRelayedAsset(msg.from, msg.assetName, msg.data, msg.hash);
                break;
        }
    }

    /**
     * Eagerly establish a WebRTC DataChannel with a peer so it's ready
     * before any asset requests need it. This eliminates the 2-5s setup
     * delay that was causing all P2P fetches to timeout.
     */
    async _eagerConnect(remotePeerId) {
        // Skip if already connected or connecting
        if (this.dataChannels.has(remotePeerId) && this.dataChannels.get(remotePeerId).readyState === 'open') {
            console.log(`[P2P] Already have open DataChannel to ${remotePeerId}, skipping eager connect`);
            return;
        }
        if (this._connectingPeers.has(remotePeerId)) {
            return;
        }

        // Clean up any stale PeerConnection that's stuck in 'new' or 'failed' state
        const existingPC = this.peerConnections.get(remotePeerId);
        if (existingPC) {
            const state = existingPC.connectionState || existingPC.iceConnectionState;
            if (state === 'new' || state === 'failed' || state === 'disconnected' || state === 'closed') {
                console.log(`[P2P] Cleaning up stale PeerConnection to ${remotePeerId} (state: ${state})`);
                existingPC.close();
                this.peerConnections.delete(remotePeerId);
                this.dataChannels.delete(remotePeerId);
            }
        }

        this._connectingPeers.add(remotePeerId);
        console.log(`[P2P] Eagerly connecting to ${remotePeerId}...`);

        try {
            if (typeof RTCPeerConnection === 'undefined') {
                console.warn(`[P2P] RTCPeerConnection unavailable (non-secure context?), skipping eager connect to ${remotePeerId}`);
                return;
            }
            await this._createOfferTo(remotePeerId, '__eager_connect__');
        } catch (e) {
            console.warn(`[P2P] Eager connect to ${remotePeerId} failed:`, e.message);
        } finally {
            this._connectingPeers.delete(remotePeerId);
        }
    }

    // -----------------------------------------------------------------------
    // WebRTC DataChannel management
    // -----------------------------------------------------------------------

    _createPeerConnection(remotePeerId) {
        const existing = this.peerConnections.get(remotePeerId);
        if (existing && existing.connectionState !== 'closed' && existing.connectionState !== 'failed') {
            return existing;
        }
        // Clean up if closed/failed
        if (existing) {
            existing.close();
            this.peerConnections.delete(remotePeerId);
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

        // Send header
        channel.send(JSON.stringify({
            type: 'asset-header',
            assetName,
            size: cached.size,
            hash: cached.hash
        }));

        // Send binary data
        channel.send(cached.data.buffer);
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
        if (!this.localAssets.has(assetName)) {
            console.log(`[P2P] Peer ${fromPeerId} requested ${assetName} but we don't have it`);
            return;
        }

        console.log(`[P2P] Peer ${fromPeerId} requesting ${assetName} from us`);

        // Try to serve via DataChannel first (fastest)
        const channel = this.dataChannels.get(fromPeerId);
        if (channel && channel.readyState === 'open') {
            this._serveAsset(fromPeerId, assetName);
            return;
        }

        // DataChannel not ready — relay via WebSocket (signaling server)
        console.log(`[P2P] No DataChannel to ${fromPeerId}, relaying ${assetName} via WS`);
        await this._serveAssetViaWS(fromPeerId, assetName);
    }

    /**
     * Serve an asset to a peer through the WebSocket signaling server.
     * Used when no DataChannel is available (fallback path).
     * Optimized for large assets using chunked processing.
     */
    async _serveAssetViaWS(toPeerId, assetName) {
        const cached = await this.cache.get(assetName);
        if (!cached) {
            console.warn(`[P2P] Cannot relay ${assetName} — not in cache`);
            return;
        }

        console.log(`[P2P] Encoding ${assetName} for WS relay...`);
        const startTime = Date.now();
        
        // Fast Uint8Array to Base64 using chunked processing
        const CHUNK_SIZE = 0x8000; // 32KB chunks
        let binary = '';
        const bytes = cached.data;
        for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
        }
        const base64 = btoa(binary);
        
        const encodeTime = Date.now() - startTime;
        console.log(`[P2P] Relaying ${assetName} (${(cached.size / 1024).toFixed(1)}KB) to ${toPeerId} via WS (encoded in ${encodeTime}ms)`);

        this._send({
            type: 'ws-relay-asset',
            to: toPeerId,
            assetName,
            data: base64,
            hash: cached.hash,
            size: cached.size
        });
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
        const normalizedName = this._normalize(assetName);
        
        // DEDUP: If this exact asset is already being fetched, wait on the
        // existing promise instead of spawning another origin request.
        if (this._inflight && this._inflight.has(normalizedName)) {
            console.log(`[P2P] Dedup: waiting on in-flight request for ${normalizedName}`);
            return this._inflight.get(normalizedName);
        }

        const promise = this._doFetchAsset(normalizedName);

        // Track in-flight
        if (!this._inflight) this._inflight = new Map();
        this._inflight.set(normalizedName, promise);
        promise.finally(() => this._inflight.delete(normalizedName));

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

        // 2. Find peers who have this asset (only if connected)
        if (this.isConnected()) {
            const peersWithAsset = [];
            for (const [peerId, peer] of this.peers) {
                if (peer.assets.has(assetName)) {
                    peersWithAsset.push(peerId);
                }
            }

            console.log(`[P2P] Asset ${assetName}: ${peersWithAsset.length} peers have it [${peersWithAsset.join(', ')}]`);

            // 3. Try to get from a peer
            if (peersWithAsset.length > 0) {
                try {
                    const result = await this._fetchFromPeer(assetName, peersWithAsset);
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
                    } else {
                        console.log(`[P2P] All ${peersWithAsset.length} peers failed for ${assetName}, falling back to origin.`);
                    }
                } catch (e) {
                    console.warn(`[P2P] Peer fetch failed for ${assetName}:`, e.message);
                }
            } else {
                console.log(`[P2P] No peers found with asset ${assetName}`);
            }
        }

        // 4. Fallback to origin
        console.log(`[P2P] Fetching from origin: ${assetName}`);
        const data = await this._fetchFromOrigin(assetName);

        // _fetchFromOrigin returns null on non-200 (e.g., 404)
        if (!data) {
            console.log(`[P2P] Origin returned no data for ${assetName} (404?)`);
            return null;  // Return null — bootstrap will pass through to original fetch
        }

        // Cache it and announce
        try {
            const cacheEntry = await this.cache.put(assetName, data, 'origin');
            this.localAssets.add(assetName);
            this.assetHashes.set(assetName, cacheEntry.hash);
            this.announceAsset(assetName);
        } catch (e) {
            console.warn(`[P2P] Cache/announce failed for ${assetName}:`, e.message);
        }

        const duration = Date.now() - startTime;
        this._recordTransfer(assetName, 'origin', null, data.length, duration);
        return { data, source: 'origin' };
    }

    /**
     * Try fetching from peers via WebRTC DataChannel
     */
    async _fetchFromPeer(assetName, peerIds) {
        const normalizedName = this._normalize(assetName);
        // Try the first available peer
        for (const peerId of peerIds) {
            try {
                // Check if we already have an open channel
                let channel = this.dataChannels.get(peerId);

                if (channel && channel.readyState === 'open') {
                    // DataChannel is ready — use the fast path
                    console.log(`[P2P] Requesting ${normalizedName} from ${peerId} via DataChannel`);
                    return await this._requestViaDataChannel(channel, peerId, normalizedName);
                }

                // DataChannel not ready — try WebSocket relay as fallback
                console.log(`[P2P] No open DataChannel to ${peerId}, trying WS relay for ${normalizedName}`);
                const relayResult = await this._requestViaWSRelay(peerId, normalizedName);
                if (relayResult) return relayResult;

                // If WS relay also didn't work, try establishing DataChannel
                // (only if supported)
                if (typeof RTCPeerConnection !== 'undefined' && (!channel || channel.readyState !== 'open')) {
                    await this._createOfferTo(peerId, normalizedName);
                    
                    // Wait for channel to open (with timeout)
                    try {
                        channel = await new Promise((resolve, reject) => {
                            const timeout = setTimeout(() => reject(new Error('Channel open timeout')), 4000);
                            const check = setInterval(() => {
                                const ch = this.dataChannels.get(peerId);
                                if (ch && ch.readyState === 'open') {
                                    clearInterval(check);
                                    clearTimeout(timeout);
                                    resolve(ch);
                                }
                            }, 50);
                        });
                        return await this._requestViaDataChannel(channel, peerId, normalizedName);
                    } catch (e) {
                        console.warn(`[P2P] DataChannel to ${peerId} didn't open in time`);
                        continue;
                    }
                }
            } catch (e) {
                console.warn(`[P2P] Failed to fetch ${normalizedName} from ${peerId}:`, e.message);
                continue;
            }
        }
        return null;
    }

    /**
     * Request asset via an open DataChannel
     */
    _requestViaDataChannel(channel, peerId, assetName) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(assetName);
                reject(new Error(`Peer ${peerId} timeout via DataChannel`));
            }, this.peerTimeout);

            this.pendingRequests.set(assetName, { resolve, reject, timeout });
            channel.send(JSON.stringify({ type: 'request', assetName }));
        });
    }

    /**
     * Request asset via WebSocket relay (signaling server proxies the request)
     * This is the fallback when DataChannel isn't established yet.
     */
    _requestViaWSRelay(peerId, assetName) {
        if (!this.isConnected()) return Promise.resolve(null);

        return new Promise((resolve, reject) => {
            // Use longer timeout for WS relay of large assets
            const wsTimeout = Math.max(this.peerTimeout, 10000); 
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(assetName);
                console.warn(`[P2P] WS relay timeout for ${assetName} from ${peerId} (after ${wsTimeout}ms)`);
                resolve(null);  // Resolve null (not reject) to allow fallback to origin
            }, wsTimeout);

            this.pendingRequests.set(assetName, { resolve, reject, timeout });

            // Ask the signaling server to relay our request to the peer
            this._send({
                type: 'asset-request',
                to: peerId,
                assetName
            });
        });
    }

    /**
     * Handle an asset relayed through the WebSocket signaling server
     */
    _handleWSRelayedAsset(fromPeerId, assetName, base64Data, hash) {
        const pending = this.pendingRequests.get(assetName);
        if (!pending) {
            console.warn(`[P2P] Received WS-relayed asset ${assetName} but no pending request`);
            return;
        }

        try {
            // Optimized base64 to Uint8Array
            const binaryString = atob(base64Data);
            const len = binaryString.length;
            const data = new Uint8Array(len);
            for (let i = 0; i < len; i++) {
                data[i] = binaryString.charCodeAt(i);
            }

            clearTimeout(pending.timeout);
            console.log(`[P2P] Received ${assetName} (${(data.length / 1024).toFixed(1)}KB) from ${fromPeerId} via WS relay`);
            pending.resolve({
                data,
                source: 'peer',
                peerId: fromPeerId,
                hash,
                duration: 0
            });
            this.pendingRequests.delete(assetName);
        } catch (e) {
            console.error(`[P2P] Error decoding WS-relayed asset ${assetName}:`, e);
            clearTimeout(pending.timeout);
            pending.resolve(null);
            this.pendingRequests.delete(assetName);
        }
    }

    /**
     * Fetch from origin server (normal HTTP)
     * Uses _originalFetch to bypass the bootstrap's fetch wrapper
     * and avoid infinite recursion.
     */
    async _fetchFromOrigin(assetName) {
        // Register this URL so the bootstrap wrapper lets it pass through
        // even if _originalFetch somehow routes back through window.fetch.
        // We need to register BOTH the normalized path AND the /path version.
        const withSlash = '/' + assetName;
        this._originFetchesInFlight.add(assetName);
        this._originFetchesInFlight.add(withSlash);
        try {
            // Use the version with leading slash for the actual HTTP request
            const response = await this._originalFetch(withSlash, { credentials: 'same-origin' });
            if (!response.ok) {
                // Return null instead of throwing — 404s are normal for some
                // game assets (e.g., AZTECLOA.PNG embedded in .data package)
                console.log(`[P2P] Origin HTTP ${response.status} for ${assetName}`);
                return null;
            }
            const buffer = await response.arrayBuffer();
            return new Uint8Array(buffer);
        } catch (e) {
            console.warn(`[P2P] Origin fetch error for ${assetName}:`, e.message);
            return null;
        } finally {
            this._originFetchesInFlight.delete(assetName);
            this._originFetchesInFlight.delete(withSlash);
        }
    }

    /**
     * Announce that we now have a new asset
     */
    announceAsset(assetName) {
        const normalized = this._normalize(assetName);
        this.localAssets.add(normalized);
        if (this.isConnected()) {
            console.log(`[P2P] Announcing asset: ${normalized} (total: ${this.localAssets.size})`);
            this._send({
                type: 'asset-announce',
                peerId: this.peerId,
                assets: [normalized]
            });
        } else {
            console.log(`[P2P] Queued asset locally (not connected yet): ${normalized}`);
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
            totalTransfers: total,
            recentTransfers: this.metrics.transfers.slice(-10),
            localAssetCount: this.localAssets.size,
            uptime: Date.now() - this.metrics.startTime
        };
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
