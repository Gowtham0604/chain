const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const app = document.getElementById('app');

// --- Audio System ---
const AudioSys = {
    ctx: null,
    muted: false,
    
    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    },
    
    playTone(freq, type, duration, vol = 0.1) {
        if (this.muted || !this.ctx) return;
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
        
        gain.gain.setValueAtTime(vol, this.ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + duration);
        
        osc.connect(gain);
        gain.connect(this.ctx.destination);
        osc.start();
        osc.stop(this.ctx.currentTime + duration);
    },
    
    shoot() { this.playTone(300, 'sine', 0.1, 0.05); },
    bounce() { this.playTone(600, 'triangle', 0.05, 0.02); },
    hit() { this.playTone(150, 'square', 0.1, 0.05); },
    explode(chainLevel) {
        // Pitch increases with chain level
        const freq = 100 + (chainLevel * 50);
        this.playTone(freq, 'sawtooth', 0.3, 0.15);
        setTimeout(() => this.playTone(freq/2, 'square', 0.4, 0.1), 50);
    },
    gameOver() {
        this.playTone(150, 'sawtooth', 0.5, 0.3);
        setTimeout(() => this.playTone(100, 'square', 0.8, 0.3), 200);
    }
};

const audioBtn = document.getElementById('toggleAudioBtn');
audioBtn.addEventListener('click', () => {
    AudioSys.muted = !AudioSys.muted;
    audioBtn.innerText = AudioSys.muted ? '🔇 AUDIO: OFF' : '🔊 AUDIO: ON';
    if (!AudioSys.muted) AudioSys.init();
});

// --- Game Variables ---
const COLS = 6;
const PAD = 8;
let W, H, CW, CH, BOARD_TOP, CANNON_Y, MAX_ROWS;
let dpr = window.devicePixelRatio || 1;

let state = 'MENU';
let score = 0, wave = 1, ballsToShoot = 1;
let cannonX = 0;
let blocks = [], balls = [], particles = [], shockwaves = [], floatingTexts = [];
let isDragging = false, aimX = 0, aimY = 0;
let firstBallLanded = false;
let shootInterval = null;

// Camera Shake
let shakeTime = 0;
let shakeIntensity = 0;

function shakeCamera(intensity, duration) {
    shakeIntensity = intensity;
    shakeTime = duration;
}

// Leaderboard
let lb = JSON.parse(localStorage.getItem('cb_lb') || '[]');
let pname = '';
document.getElementById('nameInput').value = localStorage.getItem('cb_name') || '';

// --- Layout & Resize ---
let lastW = 0;
function resize() {
    const rect = app.getBoundingClientRect();
    if (lastW === rect.width && Math.abs(H - rect.height) < 100) return;
    lastW = rect.width;
    
    W = rect.width; H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    
    CW = (W - PAD * (COLS + 1)) / COLS;
    CH = CW;
    BOARD_TOP = 100;
    CANNON_Y = H - 80;
    MAX_ROWS = Math.floor((CANNON_Y - BOARD_TOP - 40) / (CH + PAD));
    
    blocks.forEach(b => {
        b.x = PAD + b.col * (CW + PAD);
        b.targetY = getTargetY(b.row);
        if (state !== 'ANIMATING') b.y = b.targetY;
    });
    
    if (state === 'MENU') cannonX = W/2;
}
window.addEventListener('resize', resize);
resize();

function getTargetY(row) { return BOARD_TOP + row * (CH + PAD); }
function getBlockColor(hp) {
    const colors = ['#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e', '#f59e0b', '#10b981'];
    return colors[(hp - 1) % colors.length];
}

