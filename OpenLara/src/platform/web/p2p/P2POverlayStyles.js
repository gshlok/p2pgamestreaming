/**
 * P2POverlayStyles — All CSS for the cinematic P2P HUD
 */
function injectP2PStyles() {
    const style = document.createElement('style');
    style.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Inter:wght@400;500;600;700&display=swap');

        #p2p-overlay {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            pointer-events: none; z-index: 10000;
            font-family: 'Inter', system-ui, sans-serif; color: #e0e0e0;
        }
        #p2p-overlay * { box-sizing: border-box; }

        .p2p-panel {
            pointer-events: auto;
            background: rgba(10, 10, 20, 0.7);
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            border: 1px solid rgba(255, 255, 255, 0.06);
            border-radius: 14px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.04);
        }

        /* ==================== NARRATOR BAR ==================== */
        #p2p-narrator {
            position: fixed; top: 0; left: 0; right: 0;
            height: 42px; z-index: 10001;
            display: flex; align-items: center; justify-content: center;
            background: linear-gradient(180deg, rgba(10,10,20,0.85) 0%, rgba(10,10,20,0) 100%);
            pointer-events: none;
        }
        #p2p-narrator-text {
            font-size: 13px; font-weight: 500; letter-spacing: 0.5px;
            color: #00e5ff; opacity: 0.9;
            transition: color 0.6s ease, opacity 0.4s ease, text-shadow 0.6s ease;
            text-shadow: 0 0 20px rgba(0,229,255,0.3);
            white-space: nowrap;
        }
        #p2p-narrator-text.narrator-green {
            color: #00e676; text-shadow: 0 0 20px rgba(0,230,118,0.4);
        }
        #p2p-narrator-text.narrator-orange {
            color: #ff9100; text-shadow: 0 0 20px rgba(255,145,0,0.4);
        }
        #p2p-narrator-text.narrator-red {
            color: #ff1744; text-shadow: 0 0 30px rgba(255,23,68,0.6);
            font-weight: 700; letter-spacing: 2px; text-transform: uppercase;
        }
        #p2p-narrator-text.narrator-cyan {
            color: #00e5ff; text-shadow: 0 0 20px rgba(0,229,255,0.4);
        }

        /* ==================== TOPOLOGY CANVAS ==================== */
        #p2p-topology {
            position: fixed; top: 50px; left: 16px;
            width: 280px; height: 220px;
            padding: 0; overflow: hidden; border-radius: 14px;
        }
        #p2p-topo-canvas {
            width: 100%; height: 100%; display: block;
        }

        /* ==================== HERO STATS ==================== */
        #p2p-hero {
            position: fixed; bottom: 20px; left: 16px;
            padding: 18px 22px; min-width: 260px;
        }
        .hero-row {
            display: flex; align-items: baseline; gap: 10px;
            margin-bottom: 10px;
        }
        .hero-row:last-child { margin-bottom: 0; }
        .hero-icon { font-size: 16px; flex-shrink: 0; }
        .hero-value {
            font-family: 'JetBrains Mono', monospace;
            font-size: 28px; font-weight: 700; line-height: 1;
            transition: all 0.4s cubic-bezier(0.4,0,0.2,1);
        }
        .hero-value.val-cyan { color: #00e5ff; text-shadow: 0 0 16px rgba(0,229,255,0.35); }
        .hero-value.val-green { color: #00e676; text-shadow: 0 0 16px rgba(0,230,118,0.35); }
        .hero-label {
            font-size: 9px; font-weight: 700;
            text-transform: uppercase; letter-spacing: 1.5px;
            color: rgba(255,255,255,0.35); margin-top: 2px;
        }
        .hero-bar-wrap {
            height: 6px; background: rgba(255,255,255,0.06);
            border-radius: 3px; overflow: hidden; display: flex;
            margin-top: 12px;
        }
        .hero-bar-p2p {
            height: 100%; border-radius: 3px 0 0 3px;
            background: linear-gradient(90deg, #00b8d4, #00e5ff);
            box-shadow: 0 0 10px rgba(0,229,255,0.3);
            transition: width 0.8s cubic-bezier(0.4,0,0.2,1);
        }
        .hero-bar-origin {
            height: 100%; border-radius: 0 3px 3px 0;
            background: linear-gradient(90deg, #e65100, #ff9100);
            transition: width 0.8s cubic-bezier(0.4,0,0.2,1);
        }
        .hero-bar-legend {
            display: flex; justify-content: space-between;
            font-size: 9px; color: rgba(255,255,255,0.3);
            margin-top: 6px; letter-spacing: 0.5px;
        }
        .hero-bar-legend .leg-cyan { color: rgba(0,229,255,0.7); }
        .hero-bar-legend .leg-orange { color: rgba(255,145,0,0.7); }

        /* ==================== TRANSFER FEED ==================== */
        #p2p-feed {
            position: fixed; top: 50px; right: 16px;
            width: 320px; max-height: 400px;
            padding: 14px; overflow: hidden;
        }
        .feed-title {
            font-size: 9px; font-weight: 700; text-transform: uppercase;
            letter-spacing: 1.5px; color: rgba(255,255,255,0.3);
            margin-bottom: 10px;
        }
        .feed-list {
            display: flex; flex-direction: column; gap: 6px;
            max-height: 340px; overflow-y: auto;
        }
        .feed-list::-webkit-scrollbar { width: 2px; }
        .feed-list::-webkit-scrollbar-track { background: transparent; }
        .feed-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }

        .feed-card {
            padding: 10px 12px; border-radius: 8px;
            border-left: 3px solid; font-size: 11px;
            animation: feedSlideIn 0.5s cubic-bezier(0.34, 1.56, 0.64, 1);
            transition: opacity 0.5s ease;
        }
        .feed-card.src-peer {
            border-left-color: #00e5ff;
            background: rgba(0,229,255,0.06);
        }
        .feed-card.src-origin {
            border-left-color: #ff9100;
            background: rgba(255,145,0,0.04);
        }
        .feed-card.src-cache {
            border-left-color: #00e676;
            background: rgba(0,230,118,0.04);
        }
        .feed-card-top {
            display: flex; align-items: center; justify-content: space-between;
            margin-bottom: 4px;
        }
        .feed-card-asset {
            font-family: 'Inter', sans-serif; font-weight: 600;
            color: rgba(255,255,255,0.85); font-size: 12px;
        }
        .feed-card-badge {
            font-size: 9px; font-weight: 700; padding: 2px 7px;
            border-radius: 4px; text-transform: uppercase; letter-spacing: 0.5px;
        }
        .feed-card-badge.badge-peer {
            background: rgba(0,229,255,0.15); color: #00e5ff;
        }
        .feed-card-badge.badge-origin {
            background: rgba(255,145,0,0.15); color: #ff9100;
        }
        .feed-card-badge.badge-cache {
            background: rgba(0,230,118,0.15); color: #00e676;
        }
        .feed-card-meta {
            display: flex; gap: 12px;
            font-family: 'JetBrains Mono', monospace;
            font-size: 10px; color: rgba(255,255,255,0.3);
        }

        @keyframes feedSlideIn {
            from { opacity: 0; transform: translateX(30px) scale(0.95); }
            to   { opacity: 1; transform: translateX(0) scale(1); }
        }

        /* ==================== SVG TRANSFER LINES ==================== */
        #p2p-svg-overlay {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            pointer-events: none; z-index: 9999;
        }
        .transfer-line {
            fill: none; stroke-width: 2; opacity: 0;
            animation: lineFlash 2s ease-out forwards;
        }
        .transfer-line.line-peer { stroke: #00e5ff; filter: drop-shadow(0 0 6px rgba(0,229,255,0.5)); }
        .transfer-line.line-origin { stroke: #ff9100; filter: drop-shadow(0 0 6px rgba(255,145,0,0.4)); }

        @keyframes lineFlash {
            0% { opacity: 0; stroke-dashoffset: 300; }
            15% { opacity: 0.8; }
            100% { opacity: 0; stroke-dashoffset: 0; }
        }

        /* ==================== ORIGIN OFFLINE FLASH ==================== */
        #p2p-flash-overlay {
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            pointer-events: none; z-index: 10003;
            background: rgba(255,23,68,0); transition: background 0.15s ease;
        }
        #p2p-flash-overlay.flash-active {
            background: rgba(255,23,68,0.2);
        }

        /* ==================== IDLE WAITING ==================== */
        .feed-empty {
            color: rgba(255,255,255,0.2); font-size: 11px;
            text-align: center; padding: 20px 10px;
            font-style: italic;
        }

        /* ==================== HIDDEN STATE ==================== */
        #p2p-overlay.p2p-hidden { opacity: 0; pointer-events: none; }

        /* ==================== REDUCED MOTION ==================== */
        @media (prefers-reduced-motion: reduce) {
            *, *::before, *::after {
                animation-duration: 0.01ms !important;
                transition-duration: 0.01ms !important;
            }
        }
    `;
    document.head.appendChild(style);
}

if (typeof window !== 'undefined') {
    window.injectP2PStyles = injectP2PStyles;
}
