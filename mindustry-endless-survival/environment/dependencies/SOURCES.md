# Runtime sources and licenses

| Component | Pinned source / license | Build or distribution reference |
| --- | --- | --- |
| Mindustry v160.7 | [Anuken/Mindustry at 17012d61d9e4c3cbd9820d87e81c24495486ac53](https://github.com/Anuken/Mindustry/tree/17012d61d9e4c3cbd9820d87e81c24495486ac53), GPLv3; text in the task's `LICENSE` | [Source archive](https://github.com/Anuken/Mindustry/archive/17012d61d9e4c3cbd9820d87e81c24495486ac53.tar.gz); upstream README and Gradle build scripts describe desktop/server builds. The Dockerfile downloads unmodified, checksum-pinned official JARs. |
| Arc (Mindustry dependency) | [Anuken/Arc at 7445105cd2](https://github.com/Anuken/Arc/tree/7445105cd2), Apache-2.0; `ARC-LICENSE` | Revision from Mindustry's pinned `gradle.properties`. Preserve upstream notices for Arc and the other dependencies/assets declared by Mindustry's build and asset tree. |
| Node.js 22.14.0 | [Node v22.14.0](https://github.com/nodejs/node/tree/v22.14.0), MIT plus bundled dependency notices | Public nodejs.org archive; its complete `LICENSE` is extracted into `/opt/licenses/NODE-LICENSE`. |
| Python / Debian runtime; Java, Mesa, Xvfb, FFmpeg and fonts | Public Python/Node Docker base images and Debian distribution packages, under their respective licenses | Base image sources: [docker-library/python](https://github.com/docker-library/python), [nodejs/docker-node](https://github.com/nodejs/docker-node). Debian package copyright/license notices remain under `/usr/share/doc/`; preserve them. |

The bridge, viewer, API, seat client and build scripts are shipped as source in
this task. GPL text and the task's licensing scope are in the task's `LICENSE` and
`NOTICE.md`. The image keeps this file, `ARC-LICENSE` and the Node.js license under
`/opt/licenses/`.

For binary redistribution, provide complete corresponding source for the exact
image and its GPL-covered non-system components as described in `NOTICE.md`;
listing source URLs alone is not a complete binary-release compliance process.
