/* 레인템포랩 어드민 · Cloud Functions
 * 드라이브·구글 문서 작업 (예전 Apps Script Code.gs 의 폴더·문서·이미지 부분)과 외부 연동 API.
 * 드라이브는 대표 구글 계정의 OAuth 토큰(비밀 RT_GOOGLE_OAUTH)으로 다룬다.
 *  - 서비스 계정은 개인 드라이브에 파일을 만들 저장 용량이 없어서 쓰지 않는다.
 * 데이터는 Firestore rt_ 컬렉션. 권한은 rt_staff/{이메일} 로 확인한다. */
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { defineSecret } from 'firebase-functions/params';
import { setGlobalOptions } from 'firebase-functions/v2';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { google } from 'googleapis';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';

setGlobalOptions({ region: 'asia-northeast3', maxInstances: 5, memory: '512MiB', timeoutSeconds: 120 });
initializeApp();
const db = getFirestore();
const OAUTH = defineSecret('RT_GOOGLE_OAUTH'); // {"client_id","client_secret","refresh_token"}
const MAX_IMAGES = 30, MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const FOLDER = 'application/vnd.google-apps.folder', GDOC = 'application/vnd.google-apps.document';

const fail = (m, code = 'failed-precondition') => { throw new HttpsError(code, m); };
const kst = (d = new Date()) => new Date(d.getTime() + 9 * 3600e3).toISOString();
const kstStamp = d => kst(d).slice(0, 16).replace('T', ' ');
const parseId = v => { v = String(v || '').trim(); const m = v.match(/\/folders\/([A-Za-z0-9_-]+)/) || v.match(/\/d\/([A-Za-z0-9_-]+)/) || v.match(/[?&]id=([A-Za-z0-9_-]+)/); return m ? m[1] : v; };
const q = s => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/* ── 구글 API (대표 계정) ── */
let G = null;
function google_() {
  if (G) return G;
  let c; try { c = JSON.parse(OAUTH.value()); } catch (e) { fail('드라이브 연결 정보(RT_GOOGLE_OAUTH)가 설정되지 않았습니다.'); }
  const auth = new google.auth.OAuth2(c.client_id, c.client_secret);
  auth.setCredentials({ refresh_token: c.refresh_token });
  G = { auth, drive: google.drive({ version: 'v3', auth }), docs: google.docs({ version: 'v1', auth }) };
  return G;
}
const drive = () => google_().drive;
const docsApi = () => google_().docs;

/* ── 권한 ── */
async function staffOf(req) {
  const email = String(req.auth?.token?.email || '').toLowerCase();
  if (!email || req.auth.token.email_verified !== true) fail('로그인이 필요합니다.', 'unauthenticated');
  const s = await db.doc(`rt_staff/${email}`).get();
  if (!s.exists || s.data().active === false) fail('등록된 직원이 아닙니다.', 'permission-denied');
  return { email, ...s.data() };
}
async function jobFor(req, id) {
  const user = await staffOf(req);
  const snap = await db.doc(`rt_jobs/${id}`).get();
  if (!snap.exists) fail('작업을 찾을 수 없습니다.', 'not-found');
  const job = { id, ...snap.data() };
  if (!user.all && !(user.clients || []).includes(job.client)) fail('이 고객사에 대한 권한이 없습니다.', 'permission-denied');
  return { user, job };
}
async function clientByName(name) {
  const s = await db.collection('rt_clients').where('name', '==', name).limit(1).get();
  if (s.empty) fail('등록되지 않은 고객사입니다: ' + name);
  return s.docs[0].data();
}
const bodyOf = async id => { const s = await db.doc(`rt_bodies/${id}`).get(); return s.exists ? s.data() : {}; };

