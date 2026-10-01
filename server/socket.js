/*
 * server/socket.js
 * -----------------------------------------------------------------------
 * Routes Socket.IO events to room-manager.js / game-session.js.
 * Does not require socket.io itself (server.js passes `io`), so it can be tested with fake-io.
 *
 * Client -> server events (details + error codes: PROTOCOL.md)
 *   createRoom {playerId, nickname}          -> ack {roomId, slot}
 *   joinRoom   {playerId, nickname, roomId}  -> ack {roomId, slot}
 *   ready                                    -> ack {ok}
 *   draftPick  {pickId}                      -> ack {ok} | {error}
 *   gameAction {requestId, choice}           -> ack {ok} | {error}
 *   leaveRoom                                -> ack {ok}   (deletes the room)
 * Server -> client: roomState, gameReady, gameStart, gameState, gameEvent, actionRequest, invalidAction, roomClosed
 *
 * Room lifecycle (Phase 7): there is NO reconnect. A disconnect, a leaveRoom or a 60 s response timeout
 * ends the game, deletes the room and sends `roomClosed {reason, slot, score}` to whoever is still in it.
 *
 * Phase 5 hardening: every payload is validated (validators.js), every socket is rate limited,
 * a socket can only be in one room, failed room-code guesses are throttled, rooms are capped.
 */
const roomManager = require('./room-manager');
const { createGameSession } = require('./game-session');
const V = require('./validators');
const { sanitizeClosed } = require('./sanitize');
const { createRateLimiter, createWindowCounter } = require('./rate-limiter');

const DEFAULT_LIMITS = {
    capacity: 30, refillPerSec: 10,     // per-socket token bucket (burst 30, 10 events/s sustained)
    maxViolations: 50,                  // after this many rate-limited events the socket is disconnected
    joinFailMax: 8, joinFailWindowMs: 60000,   // room-code guessing throttle
};

