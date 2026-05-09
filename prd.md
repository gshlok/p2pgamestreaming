# Product Requirements Document (PRD): P2P Game Asset Streaming

## 1. Project Overview
**P2P Game Asset Streaming** is a decentralized, peer-assisted asset distribution layer designed for web-based game runtimes. It allows players on the same network or across the internet to share game assets (textures, geometry, audio, levels) directly with one another, reducing the reliance on a central origin server and minimizing bandwidth costs.

### 1.1 Vision
To enable "Zero Infrastructure" game distribution where the community's collective cache serves as the primary content delivery network (CDN).

---

## 2. Problem Statement
1. **Bandwidth Costs**: High-fidelity web games (e.g., WASM/WebGL) require hundreds of megabytes of assets. Serving these from a central server is expensive.
2. **Latency**: Loading assets from a distant CDN can be slow, especially for large level files.
3. **Scalability**: Sudden spikes in player counts can overwhelm origin servers.

---

## 3. Goals & Objectives
- **Reduce Origin Load**: Aim to serve >50% of asset data from peers in a multi-user environment.
- **Zero Engine Modification**: Work with existing game engines (like OpenLara) by intercepting network requests at the browser level.
- **Integrity**: Ensure assets shared by peers are bit-identical to the origin files.
- **Resilience**: Seamlessly fallback to the origin server if no peers are available or if a peer disconnects.

---

## 4. Functional Requirements

### 4.1 Asset Interception (The "Bootstrap")
- Must wrap `window.fetch` before the game engine initializes.
- Must identify asset requests based on file extensions or URL patterns.
- Must coordinate with the `P2PManager` to fulfill requests.

### 4.2 Peer-to-Peer Networking
- **Discovery**: A signaling server must track which peers have which assets.
- **Signaling**: Use WebSockets to exchange WebRTC offers/answers and ICE candidates.
- **Transport**:
    - **Primary**: WebRTC DataChannels for low-latency, direct peer-to-peer binary transfer.
    - **Fallback Relay**: If WebRTC fails (e.g., strict NAT), assets should be relayable via the WebSocket signaling server (Base64 encoded).

### 4.3 Asset Management & Caching
- **Persistence**: Use **IndexedDB** to store assets across browser sessions.
- **Inventory**: Peers must report their current cache "inventory" to the signaling server upon connection and when new assets are added.
- **Verification**: Use **SHA-256** hashing to verify the integrity of peer-sourced data.

### 4.4 User Interface (Overlay)
- Provide a real-time visualization of P2P activity.
- Show metrics: Peers connected, % from P2P vs Origin, Bandwidth saved.
- Toggle visibility with a hotkey (F2).

---

## 5. Technical Architecture

### 5.1 Components
| Component | Description |
|-----------|-------------|
| **Bootstrap (`p2p-bootstrap.js`)** | The entry point that hooks into the browser environment. |
| **P2PManager (`P2PManager.js`)** | The core logic for peer discovery, signaling, and fetch coordination. |
| **AssetCache (`AssetCache.js`)** | Wrapper around IndexedDB for storing and retrieving binary blobs. |
| **Signaling Server (`server.js`)** | Node.js/Express server for peer matching and WebRTC relay. |

### 5.2 The "Fetch" Lifecycle
1. Game Engine calls `fetch('/levels/caves.PSX')`.
2. Interceptor checks **AssetCache**.
3. If not in cache, Interceptor asks **P2PManager**.
4. P2PManager checks if any known **Peers** have the asset.
5. If yes, request via **WebRTC** (or WS Relay fallback).
6. If no peers or transfer fails, download from **Origin**.
7. Store in **AssetCache** and announce "I have this asset" to the network.

---

## 6. Performance Requirements
- **Overhead**: Interception logic should add <10ms of latency to cache hits.
- **Scalability**: Signaling server should handle at least 100 concurrent peers (hackathon scope).
- **Integrity Check**: SHA-256 verification must not bottleneck the game loop (run in background/Promise).

---

## 7. Future Considerations
- **Delta Patching**: Only share differences between asset versions.
- **Peer Prioritization**: Prioritize peers on the same local subnet (LAN) for maximum speed.
- **Browser Service Workers**: Move interception logic to a Service Worker for even cleaner integration.
