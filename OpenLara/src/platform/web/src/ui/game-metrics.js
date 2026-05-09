import { Animations } from './animations.js';

/**
 * Game Engine Metrics
 * Displays FPS, Draw Calls (DIP), Triangles, and Ray Tracing/Render Time.
 */
export class GameMetrics {
  constructor(parent) {
    this.container = document.createElement('div');
    this.container.className = 'game-metrics-panel ui-container';
    parent.appendChild(this.container);
    
    this.metrics = {
      fps: { label: 'FPS', value: 0 },
      dip: { label: 'DIP', value: 0 },
      tri: { label: 'TRI', value: 0 },
      rt: { label: 'RT', value: 0 }
    };

    this.elements = {};
    this.init();
  }

  init() {
    Object.entries(this.metrics).forEach(([key, data]) => {
      const row = document.createElement('div');
      row.className = 'metric-row';
      
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = data.label;
      
      const value = document.createElement('span');
      value.className = 'metric-value';
      value.textContent = '0';
      
      row.appendChild(label);
      row.appendChild(value);
      this.container.appendChild(row);
      
      this.elements[key] = value;
    });
  }

  parseLog(text) {
    // Expected format: "FPS: 60 DIP: 16 TRI: 3853 RT: 2"
    const fpsMatch = text.match(/FPS:\s*(\d+)/);
    const dipMatch = text.match(/DIP:\s*(\d+)/);
    const triMatch = text.match(/TRI:\s*(\d+)/);
    const rtMatch = text.match(/RT:\s*(\d+)/);

    if (fpsMatch) this.update('fps', parseInt(fpsMatch[1]));
    if (dipMatch) this.update('dip', parseInt(dipMatch[1]));
    if (triMatch) this.update('tri', parseInt(triMatch[1]));
    if (rtMatch) this.update('rt', parseInt(rtMatch[1]));
  }

  update(key, value) {
    if (!this.elements[key]) return;
    
    const prev = this.metrics[key].value;
    if (prev === value) return;

    this.metrics[key].value = value;
    
    // For fast changing metrics like FPS, we don't always want full duration animation
    // But we use the utility for consistency.
    Animations.animateNumber(this.elements[key], prev, value, 200, v => Math.round(v).toString());
  }

  setVisible(visible) {
    this.container.style.display = visible ? 'flex' : 'none';
  }
}
