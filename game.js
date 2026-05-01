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
    swap() { this.playTone(400, 'sine', 0.1, 0.05); },
    merge(linesCount) { 
        const baseFreq = 400 + (linesCount * 100);
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
const COLS = 6;
const ROWS = 8;
const PAD = 8;

let W, H, CW, CH, BOARD_TOP, BOARD_LEFT;
let dpr = window.devicePixelRatio || 1;

let state = 'MENU'; // MENU, PLAYING, ANIMATING, PAUSED
let previousState = 'PLAYING';
let score = 0;
let bestScore = parseInt(localStorage.getItem('neon_match_best')) || 0;

let grid = []; 
let particles = [];
let floatingTexts = [];
let actionQueue = [];

// Camera Shake
let shakeTime = 0, shakeIntensity = 0;
function shakeCamera(intensity, duration) { shakeIntensity = intensity; shakeTime = duration; }

// --- Layout & Resize ---
function resize() {
    const rect = app.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    
    CW = (W - PAD * (COLS + 1)) / COLS;
    CH = CW;
    
    const gridHeight = ROWS * (CH + PAD) - PAD;
    BOARD_TOP = (H - gridHeight) / 2 + 30; 
    BOARD_LEFT = PAD;
    
    for (let c = 0; c < COLS; c++) {
        if(!grid[c]) continue;
        for (let r = 0; r < ROWS; r++) {
            if (grid[c][r]) {
                grid[c][r].targetX = getTargetX(c);
                grid[c][r].targetY = getTargetY(r);
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
        '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#d946ef', 
        '#f43f5e', '#ef4444', '#f97316', '#f59e0b', '#eab308', 
        '#84cc16', '#10b981', '#14b8a6'
    ];
    return colors[(val - 1) % colors.length];
}

// --- Classes ---
class Block {
    constructor(c, r, val) {
        this.c = c; this.r = r; this.val = val;
        this.x = getTargetX(c);
        this.y = getTargetY(-1) - Math.random() * (H / 2); 
        this.targetX = getTargetX(c);
        this.targetY = getTargetY(r);
        this.scale = 1;
        this.punch = 0; 
    }
}

function spawnParticles(x, y, color, count) {
    for(let i=0; i<count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const speed = Math.random() * 300 + 100;
        particles.push({ x, y, vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed, life: 1, color, r: Math.random() * 4 + 2 });
    }
}

// --- Game Logic ---
function initGrid() {
    grid = Array(COLS).fill().map(() => Array(ROWS).fill(null));
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            let val;
            do {
                val = Math.floor(Math.random() * 4) + 1;
            } while (
                (c >= 2 && grid[c-1][r].val === val && grid[c-2][r].val === val) ||
                (r >= 2 && grid[c][r-1].val === val && grid[c][r-2].val === val)
            );
            grid[c][r] = new Block(c, r, val);
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
    let minV = Math.max(1, maxV - 4);
    let maxDrop = Math.max(1, maxV - 1);
    return Math.floor(Math.random() * (maxDrop - minV + 1)) + minV;
}

function swapInGrid(c1, r1, c2, r2) {
    let t = grid[c1][r1]; grid[c1][r1] = grid[c2][r2]; grid[c2][r2] = t;
    if (grid[c1][r1]) { grid[c1][r1].c = c1; grid[c1][r1].r = r1; grid[c1][r1].targetX = getTargetX(c1); grid[c1][r1].targetY = getTargetY(r1); }
    if (grid[c2][r2]) { grid[c2][r2].c = c2; grid[c2][r2].r = r2; grid[c2][r2].targetX = getTargetX(c2); grid[c2][r2].targetY = getTargetY(r2); }
}

function hasAnyMatch() {
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS - 2; c++) {
            if (grid[c][r] && grid[c+1][r] && grid[c+2][r] && 
                grid[c][r].val === grid[c+1][r].val && grid[c+1][r].val === grid[c+2][r].val) return true;
        }
    }
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS - 2; r++) {
            if (grid[c][r] && grid[c][r+1] && grid[c][r+2] && 
                grid[c][r].val === grid[c][r+1].val && grid[c][r+1].val === grid[c][r+2].val) return true;
        }
    }
    return false;
}

