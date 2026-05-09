# 🌐 P2P Game Asset Streaming

[![NMIT Hacks](https://img.shields.io/badge/Project-NMIT%20Hacks-blueviolet)](https://github.com/gshlok/p2pgamestreaming)
[![Tech Stack](https://img.shields.io/badge/Stack-WebRTC%20%7C%20WS%20%7C%20IndexedDB-blue)](https://nodejs.org/)

A decentralized, peer-assisted asset distribution layer for game runtimes. This project allows nearby peers (on the same LAN or network) to share cached game assets (textures, geometry, audio) dynamically at runtime, significantly reducing server dependency and improving load times.

---

## 🚀 Quick Start

### 1. Prerequisites
- [Node.js](https://nodejs.org/) (v18+)
- A modern web browser (Chrome, Firefox, Edge)

### 2. Installation
```bash
git clone https://github.com/gshlok/p2pgamestreaming.git
cd p2pgamestreaming
npm install
```

### 3. Running the Demo
Start the signaling server with artificial network throttling (to make the P2P speed difference visible):
```bash
npm run dev
```
Open the application at: `http://localhost:3000`

---

## 🔍 How It Works

This project intercepts asset loading at the browser `fetch` level, meaning **zero modifications** are required to the underlying game engine (OpenLara).

1.  **Interception**: `p2p-bootstrap.js` wraps `window.fetch`.
2.  **Local Cache**: First check IndexedDB (via `AssetCache.js`).
3.  **Peer Search**: Query the signaling server for peers who have the asset.
4.  **P2P Transfer**: Stream binary data via **WebRTC DataChannels**.
5.  **Relay Fallback**: If WebRTC fails, relay through the WebSocket server.
6.  **Origin Fallback**: Download from the server as a last resort.
7.  **Redistribution**: Once downloaded, the peer caches the asset and announces it to others.

---

## 🛠 Tech Stack

-   **Engine**: [OpenLara](https://github.com/XProger/OpenLara) (WASM/WebGL)
-   **Signaling**: Node.js + WebSockets
-   **Transport**: WebRTC DataChannels (Primary), WS Relay (Secondary)
-   **Storage**: IndexedDB (Persistence)
-   **Verification**: SHA-256 integrity hashes

---

## 🤖 LLM Context Awareness

This section provides critical pointers for AI assistants working on this codebase.

### Core Architecture
-   **`server.js`**: The signaling server. It manages the peer registry, asset ownership broadcast, and WebRTC handshakes. It also serves static files with an optional `--throttle` flag.
-   **`OpenLara/src/platform/web/p2p/P2PManager.js`**: The main client-side orchestrator. Handles connections, peer lists, and the state of in-flight transfers.
-   **`OpenLara/src/platform/web/p2p/AssetCache.js`**: Managed IndexedDB storage. Keys are normalized asset paths.
-   **`OpenLara/src/platform/web/p2p-bootstrap.js`**: The entry point script that injects the P2P layer into the browser.

### Important Implementation Details
-   **Normalization**: All asset paths are normalized (e.g., `level/1/LEVEL2.PSX`) to ensure consistent cache hits across peers.
-   **Eager Connection**: The client attempts to pre-establish WebRTC DataChannels with peers as soon as they join to minimize retrieval latency.
-   **Binary Handling**: Assets are transferred as `ArrayBuffer` or `Uint8Array`. For WS relay, they are Base64 encoded.
-   **Cross-Origin Isolation**: `server.js` sends COOP/COEP headers required for `SharedArrayBuffer` and modern WASM threading.

---

## 📊 Metrics & Overlay
Press **F2** to toggle the P2P Overlay, which shows:
-   Active Peer connections
-   Bandwidth saved from P2P sourcing
-   Real-time transfer logs (🌐 for Origin, ⚡ for P2P)

---

## 📝 License
Built for the **Decentralized Game Assets Hackathon**. Open-source under the MIT License.