// --- Ball Class ---
class Ball {
    constructor(x, y, vx, vy) {
        this.x = x; this.y = y;
        this.vx = vx; this.vy = vy;
        this.r = 6;
        this.active = true;
        this.returning = false;
        this.trail = [];
    }
    recall() {
        if (!this.returning) {
            this.returning = true;
            this.y = CANNON_Y; 
            this.vx = 0; this.vy = 0;
        }
    }
    update(dt) {
        if (!this.active) return;
        
        this.trail.push({x: this.x, y: this.y});
        if (this.trail.length > 8) this.trail.shift();

        if (this.returning) {
            const dx = cannonX - this.x;
            const speed = 2000 * dt; // Fast return
            if (Math.abs(dx) <= speed) {
                this.x = cannonX;
                this.active = false;
            } else {
                this.x += Math.sign(dx) * speed;
            }
            return;
        }

        const steps = 4; // High precision collision
        const subDt = dt / steps;
        
        for(let s=0; s<steps; s++) {
            let nx = this.x + this.vx * subDt;
            let ny = this.y + this.vy * subDt;
            
            // Wall Bounces
            if (nx - this.r < 0) { nx = this.r; this.vx *= -1; AudioSys.bounce(); }
            if (nx + this.r > W) { nx = W - this.r; this.vx *= -1; AudioSys.bounce(); }
            if (ny - this.r < 0) { ny = this.r; this.vy *= -1; AudioSys.bounce(); }
            
            // Floor Return
            if (ny + this.r > CANNON_Y) {
                this.y = CANNON_Y; this.vy = 0; this.vx = 0; this.returning = true;
                if (!firstBallLanded) {
                    firstBallLanded = true;
                    cannonX = Math.max(this.r, Math.min(W - this.r, nx));
                }
                break;
            }

            // Block Collision
            let hit = false;
            for (let b of blocks) {
                if (b.exploding || b.hp <= 0 || b.markedForDeletion) continue;
                
                let testX = nx, testY = ny;
                if (nx < b.x) testX = b.x; else if (nx > b.x + CW) testX = b.x + CW;
                if (ny < b.y) testY = b.y; else if (ny > b.y + CH) testY = b.y + CH;
                
                const distX = nx - testX, distY = ny - testY;
                const distance = Math.sqrt(distX*distX + distY*distY);
                
                if (distance <= this.r) {
                    hit = true;
                    if (Math.abs(distX) > Math.abs(distY)) {
                        this.vx *= -1; nx += Math.sign(distX||1) * (this.r - distance + 1); 
                        this.vy += (Math.random() - 0.5) * 50; 
                    } else {
                        this.vy *= -1; ny += Math.sign(distY||1) * (this.r - distance + 1); 
                        this.vx += (Math.random() - 0.5) * 50; 
                    }
                    const spd = Math.sqrt(this.vx*this.vx + this.vy*this.vy);
                    this.vx = (this.vx / spd) * 1000; // Constant speed
                    this.vy = (this.vy / spd) * 1000;
                    
                    b.hp--; score++; updateHUD(); b.punch = 0.25;
                    AudioSys.hit();
                    
                    // Small particles on hit
                    spawnParticles(nx, ny, getBlockColor(b.maxHp), 3, 100, 2);

                    if (b.hp <= 0) triggerExplosion(b, 0);
                    break;
                }
            }
            if (!this.returning) { this.x = nx; this.y = ny; }
        }
    }
    
