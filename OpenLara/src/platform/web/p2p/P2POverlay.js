/**
 * P2POverlay — Real-time visualization HUD for peer-assisted asset streaming
 * 
 * Renders a glassmorphic overlay on top of the game canvas showing:
 *   - Connected peers count
 *   - Asset source breakdown (peer vs origin %)
 *   - Bandwidth saved
 *   - Live transfer feed with animations
 *   - Network topology mini-map
 */
class P2POverlay {
    constructor(p2pManager) {
        this.manager = p2pManager;
        this.container = null;
        this.elements = {};
        this.transferLog = [];
        this.maxLogEntries = 8;
        this._visible = true;
        this._minimized = false;

        this._createStyles();
        this._createDOM();
        this._hookManager();
        this._startUpdateLoop();
    }

    // -----------------------------------------------------------------------
    // CSS
    // -----------------------------------------------------------------------

    _createStyles() {
        const style = document.createElement('style');
        style.textContent = `
            @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');

            #p2p-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                pointer-events: none;
                z-index: 10000;
                font-family: 'Inter', system-ui, sans-serif;
                color: #e0e0e0;
            }

            #p2p-overlay * {
                box-sizing: border-box;
            }

            .p2p-panel {
                pointer-events: auto;
                background: rgba(10, 10, 20, 0.75);
                backdrop-filter: blur(16px);
                -webkit-backdrop-filter: blur(16px);
                border: 1px solid rgba(255, 255, 255, 0.08);
                border-radius: 12px;
                padding: 16px;
                box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4),
                            inset 0 1px 0 rgba(255, 255, 255, 0.05);
            }

            /* ---- Stats Panel (top-right) ---- */
            .p2p-stats {
                position: fixed;
                top: 16px;
                right: 16px;
                min-width: 260px;
                transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
            }

            .p2p-stats-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
                cursor: pointer;
            }

            .p2p-stats-title {
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                color: #00e5ff;
                display: flex;
                align-items: center;
                gap: 8px;
            }

            .p2p-stats-title::before {
                content: '';
                display: inline-block;
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #00e5ff;
                box-shadow: 0 0 8px #00e5ff, 0 0 16px rgba(0, 229, 255, 0.3);
                animation: p2p-pulse 2s ease-in-out infinite;
            }

            @keyframes p2p-pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.6; transform: scale(0.85); }
            }

            .p2p-toggle-btn {
                background: none;
                border: 1px solid rgba(255,255,255,0.1);
                color: #888;
                font-size: 10px;
                padding: 2px 8px;
                border-radius: 4px;
                cursor: pointer;
                transition: all 0.2s;
            }
            .p2p-toggle-btn:hover {
                border-color: #00e5ff;
                color: #00e5ff;
            }

            .p2p-stats-body {
                overflow: hidden;
                transition: max-height 0.3s ease, opacity 0.3s ease;
            }

            .p2p-stat-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 6px 0;
                border-bottom: 1px solid rgba(255, 255, 255, 0.04);
                font-size: 12px;
            }

            .p2p-stat-row:last-child {
                border-bottom: none;
            }

            .p2p-stat-label {
                color: #888;
                font-weight: 500;
            }

            .p2p-stat-value {
                font-family: 'JetBrains Mono', monospace;
                font-weight: 600;
                font-size: 13px;
            }

            .p2p-val-peer { color: #00e5ff; }
            .p2p-val-origin { color: #ff9100; }
            .p2p-val-neutral { color: #e0e0e0; }
            .p2p-val-saved { color: #69f0ae; }

            /* ---- Progress Bar ---- */
            .p2p-bar-container {
                margin: 10px 0 4px;
                height: 6px;
                background: rgba(255, 255, 255, 0.06);
                border-radius: 3px;
                overflow: hidden;
                display: flex;
            }

            .p2p-bar-peer {
                height: 100%;
                background: linear-gradient(90deg, #00b8d4, #00e5ff);
                transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
                border-radius: 3px 0 0 3px;
                box-shadow: 0 0 8px rgba(0, 229, 255, 0.3);
            }

            .p2p-bar-origin {
                height: 100%;
                background: linear-gradient(90deg, #e65100, #ff9100);
                transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
                border-radius: 0 3px 3px 0;
            }

            .p2p-bar-labels {
                display: flex;
                justify-content: space-between;
                font-size: 10px;
                color: #666;
                margin-bottom: 8px;
            }

            /* ---- Transfer Feed (bottom-right) ---- */
            .p2p-feed {
                position: fixed;
                bottom: 16px;
                right: 16px;
                min-width: 340px;
                max-width: 420px;
                max-height: 300px;
            }

            .p2p-feed-title {
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 1.2px;
                color: #888;
                margin-bottom: 10px;
            }

            .p2p-feed-list {
                display: flex;
                flex-direction: column;
                gap: 4px;
                max-height: 230px;
                overflow-y: auto;
            }

            .p2p-feed-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 6px 10px;
                background: rgba(255, 255, 255, 0.03);
                border-radius: 6px;
                font-size: 11px;
                font-family: 'JetBrains Mono', monospace;
                animation: p2p-slide-in 0.4s cubic-bezier(0.4, 0, 0.2, 1);
                border-left: 3px solid;
            }

            .p2p-feed-item.source-peer {
                border-left-color: #00e5ff;
            }

            .p2p-feed-item.source-origin {
                border-left-color: #ff9100;
            }

            .p2p-feed-item.source-cache {
                border-left-color: #69f0ae;
            }

            @keyframes p2p-slide-in {
                from {
                    opacity: 0;
                    transform: translateX(20px);
                }
                to {
                    opacity: 1;
                    transform: translateX(0);
                }
            }

            .p2p-feed-icon {
                font-size: 14px;
                flex-shrink: 0;
            }

            .p2p-feed-name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #ccc;
            }

            .p2p-feed-source {
                font-size: 10px;
                font-weight: 600;
                padding: 2px 6px;
                border-radius: 3px;
                flex-shrink: 0;
            }

            .p2p-feed-source.peer {
                background: rgba(0, 229, 255, 0.15);
                color: #00e5ff;
            }

            .p2p-feed-source.origin {
                background: rgba(255, 145, 0, 0.15);
                color: #ff9100;
            }

            .p2p-feed-source.cache {
                background: rgba(105, 240, 174, 0.15);
                color: #69f0ae;
            }

            .p2p-feed-size {
                color: #666;
                font-size: 10px;
                flex-shrink: 0;
            }

            .p2p-feed-time {
                color: #555;
                font-size: 10px;
                flex-shrink: 0;
            }

            /* ---- Peer Badges (top-left) ---- */
            .p2p-peers {
                position: fixed;
                top: 16px;
                left: 16px;
                min-width: 200px;
            }

            .p2p-peers-title {
                font-size: 10px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 1.2px;
                color: #888;
                margin-bottom: 10px;
            }

            .p2p-peer-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 5px 0;
                font-size: 12px;
            }

            .p2p-peer-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #00e5ff;
                box-shadow: 0 0 6px rgba(0, 229, 255, 0.4);
                flex-shrink: 0;
            }

            .p2p-peer-dot.self {
                background: #69f0ae;
                box-shadow: 0 0 6px rgba(105, 240, 174, 0.4);
            }

            .p2p-peer-name {
                font-family: 'JetBrains Mono', monospace;
                font-size: 11px;
                color: #bbb;
            }

            .p2p-peer-assets {
                font-size: 10px;
                color: #666;
                margin-left: auto;
            }

            /* ---- Transfer Animation Burst ---- */
            .p2p-transfer-burst {
                position: fixed;
                pointer-events: none;
                font-size: 12px;
                font-weight: 700;
                font-family: 'JetBrains Mono', monospace;
                z-index: 10001;
                animation: p2p-burst 1.5s ease-out forwards;
            }

            @keyframes p2p-burst {
                0% { opacity: 1; transform: translateY(0) scale(1); }
                100% { opacity: 0; transform: translateY(-40px) scale(0.8); }
            }

            /* ---- Hidden state ---- */
            .p2p-hidden {
                opacity: 0;
                pointer-events: none;
                transform: translateY(-10px);
            }
        `;
        document.head.appendChild(style);
    }

