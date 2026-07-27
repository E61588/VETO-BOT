# Official Microsoft Playwright image already ships Chromium/Firefox/WebKit
# plus all required OS-level dependencies, so we don't need to run
# `playwright install-deps` ourselves.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Install dependencies first for better layer caching
COPY package*.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

# Ensure the screenshots directory exists and is writable
RUN mkdir -p /app/screenshots

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
