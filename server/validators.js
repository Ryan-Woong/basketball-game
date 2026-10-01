/*
 * Pure input validation. No side effects, no socket/engine access.
 * Client input is untrusted: every field is type-checked and length-limited here.
 * Error codes are the ones documented in PROTOCOL.md.
 */
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;      // secret identity token (client generates 128-bit random hex)
const ROOM_ID_RE = /^[A-HJ-NP-Z2-9]{5}$/;            // same alphabet as room-manager.generateRoomId
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CHOICE_RE = /^[A-Za-z0-9_-]{1,32}$/;           // engine option ids are short ascii strings
const MAX_NICK = 20;

const isStr = (v) => typeof v === 'string';

function normalizeNickname(v) {
    if (!isStr(v)) return null;
    const s = v.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim().slice(0, MAX_NICK);
    return s || null;
}
function normalizeRoomId(v) {
    if (!isStr(v)) return null;
    const s = v.trim().toUpperCase();
    return ROOM_ID_RE.test(s) ? s : null;
}
const isValidPlayerId = (v) => isStr(v) && PLAYER_ID_RE.test(v);

function validateCreate(p) {
    const nickname = normalizeNickname(p.nickname);
    if (!isValidPlayerId(p.playerId) || !nickname) return { error: 'INVALID_PAYLOAD' };
    return { playerId: p.playerId, nickname };
}
function validateJoin(p) {
    const nickname = normalizeNickname(p.nickname);
    if (!isValidPlayerId(p.playerId) || !nickname || !isStr(p.roomId)) return { error: 'INVALID_PAYLOAD' };
    const roomId = normalizeRoomId(p.roomId);
    if (!roomId) return { error: 'ROOM_NOT_FOUND' };   // malformed code looks like an unknown room (no extra info)
    return { playerId: p.playerId, nickname, roomId };
}

/** Draft pick check (players alternate). Order of errors matches PROTOCOL.md. */
function checkDraftPick({ started, slot, status, turnSlot, pickId, pool, team }) {
    if (!started) return { error: 'NO_GAME' };
    if (slot !== 'p1' && slot !== 'p2') return { error: 'NOT_YOUR_SEAT' };
    if (status !== 'draft') return { error: 'NOT_DRAFTING' };
    if (slot !== turnSlot) return { error: 'NOT_YOUR_TURN' };
    const ok = (typeof pickId === 'number' && Number.isInteger(pickId)) || (isStr(pickId) && /^\d{1,6}$/.test(pickId));
    if (!ok) return { error: 'INVALID_PICK' };
    const id = Number(pickId);
    const cand = pool.find(p => p.id === id);
    if (!cand) return { error: 'INVALID_PICK' };
    if (team[cand.pos]) return { error: 'POSITION_FILLED' };
    return { id, cand };
}

/** Action response check against the single pending server request. */
function checkAction({ started, pending, slot, requestId, choice }) {
    if (!started) return { error: 'NO_GAME' };
    if (!pending) return { error: 'NO_PENDING_REQUEST' };
    if (slot !== pending.forSlot) return { error: 'NOT_YOUR_SEAT' };
    if (!isStr(requestId) || !REQUEST_ID_RE.test(requestId) || requestId !== pending.requestId) return { error: 'STALE_REQUEST' };
    if (!(isStr(choice) && CHOICE_RE.test(choice))) return { error: 'INVALID_CHOICE' };
    const option = pending.options.find(o => String(o.id) === choice);
    if (!option) return { error: 'INVALID_CHOICE' };
    return { option };
}

module.exports = { isValidPlayerId, normalizeNickname, normalizeRoomId, validateCreate, validateJoin, checkDraftPick, checkAction };
