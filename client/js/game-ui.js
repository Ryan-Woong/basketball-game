/* UI controller. The browser never decides anything: it shows what the server sends and sends back
 * only WHAT the player chose (draftPick {pickId}, gameAction {requestId, choice}). */
const $ = (id) => document.getElementById(id);
const POS = ['PG', 'SG', 'SF', 'PF', 'C'];
const STAT_COLS = [['pt3', '3점슛'], ['mid', '미들슛'], ['layup', '레이업'], ['outBlk', '슛블락'], ['inBlk', '골밑블락'], ['m2m', '대인수비'],
                   ['str', '힘'], ['drive', '볼핸들링'], ['pass', '패스'], ['offBall', '오프볼'], ['reb', '리바운드']];
const SCREENS = ['lobby', 'guide-screen', 'room-screen', 'draft-screen', 'sim-screen'];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
    screen: 'lobby', mySlot: null, roomId: null, finished: false, lastSeq: 0, evtCount: 0,
    teamState: null,      // latest TEAM_STATE (effective stats, marks, live box score)
    boxScore: null,       // final box score from GAME_END
    timer: { deadline: 0, target: null },
    seenPlaying: false,
};
const oppSlot = () => (S.mySlot === 'p1' ? 'p2' : 'p1');
const myName = () => Roster.names[S.mySlot] || '나';
const oppName = () => Roster.names[oppSlot()] || '상대';

function show(id) {
    SCREENS.forEach(s => $(s).classList.toggle('hidden', s !== id));
    S.screen = id;
}
function setConn(text, color) { $('conn-banner').textContent = text; $('conn-banner').style.color = color; }

/* ---------------- countdown (server tells us the limit; we only display it) ---------------- */
function startTimer(target, ms) { S.timer = { deadline: Date.now() + ms, target }; tickTimer(); }
function stopTimer() { S.timer = { deadline: 0, target: null }; ['draft-timer', 'action-timer', 'wait-timer'].forEach(id => { $(id).textContent = ''; $(id).classList.remove('warn'); }); }
function tickTimer() {
    const t = S.timer; if (!t.target) return;
    const left = Math.max(0, Math.ceil((t.deadline - Date.now()) / 1000));
    const el = $({ draft: 'draft-timer', action: 'action-timer', wait: 'wait-timer' }[t.target]);
    el.textContent = `⏱ 남은 시간 ${left}초 (시간이 지나면 기권패)`;
    el.classList.toggle('warn', left <= 10);
}
setInterval(tickTimer, 250);

/* ---------------- lobby ---------------- */
function showGuide() { show('guide-screen'); }
function hideGuide() { show('lobby'); }
function nick() { return $('nickname').value.trim() || 'Player'; }

async function createRoom() {
    $('lobby-msg').textContent = '';
    const res = await send('createRoom', { playerId, nickname: nick() });
    if (res.error) return void ($('lobby-msg').textContent = errText(res.error));
    enterRoom(res);
}
async function joinRoom() {
    $('lobby-msg').textContent = '';
    const res = await send('joinRoom', { playerId, nickname: nick(), roomId: $('room-input').value });
    if (res.error) return void ($('lobby-msg').textContent = errText(res.error));
    enterRoom(res);
}
function errText(e) {
    return ({ ROOM_NOT_FOUND: '그런 방이 없습니다. 코드를 확인하세요. (서버가 잠들었다 깨어나면 방이 사라집니다)', ROOM_FULL: '이미 두 명이 들어간 방입니다.',
        CANNOT_JOIN_OWN_ROOM: '자기 자신의 방에는 참가할 수 없습니다.', INVALID_PAYLOAD: '닉네임과 방 코드를 확인하세요.', SERVER_FULL: '서버의 방이 가득 찼습니다. 잠시 후 다시 시도하세요.',
        ALREADY_IN_ROOM: '이미 방에 들어가 있습니다.', RATE_LIMITED: '너무 빠르게 요청했습니다. 잠시 후 다시 시도하세요.' }[e]) || ('오류: ' + e);
}
function enterRoom(res) {
    S.mySlot = res.slot; S.roomId = res.roomId; Roster.me = res.slot;
    $('room-code').textContent = res.roomId;
    $('ready-btn').disabled = false; $('ready-btn').textContent = 'READY';
    $('room-msg').textContent = res.slot === 'p1' ? '상대가 코드를 입력해 입장하기를 기다리는 중...' : '';
    show('room-screen');
}
async function sendReady() {
    const res = await send('ready');
    if (res.error) return void ($('room-msg').textContent = res.error === 'WAITING_FOR_OPPONENT' ? '상대가 아직 입장하지 않았습니다.' : errText(res.error));
    $('ready-btn').disabled = true; $('ready-btn').textContent = 'READY 완료';
}
function renderRoomState(room) {
    ['p1', 'p2'].forEach(s => { if (room.players[s]) Roster.names[s] = room.players[s].nickname; });
    let html = '';
    ['p1', 'p2'].forEach(s => {
        const p = room.players[s];
        html += `<div class="player-row">${s.toUpperCase()}${s === S.mySlot ? ' (나)' : ''}: ${p ? esc(p.nickname) + (p.ready ? ' ✅ READY' : ' ⏳') : '<span class="c-fail">(대기 중)</span>'}</div>`;
    });
    $('room-players').innerHTML = html;
    if (S.screen === 'room-screen' && S.mySlot === 'p1' && room.players.p2) $('room-msg').textContent = '상대가 입장했습니다. READY를 눌러 주세요.';
}