function checkGameOver() {
    for(let c=0; c<COLS; c++) {
        for(let r=0; r<ROWS; r++) {
            if (c < COLS - 1) {
                swapInGrid(c, r, c+1, r); let has = hasAnyMatch(); swapInGrid(c, r, c+1, r);
                if (has) return false;
            }
            if (r < ROWS - 1) {
                swapInGrid(c, r, c, r+1); let has = hasAnyMatch(); swapInGrid(c, r, c, r+1);
                if (has) return false;
            }
        }
    }
    return true;
}

function processMatches(swapC = -1, swapR = -1) {
    let lines = [];
    
    // Horizontal
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS - 2; c++) {
            if (!grid[c][r]) continue;
            let val = grid[c][r].val;
            let matchLen = 1;
            while(c + matchLen < COLS && grid[c+matchLen][r] && grid[c+matchLen][r].val === val) matchLen++;
            
            if (matchLen >= 3) {
                let line = [];
                for(let i=0; i<matchLen; i++) line.push({c: c+i, r: r});
                lines.push(line);
                c += matchLen - 1; 
            }
        }
    }
    
    // Vertical
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS - 2; r++) {
            if (!grid[c][r]) continue;
            let val = grid[c][r].val;
            let matchLen = 1;
            while(r + matchLen < ROWS && grid[c][r+matchLen] && grid[c][r+matchLen].val === val) matchLen++;
            
            if (matchLen >= 3) {
                let line = [];
                for(let i=0; i<matchLen; i++) line.push({c: c, r: r+i});
                lines.push(line);
                r += matchLen - 1;
            }
        }
    }
    
    if (lines.length === 0) return false;
    
    AudioSys.merge(lines.length);
    shakeCamera(lines.length * 3, 0.2);
    
    let toDestroy = new Set();
    let toUpgrade = new Map(); 
    
    lines.forEach(line => {
        let target = line[0];
        const swapBlock = line.find(b => b.c === swapC && b.r === swapR);
        if (swapBlock) target = swapBlock;
        else target = line[Math.floor(line.length / 2)];
        
        let targetKey = `${target.c},${target.r}`;
        toUpgrade.set(targetKey, grid[target.c][target.r]);
        
        line.forEach(b => {
            let key = `${b.c},${b.r}`;
            if (key !== targetKey) toDestroy.add(key);
        });
    });
    
    toUpgrade.forEach((block, key) => { if (toDestroy.has(key)) toDestroy.delete(key); });
    
    let scoreGain = 0;
    toUpgrade.forEach((block, key) => {
        block.val++;
        block.scale = 1.4;
        spawnParticles(block.targetX + CW/2, block.targetY + CH/2, '#ffffff', 10);
        scoreGain += block.val * 50;
    });
    
    toDestroy.forEach(key => {
        let [c, r] = key.split(',').map(Number);
        let b = grid[c][r];
        if (b) {
            spawnParticles(b.targetX + CW/2, b.targetY + CH/2, getBlockColor(b.val), 15);
            grid[c][r] = null;
        }
    });
    
    score += scoreGain * lines.length; // Multiplier for combos!
    updateHUD();
    
    toUpgrade.forEach((block) => {
        floatingTexts.push({
            x: block.targetX + CW/2, y: block.targetY, 
            text: lines.length > 1 ? `COMBO x${lines.length}!` : `MERGE!`, 
            life: 1.5, color: '#f8fafc', size: lines.length > 1 ? 24 : 16
        });
    });
    
    return true;
}

function applyGravity() {
    for (let c = 0; c < COLS; c++) {
        let writeRow = ROWS - 1;
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
        for (let r = writeRow; r >= 0; r--) {
            grid[c][r] = new Block(c, r, getRandomValue());
        }
    }
}

// --- UI / Flow ---
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
        if (score > bestScore) { bestScore = score; localStorage.setItem('neon_match_best', bestScore); }
    } else {
        title.innerHTML = 'NEON<br>MATCH';
        title.style.background = 'linear-gradient(135deg, #38bdf8, #818cf8)';
        title.style.webkitBackgroundClip = 'text';
        title.style.filter = 'drop-shadow(0 0 25px rgba(56,189,248,0.4))';
        desc.innerHTML = `Swipe to match 3 or more numbers to merge them into higher values!`;
        btn.innerText = 'PLAY NOW';
    }
    
    updateHUD();
    menu.classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
    document.getElementById('pauseMenu').classList.add('hidden');
}

