/* Court visualization (ported from the 19th version). Reads only the server's events + rosters; has no game logic.
 *   Roster = who is on the court (from gameState). Cur = what the server last told us (attacker / defender / score).
 *   Court.onEvent(evt) turns VIS_* events into the same Vis.* calls the single-player version made. */
const Roster = {
    me: null,                    // 'p1' | 'p2' : the seat of THIS browser
    byId: {},                    // id -> {id,pos,name,side,...stats}
    team: { p1: {}, p2: {} },    // side -> pos -> player
    names: { p1: 'P1', p2: 'P2' },
    set(teams) {
        this.byId = {}; this.team = { p1: {}, p2: {} };
        ['p1', 'p2'].forEach(side => Object.values(teams[side] || {}).forEach(p => {
            const q = { ...p, side }; this.byId[q.id] = q; this.team[side][q.pos] = q;
        }));
    },
    defenderOf(p) { return this.team[p.side === 'p1' ? 'p2' : 'p1'][p.pos]; },
    clear() { this.byId = {}; this.team = { p1: {}, p2: {} }; },
};
const Cur = { attackerId: null, defenderId: null, quarter: 1, possession: 8, offSide: 'p1', score: { p1: 0, p2: 0 } };

const SP = { PG: [60, 50], SG: [70, 24], SF: [70, 76], PF: [80, 38], C: [82, 62] };
const clampV = (v, a, b) => Math.max(a, Math.min(b, v));
const fdist = (a, b) => Math.hypot((a.x - b.x) * 0.94, (a.y - b.y) * 0.5);
function segDist(p, a, b) {
    const px = p.x * .94, py = p.y * .5, ax = a.x * .94, ay = a.y * .5, bx = b.x * .94, by = b.y * .5;
    const vx = bx - ax, vy = by - ay, L = vx * vx + vy * vy;
    const t = L ? clampV(((px - ax) * vx + (py - ay) * vy) / L, 0, 1) : 0;
    return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}
