/*
 * server/test-session.js  (no npm packages needed)
 * Phase 6 end-to-end: room -> ready -> alternating draft -> 4 quarters -> end, with TWO human players.
 * Both fake clients answer only the requests addressed to them. Runs 5 full games.
 */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);   // accelerate engine sleep() in tests only

const { registerSocketHandlers } = require('./socket');
const roomManager = require('./room-manager');
const { createFakeIO, NEVER_TIMERS } = require('./test-utils/fake-io');
const { latestState, draftAll, autoplay } = require('./test-utils/pvp-driver');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error('  FAIL:', name); } };
const POS = ['PG', 'SG', 'SF', 'PF', 'C'];

async function playOneGame(n) {
    const { io, connectFakeSocket } = createFakeIO();
    registerSocketHandlers(io, { limits: { capacity: 1e6, refillPerSec: 1e6 }, session: { timers: NEVER_TIMERS } });   // timers are accelerated in tests
    const A = connectFakeSocket(`sockA_${n}`), B = connectFakeSocket(`sockB_${n}`);
    const idA = `pA_${n}_0123456789abcdef`, idB = `pB_${n}_0123456789abcdef`;
    const { roomId } = await A._emitToServer('createRoom', { playerId: idA, nickname: 'Alice' });
    await B._emitToServer('joinRoom', { playerId: idB, nickname: 'Bob', roomId });

    check('before start: draftPick / gameAction rejected', (await A._emitToServer('draftPick', { pickId: 1 })).error === 'NO_GAME' && (await B._emitToServer('gameAction', { requestId: 'x', choice: 'drive' })).error === 'NO_GAME');

    // ---- ready ----
    await A._emitToServer('ready');
    check('one ready -> no gameStart yet', A._eventsOf('gameStart').length === 0);
    await B._emitToServer('ready');
    check('both ready -> both get gameReady + gameStart (mode PVP)', [A, B].every(s => s._eventsOf('gameReady').length === 1 && s._eventsOf('gameStart').length === 1 && s._eventsOf('gameStart')[0].mode === 'PVP'));
    check('ready after start rejected, no second session', (await A._emitToServer('ready')).error === 'GAME_ALREADY_STARTED' && A._eventsOf('gameStart').length === 1);

    // ---- draft: p1 first, then alternating ----
    let st = latestState(A);
    check('draft starts with p1 turn, identical state for both', st.status === 'draft' && st.draftTurn === 'p1' && JSON.stringify(latestState(B)) === JSON.stringify(st));
    const pg = st.draftPool.find(p => p.pos === 'PG');
    check('p2 cannot pick on p1 turn', (await B._emitToServer('draftPick', { pickId: pg.id })).error === 'NOT_YOUR_TURN');
    check('invalid pick id rejected', (await A._emitToServer('draftPick', { pickId: 999999 })).error === 'INVALID_PICK');
    check('p1 valid pick accepted', (await A._emitToServer('draftPick', { pickId: pg.id })).ok === true);
    check('p1 cannot pick twice in a row', (await A._emitToServer('draftPick', { pickId: st.draftPool.find(p => p.pos === 'SG').id })).error === 'NOT_YOUR_TURN');
    st = latestState(B);
    check('turn passed to p2, pick is in p1 roster only', st.draftTurn === 'p2' && st.teams.p1.PG && st.teams.p1.PG.id === pg.id && Object.keys(st.teams.p2).length === 0);
    check('p2 cannot take an already drafted player', (await B._emitToServer('draftPick', { pickId: pg.id })).error === 'INVALID_PICK');
    const pg2 = st.draftPool.find(p => p.pos === 'PG');
    check('p2 valid pick accepted', (await B._emitToServer('draftPick', { pickId: pg2.id })).ok === true);
    check('turn back to p1', latestState(A).draftTurn === 'p1');
    const p1Dup = latestState(A).draftPool.find(p => p.pos === 'PG');
    check('p1 cannot fill an already filled position', !p1Dup || (await A._emitToServer('draftPick', { pickId: p1Dup.id })).error === 'POSITION_FILLED');

    // ---- game: adversarial first request, then both auto-play ----
    let first = true;
    const done = autoplay(A, B, { onRequest: async (sock, payload) => {
        const other = sock === A ? B : A;
        const valid = payload.options[Math.floor(Math.random() * payload.options.length)].id;
        if (first) {
            first = false;
            check('first request: the OTHER player cannot answer it', (await other._emitToServer('gameAction', { requestId: payload.requestId, choice: valid })).error === 'NOT_YOUR_SEAT');
            check('bogus requestId rejected', (await sock._emitToServer('gameAction', { requestId: 'bogus', choice: valid })).error === 'STALE_REQUEST');
            check('choice not offered rejected', (await sock._emitToServer('gameAction', { requestId: payload.requestId, choice: '__hack__' })).error === 'INVALID_CHOICE');
            check('valid answer accepted', (await sock._emitToServer('gameAction', { requestId: payload.requestId, choice: valid })).ok === true);
            check('duplicate answer rejected', !!(await sock._emitToServer('gameAction', { requestId: payload.requestId, choice: valid })).error);
        } else {
            await sock._emitToServer('gameAction', { requestId: payload.requestId, choice: valid });
        }
    } });
    await draftAll(A, B);
    check('draft complete: 5 + 5 players', POS.every(p => latestState(B).teams.p1[p] && latestState(B).teams.p2[p]));
    check('draftPick after draft rejected', (await A._emitToServer('draftPick', { pickId: 1 })).error === 'NOT_DRAFTING');
    await Promise.race([done, new Promise((_, j) => realSetTimeout(() => j(new Error('game did not finish in 60s')), 60000))]);
    await new Promise(r => realSetTimeout(r, 20));

    // ---- results ----
    const evA = A._eventsOf('gameEvent'), evB = B._eventsOf('gameEvent');
    check('both players received identical event streams', JSON.stringify(evA) === JSON.stringify(evB));
    check('seq contiguous from 1', evA.every((e, i) => e.seq === i + 1));
    check('no ENGINE_ERROR', !evA.some(e => e.type === 'ENGINE_ERROR'));
    const end = evA.find(e => e.type === 'GAME_END');
    const lastScore = [...evA].reverse().find(e => e.type === 'SCORE');
    check('GAME_END exists for both with p1Score/p2Score', !!end && !!evB.find(e => e.type === 'GAME_END') && typeof end.data.p1Score === 'number');
    check('last SCORE matches GAME_END', lastScore.data.p1 === end.data.p1Score && lastScore.data.p2 === end.data.p2Score);
    check('points were scored', end.data.p1Score + end.data.p2Score > 0);
    check('box score has 5 players per side', end.data.boxScore.p1.length === 5 && end.data.boxScore.p2.length === 5);
    const w1 = evA.filter(e => e.type === 'WAITING_FOR_ACTION' && e.data.forSlot === 'p1').map(e => e.data.requestId);
    const w2 = evA.filter(e => e.type === 'WAITING_FOR_ACTION' && e.data.forSlot === 'p2').map(e => e.data.requestId);
    const gotA = A._eventsOf('actionRequest').map(r => r.requestId), gotB = B._eventsOf('actionRequest').map(r => r.requestId);
    check('both players were asked to decide during the game', w1.length > 5 && w2.length > 5);
    check('p1 received exactly the requests addressed to p1', JSON.stringify(gotA) === JSON.stringify(w1));
    check('p2 received exactly the requests addressed to p2', JSON.stringify(gotB) === JSON.stringify(w2));
    check('all requestIds unique', new Set([...gotA, ...gotB]).size === gotA.length + gotB.length);
    const logs = evA.filter(e => e.type === 'LOG').map(e => e.data.text).join('\n');
    check('logs use nicknames, not USER/CPU', logs.includes('Alice 공격 턴 시작') && logs.includes('Bob 공격 턴 시작') && !/\bUSER\b|\bCPU\b/.test(logs));
    check('winner line is nickname based (or tie)', /(Alice|Bob)의 승리입니다|무승부/.test(logs));
    check('room status FINISHED', roomManager.getRoom(roomId).status === 'FINISHED');
    const everything = JSON.stringify([A._received, B._received]);
    check('no socketId / playerId leaks', !everything.includes('socketId') && !everything.includes(`pA_${n}_`) && !everything.includes(`pB_${n}_`));
    check('after the game gameAction is rejected', !!(await A._emitToServer('gameAction', { requestId: 'late', choice: 'drive' })).error);
    return { events: evA.length, p1Req: w1.length, p2Req: w2.length, score: `${end.data.p1Score}:${end.data.p2Score}` };
}

(async () => {
    for (let i = 1; i <= 5; i++) {
        const r = await playOneGame(i);
        console.log(`game ${i}: ${r.events} events, requests p1=${r.p1Req} p2=${r.p2Req}, final ${r.score}`);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('aborted:', e); process.exit(1); });
