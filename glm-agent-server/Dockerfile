# glm-agent-server — backend agent (harness Claude Code ou OpenHands + GLM-5.3-Flash via RCP)
#
# BUILD DEPUIS LA RACINE DU REPO (le serveur lit assets/skills du repo parent) :
#   docker build -f glm-agent-server/Dockerfile -t ic-registry.epfl.ch/mr-pezeu/glm-agent-server:latest .
#
# node:20-slim (Debian, glibc) plutôt qu'alpine : le Claude Agent SDK embarque
# des binaires vendorés (ripgrep, wasm) compilés pour glibc.
FROM node:20-slim

WORKDIR /app/glm-agent-server

COPY glm-agent-server/package.json glm-agent-server/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY glm-agent-server/tsconfig.json ./
COPY glm-agent-server/src ./src
# Skills partagés avec l'add-in (skills.ts résout ../../assets/skills)
COPY assets/skills /app/assets/skills

# Le SDK écrit ses sessions sous $HOME/.claude — répertoire dédié writable
ENV HOME=/app/home
RUN mkdir -p /app/home && chown -R node:node /app
USER node

ENV PORT=8790
ENV USER_TIMEZONE=Europe/Zurich
EXPOSE 8790

CMD ["npx", "tsx", "src/server.ts"]
