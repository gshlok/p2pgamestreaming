/**
 * Active Transfers Feed
 * Bottom-center "alive" component.
 */
export class TransferFeed {
  constructor(parent) {
    this.container = document.createElement('div');
    this.container.className = 'transfer-feed';
    parent.appendChild(this.container);
    
    this.activeTransfers = new Map(); // assetPath -> element
    this.maxItems = 3;
  }

  addTransfer(assetName, source, peerId) {
    if (this.activeTransfers.has(assetName)) return;

    // Remove oldest if limit reached
    if (this.activeTransfers.size >= this.maxItems) {
      const firstKey = this.activeTransfers.keys().next().value;
      this.removeTransfer(firstKey);
    }

    const item = document.createElement('div');
    item.className = 'transfer-item ui-container';
    
    const header = document.createElement('div');
    header.className = 'transfer-header';
    
    const name = document.createElement('span');
    name.className = 'asset-name';
    name.textContent = assetName.split('/').pop();
    
    const badge = document.createElement('span');
    badge.className = `source-badge badge-${source.toLowerCase()}`;
    badge.textContent = source;
    
    header.appendChild(badge);
    header.appendChild(name);
    
    const progressContainer = document.createElement('div');
    progressContainer.className = 'progress-container';
    
    const progressBar = document.createElement('div');
    progressBar.className = 'progress-bar';
    progressContainer.appendChild(progressBar);
    
    const meta = document.createElement('div');
    meta.className = 'transfer-meta';
    
    const speed = document.createElement('span');
    speed.textContent = '0.0 MB/s';
    
    const peer = document.createElement('span');
    peer.textContent = peerId ? `Peer ${peerId.slice(-4).toUpperCase()}` : 'Origin';
    
    meta.appendChild(speed);
    meta.appendChild(peer);
    
    item.appendChild(header);
    item.appendChild(progressContainer);
    item.appendChild(meta);
    
    this.container.appendChild(item);
    this.activeTransfers.set(assetName, { 
      element: item, 
      progressBar, 
      speed, 
      startTime: Date.now(),
      completed: false
    });
  }

  updateProgress(assetName, percent, currentSpeed) {
    const transfer = this.activeTransfers.get(assetName);
    if (!transfer || transfer.completed) return;
    
    transfer.progressBar.style.width = `${percent}%`;
    if (currentSpeed) {
      transfer.speed.textContent = `${currentSpeed.toFixed(1)} MB/s`;
    }

    if (percent >= 100) {
      this.completeTransfer(assetName);
    }
  }

  completeTransfer(assetName) {
    const transfer = this.activeTransfers.get(assetName);
    if (!transfer) return;
    
    transfer.completed = true;
    transfer.progressBar.style.width = '100%';
    transfer.progressBar.style.background = 'var(--emerald)';
    
    // Success flash
    transfer.element.style.borderColor = 'var(--emerald)';
    
    setTimeout(() => {
      this.removeTransfer(assetName);
    }, 2000);
  }

  removeTransfer(assetName) {
    const transfer = this.activeTransfers.get(assetName);
    if (!transfer) return;
    
    transfer.element.style.opacity = '0';
    transfer.element.style.transform = 'translateY(-10px)';
    
    setTimeout(() => {
      if (transfer.element.parentNode) {
        transfer.element.parentNode.removeChild(transfer.element);
      }
      this.activeTransfers.delete(assetName);
    }, 300);
  }
}
