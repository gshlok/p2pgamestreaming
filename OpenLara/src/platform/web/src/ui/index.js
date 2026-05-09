import { Layout } from './layout.js';
import { GlobalMetrics } from './global-metrics.js';
import { TransferFeed } from './transfer-feed.js';
import { TopologyGraph } from './topology-graph.js';
import { Controls } from './controls.js';
import { GameMetrics } from './game-metrics.js';
import { InfoPanel } from './info-panel.js';
import { LevelSelector } from './level-selector.js';

/**
 * Premium P2P Streaming UI Orchestrator
 */
export class StreamingUI {
  constructor(p2pManager) {
    this.p2p = p2pManager;
    
    // 1. Initialize Layout
    this.layout = new Layout('ui-root');
    
    // 2. Initialize Components
    this.initStatusPills();
    
    // Center: Level Selector
    this.levelSelector = new LevelSelector(this.layout.getArea('top-center'), (id) => {
      if (window.loadLevel) window.loadLevel(id);
    });

    // Left: Pills & Game Metrics
    this.gameMetrics = new GameMetrics(this.layout.getArea('top-left'));
    
    // Right: P2P Metrics & Info Panel
    this.p2pMetrics = new GlobalMetrics(this.layout.getArea('top-right'));
    this.infoPanel = new InfoPanel(this.layout.getArea('top-right'));
    
    // Bottom Areas
    this.feed = new TransferFeed(this.layout.getArea('bot-center'));
    this.topology = new TopologyGraph(this.layout.getArea('bot-right'));
    this.controls = new Controls(this.layout.getArea('bot-left'));
    
    // 3. Wire up P2P events
    this.setupBindings();
    
    // 4. Initial state
    if (this.p2p) {
      this.updateAllMetrics();
    }
    
    console.log('[UI] Streaming UI initialized');
  }

  initStatusPills() {
    const container = document.createElement('div');
    container.className = 'status-pills';
    
    const enginePill = this.createPill('Engine', 'active');
    const connPill = this.createPill('Signaling', 'idle');
    this.connDot = connPill.querySelector('.dot');
    this.connLabel = connPill.querySelector('span');
    
    container.appendChild(enginePill);
    container.appendChild(connPill);
    
    this.layout.getArea('top-left').appendChild(container);
  }

  createPill(text, state = 'idle') {
    const pill = document.createElement('div');
    pill.className = 'pill';
    
    const dot = document.createElement('div');
    dot.className = `dot ${state}`;
    
    const label = document.createElement('span');
    label.textContent = text;
    
    pill.appendChild(dot);
    pill.appendChild(label);
    return pill;
  }

  setupBindings() {
    if (!this.p2p) return;

    // Listen for Control toggles
    window.addEventListener('ui-control-change', (e) => {
      const { id, active } = e.detail;
      if (id === 'toggle-game') this.gameMetrics.setVisible(active);
      if (id === 'toggle-p2p') this.p2pMetrics.setVisible(active);
      if (id === 'toggle-info') this.infoPanel.setVisible(active);
      if (id === 'toggle-graph') this.topology.setVisible(active);
    });

    // Monitor connectivity
    setInterval(() => {
      const connected = this.p2p.isConnected();
      this.connDot.className = `dot ${connected ? 'active' : 'idle'}`;
      this.connLabel.textContent = connected ? 'Connected' : 'Standalone';
    }, 1000);

    // Monitor metrics
    this.p2p.onMetricsUpdate = (data) => {
      this.updateAllMetrics();
    };

    // Monitor peer list for topology
    this.p2p.onPeerListChanged = (peerSummary) => {
      this.topology.setPeers(peerSummary.map(p => ({
        peerId: p.peerId,
        status: p.hasChannel ? 'active' : 'idle'
      })));
    };

    // Monitor transfers
    this.p2p.onTransfer = (transfer) => {
      if (transfer.source === 'upload') {
        this.topology.sendPacket('me', transfer.peerId, 'upload');
      } else {
        this.feed.addTransfer(transfer.assetName, transfer.source, transfer.peerId);
        this.feed.updateProgress(transfer.assetName, 100);
        
        if (transfer.peerId) {
          this.topology.sendPacket(transfer.peerId, 'me', 'data');
        }
      }
    };
  }

  updateAllMetrics() {
    const data = this.p2p.getMetrics();
    
    // Top-right strip (Peers active, source distribution)
    this.p2pMetrics.update({
      peersCount: data.peersConnected,
      peerPercent: data.peerPercent,
      originPercent: data.originPercent
    });

    // Info panel (Deep dive)
    this.infoPanel.update({
      bytesSaved: data.bytesSaved,
      downRate: data.bytesFromPeers / 1024 / 1024, // Network load from peers
      bytesUploaded: data.bytesUploaded,
      localAssetCount: data.localAssetCount
    });
  }

  onGameLog(text) {
    if (this.gameMetrics) {
      this.gameMetrics.parseLog(text);
    }
  }

  setLevel(id) {
    if (this.levelSelector) this.levelSelector.setSelected(id);
  }
}
