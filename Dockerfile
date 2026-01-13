FROM node:18-alpine

# Install minimal dependencies for Puppeteer on Alpine
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    font-noto-cjk

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node dependencies
RUN npm ci --only=production

# Copy app files
COPY . .

# Create data directory for database
RUN mkdir -p /app/data

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000', (r) => {if (r.statusCode !== 200) throw new Error(r.statusCode)})"

# Run app
CMD ["node", "app.js"]
