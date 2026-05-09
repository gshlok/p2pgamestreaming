import { Animations } from './animations.js';

/**
 * Extra Information Panel
 * Swarm efficiency and cache status.
 */
export class InfoPanel {
  constructor(parent) {
    this.container = document.createElement('div');
    this.container.className = 'info-panel ui-container';
    this.container.style.display = 'none'; // Hidden by default
    parent.appendChild(this.container);
    
    this.metrics = {
      saved: { label: 'Saved Bandwidth', value: 0, formatter: v => this.formatBytes(v) },
      load: { label: 'Network Load', value: 0, formatter: v => `${v.toFixed(1)} MB/s` },
      uploaded: { label: 'Uploaded to Swarm', value: 0, formatter: v => this.formatBytes(v) },
      cache: { label: 'Local Cache', value: 0, formatter: v => `${v} assets` }
    };

    this.elements = {};
    this.init();
  }

  init() {
    Object.entries(this.metrics).forEach(([key, data]) => {
      const item = document.createElement('div');
      item.className = 'info-item';
      
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = data.label;
      
      const value = document.createElement('span');
      value.className = 'metric-value';
      value.style.fontSize = '14px'; // Slightly smaller than main metrics
      value.textContent = '0';
      
      item.appendChild(label);
      item.appendChild(value);
      this.container.appendChild(item);
      
      this.elements[key] = value;
    });
  }

  formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  update(data) {
    // data: { bytesSaved, downRate, bytesUploaded, localAssetCount }
    if (data.bytesSaved !== undefined) {
      Animations.animateNumber(this.elements.saved, this.metrics.saved.value, data.bytesSaved, 500, this.metrics.saved.formatter);
      this.metrics.saved.value = data.bytesSaved;
    }
    
    if (data.downRate !== undefined) {
      Animations.animateNumber(this.elements.load, this.metrics.load.value, data.downRate, 500, this.metrics.load.formatter);
      this.metrics.load.value = data.downRate;
    }

    if (data.bytesUploaded !== undefined) {
      Animations.animateNumber(this.elements.uploaded, this.metrics.uploaded.value, data.bytesUploaded, 500, this.metrics.uploaded.formatter);
      this.metrics.uploaded.value = data.bytesUploaded;
    }

    if (data.localAssetCount !== undefined) {
      Animations.animateNumber(this.elements.cache, this.metrics.cache.value, data.localAssetCount, 500, this.metrics.cache.formatter);
      this.metrics.cache.value = data.localAssetCount;
    }
  }

  setVisible(visible) {
    this.container.style.display = visible ? 'flex' : 'none';
  }
}
