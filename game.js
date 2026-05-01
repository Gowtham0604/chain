const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const app = document.getElementById('app');

// --- Audio System ---
const AudioSys = {
    ctx: null,
    muted: false,
    init() {
        if (!this.ctx) this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        if (this.ctx.state === 'suspended') this.ctx.resume();
    },
    playTone(freq, type, duration, vol = 0.1) {
        if (this.muted || !this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        osc.connect(gain); gain.connect(this.ctx.destination);
        osc.start(); osc.stop(this.ctx.currentTime + duration);
    },
    merge(comboSize) { 
        // Pitch goes up with combo size
        const baseFreq = 300 + (comboSize * 50);
        this.playTone(baseFreq, 'sine', 0.15, 0.1); 
        setTimeout(() => this.playTone(baseFreq * 1.5, 'square', 0.2, 0.1), 50);
    },
    pop() { this.playTone(800, 'triangle', 0.1, 0.05); },
    error() { this.playTone(150, 'sawtooth', 0.15, 0.1); },
    gameOver() {
        this.playTone(200, 'sawtooth', 0.4, 0.2);
        setTimeout(() => this.playTone(150, 'sawtooth', 0.6, 0.2), 200);
        setTimeout(() => this.playTone(100, 'square', 1.0, 0.2), 400);
    }
};

document.getElementById('toggleAudioBtn').addEventListener('click', (e) => {
    AudioSys.muted = !AudioSys.muted;
    e.target.innerText = AudioSys.muted ? '🔇 AUDIO: OFF' : '🔊 AUDIO: ON';
    if (!AudioSys.muted) AudioSys.init();
});

// --- Game Constants & State ---
const COLS = 5;
const ROWS = 7;
const PAD = 10;

let W, H, CW, CH, BOARD_TOP, BOARD_LEFT;
let dpr = window.devicePixelRatio || 1;

let state = 'MENU'; // MENU, PLAYING, ANIMATING
let score = 0;
let bestScore = parseInt(localStorage.getItem('neon_merge_best')) || 0;

let grid = []; // 2D array [col][row]
let particles = [];
let floatingTexts = [];

// Camera Shake
let shakeTime = 0, shakeIntensity = 0;
function shakeCamera(intensity, duration) { shakeIntensity = intensity; shakeTime = duration; }

// --- Layout & Resize ---
function resize() {
    const rect = app.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    
    // Calculate square blocks that fit nicely
    CW = (W - PAD * (COLS + 1)) / COLS;
    CH = CW;
    
    const gridHeight = ROWS * (CH + PAD) - PAD;
    BOARD_TOP = (H - gridHeight) / 2 + 40; // Push down slightly for HUD
    BOARD_LEFT = PAD;
    
    // Update existing blocks targets
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            if (grid[c] && grid[c][r]) {
                grid[c][r].targetY = getTargetY(r);
                grid[c][r].x = getTargetX(c);
            }
        }
    }
}
window.addEventListener('resize', resize);
resize();

function getTargetX(col) { return BOARD_LEFT + col * (CW + PAD); }
function getTargetY(row) { return BOARD_TOP + row * (CH + PAD); }

function getBlockColor(val) {
    const colors = [
        '#06b6d4', // 1 Cyan
        '#3b82f6', // 2 Blue
        '#6366f1', // 3 Indigo
        '#8b5cf6', // 4 Purple
        '#d946ef', // 5 Fuchsia
        '#f43f5e', // 6 Rose
        '#ef4444', // 7 Red
        '#f97316', // 8 Orange
        '#f59e0b', // 9 Amber
        '#eab308', // 10 Yellow
        '#84cc16', // 11 Lime
        '#10b981', // 12 Emerald
        '#14b8a6', // 13 Teal
    ];
    return colors[(val - 1) % colors.length];
}

// --- Classes ---
class Block {
    constructor(c, r, val) {
        this.c = c;
        this.r = r;
        this.val = val;
        this.x = getTargetX(c);
        // Start high up for spawn drop animation
        this.y = getTargetY(-1) - Math.random() * (H / 2); 
        this.targetY = getTargetY(r);
        this.scale = 1;
        this.punch = 0; // for jiggle effect
    }
}

