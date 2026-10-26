# License and attribution

Unless a file states otherwise, the original code, scripts and documentation in
this task folder are licensed under GNU GPL version 3 only (`GPL-3.0-only`).
See [LICENSE](LICENSE). This notice applies to this task folder, not other tasks
in the surrounding repository. There is no warranty; see the license.

This task integrates **Mindustry v160.7**, by Anuken and contributors. Its server
and desktop JARs are downloaded unmodified from the official release. The native
bridge and spectator viewer are additional GPLv3 modules built from the Java
source included here; they do not replace the upstream JARs. The extracted
content descriptions retain their upstream provenance in
`environment/plugin/resources/agentbridge/SOURCES.md`.

Changes dated 2026-10-24: standalone packaging, Harbor Multiagent
lifecycle integration, a task-specific survival profile and verifier, and
screen recording.
These are task/module changes, not claims of upstream authorship or endorsement.

Third-party dependencies retain their own licenses; the task's license does not
relicense them. Exact upstream revisions, sources, licenses and build references
are listed in `environment/dependencies/SOURCES.md`. Preserve this notice, the GPL text,
and third-party notices when redistributing the task.

## Distributing built images or JARs

The provided Dockerfiles build locally from public dependencies. If you distribute
built images or JARs, also provide the complete Corresponding Source required by
GPLv3 section 6 for the exact distributed version, including this task's modified
modules, build/install scripts and required non-system dependencies. Make that
source freely accessible to recipients with clear directions alongside the binary
download, and keep it available for as long as you distribute the binary. A link
to an unrelated repository revision or only an upstream release page is not enough.
Preserve upstream dependency and asset notices. The upstream source links below
identify versions; they do not replace the distributor's responsibility to make
complete corresponding source available.
