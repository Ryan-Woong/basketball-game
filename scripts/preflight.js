#!/usr/bin/env node
/*
 * scripts/preflight.js  (npm run preflight)
 * Offline checks that catch the usual reasons a Render deploy / first run fails. Run it before `git push`.
 * Exit code 1 if anything is wrong.
 */
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf-8');
const exists = (f) => fs.existsSync(path.join(root, f));
const readSafe = (f) => (exists(f) ? read(f) : '');   // a missing file must be reported as FAIL, not crash the script
let bad = 0, ok = 0, warned = 0;
const warn = (name, cond, hint) => { if (cond) { ok++; console.log('  OK    ' + name); } else { warned++; console.log('  WARN  ' + name + '\n          -> ' + hint); } };
const check = (name, cond, hint = '') => { if (cond) { ok++; console.log('  OK    ' + name); } else { bad++; console.log('  FAIL  ' + name + (hint ? '\n          -> ' + hint : '')); } };

const pkg = JSON.parse(read('package.json'));
console.log('package.json');
check('start script is "node server.js" (Render Start Command: npm start)', pkg.scripts && pkg.scripts.start === 'node server.js');
check('express and socket.io are runtime dependencies', pkg.dependencies && pkg.dependencies.express && pkg.dependencies['socket.io'], 'they must be in "dependencies", not devDependencies');
check('socket.io-client is a devDependency (only the smoke test needs it)', pkg.devDependencies && pkg.devDependencies['socket.io-client'] && !(pkg.dependencies || {})['socket.io-client']);
check('engines.node is set (Render picks a matching Node version)', pkg.engines && /18|20|22/.test(pkg.engines.node));
warn('package-lock.json exists (run `npm install` once and commit it)', exists('package-lock.json'), 'not fatal for Render, but keeps installs reproducible');

console.log('server');
const srv = readSafe('server.js');
check('server.js binds process.env.PORT', /process\.env\.PORT/.test(srv));
check('server.js binds 0.0.0.0 (Render requirement)', /0\.0\.0\.0/.test(srv));
check('server.js serves GET /healthz', /\/healthz/.test(srv));
check('server.js serves the client folder', /express\.static/.test(srv) && exists('client/index.html'));
check('server.js has no Cloud Run / GCP specific code', !/cloud\s*run|gcloud|K_SERVICE/i.test(srv), 'remove the Cloud Run specific lines from server.js (copy server.js from the latest zip)');
check('no leftover .gcloudignore (Cloud Run file from an older version)', !exists('.gcloudignore'),
    'delete it: Windows cmd `del .gcloudignore` / PowerShell `Remove-Item .gcloudignore` / mac,linux `rm .gcloudignore`. (Copying a new zip over the old folder does not delete files that the new zip no longer contains.)');
for (const f of ['server/socket.js', 'server/room-manager.js', 'server/game-session.js', 'server/validators.js', 'server/sanitize.js', 'server/rate-limiter.js', 'server/game-engine/game.js'])
    check(`${f} exists`, exists(f));

console.log('client');
const html = readSafe('client/index.html');
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(r => !/^(https?:)?\/\//.test(r) && !r.startsWith('/socket.io/'));
check('index.html references only existing local files', refs.length >= 5 && refs.every(r => exists('client/' + r)), 'missing: ' + refs.filter(r => !exists('client/' + r)).join(', '));
check('socket.io client script is loaded from the server (/socket.io/socket.io.js)', /src="\/socket\.io\/socket\.io\.js"/.test(html));
const js = ['socket.js', 'court-ui.js', 'game-ui.js'].map(f => readSafe('client/js/' + f)).join('\n');
check('client connects with io() to its own origin (no hard-coded server URL)', /\bio\(\)/.test(js) && !/localhost|127\.0\.0\.1|onrender\.com|https?:\/\/[a-z0-9.-]+:\d+/i.test(js));
check('client never uses localStorage for anything but its own playerId', (js.match(/localStorage\.(get|set)Item\(([^)]*)\)/g) || []).every(m => m.includes('bb_playerId')));

console.log('repository hygiene');
const gi = exists('.gitignore') ? read('.gitignore') : '';
check('.gitignore excludes node_modules and .env', /node_modules/.test(gi) && /\.env/.test(gi));
check('no node_modules / secrets folder would be pushed', !exists('.env'), 'delete .env or keep it out of git');
const docs = ['README.md', 'PROTOCOL.md', 'DEPLOY.md', 'TESTING.md'];
check('docs present: ' + docs.join(', '), docs.every(exists));

console.log(`\n${ok} ok, ${warned} warnings, ${bad} failed`);
process.exit(bad ? 1 : 0);
