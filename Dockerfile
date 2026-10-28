# debian rather than alpine: torch and tensorflow have no wheels for alpine's libc
FROM node:18-bookworm-slim AS base

FROM base AS deps

WORKDIR /app

COPY package.json yarn.lock ./

RUN yarn config set registry 'https://registry.npmmirror.com/'
RUN yarn install

FROM base AS builder

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

ENV OPENAI_API_KEY=""
ENV GOOGLE_API_KEY=""
ENV CODE=""

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN yarn build

FROM base AS runner
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends proxychains4 \
    python3 python3-venv ffmpeg git ca-certificates && rm -rf /var/lib/apt/lists/*
# python for the code execution tool's runs on the server (app/api/code-exec),
# which run as nobody, so nobody can install packages into it
RUN python3 -m venv /opt/venv && chown -R 65534:65534 /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

ENV PROXY_URL=""
ENV OPENAI_API_KEY=""
ENV GOOGLE_API_KEY=""
ENV CODE=""
ENV ENABLE_MCP=""
# python3 to run code on the server; off when empty
ENV CODE_SERVER_PYTHON=""

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/.next/server ./.next/server

RUN mkdir -p /app/app/mcp && chmod 777 /app/app/mcp
COPY --from=builder /app/app/mcp/mcp_config.default.json /app/app/mcp/mcp_config.json
COPY --from=builder /app/app/api/code-exec/runner.py /app/app/api/code-exec/runner.py

EXPOSE 3000

CMD if [ -n "$PROXY_URL" ]; then \
    export HOSTNAME="0.0.0.0"; \
    protocol=$(echo $PROXY_URL | cut -d: -f1); \
    host=$(echo $PROXY_URL | cut -d/ -f3 | cut -d: -f1); \
    port=$(echo $PROXY_URL | cut -d: -f3); \
    conf=/etc/proxychains.conf; \
    echo "strict_chain" > $conf; \
    echo "proxy_dns" >> $conf; \
    echo "remote_dns_subnet 224" >> $conf; \
    echo "tcp_read_time_out 15000" >> $conf; \
    echo "tcp_connect_time_out 8000" >> $conf; \
    echo "localnet 127.0.0.0/255.0.0.0" >> $conf; \
    echo "localnet ::1/128" >> $conf; \
    echo "[ProxyList]" >> $conf; \
    echo "$protocol $host $port" >> $conf; \
    cat /etc/proxychains.conf; \
    proxychains4 -f $conf node server.js; \
    else \
    node server.js; \
    fi
