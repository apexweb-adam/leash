# Leash policy engine image for a dstack CVM (NEAR AI Cloud / Phala Cloud).
# No secrets in the image: the signing seed is derived inside the TEE (LEASH_TEE=dstack).
# Pin the base image by digest before a real deploy: docker buildx imagetools inspect node:20-alpine
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
RUN npm ci --ignore-scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 LEASH_TEE=dstack
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
USER node
EXPOSE 8787
CMD ["node", "dist/server.js"]
