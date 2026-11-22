/* 레인템포랩 어드민 · Firebase 연결
 * 기존 Apps Script 화면 코드(App)는 run(fn, args) 한 곳으로만 서버를 부른다.
 * 여기서 같은 이름의 함수를 Firestore(데이터)와 Cloud Functions(드라이브·문서)로 바꿔 준다.
 * args[0] 은 예전 로그인 토큰 자리라 쓰지 않는다. */
import { initializeApp } from 'firebase/app';
import { getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged, connectAuthEmulator } from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, getDocs, setDoc, deleteDoc, collection, query, where,
  runTransaction, writeBatch, serverTimestamp
} from 'firebase/firestore/lite';
import { getFunctions, httpsCallable, connectFunctionsEmulator } from 'firebase/functions';
import { CONFIG } from './config.js';

const app = initializeApp(CONFIG.firebase);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, CONFIG.region);
if (CONFIG.emulator) {
  connectAuthEmulator(auth, `http://${CONFIG.emulator}:9099`, { disableWarnings: true });
  connectFirestoreEmulator(db, CONFIG.emulator, 8080);
  connectFunctionsEmulator(fns, CONFIG.emulator, 5001);
}

export const STATUSES = ['예정', '원고 작성', '이미지 리서치', '디자인 편집', '발행 준비', '발행 완료', '보류'];
const OLD_STATUS = { '작성 중': '원고 작성', '검수 요청': '이미지 리서치', '수정 필요': '디자인 편집' };
const DONE = ['발행 완료', '보류'];
const META_KEYS = ['title', 'date', 'kind', 'owner', 'status', 'blogUrl', 'webUrl', 'folderUrl'];
export const BODY_KEYS = ['brief', 'source', 'releaseAt', 'confirmedAt', 'publishTime', 'blog', 'web', 'webHtml', 'images', 'notes', 'reviewed',
  'designUrl', 'docSyncedAt', 'docVersion', 'extra', 'cards', 'docLinked'];
const MAX_BODY_BYTES = 950000, MAX_HISTORY_BYTES = 900000;

const C = { jobs: 'rt_jobs', bodies: 'rt_bodies', history: 'rt_history', clients: 'rt_clients', staff: 'rt_staff', config: 'rt_config',
  subs: 'rt_subscribers', subcodes: 'rt_subcodes', manual: 'rt_manual' };

const fail = m => { throw new Error(m); };
const bytes = o => new TextEncoder().encode(JSON.stringify(o)).length;
export const kstDate = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 10);
const kstStamp = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
const uid13 = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).slice(0, 13);

/* ── 로그인 상태 ── */
let ME = null; // { email, user:{name,admin,clients,all}, clientList }
const authReady = new Promise(res => { const off = onAuthStateChanged(auth, () => { off(); res(); }); });

async function loadMe() {
  const u = auth.currentUser; if (!u) return null;
  const email = String(u.email || '').toLowerCase();
  const s = await getDoc(doc(db, C.staff, email)).catch(() => null);
  if (!s || !s.exists() || s.data().active === false) {
    await signOut(auth);
    fail(`${email} 계정은 등록된 직원이 아닙니다. 대표님께 등록을 요청해주세요.`);
  }
  const st = s.data();
  const all = (await getDocs(collection(db, C.clients))).docs.map(d => ({ id: d.id, ...d.data() }))
    .filter(c => c.active !== false).sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  const names = st.all ? all.map(c => c.name) : (st.clients || []).filter(n => all.some(c => c.name === n));
  ME = { email, user: { name: st.name || email, admin: !!st.admin, clients: names, all: !!st.all }, clientList: all };
  return ME;
}

async function boot() {
  const cfg = await getDoc(doc(db, C.config, 'app')).catch(() => null);
  const staffNames = (cfg && cfg.exists() && cfg.data().staffNames) || [ME.user.name];
  return {
    clients: ME.clientList.filter(c => ME.user.clients.includes(c.name))
      .map(c => ({ name: c.name, short: c.short, template: c.template || '', rules: c.rules || {} })),
    staff: staffNames, statuses: STATUSES, today: kstDate(), sheetUrl: ''
  };
}

