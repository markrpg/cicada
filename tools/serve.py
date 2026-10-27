#!/usr/bin/env python3
"""Serve web/ over HTTPS on the LAN so a phone's browser allows the microphone.

Usage: python3 tools/serve.py [port]   (default 8443)
"""
import functools, http.server, pathlib, socket, ssl, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
CERT_DIR = ROOT / ".cert"  # outside web/, so the key is never served


def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def ensure_cert(ip):
    cert, key, stamp = CERT_DIR / "cert.pem", CERT_DIR / "key.pem", CERT_DIR / "ip.txt"
    if cert.exists() and key.exists() and stamp.exists() and stamp.read_text() == ip:
        return cert, key
    CERT_DIR.mkdir(exist_ok=True)
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "365",
         "-keyout", str(key), "-out", str(cert), "-subj", "/CN=cicada",
         "-addext", f"subjectAltName=IP:{ip},IP:127.0.0.1,DNS:localhost"],
        check=True, capture_output=True)
    stamp.write_text(ip)
    return cert, key


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8443
    ip = lan_ip()
    cert, key = ensure_cert(ip)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(WEB))
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", port), handler)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, key)
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
    print(f"Mac:   https://localhost:{port}")
    print(f"Phone: https://{ip}:{port}   (same Wi-Fi; tap Advanced → Proceed on the certificate warning)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
