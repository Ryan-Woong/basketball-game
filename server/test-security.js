/*
 * server/test-security.js  (no npm packages needed)
 * Phase 5: attack scenarios from the spec (TEST 18 unauthorized action, TEST 19 duplicate action,
 * TEST 20 client tampering) plus validators, rate limiting, room caps and the output whitelist.
 */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);   // accelerate engine sleep() in tests only

const { registerSocketHandlers } = require('./socket');
const roomManager = require('./room-manager');
const V = require('./validators');
const S = require('./sanitize');
const { createRateLimiter, createWindowCounter } = require('./rate-limiter');
const { createFakeIO, NEVER_TIMERS } = require('./test-utils/fake-io');
const { latestState, draftAll, autoplay } = require('./test-utils/pvp-driver');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error('  FAIL:', name); } };
const ID = (c) => `${c}_0123456789abcdef`;   // valid 16+ char playerId
const FAST = { limits: { capacity: 1e6, refillPerSec: 1e6 }, session: { timers: NEVER_TIMERS } };

async function setup(tag, opts = FAST) {
    const { io, connectFakeSocket } = createFakeIO();
    registerSocketHandlers(io, opts);
    const A = connectFakeSocket(`A_${tag}`), B = connectFakeSocket(`B_${tag}`);
    const { roomId } = await A._emitToServer('createRoom', { playerId: ID('pA' + tag), nickname: 'A' });
    await B._emitToServer('joinRoom', { playerId: ID('pB' + tag), nickname: 'B', roomId });
    return { io, connectFakeSocket, A, B, roomId };
}
const settle = () => new Promise(r => realSetTimeout(r, 10));