/* ---------------- draft ---------------- */
function rosterTable(team) {
    let html = `<table style="font-size:11px;"><tr><th>포지션</th><th>이름</th><th>OVR</th><th>슛(3/M/L)</th><th>수비(대인/슛블/골블)</th><th>기회(핸들/패스/오프/힘/리바)</th></tr>`;
    POS.forEach(pos => {
        const p = team[pos];
        html += p
            ? `<tr><td>${pos}</td><td>${esc(p.name)}</td><td><b>${p.ovr}</b></td><td>${p.pt3}/${p.mid}/${p.layup}</td><td>${p.m2m}/${p.outBlk}/${p.inBlk}</td><td>${p.drive}/${p.pass}/${p.offBall}/${p.str}/${p.reb}</td></tr>`
            : `<tr><td style="color:#777">${pos}</td><td colspan="5" style="color:#777">공석</td></tr>`;
    });
    return html + '</table>';
}
function renderDraft(st) {
    $('my-roster-title').textContent = `나의 팀 (${myName()})`;
    $('opp-roster-title').textContent = `상대 팀 (${oppName()})`;
    $('user-roster').innerHTML = rosterTable(st.teams[S.mySlot] || {});
    $('cpu-roster').innerHTML = rosterTable(st.teams[oppSlot()] || {});
    const myTurn = st.draftTurn === S.mySlot;
    $('draft-turn').textContent = myTurn ? '🟢 내 차례입니다! 영입할 선수를 고르세요.' : `⏳ ${oppName()}님이 선수를 고르는 중...`;
    $('draft-turn').className = 'turn-banner ' + (myTurn ? 'c-succ' : 'c-sys');
    const list = $('available-players'); list.innerHTML = '';
    if (st.turnTimeoutMs) startTimer('draft', st.turnTimeoutMs);
    if (!myTurn) return;
    const missing = POS.filter(p => !(st.teams[S.mySlot] || {})[p]);
    st.draftPool.filter(p => missing.includes(p.pos)).forEach(p => {
        const b = document.createElement('button'); b.className = 'avail-btn';
        b.textContent = `[${p.pos}] ${p.name} | OVR:${p.ovr} | 슛(${p.pt3}/${p.mid}/${p.layup}) 수비(${p.m2m}/${p.outBlk}/${p.inBlk}) 기회(핸들${p.drive}/패스${p.pass}/오프${p.offBall}/힘${p.str}/리바${p.reb})`;
        b.onclick = async () => {
            list.querySelectorAll('button').forEach(x => { x.disabled = true; });   // no double picks
            const res = await send('draftPick', { pickId: p.id });
            if (res.error) $('draft-turn').textContent = '선택 오류: ' + res.error;
        };
        list.appendChild(b);
    });
}

