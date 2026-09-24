"""Test de fumée du sidecar OpenHands, contre RCP, DANS l'image construite.

Lancé par run-smoke.ps1 avant tout push : le sidecar tourne dans le même
conteneur (127.0.0.1:8792). Chaque cas couvre une panne déjà rencontrée ou
possible : réflexion qui fuit dans la réponse, image supprimée par le SDK
(24.09.2026 : OpenHands forçait le texte seul pour les modèles « glm »),
historique rejoué ignoré, aller-retour d'outil cassé.

Consomme quelques milliers de jetons RCP. Stdlib seulement.
"""
import base64
import json
import struct
import sys
import threading
import time
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, HTTPServer

BASE = "http://127.0.0.1:8792"
CALLBACK_PORT = 8799


def wait_health(timeout=120):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return json.load(urllib.request.urlopen(f"{BASE}/health", timeout=3))
        except Exception:  # noqa: BLE001
            time.sleep(2)
    raise SystemExit("ÉCHEC : le sidecar ne répond pas sur /health")


# Faux serveur Node : exécute les outils demandés par le sidecar.
TOOL_CALLS = []


class ToolHandler(BaseHTTPRequestHandler):
    def do_POST(self):  # noqa: N802
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        TOOL_CALLS.append(body)
        result = {"results": [{"number": 1, "text": "Le projet stocke les données sur un serveur EPFL à Lausanne."}]}
        out = json.dumps({"ok": True, "result": json.dumps(result)}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *args):
        pass


def red_blue_png():
    """64×64 : moitié gauche rouge, moitié droite bleue."""
    w = h = 64
    rows = b"".join(
        b"\x00" + b"".join((b"\xff\x00\x00" if x < 32 else b"\x00\x00\xff") for x in range(w))
        for _ in range(h)
    )

    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))
    return "data:image/png;base64," + base64.b64encode(png).decode()


def run(message, *, effort="low", images=None, tools=None, system="Réponds en français, brièvement."):
    body = {
        "run_id": f"smoke-{time.time()}",
        "system_prompt": system,
        "message": message,
        "tools": tools or [],
        "callback_url": f"http://127.0.0.1:{CALLBACK_PORT}/exec",
        "max_iterations": 5,
        "reasoning_effort": effort,
        "ephemeral": True,
        "images": images or [],
    }
    req = urllib.request.Request(f"{BASE}/run", data=json.dumps(body).encode(),
                                 headers={"content-type": "application/json"})
    lines = [json.loads(l) for l in urllib.request.urlopen(req, timeout=240).read().decode().strip().split("\n")]
    err = next((l for l in lines if l["type"] == "error"), None)
    if err:
        raise AssertionError(f"erreur du sidecar : {err['message'][:200]}")
    text = "".join(l.get("text", "") for l in lines if l["type"] == "text_delta") or next(
        (l["text"] for l in lines if l["type"] == "result"), "")
    thinking = "".join(l.get("text", "") for l in lines if l["type"] == "thinking_delta")
    return text, thinking


def case_reasoning_low():
    text, thinking = run("Combien font 17 x 23 ? Réponds juste par le nombre.", effort="low")
    assert "391" in text, f"réponse attendue 391 : {text[:120]!r}"
    # Garde-fou de la panne GLM : la réflexion ne doit pas se déverser dans la réponse.
    assert len(text) < 200, f"réponse anormalement longue (réflexion qui fuit ?) : {text[:200]!r}"


def case_reasoning_free():
    text, thinking = run("Un train part à 14h12 et arrive à 17h05. Combien de minutes dure le trajet ?", effort=None)
    assert "173" in text, f"réponse attendue 173 : {text[:160]!r}"
    assert thinking.strip(), "réflexion libre : aucun thinking_delta reçu (réflexion perdue ou coupée)"
    assert thinking.strip()[:60] not in text, "la réflexion apparaît dans la réponse"


def case_image():
    text, _ = run("Quelles sont les deux couleurs de cette image ?", images=[red_blue_png()])
    low = text.lower()
    assert "rouge" in low and "bleu" in low, f"image non lue : {text[:160]!r}"


def case_history():
    msg = ("Historique de la conversation, pour le contexte (ne pas y répondre à nouveau) :\n"
           "<historique>\nUtilisateur : Je m'appelle Chiara.\n\nAssistant : Enchantée !\n</historique>\n\n"
           "Nouvelle demande de l'utilisateur :\nComment je m'appelle ?")
    text, _ = run(msg)
    assert "chiara" in text.lower(), f"historique ignoré : {text[:160]!r}"


def case_tool_with_image():
    TOOL_CALLS.clear()
    tools = [{
        "name": "search_local",
        "description": "Recherche dans les documents de l'utilisateur. À utiliser pour toute question sur le projet.",
        "parameters": {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
    }]
    text, _ = run("Où le projet stocke-t-il les données ? Et quelles couleurs sur l'image ?",
                  images=[red_blue_png()], tools=tools,
                  system="Réponds en français. Utilise search_local pour les questions sur le projet.")
    assert TOOL_CALLS, "l'agent n'a appelé aucun outil"
    assert "lausanne" in text.lower(), f"résultat d'outil non utilisé : {text[:200]!r}"


CASES = [
    ("réflexion coupée", case_reasoning_low),
    ("réflexion libre, séparée de la réponse", case_reasoning_free),
    ("lecture d'une image", case_image),
    ("historique rejoué", case_history),
    ("appel d'outil + image dans le même tour", case_tool_with_image),
]


def main():
    health = wait_health()
    print(f"sidecar prêt : {health}")
    srv = HTTPServer(("127.0.0.1", CALLBACK_PORT), ToolHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    failed = 0
    for name, fn in CASES:
        t = time.time()
        try:
            fn()
            print(f"  OK    {name} ({time.time() - t:.1f} s)")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"  ÉCHEC {name} : {e}")
    print(f"{len(CASES) - failed}/{len(CASES)} cas passés")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
