# Imagem única (Render, Railway, Fly...): a API Express também serve o front compilado.
# O worker, o agendador e a limpeza rodam no mesmo processo (plano grátis); a fila no banco permite separar depois.

FROM node:22-alpine AS front
WORKDIR /front
# IDs públicos do GA4 e do Clarity (opcionais). No Render, as variáveis de ambiente chegam aqui como build args.
ARG VITE_GA_ID=""
ARG VITE_CLARITY_ID=""
ENV VITE_GA_ID=$VITE_GA_ID VITE_CLARITY_ID=$VITE_CLARITY_ID
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-alpine AS back
WORKDIR /back
COPY backend/package*.json ./
RUN npm ci
COPY backend/tsconfig*.json ./
COPY backend/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production STATIC_DIR=/app/public PORT=3002
COPY --from=back /back/package.json ./
COPY --from=back /back/node_modules ./node_modules
COPY --from=back /back/dist ./dist
COPY backend/migrations ./migrations
COPY --from=front /front/dist ./public
EXPOSE 3002
USER node
CMD ["node", "dist/index.js"]