/* ---------------- game log / dice ---------------- */
function logLine(text, cls) {
    const box = $('log-box');
    const sp = document.createElement('span'); sp.className = cls || 'c-fail'; sp.textContent = text;
    box.appendChild(sp); box.appendChild(document.createTextNode('\n'));
    box.scrollTop = box.scrollHeight;
}
const FACES = ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'], rnd = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
function diceBox(style, frame, final) {   // server waits 1700 ms after DICE_* (900 rolling + 800 result), same as the original
    const el = document.createElement('div');
    el.style.cssText = 'text-align:center; margin:10px 0; border:1px dashed #555; padding:5px; background:#1a1a1a; border-radius:5px;' + style;
    $('log-box').appendChild(el); $('log-box').scrollTop = $('log-box').scrollHeight;
    let n = 0;
    (function step() {
        if (n < 6) { n++; frame(el); setTimeout(step, 150); } else { final(el); $('log-box').scrollTop = $('log-box').scrollHeight; }
    })();
}
function onDice(type, d) {
    if (type === 'DICE_CONTESTED') {
        diceBox('font-size:18px;', (el) => { el.innerHTML = `<span style="color:#81c784">공격 🎲${FACES[rnd(0, 5)]}</span> <span style="color:#e0e0e0">VS</span> <span style="color:#e57373">수비 🎲${FACES[rnd(0, 5)]}</span>`; },
            (el) => { el.innerHTML = `<span style="color:#81c784; font-weight:bold;">공격 🎲${FACES[d.offFinal - 1]} (${d.offFinal})</span> <span style="color:#e0e0e0">VS</span> <span style="color:#e57373; font-weight:bold;">수비 🎲${FACES[d.defFinal - 1]} (${d.defFinal})</span>`; });
    } else if (type === 'DICE_SUCCESS') {
        diceBox('font-size:16px; color:#ce93d8;', (el) => { el.textContent = `🎲 굴리는 중... [ ${rnd(1, 20)} ]`; }, (el) => { el.textContent = `🎲 주사위 굴림 결과 [ ${d.finalVal} ]`; });
    } else if (type === 'DICE_ADV') {
        diceBox('font-size:16px; color:#ce93d8;', (el) => { el.textContent = `🎲 굴리는 중... [ ${rnd(1, 20)} ] [ ${rnd(1, 20)} ]`; }, (el) => { el.textContent = `🎲 1차[ ${d.r1} ] / 2차[ ${d.r2} ] -> 최종 결과 [ ${d.finalRoll} ]`; });
    }
}

/* ---------------- game events ---------------- */
function setScore(p1, p2) { $('score-board').textContent = `${Roster.names.p1} ${p1} : ${p2} ${Roster.names.p2}`; }
function hidePanels() { ['action-panel', 'wait-panel'].forEach(id => $(id).classList.add('hidden')); }

function onGameEvent(e) {
    S.evtCount++;
    if (S.lastSeq && e.seq !== S.lastSeq + 1) logLine(`⚠️ 이벤트 누락 감지: ${S.lastSeq} → ${e.seq}`, 'c-crit');
    S.lastSeq = e.seq;
    const d = e.data || {};
    switch (e.type) {
        case 'LOG': logLine(d.text, d.cls); break;
        case 'SCORE': Cur.score = { p1: d.p1, p2: d.p2 }; setScore(d.p1, d.p2); break;
        case 'TEAM_STATE': S.teamState = d; break;
        case 'WAITING_FOR_ACTION':
            if (d.forSlot !== S.mySlot) {   // the opponent has to decide: show who/what we are waiting for
                $('action-panel').classList.add('hidden'); $('wait-panel').classList.remove('hidden');
                $('wait-text').textContent = `⏳ ${oppName()}님의 선택을 기다리는 중... (${d.title})`;
                startTimer('wait', d.timeoutMs || 60000);
            } else { $('wait-panel').classList.add('hidden'); }
            break;
        case 'DICE_CONTESTED': case 'DICE_SUCCESS': case 'DICE_ADV': onDice(e.type, d); break;
        case 'GAME_END': onGameEnd(d); break;
        case 'ENGINE_ERROR': logLine('❌ 서버 엔진 오류가 발생했습니다.', 'c-crit'); break;
        default: if (e.type.startsWith('VIS_')) Court.onEvent(e.type, d);
    }
}
function onGameEnd(d) {
    S.finished = true; S.boxScore = d.boxScore; stopTimer(); hidePanels();
    setScore(d.p1Score, d.p2Score);
    const mine = S.mySlot === 'p1' ? d.p1Score : d.p2Score, theirs = S.mySlot === 'p1' ? d.p2Score : d.p1Score;
    $('end-title').textContent = mine > theirs ? '🎉 승리!' : mine < theirs ? '😢 패배' : '🤝 무승부';
    $('end-title').className = mine > theirs ? 'c-succ' : mine < theirs ? 'c-cpu' : 'c-warn';
    $('end-panel').classList.remove('hidden');
}

