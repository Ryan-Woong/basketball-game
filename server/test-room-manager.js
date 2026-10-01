/* room-manager.js 단위 테스트 (패키지 불필요). 실행: node server/test-room-manager.js */
const rm = require('./room-manager');
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error('FAIL:', name); } };

const room = rm.createRoom('player_A', '철수');
check('방 코드 5자리', room.roomId.length === 5);
check('생성자가 p1', room.players.p1.playerId === 'player_A');
check('p2 비어 있음', room.players.p2 === null);
check('초기 상태 WAITING', room.status === 'WAITING');
check('자기 방 참가 거부', rm.joinRoom(room.roomId, 'player_A', '철수').error === 'CANNOT_JOIN_OWN_ROOM');
check('없는 방 거부', rm.joinRoom('ZZZZZ', 'player_B', '영희').error === 'ROOM_NOT_FOUND');
const joined = rm.joinRoom(room.roomId, 'player_B', '영희');
check('정상 참가', !joined.error && joined.room.players.p2.playerId === 'player_B');
check('제3자는 ROOM_FULL', rm.joinRoom(room.roomId, 'player_C', '민수').error === 'ROOM_FULL');
check('본인 재접속 허용', !rm.joinRoom(room.roomId, 'player_B', '영희').error);

check('상대 없이 ready는 불가(새 방)', rm.setReady(rm.createRoom('solo', 'x').roomId, 'solo').error === 'WAITING_FOR_OPPONENT');
const r1 = rm.setReady(room.roomId, 'player_A');
check('한 명만 준비하면 bothReady false', r1.bothReady === false && r1.room.status === 'WAITING');
const r2 = rm.setReady(room.roomId, 'player_B');
check('둘 다 준비하면 READY', r2.bothReady === true && r2.room.status === 'READY');

room.status = 'PLAYING';
check('경기 시작 후 ready 재요청 거부', rm.setReady(room.roomId, 'player_A').error === 'GAME_ALREADY_STARTED');
check('경기 시작 후 상태가 되돌아가지 않음', rm.getRoom(room.roomId).status === 'PLAYING');
room.status = 'READY';

rm.setSocket(room.roomId, 'player_A', 'socket_111');
check('socketId 기록', rm.getRoom(room.roomId).players.p1.socketId === 'socket_111');
rm.markDisconnected('player_A');
check('연결 끊김 표시', rm.getRoom(room.roomId).players.p1.connected === false);
rm.setSocket(room.roomId, 'player_A', 'socket_999');
check('재접속 시 socketId만 갱신', rm.getRoom(room.roomId).players.p1.socketId === 'socket_999');
check('재접속 후에도 같은 슬롯', rm.findPlayerSlot(rm.getRoom(room.roomId), 'player_A') === 'p1');

const pub = JSON.stringify(rm.sanitizeRoom(rm.getRoom(room.roomId)));
check('sanitize: socketId 비노출', !pub.includes('socketId') && !pub.includes('socket_999'));
check('sanitize: playerId 비노출', !pub.includes('player_A') && !pub.includes('player_B'));
check('sanitize: 방 코드/닉네임은 포함', pub.includes(room.roomId) && pub.includes('철수'));
check('sanitize: session 객체 비노출', !pub.includes('session'));

// generateRoomId only avoids ids already registered in the rooms Map, so test it the way it is really used: via createRoom
const ids = new Set(); for (let i = 0; i < 5000; i++) ids.add(rm.createRoom('bulk_' + i, 'n').roomId);
check('방 5000개 생성 시 방 코드 중복 없음', ids.size === 5000);

console.log(`\n${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