    // -----------------------------------------------------------------------
    // DOM Construction
    // -----------------------------------------------------------------------

    _createDOM() {
        this.container = document.createElement('div');
        this.container.id = 'p2p-overlay';

        // Stats Panel
        const stats = document.createElement('div');
        stats.className = 'p2p-panel p2p-stats';
        stats.innerHTML = `
            <div class="p2p-stats-header" id="p2p-stats-toggle">
                <div class="p2p-stats-title">P2P Asset Streaming</div>
                <button class="p2p-toggle-btn" id="p2p-minimize-btn">−</button>
            </div>
            <div class="p2p-stats-body" id="p2p-stats-body">
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Peers Connected</span>
                    <span class="p2p-stat-value p2p-val-neutral" id="p2p-peers-count">0</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Assets From Peers</span>
                    <span class="p2p-stat-value p2p-val-peer" id="p2p-from-peers">0 (0%)</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Assets From Origin</span>
                    <span class="p2p-stat-value p2p-val-origin" id="p2p-from-origin">0 (0%)</span>
                </div>
                <div class="p2p-bar-container">
                    <div class="p2p-bar-peer" id="p2p-bar-peer" style="width: 0%"></div>
                    <div class="p2p-bar-origin" id="p2p-bar-origin" style="width: 0%"></div>
                </div>
                <div class="p2p-bar-labels">
                    <span style="color: #00e5ff;">● P2P</span>
                    <span style="color: #ff9100;">● Origin</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Bandwidth Saved</span>
                    <span class="p2p-stat-value p2p-val-saved" id="p2p-bandwidth-saved">0 B</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Total Transferred</span>
                    <span class="p2p-stat-value p2p-val-neutral" id="p2p-total-bytes">0 B</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Local Assets</span>
                    <span class="p2p-stat-value p2p-val-neutral" id="p2p-local-assets">0</span>
                </div>
            </div>
        `;
        this.container.appendChild(stats);

        // Peer List Panel
        const peers = document.createElement('div');
        peers.className = 'p2p-panel p2p-peers';
        peers.innerHTML = `
            <div class="p2p-peers-title">Network Peers</div>
            <div id="p2p-peer-list">
                <div class="p2p-peer-item">
                    <div class="p2p-peer-dot self"></div>
                    <span class="p2p-peer-name" id="p2p-self-name">You</span>
                    <span class="p2p-peer-assets" id="p2p-self-assets">0 assets</span>
                </div>
            </div>
        `;
        this.container.appendChild(peers);

        // Transfer Feed Panel
        const feed = document.createElement('div');
        feed.className = 'p2p-panel p2p-feed';
        feed.innerHTML = `
            <div class="p2p-feed-title">Live Transfers</div>
            <div class="p2p-feed-list" id="p2p-feed-list">
                <div style="color: #555; font-size: 11px; text-align: center; padding: 12px;">
                    Waiting for asset requests...
                </div>
            </div>
        `;
        this.container.appendChild(feed);

        document.body.appendChild(this.container);

        // Cache references
        this.elements = {
            peersCount: document.getElementById('p2p-peers-count'),
            fromPeers: document.getElementById('p2p-from-peers'),
            fromOrigin: document.getElementById('p2p-from-origin'),
            barPeer: document.getElementById('p2p-bar-peer'),
            barOrigin: document.getElementById('p2p-bar-origin'),
            bandwidthSaved: document.getElementById('p2p-bandwidth-saved'),
            totalBytes: document.getElementById('p2p-total-bytes'),
            localAssets: document.getElementById('p2p-local-assets'),
            feedList: document.getElementById('p2p-feed-list'),
            peerList: document.getElementById('p2p-peer-list'),
            selfName: document.getElementById('p2p-self-name'),
            selfAssets: document.getElementById('p2p-self-assets'),
            statsBody: document.getElementById('p2p-stats-body'),
            minimizeBtn: document.getElementById('p2p-minimize-btn')
        };

        // Minimize toggle
        this.elements.minimizeBtn.addEventListener('click', () => {
            this._minimized = !this._minimized;
            this.elements.statsBody.style.maxHeight = this._minimized ? '0' : '500px';
            this.elements.statsBody.style.opacity = this._minimized ? '0' : '1';
            this.elements.minimizeBtn.textContent = this._minimized ? '+' : '−';
        });

        // Set self name
        if (this.manager) {
            this.elements.selfName.textContent = this.manager.peerId;
        }
    }

