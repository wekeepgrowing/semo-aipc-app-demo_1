# syntax=docker/dockerfile:1.7

FROM node:22-trixie-slim AS ui-builder
WORKDIR /app/ui
COPY ui/package.json ui/package-lock.json* ./
RUN npm ci
COPY ui/ ./
RUN npm run build

FROM node:22-trixie-slim

ARG OPENCLAW_NPM_VERSION=2026.4.8
ARG INSTALL_HOMEBREW_AT_BUILD=1

RUN apt-get update && apt-get install -y --no-install-recommends \
  sudo \
  ca-certificates \
  curl \
  git \
  build-essential \
  python3 \
  procps \
  file \
  chromium \
  && rm -rf /var/lib/apt/lists/*

ENV HOME=/data
ENV TMPDIR=/data/.tmp
ENV TEMP=/data/.tmp
ENV TMP=/data/.tmp
WORKDIR /data
RUN mkdir -p /data && chown node:node /data

# OpenClaw runtime
RUN npm install -g "openclaw@${OPENCLAW_NPM_VERSION}"

# Persist global npm installs under app data
ENV NPM_CONFIG_PREFIX=/data/.npm-global

# Install UI gateway server deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && chown -R node:node /data /app

# Runtime app files
COPY --chown=node:node server.cjs /app/server.cjs
COPY --chown=node:node lib /app/lib
COPY --chown=node:node assets /app/assets
COPY --from=ui-builder --chown=node:node /app/ui/dist /app/ui/dist

RUN echo "node ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER node

# Homebrew for tool installs inside app sandbox
RUN if [ "${INSTALL_HOMEBREW_AT_BUILD}" = "1" ]; then \
      /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"; \
    else \
      sudo mkdir -p /home/linuxbrew; \
    fi

# Shim systemctl calls used by OpenClaw into process-level restarts
RUN printf '#!/bin/bash\ncmd=""\nfor arg in "$@"; do\n  case "$arg" in\n    -*) ;;\n    *) cmd="$arg"; break ;;\n  esac\ndone\ncase "$cmd" in\n  restart|stop) pkill -f "openclaw-gateway" 2>/dev/null || true ;;\n  start) echo "openclaw-gateway is managed by the container" ;;\n  *) exit 0 ;;\nesac\n' \
  | sudo tee /usr/local/bin/systemctl \
  && sudo chmod +x /usr/local/bin/systemctl

# Disable apt/apt-get at runtime and steer tool installs to Homebrew
RUN printf '#!/bin/bash\necho "Error: apt is disabled in this app sandbox. Use brew instead." >&2\necho "Example: brew install <package>" >&2\nexit 1\n' \
  | sudo tee /usr/local/bin/use-brew \
  && sudo chmod +x /usr/local/bin/use-brew \
  && sudo ln -sf /usr/local/bin/use-brew /usr/local/bin/apt \
  && sudo ln -sf /usr/local/bin/use-brew /usr/local/bin/apt-get

# Prepare home skeleton for persistent restore logic
RUN sudo mv /data /home-skeleton \
  && sudo mkdir -p /home-skeleton/linuxbrew \
  && if [ -d /home/linuxbrew ]; then sudo cp -a /home/linuxbrew/. /home-skeleton/linuxbrew/ 2>/dev/null || true; fi

ENV PATH="/data/.npm-global/bin:/home/linuxbrew/.linuxbrew/bin:/home/linuxbrew/.linuxbrew/sbin:${PATH}"

EXPOSE 18789
CMD ["node", "/app/server.cjs"]
