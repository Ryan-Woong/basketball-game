/*
 * server/room-manager.js
 * -----------------------------------------------------------------------
 * 방(Room) 생성/참가/준비/퇴장을 다루는 순수 로직 모듈이다.
 * Socket.IO, Express 등 어떤 외부 패키지에도 의존하지 않는다.
 * (그래서 npm install 없이도 이 파일 하나만으로 완전히 테스트할 수 있다.)
 *
 * 방 하나의 모양:
 * {
 *   roomId: "A7K3Q",
 *   status: "WAITING" | "READY" | "PLAYING" | "FINISHED",
 *   players: {
 *     p1: { playerId, nickname, socketId, ready, connected } | null,
 *     p2: { playerId, nickname, socketId, ready, connected } | null
 *   },
 *   createdAt: 1234567890,
 *   session: null, // 게임이 시작되면 이 방 전용 게임 세션(game-session.js)이 들어간다
 * }
 *
 * playerId는 socket.id와 다르다. socket.id는 재접속하면 바뀌지만,
 * playerId는 브라우저(localStorage 등)에 저장되어 같은 경기 동안 고정된다.
 * (요청서 24번 "재접속" 요구사항과 직결)
 */

const rooms = new Map(); // roomId -> room
const MAX_ROOMS = 100;              // memory cap for the free-tier server
const ROOM_TTL_MS = 10 * 60 * 1000; // abandoned / finished rooms are swept after this

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 0/O, 1/I 처럼 헷갈리는 글자는 제외

function generateRoomId() {
    let id;
    do {
        id = Array.from({ length: 5 }, () => ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)]).join('');
    } while (rooms.has(id));
    return id;
}

function makePlayer(playerId, nickname) {
    return { playerId, nickname, socketId: null, ready: false, connected: true };
}

/** 방 생성. 만든 사람이 자동으로 p1(host)이 된다. */
function createRoom(hostPlayerId, hostNickname) {
    const roomId = generateRoomId();
    const room = {
        roomId,
        status: 'WAITING',
        players: { p1: makePlayer(hostPlayerId, hostNickname), p2: null },
        createdAt: Date.now(),
        touchedAt: Date.now(),
        session: null,
    };
    rooms.set(roomId, room);
    return room;
}

/** 방 참가. 이미 그 방의 p2로 들어와 있던 사람(재접속)이면 그대로 반환한다. */
function joinRoom(roomId, guestPlayerId, guestNickname) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    if (room.players.p1.playerId === guestPlayerId) return { error: 'CANNOT_JOIN_OWN_ROOM' };
    if (room.players.p2 && room.players.p2.playerId !== guestPlayerId) return { error: 'ROOM_FULL' };
    if (!room.players.p2) room.players.p2 = makePlayer(guestPlayerId, guestNickname);
    return { room };
}

function getRoom(roomId) {
    return rooms.get(roomId) || null;
}

function findRoomByPlayerId(playerId) {
    for (const room of rooms.values()) {
        if ((room.players.p1 && room.players.p1.playerId === playerId) ||
            (room.players.p2 && room.players.p2.playerId === playerId)) {
            return room;
        }
    }
    return null;
}

function findPlayerSlot(room, playerId) {
    if (room.players.p1 && room.players.p1.playerId === playerId) return 'p1';
    if (room.players.p2 && room.players.p2.playerId === playerId) return 'p2';
    return null;
}

/** 이 플레이어의 소켓 연결 정보를 방에 기록한다 (최초 접속/재접속 공용). */
function setSocket(roomId, playerId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return null;
    const slot = findPlayerSlot(room, playerId);
    if (!slot) return null;
    room.players[slot].socketId = socketId;
    room.players[slot].connected = true;
    room.touchedAt = Date.now();
    return room;
}

/** READY 표시. 둘 다 READY면 status를 READY로 바꾸고 bothReady:true를 알려준다. */
function setReady(roomId, playerId) {
    const room = rooms.get(roomId);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    const slot = findPlayerSlot(room, playerId);
    if (!slot) return { error: 'NOT_IN_ROOM' };
    if (room.status === 'PLAYING' || room.status === 'FINISHED') return { error: 'GAME_ALREADY_STARTED' };
    if (!room.players.p2) return { error: 'WAITING_FOR_OPPONENT' };
    room.players[slot].ready = true;
    const bothReady = !!(room.players.p1.ready && room.players.p2.ready);
    if (bothReady) room.status = 'READY';
    return { room, bothReady };
}

/** 연결 끊김 표시 (방은 지우지 않는다 — 재접속 대기는 상위 계층(socket.js)이 타이머로 처리). */
function markDisconnected(playerId) {
    const room = findRoomByPlayerId(playerId);
    if (!room) return null;
    const slot = findPlayerSlot(room, playerId);
    if (slot) room.players[slot].connected = false;
    room.touchedAt = Date.now();
    return room;
}

/** Remove rooms nobody is connected to (or finished ones) that have been idle longer than ttl. Returns removed count. */
function sweep(now = Date.now(), ttl = ROOM_TTL_MS) {
    let removed = 0;
    for (const [id, room] of rooms) {
        const nobody = ['p1', 'p2'].every(s => !room.players[s] || !room.players[s].connected);
        const idle = now - room.touchedAt > ttl;
        if (idle && (nobody || room.status === 'FINISHED')) { rooms.delete(id); removed++; }
    }
    return removed;
}

function removeRoom(roomId) {
    rooms.delete(roomId);
}

/** 클라이언트에 보내도 안전한 형태로 방 정보를 가공.
 *  socketId뿐 아니라 playerId도 내보내지 않는다. playerId는 "나 자신임을 증명하는 비밀값"이라
 *  상대방이 알게 되면 안 된다. 클라이언트는 자기 자리(p1/p2)를 응답(ack)으로 이미 알고 있다. */
function sanitizeRoom(room) {
    const pub = (p) => p ? { nickname: p.nickname, ready: p.ready, connected: p.connected } : null;
    return { roomId: room.roomId, status: room.status, players: { p1: pub(room.players.p1), p2: pub(room.players.p2) } };
}

module.exports = {
    rooms, MAX_ROOMS, ROOM_TTL_MS, sweep, generateRoomId, createRoom, joinRoom, getRoom,
    findRoomByPlayerId, findPlayerSlot, setSocket, setReady,
    markDisconnected, removeRoom, sanitizeRoom,
};