    // -----------------------------------------------------------------------
    // Manager hooks
    // -----------------------------------------------------------------------

    _hookManager() {
        if (!this.manager) return;

        this.manager.onPeerListChanged = (peers) => {
            this._updatePeerList(peers);
        };

        this.manager.onTransfer = (transfer) => {
            this._addTransferEntry(transfer);
            this._showTransferBurst(transfer);
        };

        this.manager.onMetricsUpdate = (metrics) => {
            this._updateStats(metrics);
        };
    }

    // -----------------------------------------------------------------------
    // UI Updates
    // -----------------------------------------------------------------------

    _updateStats(metrics) {
        this.elements.peersCount.textContent = metrics.peersConnected;
        this.elements.fromPeers.textContent = `${metrics.fromPeers} (${metrics.peerPercent}%)`;
        this.elements.fromOrigin.textContent = `${metrics.fromOrigin} (${metrics.originPercent}%)`;
        this.elements.barPeer.style.width = `${metrics.peerPercent}%`;
        this.elements.barOrigin.style.width = `${metrics.originPercent}%`;
        this.elements.bandwidthSaved.textContent = this._formatBytes(metrics.bytesSaved);
        this.elements.totalBytes.textContent = this._formatBytes(metrics.bytesFromPeers + metrics.bytesFromOrigin);
        this.elements.localAssets.textContent = metrics.localAssetCount;
        this.elements.selfAssets.textContent = `${metrics.localAssetCount} assets`;
    }

