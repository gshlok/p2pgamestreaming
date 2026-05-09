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
                size: data.length,
                source,
                timestamp: Date.now()
            };
            return new Promise((resolve, reject) => {
                const tx = this.db.transaction(this.storeName, 'readwrite');
                const store = tx.objectStore(this.storeName);
                const request = store.put(entry);
                request.onsuccess = () => resolve({ name, hash, size: data.length, source });
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
    }

    // =========================================================================
    // 2. P2PManager — WebRTC/WebSocket Orchestrator
    // =========================================================================
    class P2PManager {
        constructor(options = {}) {
            this.peerId = options.peerId || 'peer_' + Math.random().toString(36).substr(2, 8);
            this.signalingUrl = options.signalingUrl || this._autoDetectSignalingUrl();
            this.peerTimeout = options.peerTimeout || 5000;
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
                transfers: [], startTime: Date.now()
            };

            this.cache = new AssetCache();
            this.onTransfer = null;
            this.onPeerListChanged = null;
            this.onMetricsUpdate = null;
            this._incomingChunks = new Map();
            this._inflight = new Map();
            this._connectingPeers = new Set();
        }

        isConnected() { return this.connected; }

        _normalize(path) {
            if (!path) return '';
            try {
                const url = new URL(path, location.href);
                return url.pathname.replace(/^\//, '');
            } catch (e) {
                return path.replace(/^\//, '');
            }
        }

        _autoDetectSignalingUrl() {
            const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
            return `${proto}//${location.host}/ws`;
        }

        async connect() {
            await this.cache.ready();
            const cached = await this.cache.listAssets();
            for (const name of cached) this.localAssets.add(this._normalize(name));

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
                case 'rtc-offer': this._handleRTCOffer(msg.from, msg.signal, msg.assetName); break;
                case 'rtc-answer': this._handleRTCAnswer(msg.from, msg.signal); break;
                case 'rtc-ice': this._handleRTCIce(msg.from, msg.signal); break;
                case 'asset-request': this._handleAssetRequest(msg.from, msg.assetName); break;
                case 'ws-relay-asset': this._handleWSRelayedAsset(msg.from, msg.assetName, msg.data, msg.hash); break;
            }
        }

        async _eagerConnect(peerId) {
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
            channel.onopen = () => this.dataChannels.set(peerId, channel);
            channel.onmessage = (e) => {
                if (typeof e.data === 'string') {
                    const msg = JSON.parse(e.data);
                    if (msg.type === 'request') this._serveAsset(peerId, msg.assetName);
                    else if (msg.type === 'asset-header') this._incomingChunks.set(msg.assetName, { hash: msg.hash, size: msg.size, from: peerId, start: Date.now() });
                } else this._handleBinary(peerId, e.data);
            };
            channel.onclose = () => this.dataChannels.delete(peerId);
        }

        async _serveAsset(peerId, assetName) {
            const cached = await this.cache.get(assetName);
            const channel = this.dataChannels.get(peerId);
            if (!cached || !channel || channel.readyState !== 'open') return;
            channel.send(JSON.stringify({ type: 'asset-header', assetName, size: cached.size, hash: cached.hash }));
            channel.send(cached.data);
        }

        _handleBinary(peerId, buffer) {
            for (const [name, info] of this._incomingChunks) {
                if (info.from === peerId) {
                    const data = new Uint8Array(buffer);
                    const pending = this.pendingRequests.get(name);
                    if (pending) {
                        clearTimeout(pending.timeout);
                        pending.resolve({ data, source: 'peer', peerId, hash: info.hash, duration: Date.now() - info.start });
                        this.pendingRequests.delete(name);
                    }
                    this._incomingChunks.delete(name);
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
                this._record('cache', assetName, cached.size, 0);
                return { data: cached.data, source: 'cache' };
            }

            if (this.isConnected()) {
                const holders = [];
                for (const [id, p] of this.peers) if (p.assets.has(assetName)) holders.push(id);
                if (holders.length > 0) {
                    const res = await this._fetchFromPeer(assetName, holders);
                    if (res) {
                        await this.cache.put(assetName, res.data, 'peer');
                        this.localAssets.add(assetName);
                        this._send({ type: 'asset-announce', assets: [assetName] });
                        this._record('peer', assetName, res.data.length, Date.now() - start, res.peerId);
                        return res;
                    }
                }
            }

            const originData = await this._fetchFromOrigin(assetName);
            if (!originData) return null;
            await this.cache.put(assetName, originData, 'origin');
            this.localAssets.add(assetName);
            this._send({ type: 'asset-announce', assets: [assetName] });
            this._record('origin', assetName, originData.length, Date.now() - start);
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
                const t = setTimeout(() => { this.pendingRequests.delete(name); resolve(null); }, 8000);
                this.pendingRequests.set(name, { resolve, timeout: t });
                this._send({ type: 'asset-request', to: id, assetName: name });
            });
        }

        async _handleAssetRequest(from, name) {
            const cached = await this.cache.get(name);
            if (!cached) return;
            const ch = this.dataChannels.get(from);
            if (ch && ch.readyState === 'open') return this._serveAsset(from, name);

            const base64 = await new Promise((resolve) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result.split(',')[1]);
                reader.readAsDataURL(new Blob([cached.data]));
            });
            this._send({ type: 'ws-relay-asset', to: from, assetName: name, data: base64, hash: cached.hash, size: cached.size });
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
            this._originFetchesInFlight.add(name);
            try {
                const res = await this._originalFetch('/' + name);
                if (!res.ok) return null;
                return new Uint8Array(await res.arrayBuffer());
            } finally { this._originFetchesInFlight.delete(name); }
        }

        _record(source, name, size, duration, peerId = null) {
            if (source === 'peer') { this.metrics.fromPeers++; this.metrics.bytesFromPeers += size; this.metrics.bytesSaved += size; }
            else if (source === 'origin') { this.metrics.fromOrigin++; this.metrics.bytesFromOrigin += size; }
            else if (source === 'cache') { this.metrics.fromCache++; }
            const transfer = { assetName: name, source, size, duration, peerId, timestamp: Date.now() };
            this.metrics.transfers.push(transfer);
            if (this.onTransfer) this.onTransfer(transfer);
            if (this.onMetricsUpdate) this.onMetricsUpdate(this.getMetrics());
        }

        getMetrics() {
            const total = this.metrics.fromPeers + this.metrics.fromOrigin;
            return {
                ...this.metrics,
                peersConnected: this.peers.size,
                peerPercent: total ? Math.round((this.metrics.fromPeers / total) * 100) : 0,
                originPercent: total ? Math.round((this.metrics.fromOrigin / total) * 100) : 0,
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
            this.el.innerHTML = `<div>P2P STATUS</div><div id="p2p-stats-mini">Peers: 0 | Saved: 0 B</div><div id="p2p-log" class="p2p-log"></div>`;
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
        if (_originInFlight.has(url)) return _originalFetch(input, init);
        
        if (p2p && isAsset(url)) {
            if (_interceptInflight.has(url)) return _interceptInflight.get(url).then(r => r.clone());
            const promise = (async () => {
                try {
                    const res = await p2p.fetchAsset(url);
                    if (res && res.data) return new Response(res.data, { headers: { 'Content-Type': 'application/octet-stream', 'X-P2P-Source': res.source } });
                } catch (e) {}
                return _originalFetch(input, init);
            })();
            _interceptInflight.set(url, promise);
            promise.finally(() => _interceptInflight.delete(url));
            return promise;
        }
        return _originalFetch(input, init);
    };

    async function boot() {
        p2p = new P2PManager({ originalFetch: _originalFetch, originFetchesInFlight: _originInFlight });
        window.p2pManager = p2p;
        const overlay = new P2POverlay(p2p);
        window.p2pOverlay = overlay;
        document.addEventListener('keydown', (e) => { if (e.key === 'F2') overlay.toggle(); });
        try { await p2p.connect(); } catch (e) { console.warn('[P2P] Offline mode'); }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();

})();