    draw(ctx) {
        if (!this.active && !this.returning && state === 'SHOOTING') return;
        
        // Draw Trail
        if (this.trail.length > 1) {
            ctx.beginPath(); 
            ctx.moveTo(this.trail[0].x, this.trail[0].y);
            for(let i=1; i<this.trail.length; i++) {
                ctx.lineTo(this.trail[i].x, this.trail[i].y);
            }
            ctx.strokeStyle = 'rgba(6, 182, 212, 0.5)'; 
            ctx.lineWidth = this.r * 1.5; 
            ctx.lineCap = 'round'; 
            ctx.lineJoin = 'round';
            ctx.stroke();
        }
        
        // Draw Ball
        ctx.beginPath(); 
        ctx.arc(this.x, this.y, this.r, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff'; 
        ctx.shadowColor = '#06b6d4'; 
        ctx.shadowBlur = 15; 
        ctx.fill(); 
        ctx.shadowBlur = 0;
    }
}

// --- Visual Effects ---
function spawnParticles(x, y, color, count, speed, r) {
    for(let i=0; i<count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const v = speed * 0.5 + Math.random() * speed;
        particles.push({ 
            x, y, 
            vx: Math.cos(angle) * v, 
            vy: Math.sin(angle) * v, 
            life: 1, 
            color: color, 
            r: r + Math.random() * r 
        });
    }
}

function triggerExplosion(b, chainLevel) {
    if (b.exploding) return;
    b.exploding = true; b.markedForDeletion = true;
    
    AudioSys.explode(chainLevel);
    
    if (chainLevel > 1) shakeCamera(chainLevel * 2, 0.2); // Screen shake for big combos
    
    const addScore = b.maxHp * 10 * (chainLevel + 1);
    score += addScore; updateHUD();
    floatingTexts.push({x: b.x + CW/2, y: b.y, text: `+${addScore}`, life: 1, chain: chainLevel > 1});

    const color = getBlockColor(b.maxHp);
    spawnParticles(b.x + CW/2, b.y + CH/2, color, 20, 250, 4);
    shockwaves.push({x: b.x + CW/2, y: b.y + CH/2, r: 10, maxR: CW * 3, life: 1, color: color});

    // Chain Reaction logic
    blocks.forEach(nb => {
        if (nb.exploding || nb.markedForDeletion) return;
        const dist = Math.sqrt(Math.pow((nb.x+CW/2)-(b.x+CW/2), 2) + Math.pow((nb.y+CH/2)-(b.y+CH/2), 2));
        if (dist < CW * 1.8) {
            setTimeout(() => { if (state !== 'MENU') triggerExplosion(nb, chainLevel + 1); }, 100 + Math.random() * 50);
        }
    });
    blocks = blocks.filter(x => !x.markedForDeletion);
}

// --- Game Logic ---
function spawnRow() {
    const numBlocks = Math.floor(Math.random() * 4) + 2;
    const cols = Array.from({length: COLS}, (_, i) => i).sort(() => Math.random() - 0.5);
    for(let i=0; i<numBlocks; i++) {
        const hp = wave + Math.floor(Math.random() * (wave * 0.5));
        blocks.push({
            col: cols[i], row: 0, 
            x: PAD + cols[i] * (CW + PAD), y: -CH, targetY: getTargetY(0),
            hp: Math.max(1, hp), maxHp: Math.max(1, hp), 
            exploding: false, scale: 0, punch: 0
        });
    }
}

function updateHUD() {
    document.getElementById('scoreEl').innerText = score;
    document.getElementById('waveEl').innerText = wave;
}

function renderLeaderboard() {
    const lbEl = document.getElementById('leaderboard');
    if (lb.length === 0) { lbEl.innerHTML = '<div style="text-align:center; color: var(--text-muted); padding: 1rem; font-size: 0.8rem;">NO LOGS FOUND</div>'; return; }
    lbEl.innerHTML = lb.map((entry, i) => `
        <div class="lb-row ${entry.name===pname && entry.score===score && state==='MENU' ? 'highlight' : ''}">
            <div style="display:flex; gap: 1rem;">
                <span class="rank">${i+1}</span>
                <span class="name">${entry.name || 'GHOST'}</span>
            </div>
            <span class="score">${entry.score.toLocaleString()}</span>
        </div>
    `).join('');
}

function showMenu(isGameOver = false) {
    const menu = document.getElementById('menu'), title = document.getElementById('menuTitle');
    const desc = document.getElementById('menuDesc'), btn = document.getElementById('startBtn');
    
    if (isGameOver) {
        AudioSys.gameOver();
        title.innerHTML = 'HULL BREACH';
        title.style.background = 'linear-gradient(135deg, #f43f5e, #fb923c)';
        title.style.webkitBackgroundClip = 'text';
        title.style.filter = 'drop-shadow(0 0 25px rgba(244,63,94,0.6))';
        desc.innerHTML = `You reached Wave <span class="highlight-text">${wave}</span> and scored <span class="highlight-text">${score}</span>.`;
        btn.innerText = 'REDEPLOY';
        
        pname = document.getElementById('nameInput').value.trim();
        localStorage.setItem('cb_name', pname);
        lb.push({name: pname.toUpperCase() || 'GHOST', score}); 
        lb.sort((a,b) => b.score - a.score); 
        lb = lb.slice(0, 10);
        localStorage.setItem('cb_lb', JSON.stringify(lb));
    } else {
        title.innerHTML = 'CHAIN<br>BLAST';
        title.style.background = 'linear-gradient(135deg, #22d3ee, #a855f7)';
        title.style.webkitBackgroundClip = 'text';
        title.style.filter = 'drop-shadow(0 0 25px rgba(168,85,247,0.4))';
    }
    
    renderLeaderboard();
    menu.classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
}

document.getElementById('startBtn').addEventListener('click', () => {
    AudioSys.init();
    pname = document.getElementById('nameInput').value.trim();
    localStorage.setItem('cb_name', pname);
    
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    startGame();
});

function startGame() {
    score = 0; wave = 1; ballsToShoot = 1; 
    blocks = []; balls = []; particles = []; shockwaves = []; floatingTexts = [];
    cannonX = W / 2; firstBallLanded = false;
    
    if (shootInterval) clearInterval(shootInterval);
    updateHUD(); 
    
    // Spawn initial layout
    spawnRow();
    for(let i=0; i<2; i++) {
        blocks.forEach(b => { b.row++; b.targetY = getTargetY(b.row); b.y = b.targetY; b.scale = 1; });
        spawnRow();
    }
    blocks.forEach(b => { b.scale = 1; b.y = b.targetY; });
    state = 'AIMING';
}

function shootBalls(nx, ny) {
    state = 'SHOOTING'; firstBallLanded = false; let launched = 0;
    
    floatingTexts.push({x: W/2, y: CANNON_Y - 40, text: 'Tap to recall', life: 2});
    
    shootInterval = setInterval(() => {
        AudioSys.shoot();
        balls.push(new Ball(cannonX, CANNON_Y, nx * 1000, ny * 1000));
        launched++;
        if (launched >= ballsToShoot) clearInterval(shootInterval);
    }, 90);
}

// --- Inputs ---
canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    AudioSys.init();
    if (state === 'SHOOTING') {
        balls.forEach(b => b.recall());
        if (!firstBallLanded) { firstBallLanded = true; cannonX = W/2; }
        if (shootInterval) clearInterval(shootInterval);
        return;
    }
    if (state !== 'AIMING') return;
    const rect = canvas.getBoundingClientRect();
    aimX = (e.clientX - rect.left) * (W / rect.width); 
    aimY = (e.clientY - rect.top) * (H / rect.height);
    isDragging = true;
});