/* the server asks ME to decide */
function onActionRequest(req) {
    $('wait-panel').classList.add('hidden');
    $('action-title').textContent = req.title;
    const wrap = $('action-buttons'); wrap.innerHTML = '';
    req.options.forEach(o => {
        const b = document.createElement('button'); b.className = 'action-btn';
        b.textContent = o.label + (o.stat ? ` (${o.statVal})` : '');
        b.onclick = async () => {
            wrap.querySelectorAll('button').forEach(x => { x.disabled = true; });   // answer once
            const res = await send('gameAction', { requestId: req.requestId, choice: o.id });
            if (res.error) { logLine('선택 오류: ' + res.error, 'c-fail'); wrap.querySelectorAll('button').forEach(x => { x.disabled = false; }); }
            else { $('action-panel').classList.add('hidden'); stopTimer(); }
        };
        wrap.appendChild(b);
    });
    $('action-panel').classList.remove('hidden');
    startTimer('action', req.timeoutMs || 60000);
}

/* ---------------- modals (data comes from the server's TEAM_STATE / GAME_END) ---------------- */
function showAttributes() {
    const ts = S.teamState; if (!ts) return;
    const mark = (e, key) => {
        const v = e.eff[key], dl = (e.delta || {})[key] || 0, m = [];
        if (dl > 0) m.push(`<span style="color:#81c784">↑${dl}</span>`);
        if (dl < 0) m.push(`<span style="color:#e57373">↓${Math.abs(dl)}</span>`);
        if ((e.air || []).includes(key)) m.push('<span style="color:#e57373">↓</span>');
        if ((e.hot || []).includes(key)) m.push('<span style="color:#81c784">↑</span>');
        return m.length ? `${v} (${m.join(' ')})` : v;
    };
    const table = (slot, title) => {
        let html = `<h3>${title}</h3><table><tr><th>POS</th><th>이름</th><th>OVR</th>${STAT_COLS.map(c => `<th>${c[1]}</th>`).join('')}</tr>`;
        POS.forEach(pos => {
            const p = Roster.team[slot][pos], e = (ts[slot] || []).find(x => p && x.id === p.id);
            if (!p || !e) return;
            const ovr = STAT_COLS.reduce((a, c) => a + e.eff[c[0]], 0);
            html += `<tr><td>${pos}</td><td>${esc(p.name)}</td><td><b>${ovr}</b></td>${STAT_COLS.map(c => `<td>${mark(e, c[0])}</td>`).join('')}</tr>`;
        });
        return html + '</table><br>';
    };
    $('attr-content').innerHTML = table(S.mySlot, `🔵 ${esc(myName())} (나)`) + table(oppSlot(), `🔴 ${esc(oppName())}`);
    $('attr-modal').classList.remove('hidden');
}
function showBoxScore() {
    const rowsOf = (slot) => {   // final box score if the game is over, otherwise the live one from TEAM_STATE
        if (S.boxScore) return S.boxScore[slot].map(r => ({ pos: r.pos, name: r.name, gs: r }));
        return POS.map(pos => Roster.team[slot][pos]).filter(Boolean).map(p => {
            const e = S.teamState && (S.teamState[slot] || []).find(x => x.id === p.id);
            return { pos: p.pos, name: p.name, gs: (e && e.gs) || p.gameStats || {} };
        });
    };
    const table = (slot, title) => {
        let html = `<h3>${title}</h3><table><tr><th>POS</th><th>이름</th><th>PTS</th><th>FGM</th><th>FGA</th><th>FG%</th><th>3PM</th><th>3PA</th><th>3P%</th><th>OREB</th><th>DREB</th><th>REB</th><th>AST</th><th>TOV</th><th>STL</th><th>BLK</th></tr>`;
        rowsOf(slot).forEach(({ pos, name, gs }) => {
            const g = (k) => gs[k] || 0;
            const fgp = g('fga') > 0 ? (g('fgm') / g('fga') * 100).toFixed(1) : '0.0', fg3p = g('fg3a') > 0 ? (g('fg3m') / g('fg3a') * 100).toFixed(1) : '0.0';
            html += `<tr><td>${pos}</td><td>${esc(name)}</td><td class="stat-highlight">${g('pts')}</td><td>${g('fgm')}</td><td>${g('fga')}</td><td>${fgp}</td>
                <td>${g('fg3m')}</td><td>${g('fg3a')}</td><td>${fg3p}</td><td style="color:#81c784">${g('oreb')}</td><td style="color:#81c784">${g('dreb')}</td>
                <td style="color:#81c784; font-weight:bold;">${g('oreb') + g('dreb')}</td><td style="color:#64b5f6">${g('ast')}</td><td style="color:#9e9e9e">${g('tov')}</td>
                <td style="color:#ba68c8">${g('stl')}</td><td style="color:#e57373">${g('blk')}</td></tr>`;
        });
        return html + '</table><br>';
    };
    $('boxscore-content').innerHTML = table(S.mySlot, `🔵 ${esc(myName())} (나)`) + table(oppSlot(), `🔴 ${esc(oppName())}`);
    $('boxscore-modal').classList.remove('hidden');
}
function closeModals() { $('attr-modal').classList.add('hidden'); $('boxscore-modal').classList.add('hidden'); }

