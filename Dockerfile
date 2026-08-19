# Multi-stage build for a small runtime image.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
# Host provides PORT; default 3000. MCP endpoint at $MCP_PATH (default /mcp).
EXPOSE 3000
CMD ["node", "dist/index.js"]
