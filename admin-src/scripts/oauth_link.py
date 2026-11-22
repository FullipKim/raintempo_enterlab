#!/usr/bin/env python3
"""브라우저가 다른 컴퓨터에 있어도 구글 승인을 받는 2단계 도구.

  python3 admin-src/scripts/oauth_link.py start drive     → 승인 링크 출력
  (브라우저에서 승인 → localhost 로 넘어가며 '연결할 수 없음' 이 뜨면 그 주소창 전체를 복사)
  python3 admin-src/scripts/oauth_link.py finish drive '<복사한 주소>'

  drive  : Cloud Functions 용 드라이브·문서 토큰 → config/rt_google_oauth.json
  deploy : 배포·이전용 (Firebase/GCP) 사용자 인증 → config/rt_gcloud_adc.json  (GOOGLE_APPLICATION_CREDENTIALS 로 쓴다)
config/ 는 Git 에 올라가지 않는다. 토큰 값은 화면에 출력하지 않는다.
"""
import json, os, sys
from pathlib import Path
from google_auth_oauthlib.flow import Flow

os.environ["OAUTHLIB_INSECURE_TRANSPORT"] = "1"   # localhost 리디렉트(http) 허용
os.environ["OAUTHLIB_RELAX_TOKEN_SCOPE"] = "1"
CONFIG = Path(os.environ.get("RT_CONFIG") or Path.home() / "Documents/rtadmin/config")  # 토큰은 rtadmin/config 에만 둔다 (이 저장소에 두지 않음)
REDIRECT = "http://localhost:8402/"
KINDS = {
    "drive": (["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"], "rt_google_oauth.json"),
    "firebase": (["email", "openid", "https://www.googleapis.com/auth/cloudplatformprojects.readonly", "https://www.googleapis.com/auth/firebase",
                  "https://www.googleapis.com/auth/cloud-platform"], "rt_firebase_token.json"),
    "deploy": (["https://www.googleapis.com/auth/cloud-platform", "https://www.googleapis.com/auth/firebase",
                "https://www.googleapis.com/auth/userinfo.email", "openid"], "rt_gcloud_adc.json"),
}

# Firebase CLI 공개 클라이언트 (firebase login 과 같은 값). 배포 API 사용량이 CLI 쪽 프로젝트로 잡힌다
FB_CLIENT = {"installed": {"client_id": "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com", "client_secret": "j9iVZfS8kkCEFUPaAeJV0sAi",
             "auth_uri": "https://accounts.google.com/o/oauth2/auth", "token_uri": "https://oauth2.googleapis.com/token", "redirect_uris": ["http://localhost"]}}

def flow(kind):
    if kind == "firebase":
        return Flow.from_client_config(FB_CLIENT, scopes=KINDS[kind][0], redirect_uri="http://localhost:9005")
    return Flow.from_client_secrets_file(str(CONFIG / "credentials.json"), scopes=KINDS[kind][0], redirect_uri=REDIRECT)

mode, kind = sys.argv[1], sys.argv[2]
state_file = CONFIG / f"_oauth_{kind}.json"
if mode == "start":
    f = flow(kind)
    url, state = f.authorization_url(access_type="offline", prompt="consent", include_granted_scopes="false")
    state_file.write_text(json.dumps({"state": state, "verifier": f.code_verifier}))
    print(url)
elif mode == "finish":
    saved = json.loads(state_file.read_text())
    f = flow(kind)
    f.code_verifier = saved["verifier"]
    f.fetch_token(authorization_response=sys.argv[3].strip())
    c = f.credentials
    if not c.refresh_token:
        sys.exit("refresh_token 이 없습니다. start 부터 다시 해주세요.")
    out = {"client_id": c.client_id, "client_secret": c.client_secret, "refresh_token": c.refresh_token}
    if kind == "deploy":
        out = {"type": "authorized_user", **out, "quota_project_id": "raintempolab"}
    (CONFIG / KINDS[kind][1]).write_text(json.dumps(out), encoding="utf-8")
    state_file.write_text("{}")
    print("저장 완료:", KINDS[kind][1], "| 권한:", " ".join(c.scopes or []))
