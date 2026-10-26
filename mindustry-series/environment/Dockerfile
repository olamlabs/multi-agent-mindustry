FROM python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS runtime
LABEL org.opencontainers.image.source="https://github.com/olamlabs/multi-agent-mindustry" \
      org.opencontainers.image.title="Mindustry series game runtime" \
      org.opencontainers.image.licenses="GPL-3.0-only"

RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-21-jdk-headless \
      xvfb xauth libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libasound2t64 \
      libxi6 libxcursor1 libxrandr2 libxinerama1 libxtst6 \
      ffmpeg fonts-dejavu-core xdotool ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN python -c "import hashlib, io, platform, tarfile, urllib.request; \
arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]; \
sha256 = {'x64': '69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec', 'arm64': '08bfbf538bad0e8cbb0269f0173cca28d705874a67a22f60b57d99dc99e30050'}[arch]; \
name = 'node-v22.14.0-linux-' + arch; \
data = urllib.request.urlopen('https://nodejs.org/dist/v22.14.0/' + name + '.tar.xz', timeout=600).read(); \
hashlib.sha256(data).hexdigest() == sha256 or exit('Node archive checksum mismatch'); \
archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:xz'); \
binary = archive.extractfile(name + '/bin/node').read(); \
__import__('os').makedirs('/opt/licenses', exist_ok=True); \
open('/opt/licenses/NODE-LICENSE', 'wb').write(archive.extractfile(name + '/LICENSE').read()); \
open('/usr/bin/node', 'wb').write(binary)" \
 && chmod 0755 /usr/bin/node

COPY LICENSE NOTICE environment/dependencies/*LICENSE environment/dependencies/SOURCES.md /opt/licenses/

ADD --checksum=sha256:f7b899a4038b95b14a824d5f8993984f79d73baa3254c385b6538327f9c0befd https://github.com/Anuken/Mindustry/releases/download/v160.7/server-release.jar /opt/mindustry/server.jar
ADD --checksum=sha256:36d94941a1639478ad1d9be25a9d802c6f77552f400c6da0338b7b019f63a0d1 https://github.com/Anuken/Mindustry/releases/download/v160.7/Mindustry.jar /opt/mindustry/Mindustry.jar
RUN chmod 0644 /opt/mindustry/*.jar \
 && ln -s Mindustry.jar /opt/mindustry/desktop.jar \
 && java -version && javac -version && node --version \
 && ffmpeg -hide_banner -filters 2>&1 | grep -q drawtext
COPY LICENSE NOTICE /opt/mindustry/
WORKDIR /task

ADD --checksum=sha256:9708a99717b5a951453c2ff7c14c25d3418d02ca7fcb96fdb382a8f2083bab5e https://github.com/erebe/wstunnel/releases/download/v11.0.0/wstunnel_11.0.0_linux_amd64.tar.gz /tmp/wstunnel.tar.gz
RUN tar -xzf /tmp/wstunnel.tar.gz -C /usr/local/bin wstunnel \
 && chmod 0755 /usr/local/bin/wstunnel \
 && rm /tmp/wstunnel.tar.gz \
 && mkdir -p /recordings

COPY environment/seat-client/ /opt/mindustry/environment/seat-client/
COPY environment/renderer/ /opt/mindustry/environment/renderer/
COPY environment/sim/renderer.mjs /opt/mindustry/environment/sim/renderer.mjs
COPY environment/dependencies/screen-recorder.mjs /opt/mindustry/environment/dependencies/screen-recorder.mjs

FROM runtime AS simulation
WORKDIR /app
COPY environment/sim/ /app/sim/
COPY environment/plugin/ /app/plugin/
COPY LICENSE NOTICE /
COPY environment/renderer/ /app/renderer/
COPY environment/dependencies/ /app/dependencies/
COPY instruction.md /instruction.md
RUN mkdir -p /logs/sim
EXPOSE 8080 9000 9001
CMD ["node", "/app/sim/seats.mjs", "--seat-clients"]
