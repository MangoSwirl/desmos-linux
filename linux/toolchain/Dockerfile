FROM ubuntu:26.04
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  build-essential wget cpio rsync bc unzip file python3 perl git libncurses-dev ca-certificates \
  device-tree-compiler bison flex libssl-dev libelf-dev xz-utils gzip patch texinfo gawk help2man autoconf automake libtool pkg-config lz4 zstd \
  && rm -rf /var/lib/apt/lists/*
RUN (id -u 1000 >/dev/null 2>&1 && userdel -r $(id -un 1000)) || true; useradd -m -u 1000 b
USER b
WORKDIR /w
