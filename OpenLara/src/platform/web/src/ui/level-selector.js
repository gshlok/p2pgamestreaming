/**
 * Level Selector Component
 * Modern, embedded dropdown for level switching.
 */
export class LevelSelector {
  constructor(parent, onSelect) {
    this.container = document.createElement('div');
    this.container.className = 'level-selector ui-container';
    parent.appendChild(this.container);
    
    this.onSelect = onSelect;
    this.levels = [
      { id: '1/LEVEL1.PSX', name: '01 Caves' },
      { id: '1/LEVEL2.PSX', name: '02 Vilcabamba' },
      { id: '1/LEVEL3A.PSX', name: '03 Lost Valley' },
      { id: '1/LEVEL4.PSX', name: '04 Qualopec' },
      { id: '1/LEVEL5.PSX', name: '05 St Francis' },
      { id: '1/LEVEL6.PSX', name: '06 Colosseum' },
      { id: '1/LEVEL7A.PSX', name: '07 Palace Midas' },
      { id: '1/LEVEL8A.PSX', name: '08 Cistern' },
      { id: '1/LEVEL10A.PSX', name: '10 Khamoon' },
      { id: '1/LEVEL10B.PSX', name: '11 Obelisk' },
      { id: '1/LEVEL10C.PSX', name: '12 Scion' },
      { id: '1/GYM.PSX', name: 'Laras Home' }
    ];

    this.init();
  }

  init() {
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Mission:';
    
    this.select = document.createElement('select');
    this.select.className = 'level-select-ui';
    
    this.levels.forEach(lvl => {
      const opt = document.createElement('option');
      opt.value = lvl.id;
      opt.textContent = lvl.name;
      this.select.appendChild(opt);
    });
    
    this.select.addEventListener('change', () => {
      if (this.onSelect) this.onSelect(this.select.value);
      this.select.blur(); // Return focus to the window/game
    });
    
    this.container.appendChild(label);
    this.container.appendChild(this.select);
  }

  setSelected(id) {
    this.select.value = id;
  }
}
