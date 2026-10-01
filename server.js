/*
 * server.js
 * -----------------------------------------------------------------------
 * 이 프로젝트에서 유일하게 "실행"하는 파일이다.
 *   npm install
 *   npm start
 * 로 켜고, 브라우저로 http://localhost:3000 에 접속한다.
 *
 * client/ 폴더는 정적 파일로 그대로 내려주고, 실제 통신은 Socket.IO가 처리한다.
 * 클라이언트는 io()로 "자기가 받은 주소와 같은 주소"에 접속하므로 CORS 설정이 필요 없다.
 * 이벤트 처리 내용은 server/socket.js에 있다.
 *
 * 배포 환경 (Render 등 PaaS / 일반 VM 공통):
 *   - PORT 환경변수가 있으면 그 포트, 없으면 3000. (Render는 PORT를 주입하며 기본값은 10000)
 *   - HOST는 기본 0.0.0.0. 플랫폼의 프록시는 localhost가 아니라 이 주소로 접속한다.
 *   - 방/게임 상태는 이 프로세스의 메모리에만 있다. 인스턴스를 2개 이상 띄우면 안 된다.
 */
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { registerSocketHandlers } = require('./server/socket');
const roomManager = require('./server/room-manager');

const app = express();
const server = http.createServer(app);
// Game messages are tiny; a small buffer limit rejects oversized payloads (abuse protection).
const io = new Server(server, { maxHttpBufferSize: 16 * 1024 });

// 헬스체크 / 서버 깨우기용. 방이나 게임 정보는 절대 내보내지 않는다.
app.get('/healthz', (_req, res) => {
    res.status(200).type('text/plain').send('ok');
});

app.use(express.static(path.join(__dirname, 'client')));

registerSocketHandlers(io);

// Free abandoned/finished rooms so a public URL cannot fill server memory.
const sweeper = setInterval(() => roomManager.sweep(), 60 * 1000);
if (sweeper.unref) sweeper.unref();

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

server.listen(PORT, HOST, () => {
    console.log(`농구 게임 서버 실행 중: ${HOST}:${PORT} (로컬 접속: http://localhost:${PORT})`);
});

// 플랫폼이 재배포/재시작할 때 보내는 종료 신호를 받으면 연결을 정리하고 빠르게 종료한다.
// (메모리 상태이므로 재시작하면 진행 중이던 방은 사라진다.)
let closing = false;
function shutdown(signal) {
    if (closing) return;
    closing = true;
    console.log(`[${signal}] 종료 신호 수신 - 연결을 정리하고 종료합니다.`);
    const force = setTimeout(() => process.exit(0), 5000);   // 정리가 오래 걸려도 5초 뒤 강제 종료
    if (force.unref) force.unref();
    io.close(() => process.exit(0));
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
