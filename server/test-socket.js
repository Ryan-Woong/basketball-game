/*
 * server/test-socket.js
 * -----------------------------------------------------------------------
 * socket.js가 실제 Socket.IO 패키지 없이도 올바르게 동작하는지 확인하는
 * 단위 테스트다. 진짜 io 객체를 아주 작게 흉내 낸 "가짜 io"를 만들어서
 * registerSocketHandlers(fakeIo)에 넣고, 두 명의 가짜 소켓(A, B)이
 * "방 만들기 -> 참가 -> READY -> 연결 끊김" 순서로 행동하게 시켜본다.
 *
 * 이 테스트가 통과한다고 해서 실제 네트워크로 두 브라우저가 통신하는 것까지
 * 보장하지는 않는다 (그건 npm install 후 실제 서버를 띄워 확인해야 한다).
 * 다만 이벤트 라우팅과 방 상태 전이 로직 자체는 이 테스트로 충분히 검증된다.
 *
 * 실행: node server/test-socket.js  (npm install 불필요)
 */
const { registerSocketHandlers } = require('./socket');

const { createFakeIO, NEVER_TIMERS } = require('./test-utils/fake-io');

// ---- 테스트 본문 ------------------------------------------------------------------
let pass = 0, fail = 0;
function check(name, cond) { if (cond) pass++; else { fail++; console.error('FAIL:', name); } }

async function main() {
    const { io, connectFakeSocket } = createFakeIO();
    registerSocketHandlers(io, { session: { timers: NEVER_TIMERS } });

    const socketA = connectFakeSocket('sock_A1');
    const socketB = connectFakeSocket('sock_B1');

    // 1. A가 방 생성
    const createRes = await socketA._emitToServer('createRoom', { playerId: 'player_A_0123456789abcdef', nickname: '철수' });
    check('방 생성 응답에 roomId 존재', typeof createRes.roomId === 'string' && createRes.roomId.length === 5);
    check('A는 p1 슬롯', createRes.slot === 'p1');
    const roomId = createRes.roomId;

    // 2. B가 잘못된 코드로 참가 시도
    const badJoin = await socketB._emitToServer('joinRoom', { playerId: 'player_B_0123456789abcdef', nickname: '영희', roomId: 'ZZZZZ' });
    check('없는 방 참가는 거부됨', badJoin.error === 'ROOM_NOT_FOUND');

    // 3. B가 올바른 코드로 참가
    const joinRes = await socketB._emitToServer('joinRoom', { playerId: 'player_B_0123456789abcdef', nickname: '영희', roomId });
    check('참가 성공', !joinRes.error);
    check('B는 p2 슬롯', joinRes.slot === 'p2');

    // 4. A가 참가 브로드캐스트(roomState)를 받았는지 (자기 자신도 같은 방 소속이므로 받아야 함)
    const aGotRoomState = socketA._received.some(r => r.event === 'roomState' && r.payload.players.p2 && r.payload.players.p2.nickname === '영희');
    check('A가 B 참가 소식을 roomState로 받음', aGotRoomState);

    // 5. sanitize된 roomState에 socketId가 없는지
    const anyLeak = socketA._received.some(r => r.event === 'roomState' && JSON.stringify(r.payload).includes('socketId'));
    check('클라이언트로 나가는 데이터에 socketId 노출 없음', !anyLeak);
    const idLeak = [socketA, socketB].some(s => s._received.some(r => /player_A_0123456789abcdef|player_B_0123456789abcdef/.test(JSON.stringify(r.payload))));
    check('상대의 playerId(비밀값)가 어느 클라이언트에도 노출되지 않음', !idLeak);

    // 6. A 혼자 READY -> 아직 gameReady 안 와야 함
    const readyA = await socketA._emitToServer('ready', {});
    check('A의 ready 응답 ok', readyA.ok === true);
    const gameReadyTooEarly = socketA._received.some(r => r.event === 'gameReady') || socketB._received.some(r => r.event === 'gameReady');
    check('한 명만 준비했을 때는 gameReady가 오면 안 됨', !gameReadyTooEarly);

    // 7. B도 READY -> 이제 둘 다 gameReady를 받아야 함
    const readyB = await socketB._emitToServer('ready', {});
    check('B의 ready 응답 ok', readyB.ok === true);
    const aGotGameReady = socketA._received.some(r => r.event === 'gameReady' && r.payload.roomId === roomId);
    const bGotGameReady = socketB._received.some(r => r.event === 'gameReady' && r.payload.roomId === roomId);
    check('둘 다 READY하면 A도 gameReady 받음', aGotGameReady);
    check('둘 다 READY하면 B도 gameReady 받음', bGotGameReady);

    // 7-1. 잘못된 payload(null)를 보내도 서버가 죽지 않고 에러로 응답하는지
    const nullRes = await connectFakeSocket('sock_N')._emitToServer('createRoom', null);
    check('payload가 null이어도 서버가 죽지 않고 INVALID_PAYLOAD 응답', nullRes.error === 'INVALID_PAYLOAD');

    // 8. 공격권 없는(방에 소속 안 된) 소켓이 ready를 보내면 거부되는지
    const socketC = connectFakeSocket('sock_C1');
    const readyC = await socketC._emitToServer('ready', {});
    check('방에 소속 안 된 소켓의 ready는 거부됨', readyC.error === 'NOT_IN_ROOM');

    // 9. B 연결 끊김 -> 방이 삭제되고 A가 roomClosed(DISCONNECT, slot p2)를 받는지
    await socketB._emitToServer('disconnect', {});
    const aGotPlayerLeft = socketA._received.some(r => r.event === 'roomClosed' && r.payload.reason === 'DISCONNECT' && r.payload.slot === 'p2');
    check('B 연결 끊김을 A가 roomClosed로 전달받음', aGotPlayerLeft);
    check('연결 끊김 후 방이 삭제됨', require('./room-manager').getRoom(roomId) === null);

    console.log(`\n${pass}개 통과, ${fail}개 실패`);
    process.exit(fail > 0 ? 1 : 0);
}

main();