/* ---------------- leaving / room closed ---------------- */
function resetLocal() {
    stopTimer(); closeModals(); hidePanels();
    $('end-panel').classList.add('hidden'); $('end-note').textContent = ''; $('closed-screen').classList.add('hidden');
    $('log-box').innerHTML = ''; $('score-board').textContent = '0 : 0';
    Court.reset();
    Object.assign(S, { mySlot: null, roomId: null, finished: false, lastSeq: 0, evtCount: 0, teamState: null, boxScore: null, seenPlaying: false });
    Roster.me = null; Roster.names = { p1: 'P1', p2: 'P2' };
}
async function backToLobby() {
    if (S.roomId && socket.connected) await send('leaveRoom');   // server deletes the room, the opponent is told
    resetLocal(); show('lobby');
}
function onRoomClosed(c) {
    if (S.screen === 'lobby' || !S.roomId) return;               // I already left on purpose
    stopTimer(); hidePanels();
    const slotMe = c.slot === S.mySlot;
    if (S.finished) { $('end-note').textContent = '상대가 방을 나갔습니다. 방은 삭제되었습니다.'; return; }   // keep the result on screen
    let msg = { DISCONNECT: '상대의 연결이 끊겨 경기가 종료되었습니다.', LEFT: '상대가 방을 나가 경기가 종료되었습니다.',
        TIMEOUT: slotMe ? '제한 시간(1분) 안에 응답하지 않아 기권패 처리되었습니다.' : '상대가 제한 시간(1분) 안에 응답하지 않아 승리했습니다!' }[c.reason] || '경기가 종료되었습니다.';
    if (c.score && S.seenPlaying) msg += `\n경기 스코어: ${Roster.names.p1} ${c.score.p1} : ${c.score.p2} ${Roster.names.p2}`;
    msg += '\n(방이 삭제되었습니다)';
    $('closed-msg').textContent = msg; $('closed-screen').classList.remove('hidden');
}

/* ---------------- socket wiring ---------------- */
socket.on('connect', () => setConn('🟢 서버 연결됨', '#81c784'));
socket.on('connect_error', (err) => setConn('🟠 서버 연결 실패, 재시도 중... (' + (err && err.message) + ')', '#ffb74d'));
socket.on('disconnect', (reason) => {
    setConn('🔴 서버와 연결이 끊김 (' + reason + ')', '#e57373');
    if (S.roomId && S.screen !== 'lobby' && !S.finished) {
        stopTimer(); hidePanels();
        $('closed-msg').textContent = '서버와의 연결이 끊어져 경기가 종료되었습니다.\n(방이 삭제되었습니다)'; $('closed-screen').classList.remove('hidden');
    }
});
socket.on('roomState', renderRoomState);
socket.on('gameReady', () => { $('room-msg').textContent = '게임을 시작합니다!'; });
socket.on('gameStart', () => { show('draft-screen'); });
socket.on('gameState', ({ state }) => {
    Roster.set(state.teams);
    if (state.status === 'draft') { show('draft-screen'); renderDraft(state); return; }
    if (!S.seenPlaying) {
        S.seenPlaying = true; stopTimer(); show('sim-screen'); setScore(Cur.score.p1, Cur.score.p2);
        $('user-roster').innerHTML = ''; $('cpu-roster').innerHTML = '';
    }
});
socket.on('gameEvent', onGameEvent);
socket.on('actionRequest', onActionRequest);
socket.on('invalidAction', (d) => logLine('🚫 ' + d.error, 'c-fail'));
socket.on('roomClosed', onRoomClosed);
