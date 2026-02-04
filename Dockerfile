FROM node:22-slim

WORKDIR /app

# Install Playwright's own Chromium + system dependencies
# This ensures the exact browser revision that playwright-core expects
COPY package.json package-lock.json* ./
RUN npm install
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/index.js"]
