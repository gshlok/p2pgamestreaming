/**
 * In-world Asset Tags
 * Minimalist floating labels for 3D assets.
 */
export class AssetTag {
  constructor(assetName, status = 'streaming') {
    this.element = document.createElement('div');
    this.element.className = 'asset-tag';
    
    const header = document.createElement('div');
    header.className = 'tag-header';
    
    this.dot = document.createElement('div');
    this.dot.className = 'tag-status-dot';
    this.setStatus(status);
    
    const name = document.createElement('span');
    name.className = 'tag-name';
    name.textContent = assetName.split('/').pop();
    
    header.appendChild(this.dot);
    header.appendChild(name);
    
    this.state = document.createElement('span');
    this.state.className = 'tag-state';
    this.state.textContent = status.toUpperCase();
    
    this.element.appendChild(header);
    this.element.appendChild(this.state);
  }

  setStatus(status) {
    this.status = status;
    if (this.state) this.state.textContent = status.toUpperCase();
    
    const colors = {
      streaming: 'var(--amber)',
      materialized: 'var(--emerald)',
      failed: 'var(--red)'
    };
    
    this.dot.style.background = colors[status] || colors.streaming;
    if (status === 'materialized') {
      this.dot.style.boxShadow = `0 0 6px ${colors.materialized}`;
    } else {
      this.dot.style.boxShadow = 'none';
    }
  }

  getElement() {
    return this.element;
  }
}

/**
 * Manager for Asset Tags
 * Handles lifecycle and bridging with the 3D engine.
 */
export class AssetTagManager {
  constructor(scene) {
    this.scene = scene;
    this.tags = new Map(); // assetPath -> AssetTag
  }

  createTag(assetPath, worldPosition) {
    const tag = new AssetTag(assetPath);
    this.tags.set(assetPath, tag);
    
    // In a Three.js environment with CSS2DRenderer:
    // const object = new CSS2DObject(tag.getElement());
    // object.position.copy(worldPosition);
    // this.scene.add(object);
    
    return tag;
  }

  updateTag(assetPath, status) {
    const tag = this.tags.get(assetPath);
    if (tag) tag.setStatus(status);
  }

  removeTag(assetPath) {
    const tag = this.tags.get(assetPath);
    if (tag) {
      // Handle removal from scene
      this.tags.delete(assetPath);
    }
  }
}
