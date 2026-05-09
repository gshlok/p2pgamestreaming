/**
 * P2P Bootstrap — Dynamic interception of Emscripten's asset loading
 * 
 * This script loads BEFORE the WASM module and installs a dynamic wrapper
 * around `window.fetch` to intercept game asset requests and route them
 * through the P2P layer.
 * 
 * CRITICAL DESIGN: The fetch wrapper is installed SYNCHRONOUSLY at script
 * load time — BEFORE any async operations — so it captures every fetch
 * the WASM engine makes. The wrapper gracefully handles the case where
 * P2PManager hasn't been created or connected yet by caching locally
 * and announcing when the connection is ready.
 * 
 * Flow:
 *   WASM → asyncLoad → readAsync → fetch() [INTERCEPTED]
 *        → P2PManager.fetchAsset()
 *            → cache hit? return
 *            → peer has it? WebRTC transfer or WS relay
 *            → fallback: _originalFetch() [BYPASSES wrapper]
 */

(function() {
    'use strict';

    // -----------------------------------------------------------------------
    // Save the REAL fetch IMMEDIATELY, before anything else runs
    // -----------------------------------------------------------------------
    const _originalFetch = window.fetch.bind(window);

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    const CONFIG = {
        peerTimeout: 5000,
        autoConnect: true,
        showOverlay: true,
        toggleKey: 'F2',

        // Assets that should NEVER go through P2P (critical startup files)
        excludeFromP2P: [
            'OpenLara_wasm.data',
            'OpenLara_wasm.wasm',
            'OpenLara.wasm',
            'OpenLara_wasm.js',
            'OpenLara.js',
        ]
    };

    // -----------------------------------------------------------------------
    // Global state
    // -----------------------------------------------------------------------

    let p2pManager = null;
    let p2pOverlay = null;

    // Re-entrancy guard: tracks URLs currently being fetched by P2P origin
    // fallback so the wrapper lets them pass through to real fetch.
    const _originFetchesInFlight = new Set();

    // Fetch-level dedup: the game engine's render loop can fire hundreds of
    // fetch() calls for the same asset before the first one resolves. This
    // map ensures all concurrent calls for the same URL share one promise.
    const _interceptInflight = new Map();

    // -----------------------------------------------------------------------
    // URL utilities
    // -----------------------------------------------------------------------

    /**
     * Normalize a URL to a consistent relative path (no leading slash, no origin prefix).
     * This ensures cache keys match between peers regardless of how the URL was originally formatted.
     */
    function normalizeAssetUrl(url) {
        let path = url;

        // Strip origin prefix from absolute URLs
        if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) {
            try {
                const parsed = new URL(path, location.origin);
                path = parsed.pathname;
            } catch {
                // fall through
            }
        }

        // Strip leading slash for consistent keys
        path = path.replace(/^\//, '');
        return path;
    }

    /**
     * Determine if a URL is a game asset worth intercepting
     */
    function isGameAsset(url) {
        const path = normalizeAssetUrl(url);

        // Handle absolute URLs — only intercept same-origin
        if (url.startsWith('http://') || url.startsWith('https://') || url.startsWith('//')) {
            try {
                const parsed = new URL(url, location.origin);
                if (parsed.origin !== location.origin) return false;
            } catch {
                return false;
            }
        }

        // Game asset patterns
        const assetPatterns = [
            /^level\//i,
            /^levels\//i,     // PHD files use /levels/ path
            /^audio\//i,
            /\.PSX$/i,
            /\.PHD$/i,
            /\.TR2$/i,
            /\.TR4$/i,
            /\.SFX$/i,
            /\.ogg$/i,
            /\.mp3$/i,
            /\.wav$/i,
            /\.PNG$/i,
            /\.RAW$/i,
            /\.BMP$/i,
            /\.PCX$/i,
            /\.FMV$/i,
            /\.RPL$/i,
        ];

        return assetPatterns.some(p => p.test(path));
    }

    function isExcluded(url) {
        return CONFIG.excludeFromP2P.some(exc => url.includes(exc));
    }

    // -----------------------------------------------------------------------
    // Install the intercept SYNCHRONOUSLY — this is the KEY fix
    // -----------------------------------------------------------------------
    // We install the wrapper IMMEDIATELY at script load time, not inside an
    // async init() function. This guarantees we capture EVERY fetch call the
    // WASM engine makes, even before P2PManager connects or even exists.

    window.fetch = function(input, init) {
        const url = typeof input === 'string'
            ? input
            : (input instanceof Request ? input.url : String(input));

        // CRITICAL: If this is an origin-fallback fetch from P2PManager,
        // let it pass through to the real fetch without re-intercepting.
        if (_originFetchesInFlight.has(url)) {
            return _originalFetch(input, init);
        }

        // Only intercept game asset fetches (but DON'T require isConnected —
        // we want to cache even before the WS connection is up)
        if (p2pManager && isGameAsset(url) && !isExcluded(url)) {
            // Normalize URL to a consistent relative path for cache key consistency
            const normalizedUrl = normalizeAssetUrl(url);

            // DEDUP at fetch level: if this URL is already in-flight,
            // clone the response from the existing promise
            if (_interceptInflight.has(normalizedUrl)) {
                return _interceptInflight.get(normalizedUrl).then(resp => resp.clone());
            }

            const promise = (async () => {
                try {
                    console.log(`[P2P-Intercept] Intercepting: ${url} → ${normalizedUrl}`);
                    const result = await p2pManager.fetchAsset(normalizedUrl);

                    if (result && result.data) {
                        console.log(`[P2P-Intercept] ✓ ${normalizedUrl} from ${result.source}${result.peerId ? ' (' + result.peerId + ')' : ''} — ${(result.data.length / 1024).toFixed(1)}KB`);

                        // Create a synthetic Response from the P2P/cached data
                        return new Response(result.data.buffer.slice(0), {
                            status: 200,
                            statusText: 'OK',
                            headers: {
                                'Content-Length': result.data.length.toString(),
                                'Content-Type': 'application/octet-stream',
                                'X-P2P-Source': result.source,
                                'X-P2P-Peer': result.peerId || ''
                            }
                        });
                    }
                } catch (e) {
                    console.warn(`[P2P-Intercept] P2P failed for ${url}, passing to origin:`, e.message);
                }

                // Fallback to real fetch (only if fetchAsset returned null/undefined)
                return _originalFetch(input, init);
            })();

            _interceptInflight.set(normalizedUrl, promise);
            promise.finally(() => _interceptInflight.delete(normalizedUrl));

            return promise;
        }

        // Default: pass through to real fetch
        return _originalFetch(input, init);
    };

    console.log('[P2P-Intercept] ✓ Fetch wrapper installed SYNCHRONOUSLY (before WASM loads)');

    // -----------------------------------------------------------------------
    // Async Initialization (P2PManager, overlay, WS connection)
    // -----------------------------------------------------------------------

    async function init() {
        console.log('[P2P] Initializing peer-assisted asset streaming...');

        // Wait for dependencies (these scripts load synchronously before us,
        // so they should already be available — but waitFor handles edge cases)
        await waitFor(() =>
            typeof AssetCache !== 'undefined' &&
            typeof P2PManager !== 'undefined' &&
            typeof P2POverlay !== 'undefined'
        );

        // Create P2P manager — give it the ORIGINAL fetch so origin fallback
        // bypasses our wrapper entirely.
        p2pManager = new P2PManager({
            peerTimeout: CONFIG.peerTimeout,
            originalFetch: _originalFetch,
            originFetchesInFlight: _originFetchesInFlight
        });
        window.p2pManager = p2pManager;

        // NOTE: The fetch wrapper is ALREADY installed (synchronously above).
        // Now that p2pManager exists, the wrapper will start routing through it.
        // Any fetches that happened before this point went through _originalFetch.

        // Create overlay
        p2pOverlay = new P2POverlay(p2pManager);
        window.p2pOverlay = p2pOverlay;

        // Connect to signaling server
        if (CONFIG.autoConnect) {
            try {
                await p2pManager.connect();
                console.log(`[P2P] ✓ Connected as ${p2pManager.peerId} with ${p2pManager.localAssets.size} cached assets`);
            } catch (e) {
                console.warn('[P2P] Failed to connect to signaling server:', e.message);
                console.warn('[P2P] Running in origin-only mode (still caching locally)');
            }
        }

        // Toggle overlay with F2
        document.addEventListener('keydown', (e) => {
            if (e.key === CONFIG.toggleKey) {
                p2pOverlay.toggle();
            }
        });

        console.log('[P2P] ✓ Initialization complete — press F2 to toggle overlay');
    }

    function waitFor(condition, timeout = 10000) {
        return new Promise((resolve, reject) => {
            if (condition()) { resolve(); return; }
            const start = Date.now();
            const check = setInterval(() => {
                if (condition()) {
                    clearInterval(check);
                    resolve();
                } else if (Date.now() - start > timeout) {
                    clearInterval(check);
                    reject(new Error('P2P dependency load timeout'));
                }
            }, 50);
        });
    }

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        setTimeout(init, 0);  // Use 0ms, not 100ms — faster init
    }

})();
