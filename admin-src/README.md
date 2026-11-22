# raintempoenterlab.kr · 내부 어드민 (Firebase)

Apps Script 웹앱을 Firebase로 옮긴 버전입니다. 저장소 루트의 기존 홈페이지는 그대로 두고, `/admin`에 직원용 어드민을 둡니다.

- `admin/` 빌드 결과 (Netlify 가 그대로 올림, 직접 고치지 않음)
- `admin-src/` 소스 · 함수 · 규칙 · 이전 스크립트 (사이트에서는 404)
- `admin-src/landing/` 새 공개 랜딩 초안 (아직 루트 index.html 을 바꾸지 않음)
- 토큰·직원 이메일·내보낸 데이터는 이 저장소에 두지 않습니다 (`~/Documents/rtadmin/config`)

## 구성

| 부분 | 위치 | 하는 일 |
|---|---|---|
| 화면 | `admin/` (빌드 결과) | Netlify에 올라감. 원고 편집, 요청문, 표현 검사, 카드 메이커는 예전 화면 코드(`src/legacy/`) 그대로 |
| 데이터 | Firestore `raintempolab` 프로젝트의 `rt_` 컬렉션 | 일정 `rt_jobs`, 본문 `rt_bodies`, 수정 이력 `rt_history`, 고객사 `rt_clients`, 직원 `rt_staff`, 구독사 `rt_subscribers`(진입코드는 `rt_subcodes`), 월간 입력 `rt_manual`, API 키 `rt_apikeys` |
| 드라이브·문서 | `functions/` (Cloud Functions, 서울 리전) | 날짜 폴더, 이미지, 카드원본, 구글 문서 쓰기/읽기, 외부 연동 API `rtApi` |
| 보안 규칙 | `firestore.rt.rules` | 기존 홈페이지 규칙에 끼워 넣어 배포 (`scripts/merge-rules.mjs`) |

홈페이지의 `articles`, `projects`, `inquiries` 컬렉션과 규칙은 그대로 둡니다.

## 로그인

- 직원: 구글 계정. 설정 > 직원에 이메일을 등록한 사람만 들어옵니다. 담당 고객사만 보이고, 관리자만 삭제·설정을 할 수 있습니다.
- 봇·프로그램: 설정 > API 키에서 만든 키를 `x-api-key` 헤더로 보냅니다.
  - `GET https://asia-northeast3-raintempolab.cloudfunctions.net/rtApi?op=jobs&month=2026-11` 일정
  - `GET ...?op=export` 구독사 + 월간 입력 (로컬 대시보드 동기화용, 예전 `?api=export`)

## 처음 한 번 하는 일 (대표)

1. Firebase 콘솔 > Authentication > 로그인 방법에서 Google 사용 확인. 설정 > 승인된 도메인에 `raintempoenterlab.kr` 추가.
2. Firebase CLI 로그인: `cd admin-src && npx firebase-tools@15 login`
3. 드라이브 토큰: `cd ~/Documents/rtadmin && python3 enterlab/scripts/drive_auth.py` → 대표 계정으로 승인
   → `cd enterlab && npx firebase functions:secrets:set RT_GOOGLE_OAUTH --data-file ../config/rt_google_oauth.json --project raintempolab`
4. 보안 규칙: 콘솔 Firestore > 규칙에 지금 올라가 있는 내용을 `rules/live.rules`로 저장 → `node scripts/merge-rules.mjs rules/live.rules > firestore.rules` → 확인 후 `npx firebase deploy --only firestore:rules --project raintempolab`
5. 함수 배포: `cd functions && npm ci && cd .. && npx firebase deploy --only functions:rtadmin --project raintempolab`
6. 데이터 옮기기: Apps Script `?api=exportAll&key=SYNC_KEY` 결과를 `export.json`으로 저장, 직원 이메일 `staff-emails.json` 작성 →
   `gcloud auth application-default login` 후 `GCLOUD_PROJECT=raintempolab node scripts/migrate.mjs export.json staff-emails.json --dry` → 확인 후 `--dry` 빼고 실행
7. Netlify: 새 사이트를 이 폴더에 연결(배포 폴더 `public`), 도메인 `raintempoenterlab.kr` 연결.

## 고치고 배포하기

```sh
cd admin-src && npm ci && node scripts/build.mjs   # ../admin/ 다시 만들기
python3 -m http.server -d .. 8777   # http://localhost:8777/admin/ (에뮬레이터 연결, ?live 를 붙이면 실제 프로젝트)
npx firebase-tools@15 emulators:start --only auth,firestore,functions --project raintempolab
```

- `src/legacy/*.html`은 Apps Script 화면 코드입니다. 여기서 고치면 빌드에 반영됩니다.
- `src/backend.js`가 예전 `google.script.run` 자리를 Firestore·Functions 호출로 바꿉니다.
- 스타일은 `src/linear.css`가 기존 스타일 위에 덮어씁니다.
