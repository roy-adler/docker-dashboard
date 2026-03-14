FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV PORT=3000
ENV LAYOUT_STORE_PATH=/data/layout.json
VOLUME ["/data"]
EXPOSE 3000

CMD ["npm", "start"]
