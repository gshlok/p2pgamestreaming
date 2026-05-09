/**
 * global-metrics.js — Global Network Metrics Strip (Top Right)
 *
 * Renders and animates a compact horizontal dashboard of aggregate P2P
 * network health metrics. Binds to custom window events dispatched by
 * P2PManager to receive live metric updates.
 *
 * Events listened:
 *   arrakis:metrics-update  { detail: MetricsPayload }
 *
 * MetricsPayload shape:
 *   {
 *     bytesSaved:      number,   // total bytes fetched from peers
 *     bytesUploaded:   number,   // total bytes uploaded to swarm
 *     downloadRate:    number,   // bytes/s download
 *     uploadRate:      number,   // bytes/s upload
 *     peersActive:     number,   // WebRTC channels open
 *     peersConnected:  number,   // total known peers
 *   }
 */

(function () {
    'use strict';

    /**
     * Formats a byte count into a human-readable string.
     * @param {number} bytes
     * @returns {string}
     */
    function formatBytes(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
        return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
    }

    /**
     * Formats a bytes/s rate.
     * @param {number} bps
     * @returns {string}
     */
    function formatRate(bps) {
        if (!bps || bps <= 0) return '0 B/s';
        const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
        const i = Math.min(Math.floor(Math.log(bps) / Math.log(1024)), units.length - 1);
        return `${(bps / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
    }

    /**
     * Smoothly animates a metric value DOM element on change.
     * Adds the 'ticked' CSS class which triggers the keyframe.
     * @param {HTMLElement} el
     * @param {string} newText
     */
    function animateTick(el, newText) {
        if (!el || el.textContent === newText) return;
        el.textContent = newText;
        el.classList.remove('ticked');
        // Force reflow to restart animation
        void el.offsetWidth;
        el.classList.add('ticked');
    }

    /**
     * GlobalMetrics — manages the metrics strip in the top-right corner.
     */
    class GlobalMetrics {
        /**
         * @param {HTMLElement} container  The #hud-global-metrics element.
         */
        constructor(container) {
            this._container = container;
            this._els = {};
            this._build();
            this._bindEvents();
        }

        // ── DOM Build ───────────────────────────────────────────────────────

        _build() {
            // Metric definitions: [id, label, colorClass]
            const items = [
                { id: 'bw-saved',   label: 'BW SAVED',   cls: 'v-peer' },
                { id: 'uploaded',   label: 'UPLOADED',   cls: '' },
                { id: 'net-dl',     label: 'NET ↓',      cls: 'v-origin' },
                { id: 'net-ul',     label: 'NET ↑',      cls: '' },
                { id: 'peers',      label: 'PEERS',      cls: 'v-peer' },
            ];

            items.forEach(({ id, label, cls }) => {
                const item = document.createElement('div');
                item.className = 'metric-item';

                const labelEl = document.createElement('span');
                labelEl.className = 'metric-label';
                labelEl.textContent = label;

                const valueEl = document.createElement('span');
                valueEl.className = `metric-value${cls ? ' ' + cls : ''}`;
                valueEl.id = `gm-${id}`;
                valueEl.textContent = '—';

                item.appendChild(labelEl);
                item.appendChild(valueEl);
                this._container.appendChild(item);

                this._els[id] = valueEl;
            });
        }

        // ── Event Binding ────────────────────────────────────────────────────

        _bindEvents() {
            window.addEventListener('arrakis:metrics-update', (e) => {
                this._onMetrics(e.detail);
            });

            // Also poll window.p2pManager as a fallback if events aren't fired
            this._pollInterval = setInterval(() => {
                if (window.p2pManager && typeof window.p2pManager.getMetrics === 'function') {
                    const m = window.p2pManager.getMetrics();
                    this._onMetrics({
                        bytesSaved:     m.bytesSaved     || 0,
                        bytesUploaded:  m.bytesUploaded  || 0,
                        downloadRate:   0,
                        uploadRate:     0,
                        peersActive:    m.peersConnected || 0,
                        peersConnected: m.peersConnected || 0,
                    });
                }
            }, 1200);
        }

        // ── Data Handler ─────────────────────────────────────────────────────

        _onMetrics(m) {
            animateTick(this._els['bw-saved'], formatBytes(m.bytesSaved));
            animateTick(this._els['uploaded'], formatBytes(m.bytesUploaded));
            animateTick(this._els['net-dl'],   formatRate(m.downloadRate));
            animateTick(this._els['net-ul'],   formatRate(m.uploadRate));

            const active    = m.peersActive    || 0;
            const connected = m.peersConnected || 0;
            animateTick(this._els['peers'], `${active} / ${connected}`);
        }

        destroy() {
            clearInterval(this._pollInterval);
        }
    }

    // ── Export ────────────────────────────────────────────────────────────────
    window.GlobalMetrics = GlobalMetrics;
})();
