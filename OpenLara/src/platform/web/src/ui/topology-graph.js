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
    this.peers = []; // { id, angle, distance, status, targetDistance, currentDistance, drift, color, glow }
    this.packets = []; // { from, to, progress, color }
    this.localPeerId = 'me';
    this.localGlow = 0; // 0 to 1
    
    // Use ResizeObserver for reliable sizing
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(this.container);
    
    this.animate();
  }

  setLocalPeerId(id) {
    this.localPeerId = id;
  }

  _getColor(id) {
    if (!id) return '#3F3F46';
    // Stable color from ID
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = id.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash % 360);
    return `hsl(${h}, 70%, 60%)`;
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
        drift: Math.random() * 1000,
        color: this._getColor(p.peerId),
        glow: 0
      };
    });
    this.peers = newPeers;
  }

  triggerNodeGlow(peerId) {
    if (peerId === 'me' || peerId === this.localPeerId) {
      this.localGlow = 1.0;
    } else {
      const p = this.peers.find(peer => peer.id === peerId);
      if (p) p.glow = 1.0;
    }
  }

  sendPacket(fromId, toId, type = 'data') {
    let color = type === 'data' ? '#10B981' : '#3B82F6';
    
    // Origin packets use orange color and animate from the origin node
    if (fromId === 'origin') {
      color = '#FB923C';
    }

    if (fromId !== 'me' && fromId !== this.localPeerId && fromId !== 'origin') {
      const p = this.peers.find(p => p.id === fromId);
      if (p) color = p.color;
    } else if (toId !== 'me' && toId !== this.localPeerId) {
      const p = this.peers.find(p => p.id === toId);
      if (p) color = p.color;
    }
    
    this.packets.push({
      from: fromId,
      to: toId,
      progress: 0,
      color: color
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

    // Draw "Origin Server" node (fixed top-right)
    const originX = width - 20;
    const originY = 20;
    this.originX = originX;
    this.originY = originY;
    ctx.beginPath();
    ctx.arc(originX, originY, 4, 0, Math.PI * 2);
    ctx.fillStyle = '#FB923C';
    ctx.shadowBlur = 8;
    ctx.shadowColor = '#FB923C';
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.font = '8px JetBrains Mono';
    ctx.fillStyle = 'rgba(251,146,60,0.7)';
    ctx.textAlign = 'right';
    ctx.fillText('ORIGIN', originX - 8, originY + 3);
    ctx.textAlign = 'left';

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
    
    if (this.localGlow > 0) {
      ctx.fillStyle = `rgba(251, 146, 60, ${this.localGlow})`; // Orange-400
      ctx.shadowBlur = 15 * this.localGlow;
      ctx.shadowColor = '#FB923C';
      this.localGlow -= 0.01;
    } else {
      ctx.fillStyle = '#00f0ff';
      ctx.shadowBlur = 10;
      ctx.shadowColor = '#00f0ff';
    }
    
    ctx.fill();
    ctx.shadowBlur = 0;

    // Local Peer ID Label
    ctx.font = '10px JetBrains Mono';
    ctx.fillStyle = '#00f0ff';
    ctx.textAlign = 'center';
    const displayId = this.localPeerId.includes('_') ? this.localPeerId.split('_')[1] : this.localPeerId;
    ctx.fillText('YOU: ' + displayId.toUpperCase(), centerX, centerY + 25);
    ctx.textAlign = 'left';

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
      
      if (peer.glow > 0) {
        ctx.fillStyle = `rgba(251, 146, 60, ${peer.glow})`;
        ctx.shadowBlur = 15 * peer.glow;
        ctx.shadowColor = '#FB923C';
        peer.glow -= 0.01;
      } else {
        ctx.fillStyle = peer.status === 'active' ? peer.color : '#3F3F46';
        if (peer.status === 'active') {
          ctx.shadowBlur = 8;
          ctx.shadowColor = peer.color;
        }
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
      
      // Determine Start Point
      if (p.from === 'me' || p.from === this.localPeerId) {
        fromX = centerX; fromY = centerY;
      } else if (p.from === 'origin') {
        fromX = this.originX || (width - 20); fromY = this.originY || 20;
      } else {
        const source = this.peers.find(peer => peer.id === p.from);
        if (!source) return false;
        fromX = source.x; fromY = source.y;
      }

      // Determine End Point
      if (p.to === 'me' || p.to === this.localPeerId) {
        toX = centerX; toY = centerY;
      } else if (p.to === 'origin') {
        toX = this.originX || (width - 20); toY = this.originY || 20;
      } else {
        const target = this.peers.find(peer => peer.id === p.to);
        if (!target) return false;
        toX = target.x; toY = target.y;
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
