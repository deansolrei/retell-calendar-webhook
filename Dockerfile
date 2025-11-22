FROM node:18-slim

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json first for layer caching
COPY package*.json ./

# Install production dependencies
RUN npm ci --only=production

# Copy the rest of the application (includes GoogleCalendarWebhook.js and calendar-operations.js)
# Do not COPY credentials into /app if you intend to mount them as a secret.
COPY . .

# Optional: sanity check (can be removed later)
RUN ls -la /app/ && echo "Files copied successfully"

EXPOSE 8080
CMD ["node", "main.js"]