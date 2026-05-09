/**
 * topology-graph.js — Network Topology Visualizer (Bottom Right)
 *
 * Renders a sleek, force-influenced radial node graph on a 192×192
 * HTML5 Canvas element at 30 fps.
 *
 * Design:
 *   • NO radar sweep — clean, data-viz aesthetic.
 *   • Nodes orbit the central YOU node with slight sine-wave oscillation
 *     to keep the graph feeling "alive" even when idle.
 *   • Active edges turn Emerald (#10B981) and animate a moving dashed line
 *     to show packet flow direction (peer→you for download, you→peer for upload).
 *   • ctx.setLineDash([4,4]) + lineDashOffset animation for the flow effect.
 *
 * Events listened:
 *   arrakis:peer-joined    { detail: { peerId } }
 *   arrakis:peer-left      { detail: { peerId } }
 *   arrakis:peer-list      { detail: { peers: [{peerId}] } }
 *   arrakis:transfer       { detail: { source, peerId, assetName } }
 *   arrakis:upload         { detail: { peerId } }
 */

(function () {
    'use strict';

    // ── Constants ─────────────────────────────────────────────────────────────

    /** Canvas logical resolution (CSS size set via CSS) */
    const W = 192;
    const H = 192;

    /** Center of the canvas */
    const CX = W / 2;
    const CY = H / 2;

    /** Radius of the orbit ring on which peers are placed */
    const ORBIT_R_MIN = 52;
    const ORBIT_R_MAX = 76;

    /** Self node visual radius */
    const SELF_R = 6;
    /** Peer node visual radius */
    const PEER_R = 4;

    /** Milliseconds an edge stays "active" after a transfer event */
    const EDGE_ACTIVE_MS = 2200;

    /** Target frames per second */
    const FPS = 30;
    const FRAME_MS = 1000 / FPS;

    // Design system colors (mirrored from CSS vars for canvas use)
    const COLOR_BG           = 'rgba(0,0,0,0)';
    const COLOR_SELF         = '#F4F4F5';
    const COLOR_SELF_GLOW    = 'rgba(244,244,245,0.3)';
    const COLOR_PEER_ACTIVE  = '#10B981';
    const COLOR_PEER_IDLE    = '#3F3F46';
    const COLOR_EDGE_BASE    = 'rgba(255,255,255,0.06)';
    const COLOR_EDGE_ACTIVE  = '#10B981';
    const COLOR_EDGE_UPLOAD  = '#A855F7';
    const COLOR_PACKET       = '#10B981';
    const COLOR_ORIGIN_NODE  = '#3B82F6';

    // ── TopologyGraph ─────────────────────────────────────────────────────────

    class TopologyGraph {
        /**
         * @param {HTMLCanvasElement} canvas
         */
        constructor(canvas) {
            this._canvas = canvas;
            this._ctx    = canvas.getContext('2d');

            // Set canvas pixel resolution
            canvas.width  = W;
            canvas.height = H;

            /**
             * Peer node map.
             * Map<peerId, {
             *   baseAngle: number,    angle in radians for base orbit position
             *   orbitR:   number,     orbit radius (px)
             *   phase:    number,     sine phase offset for oscillation
             *   speed:    number,     oscillation speed
             *   amplitude: number,    oscillation amplitude in px
             *   activeUntil: number,  timestamp until edge is highlighted
             *   uploadUntil: number,  timestamp until upload edge is highlighted
             * }>
             */
            this._peers = new Map();

            /** Animation tick counter (increments each frame) */
            this._tick = 0;

            /** timestamp of last frame */
            this._lastFrame = 0;

            /** rAF handle */
            this._raf = null;

            this._bindEvents();
            this._startLoop();
        }

        // ── Peer Management ────────────────────────────────────────────────────

        _addPeer(peerId) {
            if (this._peers.has(peerId)) return;

            // Spread peers evenly around the ring, then jitter
            const count   = this._peers.size;
            const baseAng = (count * 2.399) % (Math.PI * 2); // golden-angle spread
            const orbitR  = ORBIT_R_MIN + Math.random() * (ORBIT_R_MAX - ORBIT_R_MIN);
            const phase   = Math.random() * Math.PI * 2;
            const speed   = 0.6 + Math.random() * 0.8;   // radians/s
            const amp     = 3 + Math.random() * 5;        // px oscillation

            this._peers.set(peerId, {
                baseAngle:    baseAng,
                orbitR,
                phase,
                speed,
                amplitude:    amp,
                activeUntil:  0,
                uploadUntil:  0,
            });
        }

        _removePeer(peerId) {
            this._peers.delete(peerId);
        }

        /**
         * Computes the current (x, y) position of a peer node.
         * Applies a slow sine-wave oscillation so the graph feels alive.
         * @param {object} peer  The peer state object.
         * @param {number} now   Current timestamp (ms).
         * @returns {{ x: number, y: number }}
         */
        _peerPos(peer, now) {
            const t   = now / 1000;
            // Oscillate the orbit radius with a per-peer sine wave
            const osc = Math.sin(t * peer.speed + peer.phase) * peer.amplitude;
            const r   = peer.orbitR + osc;
            return {
                x: CX + Math.cos(peer.baseAngle + t * 0.05) * r,
                y: CY + Math.sin(peer.baseAngle + t * 0.05) * r,
            };
        }

        // ── Event Binding ──────────────────────────────────────────────────────

        _bindEvents() {
            window.addEventListener('arrakis:peer-joined', (e) => {
                this._addPeer(e.detail.peerId);
            });

            window.addEventListener('arrakis:peer-left', (e) => {
                this._removePeer(e.detail.peerId);
            });

            window.addEventListener('arrakis:peer-list', (e) => {
                const newIds = new Set((e.detail.peers || []).map(p => p.peerId));
                // Remove departed
                for (const id of this._peers.keys()) {
                    if (!newIds.has(id)) this._removePeer(id);
                }
                // Add new
                for (const id of newIds) {
                    this._addPeer(id);
                }
            });

            window.addEventListener('arrakis:transfer', (e) => {
                const { source, peerId } = e.detail;
                if (source === 'peer' && peerId) {
                    if (!this._peers.has(peerId)) this._addPeer(peerId);
                    const p = this._peers.get(peerId);
                    if (p) p.activeUntil = Date.now() + EDGE_ACTIVE_MS;
                }
            });

            window.addEventListener('arrakis:upload', (e) => {
                const { peerId } = e.detail;
                if (peerId) {
                    if (!this._peers.has(peerId)) this._addPeer(peerId);
                    const p = this._peers.get(peerId);
                    if (p) p.uploadUntil = Date.now() + EDGE_ACTIVE_MS;
                }
            });

            // Also hook directly into P2PManager callbacks if available
            this._managerPollInterval = setInterval(() => {
                if (window.p2pManager && window.p2pManager.peers) {
                    for (const [id] of window.p2pManager.peers) {
                        this._addPeer(id);
                    }
                    // Remove stale
                    for (const id of this._peers.keys()) {
                        if (!window.p2pManager.peers.has(id)) {
                            this._removePeer(id);
                        }
                    }
                }
            }, 2000);
        }

        // ── Render Loop ────────────────────────────────────────────────────────

        _startLoop() {
            const frame = (ts) => {
                this._raf = requestAnimationFrame(frame);
                if (ts - this._lastFrame < FRAME_MS - 1) return; // throttle to 30fps
                this._lastFrame = ts;
                this._tick++;
                this._draw(ts);
            };
            this._raf = requestAnimationFrame(frame);
        }

        _draw(now) {
            const ctx = this._ctx;

            // ── Clear ──────────────────────────────────────────────────────────
            ctx.clearRect(0, 0, W, H);

            // ── Draw edges ────────────────────────────────────────────────────
            for (const [peerId, peer] of this._peers) {
                const pos      = this._peerPos(peer, now);
                const isActive  = now < peer.activeUntil;
                const isUpload  = now < peer.uploadUntil;
                const anyActive = isActive || isUpload;

                // Base edge line
                ctx.beginPath();
                ctx.moveTo(CX, CY);
                ctx.lineTo(pos.x, pos.y);

                if (anyActive) {
                    ctx.strokeStyle = isUpload ? COLOR_EDGE_UPLOAD : COLOR_EDGE_ACTIVE;
                    ctx.lineWidth   = 1.5;
                    ctx.globalAlpha = 0.55;
                } else {
                    ctx.strokeStyle = COLOR_EDGE_BASE;
                    ctx.lineWidth   = 1;
                    ctx.globalAlpha = 1;
                }
                ctx.setLineDash([]);
                ctx.stroke();
                ctx.globalAlpha = 1;

                // Animated dash overlay on active edges
                if (anyActive) {
                    const dashColor = isUpload ? COLOR_EDGE_UPLOAD : COLOR_EDGE_ACTIVE;

                    // Compute dashes flowing: download → from peer to center
                    //                         upload   → from center to peer
                    // We do this by controlling lineDashOffset direction.
                    const dashOffset = isUpload
                        ? (this._tick * 1.2) % 16      // flows toward peer
                        : -(this._tick * 1.2) % 16;    // flows toward center

                    ctx.beginPath();
                    ctx.moveTo(CX, CY);
                    ctx.lineTo(pos.x, pos.y);
                    ctx.strokeStyle = dashColor;
                    ctx.lineWidth   = 1.5;
                    ctx.setLineDash([4, 4]);
                    ctx.lineDashOffset = dashOffset;
                    ctx.globalAlpha = 0.85;
                    ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.globalAlpha = 1;
                }
            }

            // ── Draw peer nodes ───────────────────────────────────────────────
            for (const [peerId, peer] of this._peers) {
                const pos      = this._peerPos(peer, now);
                const isActive  = now < peer.activeUntil || now < peer.uploadUntil;
                const nodeColor = isActive ? COLOR_PEER_ACTIVE : COLOR_PEER_IDLE;

                // Glow on active
                if (isActive) {
                    ctx.beginPath();
                    ctx.arc(pos.x, pos.y, PEER_R + 4, 0, Math.PI * 2);
                    const grd = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, PEER_R + 4);
                    grd.addColorStop(0, 'rgba(16,185,129,0.35)');
                    grd.addColorStop(1, 'rgba(16,185,129,0)');
                    ctx.fillStyle = grd;
                    ctx.fill();
                }

                // Peer dot
                ctx.beginPath();
                ctx.arc(pos.x, pos.y, PEER_R, 0, Math.PI * 2);
                ctx.fillStyle = nodeColor;
                ctx.fill();

                // Peer label (short id)
                const label = peerId.replace(/^peer_?/, '').slice(-4).toUpperCase();
                ctx.fillStyle  = isActive ? 'rgba(244,244,245,0.7)' : 'rgba(161,161,170,0.5)';
                ctx.font       = `500 8px "JetBrains Mono", monospace`;
                ctx.textAlign  = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillText(label, pos.x, pos.y - PEER_R - 2);
            }

            // ── Draw self (center) node ───────────────────────────────────────
            // Breathe ring
            const breathe = 1 + Math.sin(now / 500) * 0.12;

            ctx.beginPath();
            ctx.arc(CX, CY, (SELF_R + 4) * breathe, 0, Math.PI * 2);
            const selfGrd = ctx.createRadialGradient(CX, CY, 0, CX, CY, (SELF_R + 6) * breathe);
            selfGrd.addColorStop(0, 'rgba(244,244,245,0.18)');
            selfGrd.addColorStop(1, 'rgba(244,244,245,0)');
            ctx.fillStyle = selfGrd;
            ctx.fill();

            // Solid core
            ctx.beginPath();
            ctx.arc(CX, CY, SELF_R, 0, Math.PI * 2);
            ctx.fillStyle = COLOR_SELF;
            ctx.fill();

            // YOU label
            ctx.fillStyle    = 'rgba(244,244,245,0.65)';
            ctx.font         = `600 8px "JetBrains Mono", monospace`;
            ctx.textAlign    = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText('YOU', CX, CY - SELF_R - 3);

            // Reset state
            ctx.setLineDash([]);
            ctx.globalAlpha  = 1;
            ctx.textBaseline = 'alphabetic';
        }

        destroy() {
            if (this._raf) cancelAnimationFrame(this._raf);
            clearInterval(this._managerPollInterval);
        }
    }

    // ── Export ────────────────────────────────────────────────────────────────
    window.TopologyGraph = TopologyGraph;
})();
