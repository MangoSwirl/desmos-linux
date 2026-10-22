#!/bin/bash
# Build the RV32 kernel inside the rvbuild container.
#   docker run --rm -v ~/br:/w -v $PROJECT:/p rvbuild /p/linux/build-kernel.sh
set -euo pipefail
export PATH=/w/out/host/bin:$PATH
KSRC=/w/src/linux-7.0.14
KOUT=/w/kbuild
mkdir -p $KOUT
cd $KSRC
make O=$KOUT ARCH=riscv CROSS_COMPILE=riscv32-buildroot-linux-gnu- tinyconfig >/dev/null
scripts/kconfig/merge_config.sh -m -O $KOUT $KOUT/.config /p/linux/kernel.config >/dev/null
make O=$KOUT ARCH=riscv CROSS_COMPILE=riscv32-buildroot-linux-gnu- olddefconfig >/dev/null
# report options from the fragment that did not stick
while IFS= read -r line; do
  case "$line" in
    CONFIG_*=*) grep -qxF "$line" $KOUT/.config || echo "MISSING: $line" ;;
    "# CONFIG_"*" is not set") grep -qxF "$line" $KOUT/.config || { k=${line#\# }; k=${k% is not set}; grep -q "^$k=" $KOUT/.config && echo "STILL SET: $k"; } ;;
  esac
done < /p/linux/kernel.config
make O=$KOUT ARCH=riscv CROSS_COMPILE=riscv32-buildroot-linux-gnu- -j4 Image
ls -la $KOUT/arch/riscv/boot/Image
