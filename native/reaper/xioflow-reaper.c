/*
 * xioflow-reaper: holds a supervised process tree for @xioflow/kernel.
 *
 *   xioflow-reaper <file> [args...]
 *
 * The host spawns this helper in a new session with fd 3 as a bidirectional
 * control socket. The helper forks the target into its own process group,
 * keeps it blocked on a gate until the host has persisted its identity, and
 * then stays alive as the holder of the whole tree:
 *
 *   Linux  PR_SET_CHILD_SUBREAPER: every orphaned descendant (setsid,
 *          double fork) is reparented to the helper, so "waitpid(-1) returns
 *          ECHILD" proves the tree is empty. Signals go through pidfd after the
 *          start time is re-checked, so a recycled pid is never signalled.
 *   macOS  no subreaper: descendants are tracked through kqueue NOTE_FORK plus
 *          a periodic scan, identified by (pid, microsecond start time).
 *          Emptiness means "every tracked process is gone", which is weaker
 *          and is reported as such (scope "tracked_tree").
 *
 * Control protocol (one ASCII line per message):
 *   helper -> host   spawned <pid> | exit <code> <signal> | empty
 *                    stopped | residual <pid,pid,...> | error <text>
 *   host -> helper   go | abort | stop <graceMs> | signal <signo>
 * EOF on the control socket (host died) or SIGTERM/SIGINT/SIGHUP to the helper
 * stops the whole tree before the helper exits: a crashed supervisor never
 * leaves the tree running unsupervised.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#ifdef __linux__
#include <dirent.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#define TREE_SCOPE "subreaper_tree"
#elif defined(__APPLE__)
#include <libproc.h>
#include <sys/event.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#define TREE_SCOPE "tracked_tree"
#else
#error "xioflow-reaper supports Linux and macOS only"
#endif

#define CTL_FD 3
#define EXIT_GATE_CLOSED 125
#define EXIT_EXEC_FAILED 127

typedef struct {
  pid_t pid;
  pid_t ppid;
  unsigned long long start; /* Linux: clock ticks since boot; macOS: microseconds since epoch */
  int zombie;
} proc_ent;

typedef struct {
  proc_ent *items;
  size_t len, cap;
} proc_list;

static pid_t self_pid;
static pid_t root_pid = -1;
static int root_reaped = 0;
static int sig_pipe[2] = {-1, -1};
static int gate_pipe[2] = {-1, -1};
static volatile sig_atomic_t stop_requested = 0;
#ifdef __APPLE__
static proc_list known; /* every descendant ever observed */
#endif

/* ------------------------------------------------------------------ utils */

static void list_push(proc_list *l, proc_ent e) {
  if (l->len == l->cap) {
    size_t cap = l->cap ? l->cap * 2 : 64;
    proc_ent *items = realloc(l->items, cap * sizeof(proc_ent));
    if (!items) {
      perror("xioflow-reaper: realloc");
      _exit(70);
    }
    l->items = items;
    l->cap = cap;
  }
  l->items[l->len++] = e;
}

