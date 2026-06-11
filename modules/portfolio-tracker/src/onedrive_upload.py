"""Upload modified PP file to OneDrive after portfolio changes."""
import json, os, sys, time, urllib.request, urllib.parse

TOKEN_FILE = "/app/config/onedrive_refresh_token"
LOCAL_FILE = os.environ.get("PP_XML_PATH", "/data/onedrive/Portfolio/Portfolio.portfolio")
CLIENT_ID = "d50ca740-c83f-4d1b-b616-12c519384f0c"
TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token"
REDIRECT = "https://login.microsoftonline.com/common/oauth2/nativeclient"

def get_access_token():
    with open(TOKEN_FILE) as f:
        refresh_token = f.read().strip()
    data = urllib.parse.urlencode({
        "client_id": CLIENT_ID, "refresh_token": refresh_token,
        "grant_type": "refresh_token", "redirect_uri": REDIRECT,
    }).encode()
    for attempt in range(3):
        try:
            req = urllib.request.Request(TOKEN_URL, data=data, headers={"Content-Type": "application/x-www-form-urlencoded"})
            return json.loads(urllib.request.urlopen(req, timeout=15).read())["access_token"]
        except Exception:
            if attempt < 2: time.sleep(2)
            else: raise

def upload_file():
    token = get_access_token()
    with open(LOCAL_FILE, "rb") as f:
        content = f.read()

    # Resolve remote folder (handles shortcut/shared folders)
    req = urllib.request.Request(
        "https://graph.microsoft.com/v1.0/me/drive/root:/Portfolio",
        headers={"Authorization": f"Bearer {token}"},
    )
    item = json.loads(urllib.request.urlopen(req, timeout=10).read())
    remote = item.get("remoteItem")
    
    if remote:
        drive_id = remote["parentReference"]["driveId"]
        folder_id = remote["id"]
        url = f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{folder_id}:/Portfolio.portfolio:/content"
    else:
        url = f"https://graph.microsoft.com/v1.0/me/drive/root:/Portfolio/Portfolio.portfolio:/content"

    url += "?@microsoft.graph.conflictBehavior=replace"
    req = urllib.request.Request(
        url, data=content,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "text/plain"},
        method="PUT",
    )
    result = json.loads(urllib.request.urlopen(req, timeout=30).read())
    print(f"Uploaded: {len(content)} bytes -> {result.get('name','?')} ({result.get('size',0)} bytes)")

if __name__ == "__main__":
    try:
        upload_file()
    except Exception as e:
        print(f"OneDrive upload failed: {e}", file=sys.stderr)
        sys.exit(1)
