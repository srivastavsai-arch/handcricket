import urllib.request

# Check CSP on GET request (what browsers use)
req = urllib.request.Request('https://handcricketvas.vercel.app/')
r = urllib.request.urlopen(req, timeout=30)
csp = r.headers.get('Content-Security-Policy')
print('CSP from GET:')
print(csp)
print()
print('Has wasm-unsafe-eval:', "'wasm-unsafe-eval'" in csp)
tokens = csp.replace(';', ' ').split()
has_unsafe_eval = "'unsafe-eval'" in tokens
has_wasm_unsafe = "'wasm-unsafe-eval'" in tokens
print('Has unsafe-eval (standalone):', has_unsafe_eval)
print('Has wasm-unsafe-eval:', has_wasm_unsafe)

# Also check all security headers
print()
print('=== ALL SECURITY HEADERS ===')
for k in ['Content-Security-Policy', 'Permissions-Policy', 'Cross-Origin-Embedder-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security']:
    print(k + ':', r.headers.get(k))