canvas.addEventListener('pointermove', e => {
    e.preventDefault();
    if (!isDragging || state !== 'AIMING') return;
    const rect = canvas.getBoundingClientRect();
    aimX = (e.clientX - rect.left) * (W / rect.width); 
    aimY = (e.clientY - rect.top) * (H / rect.height);
});

canvas.addEventListener('pointerup', e => {
    e.preventDefault();
    if (!isDragging || state !== 'AIMING') return;
    isDragging = false;
    const dx = aimX - cannonX, dy = aimY - CANNON_Y, dist = Math.sqrt(dx*dx + dy*dy);
    if (dist < 20 || dy > -20) return; // Ignore slight taps or aiming downwards
    shootBalls(dx/dist, dy/dist);
});

canvas.addEventListener('pointerleave', () => isDragging = false);

// --- Game Loop ---
function update(dt) {
    // Camera Shake decay
    if (shakeTime > 0) {
        shakeTime -= dt;
        shakeIntensity *= 0.9;
    }
    
    blocks.forEach(b => { if (b.punch > 0) b.punch = Math.max(0, b.punch - dt * 3); });
    
    particles.forEach(p => { 
        p.x += p.vx * dt; p.y += p.vy * dt; 
        p.vy += 600 * dt; // Gravity 
        p.life -= dt * 1.5; p.r *= 0.95; 
    });
    particles = particles.filter(p => p.life > 0);
    
    shockwaves.forEach(sw => { 
        sw.r += (sw.maxR - sw.r) * dt * 10; 
        sw.life -= dt * 3; 
    });
    shockwaves = shockwaves.filter(sw => sw.life > 0);
    
    floatingTexts.forEach(ft => { 
        ft.y -= dt * 80; 
        ft.life -= dt * 1.5; 
    });
    floatingTexts = floatingTexts.filter(ft => ft.life > 0);

    if (state === 'AIMING' && blocks.length === 0) {
        wave++; ballsToShoot++; score += 1000 * wave; 
        updateHUD(); spawnRow(); state = 'ANIMATING';
        floatingTexts.push({x: W/2, y: H/2, text: 'CLEAR BONUS!', life: 2, chain: true});
        AudioSys.explode(3);
    }

    if (state === 'SHOOTING') {
        if (balls.length > 0 && balls.every(b => !b.active)) {
            balls = []; wave++; ballsToShoot++; updateHUD();
            blocks.forEach(b => { b.row++; b.targetY = getTargetY(b.row); });
            spawnRow(); state = 'ANIMATING';
        }
    }

    if (state === 'ANIMATING') {
        let allSettled = true;
        blocks.forEach(b => {
            const dy = b.targetY - b.y;
            if (Math.abs(dy) > 0.5) { 
                b.y += dy * 12 * dt; 
                allSettled = false; 
            } else {
                b.y = b.targetY;
            }
            
            if (b.scale < 1) { 
                b.scale = Math.min(1, b.scale + 5 * dt); 
                allSettled = false; 
            }
        });
        if (allSettled) {
            if (blocks.some(b => b.row >= MAX_ROWS)) { 
                state = 'MENU'; showMenu(true); 
            } else {
                state = 'AIMING';
            }
        }
    }

    balls.forEach(b => b.update(dt));
}

