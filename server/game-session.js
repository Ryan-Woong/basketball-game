/*
 * server/game-session.js
 * -----------------------------------------------------------------------
 * One session per room. Owns one game engine (mode 'pvp') and converts the engine's io
 * (log / emit / score / requestAction) into Socket.IO traffic.
 *
 * Phase 6: both players are humans. Engine side "user" == p1, side "cpu" == p2 (internal names kept so
 * the rule code is untouched). This file is the boundary: everything sent to clients uses p1/p2.
 *   - requestAction(slot, ...) -> the actionRequest goes ONLY to that player; the engine waits for the answer.
 *   - draft alternates p1, p2, p1, p2 ... (the original order: the first side picks first each round).
 * Clients only say WHAT they choose; dice / checks / score stay inside the engine on the server.
 * Still open: AFK players stall the game (no turn timer), disconnects are not recovered (Phase 9).
 */
const createGameEngine = require('./game-engine/game');
const V = require('./validators');
const { sanitizeSnapshot, sanitizeEvent } = require('./sanitize');

const MAX_EVENT_BUFFER = 5000;   // recent events kept for reconnect recovery (Phase 9)
const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const clone = (v) => JSON.parse(JSON.stringify(v));

function slotOf(room, playerId) {
    if (room.players.p1 && room.players.p1.playerId === playerId) return 'p1';
    if (room.players.p2 && room.players.p2.playerId === playerId) return 'p2';
    return null;
}

const DEFAULT_TURN_TIMEOUT_MS = 60 * 1000;

/**
 * opts.turnTimeoutMs : how long a player may take for one draft pick / one decision (default 60 s)
 * opts.timers        : { set(fn, ms) -> handle, clear(handle) } injectable for tests
 * opts.onClose(reason, slot) : called when the session itself ends the room (timeout forfeit)
 */