// --- Visual Effects ---
function spawnParticles(x, y, color, count) {
    for(let i=0; i<count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 300 + 100;
        particles.push({ 
            x, y, 
            vx: Math.cos(angle)*speed, 
            vy: Math.sin(angle)*speed, 
            life: 1, color, 
            r: Math.random() * 5 + 2 
        });
    }
}

// --- Game Logic ---
function initGrid() {
    grid = Array(COLS).fill().map(() => Array(ROWS).fill(null));
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            grid[c][r] = new Block(c, r, Math.floor(Math.random() * 4) + 1);
        }
    }
}

function getRandomValue() {
    let maxV = 1;
    for(let c=0; c<COLS; c++) {
        for(let r=0; r<ROWS; r++) {
            if(grid[c][r] && grid[c][r].val > maxV) maxV = grid[c][r].val;
        }
    }
    
    // We drop numbers slightly below the max
    let minV = Math.max(1, maxV - 5);
    let maxDrop = Math.max(1, maxV - 1);
    
    return Math.floor(Math.random() * (maxDrop - minV + 1)) + minV;
}

function getConnected(c, r, targetVal, visited) {
    if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return [];
    if (!grid[c][r] || grid[c][r].val !== targetVal) return [];
    
    const key = `${c},${r}`;
    if (visited.has(key)) return [];
    visited.add(key);
    
    let group = [grid[c][r]];
    group = group.concat(getConnected(c+1, r, targetVal, visited));
    group = group.concat(getConnected(c-1, r, targetVal, visited));
    group = group.concat(getConnected(c, r+1, targetVal, visited));
    group = group.concat(getConnected(c, r-1, targetVal, visited));
    
    return group;
}

function checkGameOver() {
    // If ANY two adjacent blocks match, game is not over
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            if (!grid[c][r]) continue;
            let val = grid[c][r].val;
            if (c < COLS-1 && grid[c+1][r] && grid[c+1][r].val === val) return false;
            if (r < ROWS-1 && grid[c][r+1] && grid[c][r+1].val === val) return false;
        }
    }
    return true;
}

function updateHUD() {
    document.getElementById('scoreEl').innerText = score;
    document.getElementById('bestEl').innerText = bestScore;
}

function showMenu(isGameOver = false) {
    const menu = document.getElementById('menu'), title = document.getElementById('menuTitle');
    const desc = document.getElementById('menuDesc'), btn = document.getElementById('startBtn');
    
    if (isGameOver) {
        AudioSys.gameOver();
        title.innerHTML = 'OUT OF<br>MOVES';
        title.style.background = 'linear-gradient(135deg, #f43f5e, #fb923c)';
        title.style.webkitBackgroundClip = 'text';
        title.style.filter = 'drop-shadow(0 0 25px rgba(244,63,94,0.6))';
        desc.innerHTML = `Final Score: <span class="highlight-text">${score}</span>`;
        btn.innerText = 'PLAY AGAIN';
        
        if (score > bestScore) {
            bestScore = score;
            localStorage.setItem('neon_merge_best', bestScore);
        }
    } else {
        title.innerHTML = 'NEON<br>MERGE';
        title.style.background = 'linear-gradient(135deg, #22d3ee, #a855f7)';
        title.style.webkitBackgroundClip = 'text';
        title.style.filter = 'drop-shadow(0 0 25px rgba(168,85,247,0.4))';
    }
    
    updateHUD();
    menu.classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
}

document.getElementById('startBtn').addEventListener('click', () => {
    AudioSys.init();
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    
    score = 0;
    updateHUD();
    initGrid();
    state = 'ANIMATING';
});

