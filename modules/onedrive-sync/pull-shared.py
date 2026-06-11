#!/usr/bin/env python3
"""One-time download of shared-with-me file, then portfolio-tracker works locally."""
import json, os, sys
import urllib.request, urllib.parse

CLIENT_ID = "d50ca740-c83f-4d1b-b616-12c519384f0c"
REFRESH_TOKEN = open("config/onedrive/refresh_token").read().strip()
OUTPUT = os.environ.get("PP_XML_PATH", "/data/onedrive/portfolio.xml")
REMOTE_PATH = os.environ.get("ONEDRIVE_REMOTE_PATH", "PortfolioPerformance/portfolio.xml")

def get_access_token():
    data = urllib.parse.urlencode({
        "client_id": CLIENT_ID,
        "refresh_token": REFRESH_TOKEN,
        "grant_type": "refresh_token",
        "redirect_uri": "https://login.microsoftonline.com/common/oauth2/nativeclient",
    }).encode()
    req = urllib.request.Request(
        "https://login.microsoftonline.com/common/oauth2/v2.0/token",
        data=data, headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())["access_token"]

def list_shared():
    token = get_access_token()
    req = urllib.request.Request(
        "https://graph.microsoft.com/v1.0/me/drive/sharedWithMe",
        headers={"Authorization": f"Bearer {token}"},
    )
    resp = urllib.request.urlopen(req)
    return json.loads(resp.read())["value"]

token = get_access_token()
# Try to find and download the file
shared = list_shared()
for item in shared:
    name = item.get("name", "")
    if REMOTE_PATH in name or name.endswith(".xml"):
        download_url = item.get("@microsoft.graph.downloadUrl")
        if download_url:
            urllib.request.urlretrieve(download_url, OUTPUT)
            print(f"Downloaded: {name} -> {OUTPUT} ({os.path.getsize(OUTPUT)} bytes)")
            break
else:
    print(f"File '{REMOTE_PATH}' not found in shared items:")
    for item in shared:
        print(f"  {item.get('name')} ({item.get('id')})")
