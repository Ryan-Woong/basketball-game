/*
 * server/game-engine/game.js
 * -----------------------------------------------------------------------
 * 16차/19차 농구 게임의 판정/규칙 로직을 브라우저(DOM) 없이 그대로 실행할 수 있게
 * 옮긴 "순수 게임 엔진" 이다.
 *
 * - 함수 이름, 변수 이름, 판정 공식은 원본과 100% 동일하다. 바뀐 것은 오직
 *   "결과를 어떻게 화면에 보여줄까"였던 부분(DOM 조작)을, 호출하는 쪽(io)이
 *   원하는 방식으로 처리하도록 넘겨주는 것뿐이다.
 * - 이 모듈은 Node.js에서 그대로 require해서 쓸 수 있고, 브라우저가 전혀 필요 없다.
 *   (지금 단계에서는 소켓도 아직 연결하지 않는다 — 그건 다음 단계 작업이다.)
 *
 * 사용법:
 *   const createGameEngine = require('./game.js');
 *   const engine = createGameEngine(io);   // io: 아래 "io 인터페이스" 참고
 *   engine.initDraftPool();
 *   engine.draftPlayer(playerId);          // 드래프트가 끝나면 자동으로 경기가 시작됨
 *
 * io 인터페이스 (호출하는 쪽이 반드시 구현해서 넘겨줘야 하는 4개 함수):
 *   io.log(text, cssClass)              — 원래 printLog가 화면에 쓰던 한 줄의 로그
 *   io.emit(type, payload)              — Vis.*(코트 애니메이션), DICE_*(주사위 연출),
 *                                          GAME_END(경기 종료+박스스코어) 등의 이벤트
 *   io.score(userScore, cpuScore)       — 점수가 바뀔 때마다 호출됨
 *   io.requestAction(slot, options, title) — slot 'p1'|'p2' = who must choose. 원래 waitUserInput(버튼 클릭 대기)이었던 자리.
 *                                          Promise를 반환해야 하고, 그 Promise가
 *                                          options 중 하나의 id로 resolve되어야 한다.
 */