function registerSocketHandlers(io, options = {}) {
    const L = { ...DEFAULT_LIMITS, ...(options.limits || {}) };

    /** End the game + delete the room. Everyone still in it gets `roomClosed`, then all sockets leave the room name
     *  (so a later room that happens to reuse the same code can never be heard by old members). */
    function closeRoom(room, reason, slot) {
        const roomId = room.roomId;
        if (!roomManager.getRoom(roomId)) return;
        const score = room.session ? room.session.getScore() : null;
        if (room.session) room.session.dispose();
        roomManager.removeRoom(roomId);
        io.to(roomId).emit('roomClosed', sanitizeClosed(reason, slot, score));
        if (io.in) io.in(roomId).socketsLeave(roomId);
    }

    io.on('connection', (socket) => {
        const limiter = createRateLimiter({ capacity: L.capacity, refillPerSec: L.refillPerSec });
        const joinFails = createWindowCounter(L.joinFailMax, L.joinFailWindowMs);
        let violations = 0;

        /** Safe handler wrapper: rate limit, payload shape, no crash on bad input / exceptions. */
        function on(event, handler, { limited = true } = {}) {
            socket.on(event, (payload, ack) => {
                if (typeof payload === 'function') { ack = payload; payload = {}; }   // socket.emit('ready', ack)
                const reply = typeof ack === 'function' ? ack : () => {};
                if (limited && !limiter.take()) {
                    violations++;
                    reply({ error: 'RATE_LIMITED' });
                    if (violations >= L.maxViolations) socket.disconnect(true);
                    return;
                }
                const safe = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
                try { handler(safe, reply); }
                catch (err) { console.error(`[${event}] handler error:`, err); reply({ error: 'SERVER_ERROR' }); }
            });
        }

        // Game-time errors: ack + invalidAction (PROTOCOL.md)
        const respond = (reply, result, extra) => {
            if (result && result.error) socket.emit('invalidAction', { error: result.error, ...extra });
            reply(result);
        };

        /** The room this socket is really a member of (clears stale data if the room was deleted / code reused). */
        function activeRoom() {
            const id = socket.data.roomId;
            if (!id) return null;
            const room = roomManager.getRoom(id);
            const slot = room && roomManager.findPlayerSlot(room, socket.data.playerId);
            if (room && slot && room.players[slot].socketId === socket.id) return room;
            socket.data.roomId = null; socket.data.playerId = null;
            return null;
        }

        function enter(roomId, playerId) {
            roomManager.setSocket(roomId, playerId, socket.id);
            socket.join(roomId);
            socket.data.playerId = playerId;
            socket.data.roomId = roomId;
        }

        on('createRoom', (payload, reply) => {
            if (activeRoom()) return reply({ error: 'ALREADY_IN_ROOM' });
            const v = V.validateCreate(payload);
            if (v.error) return reply({ error: v.error });
            if (roomManager.rooms.size >= roomManager.MAX_ROOMS) roomManager.sweep();
            if (roomManager.rooms.size >= roomManager.MAX_ROOMS) return reply({ error: 'SERVER_FULL' });

            const room = roomManager.createRoom(v.playerId, v.nickname);
            enter(room.roomId, v.playerId);
            reply({ roomId: room.roomId, slot: 'p1' });
            io.to(room.roomId).emit('roomState', roomManager.sanitizeRoom(room));
        });

        on('joinRoom', (payload, reply) => {
            if (activeRoom()) return reply({ error: 'ALREADY_IN_ROOM' });
            if (joinFails.blocked()) return reply({ error: 'RATE_LIMITED' });
            const v = V.validateJoin(payload);
            if (v.error) { joinFails.record(); return reply({ error: v.error }); }

            const result = roomManager.joinRoom(v.roomId, v.playerId, v.nickname);
            if (result.error) { joinFails.record(); return reply({ error: result.error }); }

            enter(v.roomId, v.playerId);
            reply({ roomId: v.roomId, slot: roomManager.findPlayerSlot(result.room, v.playerId) });
            io.to(v.roomId).emit('roomState', roomManager.sanitizeRoom(result.room));
        });

        on('ready', (_payload, reply) => {
            const mine = activeRoom();
            if (!mine) return reply({ error: 'NOT_IN_ROOM' });
            const { roomId, playerId } = socket.data;
            const result = roomManager.setReady(roomId, playerId);
            if (result.error) return reply({ error: result.error });

            reply({ ok: true });
            io.to(roomId).emit('roomState', roomManager.sanitizeRoom(result.room));
            if (result.bothReady && !result.room.session) {
                io.to(roomId).emit('gameReady', { roomId });
                result.room.session = createGameSession(result.room, io, { ...(options.session || {}), onClose: (reason, slot) => closeRoom(result.room, reason, slot) });
                result.room.session.start();
            }
        });

        on('draftPick', (payload, reply) => {
            const room = activeRoom();
            if (!room || !room.session) return respond(reply, { error: 'NO_GAME' });
            respond(reply, room.session.draftPick(socket.data.playerId, payload.pickId));
        });

        on('gameAction', (payload, reply) => {
            const room = activeRoom();
            if (!room || !room.session) return respond(reply, { error: 'NO_GAME' });
            // Only requestId + choice are read. Any other field the client sends (score, dice, success ...) is ignored.
            respond(reply, room.session.handleAction(socket.data.playerId, { requestId: payload.requestId, choice: payload.choice }),
                { requestId: typeof payload.requestId === 'string' ? payload.requestId.slice(0, 64) : null });
        });

        // Leaving on purpose (back to the lobby): deletes the room, the other player is told.
        on('leaveRoom', (_payload, reply) => {
            const room = activeRoom();
            if (room) closeRoom(room, 'LEFT', roomManager.findPlayerSlot(room, socket.data.playerId));
            reply({ ok: true });
        });

        // Any disconnect ends the game and deletes the room (no reconnect by design).
        on('disconnect', () => {
            const room = activeRoom();
            if (room) closeRoom(room, 'DISCONNECT', roomManager.findPlayerSlot(room, socket.data.playerId));
        }, { limited: false });
    });
}

module.exports = { registerSocketHandlers, DEFAULT_LIMITS };
