import urllib.request

base = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4.1675469240/'
resources = [
    'hands.js',
    'hands_solution_packed_assets_loader.js', 
    'hands_solution_wasm_bin.js',
    'hands_solution_simd_wasm_bin.js',
    'hands.binarypb',
    'hand_landmark_lite.tflite',
    'hand_landmark_full.tflite'
]
for res in resources:
    try:
        req = urllib.request.Request(base + res, method='HEAD')
        r = urllib.request.urlopen(req, timeout=30)
        ct = r.headers.get("Content-Type")
        cl = r.headers.get("Content-Length")
        cors = r.headers.get("Access-Control-Allow-Origin")
        print(res + ": " + str(r.status) + " | CT: " + str(ct) + " | Len: " + str(cl) + " | CORS: " + str(cors))
    except Exception as e:
        print(res + ": ERROR - " + str(e))