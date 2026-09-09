import urllib.request
import re

req = urllib.request.Request('https://handcricketvas.vercel.app/')
r = urllib.request.urlopen(req, timeout=30)
body = r.read().decode('utf-8', errors='ignore')
print('=== BODY LENGTH ===', len(body))

# Check for script tags and their order
scripts = re.findall(r'<script[^>]*src=["\']([^"\']+)["\']', body)
print('=== SCRIPT TAGS IN ORDER ===')
for s in scripts:
    print(s)

# Check for CSP meta tag
csp_meta = re.findall(r'<meta[^>]*http-equiv=["\']Content-Security-Policy["\'][^>]*content=["\']([^"\']+)["\']', body, re.IGNORECASE)
print('=== CSP META TAGS ===')
for c in csp_meta:
    print(c[:200])

# Check for any inline scripts
inline_scripts = re.findall(r'<script[^>]*>([^<]*)</script>', body)
print('=== INLINE SCRIPT CONTENT (first 500 chars each) ===')
for i, s in enumerate(inline_scripts):
    if s.strip():
        print(f'Script {i}: {s.strip()[:500]}')

# Check the version/commit info in HTML comments or meta
print('=== LOOKING FOR VERSION INFO ===')
for line in body.split('\n')[:50]:
    if 'version' in line.lower() or 'commit' in line.lower() or 'vercel' in line.lower() or 'git' in line.lower():
        print(line.strip())