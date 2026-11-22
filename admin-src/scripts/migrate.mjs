// 기존 Apps Script 데이터(내보내기 JSON)를 Firestore rt_ 컬렉션으로 옮긴다.
// 사용:
//   node scripts/migrate.mjs export.json staff-emails.json [--dry]
//   - export.json: Apps Script exportAll 결과 { jobs, bodies, clients, staff, subscribers, manual }
//   - staff-emails.json: { "대표": "raintempoenterlab@gmail.com", "예현": "...@gmail.com" }  (이메일이 없는 직원은 건너뜀)
//   에뮬레이터: FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 GCLOUD_PROJECT=raintempolab node scripts/migrate.mjs ...
//   실제 프로젝트: gcloud auth application-default login 후 GCLOUD_PROJECT=raintempolab
// 같은 ID 로 덮어쓰므로 여러 번 돌려도 된다. --dry 는 쓰지 않고 개수만 보여준다.
import fs from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

const [, , exportPath, emailsPath, flag] = process.argv;
if (!exportPath) { console.error('사용: node scripts/migrate.mjs export.json staff-emails.json [--dry]'); process.exit(1); }
const dry = flag === '--dry' || emailsPath === '--dry';
const X = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
const emails = emailsPath && emailsPath !== '--dry' ? JSON.parse(fs.readFileSync(emailsPath, 'utf8')) : {};

const STATUSES = ['예정', '원고 작성', '이미지 리서치', '디자인 편집', '발행 준비', '발행 완료', '보류'];
const OLD = { '작성 중': '원고 작성', '검수 요청': '이미지 리서치', '수정 필요': '디자인 편집' };
const DONE = ['발행 완료', '보류'];
const KIND = { '시의성': 'event', '아티클': 'article', '프로젝트': 'project' };
const BODY_KEYS = ['brief', 'source', 'releaseAt', 'confirmedAt', 'publishTime', 'blog', 'web', 'webHtml', 'images', 'notes', 'reviewed',
  'designUrl', 'docSyncedAt', 'docVersion', 'extra', 'cards', 'docLinked'];
const bytes = o => Buffer.byteLength(JSON.stringify(o));
const ymd = v => { const m = String(v || '').match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : ''; };
const norm = s => String(s || '').replace(/\s+/g, '').toLowerCase();
const parseId = v => { v = String(v || '').trim(); const m = v.match(/\/folders\/([A-Za-z0-9_-]+)/) || v.match(/\/d\/([A-Za-z0-9_-]+)/) || v.match(/[?&]id=([A-Za-z0-9_-]+)/); return m ? m[1] : v; };

initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'raintempolab' });
const db = getFirestore();
const writes = [];
const put = (col, id, data) => writes.push({ col, id, data });

/* 고객사 */
const clients = (X.clients || []).filter(c => c['고객사']);
clients.forEach((c, i) => {
  const short = String(c['약칭'] || c['고객사']).trim();
  put('rt_clients', short.replace(/[\/]/g, '_'), {
    name: c['고객사'], short, folderId: parseId(c['드라이브폴더ID']), template: c['Canva템플릿'] && c['Canva템플릿'] !== '-' ? c['Canva템플릿'] : '',
    active: c['사용'] !== 'N', order: i,
    rules: { background: c['홈페이지 바탕색'] || '', blog: c['블로그 작성 규칙'] || '', web: c['홈페이지 작성 규칙'] || '',
      design: c['이미지 제작 규칙'] || '', links: c['링크·브랜드 규칙'] || '', sources: c['참고 문서'] || '' }
  });
});
const resolveClients = v => {
  v = String(v || '').trim();
  if (!v || v === '전체') return { all: true, clients: [] };
  return { all: false, clients: v.split(/\s*[,，]\s*/).map(n => clients.find(c => norm(c['고객사']) === norm(n) || norm(c['약칭']) === norm(n))?.['고객사']).filter((n, i, a) => n && a.indexOf(n) === i) };
};

/* 직원: 구글 이메일이 있는 사람만. 접속코드는 옮기지 않는다 */
const staffNames = [], skipped = [];
(X.staff || []).filter(s => s['이름'] && s['사용'] !== 'N').forEach(s => {
  staffNames.push(s['이름']);
  const email = String(emails[s['이름']] || '').trim().toLowerCase();
  if (!email) { skipped.push(s['이름']); return; }
  put('rt_staff', email, { name: s['이름'], admin: s['관리자'] === 'Y', active: true, ...resolveClients(s['담당고객사']) });
});
put('rt_config', 'app', { staffNames, migratedAt: new Date().toISOString() });

/* 일정 + 본문 + 수정 이력 */
const tooBig = [];
(X.jobs || []).filter(r => r.id).forEach(r => {
  if (!ymd(r['발행일'])) { console.log('발행일이 비어 건너뜀:', r.id, r['주제']); return; }
  const status = OLD[r['상태']] || (STATUSES.includes(r['상태']) ? r['상태'] : '예정');
  const body0 = (X.bodies || {})[r.id] || {};
  const body = {}; BODY_KEYS.forEach(k => { if (body0[k] !== undefined) body[k] = body0[k]; });
  let history = Array.isArray(body0.history) ? body0.history.slice(0, 10) : [];
  while (history.length && bytes(history) > 900000) history = history.slice(0, -1);
  if (bytes(body) > 1000000) { tooBig.push(r.id); return; }
  put('rt_jobs', r.id, {
    client: r['고객사'], date: ymd(r['발행일']), title: r['주제'] || '', kind: KIND[r['종류']] || 'basic', owner: r['담당자'] || '', status,
    open: !DONE.includes(status), docUrl: r['문서'] || '', folderUrl: r['폴더'] || '', blogUrl: r['블로그URL'] || '', webUrl: r['홈페이지URL'] || '',
    imageCount: Number(r['이미지수'] || 0), version: Math.max(1, Number(r['버전'] || 1)), updatedBy: r['수정자'] || '', updatedAt: r['수정시각'] || '',
    ex: body.extra || {}, plan: (body.images || []).map(im => ({ type: im.type || '', title: im.title || '', body: im.body || '', alt: im.alt || '' }))
  });
  put('rt_bodies', r.id, body);
  if (history.length) put('rt_history', r.id, { items: history });
});

/* 구독사 (진입코드는 관리자 전용 문서로 분리) */
(X.subscribers || []).forEach((s, i) => {
  if (!s.id) return;
  const { code, _row, _codeHidden, ...rest } = s;
  put('rt_subscribers', s.id, { ...rest, order: i });
  if (code) put('rt_subcodes', s.id, { code });
});

/* 월간 수동 입력 */
Object.entries(X.manual || {}).forEach(([ym, d]) => { if (/^\d{4}-\d{2}$/.test(ym)) put('rt_manual', ym, d); });

const count = writes.reduce((m, w) => (m[w.col] = (m[w.col] || 0) + 1, m), {});
console.log('옮길 문서:', count);
if (skipped.length) console.log('이메일이 없어 건너뛴 직원:', skipped.join(', '));
if (tooBig.length) console.log('1MB 가 넘어 옮기지 못한 글:', tooBig.join(', '));
if (dry) process.exit(0);
for (let i = 0; i < writes.length; i += 400) {
  const batch = db.batch();
  writes.slice(i, i + 400).forEach(w => batch.set(db.collection(w.col).doc(w.id), { ...w.data, ...(w.col === 'rt_jobs' ? { ts: FieldValue.serverTimestamp() } : {}) }));
  await batch.commit();
}
console.log('완료');
