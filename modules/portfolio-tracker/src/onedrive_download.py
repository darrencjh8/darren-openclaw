"""Download latest PP file from OneDrive before making changes."""
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

def download_file():
    token = get_access_token()
    
    # Resolve Portfolio shortcut
    req = urllib.request.Request(
        "https://graph.microsoft.com/v1.0/me/drive/root:/Portfolio",
        headers={"Authorization": f"Bearer {token}"},
    )
    item = json.loads(urllib.request.urlopen(req, timeout=10).read())
    remote = item.get("remoteItem")
    
    if not remote:
        raise Exception("Portfolio is not a shared folder shortcut")
    
    # List children to get pre-signed download URL
    drive_id = remote["parentReference"]["driveId"]
    folder_id = remote["id"]
    url = f"https://graph.microsoft.com/v1.0/drives/{drive_id}/items/{folder_id}/children?select=name,@microsoft.graph.downloadUrl"
    req2 = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    children = json.loads(urllib.request.urlopen(req2, timeout=30).read())
    
    for child in children.get("value", []):
        if child.get("name") == "Portfolio.portfolio":
            dl_url = child.get("@microsoft.graph.downloadUrl", "")
            if not dl_url:
                raise Exception("No download URL available")
            
            # Download via pre-signed URL (no auth needed)
            content = urllib.request.urlopen(dl_url, timeout=60).read()
            
            with open(LOCAL_FILE, "wb") as f:
                f.write(content)
            print(f"Downloaded: {len(content)} bytes from OneDrive -> {LOCAL_FILE}")
            return
    
    raise Exception("Portfolio.portfolio not found in shared folder")

if __name__ == "__main__":
    try:
        download_file()
    except Exception as e:
        print(f"OneDrive download failed: {e}", file=sys.stderr)
        sys.exit(1)
