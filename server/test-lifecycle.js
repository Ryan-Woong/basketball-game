/*
 * server/test-lifecycle.js  (no npm packages needed)
 * Phase 7: 60 s response timeout (forfeit), "any disconnect ends the game and deletes the room", leaveRoom,
 * stale-room safety, and the data the real client needs (countdown, TEAM_STATE, VIS_RESET payload).
 */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);   // accelerate engine sleep() in tests only

const { registerSocketHandlers } = require('./socket');
const roomManager = require('./room-manager');
const { createFakeIO, createFakeTimers, NEVER_TIMERS } = require('./test-utils/fake-io');
const { latestState, draftAll, autoplay, withTimeout } = require('./test-utils/pvp-driver');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error('  FAIL:', n); } };
const ID = (c) => `${c}_0123456789abcdef`;
const FAST = { capacity: 1e6, refillPerSec: 1e6 };
const settle = () => new Promise(r => realSetTimeout(r, 15));

async function setup(tag, timers = NEVER_TIMERS, turnTimeoutMs = 60000) {
    const { io, connectFakeSocket } = createFakeIO();
    registerSocketHandlers(io, { limits: FAST, session: { timers, turnTimeoutMs } });
    const A = connectFakeSocket(`A_${tag}`), B = connectFakeSocket(`B_${tag}`);
    const { roomId } = await A._emitToServer('createRoom', { playerId: ID('pA' + tag), nickname: 'Alice' });
    await B._emitToServer('joinRoom', { playerId: ID('pB' + tag), nickname: 'Bob', roomId });
    return { io, connectFakeSocket, A, B, roomId, ids: { A: ID('pA' + tag), B: ID('pB' + tag) } };
}
const closedOf = (s) => s._eventsOf('roomClosed');

