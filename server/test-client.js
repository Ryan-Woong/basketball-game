/*
 * server/test-client.js  (no npm packages needed)
 * Runs the REAL client scripts (client/js/*.js) inside Node against a small stub DOM built from client/index.html,
 * connected to the REAL server logic through the fake socket layer. Two clients play a whole game by clicking
 * the buttons the UI renders. It catches runtime errors, missing element ids, wrong event handling, escaping bugs.
 * It does NOT prove the layout/CSS looks right or that a real browser + real Socket.IO behave the same.
 */
const realSetTimeout = global.setTimeout;
global.setTimeout = (fn) => realSetTimeout(fn, 0);   // accelerate the ENGINE's sleep() only; the client contexts get their own timers below

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const nodeCrypto = require('crypto');
const { registerSocketHandlers } = require('./socket');
const roomManager = require('./room-manager');
const { createFakeIO, createFakeTimers, NEVER_TIMERS } = require('./test-utils/fake-io');

let pass = 0, fail = 0;
const check = (n, c) => { if (c) pass++; else { fail++; console.error('  FAIL:', n); } };
const tick = (ms = 2) => new Promise(r => realSetTimeout(r, ms));
const errors = [];
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && e.stack || e)));
process.on('uncaughtException', (e) => errors.push('uncaughtException: ' + (e && e.stack || e)));

const clientDir = path.join(__dirname, '..', 'client');
const html = fs.readFileSync(path.join(clientDir, 'index.html'), 'utf-8');