// --- Inputs ---
canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    AudioSys.init();
    
    if (state !== 'PLAYING') return; // Lock input during falls
    
    const rect = canvas.getBoundingClientRect();
    const touchX = (e.clientX || (e.touches && e.touches[0].clientX)) - rect.left;
    const touchY = (e.clientY || (e.touches && e.touches[0].clientY)) - rect.top;
    
    const c = Math.floor((touchX * (W / rect.width) - BOARD_LEFT + PAD/2) / (CW + PAD));
    const r = Math.floor((touchY * (H / rect.height) - BOARD_TOP + PAD/2) / (CH + PAD));
    
    if (c >= 0 && c < COLS && r >= 0 && r < ROWS && grid[c][r]) {
        handleBlockClick(c, r);
    }
});

function handleBlockClick(c, r) {
    const clickedBlock = grid[c][r];
    const group = getConnected(c, r, clickedBlock.val, new Set());
    
    if (group.length >= 2) {
        state = 'ANIMATING';
        AudioSys.merge(group.length);
        
        if (group.length >= 4) shakeCamera(group.length, 0.2);
        
        let scoreGain = 0;
        
        // Remove connected blocks
        group.forEach(b => {
            if (b === clickedBlock) {
                // The clicked block upgrades
                b.val++;
                b.scale = 1.4; // Pop effect
                spawnParticles(b.x + CW/2, b.y + CH/2, '#ffffff', 10);
            } else {
                // Others are destroyed
                grid[b.c][b.r] = null;
                spawnParticles(b.x + CW/2, b.y + CH/2, getBlockColor(b.val), 20);
                AudioSys.pop();
            }
            scoreGain += b.val * 10;
        });
        
        // Massive combo bonus
        const totalEarned = scoreGain * group.length;
        score += totalEarned;
        updateHUD();
        
        floatingTexts.push({
            x: clickedBlock.x + CW/2, y: clickedBlock.y, 
            text: `+${totalEarned}`, life: 1.5, 
            color: '#f8fafc', size: group.length >= 4 ? 24 : 18
        });
        if (group.length >= 4) {
            floatingTexts.push({
                x: clickedBlock.x + CW/2, y: clickedBlock.y - 25, 
                text: `${group.length} COMBO!`, life: 2, 
                color: '#f43f5e', size: 16
            });
        }
        
        applyGravity();
        
    } else {
        // Invalid move jiggle
        clickedBlock.punch = 0.2;
        AudioSys.error();
    }
}

function applyGravity() {
    for (let c = 0; c < COLS; c++) {
        let writeRow = ROWS - 1;
        // Shift blocks down
        for (let r = ROWS - 1; r >= 0; r--) {
            if (grid[c][r]) {
                if (writeRow !== r) {
                    grid[c][writeRow] = grid[c][r];
                    grid[c][r] = null;
                    grid[c][writeRow].r = writeRow;
                    grid[c][writeRow].targetY = getTargetY(writeRow);
                }
                writeRow--;
            }
        }
        // Drop new blocks
        for (let r = writeRow; r >= 0; r--) {
            grid[c][r] = new Block(c, r, getRandomValue());
        }
    }
}

// --- Game Loop ---
function update(dt) {
    if (shakeTime > 0) { shakeTime -= dt; shakeIntensity *= 0.9; }
    
    particles.forEach(p => { 
        p.x += p.vx * dt; p.y += p.vy * dt; 
        p.vy += 800 * dt; // Gravity 
        p.life -= dt * 2; p.r *= 0.9; 
    });
    particles = particles.filter(p => p.life > 0);
    
    floatingTexts.forEach(ft => { ft.y -= dt * 60; ft.life -= dt * 1.5; });
    floatingTexts = floatingTexts.filter(ft => ft.life > 0);
    
    let allSettled = true;
    for(let c=0; c<COLS; c++) {
        for(let r=0; r<ROWS; r++) {
            let b = grid[c][r];
            if (!b) continue;
            
            if (b.punch > 0) b.punch = Math.max(0, b.punch - dt * 3);
            
            const dy = b.targetY - b.y;
            if (Math.abs(dy) > 1) { 
                // Gravity acceleration feel
                b.y += dy * 12 * dt; 
                allSettled = false; 
            } else {
                b.y = b.targetY;
            }
            
            if (b.scale > 1) { 
                b.scale = Math.max(1, b.scale - 3 * dt); 
                allSettled = false; 
            } else if (b.scale < 1) {
                b.scale = Math.min(1, b.scale + 3 * dt);
                allSettled = false;
            }
        }
    }
    
    if (state === 'ANIMATING' && allSettled) {
        state = 'PLAYING';
        if (checkGameOver()) {
            setTimeout(() => showMenu(true), 500); // Small delay before game over screen
        }
    }
}

