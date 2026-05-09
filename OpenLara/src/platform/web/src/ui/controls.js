/**
 * UI Controls
 * Dashboard panel toggles and fullscreen.
 */
export class Controls {
  constructor(parent) {
    this.container = document.createElement('div');
    this.container.className = 'controls-group';
    parent.appendChild(this.container);
    
    this.buttons = [
      { id: 'toggle-game', icon: '🎮', title: 'Toggle Game Engine Metrics', active: true },
      { id: 'toggle-p2p', icon: '📊', title: 'Toggle P2P Network Metrics', active: true },
      { id: 'toggle-info', icon: 'ℹ️', title: 'Toggle Extra Swarm Info', active: false },
      { id: 'toggle-graph', icon: '🕸️', title: 'Toggle Topology Graph', active: true },
      { id: 'btn-fullscreen', icon: '⛶', title: 'Toggle Fullscreen', active: false }
    ];

    this.init();
  }

  init() {
    this.buttons.forEach(btn => {
      const el = document.createElement('button');
      el.className = 'icon-btn';
      if (btn.active) el.classList.add('active');
      el.id = btn.id;
      el.innerHTML = btn.icon;
      el.title = btn.title;
      
      el.addEventListener('click', () => {
        btn.active = !btn.active;
        el.classList.toggle('active', btn.active);
        this.onControlChange(btn.id, btn.active);
      });
      
      this.container.appendChild(el);
    });
  }

  onControlChange(id, active) {
    if (id === 'btn-fullscreen') {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen();
      } else {
        document.exitFullscreen();
      }
      return;
    }
    
    // Custom events for panel toggling
    const event = new CustomEvent('ui-control-change', { detail: { id, active } });
    window.dispatchEvent(event);
  }
}
