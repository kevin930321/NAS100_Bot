FROM node:18-slim

WORKDIR /app

COPY package.json ./
RUN apt-get update && apt-get install -y tzdata && npm install --production

COPY . .

# 設置時區為 Asia/Taipei
ENV TZ=Asia/Taipei

CMD ["node", "trading-bot.js"]