/* ── 드라이브 폴더 (예전 dayFolder_ 와 같은 규칙) ── */
const isDateFolder = n => /^(\d{6}|\d{8})(\s|$)/.test(String(n));
async function listChildren(parentId, extra = '') {
  const out = []; let pageToken;
  do {
    const r = await drive().files.list({ q: `'${parentId}' in parents and trashed = false${extra}`, fields: 'nextPageToken, files(id,name,mimeType,modifiedTime,size,description,thumbnailLink)', pageSize: 200, pageToken, supportsAllDrives: true, includeItemsFromAllDrives: true });
    out.push(...r.data.files); pageToken = r.data.nextPageToken;
  } while (pageToken);
  return out;
}
async function childFolder(parentId, date, create) {
  const long = date.replace(/-/g, ''), short = long.slice(2);
  const folders = await listChildren(parentId, ` and mimeType = '${FOLDER}'`);
  const hit = folders.find(f => [long, short].some(k => f.name === k || f.name.startsWith(k + ' ')));
  if (hit) return hit;
  if (!create) return null;
  const shortStyle = folders.some(f => /^\d{6}(\s|$)/.test(f.name));
  return (await drive().files.create({ requestBody: { name: shortStyle ? short : long, mimeType: FOLDER, parents: [parentId] }, fields: 'id,name', supportsAllDrives: true })).data;
}
async function dayFolder(job, create) {
  if (job.folderUrl) { try { return (await drive().files.get({ fileId: parseId(job.folderUrl), fields: 'id,name', supportsAllDrives: true })).data; } catch (e) { } }
  if (job.docUrl) {
    let parent = null;
    try { const f = (await drive().files.get({ fileId: parseId(job.docUrl), fields: 'parents', supportsAllDrives: true })).data; if (f.parents?.[0]) parent = (await drive().files.get({ fileId: f.parents[0], fields: 'id,name', supportsAllDrives: true })).data; } catch (e) { }
    if (parent) return isDateFolder(parent.name) ? parent : childFolder(parent.id, job.date, create);
  }
  const c = await clientByName(job.client);
  if (!c.folderId) fail('고객사 설정에 드라이브 폴더를 넣거나, 이 작업에 저장 폴더 링크를 넣어주세요: ' + job.client);
  return childFolder(c.folderId, job.date, create);
}
const folderUrl = f => `https://drive.google.com/drive/folders/${f.id}`;
const trash = id => drive().files.update({ fileId: id, requestBody: { trashed: true }, supportsAllDrives: true });

/* ── 문서 상태 ── */
async function docStateOf(job, body) {
  if (!job.docUrl) return { exists: false };
  try {
    const f = (await drive().files.get({ fileId: parseId(job.docUrl), fields: 'name,modifiedTime,trashed', supportsAllDrives: true })).data;
    if (f.trashed) return { exists: false, missing: true };
    const modified = Date.parse(f.modifiedTime), synced = Number(body.docSyncedAt || 0);
    return { exists: true, url: job.docUrl, linked: !!body.docLinked, name: f.name, syncedVersion: body.docVersion || 0,
      editedInDocs: !body.docLinked && synced > 0 && modified > synced + 15000, modifiedAt: kst(new Date(modified)).slice(5, 16).replace('T', ' ') };
  } catch (e) { return { exists: false, missing: true }; }
}

/* 버전을 확인하고 한 칸 올린다 (Firestore 트랜잭션) */
async function bump(id, version, user, metaPatch = {}, bodyPatch = null) {
  return db.runTransaction(async tx => {
    const ref = db.doc(`rt_jobs/${id}`), s = await tx.get(ref), cur = s.data();
    if (version != null && Number(version) !== Number(cur.version)) return { conflict: true, version: cur.version, updatedBy: cur.updatedBy };
    const next = { ...metaPatch, version: Number(cur.version) + 1, updatedBy: user.name, updatedAt: kstStamp(), ts: FieldValue.serverTimestamp() };
    tx.update(ref, next);
    if (bodyPatch) tx.set(db.doc(`rt_bodies/${id}`), bodyPatch, { merge: true });
    return { ok: true, ...cur, ...next };
  });
}

