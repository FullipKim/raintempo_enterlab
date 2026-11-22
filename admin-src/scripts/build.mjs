// 저장소 루트의 admin/ 을 만든다: src/legacy(기존 화면 코드) + src/linear.css + src/backend.js(번들)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
const R = p => fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const out = new URL('../../admin/', import.meta.url); // 저장소 루트/admin
fs.mkdirSync(out, { recursive: true });

let app = R('src/legacy/App.html');
const swap = (a, b, label) => { if (!app.includes(a)) throw new Error('바꿀 곳을 못 찾음: ' + label); app = app.replace(a, b); };
// 1) 서버 호출을 Firebase 어댑터로
swap(`function run(fn, args) {
  return new Promise((resolve, reject) => {
    google.script.run.withSuccessHandler(resolve).withFailureHandler(reject)[fn](...args);
  });
}`, `function run(fn, args) { return window.RTBackend.run(fn, args); }`, 'run');
// 2) 시작: 저장된 토큰 대신 Firebase 로그인 상태
swap(`async function start() {
  const t = store('rt.token');
  if (t) {
    S.token = t;
    try { const r = await run('whoami', [t]); enter(r.user, r.boot); return go('content'); } catch (e) { S.token = null; store('rt.token', null); }
  }
  showLogin();
}`, `async function start() {
  const r = await window.RTBackend.whoami();
  if (r) { S.token = 'firebase'; enter(r.user, r.boot); return go('content'); }
  showLogin();
}`, 'start');
// 3) 나가기: 구글 로그아웃
swap(`$('#logout').onclick = async () => { await flush(); S.token = null; S.user = null; store('rt.token', null); location.reload(); };`,
  `$('#logout').onclick = async () => { await flush(); await window.RTBackend.signOut(); S.token = null; S.user = null; location.reload(); };`, 'logout');
// 4) 이름 머리글자
swap(`$('#who').textContent = user.name + (user.admin ? ' · 관리자' : '');`,
  `$('#who').textContent = user.name + (user.admin ? ' · 관리자' : ''); if ($('#av')) $('#av').textContent = String(user.name || '?').slice(0, 1);`, 'who');
// 5) 문서 상태가 뒤늦게 오면 화면 갱신
swap(`window.RTApp = { S,`, `const onDocState = () => { try { if (S.tab === 'publish' || S.tab === 'write') renderTab(); } catch (e) { } };
window.RTApp = { S, onDocState,`, 'RTApp');
app = app.replace('rgba(246,246,243,.96)', 'rgba(251,251,250,.97)');
// 6) 설정 화면 (관리자)
swap(`return v === 'report' ? reportView() : subsView();`, `return v === 'report' ? reportView() : v === 'settings' ? window.RTSettings.render($('#view')) : subsView();`, 'go settings');
swap(`const sh = $('#open-sheet');`, `if ($('#nav-settings')) $('#nav-settings').hidden = !user.admin;
  const sh = $('#open-sheet');`, 'settings nav');

const index = R('src/legacy/Index.html');
const dialogs = index.slice(index.indexOf('<div class="toast"'), index.indexOf('<script src="https://cdnjs'));
const styles = R('src/legacy/Styles.html').replace('</style>', '') + R('src/linear.css') + '\n</style>';
const ver = Date.now().toString(36);
const html = R('src/admin.html').replace('{{STYLES}}', () => styles).replace('{{DIALOGS}}', () => dialogs)
  .replace('{{PROFILES}}', () => R('src/legacy/Profiles.html')).replace('{{CARDS}}', () => R('src/legacy/Cards.html'))
  .replace('{{APP}}', () => app + '\n<script>' + R('src/settings.js') + '</script>').replace('{{VER}}', ver);
fs.writeFileSync(new URL('index.html', out), html);
execFileSync('npx', ['esbuild', 'src/backend.js', '--bundle', '--format=iife', '--minify', '--target=es2020', '--outfile=../admin/fb.js'],
  { cwd: new URL('..', import.meta.url), stdio: 'inherit' });
console.log('ok', (html.length / 1024).toFixed(0) + 'KB');
