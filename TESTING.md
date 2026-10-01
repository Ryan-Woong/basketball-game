# 테스트 항목 대응표 (요청서 TEST 1~20)

자동 테스트는 모두 `npm test`로 실행됩니다. 이 테스트들은 **가짜 소켓 계층과 가짜 화면(DOM)** 위에서 진짜 서버 로직과 진짜 클라이언트 JS를 실행합니다.
진짜 `express`/`socket.io`, 진짜 브라우저, 진짜 네트워크는 쓰지 않으므로, 아래 "사람이 확인" 열과 `npm run smoke`가 마지막 검증입니다.

| # | 요청서 항목 | 자동 테스트 | 사람/실서버에서 확인 |
|---|---|---|---|
| 1 | 서버 실행 (`npm install`, `npm start`) | `test-server-boot`(PORT/HOST/healthz/정적 경로/종료 배선), `preflight` | `npm install && npm start` 후 `농구 게임 서버 실행 중: 0.0.0.0:3000` 로그 (실제 패키지로 처음 기동) |
| 2 | 브라우저 두 개 접속 | `test-client`(진짜 클라이언트 JS 두 개), `smoke`(진짜 Socket.IO 두 개) | 실제 브라우저 두 개로 접속, 개발자도구 Network → WS `101` |
| 3 | 방 생성 | `test-socket`, `test-session`, `test-client` | 화면에 5자리 방 코드 표시 |
| 4 | 방 참가 | `test-socket`, `test-security`(가득 찬 방/자기 방/중복 참가 거부) | 다른 기기에서 코드 입력 |
| 5 | 플레이어 인식(A/B 구분) | `test-socket`, `test-session`(p1/p2 슬롯, 요청이 정확히 해당 플레이어에게만 감) | 대기실에 두 닉네임이 보임 |
| 6 | 둘 다 READY | `test-socket`, `test-session`(한 명이면 시작 안 함, 둘이면 gameStart, 재요청 거부) | READY 후 드래프트 화면으로 전환 |
| 7 | 드래프트 | `test-session`(교대 순서, 중복/포지션/차례 검증), `test-engine-pvp`, `test-client` | 내 차례에만 선수 목록이 보임 |
| 8 | 경기 시작, 같은 경기 상태 | `test-session`(두 클라이언트 이벤트 스트림 완전 동일), `test-client` | 두 화면 로그가 같은 내용 |
| 9 | A 공격 → 행동 선택 | `test-session`, `test-engine-pvp`(결정 6종이 올바른 사람에게) | 공격권 쪽에만 버튼 표시 |
| 10 | 서버 판정(주사위/경합) | `test-engine`, `test-engine-pvp`(엔진이 끝까지 정상 진행), `test-security` TEST20 | 로그에 주사위 결과 표시 |
| 11 | B 화면 동기화 | `test-client`(로그 텍스트 일치), `smoke`(이벤트 스트림 동일) | 두 화면 동시 확인 |
| 12 | 점수 동기화 | `test-client`(점수판 일치, 기록지 합 = 점수), `smoke` | 점수판 동일 |
| 13 | 농구장 동기화(선수/공 위치) | `test-client`(10명 모두 좌우 반전 위치 일치, 허용오차 3%) | 코트 애니메이션을 눈으로 확인(공 위치는 연출용 난수가 있어 완전 일치를 요구하지 않음) |
| 14 | 공격권 전환 | `test-lifecycle`(Q1 p1 선공), `test-client`(상태바 공격권) | 상태바의 공격권 표시 |
| 15 | 쿼터 전환 동시 | `test-lifecycle`(VIS_RESET quarter 1~4), `test-client`(Q4 도달) | 두 화면의 Q 표시 |
| 16 | 경기 종료, 같은 결과 | `test-session`, `test-client`(승/패/무 일관), `smoke` | 종료 화면 동일 |
| 17 | 재접속 | **설계 변경:** 재접속 없음. `test-lifecycle`(연결 끊김/나가기/60초 초과 → 경기 종료 + 방 삭제, 새 방 생성 가능) | 탭을 닫아 보고 상대 화면의 안내 확인 |
| 18 | 잘못된 Action 거부 | `test-security` TEST18, `test-session`, `smoke`(STALE/NOT_YOUR_SEAT/INVALID_CHOICE) | — |
| 19 | 중복 Action | `test-security` TEST19(동시 10/20회 → 1회만 적용) | 선택 버튼을 빠르게 여러 번 눌러도 한 번만 처리 |
| 20 | 클라이언트 조작 | `test-security` TEST20(score/dice/위조 이벤트/타입 혼동/객체 오염), `smoke`(score/dice 필드 무시) | 개발자도구에서 `socket.emit('gameAction', {score:999})` 시도 |

## 추가로 자동 검증하는 것
- 60초 응답 제한과 기권 처리, 정상 경기에서는 타임아웃이 발생하지 않음: `test-lifecycle`
- 입력 검증, 속도 제한, 방 수 상한/정리, 출력 화이트리스트(playerId/socketId 비노출): `test-security`
- 스모크 스크립트 자체의 로직(정상/비정상/이벤트 유실 서버 탐지): `test-smoke-logic`

## 아직 자동으로 증명되지 않는 것 (직접 확인 필요)
- 진짜 `express`/`socket.io`로의 기동과 통신, WebSocket 업그레이드
- 화면 레이아웃, 코트 애니메이션이 눈으로 자연스러운지, 모바일 화면
- Render Free의 잠들기/깨우기/재시작 동작과 실제 지연
- Socket.IO가 갑작스러운 연결 단절을 감지하는 데 걸리는 시간(기본 설정 기준 최대 약 45초로 알려져 있으나 실측하지 않음)
