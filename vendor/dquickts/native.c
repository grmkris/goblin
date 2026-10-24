/* One stateless native slice. The HTTP controller owns auth and snapshot sealing. */
#include <errno.h>
#include <limits.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <signal.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>
#include "driver.c"

static uint64_t ns(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000000000u + t.tv_nsec;
}
#define DENY(n) BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_##n, 0, 1), BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM)
static int no_network(void) {
    struct sock_filter rules[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000u, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        DENY(socket), DENY(socketpair), DENY(connect), DENY(bind), DENY(listen),
        DENY(accept), DENY(accept4), DENY(sendto), DENY(sendmsg), DENY(recvfrom), DENY(recvmsg),
        DENY(execve), DENY(execveat), DENY(clone), DENY(fork), DENY(vfork), DENY(ptrace),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog policy = { .len = sizeof(rules) / sizeof(rules[0]), .filter = rules };
    return prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) || prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &policy);
}
static char *read_bytes(unsigned n) {
    if (n > 4u * 1024u * 1024u) return NULL;
    char *p = malloc((size_t)n + 1);
    if (!p || fread(p, 1, n, stdin) != n) { free(p); return NULL; }
    p[n] = 0;
    return p;
}
int main(void) {
    unsigned op, budget, bn, dn, in;
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || no_network()) return 70;
    if (scanf("%u %u %u %u %u", &op, &budget, &bn, &dn, &in) != 5 || getchar() != '\n') return 71;
    char *base = read_bytes(bn), *delta = read_bytes(dn), *input = read_bytes(in);
    if (!base || !delta || !input) return 72;
    uint64_t eval_ns = 0, snapshot_ns = 0, restore_resume_ns = 0, start;
    unsigned out_bn = bn, out_dn = 0;
    const uint8_t *out_delta = NULL;
    if (op >= 4) {
        errno = 0;
        if (op == 4) { int fd = socket(AF_INET, SOCK_STREAM, 0); if (fd >= 0) close(fd); }
        else if (op == 5) { void *p = malloc(256u * 1024u * 1024u); if (p) { memset(p, 1, 256u * 1024u * 1024u); free(p); } }
        else { for (;;) pause(); }
        snprintf(output, sizeof(output), "{\"ok\":true,\"value\":{\"errno\":%d},\"logs\":[]}", errno);
        status = 0; out_bn = 0;
    } else if (op == 0) {
        start = ns();
        dq_init();
        const uint8_t *p = dq_snapshot(1);
        bn = (unsigned)dq_snapshot_len();
        free(base); base = malloc(bn);
        if (!p || !base) return 73;
        memcpy(base, p, bn); out_bn = bn;
        snapshot_ns += ns() - start;
        dq_budget((int)budget, INT_MAX);
        start = ns(); dq_eval(input, in); eval_ns = ns() - start;
    } else {
        start = ns();
        dq_restore((const uint8_t *)base, bn, (const uint8_t *)delta, dn);
        if (status >= 0 && op == 1) { dq_budget((int)budget, INT_MAX); dq_resume(input, in); }
        restore_resume_ns = ns() - start;
    }
    if (status == 1) {
        start = ns(); out_delta = dq_snapshot(2); out_dn = (unsigned)dq_snapshot_len(); snapshot_ns += ns() - start;
        if (!out_delta) status = -1;
    } else out_bn = 0;
    unsigned on = (unsigned)strlen(output);
    printf("%d %d %u %u %u %llu %llu %llu\n", status, dq_remaining(), out_bn, out_dn, on,
           (unsigned long long)eval_ns, (unsigned long long)snapshot_ns, (unsigned long long)restore_resume_ns);
    fwrite(base, 1, out_bn, stdout); fwrite(out_delta, 1, out_dn, stdout); fwrite(output, 1, on, stdout);
    dq_dispose(); free(base); free(delta); free(input);
    return 0;
}