function draw() {
    ctx.clearRect(0, 0, W, H);
    
    ctx.save();
    // Apply Camera Shake
    if (shakeTime > 0) {
        const dx = (Math.random() - 0.5) * shakeIntensity;
        const dy = (Math.random() - 0.5) * shakeIntensity;
        ctx.translate(dx, dy);
    }
    
    // Grid lines
    ctx.strokeStyle = 'rgba(255,255,255,0.03)'; 
    ctx.lineWidth = 1; 
    ctx.beginPath();
    for(let i=0; i<=COLS; i++) { 
        const x = PAD + i * (CW + PAD); 
        ctx.moveTo(x, BOARD_TOP); 
        ctx.lineTo(x, CANNON_Y); 
    }
    ctx.stroke();

    // Danger Line
    const dangerY = getTargetY(MAX_ROWS - 1);
    ctx.setLineDash([10, 10]); 
    ctx.strokeStyle = 'rgba(244, 63, 94, 0.4)'; 
    ctx.beginPath(); 
    ctx.moveTo(0, dangerY + CH); 
    ctx.lineTo(W, dangerY + CH); 
    ctx.stroke(); 
    ctx.setLineDash([]);

    // Shockwaves & Particles (Additive blending for glow)
    ctx.save(); 
    ctx.globalCompositeOperation = 'screen';
    shockwaves.forEach(sw => { 
        ctx.beginPath(); 
        ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2); 
        ctx.strokeStyle = sw.color; 
        ctx.globalAlpha = sw.life; 
        ctx.lineWidth = 4; 
        ctx.stroke(); 
    });
    particles.forEach(p => { 
        ctx.beginPath(); 
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); 
        ctx.fillStyle = p.color; 
        ctx.globalAlpha = p.life; 
        ctx.fill(); 
    });
    ctx.restore();

    // Blocks
    blocks.forEach(b => {
        if (b.exploding || b.markedForDeletion) return;
        ctx.save(); 
        ctx.translate(b.x + CW/2, b.y + CH/2);
        
        // Punch scale effect
        const s = b.scale - b.punch; 
        ctx.scale(s, s);
        
        const color = getBlockColor(b.maxHp);
        
        // Block Body
        ctx.fillStyle = 'rgba(15, 23, 42, 0.9)'; 
        ctx.beginPath(); 
        ctx.roundRect(-CW/2, -CH/2, CW, CH, 12); 
        ctx.fill();
        
        // Glass highlight
        ctx.fillStyle = 'rgba(255,255,255,0.1)'; 
        ctx.beginPath(); 
        ctx.roundRect(-CW/2, -CH/2, CW, CH/2, {tl: 12, tr: 12, bl: 0, br: 0}); 
        ctx.fill();
        
        // Neon Border
        ctx.strokeStyle = color; 
        ctx.lineWidth = 3; 
        ctx.shadowColor = color;
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0; // reset
        
        // Health fill
        ctx.fillStyle = color; 
        ctx.globalAlpha = 0.15 + 0.6 * Math.max(0, b.hp / b.maxHp);
        ctx.beginPath(); 
        ctx.roundRect(-CW/2 + 3, -CH/2 + 3, CW - 6, CH - 6, 8); 
        ctx.fill(); 
        ctx.globalAlpha = 1;
        
        // Text
        ctx.fillStyle = '#ffffff'; 
        ctx.font = `900 ${Math.max(16, CW * 0.45)}px Outfit`;
        ctx.textAlign = 'center'; 
        ctx.textBaseline = 'middle'; 
        ctx.shadowColor = '#000000'; 
        ctx.shadowBlur = 4;
        ctx.fillText(Math.ceil(b.hp), 0, 2); 
        
        ctx.restore();
    });

    // Cannon
    ctx.fillStyle = '#06b6d4'; 
    ctx.beginPath(); 
    ctx.arc(cannonX, CANNON_Y, 10, 0, Math.PI * 2);
    ctx.shadowColor = '#06b6d4'; 
    ctx.shadowBlur = 20; 
    ctx.fill(); 
    ctx.shadowBlur = 0;

    // Ball count above cannon
    if (state === 'AIMING' || state === 'ANIMATING') {
        ctx.fillStyle = '#f8fafc'; 
        ctx.font = '800 14px Outfit'; 
        ctx.textAlign = 'center';
        ctx.shadowColor = '#000000';
        ctx.shadowBlur = 4;
        ctx.fillText(`x${ballsToShoot}`, cannonX, CANNON_Y + 28);
    }

    balls.forEach(b => b.draw(ctx));

    // Aiming line
    if (state === 'AIMING' && isDragging) {
        const dx = aimX - cannonX, dy = aimY - CANNON_Y, dist = Math.sqrt(dx*dx + dy*dy);
        if (dist > 20 && dy < -20) {
            let px = cannonX, py = CANNON_Y, pvx = dx/dist, pvy = dy/dist;
            ctx.save(); 
            ctx.strokeStyle = 'rgba(6, 182, 212, 0.8)'; 
            ctx.lineWidth = 3; 
            ctx.setLineDash([10, 10]);
            ctx.beginPath(); 
            ctx.moveTo(px, py);
            
            // Predict bounces
            for(let i=0; i<3; i++) {
                let tHit = Infinity;
                if (pvy < 0) tHit = Math.min(tHit, (6 - py) / pvy);
                if (pvx < 0) tHit = Math.min(tHit, (6 - px) / pvx);
                if (pvx > 0) tHit = Math.min(tHit, (W - 6 - px) / pvx);
                
                if (tHit === Infinity) break;
                px += pvx * tHit; py += pvy * tHit; 
                ctx.lineTo(px, py);
                if (py <= 6) pvy *= -1; else pvx *= -1;
            }
            ctx.shadowColor = '#06b6d4';
            ctx.shadowBlur = 10;
            ctx.stroke(); 
            ctx.restore();
        }
    }

    // Floating Texts
    floatingTexts.forEach(ft => {
        ctx.save(); 
        ctx.globalAlpha = Math.max(0, ft.life); 
        ctx.fillStyle = ft.chain ? '#f43f5e' : '#f8fafc';
        ctx.font = `900 ${ft.chain ? '24px' : '18px'} Outfit`; 
        ctx.textAlign = 'center'; 
        ctx.shadowColor = '#000000'; 
        ctx.shadowBlur = 5;
        ctx.fillText(ft.text, ft.x, ft.y); 
        ctx.restore();
    });
    
    ctx.restore(); // Restore camera shake translation
}

let lastTime = 0;
requestAnimationFrame(function loop(timestamp) {
    requestAnimationFrame(loop);
    if (!lastTime) { lastTime = timestamp; return; }
    let dt = (timestamp - lastTime) / 1000;
    lastTime = timestamp;
    if (dt > 0.1) dt = 0.1; // Cap dt for lag spikes
    update(dt); 
    draw();
});