// ---------- stub DOM built from index.html (ids + initial classes) ----------
function makeDocument() {
    const reg = new Map(), known = new Map(), missing = [];
    for (const m of html.matchAll(/<(\w+)([^>]*)>/g)) {
        const id = (m[2].match(/\bid="([^"]+)"/) || [])[1]; if (!id) continue;
        known.set(id, ((m[2].match(/\bclass="([^"]*)"/) || [])[1] || '').split(/\s+/).filter(Boolean));
    }
    const mk = (id) => {
        const el = { children: [], style: {}, _cls: new Set(), textContent: '', _html: '', value: '', disabled: false, scrollTop: 0, scrollHeight: 0, onclick: null, _id: id, tag: 'div',
            classList: {
                add: (...c) => c.forEach(x => el._cls.add(x)), remove: (...c) => c.forEach(x => el._cls.delete(x)),
                toggle: (c, f) => { const on = f === undefined ? !el._cls.has(c) : !!f; on ? el._cls.add(c) : el._cls.delete(c); return on; }, contains: (c) => el._cls.has(c),
            },
            appendChild(c) { el.children.push(c); c.parent = el; return c; },
            remove() { if (el.parent) el.parent.children = el.parent.children.filter(x => x !== el); if (el._id) reg.delete(el._id); },
            querySelectorAll(sel) {
                const out = [], isTag = sel === 'button', cls = sel.replace('.', '');
                (function walk(n) { n.children.forEach(ch => { if (isTag ? ch.tag === 'button' : (ch._cls && ch._cls.has(cls))) out.push(ch); walk(ch); }); })(el);
                return out;
            },
            set innerHTML(v) { el._html = v; el.children = []; }, get innerHTML() { return el._html; },
            set className(v) { el._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }, get className() { return [...el._cls].join(' '); },
            set id(v) { el._id = v; reg.set(v, el); }, get id() { return el._id; },
        };
        return el;
    };
    const doc = {
        missing, reg,
        getElementById(id) {
            if (reg.has(id)) return reg.get(id);
            if (known.has(id)) { const e = mk(id); known.get(id).forEach(c => e._cls.add(c)); reg.set(id, e); return e; }
            missing.push(id); return null;
        },
        createElement(tag) { const e = mk(null); e.tag = tag; return e; },
        createTextNode(t) { return { textContent: t, children: [], _cls: new Set() }; },
    };
    return doc;
}

// ---------- one client = vm context + stub DOM + bridge to a fake server socket ----------
function loadClient(srvSocket) {
    const document = makeDocument(), handlers = {}, intervals = [];
    const store = {};
    const bridge = {
        connected: true,
        on(ev, fn) { handlers[ev] = fn; },
        emit(ev, payload, ack) { srvSocket._emitToServer(ev, payload).then(res => { if (typeof ack === 'function') ack(res); }); },
    };
    srvSocket._onEvent = (event, payload) => { if (handlers[event]) handlers[event](payload); };
    const ctx = vm.createContext({
        document, console, Math, Date, JSON, Promise, Array, Object, Number, String, Uint8Array, RegExp, Error,
        io: () => bridge,
        localStorage: { getItem: (k) => store[k] || null, setItem: (k, v) => { store[k] = v; } },
        crypto: { getRandomValues: (a) => nodeCrypto.randomFillSync(a) },
        setTimeout: (fn) => realSetTimeout(fn, 0), setInterval: (fn) => { intervals.push(fn); return intervals.length; },
    });
    for (const f of ['socket.js', 'court-ui.js', 'game-ui.js'])
        vm.runInContext(fs.readFileSync(path.join(clientDir, 'js', f), 'utf-8'), ctx, { filename: f });
    if (handlers.connect) handlers.connect();
    const $ = (id) => document.getElementById(id);
    return {
        ctx, document, handlers, bridge, srv: srvSocket, $,
        run: (code) => vm.runInContext(code, ctx),
        visible: (id) => !$(id)._cls.has('hidden'),
        buttons: (id) => $(id).querySelectorAll('button').filter(b => !b.disabled && b.onclick),
        pulse: () => intervals.forEach(fn => fn()),   // the client's setInterval callbacks (renderCourt, countdown)
        text: (id) => $(id).textContent, html: (id) => $(id).innerHTML,
    };
}

async function untilTrue(fn, label, ms = 60000) {
    const t0 = Date.now();
    while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout waiting for: ' + label); await tick(); }
}

(async () => {
    // ================= full game through both UIs =================
    {
        const { io, connectFakeSocket } = createFakeIO();
        registerSocketHandlers(io, { limits: { capacity: 1e6, refillPerSec: 1e6 }, session: { timers: NEVER_TIMERS } });
        const A = loadClient(connectFakeSocket('cA')), B = loadClient(connectFakeSocket('cB'));
        check('CLI connection banner shows connected', A.text('conn-banner').includes('연결됨') && B.text('conn-banner').includes('연결됨'));
        check('CLI starts on the lobby only', A.visible('lobby') && !A.visible('room-screen') && !A.visible('sim-screen') && !A.visible('closed-screen'));
        check('CLI playerId is 32 hex chars', /^[a-f0-9]{32}$/.test(A.run('playerId')));

        A.$('nickname').value = 'A<i>lice'; B.$('nickname').value = 'Bob';   // HTML in a nickname must never become markup
        await A.run('createRoom()');
        const code = A.text('room-code');
        check('CLI room screen shows a 5-char code after createRoom', A.visible('room-screen') && /^[A-Z2-9]{5}$/.test(code));
        B.$('room-input').value = code.toLowerCase();
        await B.run('joinRoom()'); await tick(5);
        check('CLI joining works with a lowercase code', B.visible('room-screen'));
        check('CLI both see both players, nickname HTML is escaped', A.html('room-players').includes('&lt;i&gt;') && !A.html('room-players').includes('<i>lice') && B.html('room-players').includes('Bob'));
        const badJoin = loadClient(connectFakeSocket('cX')); badJoin.$('room-input').value = 'ZZZZZ'; badJoin.$('nickname').value = 'x';
        await badJoin.run('joinRoom()');
        check('CLI unknown code shows an error on the lobby', badJoin.visible('lobby') && badJoin.text('lobby-msg').includes('방이 없습니다'));

        await A.run('sendReady()'); await B.run('sendReady()'); await tick(5);
        check('CLI both ready -> both on the draft screen', A.visible('draft-screen') && B.visible('draft-screen') && !A.visible('room-screen'));
        check('CLI p1 turn: A has pick buttons, B has none and sees the waiting banner', A.buttons('available-players').length === 20 && B.buttons('available-players').length === 0 && A.text('draft-turn').includes('내 차례') && B.text('draft-turn').includes('고르는 중'));
        A.pulse();
        B.pulse();
        check('CLI draft countdown is shown to both players (60 s)', A.text('draft-timer').includes('60초') && B.text('draft-timer').includes('60초'));
        let sawTimer = false;

        // draft: whoever has buttons clicks the first one
        let picks = 0;
        while (!A.visible('sim-screen')) {
            const who = [A, B].find(c => c.buttons('available-players').length > 0);
            if (!who) { await tick(); continue; }
            who.buttons('available-players')[0].onclick(); picks++;
            await tick(5);
            if (picks > 12) throw new Error('draft did not finish');
        }
        check('CLI draft took exactly 10 picks and both reach the game screen', picks === 10 && B.visible('sim-screen') && !A.visible('draft-screen'));

        // play: click random buttons of whoever is asked
        let clicks = 0;
        const guard = Date.now();
        while (!(A.visible('end-panel') && B.visible('end-panel'))) {
            if (Date.now() - guard > 90000) throw new Error('game did not finish');
            A.pulse(); B.pulse();
            for (const c of [A, B]) {
                const btns = c.buttons('action-buttons');
                if (c.visible('action-panel') && btns.length) {
                    if (!sawTimer && c.text('action-timer').includes('60초')) sawTimer = true;
                    btns[Math.floor(Math.random() * btns.length)].onclick(); clicks++;
                }
            }
            await tick();
        }
        await tick(10); A.pulse(); B.pulse();

        check('CLI no runtime errors in either client or the server', errors.length === 0);
        if (errors.length) console.error(errors.slice(0, 3));
        check('CLI no missing element ids were requested', A.document.missing.length === 0 && B.document.missing.length === 0);
        if (A.document.missing.length) console.error('missing ids:', A.document.missing);
        check('CLI the UI let both players decide during the game', clicks > 40);
        check('CLI own action countdown (60 s) was displayed', sawTimer);
        check('CLI log box is filled for both and identical in length', A.$('log-box').children.length > 200 && A.$('log-box').children.length === B.$('log-box').children.length);
        const logText = (c) => c.$('log-box').children.filter(x => x.tag === 'span').map(x => x.textContent).join('|');
        check('CLI both players got the same log text', logText(A) === logText(B));
        check('CLI nickname with HTML appears as plain text in the log (not markup)', logText(A).includes('A<i>lice 공격 턴 시작'));
        check('CLI dice animation boxes were drawn', A.$('log-box').children.some(x => x.tag === 'div' && /🎲/.test(x.textContent || '')));
        check('CLI score boards agree', A.text('score-board') === B.text('score-board') && /A<i>lice \d+ : \d+ Bob/.test(A.text('score-board')));

        // court
        const plA = A.$('court').querySelectorAll('.pl'), plB = B.$('court').querySelectorAll('.pl');
        check('CLI court shows 10 players for each client', plA.length === 10 && plB.length === 10);
        check('CLI every client sees itself in blue (5 blue / 5 red)', plA.filter(e => e._cls.has('u')).length === 5 && plB.filter(e => e._cls.has('u')).length === 5);
        const mineA = plA.filter(e => e._cls.has('u')).map(e => e.children[1].textContent).sort().join(), mineB = plB.filter(e => !e._cls.has('u')).map(e => e.children[1].textContent).sort().join();
        check('CLI A\'s blue team is B\'s red team (same roster, mirrored view)', mineA === mineB);
        check('CLI players have positions and ball is placed', plA.every(e => /%$/.test(e.style.left) && /%$/.test(e.style.top)) && /%$/.test(A.$('ball').style.left));
        check('CLI status bar shows the quarter / possession / names', /Q[1-4]/.test(A.text('court-status')) && A.text('court-status').includes('남은 Possession') && A.text('court-status').includes('Bob'));
        check('CLI Q4 reached on the status bar', A.text('court-status').includes('Q4'));

        // TEST 13: both screens show the same court situation (each client draws itself in blue attacking right => mirrored x)
        {
            let maxdx = 0, maxdy = 0;
            for (const id of Object.keys(A.run('Roster.byId'))) {
                const pos = (c) => c.run(`(()=>{const q=Vis.pos(Roster.byId[${id}]);return [q.x,q.y]})()`);
                const a = pos(A), b = pos(B);
                maxdx = Math.max(maxdx, Math.abs(a[0] - (100 - b[0]))); maxdy = Math.max(maxdy, Math.abs(a[1] - b[1]));
            }
            check('CLI TEST13 final court positions of all 10 players match between the two screens (mirrored, tolerance 3%)', maxdx <= 3 && maxdy <= 3);
        }
        // modals
        A.run('showAttributes()');
        check('CLI attribute modal: both teams, 11 stat columns, escaped nickname', A.visible('attr-modal') && A.html('attr-content').includes('Bob') && A.html('attr-content').includes('리바운드') && A.html('attr-content').includes('&lt;i&gt;') && (A.html('attr-content').match(/<tr>/g) || []).length >= 12);
        A.run('showBoxScore()');
        const bs = A.html('boxscore-content');
        check('CLI box score modal lists both teams with PTS/FG%/REB columns', A.visible('boxscore-modal') && bs.includes('PTS') && bs.includes('FG%') && bs.includes('REB') && (bs.match(/<tr>/g) || []).length === 12);
        const ptsSum = [...bs.matchAll(/stat-highlight">(\d+)</g)].reduce((s, m) => s + Number(m[1]), 0);
        const sc = A.text('score-board').match(/(\d+) : (\d+)/);
        check('CLI box score points add up to the scoreboard', ptsSum === Number(sc[1]) + Number(sc[2]));
        A.run('closeModals()');
        check('CLI modals close', !A.visible('attr-modal') && !A.visible('boxscore-modal'));

        // end panel
        const ta = A.text('end-title'), tb = B.text('end-title');
        check('CLI end panel: results are consistent (win <-> loss / draw)', (ta.includes('승리') && tb.includes('패배')) || (ta.includes('패배') && tb.includes('승리')) || (ta.includes('무승부') && tb.includes('무승부')));

        // leave after the game: the other player keeps the result on screen
        await A.run('backToLobby()'); await tick(5);
        check('CLI leaving after the game returns to the lobby and resets the UI', A.visible('lobby') && !A.visible('sim-screen') && A.$('log-box').children.length === 0 && A.text('score-board') === '0 : 0');
        check('CLI the other player keeps the result and sees a note (no kick-out)', B.visible('sim-screen') && B.visible('end-panel') && !B.visible('closed-screen') && B.text('end-note').includes('방을 나갔습니다'));
        check('CLI the server room is deleted', roomManager.rooms.size === 0 || [...roomManager.rooms.values()].every(r => r.roomId !== code));
        await B.run('backToLobby()');
        check('CLI both are back in the lobby and can create a new room', B.visible('lobby'));
        A.$('nickname').value = 'Again'; await A.run('createRoom()');
        check('CLI a new room can be created right after', A.visible('room-screen') && /^[A-Z2-9]{5}$/.test(A.text('room-code')));
    }

    // ================= timeout / disconnect screens =================
    {
        roomManager.rooms.clear();
        const timers = createFakeTimers();
        const { io, connectFakeSocket } = createFakeIO();
        registerSocketHandlers(io, { limits: { capacity: 1e6, refillPerSec: 1e6 }, session: { timers } });
        const mkPair = async (tag) => {
            const A = loadClient(connectFakeSocket('tA' + tag)), B = loadClient(connectFakeSocket('tB' + tag));
            A.$('nickname').value = 'Alice'; B.$('nickname').value = 'Bob';
            await A.run('createRoom()'); B.$('room-input').value = A.text('room-code'); await B.run('joinRoom()');
            await A.run('sendReady()'); await B.run('sendReady()'); await tick(5);
            return { A, B };
        };
        // draft timeout: p1 never picks
        {
            const { A, B } = await mkPair('1');
            timers.advance(61000); await tick(5);
            check('TO draft: the idle player (p1) sees the forfeit message', A.visible('closed-screen') && A.text('closed-msg').includes('기권패'));
            check('TO draft: the other player sees the win message', B.visible('closed-screen') && B.text('closed-msg').includes('승리했습니다'));
            check('TO draft: the server deleted the room', roomManager.rooms.size === 0);
            await A.run('backToLobby()'); await B.run('backToLobby()');
            check('TO draft: both can go back to the lobby', A.visible('lobby') && B.visible('lobby') && !A.visible('closed-screen'));
        }
        // disconnect while drafting
        {
            const { A, B } = await mkPair('2');
            await B.srv._emitToServer('disconnect'); await tick(5);
            check('DC draft: the remaining player is told the connection dropped and the room is deleted', A.visible('closed-screen') && A.text('closed-msg').includes('연결이 끊겨') && A.text('closed-msg').includes('방이 삭제') && roomManager.rooms.size === 0);
            await A.run('backToLobby()');
            check('DC draft: back to the lobby', A.visible('lobby'));
        }
        // timeout in the middle of the game: nobody answers the first request
        {
            const { A, B } = await mkPair('3');
            while (!A.visible('sim-screen')) {
                const who = [A, B].find(c => c.buttons('available-players').length > 0);
                if (who) who.buttons('available-players')[0].onclick();
                await tick(5);
            }
            await untilTrue(() => A.visible('action-panel') || A.visible('wait-panel') || B.visible('action-panel') || B.visible('wait-panel'), 'first decision');
            const asked = A.visible('action-panel') ? A : B, waiting = asked === A ? B : A;
            check('TO game: the asked player sees buttons, the other sees the waiting panel', asked.buttons('action-buttons').length > 0 && waiting.visible('wait-panel') && waiting.text('wait-text').includes('기다리는 중'));
            waiting.pulse(); asked.pulse();
            check('TO game: both show the 60 s countdown', asked.text('action-timer').includes('60초') && waiting.text('wait-timer').includes('60초'));
            timers.advance(61000); await tick(5);
            check('TO game: forfeit screens (loser / winner) with the score so far', asked.visible('closed-screen') && asked.text('closed-msg').includes('기권패') && waiting.text('closed-msg').includes('승리했습니다') && waiting.text('closed-msg').includes('경기 스코어'));
            check('TO game: panels are hidden after the forfeit', !asked.visible('action-panel') && !waiting.visible('wait-panel'));
        }
        // the client's own connection to the server drops mid-game
        {
            const { A, B } = await mkPair('4');
            while (!A.visible('sim-screen')) {
                const who = [A, B].find(c => c.buttons('available-players').length > 0);
                if (who) who.buttons('available-players')[0].onclick();
                await tick(5);
            }
            A.handlers.disconnect('transport close');
            check('DC client: my own connection loss shows the overlay and the banner turns red', A.visible('closed-screen') && A.text('closed-msg').includes('연결이 끊어져') && A.text('conn-banner').includes('끊김'));
        }
    }

    check('CLI no runtime errors anywhere (including timeout / disconnect scenarios)', errors.length === 0);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('aborted:', e); process.exit(1); });
