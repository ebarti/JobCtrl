"""Loopback HTTP process; production entrypoint for source and installed use."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import uvicorn

from jobctrl.app.bootstrap import create_application
from jobctrl.app.errors import AppError
from jobctrl.app.http import create_http_app
from jobctrl.app.security import is_loopback


def main():
    parser = argparse.ArgumentParser(description="Run the JobCtrl Python HTTP application")
    parser.add_argument("--workspace", type=Path, default=Path(os.environ.get("JOBCTRL_DIR", "~/.jobctrl")).expanduser())
    parser.add_argument("--host", default=os.environ.get("JOBCTRL_API_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("JOBCTRL_API_PORT", os.environ.get("API_PORT", "8766"))))
    parser.add_argument("--static-dir", type=Path, default=os.environ.get("JOBCTRL_WEB_DIR"))
    parser.add_argument("--features", default=os.environ.get("JOBCTRL_FEATURES"))
    args = parser.parse_args()
    if not is_loopback(args.host) or not 1 <= args.port <= 65535:
        parser.error("The API must bind a loopback host and valid port.")
    os.environ["JOBCTRL_DIR"] = str(args.workspace.expanduser().resolve())
    try:
        application = create_application(args.workspace, enabled_features=args.features.split(",") if args.features else None)
        app = create_http_app(application, static_dir=args.static_dir, port=args.port)
        uvicorn.run(app, host=args.host, port=args.port, proxy_headers=False, access_log=False,
                    server_header=False, timeout_graceful_shutdown=15)
    except AppError as error:
        print(f"{error.code}: {error.message}", file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
