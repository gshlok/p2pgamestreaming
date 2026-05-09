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
      { id: 'Tomb-Raider-1/01-Caves.PHD', name: '01 Caves' },
      { id: 'Tomb-Raider-1/02-City-of-Vilcabamba.PHD', name: '02 Vilcabamba' },
      { id: 'Tomb-Raider-1/03-The-Lost-Valley.PHD', name: '03 Lost Valley' },
      { id: 'Tomb-Raider-1/04-Tomb-of-Qualopec.PHD', name: '04 Qualopec' },
      { id: 'Tomb-Raider-1/05-St-Francis-Folly.PHD', name: '05 St Francis' },
      { id: 'Tomb-Raider-1/06-Colosseum.PHD', name: '06 Colosseum' },
      { id: 'Tomb-Raider-1/07-Palace-Midas.PHD', name: '07 Palace Midas' },
      { id: 'Tomb-Raider-1/08-Cistern.PHD', name: '08 Cistern' },
      { id: 'Tomb-Raider-1/09-Tomb-of-Tihocan.PHD', name: '09 Tihocan' },
      { id: 'Tomb-Raider-1/10-City-of-Khamoon.PHD', name: '10 Khamoon' },
      { id: 'Tomb-Raider-1/11-Obelisk-of-Khamoon.PHD', name: '11 Obelisk' },
      { id: 'Tomb-Raider-1/12-Sanctuary-of-the-Scion.PHD', name: '12 Scion' },
      { id: 'Tomb-Raider-1/13-Natlas-Mines.PHD', name: '13 Mines' },
      { id: 'Tomb-Raider-1/14-Atlantis.PHD', name: '14 Atlantis' },
      { id: 'Tomb-Raider-1/15-The-Great-Pyramid.PHD', name: '15 Pyramid' }
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
    });
    
    this.container.appendChild(label);
    this.container.appendChild(this.select);
  }

  setSelected(id) {
    this.select.value = id;
  }
}
