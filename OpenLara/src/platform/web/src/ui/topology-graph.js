/**
 * Network Topology Graph
 * Minimalist, orbital, organic living system.
 */
export class TopologyGraph {
  constructor(parent) {
    this.container = document.createElement('div');
    this.container.className = 'topology-container ui-container';
    parent.appendChild(this.container);
    
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'topology-canvas';
    this.container.appendChild(this.canvas);
    
    this.ctx = this.canvas.getContext('2d');
    this.peers = []; // { id, angle, distance, status, targetDistance, currentDistance, drift }
    this.packets = []; // { from, to, progress, color }
    
    // Use ResizeObserver for reliable sizing
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.container);
    
    this.animate();
  }

  resize() {
    const rect = this.container.getBoundingClientRect();
    this.canvas.width = rect.width * window.devicePixelRatio;
    this.canvas.height = rect.height * window.devicePixelRatio;
    this.ctx.scale(window.devicePixelRatio, window.devicePixelRatio);
    this.width = rect.width;
    this.height = rect.height;
  }

  setPeers(peerList) {
    // Sync peers
    const newPeers = peerList.map(p => {
      const existing = this.peers.find(ep => ep.id === p.peerId);
      if (existing) {
        existing.status = p.status || 'idle';
        return existing;
      }
      return {
        id: p.peerId,
        angle: Math.random() * Math.PI * 2,
        distance: 60 + Math.random() * 30,
        status: p.status || 'idle',
        drift: Math.random() * 1000
      };
    });
    this.peers = newPeers;
  }

  sendPacket(fromId, toId, type = 'data') {
    this.packets.push({
      from: fromId,
      to: toId,
      progress: 0,
      color: type === 'data' ? '#10B981' : '#3B82F6'
    });
  }

  animate() {
    this.render();
    requestAnimationFrame(() => this.animate());
  }

  render() {
    const { ctx, width, height } = this;
    if (!width || !height) return;
    
    ctx.clearRect(0, 0, width, height);
    
    const centerX = width / 2;
    const centerY = height / 2;
    const time = Date.now() * 0.001;

    // Draw orbital rings
    ctx.beginPath();
    ctx.arc(centerX, centerY, 60, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(centerX, centerY, 90, 0, Math.PI * 2);
    ctx.stroke();

    // Draw "YOU" node
    ctx.save();
    ctx.translate(centerX, centerY);
    
    // Outer rotating ring
    ctx.rotate(time * 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, 10, 0, Math.PI * 1.5);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();

    // Core node
    ctx.beginPath();
    ctx.arc(centerX, centerY, 5, 0, Math.PI * 2);
    ctx.fillStyle = '#fff';
    ctx.shadowBlur = 10;
    ctx.shadowColor = '#fff';
    ctx.fill();
    ctx.shadowBlur = 0;

    // Draw Peers
    this.peers.forEach(peer => {
      // Oscillation
      const orbitTime = time * 0.2 + peer.drift;
      const x = centerX + Math.cos(peer.angle + Math.sin(orbitTime) * 0.1) * peer.distance;
      const y = centerY + Math.sin(peer.angle + Math.sin(orbitTime) * 0.1) * peer.distance;
      
      peer.x = x;
      peer.y = y;

      // Connection line
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(x, y);
      ctx.strokeStyle = 'rgba(255,255,255,0.05)';
      ctx.stroke();

      // Node
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fillStyle = peer.status === 'active' ? '#10B981' : '#3F3F46';
      if (peer.status === 'active') {
        ctx.shadowBlur = 8;
        ctx.shadowColor = '#10B981';
      }
      ctx.fill();
      ctx.shadowBlur = 0;
      
      // Label (minimal)
      ctx.font = '8px JetBrains Mono';
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(peer.id.slice(-4).toUpperCase(), x + 8, y + 3);
    });

    // Draw Packets
    this.packets = this.packets.filter(p => {
      p.progress += 0.02;
      
      let fromX, fromY, toX, toY;
      
      if (p.from === 'me') {
        fromX = centerX; fromY = centerY;
        const target = this.peers.find(peer => peer.id === p.to);
        if (!target) return false;
        toX = target.x; toY = target.y;
      } else {
        const source = this.peers.find(peer => peer.id === p.from);
        if (!source) return false;
        fromX = source.x; fromY = source.y;
        toX = centerX; toY = centerY;
      }

      const curX = fromX + (toX - fromX) * p.progress;
      const curY = fromY + (toY - fromY) * p.progress;

      ctx.beginPath();
      ctx.arc(curX, curY, 2, 0, Math.PI * 2);
      ctx.fillStyle = p.color;
      ctx.fill();

      return p.progress < 1;
    });
  }

  setVisible(visible) {
    this.container.style.display = visible ? 'flex' : 'none';
  }
}
