/*
 * Verifies the LOGIC of scripts/smoke-pvp.js against the fake socket layer (no network).
 * The real-network run (npm run smoke -- <url>) is what proves Render / real Socket.IO; this only proves the script itself is correct.
 */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);   // accelerate engine sleep()

const { registerSocketHandlers } = require('./socket');
const { createFakeIO, NEVER_TIMERS } = require('./test-utils/fake-io');
const { runSmoke } = require('../scripts/smoke-pvp');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error('  FAIL:', n); } };

function makeConnect(connectFakeSocket) {
    let n = 0;
    return async () => {
        const srv = connectFakeSocket('smoke_' + (++n)), handlers = {};
        srv._onEvent = (event, payload) => { if (handlers[event]) handlers[event](payload); };
        return { emit: (ev, p, ack) => srv._emitToServer(ev, p).then(r => ack && ack(r)), on: (ev, fn) => { handlers[ev] = fn; }, close: () => srv._emitToServer('disconnect'), transport: () => 'websocket' };
    };
}
const quiet = () => {};
const fastSleep = (ms) => new Promise(r => realSetTimeout(r, ms > 0 ? 1 : 0));

(async () => {
    {   // healthy server: the whole script passes
        const { io, connectFakeSocket } = createFakeIO();
        registerSocketHandlers(io, { limits: { capacity: 1e6, refillPerSec: 1e6 }, session: { timers: NEVER_TIMERS } });
        const out = await runSmoke({ url: 'http://fake', connect: makeConnect(connectFakeSocket), httpGet: async () => ({ status: 200, body: 'ok\n' }), log: quiet, sleep: fastSleep });
        check('SMOKE healthy server: every check passes', out.failed === 0 && out.passed >= 26);
        if (out.failed) console.error(out.results.filter(r => !r.ok));
        const names = out.results.map(r => r.name).join('|');
        for (const k of ['WebSocket upgrade', 'identical event streams', 'contiguous', 'STALE_REQUEST', 'NOT_YOUR_SEAT', 'INVALID_CHOICE', 'roomClosed LEFT', 'secret leaks'])
            check(`SMOKE covers: ${k}`, names.includes(k));
    }
    {   // server that never becomes healthy: fails cleanly and early
        const out = await runSmoke({ url: 'http://fake', connect: async () => { throw new Error('should not connect'); }, httpGet: async () => ({ status: 503, body: 'down' }), wakeMs: 30, log: quiet, sleep: fastSleep });
        check('SMOKE unhealthy server: reports failure without trying to connect', out.failed === 1 && out.results[0].name.includes('/healthz'));
    }
    {   // a server that breaks the protocol (drops events for one client) is detected
        const { io, connectFakeSocket } = createFakeIO();
        registerSocketHandlers(io, { limits: { capacity: 1e6, refillPerSec: 1e6 }, session: { timers: NEVER_TIMERS } });
        const baseConnect = makeConnect(connectFakeSocket); let count = 0;
        const connect = async (u) => {
            const c = await baseConnect(u); count++;
            if (count !== 2) return c;               // the second client (B) loses every 7th gameEvent
            let k = 0; const on = c.on;
            return { ...c, on: (ev, fn) => on(ev, ev === 'gameEvent' ? (e) => { if (++k % 7 !== 0) fn(e); } : fn) };
        };
        const out = await runSmoke({ url: 'http://fake', connect, httpGet: async () => ({ status: 200, body: 'ok' }), log: quiet, sleep: fastSleep });
        check('SMOKE detects lost / diverging events', out.results.some(r => !r.ok && /identical|contiguous/.test(r.name)));
    }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch(e => { console.error('aborted:', e); process.exit(1); });
