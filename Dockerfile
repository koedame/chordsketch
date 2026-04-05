# Multi-stage Dockerfile for building ChordSketch from source.
# For pre-built multi-arch images, see ghcr.io/koedame/chordsketch.

FROM rust:1.85-bookworm AS builder

WORKDIR /build
COPY . .

RUN cargo build --release -p chordsketch && \
    cp target/release/chordsketch /usr/local/bin/chordsketch

FROM debian:bookworm-slim

COPY --from=builder /usr/local/bin/chordsketch /usr/local/bin/chordsketch

ENTRYPOINT ["/usr/local/bin/chordsketch"]
