FROM apify/actor-node:22

# The debug session is a real OpenSSH server inside the run. The platform publishes no raw TCP
# port for a container, so sshd listens on loopback only and the single route to it is the
# WebSocket bridge this Actor serves on ACTOR_WEB_SERVER_PORT (see src/ssh_bridge.ts).
# sshd needs root to authenticate a login, hence the explicit USER root.
USER root
RUN apk add --no-cache openssh-server openssh-keygen \
    && mkdir -p /var/empty /run/sshd \
    && apk info -v openssh-server

COPY package*.json ./
RUN npm install --include=dev --audit=false --fund=false \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version

COPY . ./
RUN npm run build

CMD ["node", "dist/main.js"]
