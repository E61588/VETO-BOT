# VETO bot — Cloud Run job image (also runs server mode with: node server.js)
# The official Playwright image ships Chromium and its system libraries for
# exactly this Playwright version.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY . .

# Never run as root inside the container.
USER pwuser

# Default: run one task (Cloud Run job). JOB_ID is set per execution.
CMD ["node", "job.js"]
