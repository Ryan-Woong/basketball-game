/*
 * Whitelist sanitizers: nothing leaves the server unless it is listed here.
 * New engine fields / event types stay private until added deliberately.
 */
const POSITIONS = ['PG', 'SG', 'SF', 'PF', 'C'];
const STAT_KEYS = ['layup', 'mid', 'pt3', 'inBlk', 'outBlk', 'm2m', 'str', 'drive', 'pass', 'offBall', 'reb', 'ovr'];
const STAT_KEYS_11 = ['pt3', 'mid', 'layup', 'inBlk', 'outBlk', 'm2m', 'str', 'drive', 'pass', 'offBall', 'reb'];
const GAME_STAT_KEYS = ['pts', 'fgm', 'fga', 'fg3m', 'fg3a', 'oreb', 'dreb', 'ast', 'tov', 'stl', 'blk'];

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (max) => (v) => (typeof v === 'string' ? v.slice(0, max) : undefined);
const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const numArr = (v) => (Array.isArray(v) && v.length <= 10 ? v.map(x => (x == null ? null : num(x) ?? null)) : undefined);

function pickKeys(src, spec) {
    const out = {};
    if (!src || typeof src !== 'object') return out;
    for (const k of Object.keys(spec)) {
        const v = spec[k](src[k]);
        if (v !== undefined) out[k] = v;
    }
    return out;
}
const numSpec = (keys) => Object.fromEntries(keys.map(k => [k, num]));

function sanitizePlayer(p) {
    if (!p || typeof p !== 'object') return null;
    const out = pickKeys(p, { id: num, pos: str(2), name: str(20), ...numSpec(STAT_KEYS) });
    out.gameStats = pickKeys(p.gameStats, numSpec(GAME_STAT_KEYS));
    out.buffs = Array.isArray(p.buffs) ? p.buffs.slice(0, 10).map(b => pickKeys(b, { stat: str(10), val: num, duration: num })) : [];
    return out;
}
function sanitizeTeam(team) {
    const out = {};
    for (const pos of POSITIONS) if (team && team[pos]) out[pos] = sanitizePlayer(team[pos]);
    return out;
}

/** Snapshot sent in `gameState`. `raw` is built from engine.getState(). */
function sanitizeSnapshot(raw) {
    return {
        status: str(12)(raw.status) || 'menu',
        quarter: num(raw.quarter) ?? 1,
        possession: num(raw.possession) ?? 0,
        score: { p1: num(raw.score && raw.score.p1) ?? 0, p2: num(raw.score && raw.score.p2) ?? 0 },
        isP1Offense: !!raw.isP1Offense,
        hasPassed: !!raw.hasPassed,
        currentAttackerId: num(raw.currentAttackerId) ?? null,
        currentDefenderId: num(raw.currentDefenderId) ?? null,
        teams: { p1: sanitizeTeam(raw.teams && raw.teams.p1), p2: sanitizeTeam(raw.teams && raw.teams.p2) },
        draftTurn: raw.draftTurn === 'p1' || raw.draftTurn === 'p2' ? raw.draftTurn : null,
        turnTimeoutMs: num(raw.turnTimeoutMs) ?? null,
        draftPool: Array.isArray(raw.draftPool) ? raw.draftPool.slice(0, 40).map(sanitizePlayer).filter(Boolean) : [],
    };
}

const boxEntry = (e) => pickKeys(e, { id: num, pos: str(2), name: str(20), ...numSpec(GAME_STAT_KEYS) });
const keyArr = (v) => (Array.isArray(v) ? v.filter(k => STAT_KEYS_11.includes(k)).slice(0, 11) : undefined);
const statObj = (keys) => (v) => (v && typeof v === 'object' ? pickKeys(v, numSpec(keys)) : undefined);
const teamStateArr = (arr) => (Array.isArray(arr)
    ? arr.slice(0, 5).map(e => pickKeys(e, { id: num, eff: statObj(STAT_KEYS_11), delta: statObj(STAT_KEYS_11), air: keyArr, hot: keyArr, gs: statObj(GAME_STAT_KEYS) }))
    : undefined);
const EVENT_SPECS = {
    LOG: { text: str(1000), cls: str(40) },
    SCORE: { p1: num, p2: num },
    WAITING_FOR_ACTION: { forSlot: str(2), title: str(100), requestId: str(64), timeoutMs: num },
    TEAM_STATE: { p1: teamStateArr, p2: teamStateArr },
    DICE_CONTESTED: { offFinal: num, defFinal: num },
    DICE_SUCCESS: { finalVal: num },
    DICE_ADV: { r1: num, r2: num, finalRoll: num, finalCrit: num },
    VIS_RESET: { isP1Offense: bool, attackerId: num, quarter: num, possession: num },
    VIS_ADVANCE: { attackerId: num, defenderId: num, type: str(20) },
    VIS_HELP: { helperId: num },
    VIS_PASS: { fromId: num, toId: num },
    VIS_PREP_SHOT: { shooterId: num, type: str(20) },
    VIS_SHOT: { shooterId: num, type: str(20), made: bool },
    VIS_REB_POS: { offIds: numArr, defIds: numArr },
    VIS_GRAB: { playerId: num },
    VIS_STEAL: { playerId: num },
    VIS_FAST_BREAK: { playerId: num, isP1Side: bool },
    GAME_END: {
        p1Score: num, p2Score: num,
        boxScore: (b) => (b && typeof b === 'object'
            ? { p1: (Array.isArray(b.p1) ? b.p1 : []).map(boxEntry), p2: (Array.isArray(b.p2) ? b.p2 : []).map(boxEntry) }
            : undefined),
    },
    ENGINE_ERROR: { message: () => 'ENGINE_ERROR' },   // details stay in the server log
};

/** Returns cleaned data, or null if the event type is not whitelisted. */
function sanitizeEvent(type, data) {
    const spec = EVENT_SPECS[type];
    if (!spec) return null;
    const out = pickKeys(data || {}, spec);
    if (type === 'ENGINE_ERROR') out.message = 'ENGINE_ERROR';
    return out;
}

const CLOSE_REASONS = ['DISCONNECT', 'TIMEOUT', 'LEFT'];
/** roomClosed payload: reason + which seat caused it + final-so-far score. */
function sanitizeClosed(reason, slot, score) {
    return {
        reason: CLOSE_REASONS.includes(reason) ? reason : 'DISCONNECT',
        slot: slot === 'p1' || slot === 'p2' ? slot : null,
        score: score ? { p1: num(score.p1) ?? 0, p2: num(score.p2) ?? 0 } : null,
    };
}

module.exports = { sanitizeClosed, sanitizePlayer, sanitizeSnapshot, sanitizeEvent, EVENT_SPECS };
