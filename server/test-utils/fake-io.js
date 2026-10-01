/*
 * server/test-utils/fake-io.js
 * -----------------------------------------------------------------------
 * 진짜 Socket.IO 없이 socket.js / game-session.js를 테스트하기 위한 "가짜 io".
 * 실제 Socket.IO와 같은 점:
 *   - 전달되는 payload를 JSON으로 복사한다(순환 참조 등 직렬화 불가 데이터가 있으면 여기서 터진다)
 *   - 모든 소켓은 자기 socket.id 이름의 방에 자동으로 들어가 있다 (io.to(socket.id)로 한 명에게만 전송)
 * 다른 점:
 *   - 네트워크 지연이 없다. 단, _onEvent 콜백은 비동기(마이크로태스크)로 호출해서
 *     "서버 핸들러 실행 중에 클라이언트가 끼어드는" 비현실적인 재진입을 막는다.
 */
function createFakeIO() {
    const socketsById = new Map();
    const roomMembers = new Map();
    let connectionHandler = null;

    function deliver(sid, event, payload) {
        const s = socketsById.get(sid);
        if (!s) return;
        const copy = payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
        s._received.push({ event, payload: copy });
        if (s._onEvent) {
            const cb = s._onEvent;
            Promise.resolve().then(() => cb(event, copy));
        }
    }

    const io = {
        in(room) { return { socketsLeave(r) { const m = roomMembers.get(r || room); if (m) m.clear(); } }; },
        on(event, handler) { if (event === 'connection') connectionHandler = handler; },
        to(room) {
            return {
                emit(event, payload) {
                    (roomMembers.get(room) || new Set()).forEach((sid) => deliver(sid, event, payload));
                },
            };
        },
    };

    function connectFakeSocket(id) {
        const handlers = {};
        const socket = {
            id,
            data: {},
            _received: [],
            _onEvent: null,
            on(event, cb) { handlers[event] = cb; },
            join(room) {
                if (!roomMembers.has(room)) roomMembers.set(room, new Set());
                roomMembers.get(room).add(id);
            },
            emit(event, payload) { deliver(id, event, payload); },   // 이 소켓 한 명에게만 전송
            _disconnected: false,
            disconnect() { if (socket._disconnected) return; socket._disconnected = true; if (handlers.disconnect) handlers.disconnect(undefined, () => {}); },
            // 테스트에서 "클라이언트가 서버에 이벤트를 보낸다"를 흉내 낸다
            _emitToServer(event, payload) {
                return new Promise((resolve) => {
                    const ack = (res) => resolve(res);
                    if (!handlers[event]) return resolve(undefined);
                    handlers[event](payload, ack);
                    if (event === 'disconnect') resolve();
                });
            },
            _eventsOf(name) { return socket._received.filter(r => r.event === name).map(r => r.payload); },
        };
        socketsById.set(id, socket);
        socket.join(id);
        connectionHandler(socket);
        return socket;
    }

    return { io, connectFakeSocket };
}

/** Manual clock for session timers: nothing fires until advance(ms) is called. */
function createFakeTimers() {
    let now = 0, nextId = 1; const list = new Map();
    return {
        set(fn, ms) { const id = nextId++; list.set(id, { at: now + ms, fn }); return id; },
        clear(id) { list.delete(id); },
        advance(ms) { now += ms; for (const [id, t] of [...list]) if (t.at <= now) { list.delete(id); t.fn(); } },
        count() { return list.size; },
    };
}
const NEVER_TIMERS = { set: () => 1, clear: () => {} };   // timers that never fire (normal tests)

module.exports = { createFakeIO, createFakeTimers, NEVER_TIMERS };
