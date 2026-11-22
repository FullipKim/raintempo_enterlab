/* 설정 (관리자): 운영 시트의 고객사 · 직원 탭을 대신한다. API 키도 여기서 만든다. */
(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const A = () => window.RTBackend.admin;
const toast = (m, bad) => { const t = $('#toast'); t.textContent = m; t.className = 'toast on' + (bad ? ' bad' : ''); clearTimeout(toast.t); toast.t = setTimeout(() => t.className = 'toast', bad ? 5000 : 2600); };
const RULES = [['background', '홈페이지 바탕색', '예: #121212 (어두운 바탕). 지정하지 않으면 흰 바탕'], ['blog', '블로그 작성 규칙', ''], ['web', '홈페이지 작성 규칙', ''],
  ['design', '이미지 제작 규칙', ''], ['links', '링크·브랜드 규칙', ''], ['sources', '참고 문서', '한 줄에 하나 · 이름|문서 ID 또는 링크']];
const ST = { tab: 'clients', clients: [], staff: [], keys: [], open: null };

async function render(root) {
  if (!window.RTBackend.admin.me()?.user.admin) { root.innerHTML = '<div class="empty-box">설정은 관리자만 볼 수 있습니다.</div>'; return; }
  root.innerHTML = '<div class="loading"><span class="spin"></span></div>';
  try { [ST.clients, ST.staff, ST.keys] = await Promise.all([A().clients(), A().staff(), A().keys()]); }
  catch (e) { root.innerHTML = `<div class="note bad">${esc(e.message)}</div>`; return; }
  paint(root);
}
function paint(root) {
  const T = { clients: '고객사', staff: '직원', keys: 'API 키' };
  root.innerHTML = `<div class="set">
    <div class="row" style="margin-bottom:12px"><h2 style="font-size:15px;font-weight:600">설정</h2><div class="sp"></div></div>
    <div class="tabs">${Object.entries(T).map(([k, v]) => `<button data-st="${k}" class="${ST.tab === k ? 'on' : ''}">${v}<span class="count">${ST[k].length}</span></button>`).join('')}</div>
    <div id="set-body"></div></div>`;
  $$('[data-st]', root).forEach(b => b.onclick = () => { ST.tab = b.dataset.st; ST.open = null; paint(root); });
  ({ clients: clientsView, staff: staffView, keys: keysView })[ST.tab]($('#set-body', root), root);
}

/* 고객사 */
function clientsView(el, root) {
  el.innerHTML = `<div class="toolbar"><span class="muted">작성 규칙 칸에 적은 내용이 기본 규칙보다 우선합니다.</span><div class="sp"></div><button class="b sm" id="c-new">+ 고객사</button></div>
    <div class="jobs">${ST.clients.map(c => `<div class="lrow" data-c="${esc(c.id)}"><span class="chip c${(c.order ?? 0) % 5}">${esc(c.short)}</span><b>${esc(c.name)}</b>
      <span class="muted">${c.folderId ? '드라이브 연결' : '<span style="color:var(--warn)">드라이브 폴더 없음</span>'}</span><span class="muted">${Object.values(c.rules || {}).filter(v => String(v || '').trim()).length}/6 규칙</span>
      <span class="pill" data-s="${c.active === false ? '보류' : '발행 완료'}">${c.active === false ? '사용 안 함' : '사용'}</span></div>
      ${ST.open === c.id ? clientForm(c) : ''}`).join('')}${ST.open === '__new' ? clientForm({ id: '', name: '', short: '', active: true, rules: {} }) : ''}</div>`;
  $('#c-new', el).onclick = () => { ST.open = '__new'; paint(root); };
  $$('[data-c]', el).forEach(r => r.onclick = () => { ST.open = ST.open === r.dataset.c ? null : r.dataset.c; paint(root); });
  const f = $('.sform', el); if (!f) return;
  f.querySelector('[data-cancel]').onclick = () => { ST.open = null; paint(root); };
  f.querySelector('[data-save]').onclick = async () => {
    const v = n => f.querySelector(`[name="${n}"]`);
    const c = { id: f.dataset.id || '', name: v('name').value.trim(), short: v('short').value.trim(), folderId: v('folderId').value.trim(), template: v('template').value.trim(),
      active: v('active').checked, order: Number(v('order').value || 0), rules: Object.fromEntries(RULES.map(([k]) => [k, v('r_' + k).value])) };
    try { await A().saveClient(c); toast('저장했습니다. 새로 고침하면 작성 화면에 반영됩니다'); ST.open = null; render(root); } catch (e) { toast(e.message, true); }
  };
}
function clientForm(c) {
  const r = c.rules || {};
  return `<div class="sform" data-id="${esc(c.id)}" onclick="event.stopPropagation()">
    <div class="grid g4">
      <label class="f"><span>고객사 이름</span><input name="name" value="${esc(c.name)}"></label>
      <label class="f"><span>약칭</span><input name="short" value="${esc(c.short)}" ${c.id ? 'readonly title="약칭은 문서 ID 라 바꿀 수 없습니다"' : ''}></label>
      <label class="f"><span>순서</span><input name="order" type="text" inputmode="numeric" value="${esc(c.order ?? '')}"></label>
      <label class="f"><span>사용</span><span class="row" style="height:32px"><input type="checkbox" name="active" ${c.active !== false ? 'checked' : ''}> 작성 화면에 보이기</span></label>
      <label class="f" style="grid-column:span 2"><span>드라이브 폴더 (링크 또는 ID)</span><input name="folderId" value="${esc(c.folderId || '')}"></label>
      <label class="f" style="grid-column:span 2"><span>Canva 템플릿</span><input name="template" value="${esc(c.template || '')}"></label>
    </div>
    <div class="grid g2" style="margin-top:12px">${RULES.map(([k, label, ph]) => `<label class="f"><span>${label}</span><textarea name="r_${k}" rows="${k === 'background' ? 2 : 5}" placeholder="${esc(ph)}">${esc(r[k] || '')}</textarea></label>`).join('')}</div>
    <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="b sm" data-cancel>취소</button><button class="b sm pri" data-save>저장</button></div>
  </div>`;
}

/* 직원 */
function staffView(el, root) {
  const names = ST.clients.map(c => c.name);
  el.innerHTML = `<div class="toolbar"><span class="muted">구글 계정으로 로그인합니다. 담당 고객사만 보이고, 관리자는 삭제·설정을 할 수 있습니다.</span><div class="sp"></div><button class="b sm" id="s-new">+ 직원</button></div>
    <div class="jobs">${ST.staff.map(s => `<div class="lrow" data-s="${esc(s.email)}"><span class="av">${esc(String(s.name || '?').slice(0, 1))}</span><b>${esc(s.name)}</b><span class="muted">${esc(s.email)}</span>
      <span class="muted">${s.all ? '전체 고객사' : (s.clients || []).map(n => esc(ST.clients.find(c => c.name === n)?.short || n)).join(', ') || '없음'}</span>
      <span class="pill" data-s="${s.active === false ? '보류' : '발행 완료'}">${s.active === false ? '정지' : s.admin ? '관리자' : '직원'}</span></div>
      ${ST.open === s.email ? staffForm(s, names) : ''}`).join('')}${ST.open === '__new' ? staffForm({ email: '', name: '', active: true, clients: [] }, names) : ''}</div>`;
  $('#s-new', el).onclick = () => { ST.open = '__new'; paint(root); };
  $$('[data-s]', el).forEach(r => { if (r.classList.contains('lrow')) r.onclick = () => { ST.open = ST.open === r.dataset.s ? null : r.dataset.s; paint(root); }; });
  const f = $('.sform', el); if (!f) return;
  const allBox = f.querySelector('[name="all"]'), sync = () => f.querySelector('.cl').style.opacity = allBox.checked ? .4 : 1; allBox.onchange = sync; sync();
  f.querySelector('[data-cancel]').onclick = () => { ST.open = null; paint(root); };
  const del = f.querySelector('[data-del]');
  if (del) del.onclick = async () => { if (!confirm('이 직원을 지울까요? 바로 로그인할 수 없게 됩니다.')) return; try { await A().deleteStaff(f.dataset.id); ST.open = null; render(root); } catch (e) { toast(e.message, true); } };
  f.querySelector('[data-save]').onclick = async () => {
    const v = n => f.querySelector(`[name="${n}"]`);
    const s = { email: v('email').value, name: v('name').value.trim(), admin: v('admin').checked, active: v('active').checked, all: allBox.checked,
      clients: $$('[name="cl"]:checked', f).map(x => x.value) };
    try { await A().saveStaff(s); toast('저장했습니다'); ST.open = null; render(root); } catch (e) { toast(e.message, true); }
  };
}
function staffForm(s, names) {
  return `<div class="sform" data-id="${esc(s.email)}" onclick="event.stopPropagation()">
    <div class="grid g4">
      <label class="f" style="grid-column:span 2"><span>구글 계정 이메일</span><input name="email" value="${esc(s.email)}" ${s.email ? 'readonly' : ''} placeholder="name@gmail.com"></label>
      <label class="f"><span>이름</span><input name="name" value="${esc(s.name)}"></label>
      <div class="f"><span>권한</span><div class="row" style="height:32px;gap:12px"><label class="row"><input type="checkbox" name="admin" ${s.admin ? 'checked' : ''}> 관리자</label><label class="row"><input type="checkbox" name="active" ${s.active !== false ? 'checked' : ''}> 사용</label></div></div>
    </div>
    <div class="f" style="margin-top:12px"><span>담당 고객사</span>
      <label class="row" style="margin:4px 0"><input type="checkbox" name="all" ${s.all ? 'checked' : ''}> 전체 (새 고객사도 자동 포함)</label>
      <div class="row cl" style="gap:6px">${names.map(n => `<label class="tag"><input type="checkbox" name="cl" value="${esc(n)}" ${(s.clients || []).includes(n) ? 'checked' : ''}><span>${esc(n)}</span></label>`).join('')}</div></div>
    <div class="row" style="margin-top:12px">${s.email ? '<button class="b sm ghost danger" data-del>삭제</button>' : ''}<div class="sp"></div><button class="b sm" data-cancel>취소</button><button class="b sm pri" data-save>저장</button></div>
  </div>`;
}

/* API 키 (포포봇 · 로컬 대시보드 동기화) */
function keysView(el, root) {
  el.innerHTML = `<div class="toolbar"><span class="muted">봇이나 다른 프로그램이 일정을 읽거나 구독사·월간 입력을 내려받을 때 씁니다. 키는 만들 때 한 번만 보입니다.</span><div class="sp"></div><button class="b sm" id="k-new">+ 키 만들기</button></div>
    <div id="k-made"></div>
    <div class="jobs">${ST.keys.length ? ST.keys.map(k => `<div class="lrow" style="cursor:default"><b>${esc(k.name)}</b><span class="muted">…${esc(k.tail || '')}</span><span class="muted">${esc((k.scopes || []).join(', '))}</span>
      <span class="muted">${k.all ? '전체 고객사' : esc((k.clients || []).join(', '))}</span><button class="b sm ghost danger" data-rv="${esc(k.id)}">폐기</button></div>`).join('') : '<div class="empty-box">아직 만든 키가 없습니다.</div>'}</div>
    ${ST.open === '__new' ? `<div class="sform" style="margin-top:10px"><div class="grid g3">
      <label class="f"><span>이름</span><input name="kname" placeholder="예: 포포봇"></label>
      <div class="f"><span>할 수 있는 일</span><div class="row" style="height:32px;gap:12px"><label class="row"><input type="checkbox" name="sc" value="jobs" checked> 일정 읽기</label><label class="row"><input type="checkbox" name="sc" value="export"> 구독사·월간 입력</label></div></div>
      <div class="f"><span>고객사</span><select name="kcl"><option value="__all">전체</option>${ST.clients.map(c => `<option>${esc(c.name)}</option>`).join('')}</select></div></div>
      <div class="row" style="margin-top:12px;justify-content:flex-end"><button class="b sm" data-cancel>취소</button><button class="b sm pri" data-save>만들기</button></div></div>` : ''}`;
  $('#k-new', el).onclick = () => { ST.open = '__new'; paint(root); };
  $$('[data-rv]', el).forEach(b => b.onclick = async () => { if (!confirm('이 키를 폐기할까요? 쓰던 프로그램은 바로 막힙니다.')) return; await A().revokeKey(b.dataset.rv); render(root); });
  const f = $('.sform', el); if (!f) return;
  f.querySelector('[data-cancel]').onclick = () => { ST.open = null; paint(root); };
  f.querySelector('[data-save]').onclick = async () => {
    const cl = f.querySelector('[name="kcl"]').value;
    try {
      const raw = await A().createKey({ name: f.querySelector('[name="kname"]').value.trim(), scopes: $$('[name="sc"]:checked', f).map(x => x.value), all: cl === '__all', clients: cl === '__all' ? [] : [cl] });
      ST.keys = await A().keys(); ST.open = null; paint(root);
      $('#k-made').innerHTML = `<div class="note good" style="margin-bottom:10px">새 키입니다. 지금 복사해 두세요. 다시 볼 수 없습니다.<br><code style="user-select:all;font-size:12px">${esc(raw)}</code></div>`;
    } catch (e) { toast(e.message, true); }
  };
}

window.RTSettings = { render };
})();
