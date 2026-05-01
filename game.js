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
    shoot() { this.playTone(400, 'sine', 0.1, 0.05); },
    bounce() { this.playTone(800, 'triangle', 0.05, 0.02); },
    hit() { this.playTone(200, 'square', 0.1, 0.05); },
    collectItem() { this.playTone(1200, 'sine', 0.2, 0.1); setTimeout(()=>this.playTone(1600, 'sine', 0.3, 0.1), 100); },
    explode(chainLevel) {
        const freq = 100 + (Math.min(chainLevel, 10) * 40);
        this.playTone(freq, 'sawtooth', 0.3, 0.15);
        setTimeout(() => this.playTone(freq/2, 'square', 0.4, 0.1), 50);
    },
    gameOver() {
        this.playTone(150, 'sawtooth', 0.5, 0.3);
        setTimeout(() => this.playTone(100, 'square', 0.8, 0.3), 200);
    }
};

document.getElementById('toggleAudioBtn').addEventListener('click', (e) => {
    AudioSys.muted = !AudioSys.muted;
    e.target.innerText = AudioSys.muted ? '🔇 AUDIO: OFF' : '🔊 AUDIO: ON';
    if (!AudioSys.muted) AudioSys.init();
});

// --- Game Constants & State ---
const COLS = 7;
const PAD = 6;
const BALL_SPEED = 1200;
const BALL_RADIUS = 5;

let W, H, CW, CH, BOARD_TOP, CANNON_Y, MAX_ROWS;
let dpr = window.devicePixelRatio || 1;

let state = 'MENU'; // MENU, AIMING, SHOOTING, PLAYING, ANIMATING
let score = 0, wave = 1;
let ballsTotal = 1;
let ballsInCannon = 1;
let ballsEarned = 0;
let cannonX = 0;

let blocks = [];
let items = [];
let balls = [];
let particles = [];
let shockwaves = [];
let floatingTexts = [];

let isDragging = false;
let aimVector = {x: 0, y: -1};
let firstBallLanded = false;
let shootInterval = null;
let fastForward = false;

// Camera Shake
let shakeTime = 0, shakeIntensity = 0;
function shakeCamera(intensity, duration) { shakeIntensity = intensity; shakeTime = duration; }

// Leaderboard
const LB_KEY = 'chain_blast_pro_lb';
let lb = JSON.parse(localStorage.getItem(LB_KEY) || '[]');
document.getElementById('nameInput').value = localStorage.getItem('cb_name') || '';

// --- Layout & Resize ---
function resize() {
    const rect = app.getBoundingClientRect();
    W = rect.width; H = rect.height;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    
    CW = (W - PAD * (COLS + 1)) / COLS;
    CH = CW;
    BOARD_TOP = 110;
    CANNON_Y = H - 60;
    MAX_ROWS = Math.floor((CANNON_Y - BOARD_TOP - 40) / (CH + PAD));
    
    if (state === 'MENU') cannonX = W/2;
}
window.addEventListener('resize', resize);
resize();

function getTargetY(row) { return BOARD_TOP + row * (CH + PAD); }
function getBlockColor(hp) {
    const colors = ['#06b6d4', '#3b82f6', '#8b5cf6', '#d946ef', '#f43f5e', '#f59e0b', '#10b981'];
    return colors[(hp - 1) % colors.length];
}

