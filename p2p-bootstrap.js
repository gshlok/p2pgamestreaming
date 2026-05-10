/**
 * P2P Game Asset Streaming — Unified Bootstrap & Interception Layer
 * 
 * Consolidates AssetCache, P2PManager, and P2POverlay into a single script
 * that intercepts Emscripten's asset loading and routes it through P2P.
 */

(function() {
    'use strict';

    // Save the original fetch immediately
    const _originalFetch = window.fetch.bind(window);

    // =========================================================================
    // 1. AssetCache — IndexedDB Persistence
    // =========================================================================
    class AssetCache {
        constructor(dbName = 'p2p-asset-cache', storeName = 'assets') {
            this.dbName = dbName;
            this.storeName = storeName;
            this.db = null;
            this._ready = this._initDB();
        }

        async _initDB() {
            return new Promise((resolve, reject) => {
                const request = indexedDB.open(this.dbName, 1);
                request.onupgradeneeded = (e) => {
                    const db = e.target.result;
                    if (!db.objectStoreNames.contains(this.storeName)) {
                        db.createObjectStore(this.storeName, { keyPath: 'name' });
                    }
                };
                request.onsuccess = (e) => {
                    this.db = e.target.result;
                    resolve(this.db);
                };
                request.onerror = (e) => reject(e.target.error);
            });
        }

        async ready() { return this._ready; }

        async _computeHash(data) {
            if (typeof crypto !== 'undefined' && crypto.subtle) {
                try {
                    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
                    const hashArray = Array.from(new Uint8Array(hashBuffer));
                    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
                } catch (e) {}
            }
            let hash = 0;
            for (let i = 0; i < data.length; i++) {
                hash = ((hash << 5) - hash) + data[i];
                hash |= 0;
            }
            return 'fallback-' + Math.abs(hash).toString(16) + '-' + data.length;
        }

        async put(name, data, source = 'origin') {
            await this._ready;
            const hash = await this._computeHash(data);
            const entry = {
                name,
                data: data.buffer,
                hash,
                size: data.byteLength || data.length || 0,
                source,
                timestamp: Date.now()
            };
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.put(entry);
                request.onsuccess = () => resolve({ name, hash, size: data.byteLength || data.length || 0, source });
                request.onerror = (e) => reject(e.target.error);
            });
        }

        async get(name) {
            await this._ready;
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.get(name);
                request.onsuccess = (e) => {
                    const entry = e.target.result;
                    if (entry) resolve({ data: new Uint8Array(entry.data), hash: entry.hash, size: entry.size, source: entry.source });
                    else resolve(null);
                };
                request.onerror = (e) => reject(e.target.error);
            });
        }

        async listAssets() {
            await this._ready;
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readonly');
                const store = tx.objectStore(this.storeName);
                const request = store.getAllKeys();
                request.onsuccess = () => resolve(request.result);
                request.onerror = (e) => reject(e.target.error);
            });
        }

        // Remove stale 0-byte entries (from old 204 No Content responses)
        async purgeEmpty() {
            await this._ready;
            return new Promise((resolve) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.openCursor();
                let purged = 0;
                request.onsuccess = (e) => {
                    const cursor = e.target.result;
                    if (cursor) {
                        const entry = cursor.value;
                        if (!entry.size || entry.size === 0) {
                            cursor.delete();
                            purged++;
                        }
                        cursor.continue();
                    } else {
                        if (purged > 0) console.log(`[Cache] Purged ${purged} empty entries`);
                        resolve(purged);
                    }
                };
                request.onerror = () => resolve(0);
            });
        }
    }

    // =========================================================================
    // 2. P2PManager — WebRTC/WebSocket Orchestrator
    // =========================================================================
    class P2PManager {
        constructor(options = {}) {
            this.peerId = options.peerId || 'peer_' + Math.random().toString(36).substr(2, 8);
            this.signalingUrl = options.signalingUrl || this._autoDetectSignalingUrl();
            this.peerTimeout = options.peerTimeout || 10000; // 10 seconds WebRTC default for large .PSX files
            this._originalFetch = options.originalFetch || _originalFetch;
            this._originFetchesInFlight = options.originFetchesInFlight || new Set();

            this.ws = null;
            this.connected = false;
            this.peers = new Map();
            this.localAssets = new Set();
            this.pendingRequests = new Map();
            this.peerConnections = new Map();
            this.dataChannels = new Map();

            this.metrics = {
                fromPeers: 0, fromOrigin: 0, fromCache: 0,
                bytesFromPeers: 0, bytesFromOrigin: 0, bytesSaved: 0,
                bytesFromCache: 0, bytesUploaded: 0,
                transfers: [], startTime: Date.now()
            };

            this.cache = new AssetCache();
            this.onTransfer = null;
            this.onPeerListChanged = null;
            this.onMetricsUpdate = null;
            this.onNetworkTransfer = null;
            this._incomingChunks = new Map();
            this._inflight = new Map();
            this._connectingPeers = new Set();
        }

        isConnected() { return this.connected; }

        _normalize(path) {
            if (!path) return '';

            // Fix any legacy double-prefix corruption
            path = path.replace(/OpenLara\/src\/platform\/web\/OpenLara\/src\/platform\/web\//g,
                                'OpenLara/src/platform/web/');

            // Strip any http(s)://host:port prefix — always work with server-root-relative paths
            try {
                const u = new URL(path);
                // It's an absolute URL — just take the pathname, strip leading slash
                return u.pathname.replace(/^\//, '');
            } catch (e) {
                // Not an absolute URL — it's already relative or root-relative
            }

            // Strip leading slash
            if (path.startsWith('/')) return path.slice(1);

            // If it already looks like a known server-root-relative path, return as-is
            if (/^(OpenLara|levels|doom|audio)/i.test(path)) return path;

            // It's a relative path from inside the iframe (e.g. "level/1/LEVEL1.PSX")
            // Resolve it against the canonical iframe base path
            const iframeBase = 'OpenLara/src/platform/web/';
            return iframeBase + path;
        }

        _autoDetectSignalingUrl() {
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            return `${proto}//${location.host}/ws`;
        }

        async connect() {
            await this.cache.ready();
            await this.cache.purgeEmpty(); // Remove stale 0-byte entries
            const cached = await this.cache.listAssets();
            for (const name of cached) this.localAssets.add(this._normalize(name));

            console.log(`[P2P] Registering with ${this.localAssets.size} cached assets:`);
            for (const a of this.localAssets) console.log(`  → ${a}`);

            return new Promise((resolve, reject) => {
                console.log(`[P2P] Connecting: ${this.signalingUrl}`);
                this.ws = new WebSocket(this.signalingUrl);
                this.ws.onopen = () => {
                    this.connected = true;
                    this._send({ type: 'register', peerId: this.peerId, assets: Array.from(this.localAssets) });
                    this._heartbeatTimer = setInterval(() => this._send({ type: 'heartbeat', peerId: this.peerId }), 4000);
                    resolve();
                };
                this.ws.onmessage = (e) => this._handleSignalingMessage(JSON.parse(e.data));
                this.ws.onclose = () => { this.connected = false; clearInterval(this._heartbeatTimer); };
                this.ws.onerror = (err) => reject(err);
            });
        }

        _send(msg) { if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg)); }

         _handleSignalingMessage(msg) {
            switch (msg.type) {
                case 'peer-list':
                    for (const peer of msg.peers) {
                        this.peers.set(peer.peerId, { assets: new Set((peer.assets || []).map(a => this._normalize(a))) });
                        this._eagerConnect(peer.peerId);
                    }
                    if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
                    break;
                case 'peer-joined':
                    this.peers.set(msg.peer.peerId, { assets: new Set((msg.peer.assets || []).map(a => this._normalize(a))) });
                    this._eagerConnect(msg.peer.peerId);
                    if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
                    break;
                case 'peer-left':
                    this.peers.delete(msg.peerId);
                    this.peerConnections.get(msg.peerId)?.close();
                    this.peerConnections.delete(msg.peerId);
                    this.dataChannels.delete(msg.peerId);
                    if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
                    break;
                case 'asset-update':
                    if (this.peers.has(msg.peerId)) {
                        this.peers.get(msg.peerId).assets = new Set((msg.assets || []).map(a => this._normalize(a)));
                        if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
                    }
                    break;
                case 'rtc-offer': this._handleRTCOffer(msg.from, msg.signal, msg.assetName); break;
                case 'rtc-answer': this._handleRTCAnswer(msg.from, msg.signal); break;
                case 'rtc-ice': this._handleRTCIce(msg.from, msg.signal); break;
                case 'asset-request': this._handleAssetRequest(msg.from, msg.assetName); break;
                case 'ws-relay-asset': this._handleWSRelayedAsset(msg.from, msg.assetName, msg.data, msg.hash); break;
                case 'transfer-event':
                    if (this.onNetworkTransfer) {
                        this.onNetworkTransfer({
                            from: msg.from,
                            to: msg.to,
                            source: msg.source,
                            assetName: msg.assetName
                        });
                    }
                    break;
            }
        }

        async _eagerConnect(peerId) {
            if (this.peerId > peerId) return; // Only alphabetically smaller peer initiates to prevent WebRTC glare
            if (this.dataChannels.has(peerId) || this._connectingPeers.has(peerId)) return;
            this._connectingPeers.add(peerId);
            try {
                if (typeof RTCPeerConnection === 'undefined') return;
                await this._createOfferTo(peerId, '__eager__');
            } catch (e) {} finally { this._connectingPeers.delete(peerId); }
        }

        async _createOfferTo(peerId, assetName) {
            const pc = this._getPC(peerId);
            const channel = pc.createDataChannel('assets', { ordered: true });
            this._setupChannel(peerId, channel);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this._send({ type: 'rtc-offer', to: peerId, signal: offer, assetName });
        }

        _getPC(peerId) {
            let pc = this.peerConnections.get(peerId);
            if (pc && pc.connectionState !== 'closed') return pc;
            pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
            pc.onicecandidate = (e) => e.candidate && this._send({ type: 'rtc-ice', to: peerId, signal: e.candidate });
            pc.ondatachannel = (e) => this._setupChannel(peerId, e.channel);
            this.peerConnections.set(peerId, pc);
            return pc;
        }

        _setupChannel(peerId, channel) {
            channel.binaryType = 'arraybuffer';
            channel.onopen = () => {
                this.dataChannels.set(peerId, channel);
                if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
            };
            channel.onmessage = (e) => {
                if (typeof e.data === 'string') {
                    const msg = JSON.parse(e.data);
                    if (msg.type === 'request') {
                        this._serveAsset(peerId, this._normalize(msg.assetName));
                    } else if (msg.type === 'asset-header') {
                        this._incomingChunks.set(msg.assetName, { 
                            hash: msg.hash, 
                            size: msg.size, 
                            from: peerId, 
                            start: Date.now(),
                            totalChunks: msg.totalChunks,
                            receivedChunks: [],
                            receivedBytes: 0
                        });
                    }
                } else {
                    this._handleBinary(peerId, e.data);
                }
            };
            channel.onclose = () => {
                this.dataChannels.delete(peerId);
                if (this.onPeerListChanged) this.onPeerListChanged(this._getPeerSummary());
            };
        }

        async _serveAsset(peerId, assetName) {
            const key = this._normalize(assetName);
            const cached = await this.cache.get(key);
            const channel = this.dataChannels.get(peerId);
            if (!cached || !channel || channel.readyState !== 'open') {
                console.warn(`[P2P] _serveAsset: cache miss or closed channel for "${key}" (requested "${assetName}")`);
                return;
            }

            try {
                const CHUNK_SIZE = 64 * 1024; // 64KB safe SCTP chunk size
                const totalChunks = Math.ceil(cached.data.length / CHUNK_SIZE);
                
                console.log(`[P2P WebRTC] Sending "${key}" via data channel. Total size: ${cached.size} bytes in ${totalChunks} chunks.`);
                
                // Send the header first
                channel.send(JSON.stringify({ 
                    type: 'asset-header', 
                    assetName: key, 
                    size: cached.size, 
                    hash: cached.hash,
                    totalChunks: totalChunks
                }));

                // Send chunks sequentially
                for (let offset = 0; offset < cached.data.length; offset += CHUNK_SIZE) {
                    const chunk = cached.data.subarray(offset, offset + CHUNK_SIZE);
                    // Avoid WebRTC congestion / buffer bloat
                    while (channel.bufferedAmount > 1024 * 1024) { // 1MB buffer limit
                        await new Promise(r => setTimeout(r, 10));
                    }
                    channel.send(chunk);
                }

                this._record('upload', key, cached.size, 0, peerId);
            } catch (e) {
                console.error('[P2P WebRTC] Failed to send asset via data channel:', e);
            }
        }

        _handleBinary(peerId, buffer) {
            const chunk = new Uint8Array(buffer);
            // Find the active incoming stream for this peer
            for (const [name, info] of this._incomingChunks) {
                if (info.from === peerId) {
                    info.receivedChunks.push(chunk);
                    info.receivedBytes += chunk.byteLength;
                    
                    if (info.receivedChunks.length === info.totalChunks) {
                        const finalData = new Uint8Array(info.size);
                        let pos = 0;
                        for (const c of info.receivedChunks) {
                            finalData.set(c, pos);
                            pos += c.byteLength;
                        }
                        
                        console.log(`[P2P WebRTC] Successfully reassembled "${name}" from ${info.totalChunks} chunks.`);
                        const pending = this.pendingRequests.get(name);
                        if (pending) {
                            clearTimeout(pending.timeout);
                            pending.resolve({ data: finalData, source: 'peer', peerId, hash: info.hash, duration: Date.now() - info.start });
                            this.pendingRequests.delete(name);
                        }
                        this._incomingChunks.delete(name);
                    }
                    return;
                }
            }
        }

        async fetchAsset(assetName) {
            const normalized = this._normalize(assetName);
            if (this._inflight.has(normalized)) return this._inflight.get(normalized);
            const p = this._doFetchAsset(normalized);
            this._inflight.set(normalized, p);
            p.finally(() => this._inflight.delete(normalized));
            return p;
        }

        async _doFetchAsset(assetName) {
            const start = Date.now();
            const cached = await this.cache.get(assetName);
            if (cached) {
                // Skip 0-byte cache entries (from stale 204 No Content responses)
                if (!cached.size || cached.size === 0) {
                    // Don't count empty entries, fall through to real fetch
                } else {
                    this._record('cache', assetName, cached.size, 0);
                    return { data: cached.data, source: 'cache' };
                }
            }

            if (this.isConnected()) {
                const holders = [];
                for (const [id, p] of this.peers) if (p.assets.has(assetName)) holders.push(id);
                console.log(`[P2P] Asset "${assetName}" — ${holders.length} holders found among ${this.peers.size} peers`);
                if (this.peers.size > 0 && holders.length === 0) {
                    // Debug: show what each peer has
                    for (const [id, p] of this.peers) {
                        console.log(`[P2P] Peer ${id} assets (${p.assets.size}):`, [...p.assets].slice(0, 5));
                    }
                }
                if (holders.length > 0) {
                    const res = await this._fetchFromPeer(assetName, holders);
                    if (res && res.data && res.data.byteLength > 0) {
                        await this.cache.put(assetName, res.data, 'peer');
                        this.localAssets.add(assetName);
                        this._send({ type: 'asset-announce', assets: [assetName] });
                        this._record('peer', assetName, res.data.byteLength, Date.now() - start, res.peerId);
                        return res;
                    }
                }
            }

            const originData = await this._fetchFromOrigin(assetName);
            if (!originData || originData.byteLength === 0) return null;
            await this.cache.put(assetName, originData, 'origin');
            this.localAssets.add(assetName);
            this._send({ type: 'asset-announce', assets: [assetName] });
            this._record('origin', assetName, originData.byteLength, Date.now() - start);
            return { data: originData, source: 'origin' };
        }

        async _fetchFromPeer(name, ids) {
            for (const id of ids) {
                let ch = this.dataChannels.get(id);
                if (ch && ch.readyState === 'open') return this._reqChannel(ch, id, name);
                const relay = await this._reqRelay(id, name);
                if (relay) return relay;
            }
            return null;
        }

        _reqChannel(ch, id, name) {
            return new Promise((resolve) => {
                const t = setTimeout(() => { this.pendingRequests.delete(name); resolve(null); }, this.peerTimeout);
                this.pendingRequests.set(name, { resolve, timeout: t });
                ch.send(JSON.stringify({ type: 'request', assetName: name }));
            });
        }

        _reqRelay(id, name) {
            return new Promise((resolve) => {
                const t = setTimeout(() => { this.pendingRequests.delete(name); resolve(null); }, 12000); // 12 seconds for WebSocket relay
                this.pendingRequests.set(name, { resolve, timeout: t });
                this._send({ type: 'asset-request', to: id, assetName: name });
            });
        }

        async _handleAssetRequest(from, name) {
            const key = this._normalize(name);
            const cached = await this.cache.get(key);
            if (!cached) {
                console.warn(`[P2P] _handleAssetRequest: no cache for "${key}"`);
                return;
            }
            const ch = this.dataChannels.get(from);
            if (ch && ch.readyState === 'open') return this._serveAsset(from, key);

            const base64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(new Blob([cached.data]));
            });
            this._send({ type: 'ws-relay-asset', to: from, assetName: key, data: base64, hash: cached.hash, size: cached.size });
            this._record('upload', key, cached.size, 0, from);
        }

        _handleWSRelayedAsset(from, name, base64, hash) {
            const pending = this.pendingRequests.get(name);
            if (!pending) return;
            try {
                const bin = atob(base64);
                const data = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);
                clearTimeout(pending.timeout);
                pending.resolve({ data, source: 'peer', peerId: from, hash, duration: 0 });
                this.pendingRequests.delete(name);
            } catch (e) { pending.resolve(null); }
        }

        async _fetchFromOrigin(name) {
            try {
                console.log('[P2P] fetching from origin:', name);
                const res = await this._originalFetch('/' + name);
                console.log('[P2P] fetch response status:', res.status, 'ok:', res.ok);
                // Skip 204 No Content (missing optional assets like .ogg/.PNG)
                if (!res.ok || res.status === 204) return null;
                const buf = await res.arrayBuffer();
                if (!buf || buf.byteLength === 0) return null;
                return new Uint8Array(buf);
            } catch (e) {
                console.error('[P2P] _fetchFromOrigin failed for:', name, 'Error:', e);
                return null;
            }
        }

         _record(source, name, size, duration, peerId = null) {
            const s = Number(size) || 0;
            if (source === 'peer') { this.metrics.fromPeers++; this.metrics.bytesFromPeers += s; this.metrics.bytesSaved += s; }
            else if (source === 'origin') { this.metrics.fromOrigin++; this.metrics.bytesFromOrigin += s; }
            else if (source === 'cache') { this.metrics.fromCache++; this.metrics.bytesFromCache += s; this.metrics.bytesSaved += s; }
            else if (source === 'upload') { this.metrics.bytesUploaded += s; }
            const transfer = { assetName: name, source, size: s, duration, peerId, timestamp: Date.now() };
            this.metrics.transfers.push(transfer);
            if (this.onTransfer) this.onTransfer(transfer);
            if (this.onMetricsUpdate) this.onMetricsUpdate(this.getMetrics());

            // Broadcast transfer event to all peers for the map visualization
            if (source !== 'upload' && source !== 'cache') {
                this._send({
                    type: 'transfer-event',
                    from: source === 'peer' ? peerId : 'origin',
                    to: this.peerId,
                    source: source,
                    assetName: name
                });
            }
        }

        getMetrics() {
            const totalSourced = this.metrics.bytesFromPeers + this.metrics.bytesFromOrigin + this.metrics.bytesFromCache;
            return {
                ...this.metrics,
                peersConnected: this.peers.size,
                peerPercent: totalSourced ? Math.round(((this.metrics.bytesFromPeers + this.metrics.bytesFromCache) / totalSourced) * 100) : 0,
                originPercent: totalSourced ? Math.round((this.metrics.bytesFromOrigin / totalSourced) * 100) : 0,
                localAssetCount: this.localAssets.size
            };
        }

        _getPeerSummary() {
            return Array.from(this.peers).map(([id, p]) => ({ 
                peerId: id, 
                assetCount: p.assets.size,
                hasChannel: this.dataChannels.has(id)
            }));
        }

        async _handleRTCOffer(from, signal, assetName) {
            const pc = this._getPC(from);
            // Glare handling: if we both send an offer, the peer with the "smaller" ID is the polite one and yields.
            const polite = this.peerId < from;
            const offerCollision = pc.signalingState !== 'stable';
            if (offerCollision && !polite) return; // Ignore incoming offer if we are impolite and have a collision

            try {
                await pc.setRemoteDescription(new RTCSessionDescription(signal));
                const ans = await pc.createAnswer();
                await pc.setLocalDescription(ans);
                this._send({ type: 'rtc-answer', to: from, signal: ans });
            } catch (e) {
                console.warn('[P2P] RTC Offer Error:', e);
            }
        }

        async _handleRTCAnswer(from, signal) { 
            const pc = this.peerConnections.get(from); 
            if (!pc || pc.signalingState === 'stable') return; 
            try {
                await pc.setRemoteDescription(new RTCSessionDescription(signal)); 
            } catch (e) {
                console.warn('[P2P] RTC Answer Error:', e);
            }
        }

        async _handleRTCIce(from, signal) { 
            const pc = this.peerConnections.get(from); 
            if (!pc) return;
            try { 
                await pc.addIceCandidate(new RTCIceCandidate(signal)); 
            } catch (e) {} 
        }
    }

    // =========================================================================
    // 3. P2POverlay — Minimal HUD
    // =========================================================================
    class P2POverlay {
        constructor(manager) {
            this.manager = manager;
            this._visible = true;
            this._createDOM();
            this._hook();
        }
        _createDOM() {
            const style = document.createElement('style');
            style.textContent = `
                #p2p-hud { position: fixed; top: 10px; right: 10px; background: rgba(0,0,0,0.7); color: #00f0ff; padding: 10px; border: 1px solid #00f0ff; font-family: monospace; font-size: 12px; z-index: 10000; pointer-events: none; border-radius: 4px; }
                .p2p-log { margin-top: 5px; color: #fff; font-size: 10px; max-height: 100px; overflow: hidden; }
            `;
            document.head.appendChild(style);
            this.el = document.createElement('div');
            this.el.id = 'p2p-hud';
            const displayId = this.manager.peerId.includes('_') ? this.manager.peerId.split('_')[1] : this.manager.peerId;
            this.el.innerHTML = `<div>P2P STATUS | ID: ${displayId.toUpperCase()}</div><div id="p2p-stats-mini">Peers: 0 | Saved: 0 B</div><div id="p2p-log" class="p2p-log"></div>`;
            document.body.appendChild(this.el);
        }
        _hook() {
            this.manager.onMetricsUpdate = (m) => {
                document.getElementById('p2p-stats-mini').textContent = `Peers: ${m.peersConnected} | Saved: ${this._fmt(m.bytesSaved)}`;
            };
            this.manager.onTransfer = (t) => {
                const log = document.getElementById('p2p-log');
                const line = document.createElement('div');
                line.textContent = `[${t.source.toUpperCase()}] ${t.assetName.split('/').pop()} (${this._fmt(t.size)})`;
                log.insertBefore(line, log.firstChild);
                if (log.childNodes.length > 5) log.removeChild(log.lastChild);
            };
        }
        _fmt(b) {
            if (b < 1024) return b + ' B';
            if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
            return (b/1048576).toFixed(1) + ' MB';
        }
        toggle() { this._visible = !this._visible; this.el.style.display = this._visible ? 'block' : 'none'; }
    }

    // =========================================================================
    // 4. Fetch Wrapper & Initialization
    // =========================================================================
    let p2p = null;
    const _originInFlight = new Set();
    const _interceptInflight = new Map();

    const EXCLUDED = ['OpenLara_wasm.data', 'OpenLara_wasm.wasm', 'OpenLara.wasm', 'OpenLara_wasm.js', 'OpenLara.js', 'doom.wasm', 'doom.js', 'chocolate-doom.js', 'chocolate-doom.wasm'];
    const ASSET_EXT = ['.PSX', '.PHD', '.TR2', '.TR4', '.SFX', '.OGG', '.MP3', '.WAV', '.PNG', '.RAW', '.BMP', '.WAD'];

    function isAsset(url) {
        const u = url.split('?')[0].toUpperCase();
        return ASSET_EXT.some(ext => u.endsWith(ext)) && !EXCLUDED.some(exc => u.includes(exc.toUpperCase()));
    }

    window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : (input instanceof Request ? input.url : String(input));
        
        if (p2p && isAsset(url)) {
            const absoluteUrl = new URL(url, location.href).toString();
            // Dedup concurrent requests for the same asset
            if (_interceptInflight.has(absoluteUrl)) return _interceptInflight.get(absoluteUrl).then(r => r.clone());
            const promise = (async () => {
                try {
                    const res = await p2p.fetchAsset(absoluteUrl);
                    if (res && res.data && res.data.byteLength > 0) {
                        return new Response(res.data, { headers: { 'Content-Type': 'application/octet-stream', 'X-P2P-Source': res.source } });
                    }
                } catch (e) { console.warn('[P2P] fetchAsset error:', e); }
                // Fall through to origin
                return _originalFetch(input, init);
            })();
            _interceptInflight.set(absoluteUrl, promise);
            promise.finally(() => _interceptInflight.delete(absoluteUrl));
            return promise;
        }
        return _originalFetch(input, init);
    };

    // Intercept XMLHttpRequest (widely used by Emscripten to load WebGL assets)
    const _originalXHR = window.XMLHttpRequest;
    window.XMLHttpRequest = function() {
        const xhr = new _originalXHR();
        let isIntercepted = false;
        let interceptedUrl = '';
        let interceptedMethod = 'GET';
        let interceptedAsync = true;
        let interceptedUser = undefined;
        let interceptedPass = undefined;
        
        let responseTypeVal = '';
        let onloadHandler = null;
        let onreadystatechangeHandler = null;
        let onerrorHandler = null;
        let onprogressHandler = null;
        
        let simReadyState = 0;
        let simStatus = 0;
        let simStatusText = '';
        let simResponse = null;
        let simResponseText = '';
        let requestHeaders = [];

        const self = this;

        function setReadyState(state) {
            simReadyState = state;
            if (self.onreadystatechange) self.onreadystatechange();
            self.dispatchEvent(new Event('readystatechange'));
        }

        Object.defineProperties(this, {
            readyState: { get: () => isIntercepted ? simReadyState : xhr.readyState },
            status: { get: () => isIntercepted ? simStatus : xhr.status },
            statusText: { get: () => isIntercepted ? simStatusText : xhr.statusText },
            response: { get: () => isIntercepted ? simResponse : xhr.response },
            responseText: { get: () => isIntercepted ? simResponseText : xhr.responseText },
            responseType: {
                get: () => isIntercepted ? responseTypeVal : xhr.responseType,
                set: (val) => {
                    responseTypeVal = val;
                    if (!isIntercepted) xhr.responseType = val;
                }
            },
            onreadystatechange: {
                get: () => onreadystatechangeHandler,
                set: (val) => {
                    onreadystatechangeHandler = val;
                    if (!isIntercepted) xhr.onreadystatechange = val;
                }
            },
            onload: {
                get: () => onloadHandler,
                set: (val) => {
                    onloadHandler = val;
                    if (!isIntercepted) xhr.onload = val;
                }
            },
            onerror: {
                get: () => onerrorHandler,
                set: (val) => {
                    onerrorHandler = val;
                    if (!isIntercepted) xhr.onerror = val;
                }
            },
            onprogress: {
                get: () => onprogressHandler,
                set: (val) => {
                    onprogressHandler = val;
                    if (!isIntercepted) xhr.onprogress = val;
                }
            }
        });

        this.open = function(method, url, asyncVal = true, user, password) {
            interceptedMethod = method;
            interceptedUrl = url;
            interceptedAsync = asyncVal;
            interceptedUser = user;
            interceptedPass = password;
            
            // Only intercept GET requests for valid assets
            if (p2p && method.toUpperCase() === 'GET' && isAsset(url)) {
                isIntercepted = true;
                simReadyState = 1; // OPENED
                setTimeout(() => {
                    if (self.onreadystatechange) self.onreadystatechange();
                }, 0);
            } else {
                isIntercepted = false;
                xhr.open(method, url, asyncVal, user, password);
            }
        };

        this.setRequestHeader = function(header, value) {
            if (isIntercepted) {
                requestHeaders.push({ header, value });
            } else {
                xhr.setRequestHeader(header, value);
            }
        };

        this.overrideMimeType = function(mime) {
            if (!isIntercepted) xhr.overrideMimeType(mime);
        };

        this.getAllResponseHeaders = function() {
            if (isIntercepted) {
                return 'content-type: application/octet-stream\r\ncache-control: no-store\r\n';
            }
            return xhr.getAllResponseHeaders();
        };

        this.getResponseHeader = function(header) {
            if (isIntercepted) {
                if (header.toLowerCase() === 'content-type') return 'application/octet-stream';
                if (header.toLowerCase() === 'cache-control') return 'no-store';
                return null;
            }
            return xhr.getResponseHeader(header);
        };

        function fallbackToNative(body) {
            console.log('[P2P XHR Interceptor] Falling back to native XHR for:', interceptedUrl);
            isIntercepted = false;
            
            // Prepare native XHR
            xhr.open(interceptedMethod, interceptedUrl, interceptedAsync, interceptedUser, interceptedPass);
            
            // Apply request headers
            for (const { header, value } of requestHeaders) {
                xhr.setRequestHeader(header, value);
            }

            // Copy explicit properties
            if (responseTypeVal) xhr.responseType = responseTypeVal;
            if (onloadHandler) xhr.onload = onloadHandler;
            if (onreadystatechangeHandler) xhr.onreadystatechange = onreadystatechangeHandler;
            if (onerrorHandler) xhr.onerror = onerrorHandler;
            if (onprogressHandler) xhr.onprogress = onprogressHandler;
            
            // Copy custom event listeners added via addEventListener
            if (self._listeners) {
                for (const type in self._listeners) {
                    for (const listener of self._listeners[type]) {
                        xhr.addEventListener(type, listener);
                    }
                }
            }

            xhr.send(body);
        }

        this.send = function(body) {
            if (!isIntercepted) {
                xhr.send(body);
                return;
            }

            const absoluteUrl = new URL(interceptedUrl, location.href).toString();
            console.log('[P2P XHR Interceptor] Intercepted request for:', absoluteUrl);

            p2p.fetchAsset(absoluteUrl).then(res => {
                if (res && res.data && res.data.byteLength > 0) {
                    simStatus = 200;
                    simStatusText = 'OK';
                    
                    const data = res.data;
                    if (responseTypeVal === 'arraybuffer') {
                        simResponse = data.buffer;
                    } else if (responseTypeVal === 'blob') {
                        simResponse = new Blob([data]);
                    } else {
                        const decoder = new TextDecoder('utf-8');
                        simResponseText = decoder.decode(data);
                        simResponse = simResponseText;
                    }

                    setReadyState(2); // HEADERS_RECEIVED
                    setReadyState(3); // LOADING
                    setReadyState(4); // DONE

                    if (self.onload) self.onload();
                    self.dispatchEvent(new Event('load'));
                } else {
                    fallbackToNative(body);
                }
            }).catch(err => {
                console.error('[P2P XHR Interceptor] Fetch promise rejected, falling back:', err);
                fallbackToNative(body);
            });
        };

        this.abort = function() {
            if (!isIntercepted) xhr.abort();
        };

        this.addEventListener = function(type, listener, options) {
            if (isIntercepted) {
                if (!this._listeners) this._listeners = {};
                if (!this._listeners[type]) this._listeners[type] = [];
                this._listeners[type].push(listener);
            } else {
                xhr.addEventListener(type, listener, options);
            }
        };

        this.removeEventListener = function(type, listener, options) {
            if (isIntercepted) {
                if (this._listeners && this._listeners[type]) {
                    this._listeners[type] = this._listeners[type].filter(l => l !== listener);
                }
            } else {
                xhr.removeEventListener(type, listener, options);
            }
        };

        this.dispatchEvent = function(event) {
            if (isIntercepted) {
                if (this._listeners && this._listeners[event.type]) {
                    this._listeners[event.type].forEach(l => l.call(this, event));
                }
                return true;
            }
            return xhr.dispatchEvent(event);
        };
    };
    window.XMLHttpRequest.prototype = _originalXHR.prototype;


    if (window.parent && window.parent.p2pManager && window.parent !== window) {
        p2p = window.parent.p2pManager;
        window.p2pManager = p2p;
        console.log('[P2P] Reusing parent P2PManager instance inside iframe synchronously');
    } else {
        p2p = new P2PManager({ originalFetch: _originalFetch, originFetchesInFlight: _originInFlight });
        window.p2pManager = p2p;
    }

    async function boot() {
        if (window.parent && window.parent.p2pManager && window.parent !== window) {
            return;
        }
        try { await p2p.connect(); } catch (e) { console.warn('[P2P] Offline mode'); }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})();
