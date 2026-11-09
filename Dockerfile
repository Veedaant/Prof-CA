FROM node:22-slim AS web
WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend ./
RUN npm run build

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY server/package*.json server/
RUN npm --prefix server ci --omit=dev
COPY server server
COPY --from=web /app/frontend/dist frontend/dist
EXPOSE 8000
CMD ["node", "server/src/index.js"]
