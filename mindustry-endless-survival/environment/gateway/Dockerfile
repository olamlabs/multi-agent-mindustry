FROM node:22.14.0-bookworm
COPY LICENSE NOTICE.md /opt/licenses/
COPY environment/gateway/proxy.mjs /proxy.mjs
CMD ["node", "/proxy.mjs"]
