#!/bin/bash
# Build the userland (GNU bash, BusyBox, init; static, glibc, rv32ima/ilp32) inside the rvbuild container:
#   docker run --rm -v ~/br:/w -v $PROJECT:/p rvbuild /p/linux/build-userland.sh
set -euo pipefail
export PATH=/w/out/host/bin:$PATH
HOST=riscv32-buildroot-linux-gnu
export CC=$HOST-gcc
export CFLAGS="-Os -std=gnu17 -ffunction-sections -fdata-sections -Wno-implicit-function-declaration -Wno-int-conversion -Wno-incompatible-pointer-types"
export LDFLAGS="-static -Wl,--gc-sections"
OUT=/w/userland
mkdir -p /w/tmp
mkdir -p $OUT/bin

# --- tiny init (no libc): set up a session on the console, then exec bash
$CC -Os -nostdlib -static -fno-builtin -fno-stack-protector -Wl,--no-relax -o $OUT/bin/init /p/linux/init.c
$HOST-strip $OUT/bin/init

# --- GNU bash
if [ ! -x $OUT/bin/bash ]; then
  rm -rf /w/tmp/bash && cp -r /w/src/bash-5.2.37 /w/tmp/bash && cd /w/tmp/bash
  CC_FOR_BUILD="gcc -std=gnu17" ./configure --host=$HOST --prefix=/ --enable-static-link --without-bash-malloc --disable-nls \
    --enable-minimal-config --enable-alias --enable-arith-for-command --enable-array-variables \
    --enable-brace-expansion --enable-casemod-attributes --enable-cond-command --enable-cond-regexp \
    --enable-directory-stack --enable-dparen-arithmetic --enable-extended-glob --enable-function-import \
    --enable-help-builtin --enable-history --enable-job-control --enable-process-substitution \
    --enable-prompt-string-decoding --enable-readline --enable-select \
    bash_cv_job_control_missing=present bash_cv_sys_named_pipes=present bash_cv_func_sigsetjmp=present \
    bash_cv_getcwd_malloc=yes bash_cv_unusable_rtsigs=no bash_cv_func_ctype_nonascii=no > /w/tmp/bash-configure.log
  make -j4 > /w/tmp/bash-make.log 2>&1 || { tail -40 /w/tmp/bash-make.log; exit 1; }
  cp bash $OUT/bin/bash && $HOST-strip $OUT/bin/bash
fi

# --- BusyBox applets in place of GNU coreutils: a smaller binary, so a smaller initramfs for the
# kernel to unpack and less to page in on each exec. allnoconfig, then the symbols in busybox.config.
if [ ! -x $OUT/bin/busybox ]; then
  rm -rf /w/tmp/bb && cp -r /w/src/busybox-1.37.0 /w/tmp/bb && cd /w/tmp/bb
  BB="make CROSS_COMPILE=$HOST- CC=$CC"
  (unset CFLAGS LDFLAGS
   $BB allnoconfig > /w/tmp/bb-config.log
   for k in $(grep -oE '^(# )?CONFIG_[A-Z0-9_]+' /p/linux/busybox.config | sed 's/^# //'); do
     sed -i "/^$k=/d;/^# $k is not set/d" .config
   done
   grep -E '^(# )?CONFIG_' /p/linux/busybox.config >> .config
   { yes '' || true; } | $BB oldconfig >> /w/tmp/bb-config.log
   while IFS= read -r line; do
     case "$line" in CONFIG_*|"# CONFIG_"*) grep -qxF "$line" .config || echo "MISSING: $line" ;; esac
   done < /p/linux/busybox.config
   $BB -j4 > /w/tmp/bb-make.log 2>&1 || { tail -40 /w/tmp/bb-make.log; exit 1; }
   $BB busybox.links >> /w/tmp/bb-make.log 2>&1)
  cp busybox $OUT/bin/busybox && $HOST-strip $OUT/bin/busybox
  # applet names; bash has its own [[
  sed 's#.*/##' busybox.links | grep -vxF '[[' > $OUT/busybox-applets.txt
fi
ls -la $OUT/bin
