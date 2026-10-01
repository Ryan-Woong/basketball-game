/*
 * Engine-level PvP test (no sockets): both sides are humans.
 * Checks that EVERY decision is asked to the correct player:
 *   - offense choices (action, follow-up, wide open, pass receiver) -> the side that has the ball
 *   - help defense                                                 -> the defending side
 *   - fast break finish                                            -> the side that stole the ball (not the possession owner)
 * and that solo mode (original game) still only ever asks p1.
 * Run: node server/game-engine/test-engine-pvp.js
 */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);
const createGameEngine = require('./game.js');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error('  FAIL:', n); } };
const L1 = 'Alice', L2 = 'Bob';

function playGame(mode) {
    return new Promise((resolve, reject) => {
        let offSlot = null;
        const stats = { asked: { p1: 0, p2: 0 }, wrong: [], kinds: {} };
        const kindOf = (t) => t.startsWith('[수비]') ? 'help' : t.includes('속공') ? 'fastbreak' : t.includes('와이드') ? 'wideopen'
            : t.includes('누구에게') ? 'passTarget' : t.includes('연계') ? 'followup' : t.includes('어떤 행동') ? 'action' : 'other';
        const io = {
            log(text) { const m = text.match(/\[(.+) 공격 턴 시작\]/); if (m) offSlot = (m[1] === L1 || m[1] === 'USER') ? 'p1' : 'p2'; },
            emit(type, payload) { if (type === 'GAME_END') resolve(stats); if (type === 'ENGINE_ERROR') reject(new Error(payload.message)); },
            score() {},
            requestAction(slot, options, title) {
                stats.asked[slot]++;
                const k = kindOf(title); stats.kinds[k] = (stats.kinds[k] || 0) + 1;
                const other = offSlot === 'p1' ? 'p2' : 'p1';
                const expected = (k === 'help' || k === 'fastbreak') ? other : offSlot;
                if (slot !== expected) stats.wrong.push(`${k}: asked ${slot}, expected ${expected}`);
                return Promise.resolve(options[Math.floor(Math.random() * options.length)].id);
            },
        };
        const engine = createGameEngine(io, mode === 'pvp' ? { mode: 'pvp', labels: { p1: L1, p2: L2 } } : {});
        engine.initDraftPool();
        const POS = engine.POSITIONS;
        if (mode === 'pvp') {            // alternate picks, p1 first
            for (let i = 0; i < 10; i++) {
                const s = engine.getState(), isP1 = i % 2 === 0, team = isP1 ? s.userTeam : s.cpuTeam;
                const cand = s.draftPool.find(p => !team[p.pos]);
                engine.draftPlayerPvp(isP1, cand.id);
            }
        } else {
            for (let i = 0; i < 5; i++) { const s = engine.getState(); engine.draftPlayer(s.draftPool.find(p => !s.userTeam[p.pos]).id); }
        }
    });
}

(async () => {
    const wrongPvp = [], pvpTotals = { p1: 0, p2: 0 }, kinds = {};
    for (let i = 0; i < 25; i++) {
        const st = await playGame('pvp');
        wrongPvp.push(...st.wrong); pvpTotals.p1 += st.asked.p1; pvpTotals.p2 += st.asked.p2;
        for (const k in st.kinds) kinds[k] = (kinds[k] || 0) + st.kinds[k];
    }
    check('PVP every decision went to the right player (25 games)', wrongPvp.length === 0);
    check('PVP both players were asked a similar number of times (no CPU branch left)', pvpTotals.p1 > 200 && pvpTotals.p2 > 200);
    for (const k of ['action', 'followup', 'help', 'passTarget', 'wideopen', 'fastbreak'])
        check(`PVP decision site "${k}" was exercised`, (kinds[k] || 0) > 0);
    if (wrongPvp.length) console.error(wrongPvp.slice(0, 5));

    const solo = await playGame('solo');
    check('SOLO mode still only asks p1 (CPU decides for the other side)', solo.asked.p2 === 0 && solo.asked.p1 > 0);
    console.log('PvP asks:', JSON.stringify(pvpTotals), 'sites:', JSON.stringify(kinds));
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('aborted:', e); process.exit(1); });
