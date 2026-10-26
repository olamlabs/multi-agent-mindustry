FROM python:3.13-slim-trixie@sha256:7c61056e61ac89e852de05f3dc6fa51a6dd2181797bceed46aa725dd7cb2cd3b AS runtime
LABEL org.opencontainers.image.source="https://github.com/olamlabs/multi-agent-mindustry" \
      org.opencontainers.image.title="Mindustry Endless Survival runtime" \
      org.opencontainers.image.licenses="GPL-3.0-only"

RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-21-jdk-headless \
      xvfb xauth libgl1 libglx-mesa0 libgl1-mesa-dri libegl1 libasound2t64 \
      libxi6 libxcursor1 libxrandr2 libxinerama1 libxtst6 \
      ffmpeg fonts-dejavu-core xdotool ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*

RUN python -c "import hashlib, io, platform, tarfile, urllib.request; \
arch = {'x86_64': 'x64', 'aarch64': 'arm64'}[platform.machine()]; \
sha256 = {'x64': '69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec', 'arm64': '08bfbf538bad0e8cbb0269f0173cca28d705874a67a22f60b57d99dc99e30050'}[arch]; \
name = 'node-v22.14.0-linux-' + arch; \
data = urllib.request.urlopen('https://nodejs.org/dist/v22.14.0/' + name + '.tar.xz', timeout=600).read(); \
hashlib.sha256(data).hexdigest() == sha256 or exit('Node archive checksum mismatch'); \
archive = tarfile.open(fileobj=io.BytesIO(data), mode='r:xz'); \
__import__('os').makedirs('/opt/licenses', exist_ok=True); \
open('/opt/licenses/NODE-LICENSE', 'wb').write(archive.extractfile(name + '/LICENSE').read()); \
binary = archive.extractfile(name + '/bin/node').read(); \
open('/usr/bin/node', 'wb').write(binary)" \
 && chmod 0755 /usr/bin/node

COPY dependencies/ARC-LICENSE dependencies/SOURCES.md /opt/licenses/

ADD --checksum=sha256:f7b899a4038b95b14a824d5f8993984f79d73baa3254c385b6538327f9c0befd https://github.com/Anuken/Mindustry/releases/download/v160.7/server-release.jar /opt/mindustry/server.jar
ADD --checksum=sha256:36d94941a1639478ad1d9be25a9d802c6f77552f400c6da0338b7b019f63a0d1 https://github.com/Anuken/Mindustry/releases/download/v160.7/Mindustry.jar /opt/mindustry/Mindustry.jar
RUN chmod 0644 /opt/mindustry/*.jar \
 && ln -s Mindustry.jar /opt/mindustry/desktop.jar \
 && java -version && javac -version && node --version \
 && ffmpeg -hide_banner -filters 2>&1 | grep -q drawtext
WORKDIR /task

RUN mkdir -p /recordings

COPY seat-client/ /opt/mindustry/environment/seat-client/
COPY renderer/ /opt/mindustry/environment/renderer/
COPY sim/renderer.mjs /opt/mindustry/environment/sim/renderer.mjs
COPY dependencies/screen-recorder.mjs /opt/mindustry/environment/dependencies/screen-recorder.mjs

FROM runtime AS simulation
WORKDIR /app
COPY sim/ /app/sim/
COPY plugin/ /app/plugin/
COPY renderer/ /app/renderer/
COPY dependencies/ /app/dependencies/
COPY task-runtime/ /app/task-runtime/
RUN mkdir -p /logs/sim && chmod 0777 /logs/sim
EXPOSE 8080 9001
CMD ["node", "/app/task-runtime/seats.mjs", "--seat-clients"]
