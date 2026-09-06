"""Flask entrypoint — serves the API + the static frontend prototype."""
from __future__ import annotations

import os
from flask import Flask, send_from_directory
from flask_cors import CORS

from .routes import api

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND_DIR = os.path.join(BASE_DIR, "frontend")


def create_app() -> Flask:
    app = Flask(__name__, static_folder=FRONTEND_DIR, static_url_path="")
    CORS(app)
    app.register_blueprint(api)

    @app.get("/")
    def index():
        return send_from_directory(FRONTEND_DIR, "index.html")

    @app.get("/health")
    def health():
        return {"ok": True, "game": "hand-cricket", "version": "2-prototype"}

    return app


app = create_app()

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    print(f"Hand Cricket prototype on http://127.0.0.1:{port}")
    app.run(host="127.0.0.1", port=port, debug=True)
