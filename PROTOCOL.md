# Socket.IO 프로토콜 (Phase 8 기준: 실제 1:1 PvP + 실제 클라이언트)

원칙: 클라이언트는 **"무엇을 하겠다"만** 보낸다. 주사위·판정·점수·턴오버는 전부 서버(엔진)가 정한다.

## 클라이언트 → 서버

| 이벤트 | payload | 응답(ack) | 설명 |
|---|---|---|---|
| `createRoom` | `{playerId, nickname}` | `{roomId, slot:'p1'}` | 방 생성. 만든 사람이 p1 |
| `joinRoom` | `{playerId, nickname, roomId}` | `{roomId, slot}` | 방 참가 / 본인 재접속 |
| `ready` | 없음 | `{ok}` | 둘 다 READY면 게임 시작 |
| `draftPick` | `{pickId}` | `{ok}` / `{error}` | 드래프트에서 선수 한 명 선택 |
| `gameAction` | `{requestId, choice}` | `{ok}` / `{error}` | `actionRequest`에 대한 응답 |
| `leaveRoom` | 없음 | `{ok}` | 방을 나간다. **방이 삭제되고** 상대에게 `roomClosed(LEFT)`가 간다 |

`playerId`는 브라우저가 만들어 localStorage에 보관하는 **비밀값**이다(자기 자신임을 증명). 서버는 이 값을 상대방에게 절대 내보내지 않는다.

## 서버 → 클라이언트

| 이벤트 | 대상 | 설명 |
|---|---|---|
| `roomState` | 방 전체 | 방 정보(닉네임/준비/연결 상태). socketId·playerId 없음 |
| `gameReady` | 방 전체 | 둘 다 READY |
| `gameStart` | 방 전체 | `{roomId, mode:'PVP'}` |
| `gameState` | 방 전체 | `{atSeq, state}` 스냅샷(드래프트 진행 등). `atSeq`는 이 시점까지 반영된 `gameEvent.seq` |
| `gameEvent` | 방 전체 | 경기 진행 이벤트 스트림. 아래 참고 |
| `actionRequest` | **선택해야 할 사람 1명만** | `{requestId, title, timeoutMs, options:[{id,label,stat,statVal}]}` |
| `invalidAction` | 요청한 본인 | `{error, requestId?}` |
| `roomClosed` | 방에 남은 사람 | `{reason:'DISCONNECT'\|'TIMEOUT'\|'LEFT', slot, score:{p1,p2}\|null}` — 방이 삭제되었다. `slot`은 원인을 만든 자리(연결 끊김/시간 초과/나간 사람) |

### gameEvent 형식

```json
{ "seq": 12, "type": "VIS_SHOT", "data": { "shooterId": 7, "type": "pt3", "made": true } }
```
- `seq`는 1부터 1씩 증가. 클라이언트는 빠지거나 중복된 번호를 감지할 수 있다.
- 모든 이벤트는 방의 두 사람에게 **완전히 같은 내용**으로 전달된다.
- 실제 payload는 항상 `data` 안에 있다(`data.type`이 이벤트 `type`과 겹칠 수 있어 분리).

| type | data | 클라이언트가 할 일 |
|---|---|---|
| `LOG` | `{text, cls}` | 로그창에 한 줄 추가 (원본 `printLog`) |
| `SCORE` | `{p1, p2}` | 점수판 갱신 (p1 = 방장, p2 = 참가자) |
| `TEAM_STATE` | `{p1:[{id, eff:{11스탯}, delta, air, hot, gs:{기록}}], p2:[…]}` | 능력치 모달(버프/핫핸드/에어볼 표시 포함)과 실시간 박스스코어용. 시작 시 1회 + 매 포제션 종료 후 |
| `WAITING_FOR_ACTION` | `{forSlot, title, requestId, timeoutMs}` | "누구의 선택을 기다리는 중" 표시 (관전자 포함 전원에게) |
| `DICE_CONTESTED` | `{offFinal, defFinal}` | 경합 주사위 연출 (Phase 8) |
| `DICE_SUCCESS` | `{finalVal}` | 성공 판정 주사위 연출 (Phase 8) |
| `DICE_ADV` | `{r1, r2, finalRoll, finalCrit}` | 어드밴티지 성공 판정 연출 (Phase 8) |
| `VIS_RESET` `VIS_ADVANCE` `VIS_HELP` `VIS_PASS` `VIS_PREP_SHOT` `VIS_SHOT` `VIS_REB_POS` `VIS_GRAB` `VIS_STEAL` `VIS_FAST_BREAK` | 선수 id 위주. `VIS_RESET`은 `{isP1Offense, attackerId, quarter, possession}`(새 포제션 시작: 선수 배치/상태바용). `VIS_FAST_BREAK`는 `{playerId, isP1Side}` | 코트 시각화 (Phase 8). 좌표는 서버가 보내지 않고 클라이언트 `court-ui.js`가 계산 |
| `GAME_END` | `{p1Score, p2Score, boxScore:{p1:[…], p2:[…]}}` | 결과/박스스코어 화면 |
| `ENGINE_ERROR` | `{message}` | 엔진 오류 알림 (방은 FINISHED 처리) |

