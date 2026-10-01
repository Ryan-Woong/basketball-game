#!/usr/bin/env node
/*
 * scripts/smoke-pvp.js
 * -----------------------------------------------------------------------
 * Plays one COMPLETE 1:1 game against a running server with two real Socket.IO clients (no browser needed).
 * Use it right after deploying to Render (or against http://localhost:3000):
 *
 *     npm install                       (once; installs socket.io-client from devDependencies)
 *     npm run smoke -- https://<name>.onrender.com
 *     npm run smoke -- http://localhost:3000 --think 2000
 *
 * Options:  --think <ms>    simulated thinking time before each answer (default 0)
 *           --timeout <s>   give up after this many seconds (default 1800)
 *           --wake <s>      how long to wait for a sleeping Render service to wake up (default 150)
 *
 * What it checks: cold start / wake-up time, health endpoint, WebSocket upgrade, room create/join/ready,
 * alternating draft, a full 4-quarter game with both players deciding, identical event streams on both
 * clients, contiguous seq numbers, server-side rejection of forged/stale actions, leaveRoom + roomClosed.
 * A full game takes about 8 minutes of server pacing plus your think time (the server keeps the original
 * animation pacing), so this also keeps a free Render instance awake the whole time.
 */
const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
const fmt = (ms) => (ms / 1000).toFixed(1) + 's';

/**
 * Core logic with injected I/O so it can be unit-tested without a network.
 *   connect(url) -> Promise<{ emit(event, payload, ack), on(event, fn), close(), transport?() }>
 *   httpGet(url) -> Promise<{ status, body }>
 */
