FROM node:20-bullseye

WORKDIR /app

# Install sqlite dependencies
RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    sqlite3 \
    libsqlite3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY app/package*.json ./

RUN npm install

COPY app .

EXPOSE 5050

CMD ["node", "server.js"]
