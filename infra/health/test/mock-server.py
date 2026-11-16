#!/usr/bin/env python3
"""Tiny mock for checks.sh tests (HRD-06).

Usage: mock-server.py <port> <mode> [port-file]
  mode: healthy | degraded-db | no-checks | http500
  port 0 lets the OS pick a free port (#897: parallel test runs must not
  share a fixed port). When port-file is given, the bound port is written
  there (atomically) once the server is listening.

Serves:
  /           -> 200 "ok"
  /privacy    -> 200 "ok"
  /api/health -> JSON per mode (or 500 for http500)
Everything else -> 404.
"""
import json
import os
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
    port_file = sys.argv[3] if len(sys.argv) > 3 else None
    assert mode in MODES or mode == "http500", f"unknown mode {mode}"
    Handler.mode = mode
    server = HTTPServer(("127.0.0.1", port), Handler)
    if port_file:
        tmp = f"{port_file}.tmp"
        with open(tmp, "w") as f:
            f.write(str(server.server_address[1]))
        os.replace(tmp, port_file)
    server.serve_forever()