static int write_all(int fd, const char *buf, size_t len) {
  while (len > 0) {
    ssize_t n = write(fd, buf, len);
    if (n < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    buf += n;
    len -= (size_t)n;
  }
  return 0;
}

static void ctl_send(const char *fmt, ...) {
  char buf[8192];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(buf, sizeof(buf) - 1, fmt, ap);
  va_end(ap);
  if (n < 0) return;
  if ((size_t)n > sizeof(buf) - 2) n = (int)sizeof(buf) - 2;
  buf[n++] = '\n';
  /* The host may already be gone; EPIPE is handled as EOF by the main loop. */
  (void)write_all(CTL_FD, buf, (size_t)n);
}

static long long now_ms(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (long long)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

static void sleep_ms(long ms) {
  struct timespec ts = {ms / 1000, (ms % 1000) * 1000000L};
  while (nanosleep(&ts, &ts) < 0 && errno == EINTR) {
  }
}

/* ---------------------------------------------------------- process table */

#ifdef __linux__
static int read_stat(pid_t pid, proc_ent *out) {
  char path[64], buf[1024];
  snprintf(path, sizeof(path), "/proc/%d/stat", (int)pid);
  int fd = open(path, O_RDONLY | O_CLOEXEC);
  if (fd < 0) return -1;
  ssize_t n = read(fd, buf, sizeof(buf) - 1);
  close(fd);
  if (n <= 0) return -1;
  buf[n] = '\0';
  /* comm may contain spaces and parentheses: fields resume after the last ')' */
  char *p = strrchr(buf, ')');
  if (!p) return -1;
  char state;
  int ppid;
  unsigned long long start;
  /* fields 3 (state), 4 (ppid), then skip 5..21, field 22 (starttime) */
  if (sscanf(p + 2, "%c %d %*d %*d %*d %*d %*u %*u %*u %*u %*u %*u %*u %*d %*d %*d %*d %*d %*d %llu",
             &state, &ppid, &start) != 3)
    return -1;
  out->pid = pid;
  out->ppid = ppid;
  out->start = start;
  out->zombie = state == 'Z' || state == 'X';
  return 0;
}

static void list_procs(proc_list *out) {
  out->len = 0;
  DIR *d = opendir("/proc");
  if (!d) return;
  struct dirent *de;
  while ((de = readdir(d)) != NULL) {
    char *end;
    long pid = strtol(de->d_name, &end, 10);
    if (*end != '\0' || pid <= 0) continue;
    proc_ent e;
    if (read_stat((pid_t)pid, &e) == 0) list_push(out, e);
  }
  closedir(d);
}
#else
static int read_stat(pid_t pid, proc_ent *out) {
  struct proc_bsdinfo info;
  int n = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &info, sizeof(info));
  if (n != (int)sizeof(info)) return -1;
  out->pid = pid;
  out->ppid = (pid_t)info.pbi_ppid;
  out->start = (unsigned long long)info.pbi_start_tvsec * 1000000ULL + info.pbi_start_tvusec;
  out->zombie = info.pbi_status == SZOMB;
  return 0;
}

static void list_procs(proc_list *out) {
  out->len = 0;
  int count = proc_listallpids(NULL, 0);
  if (count <= 0) return;
  size_t cap = (size_t)count + 64;
  pid_t *pids = calloc(cap, sizeof(pid_t));
  if (!pids) return;
  int got = proc_listallpids(pids, (int)(cap * sizeof(pid_t)));
  for (int i = 0; i < got; i++) {
    proc_ent e;
    if (pids[i] > 0 && read_stat(pids[i], &e) == 0) list_push(out, e);
  }
  free(pids);
}
#endif

static int cmp_pid(const void *a, const void *b) {
  pid_t x = ((const proc_ent *)a)->pid, y = ((const proc_ent *)b)->pid;
  return (x > y) - (x < y);
}

static proc_ent *find_pid(proc_list *l, pid_t pid) {
  proc_ent key = {.pid = pid};
  return bsearch(&key, l->items, l->len, sizeof(proc_ent), cmp_pid);
}

#ifdef __APPLE__
static int is_known(pid_t pid, unsigned long long start) {
  for (size_t i = 0; i < known.len; i++)
    if (known.items[i].pid == pid && known.items[i].start == start) return 1;
  return 0;
}
#endif

/*
 * Live (non-zombie) descendants of the helper. On macOS an orphan is
 * reparented to launchd and loses its link to the helper, so processes we
 * already tracked and members of the helper's session count as well.
 */
static void collect_tree(proc_list *table, proc_list *out) {
  out->len = 0;
  list_procs(table);
  qsort(table->items, table->len, sizeof(proc_ent), cmp_pid);
  unsigned char *in = calloc(table->len ? table->len : 1, 1);
  if (!in) return;
#ifdef __APPLE__
  /* Session membership survives reparenting to launchd; only setsid() leaves it. */
  for (size_t i = 0; i < table->len; i++)
    if (is_known(table->items[i].pid, table->items[i].start) || getsid(table->items[i].pid) == self_pid) in[i] = 1;
#endif
  int changed = 1;
  while (changed) {
    changed = 0;
    for (size_t i = 0; i < table->len; i++) {
      if (in[i]) continue;
      pid_t ppid = table->items[i].ppid;
      proc_ent *parent = ppid == self_pid ? NULL : find_pid(table, ppid);
      if (ppid == self_pid || (parent && in[parent - table->items])) {
        in[i] = 1;
        changed = 1;
      }
    }
  }
  for (size_t i = 0; i < table->len; i++) {
    if (!in[i] || table->items[i].zombie || table->items[i].pid == self_pid) continue;
    list_push(out, table->items[i]);
  }
  free(in);
}

#ifdef __APPLE__
static int kq = -1;

static void track(proc_list *tree) {
  for (size_t i = 0; i < tree->len; i++) {
    proc_ent *e = &tree->items[i];
    if (is_known(e->pid, e->start)) continue;
    list_push(&known, *e);
    struct kevent kev;
    EV_SET(&kev, e->pid, EVFILT_PROC, EV_ADD | EV_CLEAR, NOTE_FORK | NOTE_EXIT, 0, NULL);
    (void)kevent(kq, &kev, 1, NULL, 0, NULL); /* ESRCH: already gone, the next scan settles it */
  }
}
#endif

/* ------------------------------------------------------------- signalling */

/* Signal (pid, start) only if that pid still names the same process. */
static void safe_kill(proc_ent *e, int sig) {
#ifdef __linux__
#ifdef SYS_pidfd_open
  int pidfd = (int)syscall(SYS_pidfd_open, e->pid, 0);
  if (pidfd >= 0) {
    proc_ent now;
    if (read_stat(e->pid, &now) == 0 && now.start == e->start)
      (void)syscall(SYS_pidfd_send_signal, pidfd, sig, NULL, 0);
    close(pidfd);
    return;
  }
  if (errno != ENOSYS) return; /* ESRCH: already gone */
#endif
#endif
  proc_ent now;
  if (read_stat(e->pid, &now) == 0 && now.start == e->start) (void)kill(e->pid, sig);
}

static void reap_children(void) {
  int status;
  pid_t p;
  while ((p = waitpid(-1, &status, WNOHANG)) > 0) {
    if (p != root_pid) continue;
    root_reaped = 1;
    if (WIFEXITED(status))
      ctl_send("exit %d -", WEXITSTATUS(status));
    else if (WIFSIGNALED(status))
      ctl_send("exit - %d", WTERMSIG(status));
  }
}

static int has_children(void) {
  /* ECHILD is the only "no child left" answer; WNOWAIT leaves any zombie for reap_children. */
  siginfo_t info;
  memset(&info, 0, sizeof(info));
  return !(waitid(P_ALL, 0, &info, WEXITED | WNOHANG | WNOWAIT) < 0 && errno == ECHILD);
}

/* Tree is empty: no live descendant and no child left to reap. */
static int tree_empty(proc_list *table, proc_list *tree) {
  reap_children();
  collect_tree(table, tree);
#ifdef __APPLE__
  track(tree);
#endif
  return tree->len == 0 && !has_children();
}

static int signal_tree_until_empty(int sig, long long deadline, proc_list *table, proc_list *tree) {
  for (;;) {
    if (tree_empty(table, tree)) return 1;
    for (size_t i = 0; i < tree->len; i++) safe_kill(&tree->items[i], sig);
    if (now_ms() >= deadline) return tree_empty(table, tree);
    sleep_ms(10);
  }
}

/* SIGINT -> grace -> SIGTERM -> 1s -> SIGKILL (repeated until empty or 2s). */
static int stop_tree(long grace_ms, proc_list *table, proc_list *tree) {
  if (signal_tree_until_empty(SIGINT, now_ms() + grace_ms, table, tree)) return 1;
  if (signal_tree_until_empty(SIGTERM, now_ms() + 1000, table, tree)) return 1;
  return signal_tree_until_empty(SIGKILL, now_ms() + 2000, table, tree);
}

static void report_stop(int empty, proc_list *tree) {
  if (empty) {
    ctl_send("stopped");
    return;
  }
  char buf[6000];
  size_t off = 0;
  for (size_t i = 0; i < tree->len && off < sizeof(buf) - 16; i++)
    off += (size_t)snprintf(buf + off, sizeof(buf) - off, "%s%d", i ? "," : "", (int)tree->items[i].pid);
  buf[off] = '\0';
  ctl_send("residual %s", buf);
}

/* -------------------------------------------------------------- lifecycle */

static void on_signal(int sig) {
  int saved = errno;
  if (sig != SIGCHLD) stop_requested = 1;
  char c = (char)sig;
  /* Self-pipe wakeup; a full pipe already guarantees a pending wakeup. glibc's
     warn_unused_result ignores a (void) cast, hence the named variable. */
  ssize_t ignored = write(sig_pipe[1], &c, 1);
  (void)ignored;
  errno = saved;
}

static void close_gate(int go) {
  if (gate_pipe[1] < 0) return;
  if (go) (void)write_all(gate_pipe[1], "G", 1);
  close(gate_pipe[1]);
  gate_pipe[1] = -1;
}

static void run_child(char **argv) {
  sigset_t none;
  sigemptyset(&none);
  int sigs[] = {SIGCHLD, SIGINT, SIGTERM, SIGHUP, SIGPIPE};
  for (size_t i = 0; i < sizeof(sigs) / sizeof(sigs[0]); i++) signal(sigs[i], SIG_DFL);
  sigprocmask(SIG_SETMASK, &none, NULL);
  close(CTL_FD);
  close(gate_pipe[1]);
  setpgid(0, 0);
  char c = 0;
  ssize_t n;
  while ((n = read(gate_pipe[0], &c, 1)) < 0 && errno == EINTR) {
  }
  if (n != 1 || c != 'G') _exit(EXIT_GATE_CLOSED);
  close(gate_pipe[0]);
  execvp(argv[0], argv);
  dprintf(STDERR_FILENO, "xioflow-reaper: %s: %s\n", argv[0], strerror(errno));
  _exit(EXIT_EXEC_FAILED);
}

static void install_signals(void) {
  if (pipe(sig_pipe) < 0) {
    perror("xioflow-reaper: pipe");
    exit(70);
  }
  for (int i = 0; i < 2; i++) {
    fcntl(sig_pipe[i], F_SETFD, FD_CLOEXEC);
    fcntl(sig_pipe[i], F_SETFL, O_NONBLOCK);
  }
  struct sigaction sa;
  memset(&sa, 0, sizeof(sa));
  sa.sa_handler = on_signal;
  sa.sa_flags = SA_RESTART | SA_NOCLDSTOP;
  int sigs[] = {SIGCHLD, SIGINT, SIGTERM, SIGHUP};
  for (size_t i = 0; i < sizeof(sigs) / sizeof(sigs[0]); i++) sigaction(sigs[i], &sa, NULL);
  signal(SIGPIPE, SIG_IGN);
}

/* Detach the helper from the target's stdio so the pipes close when the tree is done. */
static void release_stdio(void) {
  int devnull = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (devnull < 0) return;
  for (int fd = 0; fd <= 2; fd++) dup2(devnull, fd);
  if (devnull > 2) close(devnull);
}

/* Returns 1 when the host asked to stop and the helper should exit. */
static int handle_command(char *line, proc_list *table, proc_list *tree) {
  if (strcmp(line, "go") == 0) {
    close_gate(1);
  } else if (strcmp(line, "abort") == 0) {
    close_gate(0);
  } else if (strncmp(line, "stop ", 5) == 0) {
    close_gate(0);
    int empty = stop_tree(strtol(line + 5, NULL, 10), table, tree);
    report_stop(empty, tree);
    return empty;
  } else if (strncmp(line, "signal ", 7) == 0) {
    int sig = (int)strtol(line + 7, NULL, 10);
    if (!root_reaped && sig > 0) (void)kill(root_pid, sig); /* unreaped: pid cannot be recycled */
  } else {
    ctl_send("error unknown command");
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc < 2) {
    fprintf(stderr, "usage: xioflow-reaper <file> [args...]\n");
    return 64;
  }
  if (fcntl(CTL_FD, F_GETFD) < 0) {
    fprintf(stderr, "xioflow-reaper: fd 3 must be the control socket\n");
    return 64;
  }
  fcntl(CTL_FD, F_SETFD, FD_CLOEXEC);
  self_pid = getpid();
#ifdef __linux__
  if (prctl(PR_SET_CHILD_SUBREAPER, 1) != 0) {
    ctl_send("error prctl(PR_SET_CHILD_SUBREAPER): %s", strerror(errno));
    return 71;
  }
#else
  kq = kqueue();
  if (kq < 0) {
    ctl_send("error kqueue: %s", strerror(errno));
    return 71;
  }
#endif
  install_signals();
  if (pipe(gate_pipe) < 0) {
    ctl_send("error pipe: %s", strerror(errno));
    return 71;
  }
  fcntl(gate_pipe[1], F_SETFD, FD_CLOEXEC);

  root_pid = fork();
  if (root_pid < 0) {
    ctl_send("error fork: %s", strerror(errno));
    return 71;
  }
  if (root_pid == 0) run_child(argv + 1);

  close(gate_pipe[0]);
  setpgid(root_pid, root_pid); /* both sides set it: no race with the host reading the pgid */
  release_stdio();
  ctl_send("spawned %d", (int)root_pid);

  proc_list table = {0}, tree = {0};
  char buf[4096];
  size_t buf_len = 0;

  for (;;) {
    if (stop_requested) {
      close_gate(0);
      report_stop(stop_tree(0, &table, &tree), &tree);
      break;
    }
    if (root_reaped && tree_empty(&table, &tree)) {
      ctl_send("empty");
      break;
    }
    struct pollfd fds[3] = {{CTL_FD, POLLIN, 0}, {sig_pipe[0], POLLIN, 0}, {-1, 0, 0}};
    int timeout = -1;
#ifdef __APPLE__
    fds[2].fd = kq;
    fds[2].events = POLLIN;
    timeout = 50; /* fallback scan in case a NOTE_FORK was missed */
#else
    if (root_reaped) timeout = 100; /* descendants of an exited root: poll for emptiness */
#endif
    int n = poll(fds, 3, timeout);
    if (n < 0 && errno != EINTR) break;

    if (fds[1].revents & POLLIN) {
      char drain[64];
      while (read(sig_pipe[0], drain, sizeof(drain)) > 0) {
      }
      reap_children();
    }
#ifdef __APPLE__
    struct kevent evs[32];
    struct timespec zero = {0, 0};
    while (kevent(kq, NULL, 0, evs, 32, &zero) > 0) {
    }
    collect_tree(&table, &tree);
    track(&tree);
#endif
    if (fds[0].revents & (POLLIN | POLLHUP | POLLERR)) {
      ssize_t r = read(CTL_FD, buf + buf_len, sizeof(buf) - 1 - buf_len);
      if (r <= 0) {
        if (r < 0 && errno == EINTR) continue;
        /* Host is gone: never leave the tree running unsupervised. */
        close_gate(0);
        stop_tree(0, &table, &tree);
        break;
      }
      buf_len += (size_t)r;
      buf[buf_len] = '\0';
      char *line = buf, *nl;
      int done = 0;
      while (!done && (nl = strchr(line, '\n')) != NULL) {
        *nl = '\0';
        done = handle_command(line, &table, &tree);
        line = nl + 1;
      }
      if (done) break;
      buf_len = strlen(line);
      memmove(buf, line, buf_len + 1);
      if (buf_len >= sizeof(buf) - 1) buf_len = 0; /* oversized garbage line: drop it */
    }
  }
  return 0;
}
