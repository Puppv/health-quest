FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Railway/Render both set PORT at runtime and route to whatever server.js
# binds it to (see server.js's `process.env.PORT ?? 4000`) — no EXPOSE
# value here overrides that, it's just documentation for local `docker run`.
EXPOSE 4000

CMD ["node", "src/server.js"]
