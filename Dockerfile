# =========================================================================
# Gesipan (게시판) — Dockerfile multi-stage
#
# Etapa 1: compila el binario en una imagen con Rust.
# Etapa 2: imagen final mínima (Debian slim) con solo el binario + certs.
# =========================================================================

# --- Etapa de build ---
FROM rust:1.97 AS build
WORKDIR /app

# Cache de dependencias: copiamos solo los manifests primero.
COPY Cargo.toml Cargo.lock ./
COPY src ./src
COPY web ./web
COPY tests ./tests

RUN cargo build --release

# --- Etapa final ---
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/target/release/gesipan /usr/local/bin/gesipan

# Directorio de datos + backups (montar como volumen)
ENV GESIPAN_HOST=0.0.0.0 \
    GESIPAN_PORT=8733 \
    GESIPAN_DATA=/data/gesipan.db \
    GESIPAN_BACKUP_DIR=/data/backups \
    GESIPAN_BACKUP_EVERY=3600 \
    GESIPAN_BACKUP_KEEP=24

VOLUME /data
EXPOSE 8733

CMD ["gesipan"]