    _updatePeerList(peers) {
        // Keep self entry, rebuild others
        const selfEntry = this.elements.peerList.firstElementChild;
        this.elements.peerList.innerHTML = '';
        this.elements.peerList.appendChild(selfEntry);

        for (const peer of peers) {
            const item = document.createElement('div');
            item.className = 'p2p-peer-item';
            item.innerHTML = `
                <div class="p2p-peer-dot"></div>
                <span class="p2p-peer-name">${this._escapeHtml(peer.peerId)}</span>
                <span class="p2p-peer-assets">${peer.assetCount} assets</span>
            `;
            this.elements.peerList.appendChild(item);
        }

        // Update stats panel peer count too
        this.elements.peersCount.textContent = peers.length;
    }

    _addTransferEntry(transfer) {
        // Remove placeholder text
        if (this.transferLog.length === 0) {
            this.elements.feedList.innerHTML = '';
        }

        this.transferLog.push(transfer);

        // Keep only recent entries
        while (this.transferLog.length > this.maxLogEntries) {
            this.transferLog.shift();
            if (this.elements.feedList.firstChild) {
                this.elements.feedList.removeChild(this.elements.feedList.firstChild);
            }
        }

        const item = document.createElement('div');
        item.className = `p2p-feed-item source-${transfer.source}`;

        const icon = transfer.source === 'peer' ? '⚡' : transfer.source === 'cache' ? '💾' : '🌐';
        const sourceLabel = transfer.source === 'peer'
            ? transfer.peerId || 'Peer'
            : transfer.source === 'cache' ? 'Cache' : 'Origin';

        const shortName = transfer.assetName.split('/').pop();

        item.innerHTML = `
            <span class="p2p-feed-icon">${icon}</span>
            <span class="p2p-feed-name" title="${this._escapeHtml(transfer.assetName)}">${this._escapeHtml(shortName)}</span>
            <span class="p2p-feed-source ${transfer.source}">${sourceLabel}</span>
            <span class="p2p-feed-size">${this._formatBytes(transfer.size)}</span>
            <span class="p2p-feed-time">${transfer.duration}ms</span>
        `;

        this.elements.feedList.appendChild(item);

        // Auto-scroll to bottom
        this.elements.feedList.scrollTop = this.elements.feedList.scrollHeight;
    }

    _showTransferBurst(transfer) {
        if (transfer.source === 'cache') return; // Don't burst for cache hits

        const burst = document.createElement('div');
        burst.className = 'p2p-transfer-burst';
        burst.style.right = '280px';
        burst.style.bottom = `${60 + Math.random() * 100}px`;

        const color = transfer.source === 'peer' ? '#00e5ff' : '#ff9100';
        const label = transfer.source === 'peer' ? '⚡ P2P' : '🌐 CDN';
        burst.style.color = color;
        burst.textContent = `${label} ${this._formatBytes(transfer.size)}`;

        document.body.appendChild(burst);

        setTimeout(() => burst.remove(), 1500);
    }

    // -----------------------------------------------------------------------
    // Update loop (for uptime-based stats)
    // -----------------------------------------------------------------------

    _startUpdateLoop() {
        setInterval(() => {
            if (this.manager) {
                const metrics = this.manager.getMetrics();
                this._updateStats(metrics);
            }
        }, 1000);
    }

    // -----------------------------------------------------------------------
    // Public API for external recording
    // -----------------------------------------------------------------------

    /**
     * Called from the intercept layer to record a transfer
     * (in case the manager's own callback is insufficient)
     */
    recordTransfer(assetName, source, size) {
        // This is handled via manager callbacks now, but kept as a backup API
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    _formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
    }

    _escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    toggle() {
        this._visible = !this._visible;
        this.container.style.display = this._visible ? 'block' : 'none';
    }

    destroy() {
        this.container?.remove();
    }
}

// Export
if (typeof window !== 'undefined') {
    window.P2POverlay = P2POverlay;
}
