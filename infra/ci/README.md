# Remote Auth image build

Auth Docker builds run in the private repository `hunrabb/trangsuc-auth-build` on
GitHub-hosted `ubuntu-24.04`. Do not build images on the laptop that hosts etcd.
The workflow template is `auth-private-build.yml`; its copy in
`.github/workflows/auth-image.yml` is guarded so it cannot publish from the public
source repository. Keep the private repository's workflow in sync with the template.

Source is checked out from `hunrabb/trangsuc-microservice`, and its resolved full
commit SHA is recorded in the image tag and metadata. To build an explicit commit:

```bash
gh workflow run auth-image.yml --repo hunrabb/trangsuc-auth-build \
  -f source_sha=FULL_SOURCE_COMMIT_SHA
```

The job builds only `apps/auth/Dockerfile`, target `runtime`, `linux/amd64`, audits
its contents, publishes a private GHCR package, verifies visibility, and uploads
`private-auth-image` for three days. That artifact contains the same image as a
Docker archive plus `auth-image.json` with registry digest, config digest, source
SHA, and archive SHA256. Artifacts remain private with the workflow repository.
Only `contents: read` and `packages: write` are granted; no PAT or application
credentials are passed to the build.

A deployment must first verify remote run success, private visibility, archive
SHA256, config/layer identity, and Kubernetes/resource gates. Import into each
Worker separately and check API/etcd/Lease/disk I/O between steps. Use the exact
commit tag with `imagePullPolicy: Never` for a preloaded kind image. Registry,
archive OCI manifest, and config digests identify different objects; record all
three rather than requiring their strings to be equal.

Deploy Auth with one replica and pass health, dependency, JWT and resource gates
before scaling to two replicas with required hostname anti-affinity. Do not run
migrations, create accounts, alter Compose, or perform fault injection as part of
this rollout. The dedicated `[auth-image-only]` commit prefix skips the general
source CI on `feat/k8s-phase4`; ordinary CI behavior is unchanged for other commits.
