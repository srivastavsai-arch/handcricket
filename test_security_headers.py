"""Regression tests for the production security headers (backend/app.py).

Root cause these guard: the MediaPipe Hands tracker runs entirely in
WebAssembly, and Chrome/Edge refuse to compile/instantiate WASM unless
script-src contains 'wasm-unsafe-eval'. Without it the camera preview
still works but no landmarks are ever returned, so the exoskeleton and
gesture detection silently never appear in any environment served by
this Flask app (e.g. the Vercel deployment) — while a header-less local
server (VS Code Live Server) keeps working. These tests pin the exact
header contract that keeps production camera detection alive.
"""
from backend.app import create_app


def _csp():
    c = create_app().test_client()
    return c.get("/").headers.get("Content-Security-Policy", "")


def test_csp_allows_mediapipe_wasm():
    csp = _csp()
    assert "'wasm-unsafe-eval'" in csp, (
        "script-src must allow WASM or production camera detection dies: " + csp
    )


def test_csp_still_blocks_inline_scripts_and_eval():
    csp = _csp()
    assert "'unsafe-inline'" not in csp
    # 'wasm-unsafe-eval' contains the substring 'unsafe-eval'; check the
    # standalone token only so the WASM allowance is not mistaken for eval().
    tokens = csp.replace(";", " ").split()
    assert "'unsafe-eval'" not in tokens


def test_csp_still_allows_mediapipe_cdn():
    csp = _csp()
    assert "https://cdn.jsdelivr.net" in csp
    assert "connect-src" in csp and "script-src" in csp
    assert "worker-src" in csp and "blob:" in csp


def test_camera_permission_policy_intact():
    c = create_app().test_client()
    pp = c.get("/").headers.get("Permissions-Policy", "")
    assert "camera=(self)" in pp
