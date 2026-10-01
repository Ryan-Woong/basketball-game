/*
 * server/test-server-boot.js
 * -----------------------------------------------------------------------
 * server.js의 "배선"이 배포 환경(Render 등)의 요구사항대로인지 확인한다.
 * 진짜 express / socket.io / http 서버 없이, 가짜 모듈을 끼워 넣어 server.js를 실제로 실행한다.
 *
 *   확인하는 것: PORT/HOST 처리, /healthz 응답, client 폴더 정적 제공 경로,
 *               Socket.IO 핸들러 등록, SIGTERM 종료 처리
 *   확인하지 못하는 것: 진짜 express/socket.io의 동작, 실제 네트워크 통신
 *               (그건 npm install 후 실제 서버를 띄워서 확인해야 한다)
 *
 * 실행: node server/test-server-boot.js   (npm install 불필요)
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) pass++; else { fail++; console.error('  FAIL:', name); } };

const serverPath = path.join(__dirname, '..', 'server.js');
const clientDir = path.join(__dirname, '..', 'client');

function bootWith(env) {
    const rec = { routes: {}, staticDir: null, listen: null, ioConnectionHandlers: 0, ioClosed: false };

    const fakeExpress = () => {
        const app = () => {};
        app.get = (p, h) => { rec.routes[p] = h; };
        app.use = () => {};
        return app;
    };
    fakeExpress.static = (dir) => { rec.staticDir = dir; return () => {}; };

    class FakeServer {
        constructor(srv, opts) { rec.ioOptions = opts; }
        on(event) { if (event === 'connection') rec.ioConnectionHandlers++; }
        close(cb) { rec.ioClosed = true; if (cb) cb(); }
    }
    const fakeHttp = { createServer: () => ({ listen(port, host, cb) { rec.listen = { port, host }; if (cb) cb(); } }) };

    const origLoad = Module._load;
    Module._load = function (request, parent, isMain) {
        if (request === 'express') return fakeExpress;
        if (request === 'socket.io') return { Server: FakeServer };
        if (request === 'http') return fakeHttp;
        return origLoad.apply(this, arguments);
    };

    const savedEnv = { PORT: process.env.PORT, HOST: process.env.HOST };
    if (env.PORT === undefined) delete process.env.PORT; else process.env.PORT = env.PORT;
    if (env.HOST === undefined) delete process.env.HOST; else process.env.HOST = env.HOST;
    const logSaved = console.log; console.log = () => {};
    const beforeSigterm = process.listeners('SIGTERM').length;
    try {
        delete require.cache[serverPath];
        require(serverPath);
    } finally {
        console.log = logSaved;
        Module._load = origLoad;
        if (savedEnv.PORT === undefined) delete process.env.PORT; else process.env.PORT = savedEnv.PORT;
        if (savedEnv.HOST === undefined) delete process.env.HOST; else process.env.HOST = savedEnv.HOST;
    }
    rec.sigtermHandlerAdded = process.listeners('SIGTERM').length > beforeSigterm;
    return rec;
}

// --- 1) Render처럼 PORT=10000이 주입된 경우 ---
let r = bootWith({ PORT: '10000' });
check('PORT=10000 이면 10000 포트로 listen', r.listen && r.listen.port === 10000);
check('호스트는 0.0.0.0 (Render 요구사항)', r.listen && r.listen.host === '0.0.0.0');
check('PORT가 숫자로 변환되어 전달됨(문자열 아님)', r.listen && typeof r.listen.port === 'number');
check('Socket.IO connection 핸들러가 등록됨', r.ioConnectionHandlers === 1);
check('Socket.IO 메시지 크기 제한(maxHttpBufferSize <= 64KB)', r.ioOptions && r.ioOptions.maxHttpBufferSize <= 64 * 1024);
check('client 폴더를 정적 파일로 제공', r.staticDir === clientDir);
check('client/index.html 이 실제로 존재', fs.existsSync(path.join(clientDir, 'index.html')));
check('/healthz 라우트 등록', typeof r.routes['/healthz'] === 'function');

// /healthz 응답 내용
const res = { _status: null, _type: null, _body: null,
    status(c) { this._status = c; return this; }, type(t) { this._type = t; return this; }, send(b) { this._body = b; return this; } };
r.routes['/healthz']({}, res);
check('/healthz 는 200 + "ok"', res._status === 200 && res._body === 'ok');
check('/healthz 응답에 방/게임 정보가 없음', String(res._body).length < 10);

// --- 2) 종료 신호(SIGTERM) 처리 ---
check('SIGTERM 핸들러가 등록됨', r.sigtermHandlerAdded);
const exitSaved = process.exit; let exitCode = null;
process.exit = (c) => { exitCode = c; };
const handlers = process.listeners('SIGTERM');
handlers[handlers.length - 1]();           // 방금 등록된 핸들러 실행
process.exit = exitSaved;
check('SIGTERM 수신 시 io.close 호출', r.ioClosed === true);
check('SIGTERM 수신 후 정상 종료(코드 0)', exitCode === 0);
process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT');

// --- 3) 로컬 개발: PORT 없음 / 잘못된 값 ---
r = bootWith({});
check('PORT가 없으면 3000', r.listen.port === 3000);
process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT');
r = bootWith({ PORT: 'abc' });
check('PORT가 숫자가 아니면 3000으로 대체', r.listen.port === 3000);
process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT');

// --- 4) HOST 재정의 가능 ---
r = bootWith({ PORT: '4000', HOST: '127.0.0.1' });
check('HOST 환경변수로 바인딩 주소 변경 가능', r.listen.host === '127.0.0.1' && r.listen.port === 4000);
process.removeAllListeners('SIGTERM'); process.removeAllListeners('SIGINT');

// --- 5) 코드에 특정 클라우드 전용 요소가 없는지 ---
const src = fs.readFileSync(serverPath, 'utf-8');
check('server.js에 Cloud Run/GCP 전용 코드 없음', !/cloud\s*run|gcloud|K_SERVICE|googleapis/i.test(src));
check('server.js에 CORS를 전체 허용하는 설정 없음', !/origin\s*:\s*['"]\*['"]/.test(src));

console.log(`\n${pass}개 통과, ${fail}개 실패`);
process.exit(fail ? 1 : 0);
