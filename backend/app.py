"""Flask entrypoint — serves the API + the static frontend prototype."""
from __future__ import annotations

import os
from flask import Flask, send_from_directory
from flask_cors import CORS

from .routes import api

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")


def _cors_origins() -> list[str]:
    """Allowed browser origins for /api/*. Same-origin needs no CORS;
    this list covers the public frontend plus local dev servers.
    Override with HC_CORS_ORIGINS=https://a.example,https://b.example"""
    raw = os.environ.get("HC_CORS_ORIGINS", "").strip()
    if raw:
        return [o.strip() for o in raw.split(",") if o.strip()]
    return [
        "https://handcricketvas.vercel.app",
        "http://127.0.0.1:5000",
        "http://localhost:5000",
        "http://127.0.0.1:5501",
        "http://localhost:5501",
    ]


def _content_security_policy() -> str:
    # Every network origin this page legitimately uses (verified against
    # index.html / camera-input.js / privacy.html — no inline scripts,
    # handlers, or style attributes exist, so no 'unsafe-inline' needed):
    #   self                  — game scripts, styles, gesture SVGs, /api
    #   cdn.jsdelivr.net       — MediaPipe Hands loader + model files
    #   fonts.googleapis.com  — stylesheets | fonts.gstatic.com — font files
    # blob:/data: cover the camera preview overlay and font loading.
    # worker-src blob: is included defensively for the tracking runtime.
    return (
        "default-src 'self'; "
        "script-src 'self' https://cdn.jsdelivr.net; "
        "style-src 'self' https://fonts.googleapis.com; "
        "font-src 'self' https://fonts.gstatic.com data:; "
        "img-src 'self' data: blob:; "
        "media-src 'self' blob:; "
        "connect-src 'self' https://cdn.jsdelivr.net; "
        "worker-src 'self' blob:; "
        "object-src 'none'; base-uri 'self'; form-action 'self'; "
        "frame-ancestors 'self'"
    )


def create_app() -> Flask:
    app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
    # Game API is unauthenticated and carries no secrets or personal data
    # (session id + difficulty + moves only). Origins are allowlisted to
    # the real frontend(s) so random third-party sites cannot drive the
    # API from visitors' browsers. Scoped to /api/* (no CORS on pages).
    CORS(app, resources={r"/api/*": {"origins": _cors_origins()}})
    app.register_blueprint(api)

    @app.after_request
    def _security_headers(resp):
        # None of these block same-origin play, the jsDelivr MediaPipe
        # load, Google Fonts, or getUserMedia camera use.
        resp.headers.setdefault("X-Content-Type-Options", "nosniff")
        resp.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        resp.headers.setdefault("X-Frame-Options", "SAMEORIGIN")
        resp.headers.setdefault("Content-Security-Policy", _content_security_policy())
        # Camera allowed for this site only; mic/geolocation unused → denied.
        resp.headers.setdefault(
            "Permissions-Policy", "camera=(self), microphone=(), geolocation=()"
        )
        return resp

    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/privacy")
    def privacy():
        return send_from_directory(FRONTEND_DIR, "privacy.html")

    @app.get("/report")
    def report():
        return send_from_directory(FRONTEND_DIR, "report.html")

    @app.get("/health")
    def health():
        return {"ok": True, "game": "hand-cricket", "version": "2-prototype"}

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"Hand Cricket prototype on http://127.0.0.1:{port}")
    # Debug mode is opt-in only (FLASK_DEBUG=1). Never on in production:
    # the Werkzeug debugger can execute code and must not be exposed.
    debug = os.environ.get("FLASK_DEBUG", "").lower() in ("1", "true", "yes")
    app.run(host="127.0.0.1", port=port, debug=debug)