function draw() {
    ctx.clearRect(0, 0, W, H);
    
    ctx.save();
    if (shakeTime > 0) { ctx.translate((Math.random()-0.5)*shakeIntensity, (Math.random()-0.5)*shakeIntensity); }
    
    // Draw Grid Background slots
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            ctx.fillStyle = 'rgba(255,255,255,0.02)';
            ctx.beginPath();
            ctx.roundRect(getTargetX(c), getTargetY(r), CW, CH, 14);
            ctx.fill();
        }
    }

    // Particles (behind blocks looks cleaner for this game)
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    particles.forEach(p => { 
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); 
        ctx.fillStyle = p.color; ctx.globalAlpha = p.life; ctx.fill(); 
    });
    ctx.restore();

    // Blocks
    for(let c=0; c<COLS; c++) {
        for(let r=0; r<ROWS; r++) {
            let b = grid[c][r];
            if (!b) continue;
            
            ctx.save(); 
            ctx.translate(b.x + CW/2, b.y + CH/2);
            
            // Jiggle effect
            if (b.punch > 0) {
                ctx.rotate(Math.sin(performance.now() * 0.05) * b.punch);
            }
            
            ctx.scale(b.scale, b.scale);
            const color = getBlockColor(b.val);
            
            // Block Body
            ctx.fillStyle = 'rgba(15, 23, 42, 0.95)'; 
            ctx.beginPath(); ctx.roundRect(-CW/2, -CH/2, CW, CH, 14); ctx.fill();
            
            // Glass highlight top
            ctx.fillStyle = 'rgba(255,255,255,0.12)'; 
            ctx.beginPath(); ctx.roundRect(-CW/2, -CH/2, CW, CH/2.5, {tl: 14, tr: 14, bl: 0, br: 0}); ctx.fill();
            
            // Neon Border
            ctx.strokeStyle = color; ctx.lineWidth = 3; 
            ctx.shadowColor = color; ctx.shadowBlur = 10;
            ctx.stroke(); ctx.shadowBlur = 0; 
            
            // Inner color fill
            ctx.fillStyle = color; ctx.globalAlpha = 0.2;
            ctx.beginPath(); ctx.roundRect(-CW/2 + 3, -CH/2 + 3, CW - 6, CH - 6, 10); ctx.fill(); 
            ctx.globalAlpha = 1;
            
            // Number Text
            ctx.fillStyle = '#ffffff'; 
            ctx.font = `900 ${Math.max(20, CW * 0.5)}px Outfit`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; 
            ctx.shadowColor = color; ctx.shadowBlur = 8;
            ctx.fillText(b.val, 0, 2); 
            
            ctx.restore();
        }
    }

    // Floating Texts
    floatingTexts.forEach(ft => {
        ctx.save(); ctx.globalAlpha = Math.max(0, ft.life); 
        ctx.fillStyle = ft.color || '#f8fafc';
        ctx.font = `900 ${ft.size || 18}px Outfit`; ctx.textAlign = 'center'; 
        ctx.shadowColor = '#000000'; ctx.shadowBlur = 6;
        ctx.fillText(ft.text, ft.x, ft.y); ctx.restore();
    });
    
    ctx.restore();
}

let lastTime = 0;
requestAnimationFrame(function loop(timestamp) {
    requestAnimationFrame(loop);
    if (!lastTime) { lastTime = timestamp; return; }
    let dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    if (dt > 0.05) dt = 0.05; 
    update(dt); draw();
});