/* ── 구글 문서 쓰기 (예전 writeDoc_) ── */
const KIND = { event: '경제지표·시의성', article: '홈페이지 아티클', project: '홈페이지 프로젝트' };
function docParagraphs(job, body, webCode, user, nextVersion) {
  const P = [], add = (text, style = 'NORMAL_TEXT', fmt = null) => P.push({ text: String(text ?? '').replace(/\r/g, ''), style, fmt });
  const lines = (t, empty = '(아직 없음)') => { const s = String(t || '').replace(/\r/g, ''); if (!s.trim()) add(empty); else s.split('\n').forEach(l => add(l)); };
  add(job.title || '(주제 미정)', 'TITLE');
  add([job.client, '발행 ' + job.date + (body.publishTime ? ' ' + body.publishTime : ''), KIND[job.kind] || '일반 정보', '담당 ' + (job.owner || '-'), '상태 ' + job.status].join('  ·  '), 'NORMAL_TEXT', { color: '#666666', size: 10 });
  add(`웹앱 저장본 v${nextVersion} · ${user.name} · ${kstStamp()} · 이 문서를 직접 고치면 웹앱의 [문서 내용 가져오기]로 되돌려 받을 수 있습니다.`, 'NORMAL_TEXT', { color: '#999999', size: 9 });
  if (job.kind === 'event') {
    add('발표·출처', 'HEADING_2');
    add('발표 예정(KST): ' + (body.releaseAt || '-')); add('공식 자료 확인(KST): ' + (body.confirmedAt || '-')); add('출처: ' + (body.source || '-'));
  }
  add('블로그 원고', 'HEADING_1'); lines(body.blog);
  add('홈페이지 코드', 'HEADING_1');
  add('아래 내용 전체를 복사해 아임웹 코드 모드에 붙여넣습니다. 깨진 이미지 자리는 이미지 바꾸기로 교체합니다.', 'NORMAL_TEXT', { color: '#666666', size: 9 });
  const code = String(webCode || '').replace(/\r/g, '');
  (code.trim() ? code.split('\n') : ['(아직 없음)']).forEach(l => add(l, 'NORMAL_TEXT', { mono: true, size: 8 }));
  add('이미지', 'HEADING_1');
  const imgs = Array.isArray(body.images) ? body.images : [];
  if (!imgs.length) add('(이미지 계획 없음)');
  imgs.forEach((im, i) => {
    add(`${i + 1}. [${im.type || ''}] ${String(im.title || '').replace(/\n/g, ' / ')}`, 'HEADING_3');
    if (im.body) lines(im.body, '');
    if (im.alt) add('alt: ' + im.alt, 'NORMAL_TEXT', { color: '#666666', size: 9 });
  });
  if (body.notes) { add('검수 메모', 'HEADING_1'); lines(body.notes); }
  return P;
}
const rgb = hex => { const n = parseInt(hex.slice(1), 16); return { red: (n >> 16 & 255) / 255, green: (n >> 8 & 255) / 255, blue: (n & 255) / 255 }; };
async function writeDoc(docId, paras) {
  const d = (await docsApi().documents.get({ documentId: docId })).data;
  const content = d.body?.content || [], end = content.length ? content[content.length - 1].endIndex : 2;
  const reqs = [];
  if (end > 2) reqs.push({ deleteContentRange: { range: { startIndex: 1, endIndex: end - 1 } } });
  const text = paras.map(p => p.text).join('\n');
  reqs.push({ insertText: { location: { index: 1 }, text } });
  reqs.push({ updateTextStyle: { range: { startIndex: 1, endIndex: 1 + text.length }, textStyle: {}, fields: 'bold,italic,foregroundColor,fontSize,weightedFontFamily' } });
  let at = 1;
  paras.forEach(p => {
    const s = at, e = at + p.text.length + 1; // 줄바꿈 포함
    reqs.push({ updateParagraphStyle: { range: { startIndex: s, endIndex: e }, paragraphStyle: { namedStyleType: p.style }, fields: 'namedStyleType' } });
    if (p.fmt && p.text.length) {
      const ts = {}, f = [];
      if (p.fmt.color) { ts.foregroundColor = { color: { rgbColor: rgb(p.fmt.color) } }; f.push('foregroundColor'); }
      if (p.fmt.size) { ts.fontSize = { magnitude: p.fmt.size, unit: 'PT' }; f.push('fontSize'); }
      if (p.fmt.mono) { ts.weightedFontFamily = { fontFamily: 'Roboto Mono' }; f.push('weightedFontFamily'); }
      reqs.push({ updateTextStyle: { range: { startIndex: s, endIndex: s + p.text.length }, textStyle: ts, fields: f.join(',') } });
    }
    at = e;
  });
  reqs.push({ updateDocumentStyle: { documentStyle: { marginTop: { magnitude: 48, unit: 'PT' }, marginBottom: { magnitude: 48, unit: 'PT' } }, fields: 'marginTop,marginBottom' } });
  for (let i = 0; i < reqs.length; i += 400) await docsApi().documents.batchUpdate({ documentId: docId, requestBody: { requests: reqs.slice(i, i + 400) } });
}

