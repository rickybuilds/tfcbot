FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY upstream/src ./upstream/src
RUN npm run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production NONAME_PARSER_HOST=0.0.0.0 NONAME_PARSER_PORT=3210 NONAME_PARSER_DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY --from=build /app/dist ./dist
COPY upstream/LICENSE ./LICENSE
USER node
VOLUME /data
EXPOSE 3210
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3210/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