function startGame() {
    AudioSys.init();
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('pauseMenu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    score = 0; updateHUD(); initGrid(); state = 'ANIMATING';
}

document.getElementById('startBtn').addEventListener('click', startGame);

// --- Pause Menu Listeners ---
document.getElementById('pauseBtn').addEventListener('click', () => {
    if (state === 'PAUSED' || state === 'MENU') return;
    AudioSys.init();
    previousState = state;
    state = 'PAUSED';
    document.getElementById('pauseMenu').classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
});

document.getElementById('resumeBtn').addEventListener('click', () => {
    AudioSys.init();
    state = previousState;
    document.getElementById('pauseMenu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
});

document.getElementById('restartBtn').addEventListener('click', startGame);

document.getElementById('quitBtn').addEventListener('click', () => {
    AudioSys.init();
    state = 'MENU';
    showMenu(false);
});

// --- Inputs (Swipe to Swap) ---
let dragStart = null;

canvas.addEventListener('pointerdown', e => {
    e.preventDefault(); AudioSys.init();
    if (state !== 'PLAYING') return; 
    
    const rect = canvas.getBoundingClientRect();
    const touchX = (e.clientX || (e.touches && e.touches[0].clientX)) - rect.left;
    const touchY = (e.clientY || (e.touches && e.touches[0].clientY)) - rect.top;
    
    const c = Math.floor((touchX * (W / rect.width) - BOARD_LEFT + PAD/2) / (CW + PAD));
    const r = Math.floor((touchY * (H / rect.height) - BOARD_TOP + PAD/2) / (CH + PAD));
    
    if (c >= 0 && c < COLS && r >= 0 && r < ROWS && grid[c][r]) {
        dragStart = {x: touchX * (W / rect.width), y: touchY * (H / rect.height), c, r};
    }
});

canvas.addEventListener('pointermove', e => {
    e.preventDefault();
    if (!dragStart || state !== 'PLAYING') return;
    const rect = canvas.getBoundingClientRect();
    const touchX = (e.clientX || (e.touches && e.touches[0].clientX)) - rect.left;
    const touchY = (e.clientY || (e.touches && e.touches[0].clientY)) - rect.top;
    
    const dx = (touchX * (W / rect.width)) - dragStart.x;
    const dy = (touchY * (H / rect.height)) - dragStart.y;
    
    const SWIPE_THRESH = CW * 0.4; // 40% of a block width to trigger swap
    
    if (Math.abs(dx) > SWIPE_THRESH || Math.abs(dy) > SWIPE_THRESH) {
        let targetC = dragStart.c;
        let targetR = dragStart.r;
        
        if (Math.abs(dx) > Math.abs(dy)) targetC += (dx > 0) ? 1 : -1;
        else targetR += (dy > 0) ? 1 : -1;
        
        if (targetC >= 0 && targetC < COLS && targetR >= 0 && targetR < ROWS) {
            AudioSys.swap();
            state = 'ANIMATING';
            swapInGrid(dragStart.c, dragStart.r, targetC, targetR);
            
            actionQueue.push({
                type: 'CHECK_SWAP',
                c1: dragStart.c, r1: dragStart.r, c2: targetC, r2: targetR
            });
        }
        dragStart = null;
    }
});

canvas.addEventListener('pointerup', () => dragStart = null);
canvas.addEventListener('pointerleave', () => dragStart = null);
canvas.addEventListener('touchstart', e => e.preventDefault(), {passive:false});
canvas.addEventListener('touchmove', e => e.preventDefault(), {passive:false});

// --- Game Loop ---
function update(dt) {
    if (state === 'PAUSED' || state === 'MENU') return;
    
    if (shakeTime > 0) { shakeTime -= dt; shakeIntensity *= 0.9; }
    
    particles.forEach(p => { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 800 * dt; p.life -= dt * 2; p.r *= 0.9; });
    particles = particles.filter(p => p.life > 0);
    
    floatingTexts.forEach(ft => { ft.y -= dt * 60; ft.life -= dt * 1.5; });
    floatingTexts = floatingTexts.filter(ft => ft.life > 0);
    
    let allSettled = true;
    for(let c=0; c<COLS; c++) {
        for(let r=0; r<ROWS; r++) {
            let b = grid[c][r];
            if (!b) continue;
            if (b.punch > 0) b.punch = Math.max(0, b.punch - dt * 3);
            
            const dx = b.targetX - b.x;
            const dy = b.targetY - b.y;
            
            if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { 
                b.x += dx * 18 * dt; b.y += dy * 18 * dt; 
                allSettled = false; 
            } else { b.x = b.targetX; b.y = b.targetY; }
            
            if (b.scale > 1) { b.scale = Math.max(1, b.scale - 3 * dt); allSettled = false; } 
            else if (b.scale < 1) { b.scale = Math.min(1, b.scale + 3 * dt); allSettled = false; }
        }
    }
    
    if (allSettled && state === 'ANIMATING') {
        if (actionQueue.length > 0) {
            let action = actionQueue.shift();
            if (action.type === 'CHECK_SWAP') {
                let hasMatch = processMatches(action.c2, action.r2); // Prioritize block user moved
                if (!hasMatch) hasMatch = processMatches(action.c1, action.r1); // Check the other swapped block
                
                if (hasMatch) {
                    actionQueue.push({ type: 'APPLY_GRAVITY' });
                } else {
                    AudioSys.error();
                    swapInGrid(action.c1, action.r1, action.c2, action.r2); // Swap back!
                }
            } else if (action.type === 'APPLY_GRAVITY') {
                applyGravity();
                actionQueue.push({ type: 'CHECK_BOARD' });
            } else if (action.type === 'CHECK_BOARD') {
                if (processMatches()) {
                    actionQueue.push({ type: 'APPLY_GRAVITY' }); // Chain reactions!
                } else {
                    if (checkGameOver()) setTimeout(() => showMenu(true), 500);
                    else state = 'PLAYING';
                }
            }
        } else {
            state = 'PLAYING';
        }
    }
}

function draw() {
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (shakeTime > 0) { ctx.translate((Math.random()-0.5)*shakeIntensity, (Math.random()-0.5)*shakeIntensity); }
    
    for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
            ctx.fillStyle = 'rgba(0,0,0,0.15)';
            ctx.beginPath(); ctx.roundRect(getTargetX(c), getTargetY(r), CW, CH, 16); ctx.fill();
        }
    }

    ctx.save(); ctx.globalCompositeOperation = 'screen';
    particles.forEach(p => { 
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); 
        ctx.fillStyle = p.color; ctx.globalAlpha = p.life; ctx.fill(); 
    });
    ctx.restore();

    for(let c=0; c<COLS; c++) {
        for(let r=0; r<ROWS; r++) {
            let b = grid[c][r];
            if (!b) continue;
            
            ctx.save(); ctx.translate(b.x + CW/2, b.y + CH/2);
            if (b.punch > 0) ctx.rotate(Math.sin(performance.now() * 0.05) * b.punch);
            ctx.scale(b.scale, b.scale);
            const color = getBlockColor(b.val);
            
            ctx.fillStyle = color; 
            ctx.beginPath(); ctx.roundRect(-CW/2, -CH/2, CW, CH, 16); ctx.fill();
            
            // Smooth premium gradient overlay (no harsh lines)
            const grad = ctx.createLinearGradient(0, -CH/2, 0, CH/2);
            grad.addColorStop(0, 'rgba(255,255,255,0.25)');
            grad.addColorStop(1, 'rgba(0,0,0,0.15)');
            ctx.fillStyle = grad;
            ctx.fill();
            
            // Number Text
            ctx.fillStyle = '#ffffff'; ctx.font = `900 ${Math.max(20, CW * 0.45)}px Outfit`;
            ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; 
            ctx.shadowColor = 'rgba(0,0,0,0.3)'; ctx.shadowBlur = 4;
            ctx.fillText(b.val, 0, 2); 
            ctx.shadowBlur = 0;
            ctx.restore();
        }
    }

    floatingTexts.forEach(ft => {
        ctx.save(); ctx.globalAlpha = Math.max(0, ft.life); 
        ctx.fillStyle = ft.color || '#f8fafc'; ctx.font = `900 ${ft.size || 18}px Outfit`; 
        ctx.textAlign = 'center'; ctx.shadowColor = '#000000'; ctx.shadowBlur = 6;
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
