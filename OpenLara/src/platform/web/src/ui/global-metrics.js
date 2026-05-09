import { Animations } from './animations.js';

/**
 * P2P Telemetry Strip
 * Peer count and sourcing distribution.
 */
export class GlobalMetrics {
  constructor(parent) {
    this.container = document.createElement('div');
    this.container.className = 'telemetry-strip ui-container';
    parent.appendChild(this.container);
    
    this.metrics = {
      peers: { label: 'PEERS ACTIVE', value: 0 },
      peerSource: { label: 'PEER SOURCED', value: 0, suffix: '%' },
      originSource: { label: 'ORIGIN SOURCED', value: 0, suffix: '%' }
    };

    this.elements = {};
    this.init();
  }

  init() {
    Object.entries(this.metrics).forEach(([key, data]) => {
      const pill = document.createElement('div');
      pill.className = 'metric-pill';
      
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = data.label;
      
      const value = document.createElement('span');
      value.className = 'metric-value';
      value.textContent = '0';
      
      pill.appendChild(label);
      pill.appendChild(value);
      this.container.appendChild(pill);
      
      this.elements[key] = value;
    });
  }

  update(data) {
    // Expected data: { peersCount, peerPercent, originPercent }
    if (data.peersCount !== undefined) {
      Animations.animateNumber(this.elements.peers, this.metrics.peers.value, data.peersCount, 500, v => Math.round(v).toString());
      this.metrics.peers.value = data.peersCount;
    }
    
    if (data.peerPercent !== undefined) {
      Animations.animateNumber(this.elements.peerSource, this.metrics.peerSource.value, data.peerPercent, 500, v => `${Math.round(v)}%`);
      this.metrics.peerSource.value = data.peerPercent;
    }

    if (data.originPercent !== undefined) {
      Animations.animateNumber(this.elements.originSource, this.metrics.originSource.value, data.originPercent, 500, v => `${Math.round(v)}%`);
      this.metrics.originSource.value = data.originPercent;
    }
  }

  setVisible(visible) {
    this.container.style.display = visible ? 'flex' : 'none';
  }
}
