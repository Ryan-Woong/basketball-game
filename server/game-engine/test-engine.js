/*
 * server/game-engine/test-engine.js
 * -----------------------------------------------------------------------
 * Phase 1 검증용: 브라우저 없이 game.js 엔진만으로 한 경기를 처음부터 끝까지
 * 자동으로 돌려서 "로직이 원본과 동일하게 끝까지 정상 작동하는가"를 확인한다.
 *
 * io.requestAction을 "옵션 중 하나를 즉시 무작위로 고르는 함수"로 구현해서,
 * 원래 사람이 버튼을 누르던 자리를 자동 응답으로 대체했다. 이건 테스트용 껍데기일
 * 뿐이고, 다음 단계(Socket.IO 연결)에서 이 부분만 실제 네트워크 응답 대기로 교체된다.
 *
 * 실행: node test-engine.js
 */
// 테스트 전용: game.js의 sleep()은 setTimeout(resolve, ms) 그대로다.
// 실제 게임에서는 이 대기 시간이 연출 속도(사람이 로그를 읽는 시간)로 쓰이지만,
// 자동 테스트에서는 결과만 빠르게 확인하면 되므로 지연 시간을 0으로 만든다.
// game.js 파일 자체는 한 글자도 바꾸지 않는다.
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn, _ms) => realSetTimeout(fn, 0);

const createGameEngine = require('./game.js');

function main() {
    return new Promise((resolveGame) => {
        let logCount = 0;
        const io = {
            log(text, cls) { logCount++; /* 필요하면 console.log('[LOG]', text) */ },
            emit(type, payload) {
                if (type === 'GAME_END') resolveGame(payload);
                // 필요하면 console.log('[EVT]', type, payload);
            },
            score(u, c) { /* console.log('[SCORE]', u, c); */ },
            requestAction(slot, options /*, title */) {
                if (slot !== 'p1') throw new Error('solo mode must only ask p1, got ' + slot);
                // 테스트 전용: 제시된 옵션 중 하나를 즉시 무작위로 고른다
                const pick = options[Math.floor(Math.random() * options.length)];
                return Promise.resolve(pick.id);
            }
        };

        const engine = createGameEngine(io);
        engine.initDraftPool();

        // 드래프트 자동 진행: 유저 쪽도 테스트를 위해 "빈 포지션 중 가능한 선수"를 아무거나 고른다.
        // (draftPlayer 한 번 호출마다 CPU 쪽 픽도 내부에서 함께 진행되는 원본 로직 그대로)
        (function draftLoop() {
            const state = engine.getState();
            const missing = engine.getMissingPos(state.userTeam);
            if (missing.length === 0) return; // 드래프트 끝 -> checkDraftComplete가 이미 경기를 시작시켰음
            const candidate = state.draftPool.find(p => missing.includes(p.pos));
            engine.draftPlayer(candidate.id);
            draftLoop();
        })();

        this._logCountRef = () => logCount;
    });
}

main().then((result) => {
    console.log('=== GAME_END 이벤트 수신 ===');
    console.log('최종 스코어: USER', result.userScore, ':', result.cpuScore, 'CPU');
    console.log('유저팀 박스스코어:');
    result.boxScore.user.forEach(p => console.log(`  [${p.pos}] ${p.name}  ${p.pts}pts ${p.fgm}/${p.fga}FG`));
    console.log('CPU팀 박스스코어:');
    result.boxScore.cpu.forEach(p => console.log(`  [${p.pos}] ${p.name}  ${p.pts}pts ${p.fgm}/${p.fga}FG`));
    process.exit(0);
}).catch((err) => {
    console.error('테스트 실패:', err);
    process.exit(1);
});
