# Repository contribution notes

- Before adding a file, decide whether it is required source, reproducible development material, or lasting public documentation. Put temporary plans, investigations, and verification notes in `.local-dev/`.
- Keep `.local-dev/`, local environment files, generated output, local database state, dumps, and credentials out of the repository. Add precise ignore rules when a new local artifact type appears.
- Do not broadly ignore Markdown, SQL, JSON, migrations, or tests. Keep files needed to build, test, deploy, secure, or understand the application.
- Update an existing permanent document when a design decision changes. Avoid creating overlapping task reports.
- Never place secrets, private keys, or personal database exports in public files. If one may already be in repository history, flag it for review and credential rotation as appropriate.
