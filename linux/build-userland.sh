#!/bin/bash
# Build the GNU userland (static, glibc, rv32ima/ilp32) inside the rvbuild container:
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

# --- GNU coreutils (single multi-call binary)
if [ ! -x $OUT/bin/coreutils ]; then
  rm -rf /w/tmp/cu && cp -r /w/src/coreutils-9.10 /w/tmp/cu && cd /w/tmp/cu
  FORCE_UNSAFE_CONFIGURE=1 ./configure --host=$HOST --prefix=/ --enable-single-binary=symlinks \
    --disable-nls --disable-acl --disable-xattr --disable-libcap --without-selinux --without-openssl \
    --disable-libsmack --enable-no-install-program=stdbuf,base32,basenc,chcon,chroot,csplit,dir,dircolors,factor,hostid,install,link,logname,mkfifo,mknod,nice,nohup,numfmt,pathchk,pinky,pr,ptx,runcon,shred,shuf,split,sync,tsort,unexpand,users,vdir,who,stty,timeout,expand,fmt,join,od,mktemp,truncate,tac,printenv,nl,paste,comm,shuf \
    gl_cv_func_working_mktime=yes ac_cv_func_mmap_fixed_mapped=yes > /w/tmp/cu-configure.log
  make -j4 > /w/tmp/cu-make.log 2>&1 || { tail -40 /w/tmp/cu-make.log; exit 1; }
  cp src/coreutils $OUT/bin/coreutils && $HOST-strip $OUT/bin/coreutils
  ./src/coreutils --help >/dev/null 2>&1 || true
  sed -n 's/^single_binary_progs = //p' Makefile > $OUT/coreutils-progs.txt || true
fi
ls -la $OUT/bin