function canSee(client) { if (!ME || !ME.user.clients.includes(client)) fail('이 고객사에 대한 권한이 없습니다.'); }
const normJob = (id, d) => ({
  id, client: d.client, date: d.date, title: d.title || '', kind: d.kind || 'basic', owner: d.owner || '',
  status: OLD_STATUS[d.status] || d.status || '예정', docUrl: d.docUrl || '', folderUrl: d.folderUrl || '', blogUrl: d.blogUrl || '',
  webUrl: d.webUrl || '', imageCount: Number(d.imageCount || 0), version: Number(d.version || 0), updatedBy: d.updatedBy || '', updatedAt: d.updatedAt || ''
});

/* 고객사 'in' 조회는 30개까지. 넘으면 나눠 부른다 */
async function jobsWhere(...conds) {
  const col = collection(db, C.jobs);
  if (ME.user.all) return (await getDocs(query(col, ...conds))).docs;
  const out = [], list = ME.user.clients;
  for (let i = 0; i < list.length; i += 30) out.push(...(await getDocs(query(col, where('client', 'in', list.slice(i, i + 30)), ...conds))).docs);
  return out;
}

/* 드라이브 쪽 상태 (Cloud Functions). 실패해도 화면은 열리게 */
const callable = name => httpsCallable(fns, name, { timeout: 120000 });
async function call(name, data) {
  try { return (await callable(name)(data)).data; }
  catch (e) {
    const m = String(e && (e.message || e)).replace(/^FirebaseError:\s*/, '').replace(/\s*\[\d+\]\s*$/, '');
    fail(/not-found|internal/i.test(e?.code || '') && /not found|NOT_FOUND/i.test(m) ? '드라이브 연결 기능이 아직 배포되지 않았습니다.' : m);
  }
}

