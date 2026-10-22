FROM ubuntu:26.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  build-essential wget cpio rsync bc unzip file python3 perl git libncurses-dev ca-certificates \
  device-tree-compiler bison flex libssl-dev libelf-dev xz-utils gzip patch texinfo gawk help2man autoconf automake libtool pkg-config lz4 zstd \
  && rm -rf /var/lib/apt/lists/*
# build as the uid that owns the mounted work dirs (1000 locally, 1001 on GitHub runners)
ARG UID=1000
RUN (id -u $UID >/dev/null 2>&1 && userdel -r $(id -un $UID)) || true; useradd -m -u $UID b
USER b
WORKDIR /w