// --- Classes ---
class Ball {
    constructor(x, y, vx, vy) {
        this.x = x; this.y = y;
        this.vx = vx; this.vy = vy;
        this.active = true;
        this.returning = false;
        this.trail = [];
    }
    recall() {
        if (!this.returning) {
            this.returning = true;
            this.y = CANNON_Y; this.vx = 0; this.vy = 0;
        }
    }
    update(dt) {
        if (!this.active) return;
        
        this.trail.push({x: this.x, y: this.y});
        if (this.trail.length > 8) this.trail.shift();

        if (this.returning) {
            const dx = cannonX - this.x;
            const speed = 2500 * dt; 
            if (Math.abs(dx) <= speed) {
                this.x = cannonX; this.active = false;
            } else {
                this.x += Math.sign(dx) * speed;
            }
            return;
        }

        const steps = 4; 
        const subDt = (fastForward ? dt * 2.5 : dt) / steps;
        
        for(let s=0; s<steps; s++) {
            let nx = this.x + this.vx * subDt;
            let ny = this.y + this.vy * subDt;
            
            // Walls
            if (nx - BALL_RADIUS < 0) { nx = BALL_RADIUS; this.vx *= -1; AudioSys.bounce(); }
            if (nx + BALL_RADIUS > W) { nx = W - BALL_RADIUS; this.vx *= -1; AudioSys.bounce(); }
            if (ny - BALL_RADIUS < 0) { ny = BALL_RADIUS; this.vy *= -1; AudioSys.bounce(); }
            
            // Floor
            if (ny + BALL_RADIUS > CANNON_Y) {
                this.y = CANNON_Y; this.x = nx; this.vy = 0; this.vx = 0; this.returning = true;
                if (!firstBallLanded) {
                    firstBallLanded = true;
                    cannonX = Math.max(BALL_RADIUS, Math.min(W - BALL_RADIUS, nx));
                }
                break;
            }

            // Blocks Collision (AABB vs Circle)
            let hit = false;
            for (let b of blocks) {
                if (b.exploding || b.hp <= 0) continue;
                
                let testX = nx, testY = ny;
                if (nx < b.x) testX = b.x; else if (nx > b.x + CW) testX = b.x + CW;
                if (ny < b.y) testY = b.y; else if (ny > b.y + CH) testY = b.y + CH;
                
                const distX = nx - testX, distY = ny - testY;
                const distance = Math.sqrt(distX*distX + distY*distY);
                
                if (distance <= BALL_RADIUS) {
                    // Push out
                    const pen = BALL_RADIUS - distance + 0.1;
                    if (distance === 0) { this.vy *= -1; ny -= BALL_RADIUS; } // Failsafe
                    else {
                        nx += (distX/distance) * pen;
                        ny += (distY/distance) * pen;
                    }
                    
                    // Only bounce and deal damage if the ball is moving TOWARDS the block
                    const dot = this.vx * distX + this.vy * distY;
                    if (dot < 0 || distance === 0) {
                        // Bounce
                        if (Math.abs(distX) > Math.abs(distY)) {
                            this.vx *= -1; 
                            this.vy += (Math.random()-0.5)*100; // prevent infinite horizontal loops
                        } else {
                            this.vy *= -1; 
                            this.vx += (Math.random()-0.5)*100;
                        }
                        
                        const spd = Math.sqrt(this.vx*this.vx + this.vy*this.vy);
                        this.vx = (this.vx / spd) * BALL_SPEED;
                        this.vy = (this.vy / spd) * BALL_SPEED;
                        
                        b.hp--; score++; updateHUD(); b.punch = 0.3;
                        AudioSys.hit();
                        spawnParticles(nx, ny, getBlockColor(b.maxHp), 3, 150, 2);

                        if (b.hp <= 0) triggerExplosion(b, 1);
                    }
                    
                    hit = true;
                    break;
                }
            }
            
            // Items Collection
            if (!hit) {
                for (let item of items) {
                    if (!item.active) continue;
                    const dx = nx - item.x; const dy = ny - item.y;
                    if (Math.sqrt(dx*dx + dy*dy) < BALL_RADIUS + item.r) {
                        item.active = false;
                        ballsEarned++;
                        AudioSys.collectItem();
                        spawnParticles(item.x, item.y, '#10b981', 15, 150, 3);
                        floatingTexts.push({x: item.x, y: item.y, text: '+1 BALL', life: 1.5, color: '#10b981'});
                    }
                }
            }

            if (!this.returning && !hit) { this.x = nx; this.y = ny; }
            else if (!this.returning && hit) { this.x = nx; this.y = ny; }
        }
    }
    