(async () => {
    // ================= TEST 18: unauthorized actions =================
    {
        const { connectFakeSocket, A, B, roomId } = await setup('t18');
        const C = connectFakeSocket('C_t18');
        check('T18 outsider (no room) draftPick rejected', (await C._emitToServer('draftPick', { pickId: 1 })).error === 'NO_GAME');
        check('T18 outsider gameAction rejected', (await C._emitToServer('gameAction', { requestId: 'x', choice: 'drive' })).error === 'NO_GAME');
        check('T18 outsider cannot join a full room', (await C._emitToServer('joinRoom', { playerId: ID('pC'), nickname: 'C', roomId })).error === 'ROOM_FULL');
        check('T18 outsider ready rejected', (await C._emitToServer('ready')).error === 'NOT_IN_ROOM');
        check('T18 host cannot join own room via second socket', (await connectFakeSocket('A2')._emitToServer('joinRoom', { playerId: ID('pAt18'), nickname: 'A', roomId })).error === 'CANNOT_JOIN_OWN_ROOM');
        check('T18 socket already in a room cannot create another', (await A._emitToServer('createRoom', { playerId: ID('pAt18'), nickname: 'A' })).error === 'ALREADY_IN_ROOM');
        check('T18 socket already in a room cannot join another', (await A._emitToServer('joinRoom', { playerId: ID('pAt18'), nickname: 'A', roomId })).error === 'ALREADY_IN_ROOM');
        const S1 = connectFakeSocket('S1');
        await S1._emitToServer('createRoom', { playerId: ID('pS1'), nickname: 's' });
        check('T18 ready without an opponent rejected', (await S1._emitToServer('ready')).error === 'WAITING_FOR_OPPONENT');
        check('T18 draftPick before the game starts rejected', (await A._emitToServer('draftPick', { pickId: 1 })).error === 'NO_GAME');
        await A._emitToServer('ready'); await B._emitToServer('ready');
        check('T18 ready after start rejected', (await A._emitToServer('ready')).error === 'GAME_ALREADY_STARTED');
        check('T18 p2 draftPick on p1 turn rejected (NOT_YOUR_TURN)', (await B._emitToServer('draftPick', { pickId: latestState(B).draftPool[0].id })).error === 'NOT_YOUR_TURN');
        check('T18 outsider draftPick during draft still rejected', (await C._emitToServer('draftPick', { pickId: latestState(B).draftPool[0].id })).error === 'NO_GAME');
        check('T18 gameAction with nothing pending rejected', (await B._emitToServer('gameAction', { requestId: 'x', choice: 'drive' })).error === 'NO_PENDING_REQUEST');
        // during the game: the wrong player and an outsider cannot answer someone else's request
        let wrongSeat = null, outsider = null;
        const done = autoplay(A, B, { onRequest: async (sock, payload) => {
            const other = sock === A ? B : A;
            if (wrongSeat === null) {
                wrongSeat = (await other._emitToServer('gameAction', { requestId: payload.requestId, choice: payload.options[0].id })).error;
                outsider = (await C._emitToServer('gameAction', { requestId: payload.requestId, choice: payload.options[0].id })).error;
            }
            await sock._emitToServer('gameAction', { requestId: payload.requestId, choice: payload.options[0].id });
        } });
        await draftAll(A, B);
        await Promise.race([done, new Promise((_, j) => realSetTimeout(() => j(new Error('timeout')), 60000))]);
        await settle();
        check('T18 other player answering my request rejected (NOT_YOUR_SEAT)', wrongSeat === 'NOT_YOUR_SEAT');
        check('T18 outsider answering a request rejected', outsider === 'NO_GAME');
        check('T18 actions after the game ended rejected', !!(await A._emitToServer('gameAction', { requestId: 'late', choice: 'drive' })).error);
        const everything = JSON.stringify([A._received, B._received]);
        check('T18 no playerId / socketId leaks to clients', !everything.includes('pAt18_') && !everything.includes('pBt18_') && !everything.includes('socketId'));
    }

    // ================= TEST 19: duplicate actions =================
    {
        const { A, B } = await setup('t19');
        await A._emitToServer('ready'); await B._emitToServer('ready');
        const pg = latestState(A).draftPool.find(p => p.pos === 'PG');
        const dup = await Promise.all(Array.from({ length: 10 }, () => A._emitToServer('draftPick', { pickId: pg.id })));
        check('T19 10 simultaneous identical draft picks -> exactly 1 accepted', dup.filter(r => r.ok).length === 1);
        check('T19 the rest are rejected because the turn already passed', dup.filter(r => r.error === 'NOT_YOUR_TURN').length === 9);
        check('T19 roster contains the player once', Object.values(latestState(A).teams.p1).filter(p => p.id === pg.id).length === 1 && Object.keys(latestState(A).teams.p1).length === 1);

        let first = true, accepted = -1;
        const done = autoplay(A, B, { onRequest: async (sock, payload) => {
            const choice = payload.options[0].id;
            if (first) {
                first = false;
                const rs = await Promise.all(Array.from({ length: 20 }, () => sock._emitToServer('gameAction', { requestId: payload.requestId, choice })));
                accepted = rs.filter(r => r.ok).length;
            } else await sock._emitToServer('gameAction', { requestId: payload.requestId, choice });
        } });
        await draftAll(A, B);
        await Promise.race([done, new Promise((_, j) => realSetTimeout(() => j(new Error('timeout')), 60000))]);
        await settle();
        check('T19 20 simultaneous identical gameActions -> exactly 1 accepted', accepted === 1);
        const waiting = A._eventsOf('gameEvent').filter(e => e.type === 'WAITING_FOR_ACTION').length;
        check('T19 engine advanced once per request (requests == pending notices)', waiting === A._eventsOf('actionRequest').length + B._eventsOf('actionRequest').length);
    }

    // ================= TEST 20: client tampering =================
    {
        const { connectFakeSocket, A, B } = await setup('t20');
        const before = B._received.length;
        for (const ev of ['gameEvent', 'gameState', 'actionRequest', 'SCORE', 'roomState', 'gameStart'])
            check(`T20 forged "${ev}" from client ignored`, (await A._emitToServer(ev, { seq: 1, type: 'SCORE', data: { p1: 999, p2: 0 } })) === undefined);
        check('T20 opponent received nothing from forged events', B._received.length === before);

        await A._emitToServer('ready'); await B._emitToServer('ready');
        for (const bad of [-1, 1.5, NaN, Infinity, '1; DROP', {}, [], null, undefined, '__proto__', 99999999])
            check(`T20 draftPick(${typeof bad === 'object' ? JSON.stringify(bad) : String(bad)}) rejected`, !!(await A._emitToServer('draftPick', { pickId: bad })).error);

        const confusion = [];
        const done = autoplay(A, B, { onRequest: async (sock, payload) => {
            if (confusion.length === 0) {
                for (const bad of [{}, [], 5, null, true, '__proto__', 'x'.repeat(5000), payload.options[0].id + '\u0000'])
                    confusion.push(!!(await sock._emitToServer('gameAction', { requestId: payload.requestId, choice: bad })).error);
                for (const bad of [{}, [], 5, null, 'bogus'])
                    confusion.push(!!(await sock._emitToServer('gameAction', { requestId: bad, choice: payload.options[0].id })).error);
            }
            // valid answer + tampering fields that must be ignored
            await sock._emitToServer('gameAction', { requestId: payload.requestId, choice: payload.options[0].id, score: 999, dice: 20, success: true, points: 3, winner: 'p1' });
        } });
        await draftAll(A, B, { rating: 99, ovr: 999 });
        await Promise.race([done, new Promise((_, j) => realSetTimeout(() => j(new Error('timeout')), 60000))]);
        await settle();
        check('T20 every malformed choice / requestId rejected', confusion.length === 13 && confusion.every(Boolean));
        const evs = A._eventsOf('gameEvent');
        const end = evs.find(e => e.type === 'GAME_END').data;
        check('T20 client-supplied score never applied (scores plausible)', end.p1Score < 150 && end.p2Score < 150);
        check('T20 tampering keys never appear in any event', !/"(dice|success|points|winner|rating)"/.test(JSON.stringify(evs)));
        check('T20 extra draft fields (ovr:999) ignored', [...Object.values(latestState(A).teams.p1), ...Object.values(latestState(A).teams.p2)].every(p => p.ovr < 200));
        check('T20 prototype pollution via __proto__ payload had no effect',
            (await connectFakeSocket('P1')._emitToServer('createRoom', JSON.parse('{"__proto__":{"polluted":true},"playerId":"' + ID('pP') + '","nickname":"x"}'))).roomId && ({}).polluted === undefined);
    }

    // ================= validators =================
    {
        check('V nickname truncated to 20 chars', V.normalizeNickname('a'.repeat(500)).length === 20);
        check('V nickname control chars stripped', V.normalizeNickname('a\u0000b\u0007c\n') === 'abc');
        check('V nickname non-string rejected', V.normalizeNickname({}) === null && V.normalizeNickname(5) === null);
        check('V empty nickname rejected', V.validateCreate({ playerId: ID('x'), nickname: '   ' }).error === 'INVALID_PAYLOAD');
        check('V short playerId rejected', V.validateCreate({ playerId: 'abc', nickname: 'n' }).error === 'INVALID_PAYLOAD');
        check('V 10k-char playerId rejected', V.validateCreate({ playerId: 'a'.repeat(10000), nickname: 'n' }).error === 'INVALID_PAYLOAD');
        check('V playerId with symbols rejected', V.validateCreate({ playerId: '<script>alert(1)</script>', nickname: 'n' }).error === 'INVALID_PAYLOAD');
        check('V room code is case-insensitive', V.validateJoin({ playerId: ID('x'), nickname: 'n', roomId: ' a7k3q ' }).roomId === 'A7K3Q');
        check('V malformed room code looks like unknown room', V.validateJoin({ playerId: ID('x'), nickname: 'n', roomId: 'O0I1!' }).error === 'ROOM_NOT_FOUND');
        check('V non-string room code rejected', V.validateJoin({ playerId: ID('x'), nickname: 'n', roomId: 12345 }).error === 'INVALID_PAYLOAD');
    }

    // ================= rate limiting =================
    {
        let t = 0; const rl = createRateLimiter({ capacity: 5, refillPerSec: 1, now: () => t });
        const burst = Array.from({ length: 8 }, () => rl.take());
        check('RL burst capped at capacity', burst.filter(Boolean).length === 5);
        t += 2000;
        check('RL refills over time', rl.take() && rl.take() && !rl.take());
        let w = 0; const wc = createWindowCounter(3, 1000, () => w);
        wc.record(); wc.record(); check('WC not blocked below max', !wc.blocked());
        wc.record(); check('WC blocked at max', wc.blocked());
        w += 1500; check('WC window expires', !wc.blocked());

        const { connectFakeSocket } = await setup('rl', { session: { timers: NEVER_TIMERS } });   // default (real) rate limits
        const X = connectFakeSocket('X_rl');
        const res = []; for (let i = 0; i < 200; i++) res.push(await X._emitToServer('ready'));
        check('RL flood of 200 events is throttled', res.filter(r => r.error === 'RATE_LIMITED').length > 100);
        check('RL repeated violations disconnect the socket', X._disconnected === true);

        const Y = connectFakeSocket('Y_rl'); const guesses = [];
        for (let i = 0; i < 12; i++) guesses.push(await Y._emitToServer('joinRoom', { playerId: ID('pY'), nickname: 'y', roomId: 'ZZZZ' + (i % 9 + 2) }));
        check('RL room-code brute force is throttled after repeated failures', guesses.slice(-3).every(g => g.error === 'RATE_LIMITED'));
    }

    // ================= room cap + sweep =================
    {
        roomManager.rooms.clear();
        for (let i = 0; i < roomManager.MAX_ROOMS; i++) roomManager.rooms.set('R' + i, { players: { p1: { connected: true }, p2: null }, status: 'WAITING', touchedAt: Date.now() });
        const { io, connectFakeSocket } = createFakeIO(); registerSocketHandlers(io, FAST);
        const Z = connectFakeSocket('Z');
        check('CAP server full -> SERVER_FULL', (await Z._emitToServer('createRoom', { playerId: ID('pZ'), nickname: 'z' })).error === 'SERVER_FULL');
        for (const r of roomManager.rooms.values()) { r.players.p1.connected = false; r.touchedAt = Date.now() - 11 * 60 * 1000; }
        check('CAP sweep removes abandoned rooms', roomManager.sweep() === roomManager.MAX_ROOMS);
        check('CAP creating a room works again', !!(await Z._emitToServer('createRoom', { playerId: ID('pZ'), nickname: 'z' })).roomId);
        const fresh = { players: { p1: { connected: true } }, status: 'PLAYING', touchedAt: Date.now() - 99 * 60 * 1000 };
        roomManager.rooms.set('LIVE1', fresh);
        check('CAP sweep keeps rooms with a connected player', roomManager.sweep() === 0 && roomManager.rooms.has('LIVE1'));
        roomManager.rooms.clear();
    }

    // ================= sanitize whitelist =================
    {
        const p = S.sanitizePlayer({ id: 1, pos: 'PG', name: 'x', pt3: 10, ovr: 50, secretSeed: 123, socketId: 'abc', hotHand: { a: 1 },
            gameStats: { pts: 2, hidden: 9 }, buffs: [{ stat: 'pt3', val: 1, duration: 2, internal: true }], mid: 'NaN' });
        check('SAN unknown player fields dropped', !('secretSeed' in p) && !('socketId' in p) && !('hotHand' in p));
        check('SAN non-numeric stat dropped', !('mid' in p) && p.pt3 === 10);
        check('SAN nested unknown fields dropped', !('hidden' in p.gameStats) && !('internal' in p.buffs[0]));
        check('SAN unknown event type is not sent', S.sanitizeEvent('SECRET_DEBUG', { a: 1 }) === null);
        check('SAN event extra keys dropped', JSON.stringify(S.sanitizeEvent('SCORE', { p1: 1, p2: 2, token: 'x' })) === '{"p1":1,"p2":2}');
        check('SAN wrong-typed event field dropped', !('made' in S.sanitizeEvent('VIS_SHOT', { shooterId: 1, type: 'pt3', made: 'yes' })));
        check('SAN engine error details hidden', S.sanitizeEvent('ENGINE_ERROR', { message: 'TypeError at /srv/app/x.js:1' }).message === 'ENGINE_ERROR');
        const snap = S.sanitizeSnapshot({ status: 'draft', quarter: 1, possession: 8, score: { p1: 0, p2: 0 }, teams: { p1: { PG: { id: 1, pos: 'PG', name: 'a', secret: 1 } }, p2: {} }, draftPool: [{ id: 2, pos: 'C', name: 'b', secret: 2 }], leak: 'x' });
        check('SAN snapshot has only whitelisted top-level keys', Object.keys(snap).sort().join() === 'currentAttackerId,currentDefenderId,draftPool,draftTurn,hasPassed,isP1Offense,possession,quarter,score,status,teams,turnTimeoutMs');
        check('SAN snapshot players are sanitized', !JSON.stringify(snap).includes('secret'));
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('aborted:', e); process.exit(1); });