const ARC_RX = 25.25, ARC_RY = 47.5;
const Vis = {
    ov: {}, ball: null, holder: null, sig: '', offU: true, fastUntil: 0, gen: 0, prepKey: '',
    cancel() { this.gen++; },
    all() { return Object.values(Roster.byId); },
    isU(p) { return p.side === Roster.me; },   // "u" = my team (blue). Every client sees itself in blue, attacking right.
    key(p) { return (this.isU(p) ? 'u' : 'c') + p.pos; },
    hx(u) { return u ? 94.5 : 5.5; },
    dir(u) { return u ? 1 : -1; },
    pos(p) {
        const k = this.key(p); if (this.ov[k]) return this.ov[k];
        const off = (this.isU(p) === this.offU), d = this.dir(this.offU), s = SP[p.pos];
        let x = this.offU ? s[0] : 100 - s[0]; if (!off) x += 3.5 * d;
        return { x, y: s[1] };
    },
    mv(p, x, y) { if (p) this.ov[this.key(p)] = { x: clampV(x, 3, 97), y: clampV(y, 4, 96) }; },
    reset(offU) { this.cancel(); this.ov = {}; this.ball = null; this.holder = null; this.prepKey = ''; this.offU = !!offU; },
    ballPos() {
        if (this.ball && Date.now() < this.ball.until) return this.ball;
        const h = this.holder || Roster.byId[Cur.attackerId]; if (!h) return { x: 50, y: 50 };
        const q = this.pos(h), d = this.dir(this.isU(h)); return { x: q.x + d * 2.2, y: q.y + 1.5 };
    },
    spot(p, tx, ty, o) {
        const pts = this.all().filter(x => x !== p && !(o.ign || []).includes(x)).map(x => this.pos(x));
        for (const usePath of [true, false]) {
            const ok = c => c.x >= 4 && c.x <= 96 && c.y >= 5 && c.y <= 95 && pts.every(q => fdist(q, c) >= o.minD) &&
                (!usePath || !o.from || pts.every(q => segDist(q, o.from, c) >= (o.path || 0)));
            for (let r = 0; r <= 18; r++) {
                const n = r ? 20 : 1; let best = null, bs = 1e9;
                for (let i = 0; i < n; i++) {
                    const a = i / n * Math.PI * 2, R = r * 1.2;
                    const c = { x: tx + Math.cos(a) * R / 0.94, y: ty + Math.sin(a) * R / 0.5 };
                    if (!ok(c)) continue;
                    const sc = o.from ? fdist(c, o.from) : 0; if (sc < bs) { bs = sc; best = c; }
                }
                if (best) return best;
            }
        }
        return { x: tx, y: ty };
    },
    arcSpot(p, hx, d, minD, ign) {
        const q = this.pos(p), pts = this.all().filter(x => x !== p && x !== ign).map(x => this.pos(x)), cands = [];
        for (let t = -1.0; t <= 1.0001; t += 0.02)
            cands.push({ x: hx - d * 1.08 * ARC_RX * Math.cos(t), y: 50 + 1.08 * ARC_RY * Math.sin(t) });
        cands.sort((a, b) => fdist(a, q) - fdist(b, q));
        return cands.find(c => pts.every(o => fdist(o, c) >= minD)) || cands[0];
    },
    advance(type) {
        const a = Roster.byId[Cur.attackerId], df = Roster.byId[Cur.defenderId]; if (!a) return;
        const u = this.isU(a), hx = this.hx(u), dr = this.dir(u), q = this.pos(a);
        this.holder = a; this.prepKey = '';
        if (type === 'fake') {
            const t = this.spot(a, clampV(q.x - dr * 2, 10, 90), clampV(q.y + (q.y < 50 ? 4 : -4), 10, 90), { minD: 5.0, ign: [df] });
            this.mv(a, t.x, t.y);
            if (df) { const c = this.spot(df, t.x + dr * 3.8, t.y, { minD: 3.4 }); this.mv(df, c.x, c.y); }
            return;
        }
        const off = type === 'drive' ? 13 : 9;
        const ty = type === 'drive' ? 50 + (q.y - 50) * 0.35 : 50 + (q.y < 50 ? -8 : 8);
        const t = this.spot(a, hx - dr * off, ty, { minD: 5.5, ign: [df], from: q, path: 3.6 });
        this.mv(a, t.x, t.y);
        if (df) { const c = this.spot(df, t.x + dr * 3.9, t.y, { minD: 3.4 }); this.mv(df, c.x, c.y); }
    },
    help(h) {
        const a = Roster.byId[Cur.attackerId]; if (!a || !h) return;
        const q = this.pos(a), dr = this.dir(this.isU(a));
        const c = this.spot(h, q.x + dr * 2, q.y + (q.y < 50 ? 9 : -9), { minD: 4.2 }); this.mv(h, c.x, c.y);
    },
    pass(a, b) {
        this.cancel(); const q = this.pos(b), d = this.dir(this.isU(b));
        this.ball = { x: q.x + d * 2.2, y: q.y + 1.5, until: Date.now() + 700 }; this.holder = b;
    },
    prepShot(p, type) {
        if (!p) return;
        const u = this.isU(p), hx = this.hx(u), d = this.dir(u), q = this.pos(p), df = Roster.defenderOf(p);
        let t;
        if (type === 'pt3') t = this.arcSpot(p, hx, d, 5.5, df);
        else if (type === 'mid') t = this.spot(p, hx - d * 15, clampV(q.y, 22, 78), { minD: 5.5, ign: [df], from: q, path: 3.6 });
        else t = this.spot(p, hx - d * 5, 50 + (q.y - 50) * 0.3, { minD: 5, ign: [df], from: q, path: 3.4 });
        this.holder = p; this.mv(p, t.x, t.y); this.prepKey = this.key(p) + type;
        if (df) {
            const ang = Math.atan2((50 - t.y) * 0.5, (hx - t.x) * 0.94);
            const c = this.spot(df, t.x + Math.cos(ang) * 3.9 / 0.94, t.y + Math.sin(ang) * 3.9 / 0.5, { minD: 3.4 });
            this.mv(df, c.x, c.y);
        }
    },
    shoot(p, type, made) {
        const u = this.isU(p), hx = this.hx(u), d = this.dir(u);
        if (this.prepKey !== this.key(p) + type) this.prepShot(p, type);
        this.prepKey = '';
        const g = ++this.gen;
        setTimeout(() => {
            if (g !== this.gen) return;
            this.ball = { x: made ? hx : hx - d * 2.5, y: made ? 50 : 50 + (Math.random() < .5 ? -4 : 4),
                          until: Date.now() + (made ? 1200 : 6000) };
        }, 450);
    },
    rebPos(o, dfn) {
        const u = this.offU, hx = this.hx(u), d = this.dir(u);
        [0, 1].forEach(i => { this.mv(dfn[i], hx - d * 6, i ? 58 : 42); this.mv(o[i], hx - d * 9, i ? 62 : 38); });
    },
    grab(p) { this.cancel(); this.holder = p; this.ball = null; this.prepKey = ''; },
    steal(d) { this.cancel(); this.holder = d; this.ball = null; this.prepKey = ''; },
    fastBreak(p, isU) {
        this.cancel(); this.ov = {}; this.offU = isU; this.holder = p; this.ball = null; this.prepKey = ''; this.fastUntil = Date.now() + 3500;
        this.mv(p, this.hx(isU) - this.dir(isU) * 14, 50);
    }
};