    draw(ctx) {
        if (!this.active && !this.returning && (state === 'SHOOTING' || state === 'PLAYING')) return;
        
        if (this.trail.length > 1) {
            ctx.beginPath(); ctx.moveTo(this.trail[0].x, this.trail[0].y);
            for(let i=1; i<this.trail.length; i++) ctx.lineTo(this.trail[i].x, this.trail[i].y);
            ctx.strokeStyle = 'rgba(6, 182, 212, 0.4)'; 
            ctx.lineWidth = BALL_RADIUS * 1.5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.stroke();
        }
        
        ctx.beginPath(); ctx.arc(this.x, this.y, BALL_RADIUS, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff'; ctx.shadowColor = '#06b6d4'; ctx.shadowBlur = 10; 
        ctx.fill(); ctx.shadowBlur = 0;
    }
}

// --- Visual Effects ---
function spawnParticles(x, y, color, count, speed, r) {
    for(let i=0; i<count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const v = speed * 0.3 + Math.random() * speed * 0.7;
        particles.push({ x, y, vx: Math.cos(angle)*v, vy: Math.sin(angle)*v, life: 1, color, r: r + Math.random()*r });
    }
}

function triggerExplosion(b, chainLevel) {
    if (b.exploding) return;
    b.exploding = true; 
    
    AudioSys.explode(chainLevel);
    if (chainLevel > 1) shakeCamera(chainLevel * 2.5, 0.25); 
    
    const chainMult = chainLevel > 1 ? chainLevel : 1;
    const addScore = b.maxHp * 10 * chainMult;
    score += addScore; updateHUD();
    
    floatingTexts.push({
        x: b.x + CW/2, y: b.y, 
        text: chainLevel > 1 ? `CHAIN x${chainLevel}!` : `+${addScore}`, 
        life: 1.5, color: chainLevel > 1 ? '#f43f5e' : '#f8fafc',
        size: chainLevel > 1 ? 24 : 16
    });

    const color = getBlockColor(b.maxHp);
    spawnParticles(b.x + CW/2, b.y + CH/2, color, 25, 300, 4);
    shockwaves.push({x: b.x + CW/2, y: b.y + CH/2, r: 10, maxR: CW * 2.5, life: 1, color: color});

    // CHAIN REACTION: Deal damage to neighbors in radius
    const explosionRadius = CW * 1.8; // Reaches diagonals
    const splashDamage = Math.max(3, Math.floor(b.maxHp * 0.5)); // 50% of max HP as splash damage
    
    blocks.forEach(nb => {
        if (nb.exploding || nb.hp <= 0) return;
        const dist = Math.sqrt(Math.pow((nb.x+CW/2)-(b.x+CW/2), 2) + Math.pow((nb.y+CH/2)-(b.y+CH/2), 2));
        if (dist <= explosionRadius) {
            setTimeout(() => { 
                if (state === 'MENU') return;
                nb.hp -= splashDamage;
                nb.punch = 0.5;
                if (nb.hp <= 0) triggerExplosion(nb, chainLevel + 1);
                else {
                    spawnParticles(nb.x+CW/2, nb.y+CH/2, '#ffffff', 5, 100, 2);
                    floatingTexts.push({x: nb.x+CW/2, y: nb.y-10, text: `-${splashDamage}`, life: 0.8, color: '#f59e0b', size: 12});
                }
            }, 80 + Math.random() * 60); // Staggered explosions
        }
    });
}

// --- Game Logic ---
function spawnRow() {
    const isItemRow = Math.random() > 0.3; // 70% chance to spawn a +1 Ball item
    const numBlocks = Math.floor(Math.random() * 4) + 1 + Math.min(3, Math.floor(wave/10)); // 1-4 blocks, scaling up
    
    let cols = Array.from({length: COLS}, (_, i) => i).sort(() => Math.random() - 0.5);
    
    if (isItemRow) {
        const itemCol = cols.pop();
        items.push({
            col: itemCol, row: 0,
            x: PAD + itemCol * (CW + PAD) + CW/2,
            y: getTargetY(0) - CH*2 + CH/2,
            targetY: getTargetY(0) + CH/2,
            r: 14, active: true
        });
    }

    for(let i=0; i<numBlocks; i++) {
        const col = cols.pop();
        // Base HP = wave. Some blocks have 2x wave HP to encourage chain reactions
        const isTank = Math.random() > 0.8; 
        const hp = Math.max(1, wave + (isTank ? Math.floor(wave * 0.8) : 0));
        
        blocks.push({
            col: col, row: 0, 
            x: PAD + col * (CW + PAD), y: getTargetY(0) - CH*2, targetY: getTargetY(0),
            hp: hp, maxHp: hp, 
            exploding: false, scale: 0, punch: 0
        });
    }
}

function updateHUD() {
    document.getElementById('scoreEl').innerText = score;
    document.getElementById('waveEl').innerText = wave;
}

function showMenu(isGameOver = false) {
    const menu = document.getElementById('menu'), title = document.getElementById('menuTitle');
    const desc = document.getElementById('menuDesc'), btn = document.getElementById('startBtn');
    
    if (isGameOver) {
        AudioSys.gameOver();
        title.innerHTML = 'GAME OVER';
        title.style.background = 'linear-gradient(135deg, #f43f5e, #fb923c)';
        title.style.webkitBackgroundClip = 'text';
        title.style.filter = 'drop-shadow(0 0 25px rgba(244,63,94,0.6))';
        desc.innerHTML = `You survived to Wave <span class="highlight-text">${wave}</span><br>Final Score: <span class="highlight-text">${score}</span>`;
        btn.innerText = 'PLAY AGAIN';
        
        let pname = document.getElementById('nameInput').value.trim() || 'PLAYER';
        localStorage.setItem('cb_name', pname);
        lb.push({name: pname.toUpperCase(), score}); 
        lb.sort((a,b) => b.score - a.score); lb = lb.slice(0, 10);
        localStorage.setItem(LB_KEY, JSON.stringify(lb));
    } else {
        title.innerHTML = 'CHAIN<br>BLAST';
        title.style.background = 'linear-gradient(135deg, #22d3ee, #a855f7)';
        title.style.webkitBackgroundClip = 'text';
        title.style.filter = 'drop-shadow(0 0 25px rgba(168,85,247,0.4))';
    }
    
    // Render Leaderboard
    const lbEl = document.getElementById('leaderboard');
    if (lb.length === 0) lbEl.innerHTML = '<div style="text-align:center;color:#94a3b8;padding:1rem;">NO SCORES YET</div>';
    else {
        lbEl.innerHTML = lb.map((entry, i) => `
            <div class="lb-row">
                <div style="display:flex;gap:1rem;"><span class="rank">${i+1}</span><span class="name">${entry.name}</span></div>
                <span class="score">${entry.score.toLocaleString()}</span>
            </div>
        `).join('');
    }
    
    menu.classList.remove('hidden');
    document.getElementById('hud').classList.add('hidden');
}

document.getElementById('startBtn').addEventListener('click', () => {
    AudioSys.init();
    document.getElementById('menu').classList.add('hidden');
    document.getElementById('hud').classList.remove('hidden');
    startGame();
});

function startGame() {
    score = 0; wave = 1; 
    ballsTotal = 1; ballsInCannon = 1; ballsEarned = 0;
    blocks = []; items = []; balls = []; particles = []; shockwaves = []; floatingTexts = [];
    cannonX = W / 2; firstBallLanded = false; fastForward = false;
    
    if (shootInterval) clearInterval(shootInterval);
    updateHUD(); 
    
    spawnRow(); // Row 1
    blocks.forEach(b => { b.row++; b.targetY = getTargetY(b.row); });
    items.forEach(i => { i.row++; i.targetY = getTargetY(i.row) + CH/2; });
    spawnRow(); // Row 0
    
    state = 'ANIMATING';
}

function shootBalls() {
    state = 'SHOOTING'; firstBallLanded = false; fastForward = false;
    let launched = 0;
    ballsInCannon = ballsTotal;
    
    shootInterval = setInterval(() => {
        AudioSys.shoot();
        balls.push(new Ball(cannonX, CANNON_Y, aimVector.x * BALL_SPEED, aimVector.y * BALL_SPEED));
        launched++;
        ballsInCannon--;
        if (launched >= ballsTotal) {
            clearInterval(shootInterval);
            state = 'PLAYING';
            floatingTexts.push({x: W/2, y: CANNON_Y - 50, text: 'Tap anywhere to FAST FORWARD', life: 2.5, color: '#94a3b8', size: 14});
        }
    }, 100);
}

// --- Intutive Controls (Direct Aiming) ---
function updateAim(e) {
    const rect = canvas.getBoundingClientRect();
    let touchX = e.clientX; let touchY = e.clientY;
    if (e.touches) { touchX = e.touches[0].clientX; touchY = e.touches[0].clientY; }
    
    touchX = (touchX - rect.left) * (W / rect.width);
    touchY = (touchY - rect.top) * (H / rect.height);
    
    let dx = touchX - cannonX;
    let dy = touchY - CANNON_Y;
    
    if (dy > -20) dy = -20; // Prevent aiming downwards or totally flat
    
    const mag = Math.sqrt(dx*dx + dy*dy);
    if (mag > 0) { aimVector.x = dx/mag; aimVector.y = dy/mag; }
}

canvas.addEventListener('pointerdown', e => {
    e.preventDefault();
    AudioSys.init();
    if (state === 'PLAYING') {
        fastForward = true; // Tap while playing fast forwards physics
        return;
    }
    if (state !== 'AIMING') return;
    isDragging = true;
    updateAim(e);
});

canvas.addEventListener('pointermove', e => {
    e.preventDefault();
    if (!isDragging || state !== 'AIMING') return;
    updateAim(e);
});

canvas.addEventListener('pointerup', e => {
    e.preventDefault();
    if (!isDragging || state !== 'AIMING') return;
    isDragging = false;
    shootBalls();
});
canvas.addEventListener('pointerleave', () => isDragging = false);

// Touch equivalents for mobile reliability
canvas.addEventListener('touchstart', e => { if(e.cancelable) e.preventDefault(); AudioSys.init(); if(state==='PLAYING') fastForward=true; else if(state==='AIMING') { isDragging=true; updateAim(e); } }, {passive:false});
canvas.addEventListener('touchmove', e => { if(e.cancelable) e.preventDefault(); if(isDragging && state==='AIMING') updateAim(e); }, {passive:false});
canvas.addEventListener('touchend', e => { if(e.cancelable) e.preventDefault(); if(isDragging && state==='AIMING') { isDragging=false; shootBalls(); } }, {passive:false});


// --- Game Loop ---
function update(dt) {
    if (shakeTime > 0) { shakeTime -= dt; shakeIntensity *= 0.9; }
    
    blocks.forEach(b => { if (b.punch > 0) b.punch = Math.max(0, b.punch - dt * 4); });
    
    particles.forEach(p => { 
        p.x += p.vx * dt; p.y += p.vy * dt; 
        p.vy += 800 * dt; // Gravity 
        p.life -= dt * 1.5; p.r *= 0.95; 
    });
    particles = particles.filter(p => p.life > 0);
    
    shockwaves.forEach(sw => { sw.r += (sw.maxR - sw.r) * dt * 12; sw.life -= dt * 3.5; });
    shockwaves = shockwaves.filter(sw => sw.life > 0);
    
    floatingTexts.forEach(ft => { ft.y -= dt * 60; ft.life -= dt * 1.5; });
    floatingTexts = floatingTexts.filter(ft => ft.life > 0);
    
    items.forEach(i => { i.y += (i.targetY - i.y) * 10 * dt; });

    if (state === 'PLAYING' || state === 'SHOOTING') {
        balls.forEach(b => b.update(dt));
        
        // Remove dead blocks
        blocks = blocks.filter(b => !b.exploding && b.hp > 0);
        
        // If all blocks cleared, massive bonus
        if (blocks.length === 0 && state === 'PLAYING') {
            score += 1000 * wave; updateHUD();
            floatingTexts.push({x: W/2, y: H/2, text: 'BOARD CLEARED! +'+(1000*wave), life: 2.5, color: '#f59e0b', size: 24});
            AudioSys.explode(5);
            balls.forEach(b => b.recall()); // Force recall immediately
        }

        // Check if round over
        if (state === 'PLAYING' && balls.length > 0 && balls.every(b => !b.active)) {
            balls = []; 
            wave++; 
            ballsTotal += ballsEarned;
            ballsInCannon = ballsTotal;
            ballsEarned = 0;
            updateHUD();
            
            blocks.forEach(b => { b.row++; b.targetY = getTargetY(b.row); });
            items = items.filter(i => i.active); // Keep missed items on board
            items.forEach(i => { i.row++; i.targetY = getTargetY(i.row) + CH/2; });
            spawnRow(); 
            state = 'ANIMATING';
        }
    }

    if (state === 'ANIMATING') {
        let allSettled = true;
        blocks.forEach(b => {
            const dy = b.targetY - b.y;
            if (Math.abs(dy) > 0.5) { b.y += dy * 15 * dt; allSettled = false; } else b.y = b.targetY;
            if (b.scale < 1) { b.scale = Math.min(1, b.scale + 6 * dt); allSettled = false; }
        });
        if (allSettled) {
            if (blocks.some(b => b.row >= MAX_ROWS)) { state = 'MENU'; showMenu(true); } 
            else state = 'AIMING';
        }
    }
}

function draw() {
    ctx.clearRect(0, 0, W, H);
    
    ctx.save();
    if (shakeTime > 0) { ctx.translate((Math.random()-0.5)*shakeIntensity, (Math.random()-0.5)*shakeIntensity); }
    
    // Danger Line
    const dangerY = getTargetY(MAX_ROWS - 1);
    ctx.setLineDash([8, 8]); 
    ctx.strokeStyle = 'rgba(244, 63, 94, 0.3)'; 
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, dangerY + CH); ctx.lineTo(W, dangerY + CH); ctx.stroke(); 
    ctx.setLineDash([]);

