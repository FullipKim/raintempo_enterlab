#!/usr/bin/env python3
"""Cloud Functions 가 대표 구글 드라이브·문서를 다룰 수 있게 OAuth 토큰을 받는다 (한 번만).

  python3 admin-src/scripts/drive_auth.py
  → 브라우저 승인 → config/rt_google_oauth.json 저장 (Git 에 올리지 않음)
  → cd admin-src && npx firebase-tools@15 functions:secrets:set RT_GOOGLE_OAUTH --data-file ~/Documents/rtadmin/config/rt_google_oauth.json --project raintempolab
"""
import json, os
from pathlib import Path
from google_auth_oauthlib.flow import InstalledAppFlow

CONFIG = Path(os.environ.get("RT_CONFIG") or Path.home() / "Documents/rtadmin/config")  # 토큰은 rtadmin/config 에만 둔다 (이 저장소에 두지 않음)
SCOPES = ["https://www.googleapis.com/auth/drive", "https://www.googleapis.com/auth/documents"]
flow = InstalledAppFlow.from_client_secrets_file(str(CONFIG / "credentials.json"), SCOPES)
creds = flow.run_local_server(port=8401, prompt="consent", access_type="offline",
                              authorization_prompt_message="브라우저에서 대표 계정으로 승인해주세요…",
                              success_message="완료되었습니다. 창을 닫으셔도 됩니다.")
out = CONFIG / "rt_google_oauth.json"
out.write_text(json.dumps({"client_id": creds.client_id, "client_secret": creds.client_secret, "refresh_token": creds.refresh_token}), encoding="utf-8")
print("저장 완료:", out)
print("권한:", " ".join(creds.scopes or []))
