"""WSGI entrypoint (gunicorn wsgi:app)."""
from backend.app import app, create_app  # noqa: F401

application = app
