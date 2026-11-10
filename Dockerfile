# Multi-stage Dockerfile for building ChordSketch from source.
# For pre-built multi-arch images, see ghcr.io/koedame/chordsketch.

# Builder stage pinned to its sha256 manifest list digest for the same
# reason the runtime stage is below: a tag republish on Docker Hub could
# otherwise produce a tampered builder that quietly compiles malicious
# binary into the trusted runtime layer. The tag is kept alongside the
# digest so Dependabot can correlate the bump. See #1103.
FROM rust:1.99-bookworm@sha256:e6f2cff35d0f309acf8433b4f05878ed77092602c5065cc81801177da0bb3a9c AS builder

WORKDIR /build
COPY . .

# The runtime stage has no zlib, so link it statically instead of leaving a
# `libz.so.1` dependency the Distroless image cannot satisfy.
ENV LIBZ_SYS_STATIC=1

RUN cargo build --release --locked -p chordsketch && \
    cp target/release/chordsketch /usr/local/bin/chordsketch

# Distroless cc: glibc and libgcc, no shell and no package manager. The
# Debian release matches the builder stage (bookworm) so the glibc the
# binary links against is the one it runs on. `nonroot` runs as uid 65532.
# Pinned to the tag AND its sha256 manifest list digest so a tag republish
# cannot silently change the image we ship. The tag is kept alongside the
# digest so Dependabot can correlate the bump. See #1070, #1100.
FROM gcr.io/distroless/cc-debian12:nonroot@sha256:9dac0a79194e45a7da0158a9c6da57b217585af0786db3845d1f0ec1a0dd182f

COPY --from=builder /usr/local/bin/chordsketch /usr/local/bin/chordsketch
COPY --from=builder /build/LICENSE /build/NOTICE /build/THIRD_PARTY_LICENSES.md /usr/share/licenses/chordsketch/

ENTRYPOINT ["/usr/local/bin/chordsketch"]
