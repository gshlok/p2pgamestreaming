/**
 * Torrent Game Streaming — Service Worker Virtual File System (VFS)
 * 
 * Intercepts asset requests made by sandboxed iframe games and serves them 
 * directly from reassembled cryptographic torrent chunks stored in IndexedDB.
 * 
 * Scope: Matches /vfs/
 */

const DB_NAME = 'torrent-vfs-store';
const STORE_NAME = 'files';

self.addEventListener('install', (event) => {
    console.log('[VFS-SW] Installing Virtual File System Service Worker...');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[VFS-SW] VFS Service Worker active and claiming clients.');
    event.waitUntil(self.clients.claim());
});

// Helper to determine Content-Type based on file extension
function getContentType(path) {
    const ext = path.split('.').pop().toLowerCase();
    const mimeTypes = {
        'html': 'text/html; charset=utf-8',
        'htm': 'text/html; charset=utf-8',
        'css': 'text/css; charset=utf-8',
        'js': 'application/javascript; charset=utf-8',
        'json': 'application/json; charset=utf-8',
        'png': 'image/png',
        'jpg': 'image/jpeg',
        'jpeg': 'image/jpeg',
        'gif': 'image/gif',
        'svg': 'image/svg+xml',
        'ico': 'image/x-icon',
        'wasm': 'application/wasm',
        'ogg': 'audio/ogg',
        'mp3': 'audio/mpeg',
        'wav': 'audio/wav',
        'mp4': 'video/mp4',
        'woff': 'font/woff',
        'woff2': 'font/woff2',
        'ttf': 'font/ttf',
        'otf': 'font/otf',
        'xml': 'application/xml; charset=utf-8',
        'pdf': 'application/pdf',
        'txt': 'text/plain; charset=utf-8'
    };
    return mimeTypes[ext] || 'application/octet-stream';
}

// Open IndexedDB connection
function getVFSFile(infoHash, filePath) {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            }
        };

        request.onsuccess = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                db.close();
                resolve(null);
                return;
            }

            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const key = `${infoHash}:${filePath}`;
            const getReq = store.get(key);

            getReq.onsuccess = () => {
                db.close();
                resolve(getReq.result);
            };

            getReq.onerror = () => {
                db.close();
                reject(getReq.error);
            };
        };

        request.onerror = (e) => {
            reject(e.target.error);
        };
    });
}

self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Intercept only /vfs/ requests
    if (url.pathname.startsWith('/vfs/')) {
        const parts = url.pathname.substring(5).split('/');
        const infoHash = parts[0];
        const filePath = parts.slice(1).join('/');

        if (!infoHash || !filePath) return;

        console.log(`[VFS-SW] Intercepted: infoHash=${infoHash}, path=${filePath}`);

        event.respondWith(
            (async () => {
                try {
                    // Try getting the file from the database
                    const fileEntry = await getVFSFile(infoHash, filePath);

                    if (fileEntry && fileEntry.data) {
                        const contentType = getContentType(filePath);
                        console.log(`[VFS-SW] Serving ${filePath} (${fileEntry.data.byteLength} bytes) from DB as ${contentType}`);

                        // Notify pages of VFS access for real-time terminal output
                        self.clients.matchAll({ type: 'window' }).then(clients => {
                            for (const client of clients) {
                                client.postMessage({
                                    type: 'VFS_ACCESS',
                                    path: filePath
                                });
                            }
                        }).catch(() => {});

                        // Add CORS and isolation headers
                        const headers = new Headers({
                            'Content-Type': contentType,
                            'Content-Length': fileEntry.data.byteLength.toString(),
                            'Access-Control-Allow-Origin': '*',
                            'Cache-Control': 'no-store, no-cache, must-revalidate',
                            'Cross-Origin-Opener-Policy': 'same-origin',
                            'Cross-Origin-Embedder-Policy': 'require-corp'
                        });

                        return new Response(fileEntry.data, {
                            status: 200,
                            statusText: 'OK',
                            headers: headers
                        });
                    }

                    // For index requests, wait or fallback
                    if (filePath === '' || filePath === 'index.html') {
                        return new Response(`
                            <html>
                            <head>
                                <style>
                                    body {
                                        background: #05060c;
                                        color: #00f0ff;
                                        font-family: monospace;
                                        display: flex;
                                        flex-direction: column;
                                        align-items: center;
                                        justify-content: center;
                                        height: 100vh;
                                        margin: 0;
                                    }
                                    .spinner {
                                        width: 50px;
                                        height: 50px;
                                        border: 3px solid rgba(0, 240, 255, 0.1);
                                        border-top-color: #00f0ff;
                                        border-radius: 50%;
                                        animation: spin 1s linear infinite;
                                        margin-bottom: 20px;
                                    }
                                    @keyframes spin {
                                        to { transform: rotate(360deg); }
                                    }
                                </style>
                            </head>
                            <body>
                                <div class="spinner"></div>
                                <h2>Booting VFS Streamer...</h2>
                                <p>Reassembling torrent chunks for "${filePath}"</p>
                            </body>
                            </html>
                        `, {
                            headers: { 'Content-Type': 'text/html; charset=utf-8' }
                        });
                    }

                    console.warn(`[VFS-SW] File not found in cache: ${filePath}`);
                    return new Response(`VFS file "${filePath}" is not yet reassembled. Please check client download status.`, {
                        status: 404,
                        statusText: 'Not Found'
                    });

                } catch (err) {
                    console.error(`[VFS-SW] Error reading VFS for ${filePath}:`, err);
                    return new Response(`VFS internal error: ${err.message}`, {
                        status: 500,
                        statusText: 'Internal Server Error'
                    });
                }
            })()
        );
    }
});
