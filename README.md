# 농구 TRPG 1:1 PvP

16차/19차 농구 TRPG의 규칙(드래프트, 능력치 보정, 주사위 판정, 헬프 수비, 속공, 리바운드, 핫핸드, 에어볼, 4쿼터)을 그대로 유지한 채,
두 사람이 웹에서 실시간으로 대전하는 게임입니다. **서버가 모든 판정을 하고**(server-authoritative), 브라우저는 "무엇을 고르겠다"만 보냅니다.

- 상세 통신 규격: [PROTOCOL.md](PROTOCOL.md) · 배포: [DEPLOY.md](DEPLOY.md) · 테스트 항목 대응표: [TESTING.md](TESTING.md)

## 1. 설치

필요: Node.js 18 이상.

```bash
npm install
```

## 2. 실행

```bash
npm start            # http://localhost:3000
```

두 사람이 접속합니다. 같은 PC에서 혼자 확인할 때는 한쪽을 **시크릿 창/다른 브라우저**로 여세요(같은 브라우저의 탭은 같은 `playerId`를 공유합니다).
방 만들기 → 방 코드를 상대에게 전달 → 상대가 코드로 참가 → 둘 다 READY → 드래프트 → 경기.

환경변수: `PORT`(기본 3000), `HOST`(기본 `0.0.0.0`).

## 3. 서버 구조

```text
server.js                      Express(정적 파일 + /healthz) + Socket.IO 부팅, 방 정리 타이머, 종료 신호 처리
server/
  socket.js                    이벤트 라우팅, 속도 제한, 방 수명(나가기/끊김/시간 초과 → 방 삭제)
  room-manager.js              방 목록(메모리 Map), 방 코드, READY, 방 정리(sweep)
  game-session.js              방 하나당 엔진 하나. 엔진 ↔ Socket.IO 변환, 60초 타이머, 교대 드래프트, 응답 검증 호출
  validators.js                입력 형식/타입 검증(순수 함수)
  sanitize.js                  클라이언트로 나가는 데이터 화이트리스트(선수/스냅샷/이벤트)
  rate-limiter.js              토큰 버킷, 실패 횟수 창
  game-engine/game.js          게임 규칙 엔진(원본 19차 로직 + PvP 모드). DOM 없음
```

원칙
- 엔진 규칙/확률/로그 문구는 원본 그대로입니다. PvP 모드에서는 원래 CPU가 고르던 자리를 상대 플레이어에게 묻습니다.
- 엔진 내부 이름(`userTeam`/`cpuTeam`)은 그대로이고 p1/p2로의 변환은 `game-session.js`에서 합니다(user = p1 = 방장, cpu = p2 = 참가자).
- 상태는 서버 프로세스 메모리에만 있습니다. **인스턴스를 2개 이상 띄우면 안 됩니다.**

## 4. 클라이언트 구조

```text
client/
  index.html                   화면 뼈대(로비/가이드/대기실/드래프트/경기/모달/종료·방 삭제)
  css/game.css, css/court.css  스타일(원본 기반)
  js/socket.js                 접속(같은 주소로 io()), playerId(128비트 난수), send() 헬퍼
  js/court-ui.js               코트 시각화. 서버 VIS_* 이벤트 → 선수/공 이동. 자기 팀은 파란색, 오른쪽 골대 공격 시점
  js/game-ui.js                화면 전환, 드래프트, 로그, 주사위 연출, 선택 버튼+카운트다운, 능력치/기록지 모달
```

클라이언트는 판정하지 않습니다. 점수·주사위·성공 여부·승패는 모두 서버가 보낸 값을 표시할 뿐입니다.

## 5. Socket.IO 이벤트 (요약)

| 방향 | 이벤트 |
|---|---|
| 클라이언트 → 서버 | `createRoom`, `joinRoom`, `ready`, `draftPick {pickId}`, `gameAction {requestId, choice}`, `leaveRoom` |
| 서버 → 클라이언트 | `roomState`, `gameReady`, `gameStart`, `gameState`, `gameEvent {seq,type,data}`, `actionRequest`(선택할 1명에게만), `invalidAction`, `roomClosed` |

