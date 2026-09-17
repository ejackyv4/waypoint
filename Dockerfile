FROM node:24-bookworm-slim

WORKDIR /app
COPY spike /app/spike

ENV APP_PORT=8090 \
    CONTENT_PORT=8091 \
    SAAS_PORT=8092 \
    WAYPOINT_BIND_HOST=0.0.0.0 \
    WAYPOINT_DATA_DIR=/var/lib/waypoint

EXPOSE 8090 8091 8092
VOLUME ["/var/lib/waypoint"]

CMD ["node", "--env-file=spike/.env", "spike/api/server.mjs"]