function renderCourt() {
    const c = document.getElementById('court'), sim = document.getElementById('sim-screen');
    if (!c || !sim || sim.classList.contains('hidden')) return;
    const all = Vis.all();
    const sig = all.map(p => p.id).join(',') + '|' + Roster.me;
    if (sig !== Vis.sig) {
        Vis.sig = sig; c.querySelectorAll('.pl').forEach(e => e.remove());
        all.forEach(p => {
            const e = document.createElement('div'); e.className = 'pl ' + (Vis.isU(p) ? 'u' : 'c'); e.id = 'pl-' + p.id;
            const b = document.createElement('b'); b.textContent = p.pos;
            const i = document.createElement('i'); i.textContent = p.name;
            e.appendChild(b); e.appendChild(i); c.appendChild(e);
        });
    }
    const att = Roster.byId[Cur.attackerId], def = Roster.byId[Cur.defenderId];
    all.forEach(p => {
        const e = document.getElementById('pl-' + p.id); if (!e) return;
        const q = Vis.pos(p); e.style.left = q.x + '%'; e.style.top = q.y + '%';
        e.classList.toggle('atk', p === att || p === Vis.holder);
        e.classList.toggle('dfn', p === def);
    });
    const b = Vis.ballPos(), be = document.getElementById('ball'); be.style.left = b.x + '%'; be.style.top = b.y + '%';
    c.classList.toggle('fast', Date.now() < Vis.fastUntil);
    const myName = Roster.names[Roster.me] || '나', oppSlot = Roster.me === 'p1' ? 'p2' : 'p1';
    document.getElementById('court-status').textContent =
        `Q${Cur.quarter}  |  공격권: ${Cur.offSide === Roster.me ? myName + ' (나)' : Roster.names[oppSlot]}  |  남은 Possession: ${Cur.possession}  |  ${Roster.names.p1} ${Cur.score.p1} : ${Cur.score.p2} ${Roster.names.p2}`;
}
setInterval(renderCourt, 100);

/** Server VIS_* events -> Vis.* calls (same order/semantics as the single-player engine hooks). */
const Court = {
    onEvent(type, d) {
        const P = (id) => Roster.byId[id];
        const mine = (slot) => slot === Roster.me;
        switch (type) {
            case 'VIS_RESET':
                Cur.attackerId = d.attackerId; Cur.defenderId = null;
                if (d.quarter) Cur.quarter = d.quarter; if (d.possession) Cur.possession = d.possession;
                Cur.offSide = d.isP1Offense ? 'p1' : 'p2';
                Vis.reset(mine(Cur.offSide)); break;
            case 'VIS_ADVANCE': Cur.attackerId = d.attackerId; Cur.defenderId = d.defenderId; Vis.advance(d.type); break;
            case 'VIS_HELP': Vis.help(P(d.helperId)); break;
            case 'VIS_PASS': if (P(d.toId)) { Cur.attackerId = d.toId; Vis.pass(P(d.fromId), P(d.toId)); } break;
            case 'VIS_PREP_SHOT': Vis.prepShot(P(d.shooterId), d.type); break;
            case 'VIS_SHOT': if (P(d.shooterId)) Vis.shoot(P(d.shooterId), d.type, d.made); break;
            case 'VIS_REB_POS': Vis.rebPos((d.offIds || []).map(P), (d.defIds || []).map(P)); break;
            case 'VIS_GRAB': if (P(d.playerId)) Vis.grab(P(d.playerId)); break;
            case 'VIS_STEAL': if (P(d.playerId)) Vis.steal(P(d.playerId)); break;
            case 'VIS_FAST_BREAK': if (P(d.playerId)) Vis.fastBreak(P(d.playerId), mine(d.isP1Side ? 'p1' : 'p2')); break;
            case 'SCORE': Cur.score = { p1: d.p1, p2: d.p2 }; break;
        }
    },
    reset() { Roster.clear(); Cur.attackerId = null; Cur.defenderId = null; Cur.quarter = 1; Cur.possession = 8; Cur.score = { p1: 0, p2: 0 }; Vis.sig = ''; Vis.reset(true); },
};