(async () => {
    // ---------- disconnect = game over + room deleted ----------
    {   // in the lobby
        const { A, B, roomId } = await setup('lobby');
        await B._emitToServer('disconnect');
        check('LIFE lobby: guest disconnect deletes the room', roomManager.getRoom(roomId) === null);
        check('LIFE lobby: host told roomClosed(DISCONNECT, p2)', closedOf(A).length === 1 && closedOf(A)[0].reason === 'DISCONNECT' && closedOf(A)[0].slot === 'p2');
    }
    {   // host alone in the lobby
        const { connectFakeSocket } = await setup('solo');
        const H = connectFakeSocket('H'); const { roomId } = await H._emitToServer('createRoom', { playerId: ID('pH'), nickname: 'h' });
        await H._emitToServer('disconnect');
        check('LIFE lobby: host disconnect deletes an empty room', roomManager.getRoom(roomId) === null);
    }
    {   // during the draft
        const { A, B, roomId } = await setup('draft');
        await A._emitToServer('ready'); await B._emitToServer('ready');
        await A._emitToServer('draftPick', { pickId: latestState(A).draftPool[0].id });
        await A._emitToServer('disconnect');
        check('LIFE draft: room deleted on disconnect', roomManager.getRoom(roomId) === null);
        check('LIFE draft: opponent told (DISCONNECT, p1)', closedOf(B)[0] && closedOf(B)[0].reason === 'DISCONNECT' && closedOf(B)[0].slot === 'p1');
        const before = B._received.length;
        await settle();
        check('LIFE draft: nothing more is sent after closing', B._received.length === before);
    }
    {   // mid game: engine is paused waiting for an answer, then the answerer disconnects
        const { A, B, roomId } = await setup('game');
        let victim = null;
        autoplay(A, B, { onRequest: async (sock, payload) => { if (!victim) { victim = sock; return; } /* first request stays unanswered */ } });
        await A._emitToServer('ready'); await B._emitToServer('ready');
        await draftAll(A, B);
        await settle(); await settle();
        check('LIFE game: engine waits for the first decision', !!victim);
        const evBefore = A._eventsOf('gameEvent').length;
        const other = victim === A ? B : A;
        await victim._emitToServer('disconnect');
        await settle(); await settle();
        check('LIFE game: room deleted when a player disconnects mid-game', roomManager.getRoom(roomId) === null);
        check('LIFE game: the other player gets roomClosed with the score so far', closedOf(other).length === 1 && closedOf(other)[0].score && typeof closedOf(other)[0].score.p1 === 'number');
        check('LIFE game: no game events are produced after closing', A._eventsOf('gameEvent').length === evBefore);
        check('LIFE game: a late answer is rejected (no game any more)', (await other._emitToServer('gameAction', { requestId: 'x', choice: 'drive' })).error === 'NO_GAME');
    }

    // ---------- leaveRoom ----------
    {
        const { A, B, roomId } = await setup('leave');
        const r = await A._emitToServer('leaveRoom');
        check('LIFE leaveRoom acked and room deleted', r.ok === true && roomManager.getRoom(roomId) === null);
        check('LIFE leaveRoom: other player told (LEFT, p1)', closedOf(B)[0] && closedOf(B)[0].reason === 'LEFT' && closedOf(B)[0].slot === 'p1');
        check('LIFE leaveRoom without a room is harmless', (await A._emitToServer('leaveRoom')).ok === true);
    }

    // ---------- after a room is closed both players can start fresh ----------
    {
        const { connectFakeSocket, A, B, roomId } = await setup('again');
        await A._emitToServer('leaveRoom');
        const r1 = await B._emitToServer('createRoom', { playerId: ID('pBagain'), nickname: 'Bob' });
        check('LIFE after closure the remaining player can create a new room', !!r1.roomId && r1.roomId !== undefined);
        const r2 = await A._emitToServer('joinRoom', { playerId: ID('pAagain'), nickname: 'Alice', roomId: r1.roomId });
        check('LIFE after leaving, the leaver can join the new room', r2.slot === 'p2');
        // a closed room's code can never be heard by old members: simulate code reuse
        roomManager.rooms.clear();
        const old = await setup('reuse'); const oldRoom = old.roomId;
        await old.A._emitToServer('leaveRoom');
        const intruder = old.connectFakeSocket('INTR');
        // brand-new room that happens to get the same code
        roomManager.rooms.set(oldRoom, { roomId: oldRoom, status: 'WAITING', players: { p1: { playerId: ID('pNew'), nickname: 'n', socketId: 'zz', ready: false, connected: true }, p2: null }, touchedAt: Date.now(), session: null });
        old.io.to(oldRoom).emit('roomState', { secret: 'new-room-only' });
        check('LIFE old members no longer receive broadcasts of a reused room code', !old.A._received.some(r => r.payload && r.payload.secret) && !old.B._received.some(r => r.payload && r.payload.secret));
        roomManager.rooms.clear();
    }

    // ---------- 60 s timeout -> forfeit ----------
    {   // draft turn timeout
        const timers = createFakeTimers();
        const { A, B, roomId } = await setup('tdraft', timers);
        await A._emitToServer('ready'); await B._emitToServer('ready');
        const st = latestState(A);
        check('TIMER draft: state carries the countdown (60000 ms) and whose turn it is', st.turnTimeoutMs === 60000 && st.draftTurn === 'p1');
        timers.advance(59000);
        check('TIMER draft: nothing happens before 60 s', roomManager.getRoom(roomId) !== null);
        await A._emitToServer('draftPick', { pickId: st.draftPool[0].id });
        check('TIMER draft: a pick re-arms the timer for the next player (still 60 s)', latestState(A).draftTurn === 'p2' && latestState(A).turnTimeoutMs === 60000 && timers.count() === 1);
        timers.advance(59000);
        check('TIMER draft: p2 still has time after p1 used 59 s earlier', roomManager.getRoom(roomId) !== null);
        timers.advance(1500);
        check('TIMER draft: p2 forfeits after 60 s, room deleted', roomManager.getRoom(roomId) === null);
        const c = closedOf(A)[0];
        check('TIMER draft: both told roomClosed(TIMEOUT, p2)', c && c.reason === 'TIMEOUT' && c.slot === 'p2' && closedOf(B)[0].reason === 'TIMEOUT');
    }
    {   // decision timeout during the game
        const timers = createFakeTimers();
        const { A, B, roomId } = await setup('tgame', timers);
        const answered = [];
        let hold = false, wantedSlot = null;
        autoplay(A, B, { onRequest: async (sock, payload) => {
            if (answered.length >= 3) { hold = true; wantedSlot = sock === A ? 'p1' : 'p2'; return; }   // from the 4th request on nobody answers
            answered.push(payload.requestId);
            await sock._emitToServer('gameAction', { requestId: payload.requestId, choice: payload.options[0].id });
        } });
        await A._emitToServer('ready'); await B._emitToServer('ready');
        await draftAll(A, B);
        for (let i = 0; i < 50 && !hold; i++) await settle();
        check('TIMER game: engine is waiting for the 4th decision', hold);
        const w = A._eventsOf('gameEvent').filter(e => e.type === 'WAITING_FOR_ACTION');
        check('TIMER game: every request announces the 60 s limit to both players', w.length >= 4 && w.every(e => e.data.timeoutMs === 60000));
        const reqs = [...A._eventsOf('actionRequest'), ...B._eventsOf('actionRequest')];
        check('TIMER game: actionRequest carries timeoutMs', reqs.length >= 4 && reqs.every(r => r.timeoutMs === 60000));
        check('TIMER game: only one timer is running (answered requests cleared theirs)', timers.count() === 1);
        timers.advance(30000);
        check('TIMER game: still open after 30 s', roomManager.getRoom(roomId) !== null);
        const evBefore = A._eventsOf('gameEvent').length;
        timers.advance(31000);
        await settle();
        check('TIMER game: forfeit after 60 s, room deleted', roomManager.getRoom(roomId) === null);
        const c = closedOf(A)[0];
        check('TIMER game: roomClosed(TIMEOUT) names the slot that did not answer', c && c.reason === 'TIMEOUT' && c.slot === wantedSlot && closedOf(B)[0].slot === wantedSlot);
        check('TIMER game: score so far is reported', c.score && typeof c.score.p1 === 'number' && typeof c.score.p2 === 'number');
        check('TIMER game: the engine produces no more events after the forfeit', A._eventsOf('gameEvent').length === evBefore && timers.count() === 0);
    }
    {   // answering in time cancels the forfeit; finished game clears the timer
        const timers = createFakeTimers();
        const { A, B, roomId } = await setup('tok', timers);
        const done = autoplay(A, B);   // answers instantly
        await A._emitToServer('ready'); await B._emitToServer('ready');
        await draftAll(A, B);
        await withTimeout(done, 60000);
        await settle();
        check('TIMER ok: a normal full game never triggers a timeout', roomManager.getRoom(roomId) !== null && roomManager.getRoom(roomId).status === 'FINISHED' && closedOf(A).length === 0);
        check('TIMER ok: no timer left running after GAME_END', timers.count() === 0);
        timers.advance(10 * 60 * 1000);
        check('TIMER ok: time passing after the game does not close the finished room', roomManager.getRoom(roomId) !== null);
    }

    // ---------- data the real client needs ----------
    {
        const { A, B } = await setup('data');
        const done = autoplay(A, B);
        await A._emitToServer('ready'); await B._emitToServer('ready');
        await draftAll(A, B);
        await withTimeout(done, 60000);
        await settle();
        const ev = A._eventsOf('gameEvent');
        const resets = ev.filter(e => e.type === 'VIS_RESET');
        check('DATA VIS_RESET carries side/attacker/quarter/possession', resets.length >= 20 && resets.every(e => typeof e.data.isP1Offense === 'boolean' && typeof e.data.attackerId === 'number' && e.data.quarter >= 1 && e.data.quarter <= 4 && e.data.possession >= 1 && e.data.possession <= 8));
        check('DATA possession 1 = p1 offense in Q1 (original rule: odd quarters p1 first)', resets[0].data.quarter === 1 && resets[0].data.isP1Offense === true);
        const ts = ev.filter(e => e.type === 'TEAM_STATE');
        // VIS_RESET also fires for the possession that follows a rebound (inside the engine), TEAM_STATE once per runPossession + once at the start
check('DATA TEAM_STATE sent at the start and after possessions', ts.length >= 20 && ts.length <= resets.length + 1);
        const t = ts[ts.length - 1].data;
        check('DATA TEAM_STATE has 5 players per side with eff stats and live stats', t.p1.length === 5 && t.p2.length === 5 && Object.keys(t.p1[0].eff).length === 11 && typeof t.p1[0].gs.pts === 'number');
        const end = ev.find(e => e.type === 'GAME_END').data;
        const sumPts = (arr) => arr.reduce((s, p) => s + p.gs.pts, 0);
        check('DATA live box score in TEAM_STATE matches the final score', sumPts(t.p1) === end.p1Score && sumPts(t.p2) === end.p2Score);
        check('DATA TEAM_STATE contains only whitelisted fields', !JSON.stringify(ts).match(/"(buffs|hotHand|airball|name)"/));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('aborted:', e); process.exit(1); });