    // Shockwaves & Particles
    ctx.save(); ctx.globalCompositeOperation = 'screen';
    shockwaves.forEach(sw => { 
        ctx.beginPath(); ctx.arc(sw.x, sw.y, sw.r, 0, Math.PI * 2); 
        ctx.strokeStyle = sw.color; ctx.globalAlpha = sw.life; ctx.lineWidth = 4; ctx.stroke(); 
    });
    particles.forEach(p => { 
        ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); 
        ctx.fillStyle = p.color; ctx.globalAlpha = p.life; ctx.fill(); 
    });
    ctx.restore();

    // Items
    items.forEach(item => {
        if (!item.active) return;
        const pulse = 1 + Math.sin(performance.now()*0.005)*0.15;
        ctx.beginPath(); ctx.arc(item.x, item.y, item.r * pulse, 0, Math.PI*2);
        ctx.fillStyle = 'rgba(16, 185, 129, 0.2)'; ctx.fill();
        ctx.strokeStyle = '#10b981'; ctx.lineWidth = 3; ctx.stroke();
        ctx.fillStyle = '#ffffff'; ctx.font = '800 14px Outfit'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.shadowColor = '#10b981'; ctx.shadowBlur = 10;
        ctx.fillText('+1', item.x, item.y); ctx.shadowBlur = 0;
    });

    // Blocks
    blocks.forEach(b => {
        if (b.exploding || b.hp <= 0) return;
        ctx.save(); ctx.translate(b.x + CW/2, b.y + CH/2);
        
        const s = b.scale - b.punch; ctx.scale(s, s);
        const color = getBlockColor(b.maxHp);
        
        ctx.fillStyle = 'rgba(15, 23, 42, 0.95)'; 
        ctx.beginPath(); ctx.roundRect(-CW/2, -CH/2, CW, CH, 10); ctx.fill();
        
        // Highlight
        ctx.fillStyle = 'rgba(255,255,255,0.1)'; 
        ctx.beginPath(); ctx.roundRect(-CW/2, -CH/2, CW, CH/2, {tl: 10, tr: 10, bl: 0, br: 0}); ctx.fill();
        
        ctx.strokeStyle = color; ctx.lineWidth = 3; 
        ctx.shadowColor = color; ctx.shadowBlur = b.hp < b.maxHp * 0.3 ? 15 : 5; // Glows more when low HP!
        ctx.stroke(); ctx.shadowBlur = 0; 
        
        ctx.fillStyle = color; ctx.globalAlpha = 0.15 + 0.6 * Math.max(0, b.hp / b.maxHp);
        ctx.beginPath(); ctx.roundRect(-CW/2 + 3, -CH/2 + 3, CW - 6, CH - 6, 6); ctx.fill(); 
        ctx.globalAlpha = 1;
        
        ctx.fillStyle = '#ffffff'; ctx.font = `900 ${Math.max(16, CW * 0.45)}px Outfit`;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; 
        ctx.shadowColor = '#000000'; ctx.shadowBlur = 4;
        ctx.fillText(Math.ceil(b.hp), 0, 1); 
        ctx.restore();
    });

    // Cannon
    ctx.fillStyle = '#06b6d4'; 
    ctx.beginPath(); ctx.arc(cannonX, CANNON_Y, 12, 0, Math.PI * 2);
    ctx.shadowColor = '#06b6d4'; ctx.shadowBlur = 20; ctx.fill(); ctx.shadowBlur = 0;

    // Ball Count Text
    if (state === 'AIMING' || state === 'ANIMATING' || state === 'SHOOTING') {
        ctx.fillStyle = '#f8fafc'; ctx.font = '800 16px Outfit'; ctx.textAlign = 'center';
        ctx.shadowColor = '#000000'; ctx.shadowBlur = 4;
        ctx.fillText(`x${ballsInCannon}`, cannonX, CANNON_Y + 30);
    }

    balls.forEach(b => b.draw(ctx));

    // Direct Aiming Line
    if (state === 'AIMING') {
        // Tutorial prompt if wave 1
        if (wave === 1 && !isDragging) {
            ctx.fillStyle = `rgba(255, 255, 255, ${0.5 + Math.sin(performance.now()*0.005)*0.5})`;
            ctx.font = '800 20px Outfit'; ctx.textAlign = 'center';
            ctx.fillText("DRAG ANYWHERE TO AIM", W/2, H/2);
        }

        if (isDragging) {
            let px = cannonX, py = CANNON_Y, pvx = aimVector.x, pvy = aimVector.y;
            ctx.save(); 
            ctx.strokeStyle = 'rgba(6, 182, 212, 0.9)'; 
            ctx.lineWidth = 3; ctx.setLineDash([12, 12]);
            ctx.beginPath(); ctx.moveTo(px, py);
            
            // Predict path
            for(let i=0; i<4; i++) {
                let tHit = Infinity;
                if (pvy < 0) tHit = Math.min(tHit, (BALL_RADIUS - py) / pvy); // Roof
                if (pvx < 0) tHit = Math.min(tHit, (BALL_RADIUS - px) / pvx); // Left wall
                if (pvx > 0) tHit = Math.min(tHit, (W - BALL_RADIUS - px) / pvx); // Right wall
                
                if (tHit === Infinity) break;
                px += pvx * tHit; py += pvy * tHit; 
                ctx.lineTo(px, py);
                if (py <= BALL_RADIUS) pvy *= -1; else pvx *= -1; // Bounce vector
            }
            ctx.shadowColor = '#06b6d4'; ctx.shadowBlur = 10;
            ctx.stroke(); ctx.restore();
        }
    }

    // Fast Forward Indicator
    if (fastForward && state === 'PLAYING') {
        ctx.fillStyle = 'rgba(16, 185, 129, 0.8)'; ctx.font = '900 24px Outfit'; ctx.textAlign = 'center';
        ctx.fillText("▶▶ FAST FORWARD", W/2, BOARD_TOP - 20);
    }

    // Floating Texts
    floatingTexts.forEach(ft => {
        ctx.save(); ctx.globalAlpha = Math.max(0, ft.life); 
        ctx.fillStyle = ft.color || '#f8fafc';
        ctx.font = `900 ${ft.size || 16}px Outfit`; ctx.textAlign = 'center'; 
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
    if (dt > 0.05) dt = 0.05; // Cap dt tightly to prevent tunneling
    update(dt); draw();
});
