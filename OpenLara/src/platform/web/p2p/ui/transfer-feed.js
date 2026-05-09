/**
 * transfer-feed.js — Active Transfers Feed (Bottom Center)
 *
 * Displays a live vertical stack of in-flight and recently-completed
 * asset transfers. Each item shows:
 *   • Asset filename
 *   • Source badge: PEER (Emerald) | ORIGIN (Blue) | CACHE (Zinc)
 *   • 2px slim progress bar that fills during chunk assembly
 *   • Speed + Peer ID annotation
 *
 * Lifecycle:
 *   1. arrakis:transfer-start  → item appears, bar animates
 *   2. arrakis:transfer-progress → bar updates to new %
 *   3. arrakis:transfer-complete → badge → ✓, item fades out after 2s
 *
 * Also accepts arrakis:transfer (single shot complete) from P2PManager.
 */

(function () {
    'use strict';

    const MAX_VISIBLE = 3;   // Max simultaneous visible items
    const LINGER_MS   = 2000; // Time to show completed item before fade

    /**
     * Formats bytes into a human-readable string.
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
     * Returns a short display name for a peer ID.
     * @param {string|null} peerId
     * @returns {string}
     */
    function shortPeer(peerId) {
        if (!peerId) return 'HTTP Fallback';
        // Take last 4 hex-like chars as a handle
        const clean = peerId.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
        return `Peer #${clean.slice(-4)}`;
    }

    /**
     * TransferFeed — manages the live transfers feed panel.
     */
    class TransferFeed {
        /**
         * @param {HTMLElement} container  The #hud-transfer-feed element.
         */
        constructor(container) {
            this._container = container;
            this._list = null;       // .feed-list <div>
            this._countEl = null;    // feed-count span
            this._items = new Map(); // assetName → { el, barFill, badge, meta }
            this._build();
            this._bindEvents();
        }

        // ── DOM Build ────────────────────────────────────────────────────────

        _build() {
            // Header
            const header = document.createElement('div');
            header.className = 'feed-header';

            const title = document.createElement('span');
            title.className = 'feed-title';
            title.textContent = 'Active Transfers';

            this._countEl = document.createElement('span');
            this._countEl.className = 'feed-count';
            this._countEl.textContent = '';

            header.appendChild(title);
            header.appendChild(this._countEl);

            // Feed list
            this._list = document.createElement('div');
            this._list.className = 'feed-list';

            this._container.appendChild(header);
            this._container.appendChild(this._list);
        }

        // ── Event Binding ────────────────────────────────────────────────────

        _bindEvents() {
            // In-flight start (optional — fired when fetch begins)
            window.addEventListener('arrakis:transfer-start', (e) => {
                const { assetName, source, peerId } = e.detail;
                this._addItem(assetName, source, peerId, 0);
            });

            // Progress update
            window.addEventListener('arrakis:transfer-progress', (e) => {
                const { assetName, progress } = e.detail; // progress 0–1
                this._updateProgress(assetName, progress);
            });

            // Completed (with or without prior start event)
            window.addEventListener('arrakis:transfer-complete', (e) => {
                const { assetName, source, peerId, size, duration } = e.detail;
                if (!this._items.has(assetName)) {
                    this._addItem(assetName, source, peerId, 0);
                }
                this._completeItem(assetName, source, size, duration);
            });

            // Single-shot from P2PManager.onTransfer callback bridge
            window.addEventListener('arrakis:transfer', (e) => {
                const t = e.detail;
                const name = t.assetName || '';
                if (!this._items.has(name)) {
                    this._addItem(name, t.source, t.peerId, 0);
                }
                this._completeItem(name, t.source, t.size, t.duration);
            });
        }

        // ── Item Lifecycle ────────────────────────────────────────────────────

        /**
         * Creates and inserts a new feed item.
         * @param {string} assetName
         * @param {string} source  'peer' | 'origin' | 'cache'
         * @param {string|null} peerId
         * @param {number} progress  0–1
         */
        _addItem(assetName, source, peerId, progress) {
            // Deduplicate
            if (this._items.has(assetName)) return;

            // Trim if over max visible
            if (this._list.children.length >= MAX_VISIBLE) {
                const oldest = this._list.firstChild;
                if (oldest) {
                    const oldKey = oldest.dataset.asset;
                    this._items.delete(oldKey);
                    oldest.remove();
                }
            }

            const shortName = assetName.split('/').pop() || assetName;
            const src = source || 'origin';

            const el = document.createElement('div');
            el.className = 'feed-item';
            el.dataset.source = src;
            el.dataset.asset  = assetName;

            // Top row
            const top = document.createElement('div');
            top.className = 'feed-item-top';

            const badge = document.createElement('span');
            badge.className = `source-badge ${src}`;
            badge.textContent = src.toUpperCase();

            const nameEl = document.createElement('span');
            nameEl.className = 'feed-asset-name';
            nameEl.title = assetName;
            nameEl.textContent = shortName;

            const meta = document.createElement('span');
            meta.className = 'feed-meta';
            meta.textContent = shortPeer(peerId);

            top.appendChild(badge);
            top.appendChild(nameEl);
            top.appendChild(meta);

            // Progress bar
            const barWrap = document.createElement('div');
            barWrap.className = 'feed-item-bar';

            const barFill = document.createElement('div');
            barFill.className = 'feed-item-bar-fill';
            barFill.style.width = `${Math.round(progress * 100)}%`;

            barWrap.appendChild(barFill);
            el.appendChild(top);
            el.appendChild(barWrap);

            this._list.appendChild(el);
            this._items.set(assetName, { el, barFill, badge, meta });
            this._refreshCount();
        }

        /**
         * Updates the progress bar for an in-flight item.
         * @param {string} assetName
         * @param {number} progress  0–1
         */
        _updateProgress(assetName, progress) {
            const item = this._items.get(assetName);
            if (!item) return;
            item.barFill.style.width = `${Math.round(progress * 100)}%`;
        }

        /**
         * Marks an item as complete: fills bar, swaps badge, lingers, then removes.
         * @param {string} assetName
         * @param {string} source
         * @param {number} size
         * @param {number} duration  milliseconds
         */
        _completeItem(assetName, source, size, duration) {
            const item = this._items.get(assetName);
            if (!item) return;

            // Fill bar
            item.barFill.style.width = '100%';

            // Swap badge to checkmark
            item.badge.className = 'source-badge done';
            item.badge.textContent = '✓ DONE';

            // Update meta with speed
            if (size > 0 && duration > 0) {
                const bps = (size / (duration / 1000));
                item.meta.textContent = `${formatBytes(size)} · ${formatBytes(bps)}/s`;
            } else if (size > 0) {
                item.meta.textContent = formatBytes(size);
            }

            // Linger then fade out
            setTimeout(() => {
                item.el.classList.add('completing');
                setTimeout(() => {
                    item.el.remove();
                    this._items.delete(assetName);
                    this._refreshCount();
                }, 450); // match animation duration
            }, LINGER_MS);
        }

        _refreshCount() {
            const n = this._items.size;
            this._countEl.textContent = n > 0 ? `${n} active` : '';
        }

        destroy() {
            // Nothing to clean up (event listeners are on window)
        }
    }

    // ── Export ────────────────────────────────────────────────────────────────
    window.TransferFeed = TransferFeed;
})();
