FROM apify/actor-node:22
COPY package*.json ./
RUN npm install --include=dev
COPY . ./
RUN npm run build
# One-line change enables the debugger (activated by APIFY_NODE_DEBUGGER env var):
CMD ["npx", "apify-node-debugger"]