## 선택 요청 흐름

```
엔진이 선택이 필요해짐 (원래 waitUserInput 자리)
  → 서버: pending 요청 저장 + WAITING_FOR_ACTION(전원) + actionRequest(해당 1명)
  → 엔진은 이 자리에서 멈춰 있음
클라이언트: gameAction {requestId, choice}
  → 서버 검증 (아래 순서)
  → 통과하면 엔진이 그 선택으로 재개
```

검증 순서와 에러 코드 (`gameAction`):
1. `NO_GAME` — 시작된 경기가 없음
2. `NO_PENDING_REQUEST` — 지금 기다리는 선택이 없음 (이미 처리됐거나 경기 종료)
3. `NOT_YOUR_SEAT` — 이 선택을 할 자리가 아닌 사람이 응답
4. `STALE_REQUEST` — requestId가 현재 요청과 다름 (오래된/엉터리 값)
5. `INVALID_CHOICE` — 서버가 제시한 선택지에 없는 값

`draftPick` 에러: `NO_GAME`, `NOT_YOUR_SEAT`(방 소속 플레이어가 아님), `NOT_DRAFTING`, `NOT_YOUR_TURN`(내 차례가 아님), `INVALID_PICK`, `POSITION_FILLED`
`ready` 에러: `NOT_IN_ROOM`, `WAITING_FOR_OPPONENT`, `GAME_ALREADY_STARTED`
`createRoom`/`joinRoom` 에러: `INVALID_PAYLOAD`, `ALREADY_IN_ROOM`, `ROOM_NOT_FOUND`, `ROOM_FULL`, `CANNOT_JOIN_OWN_ROOM`, `SERVER_FULL`
모든 이벤트 공통: `RATE_LIMITED`, `SERVER_ERROR`

## 입력 검증 / 보안 규칙 (Phase 5)

- **형식 검증** (`server/validators.js`): `playerId`는 영숫자/`_`/`-` 16~64자(클라이언트가 128비트 난수 hex 생성), 닉네임은 제어문자 제거 후 최대 20자, 방 코드는 5자리(대소문자 무시), `requestId`/`choice`는 짧은 ASCII 문자열, `pickId`는 정수. 형식이 틀린 방 코드는 `ROOM_NOT_FOUND`로 응답한다.
- **무시되는 필드:** `gameAction`은 `requestId`·`choice`만, `draftPick`은 `pickId`만 읽는다. `score`, `dice`, `success`, `ovr` 같은 다른 필드를 보내도 무시된다. 서버 전용 이벤트 이름(`gameEvent` 등)을 클라이언트가 보내도 핸들러가 없어 무시된다.
- **속도 제한:** 소켓당 버스트 30, 초당 10회. 초과 시 `RATE_LIMITED`, 50회 누적되면 연결을 끊는다. 방 코드 추측은 60초에 8번 실패하면 잠시 차단한다.
- **방 제한:** 소켓 하나는 방 하나에만 속한다(`ALREADY_IN_ROOM`). 서버 전체 방 수 100개 상한(`SERVER_FULL`), 접속자가 없거나 끝난 방은 10분 후 자동 정리된다.
- **메시지 크기:** Socket.IO `maxHttpBufferSize` 16KB.
- **출력 화이트리스트** (`server/sanitize.js`): `gameState`는 선수 id/포지션/이름/능력치/기록/버프만, `gameEvent`는 등록된 타입과 필드만 내보낸다. 등록되지 않은 이벤트 타입은 전송되지 않는다(새 이벤트를 만들면 `EVENT_SPECS`에 추가해야 한다). `ENGINE_ERROR`의 상세 내용은 서버 로그에만 남고 클라이언트에는 `ENGINE_ERROR`만 간다.
- **idempotency:** 같은 `requestId`에 대한 응답은 첫 번째만 수락되고 나머지는 거부된다. 동시에 같은 드래프트 선택을 여러 번 보내도 한 번만 적용된다.

## 연결 / 배포 환경 (통신 규격 자체는 위 내용 그대로)

