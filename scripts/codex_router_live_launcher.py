# Copyright © 2022 Dell Inc. or its subsidiaries. All Rights Reserved.

"""Launch candidate router code with OpenCode traffic confined to the trusted proxy."""

import importlib.util
from pathlib import Path

PROXY_URL = "http://codex-router-provider-proxy:8080/v1/chat/completions"
SHIM_PATH = Path("/router/router/shim.py")


def redirect_opencode_go_hops(hops):
    for hop in hops:
        if hop.get("auth") == "opencode_go":
            hop["url"] = PROXY_URL
    return hops


def main():
    import uvicorn

    spec = importlib.util.spec_from_file_location("candidate_router_shim", SHIM_PATH)
    shim = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(shim)
    shim.AUTO_THINKING_HOPS = redirect_opencode_go_hops(shim.AUTO_THINKING_HOPS)
    shim.GLM_HOPS = redirect_opencode_go_hops(shim.GLM_HOPS)
    uvicorn.run(shim.app, host="0.0.0.0", port=4100, log_level="warning")


if __name__ == "__main__":
    main()
