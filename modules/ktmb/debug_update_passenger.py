#!/usr/bin/env python3
"""Playwright script to capture the exact UpdatePassenger network request.

Usage:
    pip install playwright && playwright install chromium
    python3 debug_update_passenger.py

Opens a headed browser. You manually:
1. Log in
2. Search for Shuttle Tebrau (JB Sentral → Woodlands CIQ, next day)
3. Select a trip
4. Solve the captcha
5. Fill passenger details and submit

The script captures every POST/GET to BookShuttle/UpdatePassenger and
prints the EXACT request payload and response for comparison.
"""

import asyncio
import json
from playwright.async_api import async_playwright
from datetime import datetime

UPDATE_PASSENGER_URL = "BookShuttle/UpdatePassenger"
RESERVE_URL = "ShuttleTrip/Reserve"
TRIP_URL = "ShuttleTrip/Trip"
BOOK_SHUTTLE_URL = "BookShuttle"

CAPTURED_REQUESTS = []


async def capture_request(request):
    if request.method != "POST":
        return
    url = request.url
    if any(x in url for x in [UPDATE_PASSENGER_URL, TRIP_URL, RESERVE_URL, "BookShuttle"]):
        try:
            body = request.post_data
            headers = dict(request.headers)
            cookies = await request.all_headers()  # gives cookie header
            CAPTURED_REQUESTS.append({
                "url": url,
                "method": request.method,
                "headers": headers,
                "body": body,
                "timestamp": datetime.now().isoformat(),
            })
        except Exception as e:
            print(f"[capture error] {e}")


async def capture_response(response):
    req = response.request
    url = req.url
    if UPDATE_PASSENGER_URL not in url:
        return
    try:
        body = await response.text()
        status = response.status
        print("\n" + "=" * 80)
        print(f"*** UpdatePassenger RESPONSE ***")
        print(f"URL: {url}")
        print(f"Status: {status}")
        print(f"Headers: {dict(response.headers)}")
        print(f"Body: {body[:2000]}")
        print("=" * 80 + "\n")
        CAPTURED_REQUESTS[-1]["response_body"] = body
        CAPTURED_REQUESTS[-1]["response_status"] = status
    except Exception as e:
        print(f"[capture response error] {e}")


async def on_response(response):
    await capture_response(response)


async def on_request(request):
    await capture_request(request)


async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False, devtools=False)
        context = await browser.new_context(
            viewport={"width": 1280, "height": 900},
            locale="en-US",
        )
        page = await context.new_page()

        page.on("request", on_request)
        page.on("response", on_response)

        await page.goto("https://shuttleonline.ktmb.com.my/Home/Shuttle")
        print("Browser opened. Please:")
        print("  1. Log in (redirects to login page if needed)")
        print("  2. Search for Shuttle Tebrau (JB Sentral → Woodlands CIQ, tomorrow)")
        print("  3. Select a trip, solve captcha")
        print("  4. Fill in passenger details, submit")
        print()
        print("This script will automatically capture all UpdatePassenger details.")
        print("Press Enter in this terminal when done, or after the payment page appears.")
        print()

        await asyncio.get_event_loop().run_in_executor(None, input, ">>> Press Enter to stop capture and print results...\n")

        # Print all captured requests
        print("\n" + "=" * 80)
        print("ALL CAPTURED REQUESTS")
        print("=" * 80)
        for i, req in enumerate(CAPTURED_REQUESTS):
            print(f"\n--- Request #{i+1}: {req['method']} {req['url'][:100]} ---")
            print(f"Time: {req['timestamp']}")
            print(f"Headers: {json.dumps(req['headers'], indent=2)}")
            if req.get("body"):
                try:
                    parsed = json.loads(req["body"])
                    print(f"Body (JSON, pretty): {json.dumps(parsed, indent=2)}")
                except (json.JSONDecodeError, TypeError):
                    print(f"Body (raw, first 2000 chars): {req['body'][:2000]}")
            if "response_status" in req:
                print(f"Response Status: {req['response_status']}")
                if req.get("response_body"):
                    try:
                        parsed = json.loads(req["response_body"])
                        print(f"Response (JSON): {json.dumps(parsed, indent=2)}")
                    except (json.JSONDecodeError, TypeError):
                        print(f"Response (raw): {req['response_body'][:1000]}")

        # Save to file for reference
        with open("/tmp/ktmb_playwright_capture.json", "w") as f:
            json.dump(CAPTURED_REQUESTS, f, indent=2, default=str)
        print("\nSaved to /tmp/ktmb_playwright_capture.json")

        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
