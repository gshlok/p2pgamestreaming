/**
 * Layout Architecture
 * Handles the macro layout and immersive mode.
 */

export class Layout {
  constructor(rootId = 'ui-root') {
    this.root = document.getElementById(rootId);
    if (!this.root) {
      this.root = document.createElement('div');
      this.root.id = rootId;
      document.body.appendChild(this.root);
    }
    
    this.areas = {};
    this.init();
  }

  init() {
    const areaNames = [
      'top-left', 'top-center', 'top-right',
      'bot-left', 'bot-center', 'bot-right'
    ];

    areaNames.forEach(name => {
      const area = document.createElement('div');
      area.className = `area-${name}`;
      this.root.appendChild(area);
      this.areas[name] = area;
    });

    this.setupImmersiveMode();
  }

  setupImmersiveMode() {
    let hideTimeout;
    const hideUI = () => {
      this.root.classList.add('immersive');
    };
    
    const resetTimer = () => {
      this.root.classList.remove('immersive');
      clearTimeout(hideTimeout);
      hideTimeout = setTimeout(hideUI, 5000); // Auto-hide after 5s of inactivity
    };

    // Restore UI on any mouse movement
    document.addEventListener('mousemove', (e) => {
      resetTimer();
    });

    // Start timer
    resetTimer();
  }

  getArea(name) {
    return this.areas[name];
  }
}