/* ── 함수별 구현 ── */
const H = {
  async login() {
    await signInWithPopup(auth, new GoogleAuthProvider());
    await loadMe();
    return { token: 'firebase', user: ME.user, boot: await boot() };
  },
  async whoami() {
    if (!ME) await loadMe();
    if (!ME) fail('SESSION_EXPIRED');
    return { user: ME.user, boot: await boot() };
  },

  async listJobs(month) {
    const today = kstDate(), list = [];
    const seen = new Set();
    const push = d => { if (seen.has(d.id)) return; seen.add(d.id); list.push(normJob(d.id, d.data())); };
    if (month) {
      (await jobsWhere(where('date', '>=', month + '-01'), where('date', '<=', month + '-31'))).forEach(push);
      (await jobsWhere(where('open', '==', true))).forEach(d => { if (d.data().date < today) push(d); });
    } else (await jobsWhere()).forEach(push);
    return list;
  },

  async createJobs(items) {
    if (!Array.isArray(items) || !items.length || items.length > 120) fail('등록할 일정을 1~120개로 입력해주세요.');
    const batch = writeBatch(db), out = [];
    items.forEach(it => {
      canSee(it.client);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(it.date || '')) fail('발행일 형식이 맞지 않습니다: ' + it.date);
      const job = { id: uid13(), client: it.client, date: it.date, title: String(it.title || '').slice(0, 200),
        kind: ['event', 'article', 'project'].includes(it.kind) ? it.kind : 'basic', owner: it.owner || '', status: '예정', version: 1 };
      const { id, ...data } = job;
      batch.set(doc(db, C.jobs, id), { ...data, open: true, imageCount: 0, updatedBy: ME.user.name, updatedAt: kstStamp(), ts: serverTimestamp() });
      batch.set(doc(db, C.bodies, id), {});
      out.push(job);
    });
    await batch.commit();
    return out;
  },

  async getJob(id) {
    const [j, b, h] = await Promise.all([getDoc(doc(db, C.jobs, id)), getDoc(doc(db, C.bodies, id)), getDoc(doc(db, C.history, id)).catch(() => null)]);
    if (!j.exists()) fail('작업을 찾을 수 없습니다. 지워졌는지 확인해주세요.');
    const job = normJob(id, j.data()); canSee(job.client);
    job.body = b.exists() ? b.data() : {};
    if (h && h.exists()) job.body.history = h.data().items || [];
    job.docState = localDocState(job);
    if (job.docUrl) call('docState', { id }).then(s => { if (window.RTApp?.S?.job?.id === id) { window.RTApp.S.job.docState = s; window.RTApp.onDocState?.(s); } }).catch(() => { });
    return job;
  },

  async saveJob(id, patch, version) {
    patch = patch || {};
    const jref = doc(db, C.jobs, id), bref = doc(db, C.bodies, id);
    const bodyPatch = {}; BODY_KEYS.forEach(k => { if (patch[k] !== undefined) bodyPatch[k] = patch[k]; });
    let history = Array.isArray(patch.history) ? patch.history.slice(0, 10) : null;
    if (history) while (history.length > 1 && bytes(history) > MAX_HISTORY_BYTES) history = history.slice(0, -1);
    const res = await runTransaction(db, async tx => {
      const snap = await tx.get(jref);
      if (!snap.exists()) fail('작업을 찾을 수 없습니다.');
      const cur = snap.data(); canSee(cur.client);
      if (Number(version) !== Number(cur.version || 0)) return { conflict: true, version: cur.version, updatedBy: cur.updatedBy, updatedAt: cur.updatedAt };
      const meta = {};
      META_KEYS.forEach(k => { if (patch[k] !== undefined) meta[k] = String(patch[k]); });
      let status = meta.status ?? cur.status;
      if (OLD_STATUS[status]) status = OLD_STATUS[status];
      if (!STATUSES.includes(status)) status = '원고 작성';
      const date = meta.date ?? cur.date;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('발행일 형식이 맞지 않습니다.');
      if (bytes(bodyPatch) > MAX_BODY_BYTES) fail('원고 용량이 너무 큽니다. HTML 길이나 이미지 계획을 확인해주세요.');
      const next = { ...meta, status, open: !DONE.includes(status), version: Number(cur.version || 0) + 1, updatedBy: ME.user.name, updatedAt: kstStamp(), ts: serverTimestamp() };
      /* 슬러그 중복 검사·Canva 대량 제작용으로 extra·이미지 계획을 목록 문서에도 둔다 */
      if (bodyPatch.extra !== undefined) next.ex = bodyPatch.extra || {};
      if (bodyPatch.images !== undefined) next.plan = (bodyPatch.images || []).map(im => ({ type: im.type || '', title: im.title || '', body: im.body || '', alt: im.alt || '' }));
      tx.update(jref, next);
      if (Object.keys(bodyPatch).length) tx.set(bref, bodyPatch, { merge: true });
      if (history) tx.set(doc(db, C.history, id), { items: history });
      return { ok: true, version: next.version, updatedAt: next.updatedAt, status, cur: { ...cur, ...next } };
    });
    if (res.conflict) return res;
    if (patch.status === '발행 완료') call('markPublished', { id }).catch(() => { });
    const job = normJob(id, res.cur);
    return { ok: true, version: res.version, updatedAt: res.updatedAt, docState: localDocState(job, { ...(window.RTApp?.S?.job?.body || {}), ...bodyPatch }) };
  },

  async deleteJob(id) {
    if (!ME.user.admin) fail('삭제는 관리자만 할 수 있습니다.');
    const batch = writeBatch(db);
    [C.jobs, C.bodies, C.history].forEach(c => batch.delete(doc(db, c, id)));
    await batch.commit();
    return true;
  },

  async listMeta(client, month) {
    if (client) canSee(client);
    const conds = month ? [where('date', '>=', month + '-01'), where('date', '<=', month + '-31')] : [];
    let docs = await jobsWhere(...conds);
    if (client) docs = docs.filter(d => d.data().client === client);
    if (docs.length > 400) fail('글이 너무 많습니다. 고객사나 월을 골라주세요.');
    return docs.map(d => { const j = normJob(d.id, d.data()); return { id: j.id, client: j.client, date: j.date, title: j.title, status: j.status, owner: j.owner, version: j.version, blogUrl: j.blogUrl, webUrl: j.webUrl, extra: d.data().ex || {} }; })
      .sort((a, b) => a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
  },

  async exportImagePlan(client, month) {
    canSee(client);
    const docs = (await jobsWhere(where('date', '>=', month + '-01'), where('date', '<=', month + '-31'))).filter(d => d.data().client === client)
      .sort((a, b) => a.data().date < b.data().date ? -1 : 1);
    const out = [];
    docs.forEach(d => { const j = d.data(); (j.plan || []).forEach((im, i) => out.push({ date: j.date, topic: j.title, n: i + 1, ...im })); });
    return out;
  },

  /* 구독사 · 진입코드는 관리자만 읽는 문서에 따로 둔다 */
  async listSubscribers() {
    const subs = (await getDocs(collection(db, C.subs))).docs.map(d => ({ id: d.id, ...d.data() }));
    if (ME.user.admin) {
      const codes = Object.fromEntries((await getDocs(collection(db, C.subcodes))).docs.map(d => [d.id, d.data().code]));
      subs.forEach(s => { s.code = codes[s.id] || ''; });
    } else subs.forEach(s => { s.code = ''; s._codeHidden = true; });
    return subs.sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
  },
  async saveSubscriber(sub) {
    const { code, _codeHidden, _row, ...rest } = sub || {};
    if (!rest.name) fail('구독사 이름을 입력해주세요.');
    const id = rest.id || ('sub' + Date.now().toString(36));
    const ref = doc(db, C.subs, id), exists = (await getDoc(ref)).exists();
    await setDoc(ref, { ...rest, id }, { merge: true });
    let out = code || '';
    if (ME.user.admin && code) await setDoc(doc(db, C.subcodes, id), { code });
    else if (!exists) {
      const letters = String(rest.name).replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4) || 'RTSB';
      out = letters + '-' + (1000 + Math.floor(Math.random() * 9000));
      await setDoc(doc(db, C.subcodes, id), { code: out });
    }
    return { ...rest, id, code: ME.user.admin ? out : '' };
  },
  async deleteSubscriber(id) {
    if (!ME.user.admin) fail('삭제는 관리자만 할 수 있습니다. 운영을 멈추려면 상태를 일시중지로 바꿔주세요.');
    const batch = writeBatch(db); batch.delete(doc(db, C.subs, id)); batch.delete(doc(db, C.subcodes, id)); await batch.commit();
    return true;
  },

  /* 월간 보고 수동 입력 · 칸 단위 저장 */
  async getManual(ym) {
    if (!/^\d{4}-\d{2}$/.test(ym || '')) fail('월 형식이 맞지 않습니다.');
    const s = await getDoc(doc(db, C.manual, ym));
    if (!s.exists()) return { month: ym, _meta: null };
    const d = s.data(); const { _updatedAt, _updatedBy, ...data } = d;
    return { ...data, month: ym, _meta: { updatedAt: _updatedAt || '', updatedBy: _updatedBy || '' } };
  },
  async saveManual(ym, patches) {
    if (!/^\d{4}-\d{2}$/.test(ym || '')) fail('월 형식이 맞지 않습니다.');
    const allowed = ['naver_search', 'naver_blog', 'instagram', 'conversions', 'comments', 'plan_links', 'visitors'];
    const ref = doc(db, C.manual, ym);
    await runTransaction(db, async tx => {
      const s = await tx.get(ref), data = s.exists() ? s.data() : { month: ym };
      (patches || []).forEach(p => {
        const path = p.path || [];
        if (!allowed.includes(path[0]) || path.length < 2 || path.length > 3) return;
        let node = data; for (let i = 0; i < path.length - 1; i++) { node[path[i]] = node[path[i]] || {}; node = node[path[i]]; }
        const last = path[path.length - 1];
        if (p.value === null || p.value === '') delete node[last]; else node[last] = p.value;
      });
      data._updatedBy = ME.user.name; data._updatedAt = kstStamp().slice(5);
      tx.set(ref, data);
    });
    return { ok: true, at: kstStamp().slice(11) };
  },

  /* ── 드라이브·구글 문서 (Cloud Functions) ── */
  syncDoc: (id, version, webCode, force) => call('syncDoc', { id, version, webCode, force: !!force }),
  linkDoc: (id, url, version) => call('linkDoc', { id, url, version }),
  unlinkDoc: (id, version) => call('unlinkDoc', { id, version }),
  pullDoc: id => call('pullDoc', { id }),
  listImages: id => call('listImages', { id }),
  getImage: (id, fileId, thumb) => call('getImage', { id, fileId, thumb: !!thumb }),
  uploadImage: (id, n, mime, data, name) => call('uploadImage', { id, n, mime, data, name }),
  reorderImages: (id, order) => call('reorderImages', { id, order }),
  listCardPhotos: id => call('listCardPhotos', { id }),
  getCardPhoto: (id, fileId) => call('getCardPhoto', { id, fileId }),
  uploadCardPhoto: (id, n, mime, data) => call('uploadCardPhoto', { id, n, mime, data }),
  removeCardPhoto: (id, n) => call('removeCardPhoto', { id, n })
};

