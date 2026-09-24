# Sidecar OpenHands du glm-agent-server — conteneur du MÊME pod que le serveur
# Node (k8s/glm-agent.yaml), qui l'appelle sur 127.0.0.1:8792.
#
# BUILD DEPUIS CE DOSSIER :
#   docker build -t ic-registry.epfl.ch/mr-pezeu/glm-agent-openhands:latest glm-agent-server/openhands-engine
FROM python:3.12-slim

WORKDIR /app

# requirements.txt est un `pip freeze` pris sous Windows : pywin32 n'existe pas
# sous Linux et ferait échouer l'installation.
COPY requirements.txt ./
RUN grep -viE '^pywin32(-ctypes)?==' requirements.txt > requirements-linux.txt \
 && pip install --no-cache-dir -r requirements-linux.txt

COPY main.py ./

# La conversation OpenHands prend le répertoire courant comme workspace et le
# SDK écrit sous $HOME : les deux doivent être writables par l'utilisateur.
ENV HOME=/app/home
RUN mkdir -p /app/home /app/work && chown -R nobody:nogroup /app/home /app/work
WORKDIR /app/work
USER nobody

ENV OPENHANDS_PORT=8792
EXPOSE 8792

# Écoute sur localhost seulement : seul le serveur Node du pod l'appelle.
CMD ["python", "-m", "uvicorn", "--app-dir", "/app", "main:app", "--host", "127.0.0.1", "--port", "8792"]
