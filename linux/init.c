// Minimal init for the Desmos machine (no libc, rv32 Linux syscalls).
// Mounts /proc, makes the SBI console our controlling terminal (so bash gets
// job control and Ctrl-C works), sets an 80x24 window size, then runs bash.

typedef unsigned long ulong;

static long sys(long n, long a, long b, long c, long d, long e) {
  register long a7 asm("a7") = n;
  register long a0 asm("a0") = a;
  register long a1 asm("a1") = b;
  register long a2 asm("a2") = c;
  register long a3 asm("a3") = d;
  register long a4 asm("a4") = e;
  asm volatile("ecall" : "+r"(a0) : "r"(a7), "r"(a1), "r"(a2), "r"(a3), "r"(a4) : "memory");
  return a0;
}

#define SYS_dup3 24
#define SYS_ioctl 29
#define SYS_mount 40
#define SYS_openat 56
#define SYS_write 64
#define SYS_exit 93
#define SYS_setsid 157
#define SYS_sethostname 161
#define SYS_execve 221
#define AT_FDCWD -100
#define O_RDWR 2
#define TIOCSCTTY 0x540E
#define TIOCSWINSZ 0x5414

static void say(const char *s) {
  long n = 0;
  while (s[n]) n++;
  sys(SYS_write, 2, (long)s, n, 0, 0);
}

void _start(void) {
  sys(SYS_mount, (long)"proc", (long)"/proc", (long)"proc", 0, 0);
  sys(SYS_sethostname, (long)"desmos", 6, 0, 0, 0);
  sys(SYS_setsid, 0, 0, 0, 0, 0);
  long fd = sys(SYS_openat, AT_FDCWD, (long)"/dev/hvc0", O_RDWR, 0, 0);
  if (fd >= 0) {
    unsigned short ws[4] = {24, 80, 0, 0};
    sys(SYS_ioctl, fd, TIOCSCTTY, 0, 0, 0);
    sys(SYS_ioctl, fd, TIOCSWINSZ, (long)ws, 0, 0);
    for (long i = 0; i < 3; i++)
      if (fd != i) sys(SYS_dup3, fd, i, 0, 0, 0);
  }
  static const char *argv[] = {"-bash", 0};
  static const char *envp[] = {"HOME=/root", "PATH=/bin", "TERM=vt100", "SHELL=/bin/bash",
                               "USER=root", "LOGNAME=root", "COLUMNS=80", "LINES=24", 0};
  sys(SYS_execve, (long)"/bin/bash", (long)argv, (long)envp, 0, 0);
  say("init: could not exec /bin/bash\n");
  for (;;) sys(SYS_exit, 1, 0, 0, 0, 0);
}