/* ── 구글 문서 읽기 (예전 pullDoc) ── */
const paraText = p => (p.paragraph?.elements || []).map(e => e.textRun?.content || '').join('').replace(/\n$/, '');
function flattenTabs(tabs, out = []) { (tabs || []).forEach(t => { out.push(t); flattenTabs(t.childTabs, out); }); return out; }
function bodyParas(body) { return (body?.content || []).filter(c => c.paragraph).map(c => ({ text: paraText(c), style: c.paragraph.paragraphStyle?.namedStyleType || 'NORMAL_TEXT' })); }
async function pullDocContent(docId) {
  const d = (await docsApi().documents.get({ documentId: docId, includeTabsContent: true })).data;
  const tabs = flattenTabs(d.tabs).map(t => ({ title: t.tabProperties?.title || '', paras: bodyParas(t.documentTab?.body) }));
  const textOf = paras => paras.map(p => p.text).join('\n');
  if (tabs.length > 1) {
    const r = { title: d.title, blog: '', webCode: '', tabs: tabs.map(t => t.title), raw: tabs.map(t => textOf(t.paras)).join('\n') };
    tabs.forEach(t => {
      const text = textOf(t.paras).trim(); if (!text) return;
      if (/html|홈페이지|코드|아임웹/i.test(t.title)) { if (!r.webCode) r.webCode = text; }
      else if (/블로그|네이버|원고/.test(t.title)) { if (!r.blog) r.blog = text; }
    });
    if (!r.blog) { const f = tabs.find(t => textOf(t.paras).trim() && textOf(t.paras).trim() !== r.webCode); if (f) r.blog = textOf(f.paras).trim(); }
    return r;
  }
  const paras = tabs[0]?.paras || [];
  if (!paras.some(p => p.style === 'HEADING_1' && p.text.trim() === '블로그 원고')) {
    const text = textOf(paras).trim();
    return { title: d.title, blog: text, webCode: /<\/?(p|div|h2|img|section)\b/i.test(text) ? text : '', raw: text };
  }
  const sections = {}; let cur = null;
  paras.forEach(p => { if (p.style === 'HEADING_1') { cur = p.text.trim(); sections[cur] = []; return; } if (cur) sections[cur].push(p.text); });
  const web = (sections['홈페이지 코드'] || []).slice(1).join('\n').trim();
  return { title: paras[0]?.text || d.title, blog: (sections['블로그 원고'] || []).join('\n').trim(), webCode: web === '(아직 없음)' ? '' : web };
}

