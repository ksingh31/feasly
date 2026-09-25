#!/usr/bin/env python3
"""Tiny mock for checks.sh tests (HRD-06).

Usage: mock-server.py <port> <mode>
  mode: healthy | degraded-db | no-checks | http500

Serves:
  /           -> 200 "ok"
  /privacy    -> 200 "ok"
  /api/health -> JSON per mode (or 500 for http500)
Everything else -> 404.
"""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

MODES = {
    "healthy": {"status": "ok", "service": "feasly-api", "version": "0.1.0",
                "checks": {"database": "ok"}},
    "degraded-db": {"status": "degraded", "service": "feasly-api",
                    "version": "0.1.0",
                    "checks": {"database": "unreachable"}},
    "no-checks": {"status": "ok", "service": "feasly-api", "version": "0.1.0"},
}


class Handler(BaseHTTPRequestHandler):
    mode = "healthy"

    def _send(self, code, body, ctype="text/plain"):
        data = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path in ("/", "/privacy"):
            self._send(200, "ok")
        elif self.path == "/api/health":
            if self.mode == "http500":
                self._send(500, "boom")
            else:
                self._send(200, json.dumps(MODES[self.mode]),
                           "application/json")
        else:
            self._send(404, "not found")

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port, mode = int(sys.argv[1]), sys.argv[2]
    assert mode in MODES or mode == "http500", f"unknown mode {mode}"
    Handler.mode = mode
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
