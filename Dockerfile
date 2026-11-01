# NavShiksha test server: the API and web app on one port, with the demo data built into the image.
# Free hosts that run this: a Hugging Face Docker Space, or any Linux VM (e.g. Oracle Cloud Always Free).
# Needs about 1 GB of memory. Set NES_TEST_PASSCODE so only your testers can sign in.
FROM node:22-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build && npm run seed && chown -R node:node /app
# Hugging Face and most hosts run the container as user 1000 (node), which must be able to write the database.
USER node
ENV PORT=7860
EXPOSE 7860
CMD ["node", "scripts/start.mjs"]
