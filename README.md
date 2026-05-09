# P2P Game Asset Streaming
THIS IS A GROUP PROJECT FOR NMIT HACKS
A decentralized, peer-assisted asset streaming layer for game runtimes. This project demonstrates how nearby peers (on the same LAN or network) can share cached game assets (textures, geometry, audio) with each other dynamically at runtime, reducing server dependency and improving load times.

## 🚀 Overview

This is a hackathon project built on top of **OpenLara** (an open-source engine for classic Tomb Raider).

- **No Cloud Gaming**: The game runs locally.
- **No Gameplay Sync**: This is not multiplayer netcode.
- **Pure Asset Distribution**: Only the binary data for rooms, textures, and assets are shared via WebRTC.

## 🛠 Tech Stack

- **Engine**: OpenLara (WASM/WebGL)
- **Signaling Server**: Node.js + Express + WebSockets
- **P2P Layer**: WebRTC DataChannels
- **Local Storage**: IndexedDB (Asset Persistence)
- **Architecture**: Zero-engine-modification. We intercept asset loading at the browser `fetch` level.

## 📦 Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)
- A modern web browser (Chrome, Firefox, Edge)

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/gshlok/p2pgamestreaming.git
   cd p2pgamestreaming
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

### Running the Demo

1. Start the signaling server with artificial network throttling (to make the P2P speed difference visible):
   ```bash
   npm run dev
   ```

2. Open the application in your browser:
   `http://localhost:3000`

3. **To test P2P logic on one machine**:
   - Open Tab A: `http://localhost:3000`. Load a level (e.g., "01 - Caves"). This will download from the origin server (slow due to throttle).
   - Open Tab B: `http://localhost:3000`. Load the SAME level. You will see it load **instantly** from Tab A via WebRTC!

## 🔍 How it Works

1. **Bootstrap**: A small `p2p-bootstrap.js` script runs before the game starts and wraps `window.fetch`.
2. **Interception**: When the game requests an asset, our wrapper intercepts it and asks the `P2PManager`.
3. **Peer Search**: The `P2PManager` checks the signaling server to find other connected peers who already have the asset cached.
4. **WebRTC Transfer**: If a peer is found, a direct WebRTC DataChannel connection is opened, and the binary data is streamed peer-to-peer.
5. **Fallback**: If no peer is available, the asset is downloaded from the origin server and cached locally for future redistribution.

## 🛡 Security & Integrity

All assets are verified using SHA-256 hashes. When a peer receives data, it re-computes the hash and verifies it against the known signature from the origin to prevent malicious asset injection.

## 📝 Requirements

This project uses **Node.js**. Even though some developers might look for a `requirements.txt`, all dependencies are managed via `package.json`.

---
*Built for the Decentralized Game Assets Hackathon.*