/* 서버에 묻기 전 화면용 문서 상태 (수정 시각 비교는 docState 함수가 채운다) */
function localDocState(job, body) {
  body = body || job.body || {};
  if (!job.docUrl) return { exists: false };
  return { exists: true, url: job.docUrl, linked: !!body.docLinked, name: '', syncedVersion: body.docVersion || 0, editedInDocs: false, modifiedAt: '' };
}

/* 설정 화면(관리자): 고객사 · 직원 · API 키 */
const ADMIN = {
  async clients() { return (await getDocs(collection(db, C.clients))).docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (a.order ?? 99) - (b.order ?? 99)); },
  async saveClient(c) {
    if (!c.name || !c.short) fail('고객사 이름과 약칭을 입력해주세요.');
    const id = c.id || String(c.short).trim().replace(/[\/]/g, '_');
    const { id: _, ...data } = c;
    await setDoc(doc(db, C.clients, id), { ...data, folderId: String(data.folderId || '').replace(/.*\/folders\/([A-Za-z0-9_-]+).*/, '$1').trim() }, { merge: true });
    await loadMe(); return id;
  },
  async staff() { return (await getDocs(collection(db, C.staff))).docs.map(d => ({ email: d.id, ...d.data() })); },
  async saveStaff(s) {
    const email = String(s.email || '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('구글 계정 이메일을 정확히 입력해주세요.');
    if (!s.name) fail('이름을 입력해주세요.');
    await setDoc(doc(db, C.staff, email), { name: s.name, admin: !!s.admin, active: s.active !== false, all: !!s.all, clients: s.all ? [] : (s.clients || []) });
    await ADMIN.syncNames(); return email;
  },
  async deleteStaff(email) {
    if (String(email).toLowerCase() === ME.email) fail('내 계정은 지울 수 없습니다.');
    await deleteDoc(doc(db, C.staff, email)); await ADMIN.syncNames();
  },
  async syncNames() { const names = (await ADMIN.staff()).filter(s => s.active !== false).map(s => s.name); await setDoc(doc(db, C.config, 'app'), { staffNames: names }, { merge: true }); },
  async keys() { return (await getDocs(collection(db, 'rt_apikeys'))).docs.map(d => ({ id: d.id, ...d.data() })); },
  async createKey(k) {
    if (!k.name) fail('이름을 입력해주세요.');
    const raw = 'rt_' + [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw)))].map(b => b.toString(16).padStart(2, '0')).join('');
    await setDoc(doc(db, 'rt_apikeys', hash), { name: k.name, scopes: k.scopes || ['jobs'], all: !!k.all, clients: k.all ? [] : (k.clients || []), active: true, createdBy: ME.user.name, createdAt: kstStamp(), tail: raw.slice(-4) });
    return raw;
  },
  async revokeKey(id) { await deleteDoc(doc(db, 'rt_apikeys', id)); },
  me: () => ME
};

window.RTBackend = {
  admin: ADMIN,
  ready: authReady,
  async run(fn, args) {
    await authReady;
    const h = H[fn]; if (!h) fail('알 수 없는 요청: ' + fn);
    const rest = fn === 'login' ? [] : args.slice(1);
    if (fn !== 'login' && fn !== 'whoami' && !ME) { if (!auth.currentUser) fail('SESSION_EXPIRED'); await loadMe(); }
    try { return await h(...rest); }
    catch (e) {
      if (e && e.code === 'permission-denied') fail('권한이 없습니다. 담당 고객사가 아니거나 등록되지 않은 계정입니다.');
      if (e && e.code === 'unavailable') fail('인터넷 연결을 확인해주세요.');
      throw e;
    }
  },
  async whoami() { await authReady; if (!auth.currentUser) return null; try { return await H.whoami(); } catch (e) { return null; } },
  async signOut() { ME = null; await signOut(auth); },
  _debug: { db, auth }
};