`gameEvent` 종류: `LOG`, `SCORE`, `WAITING_FOR_ACTION`, `TEAM_STATE`, `DICE_*`, `VIS_*`, `GAME_END`, `ENGINE_ERROR`. 모든 이벤트는 두 사람에게 같은 내용·같은 순서(`seq`)로 갑니다. 에러 코드와 검증 순서는 [PROTOCOL.md](PROTOCOL.md).

## 6. Room 구조

```js
{
  roomId: 'A7K3Q',                       // 5자리(0/O/1/I 제외)
  status: 'WAITING' | 'READY' | 'PLAYING' | 'FINISHED',
  players: { p1: {playerId, nickname, socketId, ready, connected}, p2: {…} | null },
  createdAt, touchedAt,
  session: null | GameSession            // 둘 다 READY가 되면 생성
}
```
- `playerId`는 본인 증명용 비밀값이라 상대에게 절대 보내지 않습니다(`sanitizeRoom`).
- 방 수명: 연결이 끊기거나, 나가거나, 60초 안에 응답하지 않으면 **경기 종료 + 방 삭제**(재접속 없음). 정상 종료된 방은 결과 확인용으로 남고 10분 뒤 정리됩니다. 방은 최대 100개.

## 7. GameState 구조

서버 엔진이 가진 상태(`game.js` 내부)를 클라이언트에는 화이트리스트를 거친 스냅샷으로만 보냅니다(`gameState`).

```js
{ status:'draft'|'playing'|'finished', quarter, possession, score:{p1,p2}, isP1Offense, hasPassed,
  currentAttackerId, currentDefenderId, teams:{p1:{PG..C}, p2:{PG..C}}, draftPool:[…], draftTurn:'p1'|'p2'|null, turnTimeoutMs }
```
경기 중 변화는 `gameEvent`(`SCORE`, `TEAM_STATE`, `VIS_*` …)로 전달되고, 능력치(버프·핫핸드·에어볼 포함)와 실시간 기록은 `TEAM_STATE`로 갑니다.

## 8. PvP 게임 진행 구조

1. **방**: A가 방을 만들고(p1) B가 코드로 참가합니다(p2). 둘 다 READY면 서버가 세션(엔진)을 만듭니다.
2. **드래프트**: p1부터 p1, p2, p1, p2… 한 명씩 고릅니다. 양 팀 5명이 되면 경기가 자동 시작됩니다.
3. **경기**: 4쿼터, 쿼터당 8포제션, Q1·Q3는 p1 선공, Q2·Q4는 p2 선공(원본 규칙). 서버가 원본과 같은 연출 속도로 이벤트를 방송합니다.
4. **선택 요청**(해당 1명에게만): 공격 행동·연계 행동·와이드 오픈·패스 대상 → 공격권 쪽 / 헬프 수비 → 수비 쪽 / 속공 마무리 → 공을 가로챈 쪽.
5. **서버 판정**: 선택을 받으면 엔진이 주사위·경합·성공 판정·턴오버·리바운드·점수를 계산하고 결과를 두 사람에게 같은 순서로 보냅니다.
6. **제한 시간**: 모든 선택(드래프트 포함)은 60초. 넘기면 기권패입니다.
7. **종료**: `GAME_END`(점수 + 박스스코어). 나가기를 누르면 방이 삭제되고 상대에게는 결과 화면이 유지됩니다.

한 판 소요 시간: 서버 연출 속도만으로 평균 약 8분(6~10분), 결정 횟수 평균 약 82회(70~107회) + 각자 고민 시간.

## 9. 테스트 방법

```bash
npm test                  # 전체 자동 테스트 (패키지 설치 없이도 동작하는 가짜 소켓 기반)
npm run preflight         # 배포 전 점검(파일/설정/하드코딩 URL 등)
npm run smoke -- http://localhost:3000        # 실제 네트워크로 두 클라이언트가 한 판을 끝까지 플레이 (npm install 필요)
npm run smoke -- https://<이름>.onrender.com
```

개별 실행: `test:engine`, `test:engine:pvp`, `test:room`, `test:socket`, `test:session`, `test:security`, `test:lifecycle`, `test:client`, `test:smoke-logic`, `test:boot`.
요청서 TEST 1~20과 각 자동 테스트의 대응, 그리고 사람이 직접 확인해야 하는 항목은 [TESTING.md](TESTING.md)에 있습니다.