- **연결 주소:** 클라이언트는 `io()`로 "화면을 받은 주소와 같은 주소"에 접속한다. 서버가 `client/` 화면도 같이 제공하므로 별도의 서버 URL 설정과 **CORS 설정이 필요 없다.** HTTPS로 받았으면 WebSocket은 자동으로 `wss://`가 된다.
- **전송 방식:** Socket.IO 기본값(HTTP 롱폴링으로 시작해 WebSocket으로 업그레이드). 경로는 `/socket.io/`. 모든 공개 트래픽이 하나의 포트로 들어온다(Render 등 PaaS 호환).
- **서버 주소/포트:** `PORT` 환경변수(없으면 3000), `HOST` 환경변수(없으면 `0.0.0.0`).
- **헬스체크:** `GET /healthz` → `200 ok`. 방/게임 정보는 포함하지 않는다. 배포 플랫폼의 헬스체크와 "서버 깨우기"에 쓴다.
- **인스턴스는 1개만:** 방과 경기 상태가 서버 프로세스 메모리(`room-manager.js`의 `Map`)에 있다. 프로세스가 둘 이상이면 두 플레이어가 서로 다른 프로세스에 붙어 `ROOM_NOT_FOUND`가 난다.
- **서버가 꺼지거나 재시작되면** 모든 방과 경기가 사라진다. 클라이언트에는 Socket.IO `disconnect`/`connect_error`가 발생한다. 재접속 복구는 Phase 9에서 구현한다.

## gameState 스냅샷 (Phase 6)

`{status:'draft'|'playing'|'finished', quarter, possession, score:{p1,p2}, isP1Offense, hasPassed, currentAttackerId, currentDefenderId, teams:{p1:{PG..C}, p2:{PG..C}}, draftPool:[…], draftTurn:'p1'|'p2'|null}`

## PvP 진행 규칙 (Phase 6)

- **드래프트:** p1부터 시작해 p1, p2, p1, p2 … 순서로 한 명씩 고른다(원본: 첫 쪽이 먼저 고르는 순서 유지). 내 차례가 아니면 `NOT_YOUR_TURN`. 양 팀 5명이 차면 경기가 자동 시작된다.
- **선택 요청의 대상(`actionRequest`는 해당 1명에게만):**
  - 공격 행동 / 연계 행동(슛·패스) / 와이드 오픈 마무리 / 패스 대상 선택 → **공격권을 가진 쪽**
  - 헬프 수비 여부 → **수비 쪽**
  - 속공 마무리 방식 → **공을 가로챈 쪽**(그 포제션의 공격권자의 반대편)
- 경기 규칙은 원본 그대로다: 4쿼터, 쿼터당 8포제션, Q1·Q3는 p1 선공, Q2·Q4는 p2 선공. 로그의 `USER`/`CPU` 표기는 각자의 닉네임으로 바뀐다.
- 응답 시간 제한(60초)과 연결 끊김 처리는 아래 "방 수명과 시간 제한" 참고.

## 방 수명과 시간 제한 (Phase 7)

- **응답 제한 시간 60초:** 드래프트에서 내 차례, 경기 중 내가 선택해야 할 때 각각 60초다. `gameState.turnTimeoutMs`(드래프트), `actionRequest.timeoutMs`·`WAITING_FOR_ACTION.timeoutMs`(경기)로 남은 시간 한도를 알려 주고, 클라이언트는 받은 시점부터 표시만 한다(판정은 서버 타이머). 시간 안에 응답하지 않으면 **그 플레이어가 기권패**하고 방이 삭제된다(`roomClosed(TIMEOUT, slot)`).
- **재접속 없음:** 연결이 한 번이라도 끊기면(탭 닫기, 네트워크 끊김, 서버 재시작 포함) 경기는 초기화되고 방이 삭제되며 상대에게 `roomClosed(DISCONNECT, slot)`이 간다. 로비에서 한 명이 끊겨도 방이 삭제된다.
- `leaveRoom`도 같은 방식으로 방을 삭제한다. 경기가 정상 종료된 뒤에는 방이 남아 결과를 볼 수 있고, 한쪽이 나가면 상대에게 `roomClosed(LEFT)`가 가며 클라이언트는 결과 화면을 유지한다.
- 방이 삭제되면 서버는 두 소켓을 그 방 이름에서 모두 내보낸다(방 코드가 재사용돼도 옛 참가자에게 방송되지 않는다). 방을 나온 소켓은 곧바로 새 방을 만들거나 참가할 수 있다.

## 클라이언트 구성 (Phase 8)

`client/index.html` + `css/game.css`, `css/court.css` + `js/socket.js`(연결·playerId) · `js/court-ui.js`(코트 시각화: 서버 `VIS_*` 이벤트 → 선수/공 이동) · `js/game-ui.js`(로비/대기실/드래프트/로그/선택 패널/주사위 연출/능력치·기록지 모달/종료·방 삭제 화면).
각 클라이언트는 자기 팀을 파란색으로, 상대를 빨간색으로 보며 자기 팀이 오른쪽 골대를 공격하는 시점으로 그린다(서버 이벤트는 p1/p2 기준이고 변환은 클라이언트가 한다).


## 단계별 현황

- Phase 8(현재): 두 플레이어 모두 사람 + 실제 클라이언트(코트 시각화 포함). CPU 판정 분기는 PvP 모드에서 쓰이지 않는다(1인용 모드 코드는 엔진에 남아 있다).
- 재접속 복구는 하지 않기로 했다(연결이 끊기면 경기 종료 + 방 삭제).
