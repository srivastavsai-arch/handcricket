"""Root Flask entrypoint for hosting platforms.

Platforms look for `app` in default locations (./app.py, ./wsgi.py).
The real app lives in backend/app.py — re-export it here.
"""
from backend.app import app, create_app  # noqa: F401

application = app

if __name__ == "__main__":
    import os
    port = int(os.environ.get("PORT", "5000"))
    app.run(host="0.0.0.0", port=port)
