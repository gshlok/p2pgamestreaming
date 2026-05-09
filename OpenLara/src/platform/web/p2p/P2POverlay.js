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
            @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Space+Grotesk:wght@400;500;600;700&family=Inter:wght@400;500;600;700&display=swap');

            #p2p-overlay {
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                pointer-events: none;
                z-index: 10000;
                font-family: 'Inter', system-ui, sans-serif;
                color: #f3f4f6;
            }

            #p2p-overlay * {
                box-sizing: border-box;
            }

            .p2p-panel {
                pointer-events: auto;
                background: rgba(10, 11, 24, 0.45);
                backdrop-filter: blur(24px);
                -webkit-backdrop-filter: blur(24px);
                border: 1px solid rgba(255, 255, 255, 0.05);
                border-radius: 16px;
                padding: 18px;
                box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5),
                            inset 0 1px 1px rgba(255, 255, 255, 0.03);
                transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1), box-shadow 0.3s ease, border-color 0.3s ease;
            }

            .p2p-panel:hover {
                transform: translateY(-2px);
                box-shadow: 0 16px 48px rgba(0, 0, 0, 0.65),
                            inset 0 1px 1px rgba(255, 255, 255, 0.05);
                border-color: rgba(0, 229, 255, 0.15);
            }

            /* ---- Stats Panel (top-right) ---- */
            .p2p-stats {
                position: fixed;
                top: 20px;
                right: 20px;
                width: 280px;
                animation: p2p-fade-in-up 0.5s cubic-bezier(0.16, 1, 0.3, 1);
            }

            .p2p-stats-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 14px;
                cursor: pointer;
            }

            .p2p-stats-title {
                font-family: 'Space Grotesk', sans-serif;
                font-size: 12px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                color: #00f0ff;
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
                background: #00f0ff;
                box-shadow: 0 0 10px #00f0ff, 0 0 20px rgba(0, 240, 255, 0.4);
                animation: p2p-pulse 2s ease-in-out infinite;
            }

            @keyframes p2p-pulse {
                0%, 100% { opacity: 1; transform: scale(1); }
                50% { opacity: 0.5; transform: scale(0.8); }
            }

            .p2p-toggle-btn {
                background: rgba(255,255,255,0.03);
                border: 1px solid rgba(255,255,255,0.08);
                color: #9ca3af;
                font-size: 11px;
                width: 22px;
                height: 22px;
                display: flex;
                align-items: center;
                justify-content: center;
                border-radius: 6px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .p2p-toggle-btn:hover {
                background: rgba(0, 240, 255, 0.1);
                border-color: #00f0ff;
                color: #00f0ff;
                transform: scale(1.05);
            }

            .p2p-stats-body {
                overflow: hidden;
                transition: max-height 0.4s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.3s ease;
            }

            .p2p-stat-row {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 8px 0;
                border-bottom: 1px solid rgba(255, 255, 255, 0.03);
                font-size: 12px;
            }

            .p2p-stat-row:last-child {
                border-bottom: none;
            }

            .p2p-stat-label {
                color: #9ca3af;
                font-weight: 500;
                font-family: 'Space Grotesk', sans-serif;
                letter-spacing: 0.5px;
            }

            .p2p-stat-value {
                font-family: 'JetBrains Mono', monospace;
                font-weight: 600;
                font-size: 13px;
                letter-spacing: -0.2px;
            }

            .p2p-val-peer { color: #00f0ff; text-shadow: 0 0 10px rgba(0, 240, 255, 0.25); }
            .p2p-val-origin { color: #ff8800; text-shadow: 0 0 10px rgba(255, 136, 0, 0.25); }
            .p2p-val-neutral { color: #f3f4f6; }
            .p2p-val-saved { color: #00ffaa; text-shadow: 0 0 10px rgba(0, 255, 170, 0.25); }

            /* ---- Progress Bar ---- */
            .p2p-bar-container {
                margin: 12px 0 6px;
                height: 8px;
                background: rgba(255, 255, 255, 0.04);
                border-radius: 4px;
                overflow: hidden;
                display: flex;
                position: relative;
                box-shadow: inset 0 1px 2px rgba(0,0,0,0.3);
            }

            .p2p-bar-peer {
                height: 100%;
                background: linear-gradient(90deg, #0097a7, #00f0ff);
                transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1);
                border-radius: 4px 0 0 4px;
                box-shadow: 0 0 8px rgba(0, 240, 255, 0.4);
            }

            .p2p-bar-origin {
                height: 100%;
                background: linear-gradient(90deg, #d84315, #ff8800);
                transition: width 0.8s cubic-bezier(0.16, 1, 0.3, 1);
                border-radius: 0 4px 4px 0;
            }

            .p2p-bar-labels {
                display: flex;
                justify-content: space-between;
                font-size: 10px;
                font-weight: 600;
                font-family: 'Space Grotesk', sans-serif;
                color: #6b7280;
                margin-bottom: 8px;
            }

            /* ---- Transfer Feed (bottom-right) ---- */
            .p2p-feed {
                position: fixed;
                bottom: 20px;
                right: 20px;
                width: 380px;
                max-height: 280px;
                animation: p2p-fade-in-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.1s both;
            }

            .p2p-feed-title {
                font-family: 'Space Grotesk', sans-serif;
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                color: #9ca3af;
                margin-bottom: 12px;
                border-bottom: 1px solid rgba(255,255,255,0.05);
                padding-bottom: 6px;
            }

            .p2p-feed-list {
                display: flex;
                flex-direction: column;
                gap: 6px;
                max-height: 200px;
                overflow-y: auto;
                padding-right: 4px;
            }

            /* Scrollbar styling */
            .p2p-feed-list::-webkit-scrollbar {
                width: 4px;
            }
            .p2p-feed-list::-webkit-scrollbar-track {
                background: rgba(255,255,255,0.01);
            }
            .p2p-feed-list::-webkit-scrollbar-thumb {
                background: rgba(255,255,255,0.1);
                border-radius: 2px;
            }

            .p2p-feed-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px 12px;
                background: rgba(255, 255, 255, 0.02);
                border: 1px solid rgba(255, 255, 255, 0.02);
                border-radius: 8px;
                font-size: 11px;
                font-family: 'JetBrains Mono', monospace;
                animation: p2p-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
                border-left: 3px solid;
                transition: background 0.2s ease, border-color 0.2s ease;
            }

            .p2p-feed-item:hover {
                background: rgba(255, 255, 255, 0.04);
                border-color: rgba(255, 255, 255, 0.06);
            }

            .p2p-feed-item.source-peer {
                border-left-color: #00f0ff;
            }

            .p2p-feed-item.source-origin {
                border-left-color: #ff8800;
            }

            .p2p-feed-item.source-cache {
                border-left-color: #00ffaa;
            }

            .p2p-feed-item.source-upload {
                border-left-color: #d500f9;
            }

            @keyframes p2p-slide-in {
                from { opacity: 0; transform: translateX(20px); }
                to { opacity: 1; transform: translateX(0); }
            }

            @keyframes p2p-fade-in-up {
                from { opacity: 0; transform: translateY(15px); }
                to { opacity: 1; transform: translateY(0); }
            }

            .p2p-feed-icon {
                font-size: 13px;
                flex-shrink: 0;
            }

            .p2p-feed-name {
                flex: 1;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #e5e7eb;
                font-weight: 500;
            }

            .p2p-feed-source {
                font-family: 'Space Grotesk', sans-serif;
                font-size: 9px;
                font-weight: 700;
                letter-spacing: 0.5px;
                text-transform: uppercase;
                padding: 2px 6px;
                border-radius: 4px;
                flex-shrink: 0;
            }

            .p2p-feed-source.peer {
                background: rgba(0, 240, 255, 0.1);
                color: #00f0ff;
                border: 1px solid rgba(0, 240, 255, 0.15);
            }

            .p2p-feed-source.origin {
                background: rgba(255, 136, 0, 0.1);
                color: #ff8800;
                border: 1px solid rgba(255, 136, 0, 0.15);
            }

            .p2p-feed-source.cache {
                background: rgba(0, 255, 170, 0.1);
                color: #00ffaa;
                border: 1px solid rgba(0, 255, 170, 0.15);
            }

            .p2p-feed-source.upload {
                background: rgba(213, 0, 249, 0.1);
                color: #d500f9;
                border: 1px solid rgba(213, 0, 249, 0.15);
            }

            .p2p-feed-size {
                color: #9ca3af;
                font-size: 10px;
                flex-shrink: 0;
            }

            .p2p-feed-time {
                color: #6b7280;
                font-size: 10px;
                flex-shrink: 0;
            }

            /* ---- Peer Badges (top-left) ---- */
            .p2p-peers {
                position: fixed;
                top: 20px;
                left: 20px;
                width: 260px;
                animation: p2p-fade-in-up 0.5s cubic-bezier(0.16, 1, 0.3, 1) 0.05s both;
            }

            .p2p-peers-title {
                font-family: 'Space Grotesk', sans-serif;
                font-size: 11px;
                font-weight: 700;
                text-transform: uppercase;
                letter-spacing: 1.5px;
                color: #9ca3af;
                margin-bottom: 12px;
                border-bottom: 1px solid rgba(255,255,255,0.05);
                padding-bottom: 6px;
            }

            .p2p-peer-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 6px 0;
                font-size: 12px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.02);
            }

            .p2p-peer-item:last-child {
                border-bottom: none;
            }

            .p2p-peer-dot {
                width: 8px;
                height: 8px;
                border-radius: 50%;
                background: #00f0ff;
                box-shadow: 0 0 8px rgba(0, 240, 255, 0.5);
                flex-shrink: 0;
            }

            .p2p-peer-dot.self {
                background: #00ffaa;
                box-shadow: 0 0 8px rgba(0, 255, 170, 0.5);
            }

            .p2p-peer-name {
                font-family: 'JetBrains Mono', monospace;
                font-size: 11px;
                color: #d1d5db;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                max-width: 130px;
            }

            .p2p-peer-assets {
                font-family: 'Space Grotesk', sans-serif;
                font-size: 10px;
                color: #6b7280;
                margin-left: auto;
                font-weight: 500;
            }

            /* ---- Transfer Animation Burst ---- */
            .p2p-transfer-burst {
                position: fixed;
                pointer-events: none;
                font-size: 11px;
                font-weight: 700;
                font-family: 'Space Grotesk', sans-serif;
                z-index: 10001;
                padding: 4px 10px;
                background: rgba(10, 11, 24, 0.85);
                border: 1px solid currentColor;
                border-radius: 8px;
                box-shadow: 0 8px 24px rgba(0,0,0,0.5);
                letter-spacing: 0.5px;
                animation: p2p-burst 1.8s cubic-bezier(0.16, 1, 0.3, 1) forwards;
            }

            @keyframes p2p-burst {
                0% { opacity: 0; transform: translateY(20px) scale(0.85); }
                10% { opacity: 1; transform: translateY(0) scale(1); }
                80% { opacity: 1; }
                100% { opacity: 0; transform: translateY(-50px) scale(0.9); }
            }

            /* ---- Hidden state ---- */
            .p2p-hidden {
                opacity: 0;
                pointer-events: none;
                transform: scale(0.95) translateY(-10px);
                transition: opacity 0.3s ease, transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
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
                <div class="p2p-stats-title">Swarm Node</div>
                <button class="p2p-toggle-btn" id="p2p-minimize-btn">−</button>
            </div>
            <div class="p2p-stats-body" id="p2p-stats-body">
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Active Peers</span>
                    <span class="p2p-stat-value p2p-val-neutral" id="p2p-peers-count">0</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Peer Sourced</span>
                    <span class="p2p-stat-value p2p-val-peer" id="p2p-from-peers">0 (0%)</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Origin Sourced</span>
                    <span class="p2p-stat-value p2p-val-origin" id="p2p-from-origin">0 (0%)</span>
                </div>
                <div class="p2p-bar-container">
                    <div class="p2p-bar-peer" id="p2p-bar-peer" style="width: 0%"></div>
                    <div class="p2p-bar-origin" id="p2p-bar-origin" style="width: 0%"></div>
                </div>
                <div class="p2p-bar-labels">
                    <span style="color: #00f0ff;">● SWARM P2P</span>
                    <span style="color: #ff8800;">● CDN ORIGIN</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Saved Bandwidth</span>
                    <span class="p2p-stat-value p2p-val-saved" id="p2p-bandwidth-saved">0 B</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Uploaded to Swarm</span>
                    <span class="p2p-stat-value" id="p2p-bandwidth-uploaded" style="color: #d500f9; text-shadow: 0 0 10px rgba(213, 0, 249, 0.25);">0 B</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Network Load</span>
                    <span class="p2p-stat-value p2p-val-neutral" id="p2p-total-bytes">0 B</span>
                </div>
                <div class="p2p-stat-row">
                    <span class="p2p-stat-label">Local Cache</span>
                    <span class="p2p-stat-value p2p-val-neutral" id="p2p-local-assets">0 assets</span>
                </div>
            </div>
        `;
        this.container.appendChild(stats);

        // Peer List Panel & Visual Radar
        const peers = document.createElement('div');
        peers.className = 'p2p-panel p2p-peers';
        peers.innerHTML = `
            <div class="p2p-peers-title">Swarm Network</div>
            <canvas id="p2p-radar" width="220" height="150" style="display: block; margin: 8px auto 12px; background: rgba(0,0,0,0.2); border-radius: 10px; border: 1px solid rgba(255,255,255,0.03);"></canvas>
            <div id="p2p-peer-list" style="max-height: 120px; overflow-y: auto; padding-right: 2px;">
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
                <div style="color: #6b7280; font-family: 'Space Grotesk', sans-serif; font-size: 11px; text-align: center; padding: 16px; letter-spacing: 0.5px;">
                    Waiting for network requests...
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
            bandwidthUploaded: document.getElementById('p2p-bandwidth-uploaded'),
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
        this.elements.minimizeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this._minimized = !this._minimized;
            this.elements.statsBody.style.maxHeight = this._minimized ? '0px' : '500px';
            this.elements.statsBody.style.opacity = this._minimized ? '0' : '1';
            this.elements.minimizeBtn.textContent = this._minimized ? '+' : '−';
        });

        // Set self name
        if (this.manager) {
            this.elements.selfName.textContent = this.manager.peerId;
        }

        // Initialize animated radar
        this._initRadar();
    }

    // -----------------------------------------------------------------------
    // Radar visualizer
    // -----------------------------------------------------------------------

    _initRadar() {
        const canvas = document.getElementById('p2p-radar');
        if (!canvas) return;
        this.radarCanvas = canvas;
        this.radarCtx = canvas.getContext('2d');
        this.radarPeers = new Map(); // Maps peerId -> { x, y, angle, distance, label, pulse: 0 }
        this.radarPackets = [];      // Array of { startX, startY, progress, color, speed }
        this.radarSweepAngle = 0;
        this.radarActive = true;

        this._startRadarLoop();
    }

    _triggerRadarPulse(peerId, isOrigin = false) {
        if (!this.radarCanvas) return;
        
        let startX, startY, color;
        const centerX = this.radarCanvas.width / 2;
        const centerY = this.radarCanvas.height / 2;

        if (isOrigin) {
            // Origin packets come from outer orbit edge
            const angle = Math.random() * Math.PI * 2;
            startX = centerX + Math.cos(angle) * 70;
            startY = centerY + Math.sin(angle) * 70;
            color = '#ff8800'; // Origin Orange
        } else {
            const peer = this.radarPeers.get(peerId);
            if (!peer) {
                this._addPeerToRadar(peerId);
                const p = this.radarPeers.get(peerId);
                startX = p.x;
                startY = p.y;
            } else {
                startX = peer.x;
                startY = peer.y;
            }
            color = '#00f0ff'; // Peer Cyan
        }

        this.radarPackets.push({
            startX,
            startY,
            endX: centerX,
            endY: centerY,
            progress: 0,
            color,
            speed: 0.035 + Math.random() * 0.015
        });
    }

    _addPeerToRadar(peerId) {
        if (!this.radarCanvas) return;
        const width = this.radarCanvas.width;
        const height = this.radarCanvas.height;
        const centerX = width / 2;
        const centerY = height / 2;

        const angle = Math.random() * Math.PI * 2;
        const distance = 30 + Math.random() * 30; // Orbit radius between 30 and 60
        const x = centerX + Math.cos(angle) * distance;
        const y = centerY + Math.sin(angle) * distance;
        const label = peerId.replace('peer_', '').slice(0, 4).toUpperCase();

        this.radarPeers.set(peerId, { x, y, angle, distance, label, pulse: 0 });
    }

    _startRadarLoop() {
        const tick = () => {
            if (!this.radarActive) return;
            this._drawRadar();
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }

    _drawRadar() {
        const canvas = this.radarCanvas;
        const ctx = this.radarCtx;
        if (!canvas || !ctx) return;

        const width = canvas.width;
        const height = canvas.height;
        const centerX = width / 2;
        const centerY = height / 2;

        // Clear canvas with slight transparency for glow trail
        ctx.fillStyle = 'rgba(10, 11, 24, 0.22)';
        ctx.fillRect(0, 0, width, height);

        // Draw concentric orbit grid lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.04)';
        ctx.lineWidth = 1;
        [20, 40, 60].forEach(r => {
            ctx.beginPath();
            ctx.arc(centerX, centerY, r, 0, Math.PI * 2);
            ctx.stroke();
        });

        // Draw radar sweeping line
        this.radarSweepAngle = (this.radarSweepAngle + 0.018) % (Math.PI * 2);
        const sweepX = centerX + Math.cos(this.radarSweepAngle) * 70;
        const sweepY = centerY + Math.sin(this.radarSweepAngle) * 70;

        ctx.strokeStyle = 'rgba(0, 240, 255, 0.08)';
        ctx.beginPath();
        ctx.moveTo(centerX, centerY);
        ctx.lineTo(sweepX, sweepY);
        ctx.stroke();

        // Draw visual connecting dotted lines
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.02)';
        ctx.setLineDash([2, 3]);
        for (const [id, peer] of this.radarPeers) {
            ctx.beginPath();
            ctx.moveTo(centerX, centerY);
            ctx.lineTo(peer.x, peer.y);
            ctx.stroke();
        }
        ctx.setLineDash([]); // Reset line dash

        // Draw remote peer nodes
        for (const [id, peer] of this.radarPeers) {
            const angleDiff = Math.abs(this.radarSweepAngle - peer.angle);
            const isSwept = angleDiff < 0.25 || angleDiff > Math.PI * 2 - 0.25;
            
            peer.pulse = isSwept ? 1 : peer.pulse * 0.95;

            // Peer dot
            ctx.fillStyle = `rgba(0, 240, 255, ${0.4 + peer.pulse * 0.6})`;
            ctx.beginPath();
            ctx.arc(peer.x, peer.y, 4, 0, Math.PI * 2);
            ctx.fill();

            // Pulse ring around swept peer
            ctx.strokeStyle = `rgba(0, 240, 255, ${0.15 + peer.pulse * 0.35})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.arc(peer.x, peer.y, 6 + peer.pulse * 5, 0, Math.PI * 2);
            ctx.stroke();

            // Label text
            ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
            ctx.font = '8px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(peer.label, peer.x, peer.y - 8);
        }

        // Draw central local node ("You")
        const selfPulse = 1.25 + Math.sin(Date.now() / 250) * 0.2;
        ctx.shadowColor = '#00ffaa';
        ctx.shadowBlur = 8;
        ctx.fillStyle = '#00ffaa';
        ctx.beginPath();
        ctx.arc(centerX, centerY, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.shadowBlur = 0; // reset

        // Pulse ring around central node
        ctx.strokeStyle = 'rgba(0, 255, 170, 0.18)';
        ctx.beginPath();
        ctx.arc(centerX, centerY, 7 * selfPulse, 0, Math.PI * 2);
        ctx.stroke();

        // Draw packets propagating to center
        for (let i = this.radarPackets.length - 1; i >= 0; i--) {
            const p = this.radarPackets[i];
            p.progress += p.speed;

            if (p.progress >= 1) {
                this.radarPackets.splice(i, 1);
                continue;
            }

            const px = p.startX + (p.endX - p.startX) * p.progress;
            const py = p.startY + (p.endY - p.startY) * p.progress;

            // Glowing package
            ctx.shadowColor = p.color;
            ctx.shadowBlur = 6;
            ctx.fillStyle = p.color;
            ctx.beginPath();
            ctx.arc(px, py, 3.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0; // reset
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
            
            // Visual pulse trigger on our animated radar
            if (transfer.source === 'peer' && transfer.peerId) {
                this._triggerRadarPulse(transfer.peerId, false);
            } else if (transfer.source === 'origin') {
                this._triggerRadarPulse(null, true);
            }
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
        if (this.elements.bandwidthUploaded) {
            this.elements.bandwidthUploaded.textContent = this._formatBytes(metrics.bytesUploaded || 0);
        }
        this.elements.totalBytes.textContent = this._formatBytes(metrics.bytesFromPeers + metrics.bytesFromOrigin);
        this.elements.localAssets.textContent = metrics.localAssetCount;
        this.elements.selfAssets.textContent = `${metrics.localAssetCount} assets`;
    }

    _updatePeerList(peers) {
        // Keep self entry, rebuild others
        const selfEntry = this.elements.peerList.firstElementChild;
        this.elements.peerList.innerHTML = '';
        this.elements.peerList.appendChild(selfEntry);

        // Re-sync radar nodes
        if (this.radarPeers) {
            const activeIds = new Set(peers.map(p => p.peerId));
            for (const id of this.radarPeers.keys()) {
                if (!activeIds.has(id)) {
                    this.radarPeers.delete(id);
                }
            }
            for (const peer of peers) {
                if (!this.radarPeers.has(peer.peerId)) {
                    this._addPeerToRadar(peer.peerId);
                }
            }
        }

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

        const icon = transfer.source === 'peer' ? '⚡' : transfer.source === 'cache' ? '💾' : transfer.source === 'upload' ? '📤' : '🌐';
        const sourceLabel = transfer.source === 'peer'
            ? transfer.peerId || 'Peer'
            : transfer.source === 'cache'
                ? 'Cache'
                : transfer.source === 'upload'
                    ? `To: ${transfer.peerId.substr(0, 8)}`
                    : 'Origin';

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
