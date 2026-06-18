FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG ENTRA_CLIENT_ID
ARG ENTRA_TENANT_ID
ARG BUILD_TIME
ENV ENTRA_CLIENT_ID=$ENTRA_CLIENT_ID
ENV ENTRA_TENANT_ID=$ENTRA_TENANT_ID
ENV BUILD_TIME=$BUILD_TIME
RUN npx webpack --mode production --env k8s

FROM nginx:alpine
COPY k8s/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