function createGameSession(room, io, opts = {}) {
    const roomId = room.roomId;
    const turnTimeoutMs = opts.turnTimeoutMs || DEFAULT_TURN_TIMEOUT_MS;
    const timers = opts.timers || { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h) };
    let seq = 0, requestCounter = 0, pending = null, started = false, closed = false, turnTimer = null;
    const events = [];

    // ---- turn timer: one player must act within turnTimeoutMs, otherwise they forfeit and the room is closed ----
    function clearTurnTimer() { if (turnTimer !== null) { timers.clear(turnTimer); turnTimer = null; } }
    function armTurnTimer(slot) {
        clearTurnTimer();
        turnTimer = timers.set(() => { turnTimer = null; if (!closed) { closed = true; pending = null; if (opts.onClose) opts.onClose('TIMEOUT', slot); } }, turnTimeoutMs);
    }
    /** Stop everything (room is being deleted). The paused engine is simply never resumed. */
    function dispose() { closed = true; clearTurnTimer(); pending = null; }

    function pushEvent(type, data) {
        if (closed) return null;
        const clean = sanitizeEvent(type, data);          // whitelist: unknown event types never leave the server
        if (!clean) { console.warn(`[session ${roomId}] dropped non-whitelisted event: ${type}`); return null; }
        room.touchedAt = Date.now();
        const evt = { seq: ++seq, type, data: clone(clean) };
        events.push(evt);
        if (events.length > MAX_EVENT_BUFFER) events.shift();
        io.to(roomId).emit('gameEvent', evt);
        return evt;
    }

    function sendToSlot(slot, name, payload) {
        const p = room.players[slot];
        if (p && p.socketId) io.to(p.socketId).emit(name, payload);   // socket.id is a private room of that socket
    }

    // ---- engine io -> clients (engine side names user/cpu are mapped to p1/p2 here) ----------------
    const engineIo = {
        log(text, cls) { pushEvent('LOG', { text, cls }); },
        score(user, cpu) { pushEvent('SCORE', { p1: user, p2: cpu }); },
        emit(type, payload) {
            payload = payload || {};
            if (type === 'GAME_END') {
                pending = null; clearTurnTimer(); room.status = 'FINISHED';
                const b = payload.boxScore || {};
                return void pushEvent('GAME_END', { p1Score: payload.userScore, p2Score: payload.cpuScore, boxScore: { p1: b.user, p2: b.cpu } });
            }
            if (type === 'ENGINE_ERROR') {
                pending = null; clearTurnTimer(); room.status = 'FINISHED';
                console.error(`[session ${roomId}] engine error:`, payload.message);
            }
            if (type === 'VIS_FAST_BREAK') return void pushEvent(type, { playerId: payload.playerId, isP1Side: payload.isUserSide });
            if (type === 'VIS_RESET') return void pushEvent(type, { isP1Offense: payload.isUserOffense, attackerId: payload.attackerId, quarter: payload.quarter, possession: payload.possession });
            if (type === 'TEAM_STATE') return void pushEvent(type, { p1: payload.user, p2: payload.cpu });
            pushEvent(type, payload);
        },
        // Originally "wait for a button click". The engine is paused here until the right player answers.
        requestAction(slot, options, title) {
            return new Promise((resolve) => {
                if (closed) return;                       // room is gone: leave the engine paused forever
                const requestId = `${roomId}-${++requestCounter}`;
                pending = { requestId, forSlot: slot, options: options.map(o => ({ ...o })), resolve };
                // pending is set BEFORE anything is sent, so even an instant answer is accepted
                armTurnTimer(slot);
                pushEvent('WAITING_FOR_ACTION', { forSlot: slot, title, requestId, timeoutMs: turnTimeoutMs });
                sendToSlot(slot, 'actionRequest', {
                    requestId, title, timeoutMs: turnTimeoutMs,
                    options: options.map(o => ({ id: String(o.id), label: o.label, stat: o.stat || null, statVal: o.statVal === undefined ? null : o.statVal })),
                });
            });
        },
    };

    const nick = (s) => (room.players[s] && room.players[s].nickname) || s.toUpperCase();
    const labels = { p1: nick('p1'), p2: nick('p2') };
    if (labels.p1 === labels.p2) labels.p2 += ' (2)';
    const engine = createGameEngine(engineIo, { mode: 'pvp', labels });

    // ---- draft turn: p1 picks first, then p2, alternating (equal roster sizes => p1's turn) ----------
    const filled = (team) => POSITIONS.filter(p => team[p]).length;
    function draftTurn() {
        const s = engine.getState();
        if (s.gameStatus !== 'draft') return null;
        return filled(s.userTeam) <= filled(s.cpuTeam) ? 'p1' : 'p2';
    }

    function snapshot() {
        const s = engine.getState();
        return sanitizeSnapshot(clone({
            status: s.gameStatus, quarter: s.quarter, possession: s.possession,
            score: { p1: s.userScore, p2: s.cpuScore },
            isP1Offense: s.isUserOffense, hasPassed: s.hasPassed,
            currentAttackerId: s.currentAttacker ? s.currentAttacker.id : null,
            currentDefenderId: s.currentDefender ? s.currentDefender.id : null,
            teams: { p1: s.userTeam, p2: s.cpuTeam },
            draftPool: s.draftPool,
            draftTurn: draftTurn(),
            turnTimeoutMs: draftTurn() ? turnTimeoutMs : null,
        }));
    }
    const publishState = () => { if (!closed) io.to(roomId).emit('gameState', { atSeq: seq, state: snapshot() }); };

    // ---- public API ----------------------------------------------------------------------------
    function start() {
        if (started) return false;
        started = true;
        room.status = 'PLAYING';
        io.to(roomId).emit('gameStart', { roomId, mode: 'PVP' });
        engine.initDraftPool();
        armTurnTimer('p1');                 // p1 picks first
        publishState();
        return true;
    }

    /** Draft pick: the client sends only WHICH player; turn order and validity are checked here. */
    function draftPick(playerId, pickId) {
        const s = started ? engine.getState() : null;
        const slot = slotOf(room, playerId);
        const r = V.checkDraftPick({
            started, slot, status: s && s.gameStatus, turnSlot: s && draftTurn(), pickId,
            pool: s && s.draftPool, team: s && (slot === 'p2' ? s.cpuTeam : s.userTeam),
        });
        if (r.error) return r;
        engine.draftPlayerPvp(slot === 'p1', r.id);
        const next = draftTurn();
        if (next) armTurnTimer(next); else clearTurnTimer();   // draft over: the first decision request arms its own timer
        publishState();
        return { ok: true };
    }

    /** Answer to the single pending request. All checks live in validators.checkAction. */
    function handleAction(playerId, payload) {
        const { requestId, choice } = payload || {};
        const r = V.checkAction({ started, pending, slot: slotOf(room, playerId), requestId, choice });
        if (r.error) return r;
        const resolve = pending.resolve;
        clearTurnTimer();
        pending = null;            // a second answer to the same request is rejected from here on
        resolve(r.option.id);      // the engine resumes exactly where it was paused
        return { ok: true };
    }

    return {
        start, draftPick, handleAction, snapshot, dispose,
        getScore: () => { const s = engine.getState(); return { p1: s.userScore, p2: s.cpuScore }; },
        isStarted: () => started,
        getEvents: () => events.slice(),
        getPending: () => pending && { requestId: pending.requestId, forSlot: pending.forSlot },
    };
}

module.exports = { createGameSession, POSITIONS };