function createGameEngine(io, options = {}) {
    // mode 'solo' = original game (side "user" is human, side "cpu" is decided by the CPU weights below).
    // mode 'pvp'  = BOTH sides are humans: every place that used to run CPU logic asks the other player instead.
    // Internal names (userTeam/cpuTeam/isUserOffense ...) are kept so the rule code is untouched:
    // side "user" == player p1, side "cpu" == player p2. The mapping to p1/p2 is done at the engine boundary.
    const mode = options.mode === 'pvp' ? 'pvp' : 'solo';
    const labels = { user: (options.labels && options.labels.p1) || 'USER', cpu: (options.labels && options.labels.p2) || 'CPU' };
    const isHuman = (sideIsUser) => mode === 'pvp' || sideIsUser;   // is this side decided by a person?

    const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
    const FIRST_NAMES = ['김','이','박','최','정','강','조','윤','장','임','한','오','서','신','권'];
    const LAST_NAMES = ['민준','서준','도윤','예준','시우','하준','지호','주원','건우','태윤','현우','서진','연우','우진','지훈'];
    const STAT_NAMES = {
        pt3: '3점슛', mid: '미들슛', layup: '레이업',
        inBlk: '골밑블락', outBlk: '슛블락', m2m: '대인수비',
        str: '힘', drive: '볼핸들링', pass: '패스', offBall: '오프볼', reb: '리바운드'
    };

    /* ===== 서버(Node) 전용 상태: 브라우저 window 없이 이 함수 스코프 안에만 존재 =====
       기존 16차/19차의 전역 변수와 이름이 완전히 같다. 로직 코드(아래)는 이 변수들을
       그대로 참조하므로 한 줄도 손댈 필요가 없다. */
    let userTeam = {}, cpuTeam = {};
    let userScore = 0, cpuScore = 0;
    let currentAttacker = null, currentDefender = null, currentAssister = null;
    let offTeam = null, defTeam = null;
    let isUserOffense = true, hasPassed = false;
    let seed = 12345;
    let draftPool = [], allFixedPlayers = [];
    let quarter = 1, possession = 8, gameStatus = 'menu';

    /* ===== Vis: 원래는 코트 화면을 직접 그리던 객체. 서버에서는 좌표 계산을 하지 않고
       "무슨 일이 일어났는지"만 io.emit으로 클라이언트에 전달한다. 실제 좌표/충돌 회피
       계산은 client/js/court-ui.js 쪽에 그대로 남아 있다(추후 단계에서 그 파일도 정리). */
    const Vis = {
        reset() { io.emit('VIS_RESET', { isUserOffense, attackerId: currentAttacker && currentAttacker.id, quarter, possession }); },
        advance(type) {
            io.emit('VIS_ADVANCE', { attackerId: currentAttacker && currentAttacker.id, defenderId: currentDefender && currentDefender.id, type });
        },
        help(h) { io.emit('VIS_HELP', { helperId: h && h.id }); },
        pass(a, b) { io.emit('VIS_PASS', { fromId: a && a.id, toId: b && b.id }); },
        prepShot(p, type) { io.emit('VIS_PREP_SHOT', { shooterId: p && p.id, type }); },
        shoot(p, type, made) { io.emit('VIS_SHOT', { shooterId: p && p.id, type, made }); },
        rebPos(off, def) { io.emit('VIS_REB_POS', { offIds: off.map(p => p && p.id), defIds: def.map(p => p && p.id) }); },
        grab(p) { io.emit('VIS_GRAB', { playerId: p && p.id }); },
        steal(d) { io.emit('VIS_STEAL', { playerId: d && d.id }); },
        fastBreak(p, isU) { io.emit('VIS_FAST_BREAK', { playerId: p && p.id, isUserSide: isU }); }
    };

    /* -----------------------------------------
       1. 코어 룰 & 주사위 엔진
    ----------------------------------------- */
    function randomSeeded() {
        let t = seed += 0x6D2B79F5;
        t = Math.imul(t ^ t >>> 15, t | 1);
        t ^= t + Math.imul(t ^ t >>> 7, t | 61);
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    }
    function randIntSeeded(min, max) { return Math.floor(randomSeeded() * (max - min + 1)) + min; }
    function randInt(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }
    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    function getBonus(stat) {
        if (stat > 20) return 4;
        if (stat >= 16) return 3;
        if (stat >= 11) return 2;
        if (stat >= 5) return 1;
        return 0;
    }

    function getEffStat(player, statKey) {
        let val = player[statKey];
        if (player.hotHand && player.hotHand[statKey]) val += 1;
        if (player.buffs) {
            player.buffs.forEach(b => { if (b.stat === statKey) val += b.val; });
        }
        if (player.airball && player.airball[statKey]) val -= 1; 
        return val;
    }

    // 대항 판정: 최종값이 같으면 판정에 사용한 스탯이 높은 쪽이 승리
    function rollContested(offStat, defStat, defExtraBonus = 0) {
        let offRoll = randInt(1, 6);
        let defRoll = randInt(1, 6);
        let offCrit = 0, defCrit = 0;

        if (offRoll === 6 && randInt(1, 6) === 6) offCrit = 1;
        if (offRoll === 1 && randInt(1, 6) === 1) offCrit = -1;
        
        if (defRoll === 6 && randInt(1, 6) === 6) defCrit = 1;
        if (defRoll === 1 && randInt(1, 6) === 1) defCrit = -1;

        let offTotal = offRoll + getBonus(offStat);
        let defTotal = defRoll + getBonus(defStat) + defExtraBonus;
        
        let isTie = (offTotal === defTotal);
        let offWins = false;
        if (offTotal > defTotal) {
            offWins = true;
        } else if (isTie) {
            offWins = (offStat > defStat); // 동점일 경우 스탯이 높은 쪽이 승리 (스탯까지 같으면 수비 승리)
        }

        if (offCrit === 1 && defCrit !== 1) { offWins = true; isTie = false; }
        if (defCrit === 1 && offCrit !== 1) { offWins = false; isTie = false; }
        if (offCrit === -1) { offWins = false; isTie = false; }
        if (defCrit === -1) { offWins = true; isTie = false; }

        return { offWins, isTie, offRoll, defRoll, offTotal, defTotal, offCrit, defCrit, offStat, defStat };
    }

    function rollSuccess(statVal, isHalf, statKey) {
        let target = isHalf ? Math.floor(statVal / 2) : statVal;
        
        let roll = randInt(1, 20);
        let crit = 0;
        if (roll === 1) crit = 1;
        if (roll === 20) crit = -1;

        let success = roll <= target;
        if (crit === 1) success = true;
        if (crit === -1) success = false;

        return { success, roll, target, crit };
    }

    async function performAdvantageSuccessRoll(player, statKey, isHalf, actionName) {
        let statVal = getEffStat(player, statKey);
        let target = isHalf ? Math.floor(statVal / 2) : statVal;

        printLog(`   ▶ [성공판정 진행: ${actionName}] 어드밴티지 적용! 주사위 2개를 굴려 하나라도 성공하면 인정됩니다. (기준: ${target} 이하)`, "c-sys");
        await sleep(400);

        let r1 = randInt(1, 20), r2 = randInt(1, 20);
        let c1 = (r1 === 1) ? 1 : (r1 === 20 ? -1 : 0);
        let c2 = (r2 === 1) ? 1 : (r2 === 20 ? -1 : 0);
        
        let s1 = r1 <= target; if(c1 === 1) s1 = true; if(c1 === -1) s1 = false;
        let s2 = r2 <= target; if(c2 === 1) s2 = true; if(c2 === -1) s2 = false;

        let finalRoll = r1, finalCrit = c1, finalSuccess = s1;

        if (s1 && !s2) { finalRoll = r1; finalCrit = c1; finalSuccess = true; }
        else if (!s1 && s2) { finalRoll = r2; finalCrit = c2; finalSuccess = true; }
        else if (s1 && s2) {
            if (c1 === 1) { finalRoll = r1; finalCrit = 1; }
            else if (c2 === 1) { finalRoll = r2; finalCrit = 1; }
            else { finalRoll = Math.min(r1, r2); finalCrit = 0; }
            finalSuccess = true;
        } else {
            if (c1 === -1 && c2 === -1) { finalRoll = 20; finalCrit = -1; }
            else if (c1 === -1) { finalRoll = r2; finalCrit = c2; }
            else if (c2 === -1) { finalRoll = r1; finalCrit = c1; }
            else { finalRoll = Math.min(r1, r2); finalCrit = 0; }
            finalSuccess = false;
        }

        // (animateContested/Success와 동일한 이유로 DOM 대신 이벤트로 대체, 대기시간 1700ms 동일)
        io.emit('DICE_ADV', { r1, r2, finalRoll, finalCrit });
        await sleep(1700);

        if (finalCrit === 1) printLog(`   🌟 주사위 [ ${finalRoll} ] : 대성공! (목표값 무시 완벽 성공)`, "c-crit");
        else if (finalCrit === -1) printLog(`   😵 주사위 [ ${finalRoll} ] : 주사위 두 개 모두 대실패!`, "c-crit");
        else if (finalSuccess) printLog(`   ✅ 주사위 [ ${finalRoll} ] : 성공!`, "c-succ");
        else printLog(`   ❌ 두 주사위 모두 목표값을 넘겨 실패했습니다.`, "c-fail");

        await sleep(800);
        return { success: finalSuccess, roll: finalRoll, target: target, crit: finalCrit };
    }

    function checkTurnover(cRes) {
        return cRes.offCrit === -1 || (cRes.defCrit === 1 && cRes.offCrit !== 1);
    }

    /* -----------------------------------------
       2. 주사위 그래픽 연출 래퍼 함수
    ----------------------------------------- */
    // 원래는 DOM에 주사위 굴러가는 애니메이션을 그렸다. 서버는 최종 값만 이벤트로 보내고,
    // 굴러가는 모습은 클라이언트가 이 이벤트를 받아 직접 연출한다(총 대기시간은 900+800=1700ms로 동일하게 유지).
    async function animateContested(offFinal, defFinal) {
        io.emit('DICE_CONTESTED', { offFinal, defFinal });
        await sleep(1700);
    }

    async function animateSuccess(finalVal) {
        io.emit('DICE_SUCCESS', { finalVal });
        await sleep(1700);
    }

    async function performContestedRoll(atkPlayer, defPlayer, atkStatKey, defStatKey, defExtraBonus, atkName, defName) {
        let atkVal = getEffStat(atkPlayer, atkStatKey);
        let defVal = getEffStat(defPlayer, defStatKey);
        
        printLog(`   ▶ [대항판정 시작] ${atkName}(${atkVal}) vs ${defName}(${defVal})`, "c-sys");
        await sleep(400);
        
        let cRes = rollContested(atkVal, defVal, defExtraBonus);
        await animateContested(cRes.offRoll, cRes.defRoll);
        
        printLog(`   => 공격측: 주사위 ${cRes.offRoll} + 스탯 보너스 ${getBonus(atkVal)} = 최종 ${cRes.offTotal}`, "c-roll");
        printLog(`   => 수비측: 주사위 ${cRes.defRoll} + 스탯 보너스 ${getBonus(defVal) + defExtraBonus} = 최종 ${cRes.defTotal}`, "c-roll");
        
        if (cRes.offCrit === 1) printLog(`   🌟 공격측 대성공(6, 6) 발동!`, "c-crit");
        if (cRes.offCrit === -1) printLog(`   😵 공격측 대실패(1, 1) 발동!`, "c-crit");
        if (cRes.defCrit === 1) printLog(`   🌟 수비측 대성공(6, 6) 발동!`, "c-crit");
        
        if (!cRes.offCrit && !cRes.defCrit) {
            if (cRes.isTie) {
                if (cRes.offWins) {
                    printLog(`   ✅ [동점 -> 공격 우위] 최종값 동점이나, 사용 스탯 우위(${atkVal} > ${defVal})로 공격이 승리했습니다! (슛 100% 반영)`, "c-succ");
                } else {
                    printLog(`   🛑 [동점 -> 수비 우위] 최종값 동점이나, 사용 스탯 우위(${defVal} >= ${atkVal})로 수비가 승리했습니다! (슛 50% 반영 / 블락 허용)`, "c-fail");
                }
            } else if (cRes.offWins) {
                printLog(`   ✅ [공격 우위] 공격이 대항판정에서 승리했습니다. (슛 100% 반영)`, "c-succ");
            } else {
                printLog(`   🛑 [수비 우위] 수비가 대항판정에서 승리했습니다. (슛 50% 반영 / 블락 허용)`, "c-fail");
            }
        }
        await sleep(800);
        return cRes;
    }

    async function performSuccessRoll(player, statKey, isHalf, actionName) {
        let statVal = getEffStat(player, statKey);
        let target = isHalf ? Math.floor(statVal / 2) : statVal;
        
        printLog(`   ▶ [성공판정 진행: ${actionName}] 성공 목표값: ${target} 이하 (스탯 ${statVal}의 ${isHalf ? '절반' : '전체'})`, "c-sys");
        await sleep(400);
        
        let sRes = rollSuccess(statVal, isHalf, statKey);
        await animateSuccess(sRes.roll);
        
        if (sRes.crit === 1) printLog(`   🌟 주사위 [ ${sRes.roll} ] : 대성공! (목표값 무시 완벽 성공)`, "c-crit");
        else if (sRes.crit === -1) printLog(`   😵 주사위 [ ${sRes.roll} ] : 대실패! (치명적 미스)`, "c-crit");
        else if (sRes.success) printLog(`   ✅ 주사위 [ ${sRes.roll} ] : 성공!`, "c-succ");
        else printLog(`   ❌ 주사위 [ ${sRes.roll} ] : 목표값을 넘겨 실패했습니다.`, "c-fail");
        
        await sleep(800);
        return sRes;
    }

    /* -----------------------------------------
       3. 상태 이상 및 기록 로직
    ----------------------------------------- */
    function recordShot(player, type, made) {
        Vis.shoot(player, type, made);
        player.gameStats.fga++;
        if (type === 'pt3') player.gameStats.fg3a++;
        if (made) {
            player.gameStats.fgm++;
            if (type === 'pt3') player.gameStats.fg3m++;
        }
    }

    function tickBuffs() {
        [Object.values(userTeam), Object.values(cpuTeam)].flat().forEach(p => {
            if (p.buffs) {
                p.buffs = p.buffs.map(b => ({ ...b, duration: b.duration - 1 })).filter(b => b.duration > 0);
            }
        });
    }

    function applyMoraleBuff(teamObj) {
        const stats = ['pt3','mid','layup','inBlk','outBlk','m2m','str','drive','pass','offBall','reb'];
        Object.values(teamObj).forEach(p => {
            if (!p.buffs) p.buffs = [];
            const rStat = stats[randInt(0, stats.length - 1)];
            p.buffs.push({ stat: rStat, val: 1, duration: 2 });
            printLog(`   🔥 [사기 상승] ${p.name}의 ${STAT_NAMES[rStat]} 스탯이 일시 상승!`, "c-sys");
        });
    }

    function applyDemoralizeDebuff(player) {
        if (!player.buffs) player.buffs = [];
        const stats = ['pt3','mid','layup','inBlk','outBlk','m2m','str','drive','pass','offBall','reb'];
        printLog(`   🥶 [굴욕] 덩크를 허용한 ${player.name}의 멘탈이 흔들립니다.`, "c-fail");
        for(let i=0; i<3; i++) {
            const rStat = stats[randInt(0, stats.length - 1)];
            player.buffs.push({ stat: rStat, val: -1, duration: 2 });
        }
    }

    /* -----------------------------------------
       4. UI 및 초기화
    ----------------------------------------- */
    function generateFixedPlayers() {
        allFixedPlayers = [];
        seed = 9999; 
        // SG의 패스 평균(13)을 SF(11)보다 높게 설정
        const templates = {
            'PG': { layup:16, mid:14, pt3:10, inBlk:3, outBlk:4, m2m:11, str:7,  drive:17, pass:15, offBall:14, reb:6 },
            'SG': { layup:16, mid:15, pt3:13, inBlk:4, outBlk:5, m2m:12, str:9,  drive:15, pass:13, offBall:16, reb:8 },
            'SF': { layup:17, mid:14, pt3:11, inBlk:5, outBlk:6, m2m:13, str:13, drive:14, pass:11, offBall:14, reb:11 },
            'PF': { layup:18, mid:13, pt3:7,  inBlk:10, outBlk:7, m2m:13, str:16, drive:10, pass:12, offBall:11, reb:16 },
            'C':  { layup:19, mid:10, pt3:5,  inBlk:13, outBlk:6, m2m:12, str:18, drive:7,  pass:11, offBall:8,  reb:18 }
        };

        let id = 1;
        POSITIONS.forEach(pos => {
            for(let i=0; i<10; i++) {
                let p = { 
                    id: id++, pos: pos, name: FIRST_NAMES[randIntSeeded(0, 14)] + LAST_NAMES[randIntSeeded(0, 14)], 
                    hotHand: {}, buffs: [], airball: { pt3: false, mid: false, layup: false },
                    gameStats: { pts: 0, fgm: 0, fga: 0, fg3m: 0, fg3a: 0, oreb: 0, dreb: 0, ast: 0, tov: 0, stl: 0, blk: 0 } 
                };
                let base = templates[pos];
                let ovr = 0;
                for(let key in base) {
                    let val = base[key] + randIntSeeded(-2, 2);
                    if(pos === 'C' && i >= 8 && key === 'pt3') val += 7;
                    if(pos === 'SG' && i >= 8 && key === 'pt3') val += 4;
                    if((pos === 'PG' || pos === 'SG') && i === 9 && (key === 'm2m' || key === 'outBlk')) val += 4;
                    p[key] = Math.max(5, Math.min(20, val));
                    ovr += p[key];
                }
                p.ovr = ovr;
                allFixedPlayers.push(p);
            }
        });
    }

    // returnToMain -> resetGame: 화면 전환 없이 다음 경기를 위해 상태만 초기화
    function resetGame() {
        gameStatus = 'menu'; quarter = 1; possession = 8;
        currentAttacker = null; currentDefender = null; currentAssister = null; Vis.reset();
        userTeam = {}; cpuTeam = {}; userScore = 0; cpuScore = 0;
        io.score(0, 0);
    }

    // startGame -> initDraftPool: 드래프트 풀 구성 로직은 완전히 동일, 화면 전환만 제거
    function initDraftPool() {
        gameStatus = 'draft';
        generateFixedPlayers();
        draftPool = [];
        POSITIONS.forEach(pos => {
            let posPlayers = allFixedPlayers.filter(p => p.pos === pos).sort(() => Math.random() - 0.5).slice(0, 4);
            draftPool = draftPool.concat(posPlayers);
        });
        checkDraftComplete();
    }

    function getMissingPos(team) { return POSITIONS.filter(pos => !team[pos]); }

    // renderDraft -> checkDraftComplete: 로스터/후보 목록 HTML은 클라이언트가 상태를 받아 스스로 그린다.
    // 여기서는 "양쪽 다 5명 채워졌으면 경기 시작" 판정 로직만 남긴다.
    function checkDraftComplete() {
        if (getMissingPos(userTeam).length === 0 && getMissingPos(cpuTeam).length === 0) {
            // 경기는 await 없이 백그라운드로 진행된다. 도중에 예외가 나면 서버 프로세스가
            // 통째로 죽지 않도록(unhandled rejection) 잡아서 이벤트로 알린다. 게임 로직 변경 아님.
            startSimulation().catch(err => {
                gameStatus = 'error';
                io.emit('ENGINE_ERROR', { message: String((err && err.message) || err) });
            });
        }
    }

    function draftPlayer(id) {
        let idx = draftPool.findIndex(p => p.id === id);
        userTeam[draftPool[idx].pos] = draftPool[idx];
        draftPool.splice(idx, 1);

        let cpuMissing = getMissingPos(cpuTeam);
        if (cpuMissing.length > 0) {
            let targetPos = cpuMissing[Math.floor(Math.random() * cpuMissing.length)];
            let avail = draftPool.filter(p => p.pos === targetPos);
            avail.sort((a, b) => b.ovr - a.ovr); 
            if(avail.length > 0) {
                let pickIdx = (avail.length > 1 && Math.random() < 0.3) ? 1 : 0;
                let selected = avail[pickIdx];
                cpuTeam[selected.pos] = selected;
                draftPool.splice(draftPool.findIndex(p => p.id === selected.id), 1);
            }
        }
        checkDraftComplete();
    }

    // PvP draft: the given side takes the chosen player. Turn order / validation are the caller's job (game-session + validators).
    function draftPlayerPvp(isUserSide, id) {
        const idx = draftPool.findIndex(p => p.id === id);
        const team = isUserSide ? userTeam : cpuTeam;
        team[draftPool[idx].pos] = draftPool[idx];
        draftPool.splice(idx, 1);
        checkDraftComplete();
    }

    // printLog: 화면에 직접 쓰는 대신 io.log로 전달 (텍스트/색상 클래스는 완전히 동일)
    function printLog(text, cssClass = "c-fail") { io.log(text, cssClass); }

    // updateScore: 서버는 DOM 점수판이 없으므로 점수 값만 알려준다
    function updateScore() { io.score(userScore, cpuScore); }

    // waitUserInput: 원래는 버튼 클릭을 기다리는 Promise였다. 이제는 io.requestAction이
    // "누구에게 무엇을 물어봤는지"를 넘겨받아 실제 응답(소켓 메시지 등)이 올 때까지 기다린다.
    // 호출부(phaseDecision, executeAdvance 등)는 한 글자도 바뀌지 않는다.
    function waitUserInput(options, title, sideIsUser = true) {
        return io.requestAction(sideIsUser ? 'p1' : 'p2', options, title);   // slot of the side that must choose
    }

    /* -----------------------------------------
       5. 인게임 시뮬레이션 메인 흐름
    ----------------------------------------- */
    async function startSimulation() {
        gameStatus = 'playing';
        io.emit('TEAM_STATE', buildTeamState());
        printLog("==============================================", "c-sys");
        printLog("경기가 시작됩니다!", "c-sys");
        printLog("==============================================\n", "c-sys");
        await sleep(1500);

        for(let q = 1; q <= 4; q++) {
            printLog(`\n[ ⏰ ${q}쿼터 시작 ]`, "c-sys");
            await sleep(1500);
            
            let possessions = 8; quarter = q;
            let isUserTurn = (q % 2 !== 0); 
            
            while (possessions > 0) {
                let atk = isUserTurn ? userTeam : cpuTeam;
                let def = isUserTurn ? cpuTeam : userTeam;
                
                possession = possessions;
                let isTurnover = await runPossession(atk, def, isUserTurn);
                
                possessions--; 
                
                if (isTurnover) {
                    possessions--; 
                    if (possessions >= 0) {
                        printLog(`\n🔄 [포제션 차감] 상대 속공으로 총 포제션이 1 소모되었습니다. 기존 팀에게 다시 공격권이 주어집니다. (남은 기회: ${possessions})`, "c-sys");
                    } else {
                        printLog(`\n🔄 속공과 함께 쿼터 시간이 모두 종료되었습니다!`, "c-sys");
                    }
                    await sleep(1500);
                } else {
                    isUserTurn = !isUserTurn; 
                }
            }
            printLog(`\n=== ${q}쿼터 종료 | ${labels.user} ${userScore} : ${cpuScore} ${labels.cpu} ===\n`, "c-sys");
            await sleep(2000);
        }

        printLog("\n==============================================", "c-sys");
        printLog(`경기 종료! 최종 스코어 ${labels.user} ${userScore} : ${cpuScore} ${labels.cpu}`, "c-sys");
        // same if / else-if / else chain as the original; only the wording differs in pvp mode
        if(userScore > cpuScore) printLog(mode === 'pvp' ? `🎉 ${labels.user}의 승리입니다! 🎉` : "🎉 당신의 승리입니다! 🎉", "c-succ");
        else if(userScore < cpuScore) printLog(mode === 'pvp' ? `🎉 ${labels.cpu}의 승리입니다! 🎉` : "💻 CPU의 승리입니다. 💻", mode === 'pvp' ? "c-succ" : "c-cpu");
        else printLog("🤝 무승부입니다. 🤝", "c-warn");
        
        gameStatus = 'finished';
        io.emit('GAME_END', { userScore, cpuScore, boxScore: buildBoxScore() });
    }

    // Read-only snapshot for the client UI (attribute table + live box score). Replaces showAttributes()'s data source.
    const STAT_KEYS_11 = ['pt3', 'mid', 'layup', 'inBlk', 'outBlk', 'm2m', 'str', 'drive', 'pass', 'offBall', 'reb'];
    function buildTeamState() {
        const one = (p) => {
            const eff = {}, delta = {}, air = [], hot = [];
            STAT_KEYS_11.forEach(k => {
                eff[k] = getEffStat(p, k);
                const d = (p.buffs || []).filter(b => b.stat === k).reduce((s, b) => s + b.val, 0);
                if (d !== 0) delta[k] = d;
                if (p.airball && p.airball[k]) air.push(k);
                if (p.hotHand && p.hotHand[k]) hot.push(k);
            });
            return { id: p.id, eff, delta, air, hot, gs: { ...p.gameStats } };
        };
        const side = (team) => POSITIONS.map(pos => team[pos]).filter(Boolean).map(one);
        return { user: side(userTeam), cpu: side(cpuTeam) };
    }

    // 클라이언트가 박스스코어 화면을 그릴 때 필요한 순수 데이터만 반환 (HTML 없음)
    function buildBoxScore() {
        const teamStats = (team) => POSITIONS.map(pos => {
            const p = team[pos]; if (!p) return null;
            return { pos: p.pos, name: p.name, id: p.id, ...p.gameStats };
        }).filter(Boolean);
        return { user: teamStats(userTeam), cpu: teamStats(cpuTeam) };
    }

    async function runPossession(atkTeamObj, defTeamObj, isUser) {
        offTeam = atkTeamObj; defTeam = defTeamObj; isUserOffense = isUser;
        hasPassed = false;
        currentAssister = null; 
        
        let players = Object.values(offTeam);
        currentAttacker = players[randInt(0, 4)]; Vis.reset();
        
        let atkColor = isUser ? "c-user" : "c-cpu";
        printLog(`\n🏀 [${isUser ? labels.user : labels.cpu} 공격 턴 시작]`, atkColor);
        let isTurnover = await phaseDecision();
        
        tickBuffs();
        io.emit('TEAM_STATE', buildTeamState());
        return isTurnover;
    }

    async function handleFastBreak(fbAttacker, fbDefender, isUserFB) {
        let origOff = offTeam; let origDef = defTeam; let origIsUser = isUserOffense;
        offTeam = isUserFB ? userTeam : cpuTeam; defTeam = isUserFB ? cpuTeam : userTeam; isUserOffense = isUserFB;
        Vis.fastBreak(fbAttacker, isUserFB);
        printLog(`\n🚨 [속공 찬스!] ${fbAttacker.name}이(가) 공을 낚아채 빠르게 코트를 넘어갑니다!`, "c-warn");
        await sleep(1500);

        let choice = "";
        let opts = [
            { id: 'pt3', label: '3점슛', statVal: getEffStat(fbAttacker, 'pt3'), stat: true },
            { id: 'mid', label: '미들슛', statVal: getEffStat(fbAttacker, 'mid'), stat: true },
            { id: 'layup', label: '레이업', statVal: getEffStat(fbAttacker, 'layup'), stat: true }
        ];

        if (isHuman(isUserFB)) {
            choice = await waitUserInput(opts, "속공 마무리 방식을 선택하세요! (대항판정 없이 스탯 100% 굴림)", isUserFB);
        } else {
            let r = randInt(1, 100);
            if (r <= 15) choice = 'pt3'; else if (r <= 35) choice = 'mid'; else choice = 'layup';
            await sleep(1000);
        }

        let shootStatKey = choice; Vis.prepShot(fbAttacker, choice);
        let shotName = choice === 'pt3' ? "3점슛" : (choice === 'mid' ? "미들슛" : "레이업");
        let pts = choice === 'pt3' ? 3 : 2;

        printLog(`   ▶ 단독 찬스! 속공 ${shotName} 성공 판정을 진행합니다.`, "c-sys");
        await sleep(800);
        
        let sRes = await performSuccessRoll(fbAttacker, shootStatKey, false, "속공 " + shotName);
        
        if (sRes.crit === -1) {
            recordShot(fbAttacker, shootStatKey, false);
            printLog(`   😵 [속공 에어볼!] 노마크 속공에서 슛을 날려먹습니다! 수치심에 의기소침해집니다.`, "c-crit");
            fbAttacker.airball[shootStatKey] = true;
            printLog(`   어이없는 에어볼 미스로 속공 기회를 날립니다. 리바운드 없이 공격이 넘어갑니다.`, "c-fail");
        } else if (sRes.crit === 1) {
            recordShot(fbAttacker, shootStatKey, true);
            if (choice === 'mid' || choice === 'pt3') {
                printLog(`   🔥 [핫핸드 발동] 완벽한 속공 마무리! 슛 감각이 절정에 달합니다.`, "c-crit");
                if(!fbAttacker.hotHand) fbAttacker.hotHand = {};
                fbAttacker.hotHand[shootStatKey] = true;
            } else {
                printLog(`   ☄️ 림이 부서져라 꽂아넣는 환상적인 속공 덩크!!!`, "c-crit");
                applyMoraleBuff(offTeam);
                applyDemoralizeDebuff(fbDefender);
            }
            printLog(`   💥 속공 득점 성공! (+${pts}점)`, "c-succ");
            fbAttacker.gameStats.pts += pts;
            if (isUserFB) userScore += pts; else cpuScore += pts;
            updateScore();
            clearAirball(fbAttacker, shootStatKey);
        } else if (sRes.success) {
            recordShot(fbAttacker, shootStatKey, true);
            printLog(`   💥 속공 득점 성공! (+${pts}점)`, "c-succ");
            fbAttacker.gameStats.pts += pts;
            if (isUserFB) userScore += pts; else cpuScore += pts;
            updateScore();
            clearAirball(fbAttacker, shootStatKey);
        } else {
            recordShot(fbAttacker, shootStatKey, false);
            printLog(`   ❌ 아쉽게 슛이 빗나갑니다. 속공 실패! 리바운드 없이 공격이 넘어갑니다.`, "c-fail");
        }
        
        offTeam = origOff; defTeam = origDef; isUserOffense = origIsUser;
    }

    function clearAirball(player, shootStatKey) {
        if (player.airball && player.airball[shootStatKey]) {
            player.airball[shootStatKey] = false;
            printLog(`   ✨ 슛을 성공시키며 의기소침 상태에서 벗어났습니다!`, "c-sys");
        }
    }

    async function phaseDecision() {
        currentDefender = defTeam[currentAttacker.pos];
        printLog(`▶ [${currentAttacker.pos}] ${currentAttacker.name} 공을 잡았습니다. (마크맨: [${currentDefender.pos}] ${currentDefender.name})`, "c-sys");
        await sleep(800);

        let choice = "";
        let opts = [
            { id: 'drive', label: '돌파', statVal: getEffStat(currentAttacker, 'drive'), stat: true },
            { id: 'fake', label: '페이크 무브', statVal: getEffStat(currentAttacker, 'drive'), stat: true },
            { id: 'postup', label: '포스트업', statVal: getEffStat(currentAttacker, 'str'), stat: true }
        ];
        if (!hasPassed) opts.push({ id: 'pass', label: '패스', statVal: getEffStat(currentAttacker, 'pass'), stat: true });

        if (isHuman(isUserOffense)) {
            choice = await waitUserInput(opts, "어떤 행동을 시도하시겠습니까?", isUserOffense);
        } else {
            let bh = getEffStat(currentAttacker, 'drive');
            let wDrive = Math.max(1, Math.round(bh * (getEffStat(currentAttacker, 'layup') / 15)));
            let wFake = Math.max(1, Math.round(bh * (Math.max(getEffStat(currentAttacker, 'pt3'), getEffStat(currentAttacker, 'mid')) / 15)));
            let wPost = getEffStat(currentAttacker, 'str');
            let wPass = hasPassed ? 0 : getEffStat(currentAttacker, 'pass');
            let total = wDrive + wFake + wPost + wPass;
            let r = randInt(1, total);
            
            if (r <= wDrive) choice = 'drive';
            else if (r <= wDrive + wFake) choice = 'fake';
            else if (r <= wDrive + wFake + wPost) choice = 'postup';
            else choice = 'pass';
            await sleep(1000);
        }

        if (choice === 'drive') return await executeAdvance('drive', 'drive', 'm2m', "돌파", "볼핸들링", "대인수비");
        else if (choice === 'fake') return await executeAdvance('fake', 'drive', 'm2m', "페이크 무브", "볼핸들링", "대인수비");
        else if (choice === 'postup') return await executeAdvance('postup', 'str', 'str', "포스트업", "힘", "힘");
        else if (choice === 'pass') return await handlePass(true);
    }

    async function executeAdvance(type, atkStatKey, defStatKey, actionLabel, atkStatName, defStatName) {
        Vis.advance(type); printLog(` ↳ ${actionLabel} 시도!`, "c-warn");
        await sleep(800);
        
        let cRes = await performContestedRoll(currentAttacker, currentDefender, atkStatKey, defStatKey, 0, atkStatName, defStatName);

        if (checkTurnover(cRes)) {
            currentDefender.gameStats.stl++; Vis.steal(currentDefender);
            let msg = cRes.offCrit === -1 ? "😵 공격 중 공을 흘립니다." : "🌟 수비수의 끈질긴 압박으로 공을 뺏어냅니다!";
            printLog(`   [턴오버!] ${msg} 치명적인 턴오버 발생!`, "c-fail");
            currentAttacker.gameStats.tov++;
            await handleFastBreak(currentDefender, currentAttacker, !isUserOffense);
            return true;
        }
        
        let isAutoSuccess = false;
        if (cRes.offCrit === 1) {
            let msg = (type === 'drive' || type === 'fake') ? "앵클브레이커! 수비수가 바닥에 뒹굽니다!" : "수비함락! 수비수를 종잇장처럼 밀어냅니다!";
            printLog(`   [대성공 발동] 🌟 ${msg} 슛이 무조건 성공합니다!`, "c-crit");
            isAutoSuccess = true;
        }

        // --- 헬프 수비 선택 페이즈 (페이크 무브는 성공해도 헬프 불가) ---
        let helperDefender = null;
        if (type === 'fake') {
            printLog(`   [수비 지시] 페이크 무브에는 헬프 수비를 갈 수 없습니다.`, "c-sys");
        } else if (!cRes.offWins) {
            printLog(`   [수비 지시] ${actionLabel}이(가) 막혀 헬프 수비는 발생하지 않습니다.`, "c-sys");
        } else if (isHuman(!isUserOffense)) {   // the DEFENDING side decides (in solo: only when the user defends)
            let helpOpts = [{ id: 'none', label: '헬프 안 함', stat: false }];
            POSITIONS.forEach(p => {
                if (p !== currentDefender.pos) {
                    helpOpts.push({ id: p, label: `[${p}] ${defTeam[p].name}`, stat: false });
                }
            });
            let helpChoice = await waitUserInput(helpOpts, `[수비] 상대의 ${actionLabel} 성공 이후 헬프 수비를 가시겠습니까?`, !isUserOffense);
            if (helpChoice !== 'none') helperDefender = defTeam[helpChoice];
        } else {
            const helpChance = 70;
            if (randInt(1, 100) <= helpChance) {
                let candidates = POSITIONS.filter(p => p !== currentDefender.pos);
                let pref = candidates.filter(p => p === 'C' || p === 'PF');
                let targetPos = (pref.length > 0 && randInt(1,100) <= 60) ? pref[randInt(0, pref.length-1)] : candidates[randInt(0, candidates.length-1)];
                helperDefender = defTeam[targetPos];
            }
        }

        if (helperDefender) {
            Vis.help(helperDefender); printLog(`   🚨 [수비 지시] ${helperDefender.pos} ${helperDefender.name}이(가) 헬프 수비를 들어옵니다!`, "c-sys");
        } else if (type !== 'fake' && cRes.offWins) {
            printLog(`   [수비 지시] 헬프 없이 1대1로 막아섭니다.`, "c-sys");
        }
        await sleep(1000);
        // ------------------------------

        let subChoice = "";
        let opts = [];
        if (type === 'fake') {
            opts.push({ id: 'pt3', label: '3점슛', statVal: getEffStat(currentAttacker, 'pt3'), stat: true });
            opts.push({ id: 'mid', label: '미들슛', statVal: getEffStat(currentAttacker, 'mid'), stat: true });
        } else {
            // 돌파 및 포스트업 이후에는 미들슛과 레이업(골밑슛)만 가능 (3점슛 불가)
            opts.push({ id: 'mid', label: '미들슛', statVal: getEffStat(currentAttacker, 'mid'), stat: true });
            opts.push({ id: 'layup', label: type === 'drive' ? '레이업' : '골밑슛', statVal: getEffStat(currentAttacker, 'layup'), stat: true });
        }
        if (!hasPassed) opts.push({ id: 'pass', label: '패스', statVal: getEffStat(currentAttacker, 'pass'), stat: true });

        if (isHuman(isUserOffense)) {
            subChoice = await waitUserInput(opts, `다음 연계 행동을 선택하세요`, isUserOffense);
        } else {
            let w3 = (type === 'fake') ? getEffStat(currentAttacker, 'pt3') : 0;
            let wM = getEffStat(currentAttacker, 'mid');
            let wL = (type === 'fake') ? 0 : getEffStat(currentAttacker, 'layup');
            let wP = hasPassed ? 0 : getEffStat(currentAttacker, 'pass');
            let total = w3 + wM + wL + wP;
            let r = randInt(1, total);
            if (r <= w3) subChoice = 'pt3';
            else if (r <= w3 + wM) subChoice = 'mid';
            else if (r <= w3 + wM + wL) subChoice = 'layup';
            else subChoice = 'pass';
            await sleep(1000);
        }

        if (subChoice === 'pass') {
            return await handlePass(false, helperDefender ? helperDefender.pos : null);
        } else {
            let isMid = subChoice === 'mid';
            let is3Pt = subChoice === 'pt3';
            let shootStatKey = subChoice;
            let shotName = is3Pt ? "3점슛" : (isMid ? "미들슛" : "골밑슛/레이업");
            let pts = is3Pt ? 3 : 2;
            
            let blockDefender = helperDefender ? helperDefender : currentDefender;
            let blkStatKey = (subChoice === 'layup') ? 'inBlk' : 'outBlk';
            
            Vis.prepShot(currentAttacker, subChoice); printLog(`   ↳ 연계 동작으로 ${shotName}을(를) 시도합니다!`, "c-warn");
            await sleep(800);

            if (isAutoSuccess && !isMid && !is3Pt) {
                printLog(`   ▶ 덩크 시도 여부를 결정하기 위한 힘(Str) 판정을 진행합니다.`, "c-sys");
                let strRes = await performSuccessRoll(currentAttacker, 'str', false, "덩크 (힘 판정)");
                recordShot(currentAttacker, shootStatKey, true);
                if (strRes.success) {
                    printLog(`   🚀 그대로 뛰어올라 화려한 프리 덩크를 꽂아넣습니다! (+2점)`, "c-crit");
                    addScoreAndStats(2);
                    applyMoraleBuff(offTeam);
                    clearAirball(currentAttacker, 'layup');
                    return false;
                } else {
                    printLog(`   안전하게 올려놓습니다. (+2점)`, "c-succ");
                    addScoreAndStats(2);
                    clearAirball(currentAttacker, 'layup');
                    return false;
                }
            }
            if (isAutoSuccess && (isMid || is3Pt)) {
                recordShot(currentAttacker, shootStatKey, true);
                printLog(`   💥 여유있게 ${shotName} 득점을 올립니다! (+${pts}점)`, "c-succ");
                addScoreAndStats(pts); 
                clearAirball(currentAttacker, shootStatKey);
                return false;
            }

            printLog(`   ▶ 슛 성공 여부를 먼저 확인합니다.`, "c-sys");
            await sleep(800);
            let sRes = await performSuccessRoll(currentAttacker, shootStatKey, !cRes.offWins, shotName);
            
            if (sRes.crit === -1) {
                recordShot(currentAttacker, shootStatKey, false);
                printLog(`   😵 [에어볼 대실패!] 형편없는 슛이 나옵니다... 의기소침 상태가 됩니다.`, "c-crit");
                currentAttacker.airball[shootStatKey] = true;
                printLog(`   어이없는 에어볼로 리바운드 없이 그대로 공격권이 넘어갑니다.`, "c-fail");
                return false;
            }

            let bRes = null;
            if (sRes.crit === 1) {
                if (isMid || is3Pt) {
                    if(!currentAttacker.hotHand) currentAttacker.hotHand = {};
                    currentAttacker.hotHand[shootStatKey] = true;
                    printLog(`   🔥 [핫핸드 발동] ${shotName} 감각 절정! 완벽한 포물선으로 블락이 불가합니다.`, "c-sys");
                } else {
                    let isGuard = currentAttacker.pos === 'PG' || currentAttacker.pos === 'SG';
                    if (isGuard) {
                        printLog(`   ☄️ 수비 키를 살짝 넘기는 환상적인 플로터! 블락 불가!`, "c-crit");
                    } else {
                        printLog(`   ☄️ 림을 향해 무자비하게 날아오릅니다! 인유어페이스 덩크 시도!`, "c-crit");
                        let canBlockDunk = helperDefender || !cRes.offWins;
                        if (canBlockDunk) {
                            printLog(`   ▶ 수비측이 대성공(1)을 띄워야만 이 덩크를 막을 수 있습니다! 결사의 블락 판정 진행!`, "c-warn");
                            await sleep(1500);
                            bRes = await performSuccessRoll(blockDefender, blkStatKey, true, "결사적인 블락");
                            if (bRes && bRes.crit === 1) {
                                recordShot(currentAttacker, shootStatKey, false);
                                printLog(`   ✋ [수비 대성공!] 블록커도 똑같이 날아올라 덩크를 쳐냅니다!!! 엄청난 블락 후 속공 전개!`, "c-fail");
                                blockDefender.gameStats.blk++;
                                currentAttacker.gameStats.tov++;
                                await handleFastBreak(blockDefender, currentAttacker, !isUserOffense);
                                return true;
                            } else {
                                bRes = null; 
                                recordShot(currentAttacker, shootStatKey, true);
                                printLog(`   쾅!!! 💥 수비를 뚫어버리고 그대로 덩크를 내리찍습니다!!! (+2점)`, "c-crit");
                                addScoreAndStats(2);
                                applyMoraleBuff(offTeam);
                                applyDemoralizeDebuff(blockDefender);
                                clearAirball(currentAttacker, 'layup');
                                return false; 
                            }
                        } else {
                            recordShot(currentAttacker, shootStatKey, true);
                            printLog(`   쾅!!! 💥 덩크를 완벽하게 내리찍습니다!!! (+2점)`, "c-crit");
                            addScoreAndStats(2);
                            applyMoraleBuff(offTeam);
                            applyDemoralizeDebuff(blockDefender);
                            clearAirball(currentAttacker, 'layup');
                            return false; 
                        }
                    }
                }
            }

            let canBlock = helperDefender || !cRes.offWins;
            if (!canBlock) {
                printLog(`   ▶ 공격자가 대항판정에 승리하여 수비의 블락 기회가 없습니다.`, "c-sys");
            } else if (sRes.crit !== 1) {
                printLog(`   ▶ [수비측 블락 기회] 헬프 수비 또는 대항 판정 방어로 인해 블락을 시도합니다!`, "c-warn");
                await sleep(1500);
                bRes = await performSuccessRoll(blockDefender, blkStatKey, true, helperDefender ? "헬프 블락" : "슛블락");
            }

            if (bRes && bRes.success) {
                recordShot(currentAttacker, shootStatKey, false);
                if (bRes.crit === 1) {
                    printLog(`   ✋ [블락 대성공!] ${blockDefender.name}의 무자비한 블락! 공을 잡아채며 속공으로 이어집니다!`, "c-fail");
                    blockDefender.gameStats.blk++;
                    currentAttacker.gameStats.tov++;
                    await handleFastBreak(blockDefender, currentAttacker, !isUserOffense);
                    return true;
                } else {
                    printLog(`   ✋ ${blockDefender.name}의 완벽한 타이밍! 슛을 쳐내며 공격이 즉시 종료됩니다!`, "c-fail");
                    blockDefender.gameStats.blk++;
                    return false;
                }
            } 
            
            if (sRes.success) {
                recordShot(currentAttacker, shootStatKey, true);
                printLog(`   💥 득점 성공! (+${pts}점)`, "c-succ");
                addScoreAndStats(pts);
                clearAirball(currentAttacker, shootStatKey);
            } else {
                recordShot(currentAttacker, shootStatKey, false);
                if((isMid || is3Pt) && currentAttacker.hotHand && currentAttacker.hotHand[shootStatKey]) {
                    currentAttacker.hotHand[shootStatKey] = false;
                    printLog(`   ❄️ 슛 미스로 인해 핫핸드가 식었습니다.`, "c-fail");
                }
                
                if (shootStatKey === 'layup') {
                    printLog(`   ❌ 아쉽게 빗나갑니다. 골밑슛/레이업 실패로 리바운드 없이 공격권이 넘어갑니다.`, "c-fail");
                } else {
                    await handleRebound();
                }
            }
            return false;
        }
    }

    async function wideOpenPhase() {
        let choice = "";
        let opts = [
            { id: 'pt3', label: '3점슛', statVal: getEffStat(currentAttacker, 'pt3'), stat: true },
            { id: 'mid', label: '미들슛', statVal: getEffStat(currentAttacker, 'mid'), stat: true },
            { id: 'layup', label: '레이업', statVal: getEffStat(currentAttacker, 'layup'), stat: true }
        ];

        if (isHuman(isUserOffense)) {
            choice = await waitUserInput(opts, `[와이드 오픈!] 마무리 방식을 선택하세요 (대항판정 생략)`, isUserOffense);
        } else {
            let r = randInt(1, 100);
            if(r <= 35) choice = 'pt3';
            else if(r <= 65) choice = 'mid';
            else choice = 'layup';
            await sleep(1000);
        }

        let shootStatKey = choice; Vis.prepShot(currentAttacker, choice);
        let shotName = choice === 'pt3' ? '3점슛' : (choice === 'mid' ? '미들슛' : '레이업/골밑슛');
        let pts = choice === 'pt3' ? 3 : 2;

        if (choice === 'layup') {
            printLog(`   🏃‍♂️ 수비의 빈틈을 노려 완벽하게 컷인했습니다! 노마크 레이업 찬스!`, "c-succ");
        } else {
            printLog(`   🎯 빈 공간을 찾아 완벽한 와이드 오픈을 만들었습니다! 슛 찬스!`, "c-succ");
        }
        await sleep(800);

        let sRes = await performSuccessRoll(currentAttacker, shootStatKey, false, "노마크 " + shotName);

        if (sRes.crit === -1) {
            recordShot(currentAttacker, shootStatKey, false);
            printLog(`   😵 [에어볼 대실패!] 완벽한 노마크 찬스에서 어이없는 에어볼! 의기소침해집니다.`, "c-crit");
            currentAttacker.airball[shootStatKey] = true;
            printLog(`   리바운드 없이 그대로 공격권이 넘어갑니다.`, "c-fail");
            return false;
        }

        if (sRes.crit === 1) {
            printLog(`   🔥 [핫핸드 발동] 완벽한 마무리! 슛 감각이 상승합니다.`, "c-crit");
            if(!currentAttacker.hotHand) currentAttacker.hotHand = {};
            currentAttacker.hotHand[shootStatKey] = true;
        }

        if (sRes.success) {
            recordShot(currentAttacker, shootStatKey, true);
            printLog(`   💥 득점 성공! (+${pts}점)`, "c-succ");
            addScoreAndStats(pts);
            clearAirball(currentAttacker, shootStatKey);
        } else {
            recordShot(currentAttacker, shootStatKey, false);
            printLog(`   ❌ 아쉽게 빗나갑니다.`, "c-fail");
            if (choice === 'layup') {
                printLog(`   노마크 레이업 실패로 공수교대 됩니다.`, "c-fail");
            } else {
                await handleRebound();
            }
        }
        return false;
    }

    async function handlePass(isInitial, helperPos = null) {
        hasPassed = true;
        printLog(`   ↳ 패스 시도! (나머지 4명의 팀원 오프볼 vs 대인수비 간이 판정 진행)`, "c-warn");
        await sleep(1500);

        let openTeammates = [];
        let offBallCrits = {}; 

        for (let pos of POSITIONS) {
            if (pos === currentAttacker.pos) continue; 
            let offP = offTeam[pos];
            let defP = defTeam[pos];

            if (helperPos === pos) {
                printLog(`     [${pos}] ${offP.name} -> 🚨 헬프 수비가 빠진 공간, 완벽한 노마크 와이드 오픈!`, "c-crit");
                openTeammates.push(offP);
                offBallCrits[pos] = true; 
                await sleep(300);
                continue;
            }
            
            let aVal = getEffStat(offP, 'offBall');
            let dVal = getEffStat(defP, 'm2m');
            let res = rollContested(aVal, dVal, 0);
            
            if (res.offCrit === 1) offBallCrits[pos] = true;

            let resultStr = res.offWins ? "✅ 오픈 공간 확보" : "❌ 수비에게 차단됨";
            let colorStr = res.offWins ? "c-succ" : "c-fail";
            if (res.offCrit === 1) { resultStr = "🌟 대성공 오픈!"; colorStr = "c-crit"; }
            
            printLog(`     [${pos}] ${offP.name}(${aVal}) vs ${defP.name}(${dVal}) -> ${resultStr} (공격 ${res.offTotal} vs 수비 ${res.defTotal})`, colorStr);
            
            if (res.offWins) openTeammates.push(offP);
            await sleep(300);
        }

        if (openTeammates.length === 0) {
            printLog(`   ❌ 패스를 받을 선수가 없습니다! 공격이 실패하며 공격권이 넘어갑니다. (속공 미발생)`, "c-fail");
            currentAttacker.gameStats.tov++;
            return false;
        }

        let receiver = null;
        if (openTeammates.length > 1 && isHuman(isUserOffense)) {
            let pOpts = openTeammates.map(p => {
                let lbl = `[${p.pos}] ${p.name}`;
                if(offBallCrits[p.pos]) lbl += " (와이드 오픈!)";
                return { id: p.pos, label: lbl, stat: false };
            });
            let choice = await waitUserInput(pOpts, "누구에게 패스하시겠습니까?", isUserOffense);
            receiver = openTeammates.find(p => p.pos === choice);
        } else {
            let wideOpens = openTeammates.filter(p => offBallCrits[p.pos]);
            if (wideOpens.length > 0 && randInt(1,100) <= 80) receiver = wideOpens[randInt(0, wideOpens.length-1)];
            else receiver = openTeammates[randInt(0, openTeammates.length - 1)];
        }

        printLog(`   ▶ 패스 성공 판정을 진행합니다.`, "c-sys");
        await sleep(800);
        
        let sRes;
        if (isInitial) {
            sRes = await performAdvantageSuccessRoll(currentAttacker, 'pass', false, "패스 딜리버리");
        } else {
            sRes = await performSuccessRoll(currentAttacker, 'pass', false, "패스 딜리버리");
        }
        
        if (sRes.crit === -1) {
            printLog(`   😵 패스 미스 대실패! 공이 완전히 엉뚱한 곳으로 향합니다.`, "c-crit"); 
            currentDefender.gameStats.stl++; Vis.steal(currentDefender);
            currentAttacker.gameStats.tov++;
            await handleFastBreak(currentDefender, currentAttacker, !isUserOffense);
            return true;
        }

        if (sRes.success) {
            let isWideOpen = offBallCrits[receiver.pos] || sRes.crit === 1;

            if (isWideOpen) {
                printLog(`   💫 [${receiver.pos}] ${receiver.name}에게 와이드 오픈 패스 연결!`, "c-succ");
                printLog(`   🌟 [대성공 발동!] 완벽한 패스 워크로 수비를 완전히 허물었습니다!`, "c-crit");
                Vis.pass(currentAttacker, receiver); currentAssister = currentAttacker;
                currentAttacker = receiver;
                await sleep(1000);
                return await wideOpenPhase();
            } else {
                printLog(`   💫 [${receiver.pos}] ${receiver.name}에게 정확한 패스 연결!`, "c-succ");
                Vis.pass(currentAttacker, receiver); currentAssister = currentAttacker; 
                currentAttacker = receiver;
                await sleep(1000);
                return await phaseDecision(); 
            }
        } else {
            printLog(`   ❌ 아슬아슬하게 수비수 손에 걸리며 턴오버 발생. (속공 미발생)`, "c-fail");
            currentDefender.gameStats.stl++; Vis.steal(currentDefender);
            currentAttacker.gameStats.tov++;
            return false;
        }
    }

    async function handleRebound() {
        printLog(`\n ↳ 🏀 림을 맞고 나온 공! 리바운드 경합 발생!`, "c-warn");
        await sleep(1500);

        let getRebPlayers = (team, isOffense) => {
            let p1 = team['C']; let p2 = team['PF'];
            if (isOffense && (currentAttacker.pos === 'C' || currentAttacker.pos === 'PF')) {
                p1 = currentAttacker.pos === 'C' ? team['PF'] : team['C'];
                p2 = team['SF'];
            }
            return [p1, p2];
        };

        let offR = getRebPlayers(offTeam, true);
        let defR = getRebPlayers(defTeam, false);

        function rebContestLog(atkP, defP) {
            let aVal = getEffStat(atkP, 'str');
            let dVal = getEffStat(defP, 'str');
            let cRes = rollContested(aVal, dVal, 1);
            let aTotal = cRes.offRoll + getBonus(aVal);
            let dTotal = cRes.defRoll + getBonus(dVal) + 1; 
            
            let winnerName = cRes.offWins ? atkP.name : defP.name;
            let winColor = cRes.offWins ? "c-succ" : "c-fail";
            
            printLog(`   [힘 대항결과] 공격 ${atkP.name}(주사위${cRes.offRoll}+보너스${getBonus(aVal)} = ${aTotal}, 힘:${aVal}) VS 수비 ${defP.name}(주사위${cRes.defRoll}+보너스${getBonus(dVal)}+수비가점1 = ${dTotal}, 힘:${dVal})`, "c-sys");
            printLog(`      => <span class="${winColor}">${winnerName} 박스아웃 성공!</span>`, "c-sys");
            return cRes;
        }

        Vis.rebPos(offR, defR);
        let match1 = rebContestLog(offR[0], defR[0]);
        await sleep(1000);
        let match2 = rebContestLog(offR[1], defR[1]);
        await sleep(1000);

        let offWinsCount = (match1.offWins ? 1 : 0) + (match2.offWins ? 1 : 0);

        if (offWinsCount === 2) {
            printLog(`   🔄 공격팀이 박스아웃을 완벽히 뚫어냈습니다! 공격 리바운드 획득!`, "c-succ");
            offR[0].gameStats.oreb++; Vis.grab(offR[0]); 
            await newPossessionRebound(true);
        } else if (offWinsCount === 0) {
            printLog(`   🛡️ 수비팀이 철저하게 골밑을 사수합니다. 수비 리바운드!`, "c-sys");
            defR[0].gameStats.dreb++; Vis.grab(defR[0]);
        } else {
            printLog(`   ⚔️ 혼전 상황! 박스아웃에 승리한 두 선수가 리바운드 성공 판정을 겨룹니다.`, "c-warn");
            await sleep(1500);
            
            let offWinner = match1.offWins ? offR[0] : offR[1];
            let defWinner = !match1.offWins ? defR[0] : defR[1];

            function rebSuccessLog(p) {
                let sRes = rollSuccess(getEffStat(p, 'reb'), false);
                let target = getEffStat(p, 'reb');
                let resultStr = sRes.success ? "성공" : "실패";
                let colStr = sRes.success ? "c-succ" : "c-fail";
                printLog(`   [캐치 판정] ${p.name} -> 주사위 [ ${sRes.roll} ] (기준: ${target} 이하) -> <span class="${colStr}">${resultStr}</span>`, "c-sys");
                return sRes;
            }

            let offRoll = rebSuccessLog(offWinner);
            await sleep(800);
            let defRoll = rebSuccessLog(defWinner);
            await sleep(1000);

            if (offRoll.success && defRoll.success) {
                if (getEffStat(offWinner, 'reb') > getEffStat(defWinner, 'reb')) {
                    printLog(`   🔄 스탯이 더 높은 공격팀이 공을 뺏어냅니다! 공격 리바운드!`, "c-succ");
                    offWinner.gameStats.oreb++; Vis.grab(offWinner);
                    await newPossessionRebound(true);
                } else {
                    printLog(`   🛡️ 스탯 우위로 수비팀이 공을 지켜냅니다!`, "c-sys");
                    defWinner.gameStats.dreb++; Vis.grab(defWinner);
                }
            } else if (offRoll.success) {
                printLog(`   🔄 ${offWinner.name} 재빠르게 튀어올라 공격 리바운드 따냅니다!`, "c-succ");
                offWinner.gameStats.oreb++; Vis.grab(offWinner);
                await newPossessionRebound(true);
            } else if (defRoll.success) {
                printLog(`   🛡️ ${defWinner.name} 수비 리바운드 안전하게 잡습니다.`, "c-sys");
                defWinner.gameStats.dreb++; Vis.grab(defWinner);
            } else {
                printLog(`   루즈볼 라인아웃! 서로 공을 놓쳐 공격권이 넘어갑니다.`, "c-fail");
            }
        }
    }

    async function newPossessionRebound(isOffReb) {
        if(isOffReb) {
            hasPassed = false;
            currentAssister = null;
            let players = Object.values(offTeam);
            currentAttacker = players[randInt(0, 4)]; Vis.reset();
            printLog(`\n   ▶ 공격 리바운드 획득! [${currentAttacker.pos}] ${currentAttacker.name} 다시 세팅합니다.`, "c-sys");
            await sleep(1500);
            await phaseDecision();
        }
    }

    function addScoreAndStats(pts) {
        currentAttacker.gameStats.pts += pts;
        if (currentAssister) currentAssister.gameStats.ast++; 
        if (isUserOffense) userScore += pts; else cpuScore += pts;
        updateScore();
    }

    // ---- 이 방(게임)의 엔진이 바깥에서 쓸 수 있게 공개하는 것들 ----
    return {
        POSITIONS,
        initDraftPool,
        draftPlayer,
        draftPlayerPvp,
        getMissingPos,
        resetGame,
        // 테스트/서버 쪽에서 현재 상태를 들여다보기 위한 용도 (다음 단계에서 sanitize 버전으로 다듬을 예정)
        getState() {
            return { userTeam, cpuTeam, userScore, cpuScore, currentAttacker, currentDefender,
                      isUserOffense, hasPassed, quarter, possession, gameStatus, draftPool, allFixedPlayers, mode };
        }
    };
}

module.exports = createGameEngine;
