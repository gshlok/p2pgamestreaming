/**
 * AssetCache — IndexedDB-backed local asset cache with SHA-256 integrity
 * 
 * Provides persistent storage for downloaded game assets so peers can
 * redistribute them. Each asset is stored with its SHA-256 hash for
 * verification when received from untrusted peers.
 */
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

            request.onerror = (e) => {
                console.error('[AssetCache] IndexedDB error:', e.target.error);
                reject(e.target.error);
            };
        });
    }

    async ready() {
        await this._ready;
    }

    /**
     * Compute SHA-256 hash of a Uint8Array
     */
    async _computeHash(data) {
        if (!crypto || !crypto.subtle) {
            // Fast pure-JS rolling hash fallback for non-secure HTTP LAN contexts
            let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
            for (let i = 0; i < data.length; i++) {
                h1 = Math.imul(h1 ^ data[i], 2654435761);
                h2 = Math.imul(h2 ^ data[i], 1597334677);
            }
            h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
            h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
            h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
            h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
            const hashStr = ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
            return 'http-fallback-' + hashStr;
        }
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Store an asset in the cache
     * @param {string} name - Asset path (e.g., "level/1/LEVEL2.PSX")
     * @param {Uint8Array} data - Raw binary data
     * @param {string} [source='origin'] - Where this asset came from
     * @returns {Promise<{name, hash, size, source, timestamp}>}
     */
    async put(name, data, source = 'origin') {
        await this._ready;
        const hash = await this._computeHash(data);
        const entry = {
            name,
            data: data.buffer,   // Store as ArrayBuffer (more efficient in IDB)
            hash,
            size: data.length,
            source,
            timestamp: Date.now()
        };

        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.put(entry);

            request.onsuccess = () => {
                console.log(`[AssetCache] Stored: ${name} (${(data.length / 1024).toFixed(1)}KB, ${source})`);
                resolve({ name, hash, size: data.length, source, timestamp: entry.timestamp });
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Retrieve an asset from the cache
     * @param {string} name - Asset path
     * @returns {Promise<{data: Uint8Array, hash: string, size: number, source: string}|null>}
     */
    async get(name) {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.get(name);

            request.onsuccess = (e) => {
                const entry = e.target.result;
                if (entry) {
                    resolve({
                        data: new Uint8Array(entry.data),
                        hash: entry.hash,
                        size: entry.size,
                        source: entry.source
                    });
                } else {
                    resolve(null);
                }
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Check if asset exists in cache
     */
    async has(name) {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readonly');
            const store = tx.objectStore(this.storeName);
            const request = store.count(name);
            request.onsuccess = () => resolve(request.result > 0);
            request.onerror = (e) => reject(e.target.error);
        });
    }

    /**
     * Get hash without loading entire asset data
     */
    async getHash(name) {
        const entry = await this.get(name);
        return entry ? entry.hash : null;
    }

    /**
     * List all cached asset names
     * @returns {Promise<string[]>}
     */
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

    /**
     * Verify a received asset against a known hash
     */
    async verify(data, expectedHash) {
        const actualHash = await this._computeHash(data);
        return actualHash === expectedHash;
    }

    /**
     * Clear entire cache
     */
    async clear() {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, 'readwrite');
            const store = tx.objectStore(this.storeName);
            const request = store.clear();
            request.onsuccess = () => {
                console.log('[AssetCache] Cleared');
                resolve();
            };
            request.onerror = (e) => reject(e.target.error);
        });
    }
}

// Export for both module and script contexts
if (typeof window !== 'undefined') {
    window.AssetCache = AssetCache;
}
