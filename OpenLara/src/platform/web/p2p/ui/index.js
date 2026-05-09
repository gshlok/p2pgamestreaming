/**
 * index.js — UI Orchestrator & DOM Bootstrap
 *
 * Creates the full HUD overlay DOM structure over the game canvas,
 * instantiates all sub-modules (GlobalMetrics, TransferFeed, TopologyGraph),
 * and wires up the Immersive Mode and Analytics Mode toggle buttons.
 *
 * Layout (CSS Grid, absolute over canvas):
 *
 *   ┌──────────────────────────────────────────────────┐
 *   │ [top-left]             [top-center]  [top-right] │
 *   │  —                      —            NetMetrics  │
 *   │                                                  │
 *   │                    [3D canvas]                   │
 *   │                                                  │
 *   │ [bot-left]          [bot-center]   [bot-right]   │
 *   │  Controls           TransferFeed   Topology       │
 *   └──────────────────────────────────────────────────┘
 *
 * Immersive Mode: hides everything + enters browser fullscreen.
 * Analytics Mode: toggles the metric panels visible/hidden.
 *
 * This module also acts as the bridge between P2PManager callbacks
 * and the custom arrakis:* window events that the sub-modules consume.
 */

(function () {
    'use strict';

    // ── SVG Icon Helpers ─────────────────────────────────────────────────────

    /** Eye icon (analytics ON) */
    const ICON_EYE = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
        </svg>`;

    /** Eye-off icon (analytics OFF) */
    const ICON_EYE_OFF = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
        </svg>`;

    /** Fullscreen / maximize icon */
    const ICON_MAXIMIZE = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>
        </svg>`;

    /** Exit fullscreen icon */
    const ICON_MINIMIZE = `
        <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"/>
        </svg>`;

    // ── ArrakisHUD ────────────────────────────────────────────────────────────

    class ArrakisHUD {
        constructor() {
            this._analyticsVisible = true;
            this._immersive        = false;
            this._root             = null;

            // Sub-module instances
            this._metrics   = null;
            this._feed      = null;
            this._topology  = null;

            this._injectStyles();
            this._buildDOM();
            this._initModules();
            this._bridgeP2PManager();
            this._handleResize();
        }

        // ── Style injection ─────────────────────────────────────────────────

        _injectStyles() {
            if (document.getElementById('arrakis-hud-styles')) return;
            const link = document.createElement('link');
            link.id   = 'arrakis-hud-styles';
            link.rel  = 'stylesheet';
            // Resolve relative to this script's own directory
            const scriptDir = (() => {
                const scripts = document.querySelectorAll('script[src]');
                for (const s of scripts) {
                    if (s.src.includes('ui/index.js')) {
                        return s.src.replace('index.js', '');
                    }
                }
                return 'p2p/ui/';
            })();
            link.href = scriptDir + 'styles.css';
            document.head.appendChild(link);
        }

        // ── DOM Construction ─────────────────────────────────────────────────

        _buildDOM() {
            // Root overlay
            const root = document.createElement('div');
            root.id = 'arrakis-hud';
            this._root = root;

            // ── Global Metrics (top-right) ────────────────────────────────────
            const metricsPanel = document.createElement('div');
            metricsPanel.id        = 'hud-global-metrics';
            metricsPanel.className = 'hud-panel';
            metricsPanel.setAttribute('role', 'status');
            metricsPanel.setAttribute('aria-label', 'P2P Network Metrics');
            root.appendChild(metricsPanel);

            // ── Controls (bottom-left) ────────────────────────────────────────
            const ctrlPanel = document.createElement('div');
            ctrlPanel.id        = 'hud-controls';
            ctrlPanel.className = 'hud-panel';

            // Analytics toggle button
            const analyticsBtn = document.createElement('button');
            analyticsBtn.id        = 'hud-analytics-btn';
            analyticsBtn.className = 'ctrl-btn active';
            analyticsBtn.title     = 'Toggle Analytics Panels';
            analyticsBtn.setAttribute('aria-pressed', 'true');
            analyticsBtn.innerHTML = ICON_EYE;
            analyticsBtn.addEventListener('click', () => this._toggleAnalytics(analyticsBtn));
            ctrlPanel.appendChild(analyticsBtn);

            // Immersive mode button
            const immersiveBtn = document.createElement('button');
            immersiveBtn.id        = 'hud-immersive-btn';
            immersiveBtn.className = 'ctrl-btn';
            immersiveBtn.title     = 'Immersive Mode (Fullscreen)';
            immersiveBtn.setAttribute('aria-pressed', 'false');
            immersiveBtn.innerHTML = ICON_MAXIMIZE;
            immersiveBtn.addEventListener('click', () => this._toggleImmersive(immersiveBtn));
            ctrlPanel.appendChild(immersiveBtn);

            root.appendChild(ctrlPanel);

            // ── Transfer Feed (bottom-center) ─────────────────────────────────
            const feedPanel = document.createElement('div');
            feedPanel.id        = 'hud-transfer-feed';
            feedPanel.className = 'hud-panel';
            feedPanel.setAttribute('role', 'log');
            feedPanel.setAttribute('aria-label', 'Live Asset Transfers');
            feedPanel.setAttribute('aria-live', 'polite');
            root.appendChild(feedPanel);

            // ── Topology Visualizer (bottom-right) ────────────────────────────
            const topoPanel = document.createElement('div');
            topoPanel.id        = 'hud-topology';
            topoPanel.className = 'hud-panel';
            topoPanel.setAttribute('role', 'img');
            topoPanel.setAttribute('aria-label', 'Network Topology');

            const topoHeader = document.createElement('div');
            topoHeader.className = 'topology-header';

            const topoTitle = document.createElement('span');
            topoTitle.className = 'topology-title';
            topoTitle.textContent = 'Network Topology';

            const liveDot = document.createElement('div');
            liveDot.className = 'topology-live-dot';

            topoHeader.appendChild(topoTitle);
            topoHeader.appendChild(liveDot);

            const topoCanvas = document.createElement('canvas');
            topoCanvas.id = 'topology-canvas';
            topoCanvas.setAttribute('aria-hidden', 'true');

            topoPanel.appendChild(topoHeader);
            topoPanel.appendChild(topoCanvas);
            root.appendChild(topoPanel);

            document.body.appendChild(root);

            // Save references for module init
            this._metricsEl = metricsPanel;
            this._feedEl    = feedPanel;
            this._topoCanvas = topoCanvas;
        }

        // ── Module Initialisation ─────────────────────────────────────────────

        _initModules() {
            // GlobalMetrics strip
            if (window.GlobalMetrics) {
                this._metrics = new GlobalMetrics(this._metricsEl);
            } else {
                console.warn('[ArrakisHUD] GlobalMetrics not loaded.');
            }

            // Transfer Feed
            if (window.TransferFeed) {
                this._feed = new TransferFeed(this._feedEl);
            } else {
                console.warn('[ArrakisHUD] TransferFeed not loaded.');
            }

            // Topology Graph
            if (window.TopologyGraph) {
                this._topology = new TopologyGraph(this._topoCanvas);
            } else {
                console.warn('[ArrakisHUD] TopologyGraph not loaded.');
            }
        }

        // ── P2PManager Bridge ─────────────────────────────────────────────────

        /**
         * Wires P2PManager callback hooks into window custom events so that
         * all sub-modules can independently subscribe without coupling.
         *
         * Runs on an interval to pick up the manager once it initialises
         * (it may be created after this script runs).
         */
        _bridgeP2PManager() {
            let hooked = false;

            const tryHook = () => {
                const mgr = window.p2pManager;
                if (!mgr || hooked) return;
                hooked = true;

                // ── Metrics update ──────────────────────────────────────────
                const origOnMetrics = mgr.onMetricsUpdate;
                mgr.onMetricsUpdate = (m) => {
                    if (origOnMetrics) origOnMetrics(m);
                    window.dispatchEvent(new CustomEvent('arrakis:metrics-update', {
                        detail: {
                            bytesSaved:     m.bytesSaved     || 0,
                            bytesUploaded:  m.bytesUploaded  || 0,
                            downloadRate:   0,  // not tracked by current P2PManager
                            uploadRate:     0,
                            peersActive:    m.peersConnected || 0,
                            peersConnected: m.peersConnected || 0,
                        }
                    }));
                };

                // ── Transfer event ──────────────────────────────────────────
                const origOnTransfer = mgr.onTransfer;
                mgr.onTransfer = (t) => {
                    if (origOnTransfer) origOnTransfer(t);
                    window.dispatchEvent(new CustomEvent('arrakis:transfer', { detail: t }));

                    // Emit upload event for topology
                    if (t.source === 'upload' && t.peerId) {
                        window.dispatchEvent(new CustomEvent('arrakis:upload', {
                            detail: { peerId: t.peerId }
                        }));
                    }
                };

                // ── Peer list changed ───────────────────────────────────────
                const origOnPeerList = mgr.onPeerListChanged;
                mgr.onPeerListChanged = (peers) => {
                    if (origOnPeerList) origOnPeerList(peers);
                    window.dispatchEvent(new CustomEvent('arrakis:peer-list', {
                        detail: { peers }
                    }));
                };

                console.log('[ArrakisHUD] P2PManager bridge attached.');
            };

            // Try immediately and then poll
            tryHook();
            const poll = setInterval(() => {
                tryHook();
                if (hooked) clearInterval(poll);
            }, 500);
        }

        // ── Toggle: Analytics Mode ────────────────────────────────────────────

        _toggleAnalytics(btn) {
            this._analyticsVisible = !this._analyticsVisible;
            this._root.classList.toggle('analytics-hidden', !this._analyticsVisible);
            btn.classList.toggle('active', this._analyticsVisible);
            btn.innerHTML = this._analyticsVisible ? ICON_EYE : ICON_EYE_OFF;
            btn.setAttribute('aria-pressed', String(this._analyticsVisible));
            btn.title = this._analyticsVisible ? 'Hide Analytics' : 'Show Analytics';
        }

        // ── Toggle: Immersive Mode ────────────────────────────────────────────

        _toggleImmersive(btn) {
            this._immersive = !this._immersive;
            this._root.classList.toggle('immersive', this._immersive);
            btn.classList.toggle('active', this._immersive);
            btn.innerHTML = this._immersive ? ICON_MINIMIZE : ICON_MAXIMIZE;
            btn.setAttribute('aria-pressed', String(this._immersive));
            btn.title = this._immersive ? 'Exit Immersive Mode' : 'Immersive Mode (Fullscreen)';

            if (this._immersive) {
                const el = document.documentElement;
                const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen;
                if (req) req.call(el).catch(() => {});
            } else {
                const ex = document.exitFullscreen || document.webkitExitFullscreen || document.mozCancelFullScreen;
                if (ex) ex.call(document).catch(() => {});
            }
        }

        // ── Resize Handler ────────────────────────────────────────────────────

        _handleResize() {
            // The CSS layout already adapts; topology canvas keeps its own resolution.
            // Nothing specific needed here unless future responsive work is added.
            window.addEventListener('resize', () => {}, { passive: true });
        }

        // ── Public API ────────────────────────────────────────────────────────

        destroy() {
            this._metrics?._destroy?.();
            this._feed?.destroy?.();
            this._topology?.destroy?.();
            this._root?.remove();
        }
    }

    // ── Bootstrap ─────────────────────────────────────────────────────────────

    /**
     * Wait for sub-module scripts to be available, then instantiate the HUD.
     * If they are already loaded (same-document inline scripts run synchronously)
     * this resolves immediately.
     */
    function waitForDeps(names, cb, maxWait = 5000) {
        const start = Date.now();
        const check = () => {
            if (names.every(n => typeof window[n] === 'function')) {
                cb();
                return;
            }
            if (Date.now() - start > maxWait) {
                console.warn('[ArrakisHUD] Timeout waiting for deps, initialising anyway.');
                cb();
                return;
            }
            setTimeout(check, 80);
        };
        check();
    }

    function bootstrap() {
        waitForDeps(['GlobalMetrics', 'TransferFeed', 'TopologyGraph'], () => {
            window.arrakisHUD = new ArrakisHUD();
            console.log('[ArrakisHUD] Initialised ✓');
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bootstrap);
    } else {
        bootstrap();
    }

    // ── Export ────────────────────────────────────────────────────────────────
    window.ArrakisHUD = ArrakisHUD;
})();
