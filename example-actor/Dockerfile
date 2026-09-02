FROM apify/actor-node:22
COPY package*.json ./
RUN npm install --include=dev
COPY . ./
RUN npm run build
# One-line change enables the debugger (revert to the normal entrypoint to disable):
CMD ["npx", "actor-debugger"]
