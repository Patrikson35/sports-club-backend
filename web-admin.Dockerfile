# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy web-admin package files from parent directory
COPY ../web-admin/package*.json ./

# Install dependencies
RUN npm ci

# Copy web-admin source code
COPY ../web-admin/ ./

# Build for production
RUN npm run build

# Production stage
FROM nginx:alpine

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration
COPY web-admin-nginx.conf /etc/nginx/conf.d/default.conf

# Expose port
EXPOSE 80

# Start nginx
CMD ["nginx", "-g", "daemon off;"]
