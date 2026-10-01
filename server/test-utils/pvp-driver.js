/* Helpers for tests: drive two fake clients through the draft and the game. */
const POS = ['PG', 'SG', 'SF', 'PF', 'C'];

const latestState = (sock) => { const a = sock._eventsOf('gameState'); return a[a.length - 1].state; };

/** Alternating draft driven by the server's `draftTurn`. Each pick is made by the player whose turn it is. */
async function draftAll(A, B, extra = {}) {
    for (;;) {
        const st = latestState(A);
        if (st.status !== 'draft') return;
        const turn = st.draftTurn, sock = turn === 'p1' ? A : B;
        const missing = POS.filter(p => !st.teams[turn][p]);
        const cand = st.draftPool.find(p => missing.includes(p.pos));
        const r = await sock._emitToServer('draftPick', { pickId: cand.id, ...extra });
        if (!r.ok) throw new Error('draft pick failed: ' + JSON.stringify(r));
    }
}

/** Both fake clients answer actionRequests addressed to them. onRequest(sock, payload) can override. Resolves on GAME_END. */
function autoplay(A, B, { onRequest } = {}) {
    let end; const done = new Promise(r => { end = r; });
    const handler = (sock) => async (event, payload) => {
        try {
            if (event === 'gameEvent' && payload.type === 'GAME_END') end();
            if (event !== 'actionRequest') return;
            if (onRequest) return await onRequest(sock, payload);
            const choice = payload.options[Math.floor(Math.random() * payload.options.length)].id;
            await sock._emitToServer('gameAction', { requestId: payload.requestId, choice });
        } catch (e) { console.error('driver error:', e); }
    };
    A._onEvent = handler(A); B._onEvent = handler(B);
    return done;
}

const { setTimeout: realSetTimeout } = require('timers');   // real timer even when tests accelerate global.setTimeout
const withTimeout = (p, ms, label = 'timeout') => Promise.race([p, new Promise((_, j) => realSetTimeout(() => j(new Error(label)), ms))]);

module.exports = { POS, latestState, draftAll, autoplay, withTimeout };
