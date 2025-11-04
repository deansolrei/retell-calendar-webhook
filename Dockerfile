FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY main.js ./
COPY GoogleCalendarWebhook.js ./
# Do not COPY credentials into /app if you intend to mount them as a secret.
# If you have a credentials file bundled for local testing, you can COPY it with a different name:
# COPY retell-ai-agent-calendar-*.json ./retell-ai-agent-calendar-credentials.json
RUN ls -la /app/ && echo "Files copied successfully"
EXPOSE 8080
CMD ["node", "main.js"]