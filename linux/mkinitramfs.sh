#!/bin/bash
# Build the gzip'ed initramfs inside the rvbuild container:
#   docker run --rm -v ~/br:/w -v $PROJECT:/p rvbuild /p/linux/mkinitramfs.sh
set -euo pipefail
U=/w/userland
L=/w/initramfs.list
cat > $L <<LIST
dir /dev 755 0 0
nod /dev/console 600 0 0 c 5 1
nod /dev/hvc0 620 0 0 c 229 0
nod /dev/tty 666 0 0 c 5 0
nod /dev/null 666 0 0 c 1 3
nod /dev/zero 666 0 0 c 1 5
nod /dev/random 444 0 0 c 1 8
nod /dev/urandom 444 0 0 c 1 9
dir /proc 755 0 0
dir /tmp 1777 0 0
dir /root 700 0 0
dir /etc 755 0 0
dir /bin 755 0 0
file /init $U/bin/init 755 0 0
file /bin/bash $U/bin/bash 755 0 0
slink /bin/sh bash 777 0 0
file /bin/busybox $U/bin/busybox 755 0 0
LIST
for p in $(cat $U/busybox-applets.txt); do echo "slink /bin/$p busybox 777 0 0" >> $L; done
for f in passwd group hostname inputrc motd profile; do echo "file /etc/$f /p/linux/rootfs/etc/$f 644 0 0" >> $L; done
echo "file /root/README /p/linux/rootfs/root/README 644 0 0" >> $L
/w/kbuild/usr/gen_init_cpio $L | cat > /w/initramfs.cpio
ls -la /w/initramfs.cpio
