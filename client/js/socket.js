/* Connection + identity. The page talks to the server only through this socket (client -> server -> client). */
const socket = io();   // same origin as the page: no URL / CORS configuration needed (wss:// automatically on https)

// playerId = secret identity token. Never shown to the opponent. 128-bit random; works on plain http (no randomUUID).
let playerId = localStorage.getItem('bb_playerId');
if (!playerId || !/^[a-f0-9]{32}$/.test(playerId)) {
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    playerId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('bb_playerId', playerId);
}

/** emit with an acknowledgement as a Promise (resolves with the server's ack object). */
function send(event, payload) {
    return new Promise((resolve) => socket.emit(event, payload || {}, (res) => resolve(res || {})));
}
