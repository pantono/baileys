FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package*.json ./
RUN npm install --omit=dev

COPY src ./src
COPY utils ./utils
COPY .env.example ./.env.example
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["npm", "start"]