/* ── 이미지 ── */
async function imageFiles(folderId) {
  return (await listChildren(folderId)).map(f => { const m = f.name.match(/^(\d+)\.(png|jpe?g|webp)$/i); return m ? { n: Number(m[1]), f, t: Date.parse(f.modifiedTime) } : null; })
    .filter(Boolean).sort((a, b) => a.n - b.n || b.t - a.t);
}
const imageList = async folderId => (await imageFiles(folderId)).map(x => ({ id: x.f.id, n: x.n, name: x.f.name, source: String(x.f.description || '').replace(/^원본:\s*/, ''), size: Number(x.f.size || 0), mime: x.f.mimeType, updated: x.t }));
async function fileBase64(fileId) {
  const r = await drive().files.get({ fileId, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
  return Buffer.from(r.data).toString('base64');
}
async function assertParent(fileId, folderId) {
  const f = (await drive().files.get({ fileId, fields: 'parents,mimeType', supportsAllDrives: true })).data;
  if (!folderId || !(f.parents || []).includes(folderId)) fail('이 작업의 파일이 아닙니다.', 'permission-denied');
  return f;
}
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
function decodeImage(mime, data) {
  const ext = EXT[mime]; if (!ext) fail('PNG, JPG, WebP 만 올릴 수 있습니다.');
  const buf = Buffer.from(String(data || ''), 'base64');
  if (!buf.length || buf.length > MAX_IMAGE_BYTES) fail('이미지 한 장은 15MB 이하여야 합니다.');
  return { ext, buf };
}
const createFile = (folderId, name, mime, buf, description) => drive().files.create({
  requestBody: { name, parents: [folderId], ...(description ? { description } : {}) }, media: { mimeType: mime, body: Readable.from(buf) }, fields: 'id', supportsAllDrives: true });
async function setImageMeta(id, count, folder) { await db.doc(`rt_jobs/${id}`).update({ imageCount: count, folderUrl: folderUrl(folder) }); } // 버전은 그대로

/* 카드 원본: 날짜 폴더/카드원본/c1.jpg */
async function cardFolder(job, create) {
  const day = await dayFolder(job, create); if (!day) return null;
  const hit = (await listChildren(day.id, ` and mimeType = '${FOLDER}' and name = '카드원본'`))[0];
  if (hit) return hit;
  return create ? (await drive().files.create({ requestBody: { name: '카드원본', mimeType: FOLDER, parents: [day.id] }, fields: 'id,name', supportsAllDrives: true })).data : null;
}
async function cardFiles(folderId) {
  const out = {};
  (await listChildren(folderId)).forEach(f => { const m = f.name.match(/^c(\d+)\.(png|jpe?g|webp)$/i); if (!m) return; const n = Number(m[1]), t = Date.parse(f.modifiedTime); if (!out[n] || out[n].t < t) out[n] = { n, id: f.id, t }; });
  return out;
}

/* ── 호출 함수 ── */
const opts = { secrets: [OAUTH], cors: true };
const C = (fn) => onCall(opts, async req => { try { return await fn(req, req.data || {}); } catch (e) { if (e instanceof HttpsError) throw e; console.error(e); fail(String(e.message || e).slice(0, 300), 'internal'); } });

export const docState = C(async (req, { id }) => { const { job } = await jobFor(req, id); return docStateOf(job, await bodyOf(id)); });

export const syncDoc = C(async (req, { id, version, webCode, force }) => {
  const { user, job } = await jobFor(req, id);
  if (Number(version) !== Number(job.version)) return { conflict: true, version: job.version, updatedBy: job.updatedBy };
  const body = await bodyOf(id), state = await docStateOf(job, body);
  if (state.exists && state.linked) return { linked: true, docState: state };
  if (state.exists && state.editedInDocs && !force) return { needsConfirm: true, docState: state };
  const c = await clientByName(job.client), folder = await dayFolder(job, true);
  let docId = state.exists ? parseId(job.docUrl) : '', meta = {};
  if (!docId) {
    docId = (await drive().files.create({ requestBody: { name: `${c.short} ${job.date.slice(8, 10)}`, mimeType: GDOC, parents: [folder.id] }, fields: 'id', supportsAllDrives: true })).data.id;
    meta = { docUrl: `https://docs.google.com/document/d/${docId}/edit`, folderUrl: folderUrl(folder) };
  }
  const nextVersion = Number(job.version) + 1;
  await writeDoc(docId, docParagraphs({ ...job, ...meta }, body, webCode || (String(body.webHtml || '').trim() ? body.webHtml : body.web), user, nextVersion));
  const r = await bump(id, version, user, meta, { docSyncedAt: Date.now() + 3000, docVersion: nextVersion });
  if (r.conflict) return r;
  const nb = await bodyOf(id);
  return { ok: true, version: r.version, docUrl: r.docUrl, folderUrl: r.folderUrl, docState: await docStateOf(r, nb) };
});

export const linkDoc = C(async (req, { id, url, version }) => {
  const { user, job } = await jobFor(req, id);
  const fid = parseId(url); let f;
  try { f = (await drive().files.get({ fileId: fid, fields: 'mimeType', supportsAllDrives: true })).data; } catch (e) { fail('문서를 열 수 없습니다. 링크가 맞는지, 대표 계정에 공유돼 있는지 확인해주세요.'); }
  if (f.mimeType !== GDOC) fail('구글 문서 링크를 넣어주세요.');
  const docUrl = `https://docs.google.com/document/d/${fid}/edit`;
  const r = await bump(id, version, user, { docUrl }, { docLinked: true, docSyncedAt: Date.now(), docVersion: Number(job.version) + 1 });
  if (r.conflict) return r;
  return { ok: true, version: r.version, docUrl, folderUrl: r.folderUrl || '', docState: await docStateOf(r, await bodyOf(id)) };
});

export const unlinkDoc = C(async (req, { id, version }) => {
  const { user } = await jobFor(req, id);
  const r = await bump(id, version, user, { docUrl: '' }, { docLinked: FieldValue.delete(), docSyncedAt: FieldValue.delete(), docVersion: FieldValue.delete() });
  if (r.conflict) return r;
  return { ok: true, version: r.version, docState: { exists: false } };
});

export const pullDoc = C(async (req, { id }) => {
  const { job } = await jobFor(req, id);
  if (!job.docUrl) fail('아직 연결된 문서가 없습니다.');
  return pullDocContent(parseId(job.docUrl));
});

export const markPublished = C(async (req, { id }) => {
  const { job } = await jobFor(req, id);
  try { const f = await dayFolder(job, false); if (f && isDateFolder(f.name) && !f.name.includes('(발행)')) await drive().files.update({ fileId: f.id, requestBody: { name: f.name + ' (발행)' }, supportsAllDrives: true }); } catch (e) { }
  return true;
});

export const listImages = C(async (req, { id }) => { const { job } = await jobFor(req, id); const f = await dayFolder(job, false); return f ? imageList(f.id) : []; });

export const getImage = C(async (req, { id, fileId, thumb }) => {
  const { job } = await jobFor(req, id); const folder = await dayFolder(job, false);
  const f = await assertParent(fileId, folder?.id);
  if (thumb) {
    try {
      const meta = (await drive().files.get({ fileId, fields: 'thumbnailLink', supportsAllDrives: true })).data;
      if (meta.thumbnailLink) {
        const tok = (await google_().auth.getAccessToken()).token;
        const r = await fetch(meta.thumbnailLink.replace(/=s\d+$/, '=s600'), { headers: { Authorization: 'Bearer ' + tok } });
        if (r.ok) return { mime: r.headers.get('content-type') || 'image/png', data: Buffer.from(await r.arrayBuffer()).toString('base64') };
      }
    } catch (e) { }
  }
  return { mime: f.mimeType, data: await fileBase64(fileId) };
});

export const uploadImage = C(async (req, { id, n, mime, data, name }) => {
  const { job } = await jobFor(req, id); n = Number(n);
  if (!(n >= 1 && n <= MAX_IMAGES)) fail(`이미지 번호는 1~${MAX_IMAGES} 사이여야 합니다.`);
  const { ext, buf } = decodeImage(mime, data);
  const folder = await dayFolder(job, true);
  for (const x of await imageFiles(folder.id)) if (x.n === n) await trash(x.f.id);
  await createFile(folder.id, `${n}.${ext}`, mime, buf, name ? '원본: ' + String(name).slice(0, 200) : '');
  const list = await imageList(folder.id);
  await setImageMeta(id, list.length, folder);
  return list;
});

export const reorderImages = C(async (req, { id, order }) => {
  const { job } = await jobFor(req, id); const folder = await dayFolder(job, false);
  if (!folder) return [];
  order = Array.isArray(order) ? order : [];
  const files = await imageFiles(folder.id), byId = Object.fromEntries(files.map(x => [x.f.id, x.f]));
  for (const x of files) if (!order.includes(x.f.id)) await trash(x.f.id);
  for (const [i, fid] of order.entries()) if (byId[fid]) await drive().files.update({ fileId: fid, requestBody: { name: `tmp_${i}_${byId[fid].name}` }, supportsAllDrives: true });
  for (const [i, fid] of order.entries()) if (byId[fid]) await drive().files.update({ fileId: fid, requestBody: { name: `${i + 1}.${byId[fid].name.split('.').pop()}` }, supportsAllDrives: true });
  const list = await imageList(folder.id);
  await setImageMeta(id, list.length, folder);
  return list;
});

export const listCardPhotos = C(async (req, { id }) => {
  const { job } = await jobFor(req, id); const f = await cardFolder(job, false); if (!f) return [];
  return Object.values(await cardFiles(f.id)).map(x => ({ n: x.n, id: x.id, updated: x.t }));
});
export const getCardPhoto = C(async (req, { id, fileId }) => {
  const { job } = await jobFor(req, id); const folder = await cardFolder(job, false);
  const f = await assertParent(fileId, folder?.id);
  return { mime: f.mimeType, data: await fileBase64(fileId) };
});
export const uploadCardPhoto = C(async (req, { id, n, mime, data }) => {
  const { job } = await jobFor(req, id); n = Number(n);
  if (!(n >= 1 && n <= MAX_IMAGES)) fail('카드 번호가 맞지 않습니다.');
  const { ext, buf } = decodeImage(mime, data);
  const folder = await cardFolder(job, true), old = (await cardFiles(folder.id))[n];
  const created = (await createFile(folder.id, `c${n}.${ext}`, mime, buf)).data;
  if (old) await trash(old.id);
  return { n, id: created.id };
});
export const removeCardPhoto = C(async (req, { id, n }) => {
  const { job } = await jobFor(req, id); const folder = await cardFolder(job, false); if (!folder) return true;
  const old = (await cardFiles(folder.id))[Number(n)]; if (old) await trash(old.id);
  return true;
});

/* ── 외부 연동 API (봇·로컬 대시보드) ──
 * GET  /rtApi?op=export              헤더 x-api-key  → 구독사 + 월간 입력 (예전 ?api=export)
 * GET  /rtApi?op=jobs&month=YYYY-MM  → 볼 수 있는 고객사의 일정
 * 키는 rt_apikeys/{sha256(키)} = { name, clients:[...] | all:true, scopes:['export','jobs'] } (관리자가 만든다) */
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
export const rtApi = onRequest({ cors: false }, async (req, res) => {
  try {
    const key = req.get('x-api-key') || '';
    const k = key && await db.doc(`rt_apikeys/${sha(key)}`).get();
    if (!k || !k.exists || k.data().active === false) return res.status(401).json({ error: 'bad key' });
    const K = k.data(), op = String(req.query.op || '');
    if (!(K.scopes || []).includes(op)) return res.status(403).json({ error: 'not allowed' });
    if (op === 'export') {
      const [subs, codes, manual] = await Promise.all(['rt_subscribers', 'rt_subcodes', 'rt_manual'].map(c => db.collection(c).get()));
      const codeOf = Object.fromEntries(codes.docs.map(d => [d.id, d.data().code]));
      const list = subs.docs.map(d => { const { order, ...s } = d.data(); return { ...s, code: codeOf[d.id] || '' }; });
      const m = Object.fromEntries(manual.docs.map(d => { const { _updatedBy, _updatedAt, ...x } = d.data(); return [d.id, x]; }));
      return res.json({ subscribers: { brand: '레인템포랩 오가닉마케팅 운영시스템', updated: kst().slice(0, 10), subscribers: list }, manual: m });
    }
    if (op === 'jobs') {
      const month = String(req.query.month || kst().slice(0, 7));
      if (!/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month' });
      const s = await db.collection('rt_jobs').where('date', '>=', month + '-01').where('date', '<=', month + '-31').get();
      const jobs = s.docs.map(d => ({ id: d.id, ...d.data() })).filter(j => K.all || (K.clients || []).includes(j.client))
        .map(j => ({ id: j.id, client: j.client, date: j.date, title: j.title, status: j.status, owner: j.owner, blogUrl: j.blogUrl, webUrl: j.webUrl }));
      return res.json({ month, jobs });
    }
    res.status(400).json({ error: 'op' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'server' }); }
});
