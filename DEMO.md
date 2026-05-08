# P2P Game Asset Streaming — Demo Guide

## Quick Start

```bash
# 1. Install dependencies (one time)
npm install

# 2. Start the server with origin throttling
npm run dev
# Or: node server.js --throttle

# 3. Open in browser
# http://localhost:3000
```

The `--throttle` flag adds 800ms artificial delay to origin asset requests,
making P2P transfers visibly faster in the demo.

---

## Demo Script

### Setup (Before Demo)

1. Start the server: `npm run dev`
2. Note the **Network** URL shown in the console (e.g., `http://192.168.1.100:3000`)
3. All clients should connect to this Network URL

### Act 1: Client A — The Pioneer

1. Open `http://<LAN_IP>:3000` in **Browser Tab/Machine A**
2. The OpenLara title screen loads — assets come from **origin** (throttled)
3. Watch the **P2P overlay** (top-right):
   - Peers Connected: **0**
   - Assets From Origin: **100%**
4. Play through the title screen to trigger level loading
5. Notice the **Live Transfers** feed showing assets loaded from origin with 🌐 icon

### Act 2: Client B — The Beneficiary

1. Open the **same URL** in a **second browser tab** or **another machine on LAN**
2. Watch the **P2P overlay** on both clients:
   - Peers Connected: **1** (on both sides)
3. When Client B loads the same level:
   - **⚡ P2P** transfers appear in the feed
   - The P2P bar fills with **cyan** (peer-sourced)
   - **Bandwidth Saved** counter increases
4. Compare loading times:
   - Origin: ~800ms+ per asset (throttled)
   - P2P: near-instant via WebRTC DataChannel

### Act 3: Origin Independence

1. Stop serving level files (Ctrl+C the server, then restart without asset directory)
2. Open a **third client**
3. Assets still load from Clients A and B via P2P!
4. The overlay shows **100% P2P** sourcing

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| **F2** | Toggle P2P overlay visibility |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Signaling Server                 │
│          (WebSocket on ws://host:3000/ws)        │
│                                                  │
│  • Peer registry & heartbeats                    │
│  • WebRTC offer/answer/ICE relay                 │
│  • Asset ownership broadcast                     │
│  • Artificial origin throttling (--throttle)     │
└──────────┬────────────────────┬──────────────────┘
           │                    │
      WebSocket            WebSocket
           │                    │
    ┌──────▼──────┐      ┌──────▼──────┐
    │  Client A   │      │  Client B   │
    │             │◄────►│             │
    │ P2PManager  │ WebRTC│ P2PManager  │
    │ AssetCache  │ Data  │ AssetCache  │
    │ P2POverlay  │Channel│ P2POverlay  │
    │             │      │             │
    │ OpenLara    │      │ OpenLara    │
    │ (WASM)      │      │ (WASM)      │
    └─────────────┘      └─────────────┘
```

**Asset Loading Flow:**
1. WASM engine requests asset via `fetch()`
2. `p2p-bootstrap.js` intercepts the fetch
3. Check local IndexedDB cache → if hit, return immediately
4. Query known peers for asset → if available, fetch via WebRTC DataChannel
5. Fallback to origin server (throttled in demo mode)
6. Cache locally + announce to peers

---

## Troubleshooting

- **No peers visible?** Both clients must connect to the same server URL (not localhost vs LAN IP)
- **WebRTC fails?** On some networks, even LAN WebRTC may be blocked. Try same-machine multi-tab first.
- **Assets not intercepted?** Check browser console for `[P2P-Intercept]` messages
- **Overlay hidden?** Press F2 to toggle
