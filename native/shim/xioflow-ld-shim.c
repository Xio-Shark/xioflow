/*
 * xioflow-ld-shim.c: Linux LD_PRELOAD syscall interposition layer for @xioflow/kernel.
 *
 * 1. Absolute-path shell interception:
 *    Redirects /bin/sh, /bin/bash, /bin/dash, /bin/zsh (-c / -lc) calls in execve,
 *    execv, execvp, execvpe, posix_spawn, posix_spawnp to $XIO_SHIM_DIR/<shell>
 *    even when tools bypass $PATH (e.g., Node child_process.execSync, Python
 *    subprocess(..., shell=True), C system()). Disabled when XIO_SHIM_BYPASS=1.
 *
 * 2. Zero-overhead VFS syscall tracing & Landlock EACCES trap reporting:
 *    Records file reads (R), writes (W), deletes (D), shell execs (X), and kernel
 *    confinement/permission denials (E) to $XIO_SYSCALL_TRACE_PATH using raw
 *    SYS_openat/SYS_write/SYS_close syscalls without re-entering libc.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <limits.h>
#include <spawn.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/syscall.h>
#include <sys/types.h>
#include <unistd.h>

#ifndef O_WRONLY
#define O_WRONLY 01
#define O_RDWR 02
#define O_CREAT 0100
#define O_TRUNC 01000
#define O_APPEND 02000
#define O_CLOEXEC 02000000
#endif
#ifndef AT_FDCWD
#define AT_FDCWD -100
#endif

static __thread int in_shim = 0;

static const char *get_env_from_list(char *const envp[], const char *key) {
  if (envp) {
    size_t klen = strlen(key);
    for (size_t i = 0; envp[i] != NULL; i++) {
      if (strncmp(envp[i], key, klen) == 0 && envp[i][klen] == '=') {
        return envp[i] + klen + 1;
      }
    }
  }
  return getenv(key);
}

static int is_noise_path(const char *abs_path, const char *trace_path) {
  if (!abs_path || !*abs_path) return 1;
  if (trace_path && strcmp(abs_path, trace_path) == 0) return 1;
  if (strncmp(abs_path, "/proc/", 6) == 0 || strcmp(abs_path, "/proc") == 0) return 1;
  if (strncmp(abs_path, "/sys/", 5) == 0 || strcmp(abs_path, "/sys") == 0) return 1;
  if (strncmp(abs_path, "/dev/", 5) == 0 || strcmp(abs_path, "/dev") == 0) return 1;
  if (strncmp(abs_path, "/etc/ld.so", 10) == 0) return 1;
  if (strncmp(abs_path, "/lib/", 5) == 0 || strncmp(abs_path, "/lib64/", 7) == 0) return 1;
  if (strncmp(abs_path, "/usr/lib/", 9) == 0 || strncmp(abs_path, "/usr/lib64/", 11) == 0) return 1;
  return 0;
}

static void resolve_at_path(int dirfd, const char *path, char *out, size_t outsz) {
  if (!path || !*path) {
    out[0] = '\0';
    return;
  }
  if (path[0] == '/') {
    snprintf(out, outsz, "%s", path);
    return;
  }
  char base[2048];
  base[0] = '\0';
  if (dirfd >= 0) {
    char fdlink[64];
    snprintf(fdlink, sizeof(fdlink), "/proc/self/fd/%d", dirfd);
    ssize_t n = readlink(fdlink, base, sizeof(base) - 1);
    if (n > 0) base[n] = '\0';
  }
  if (!base[0]) {
    if (!getcwd(base, sizeof(base))) {
      snprintf(out, outsz, "%s", path);
      return;
    }
  }
  if (path[0] == '.' && path[1] == '/') path += 2;
  snprintf(out, outsz, "%s/%s", base, path);
}

static void trace_vfs_event(char op, int dirfd, const char *path) {
  const char *trace_bypass = getenv("XIO_TRACE_BYPASS");
  if (trace_bypass && strcmp(trace_bypass, "1") == 0) return;
  const char *trace_path = getenv("XIO_SYSCALL_TRACE_PATH");
  if (!trace_path || !*trace_path || !path || !*path) return;

  char abs[4096];
  resolve_at_path(dirfd, path, abs, sizeof(abs));
  if (is_noise_path(abs, trace_path)) return;

  int fd = (int)syscall(SYS_openat, AT_FDCWD, trace_path, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0666);
  if (fd < 0) return;
  char line[4200];
  int n = snprintf(line, sizeof(line), "%c\t%s\n", op, abs);
  if (n > 0 && (size_t)n < sizeof(line)) {
    (void)syscall(SYS_write, fd, line, (size_t)n);
  }
  (void)syscall(SYS_close, fd);
}

static int has_command_flag(char *const argv[]) {
  if (!argv || !argv[0] || !argv[1]) return 0;
  if (strcmp(argv[1], "-c") == 0 || strcmp(argv[1], "-lc") == 0) return 1;
  if ((strcmp(argv[1], "-c") == 0 && argv[2] && strcmp(argv[2], "-l") == 0) ||
      (strcmp(argv[1], "-l") == 0 && argv[2] && strcmp(argv[2], "-c") == 0)) {
    return 1;
  }
  return 0;
}

static const char *remap_shell_path(const char *file, char *const argv[], char *const envp[], char *buf, size_t bufsz) {
  if (!file) return file;
  const char *bypass = get_env_from_list(envp, "XIO_SHIM_BYPASS");
  if (bypass && strcmp(bypass, "1") == 0) return file;
  const char *shim_dir = get_env_from_list(envp, "XIO_SHIM_DIR");
  if (!shim_dir || !*shim_dir) return file;
  if (!has_command_flag(argv)) return file;

  const char *target_name = NULL;
  if (strcmp(file, "/bin/sh") == 0 || strcmp(file, "/usr/bin/sh") == 0 || strcmp(file, "sh") == 0 ||
      strcmp(file, "/bin/dash") == 0 || strcmp(file, "/usr/bin/dash") == 0 || strcmp(file, "dash") == 0) {
    target_name = "sh";
  } else if (strcmp(file, "/bin/bash") == 0 || strcmp(file, "/usr/bin/bash") == 0 || strcmp(file, "bash") == 0) {
    target_name = "bash";
  } else if (strcmp(file, "/bin/zsh") == 0 || strcmp(file, "/usr/bin/zsh") == 0 || strcmp(file, "zsh") == 0) {
    target_name = "zsh";
  }
  if (!target_name) return file;

  snprintf(buf, bufsz, "%s/%s", shim_dir, target_name);
  if (access(buf, X_OK) == 0) {
    trace_vfs_event('X', AT_FDCWD, file);
    return buf;
  }
  return file;
}

int execve(const char *filename, char *const argv[], char *const envp[]) {
  typedef int (*fn_t)(const char *, char *const[], char *const[]);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "execve");
  char buf[2048];
  const char *target = filename;
  if (!in_shim) {
    in_shim = 1;
    target = remap_shell_path(filename, argv, envp, buf, sizeof(buf));
    in_shim = 0;
  }
  return real_fn(target, argv, envp);
}

int execv(const char *path, char *const argv[]) {
  typedef int (*fn_t)(const char *, char *const[]);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "execv");
  char buf[2048];
  const char *target = path;
  if (!in_shim) {
    in_shim = 1;
    target = remap_shell_path(path, argv, NULL, buf, sizeof(buf));
    in_shim = 0;
  }
  return real_fn(target, argv);
}

int execvp(const char *file, char *const argv[]) {
  typedef int (*fn_t)(const char *, char *const[]);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "execvp");
  char buf[2048];
  const char *target = file;
  if (!in_shim) {
    in_shim = 1;
    target = remap_shell_path(file, argv, NULL, buf, sizeof(buf));
    in_shim = 0;
  }
  return real_fn(target, argv);
}

int execvpe(const char *file, char *const argv[], char *const envp[]) {
  typedef int (*fn_t)(const char *, char *const[], char *const[]);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "execvpe");
  char buf[2048];
  const char *target = file;
  if (!in_shim) {
    in_shim = 1;
    target = remap_shell_path(file, argv, envp, buf, sizeof(buf));
    in_shim = 0;
  }
  return real_fn(target, argv, envp);
}

int posix_spawn(pid_t *pid, const char *path, const posix_spawn_file_actions_t *fa, const posix_spawnattr_t *attrp,
                char *const argv[], char *const envp[]) {
  typedef int (*fn_t)(pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *,
                      char *const[], char *const[]);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "posix_spawn");
  char buf[2048];
  const char *target = path;
  if (!in_shim) {
    in_shim = 1;
    target = remap_shell_path(path, argv, envp, buf, sizeof(buf));
    in_shim = 0;
  }
  return real_fn(pid, target, fa, attrp, argv, envp);
}

int posix_spawnp(pid_t *pid, const char *file, const posix_spawn_file_actions_t *fa, const posix_spawnattr_t *attrp,
                 char *const argv[], char *const envp[]) {
  typedef int (*fn_t)(pid_t *, const char *, const posix_spawn_file_actions_t *, const posix_spawnattr_t *,
                      char *const[], char *const[]);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "posix_spawnp");
  char buf[2048];
  const char *target = file;
  if (!in_shim) {
    in_shim = 1;
    target = remap_shell_path(file, argv, envp, buf, sizeof(buf));
    in_shim = 0;
  }
  return real_fn(pid, target, fa, attrp, argv, envp);
}

static int handle_openat_common(int (*real_fn)(int, const char *, int, mode_t), int dirfd, const char *pathname,
                                int flags, mode_t mode) {
  int ret = real_fn(dirfd, pathname, flags, mode);
  int saved = errno;
  if (!in_shim && pathname) {
    in_shim = 1;
    int is_write = (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) != 0;
    if (ret >= 0) {
      trace_vfs_event(is_write ? 'W' : 'R', dirfd, pathname);
    } else if (is_write && (saved == EACCES || saved == EPERM || saved == EROFS)) {
      trace_vfs_event('E', dirfd, pathname);
    }
    in_shim = 0;
  }
  errno = saved;
  return ret;
}

int open(const char *pathname, int flags, ...) {
  typedef int (*fn_t)(int, const char *, int, mode_t);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "openat");
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  return handle_openat_common(real_fn, AT_FDCWD, pathname, flags, mode);
}

int open64(const char *pathname, int flags, ...) {
  typedef int (*fn_t)(int, const char *, int, mode_t);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "openat64");
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "openat");
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  return handle_openat_common(real_fn, AT_FDCWD, pathname, flags, mode);
}

int openat(int dirfd, const char *pathname, int flags, ...) {
  typedef int (*fn_t)(int, const char *, int, mode_t);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "openat");
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  return handle_openat_common(real_fn, dirfd, pathname, flags, mode);
}

int openat64(int dirfd, const char *pathname, int flags, ...) {
  typedef int (*fn_t)(int, const char *, int, mode_t);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "openat64");
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "openat");
  mode_t mode = 0;
  if (flags & O_CREAT) {
    va_list ap;
    va_start(ap, flags);
    mode = (mode_t)va_arg(ap, int);
    va_end(ap);
  }
  return handle_openat_common(real_fn, dirfd, pathname, flags, mode);
}

int creat(const char *pathname, mode_t mode) {
  return open(pathname, O_CREAT | O_WRONLY | O_TRUNC, mode);
}

int creat64(const char *pathname, mode_t mode) {
  return open64(pathname, O_CREAT | O_WRONLY | O_TRUNC, mode);
}

FILE *fopen(const char *pathname, const char *mode) {
  typedef FILE *(*fn_t)(const char *, const char *);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "fopen");
  FILE *fp = real_fn(pathname, mode);
  int saved = errno;
  if (!in_shim && pathname && mode) {
    in_shim = 1;
    int is_write = (strchr(mode, 'w') != NULL || strchr(mode, 'a') != NULL || strchr(mode, '+') != NULL);
    if (fp != NULL) {
      trace_vfs_event(is_write ? 'W' : 'R', AT_FDCWD, pathname);
    } else if (is_write && (saved == EACCES || saved == EPERM || saved == EROFS)) {
      trace_vfs_event('E', AT_FDCWD, pathname);
    }
    in_shim = 0;
  }
  errno = saved;
  return fp;
}

FILE *fopen64(const char *pathname, const char *mode) {
  typedef FILE *(*fn_t)(const char *, const char *);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "fopen64");
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "fopen");
  FILE *fp = real_fn(pathname, mode);
  int saved = errno;
  if (!in_shim && pathname && mode) {
    in_shim = 1;
    int is_write = (strchr(mode, 'w') != NULL || strchr(mode, 'a') != NULL || strchr(mode, '+') != NULL);
    if (fp != NULL) {
      trace_vfs_event(is_write ? 'W' : 'R', AT_FDCWD, pathname);
    } else if (is_write && (saved == EACCES || saved == EPERM || saved == EROFS)) {
      trace_vfs_event('E', AT_FDCWD, pathname);
    }
    in_shim = 0;
  }
  errno = saved;
  return fp;
}

int unlink(const char *pathname) {
  typedef int (*fn_t)(const char *);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "unlink");
  int ret = real_fn(pathname);
  int saved = errno;
  if (!in_shim) {
    in_shim = 1;
    if (ret == 0) trace_vfs_event('D', AT_FDCWD, pathname);
    else if (saved == EACCES || saved == EPERM || saved == EROFS) trace_vfs_event('E', AT_FDCWD, pathname);
    in_shim = 0;
  }
  errno = saved;
  return ret;
}

int unlinkat(int dirfd, const char *pathname, int flags) {
  typedef int (*fn_t)(int, const char *, int);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "unlinkat");
  int ret = real_fn(dirfd, pathname, flags);
  int saved = errno;
  if (!in_shim) {
    in_shim = 1;
    if (ret == 0) trace_vfs_event('D', dirfd, pathname);
    else if (saved == EACCES || saved == EPERM || saved == EROFS) trace_vfs_event('E', dirfd, pathname);
    in_shim = 0;
  }
  errno = saved;
  return ret;
}

int rename(const char *oldpath, const char *newpath) {
  typedef int (*fn_t)(const char *, const char *);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "rename");
  int ret = real_fn(oldpath, newpath);
  int saved = errno;
  if (!in_shim) {
    in_shim = 1;
    if (ret == 0) {
      if (oldpath) trace_vfs_event('D', AT_FDCWD, oldpath);
      if (newpath) trace_vfs_event('W', AT_FDCWD, newpath);
    } else if ((saved == EACCES || saved == EPERM || saved == EROFS) && newpath) {
      trace_vfs_event('E', AT_FDCWD, newpath);
    }
    in_shim = 0;
  }
  errno = saved;
  return ret;
}

int renameat(int olddirfd, const char *oldpath, int newdirfd, const char *newpath) {
  typedef int (*fn_t)(int, const char *, int, const char *);
  static fn_t real_fn = NULL;
  if (!real_fn) *(void **)(&real_fn) = dlsym(RTLD_NEXT, "renameat");
  int ret = real_fn(olddirfd, oldpath, newdirfd, newpath);
  int saved = errno;
  if (!in_shim) {
    in_shim = 1;
    if (ret == 0) {
      if (oldpath) trace_vfs_event('D', olddirfd, oldpath);
      if (newpath) trace_vfs_event('W', newdirfd, newpath);
    } else if ((saved == EACCES || saved == EPERM || saved == EROFS) && newpath) {
      trace_vfs_event('E', newdirfd, newpath);
    }
    in_shim = 0;
  }
  errno = saved;
  return ret;
}
