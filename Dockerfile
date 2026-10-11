# One image for the whole platform: the API, the job worker and the built web app (D90).
# Build: docker build -t email-platform .
# Run:   docker run -p 8787:8787 --env-file .env -e NODE_ENV=production email-platform

FROM node:22.22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/content/package.json packages/content/
COPY packages/db/package.json packages/db/
COPY packages/engine/package.json packages/engine/
COPY packages/sdk/package.json packages/sdk/
COPY infra/package.json infra/
# The AWS setup (infra) is not part of the image, so its packages are not installed.
RUN pnpm install --frozen-lockfile --filter "@platform/api..." --filter "@platform/web..."
COPY . .
RUN pnpm --filter @platform/web build
# Only what the API needs at run time, workspace packages included.
RUN pnpm --filter @platform/api deploy --prod --legacy /out

FROM node:22.22-slim
ENV NODE_ENV=production PORT=8787 WEB_DIST=/app/web
WORKDIR /app/api
COPY --from=build /out /app/api
COPY --from=build /repo/apps/web/dist /app/web
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/server.ts"]
