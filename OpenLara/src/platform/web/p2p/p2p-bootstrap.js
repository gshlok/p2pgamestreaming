/**
 * P2P Bootstrap — Dynamic interception of Emscripten's asset loading
 * 
 * This script loads BEFORE the WASM module and installs a dynamic wrapper
 * around `window.fetch` to intercept game asset requests and route them
 * through the P2P layer.
 * 
 * Key design: We save the ORIGINAL fetch reference and pass it to
 * P2PManager for origin fallback, preventing infinite recursion.
 * 
 * Flow:
 *   WASM → asyncLoad → readAsync → fetch() [INTERCEPTED]
 *        → P2PManager.fetchAsset()
 *            → cache hit? return
 *            → peer has it? WebRTC transfer
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
        peerTimeout: 2500,
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
    let interceptInstalled = false;

    // Re-entrancy guard: tracks URLs currently being fetched by P2P origin
    // fallback so the wrapper lets them pass through to real fetch.
    const _originFetchesInFlight = new Set();

    // Fetch-level dedup: the game engine's render loop can fire hundreds of
    // fetch() calls for the same asset before the first one resolves. This
    // map ensures all concurrent calls for the same URL share one promise.
    const _interceptInflight = new Map();

    // -----------------------------------------------------------------------
    // Install the intercept
    // -----------------------------------------------------------------------

    function installIntercept() {
        if (interceptInstalled) return;

        window.fetch = function(input, init) {
            const url = typeof input === 'string'
                ? input
                : (input instanceof Request ? input.url : String(input));

            // CRITICAL: If this is an origin-fallback fetch from P2PManager,
            // let it pass through to the real fetch without re-intercepting.
            if (_originFetchesInFlight.has(url)) {
                return _originalFetch(input, init);
            }

            // Only intercept game asset fetches
            if (p2pManager && p2pManager.isConnected() && isGameAsset(url) && !isExcluded(url)) {
                // DEDUP at fetch level: if this URL is already in-flight,
                // clone the response from the existing promise
                if (_interceptInflight.has(url)) {
                    return _interceptInflight.get(url).then(resp => resp.clone());
                }

                const promise = (async () => {
                    try {
                        console.log(`[P2P-Intercept] Intercepting: ${url}`);
                        const result = await p2pManager.fetchAsset(url);

                        if (result && result.data) {
                            console.log(`[P2P-Intercept] ✓ ${url} from ${result.source}${result.peerId ? ' (' + result.peerId + ')' : ''} — ${(result.data.length / 1024).toFixed(1)}KB`);

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

                    // Fallback to real fetch
                    return _originalFetch(input, init);
                })();

                _interceptInflight.set(url, promise);
                promise.finally(() => _interceptInflight.delete(url));

                return promise;
            }

            // Default: pass through to real fetch
            return _originalFetch(input, init);
        };

        interceptInstalled = true;
        console.log('[P2P-Intercept] Asset loading intercept installed (fetch wrapper)');
    }

    /**
     * Determine if a URL is a game asset worth intercepting
     */
    function isGameAsset(url) {
        let path = url;

        // Handle absolute URLs — only intercept same-origin
        if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('//')) {
            try {
                const parsed = new URL(path, location.origin);
                if (parsed.origin !== location.origin) return false;
                path = parsed.pathname.replace(/^\//, '');
            } catch {
                return false;
            }
        }

        // Strip leading slash
        path = path.replace(/^\//, '');

        // Game asset patterns
        const assetPatterns = [
            /^level\//i,
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
    // Initialization
    // -----------------------------------------------------------------------

    async function init() {
        console.log('[P2P] Initializing peer-assisted asset streaming...');

        // Wait for dependencies
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

        // Install fetch intercept
        installIntercept();

        // Create overlay
        p2pOverlay = new P2POverlay(p2pManager);
        window.p2pOverlay = p2pOverlay;

        // Connect to signaling server
        if (CONFIG.autoConnect) {
            try {
                await p2pManager.connect();
                console.log(`[P2P] ✓ Connected as ${p2pManager.peerId}`);
            } catch (e) {
                console.warn('[P2P] Failed to connect to signaling server:', e.message);
                console.warn('[P2P] Running in origin-only mode (overlay still active)');
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
        setTimeout(init, 100);
    }

})();