async function runSmoke({ url, connect, httpGet, thinkMs = 0, timeoutMs = 30 * 60 * 1000, wakeMs = 150 * 1000, log = console.log, sleep = (ms) => new Promise(r => setTimeout(r, ms)) }) {
    const results = [];
    const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`); return !!ok; };
    const t0 = Date.now();
    const send = (c, ev, payload) => new Promise((res) => c.emit(ev, payload || {}, (r) => res(r || {})));
    const rid = () => Array.from({ length: 32 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

    // 1) health endpoint (also wakes a sleeping Render service)
    log(`\n[1] Health check ${url}/healthz  (a sleeping free Render service can take up to ~1 minute)`);
    const hs = Date.now(); let health = null;
    while (Date.now() - hs < wakeMs) {
        try { health = await httpGet(url.replace(/\/$/, '') + '/healthz'); if (health.status === 200) break; } catch (e) { health = null; }
        await sleep(3000);
    }
    check('server answers /healthz with "ok"', health && health.status === 200 && String(health.body).trim() === 'ok', `took ${fmt(Date.now() - hs)}`);
    if (!health || health.status !== 200) return finish();

    // 2) connect two players
    log('\n[2] Connecting two Socket.IO clients');
    const cs = Date.now();
    const A = await connect(url), B = await connect(url);
    check('both clients connected', !!A && !!B, `took ${fmt(Date.now() - cs)}`);
    await sleep(1500);   // let the polling -> websocket upgrade finish
    const tA = A.transport ? A.transport() : 'n/a', tB = B.transport ? B.transport() : 'n/a';
    check('WebSocket upgrade succeeded (not stuck on long-polling)', (tA === 'websocket' && tB === 'websocket') || tA === 'n/a', `A=${tA}, B=${tB}`);

    const ev = { A: [], B: [] }, reqs = { A: [], B: [] }, states = { A: [], B: [] }, closed = { A: [], B: [] };
    for (const [k, c] of [['A', A], ['B', B]]) {
        c.on('gameEvent', (e) => ev[k].push(e));
        c.on('gameState', (m) => states[k].push(m.state));
        c.on('actionRequest', (r) => reqs[k].push({ r, at: Date.now() }));
        c.on('roomClosed', (m) => closed[k].push(m));
    }
    const idA = rid(), idB = rid();

    // 3) room
    log('\n[3] Room: create / join / ready');
    const created = await send(A, 'createRoom', { playerId: idA, nickname: 'SmokeA' });
    check('A created a room (5-char code, slot p1)', created.roomId && /^[A-Z2-9]{5}$/.test(created.roomId) && created.slot === 'p1', created.roomId || JSON.stringify(created));
    const joined = await send(B, 'joinRoom', { playerId: idB, nickname: 'SmokeB', roomId: created.roomId });
    check('B joined with the code (slot p2)', joined.slot === 'p2');
    const C = await connect(url);
    check('a third player cannot join the full room', (await send(C, 'joinRoom', { playerId: rid(), nickname: 'C', roomId: created.roomId })).error === 'ROOM_FULL');
    C.close();
    check('B cannot act before the game starts (NO_GAME)', (await send(B, 'draftPick', { pickId: 1 })).error === 'NO_GAME');
    const ra = await send(A, 'ready'), rb = await send(B, 'ready');
    check('both ready accepted', ra.ok && rb.ok);

    // 4) draft
    log('\n[4] Draft (p1 first, alternating)');
    const last = (k) => states[k][states[k].length - 1];
    const waitFor = async (fn, label, ms) => { const s = Date.now(); while (!fn()) { if (Date.now() - s > ms) throw new Error('timeout waiting for ' + label); await sleep(100); } };
    await waitFor(() => states.A.length > 0 && states.B.length > 0, 'draft state', 20000);
    check('draft starts on p1 turn with a 60 s limit, same state on both clients', last('A').status === 'draft' && last('A').draftTurn === 'p1' && last('A').turnTimeoutMs === 60000 && JSON.stringify(last('A')) === JSON.stringify(last('B')));
    const st0 = last('A');
    check('p2 picking on p1 turn is rejected (NOT_YOUR_TURN)', (await send(B, 'draftPick', { pickId: st0.draftPool[0].id })).error === 'NOT_YOUR_TURN');
    let picks = 0;
    while (last('A').status === 'draft') {
        const s = last('A'), turn = s.draftTurn, c = turn === 'p1' ? A : B;
        const missing = POS.filter(p => !s.teams[turn][p]);
        const cand = s.draftPool.find(p => missing.includes(p.pos));
        if (thinkMs) await sleep(thinkMs);
        const r = await send(c, 'draftPick', { pickId: cand.id });
        if (!r.ok) { check('draft pick accepted', false, JSON.stringify(r)); return finish(); }
        picks++; await sleep(150);
        if (picks > 12) break;
    }
    check('draft completed with 10 picks, 5 players each', picks === 10 && POS.every(p => last('A').teams.p1[p] && last('A').teams.p2[p]));

    // 5) game
    log('\n[5] Game (both players answer their own decisions; this takes several minutes)');
    let ended = null, probed = false, answered = { A: 0, B: 0 }, slowest = 0, lastProgress = Date.now();
    const answerLoop = async (k, c) => {
        let handled = 0;
        while (!ended) {
            if (reqs[k].length > handled) {
                const { r, at } = reqs[k][handled++];
                if (!probed) {   // once: the server must reject a forged / stale / foreign answer
                    probed = true;
                    const other = k === 'A' ? B : A;
                    check('a bogus requestId is rejected (STALE_REQUEST)', (await send(c, 'gameAction', { requestId: 'bogus', choice: r.options[0].id })).error === 'STALE_REQUEST');
                    check('the other player cannot answer my decision (NOT_YOUR_SEAT)', (await send(other, 'gameAction', { requestId: r.requestId, choice: r.options[0].id })).error === 'NOT_YOUR_SEAT');
                    check('a choice that was not offered is rejected (INVALID_CHOICE)', (await send(c, 'gameAction', { requestId: r.requestId, choice: '__hack__' })).error === 'INVALID_CHOICE');
                    check('server announces the 60 s limit in the request', r.timeoutMs === 60000);
                }
                if (thinkMs) await sleep(thinkMs);
                const choice = r.options[Math.floor(Math.random() * r.options.length)].id;
                const res = await send(c, 'gameAction', { requestId: r.requestId, choice, score: 999, dice: 20 });   // extra fields must be ignored
                slowest = Math.max(slowest, Date.now() - at);
                if (res.ok) answered[k]++; else if (!ended) { check('game action accepted', false, JSON.stringify(res)); ended = 'error'; }
            } else await sleep(50);
        }
    };
    const loops = [answerLoop('A', A), answerLoop('B', B)];
    const gs = Date.now();
    while (!ended) {
        if (ev.A.some(e => e.type === 'GAME_END')) ended = 'ok';
        else if (closed.A.length || closed.B.length) ended = 'closed';
        else if (Date.now() - t0 > timeoutMs) ended = 'timeout';
        else if (Date.now() - lastProgress > 20000) { lastProgress = Date.now(); const q = [...ev.A].reverse().find(e => e.type === 'VIS_RESET'); log(`    ... ${fmt(Date.now() - gs)} elapsed, events=${ev.A.length}, Q${q ? q.data.quarter : '?'}, decisions A=${answered.A} B=${answered.B}`); }
        await sleep(200);
    }
    await Promise.all(loops); await sleep(1500);
    check('game reached GAME_END', ended === 'ok', ended === 'ok' ? `game took ${fmt(Date.now() - gs)}` : 'ended=' + ended);
    if (ended !== 'ok') return finish();

    // 6) verification
    log('\n[6] Verification');
    const endEv = ev.A.find(e => e.type === 'GAME_END').data;
    check('both clients received identical event streams', JSON.stringify(ev.A) === JSON.stringify(ev.B), `${ev.A.length} events`);
    check('event seq numbers are contiguous (no loss over the real network)', ev.A.every((e, i) => e.seq === i + 1) && ev.B.every((e, i) => e.seq === i + 1));
    check('both players had to decide (decisions p1/p2)', answered.A > 20 && answered.B > 20, `A=${answered.A}, B=${answered.B}`);
    check('every request was addressed to exactly one player', reqs.A.length + reqs.B.length === ev.A.filter(e => e.type === 'WAITING_FOR_ACTION').length);
    const lastScore = [...ev.A].reverse().find(e => e.type === 'SCORE').data;
    check('final score is consistent and points were scored', lastScore.p1 === endEv.p1Score && lastScore.p2 === endEv.p2Score && endEv.p1Score + endEv.p2Score > 0, `${endEv.p1Score} : ${endEv.p2Score}`);
    check('client-supplied score/dice fields were ignored', endEv.p1Score < 150 && endEv.p2Score < 150);
    check('no roomClosed / timeout during the game', closed.A.length === 0 && closed.B.length === 0);
    check('no secret leaks (playerId never appears in any message)', !JSON.stringify([ev.A, states.A, ev.B, states.B]).includes(idA) && !JSON.stringify([ev.A, states.A, ev.B, states.B]).includes(idB));
    log(`    slowest answer round trip (server request -> your ack): ${fmt(slowest)}`);

    // 7) leave
    log('\n[7] Leaving');
    await send(A, 'leaveRoom'); await sleep(1500);
    check('after A leaves, B is told (roomClosed LEFT) and the room is gone', closed.B.length === 1 && closed.B[0].reason === 'LEFT');
    check('B can no longer act in the deleted room', (await send(B, 'gameAction', { requestId: 'x', choice: 'drive' })).error === 'NO_GAME');
    A.close(); B.close();
    return finish();

    function finish() {
        const failed = results.filter(r => !r.ok);
        log(`\n=== ${results.length - failed.length} passed, ${failed.length} failed  (total ${fmt(Date.now() - t0)}) ===`);
        if (failed.length) failed.forEach(f => log('  FAILED: ' + f.name + (f.extra ? ' - ' + f.extra : '')));
        return { passed: results.length - failed.length, failed: failed.length, results };
    }
}

/* ---------------- CLI (real network) ---------------- */
async function main() {
    const args = process.argv.slice(2);
    const url = (args.find(a => /^https?:\/\//.test(a)) || 'http://localhost:3000').replace(/\/$/, '');
    const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? Number(args[i + 1]) : def; };
    let ioClient;
    try { ioClient = require('socket.io-client').io; }
    catch (e) { console.error('socket.io-client is not installed. Run `npm install` first (it is a devDependency).'); process.exit(2); }
    const connect = (u) => new Promise((resolve, reject) => {
        const s = ioClient(u, { reconnection: false, timeout: 20000 });
        s.on('connect', () => resolve({
            emit: (ev, p, ack) => s.emit(ev, p, ack), on: (ev, fn) => s.on(ev, fn), close: () => s.close(),
            transport: () => (s.io.engine && s.io.engine.transport ? s.io.engine.transport.name : 'n/a'),
        }));
        s.on('connect_error', (e) => reject(e));
    });
    const httpGet = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(20000) }); return { status: r.status, body: await r.text() }; };
    console.log(`Smoke test against ${url}`);
    const out = await runSmoke({ url, connect, httpGet, thinkMs: opt('think', 0), timeoutMs: opt('timeout', 1800) * 1000, wakeMs: opt('wake', 150) * 1000 });
    process.exit(out.failed ? 1 : 0);
}

module.exports = { runSmoke };
if (require.main === module) main().catch((e) => { console.error('smoke test aborted:', e && e.message ? e.message : e); process.exit(1); });
