import urllib.request
import difflib

# Check the actual deployed index.html vs local
r = urllib.request.urlopen('https://handcricketvas.vercel.app/', timeout=30)
deployed = r.read().decode('utf-8', errors='ignore')

# Read local
with open('frontend/index.html', 'r', encoding='utf-8') as f:
    local = f.read()

print('Deployed length:', len(deployed))
print('Local length:', len(local))
print('Match:', deployed == local)

# Find differences
diff = list(difflib.unified_diff(local.splitlines(), deployed.splitlines(), lineterm=''))
if diff:
    print('First 30 diff lines:')
    for line in diff[:30]:
        print(line)
else:
    print('Files are identical')