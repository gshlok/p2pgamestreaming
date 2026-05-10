/**
 * Game Selector Module — Unified Multi-Game Launcher
 * 
 * Provides a modal interface to switch between different game runtimes.
 */

(function() {
    'use strict';

    const GAMES = [
        { id: 'openlara', name: 'OpenLara', desc: 'Classic Tomb Raider engine', path: 'OpenLara/src/platform/web/index.html', icon: '🏃‍♀️' },
        { id: 'doom', name: 'DOOM', desc: 'The ultimate FPS classic', path: 'doom/chocolate-doom.html', icon: '👹' }, // Assuming chocolate-doom.html exists in doom folder
        { id: 'threejs', name: 'Three.js Runner', desc: 'Pure WebGL performance demo', path: 'threejs-runner/index.html', icon: '🧊' },
        { id: 'torrent', name: 'Torrent Swarm', desc: 'P2P asset deck & map viewer', path: 'torrent-loader/index.html', icon: '📡' }
    ];

    class GameSelector {
        constructor() {
            this.modal = null;
            this.isOpen = false;
            this._createStyles();
            this._createDOM();
            this._bindEvents();
        }

        _createStyles() {
            const style = document.createElement('style');
            style.textContent = `
                .gs-modal {
                    position: fixed;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background: rgba(5, 5, 8, 0.9);
                    backdrop-filter: blur(20px);
                    z-index: 10000;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    opacity: 0;
                    visibility: hidden;
                    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                }
                .gs-modal.open { opacity: 1; visibility: visible; }
                
                .gs-container {
                    width: 90%;
                    max-width: 800px;
                    display: grid;
                    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
                    gap: 20px;
                    padding: 40px;
                }
                
                .gs-card {
                    background: rgba(255, 255, 255, 0.03);
                    border: 1px solid rgba(255, 255, 255, 0.1);
                    border-radius: 16px;
                    padding: 24px;
                    text-align: center;
                    cursor: pointer;
                    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
                    position: relative;
                    overflow: hidden;
                }
                .gs-card:hover {
                    background: rgba(0, 240, 255, 0.05);
                    border-color: rgba(0, 240, 255, 0.5);
                    transform: translateY(-8px);
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
                }
                
                .gs-card-icon { font-size: 40px; margin-bottom: 16px; display: block; }
                .gs-card-name { font-weight: 700; font-size: 16px; color: #fff; margin-bottom: 8px; }
                .gs-card-desc { font-size: 12px; color: #71717A; line-height: 1.5; }
                
                .gs-card.active { border-color: #00f0ff; background: rgba(0, 240, 255, 0.1); }
                .gs-card.active::after {
                    content: 'ACTIVE';
                    position: absolute;
                    top: 12px; right: 12px;
                    font-size: 8px;
                    font-weight: 900;
                    color: #00f0ff;
                    letter-spacing: 0.1em;
                }
                
                .gs-close {
                    position: absolute;
                    top: 32px; right: 32px;
                    background: none;
                    border: none;
                    color: #71717A;
                    font-size: 24px;
                    cursor: pointer;
                    transition: color 0.2s;
                }
                .gs-close:hover { color: #fff; }
            `;
            document.head.appendChild(style);
        }

        _createDOM() {
            this.modal = document.createElement('div');
            this.modal.className = 'gs-modal';
            
            const container = document.createElement('div');
            container.className = 'gs-container';
            
            GAMES.forEach(game => {
                const card = document.createElement('div');
                card.className = 'gs-card';
                if (game.id === 'openlara') card.classList.add('active');
                card.dataset.id = game.id;
                card.innerHTML = `
                    <span class="gs-card-icon">${game.icon}</span>
                    <div class="gs-card-name">${game.name}</div>
                    <div class="gs-card-desc">${game.desc}</div>
                `;
                card.onclick = () => this.selectGame(game.id);
                container.appendChild(card);
            });
            
            const closeBtn = document.createElement('button');
            closeBtn.className = 'gs-close';
            closeBtn.innerHTML = '×';
            closeBtn.onclick = () => this.toggle();
            
            this.modal.appendChild(closeBtn);
            this.modal.appendChild(container);
            document.body.appendChild(this.modal);
        }

        _bindEvents() {
            const btn = document.getElementById('game-select-btn');
            if (btn) btn.onclick = () => this.toggle();
            
            window.addEventListener('keydown', (e) => {
                if (e.key === 'Escape' && this.isOpen) this.toggle();
            });
        }

        toggle() {
            this.isOpen = !this.isOpen;
            this.modal.classList.toggle('open', this.isOpen);
        }

        selectGame(id) {
            const game = GAMES.find(g => g.id === id);
            if (!game) return;

            console.log(`[Selector] Switching to ${game.name}...`);
            
            // Update UI
            document.querySelectorAll('.gs-card').forEach(c => c.classList.remove('active'));
            document.querySelector(`.gs-card[data-id="${id}"]`).classList.add('active');
            
            // Switch Iframe
            const viewport = document.getElementById('game-viewport');
            if (viewport) {
                viewport.src = game.path;
            }

            // Notify main page so OpenLara-specific UI can hide/show
            if (typeof window.onGameChanged === 'function') {
                window.onGameChanged(id);
            }
            
            this.toggle();
        }
    }

    window.gameSelector = new GameSelector();
})();
