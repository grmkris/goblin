/* Minimal synchronous, single-runtime embedding. Trusted snapshots only. */
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "quickjs.h"

static JSRuntime *rt;
static JSContext *ctx;
static JSValue pending = JS_UNDEFINED;
static int status; /* 0 done/ready, 1 suspended, -1 error */
static char output[270336];
static int fuel, slice;
static uint8_t *snapshot;
static size_t snapshot_len;

static void text(const char *s) { snprintf(output, sizeof(output), "%s", s ? s : "<null>"); }
static int error(const char *s) { text(s); return status = -1; }
static int exception(void)
{
    JSValue exc = JS_GetException(ctx);
    const char *s = JS_ToCString(ctx, exc);
    error(s ? s : "exception converting error");
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, exc);
    return status;
}
static int json_output(JSValueConst value)
{
    JSValue json = JS_JSONStringify(ctx, value, JS_UNDEFINED, JS_UNDEFINED);
    if (JS_IsException(json)) return exception();
    const char *s = JS_ToCString(ctx, json);
    if (!s) { JS_FreeValue(ctx, json); return exception(); }
    if (strlen(s) >= sizeof(output)) {
        JS_FreeCString(ctx, s); JS_FreeValue(ctx, json);
        return error("output limit exceeded");
    }
    text(s);
    JS_FreeCString(ctx, s);
    JS_FreeValue(ctx, json);
    return status;
}

/* The name and args survive as a host root in the snapshot. No I/O here. */
static JSValue host_call(JSContext *c, JSValueConst self, int argc, JSValueConst *argv)
{
    JS_FreeValue(c, pending);
    pending = JS_NewObject(c);
    JS_SetPropertyStr(c, pending, "callName", argc ? JS_DupValue(c, argv[0]) : JS_UNDEFINED);
    JS_SetPropertyStr(c, pending, "args", argc > 1 ? JS_DupValue(c, argv[1]) : JS_UNDEFINED);
    return JS_SuspendCall(c);
}
static const void *const natives[] = { (const void *)host_call };
static const JSSnapshotHost host = { .natives = natives, .native_count = 1 };

/* Fuel is host-owned and persisted with every checkpoint, never reset on restore. */
static int interrupt(JSRuntime *runtime, void *opaque)
{
    if (fuel-- <= 0) return 1;
    if (--slice <= 0) {
        JS_FreeValue(ctx, pending);
        pending = JS_NewObject(ctx);
        JS_SetPropertyStr(ctx, pending, "callName", JS_NewString(ctx, "$yield"));
        JS_SetPropertyStr(ctx, pending, "args", JS_NULL);
        JS_RequestSuspend(runtime);
    }
    return 0;
}
void dq_budget(int remaining, int quantum) { fuel = remaining; slice = quantum; JS_SetInterruptHandler(rt, interrupt, NULL); }
int dq_remaining(void) { return fuel > 0 ? fuel : 0; }

void dq_dispose(void)
{
    if (ctx) { JS_FreeValue(ctx, pending); JS_FreeContext(ctx); }
    if (rt) JS_FreeRuntime(rt);
    ctx = NULL; rt = NULL; pending = JS_UNDEFINED;
    free(snapshot); snapshot = NULL; snapshot_len = 0;
    output[0] = 0; status = 0;
}
static int new_runtime(void)
{
    rt = JS_NewRuntime();
    if (!rt) return error("JS_NewRuntime failed");
    JS_SetMemoryLimit(rt, 8u * 1024u * 1024u);
    JS_SetMaxStackSize(rt, 512u * 1024u);
    return 0;
}
int dq_init(void)
{
    dq_dispose();
    if (new_runtime()) return status;
    ctx = JS_NewContext(rt);
    if (!ctx) return error("JS_NewContext failed");
    JSValue global = JS_GetGlobalObject(ctx);
    JS_SetPropertyStr(ctx, global, "hostCall", JS_NewCFunction(ctx, host_call, "hostCall", 2));
    JS_FreeValue(ctx, global);
    return 0;
}
static int completion(JSValue value)
{
    if (JS_IsException(value)) {
        if (JS_IsSuspended(rt)) { status = 1; return json_output(pending); }
        return exception();
    }
    status = 0;
    json_output(value);
    JS_FreeValue(ctx, value);
    return status;
}
int dq_eval(const char *src, size_t len)
{
    if (!ctx) return error("initialize first");
    if (JS_IsSuspended(rt)) return error("already suspended");
    /* TypeScript parser also accepts ordinary JavaScript. */
    return completion(JS_Eval(ctx, src, len, "<embedding.ts>",
                             JS_EVAL_TYPE_GLOBAL | JS_EVAL_FLAG_TYPESCRIPT));
}
int dq_resume(const char *json, size_t len)
{
    if (!ctx || !JS_IsSuspended(rt)) return error("no suspended call");
    JSValue value = JS_ParseJSON(ctx, json, len, "<resume.json>");
    if (JS_IsException(value)) return exception();
    JS_FreeValue(ctx, pending); pending = JS_UNDEFINED;
    return completion(JS_ResumeWith(ctx, value, 0));
}
/* Copy result immediately; the pointer expires at the next snapshot/dispose. */
const uint8_t *dq_snapshot(int flags)
{
    if (!ctx) { error("initialize first"); return NULL; }
    free(snapshot); snapshot = NULL; snapshot_len = 0;
    size_t len = 0;
    uint8_t *buf = JS_WriteSnapshot(ctx, &len, &host, &pending, 1, flags);
    if (!buf) { exception(); return NULL; }
    snapshot = malloc(len);
    if (snapshot) { memcpy(snapshot, buf, len); snapshot_len = len; }
    js_free(ctx, buf);
    if (!snapshot) error("snapshot copy allocation failed");
    return snapshot;
}
size_t dq_snapshot_len(void) { return snapshot_len; }
int dq_restore(const uint8_t *base, size_t base_len, const uint8_t *delta, size_t delta_len)
{
    /* Inputs must be host-allocated copies, never dq_snapshot's own buffer. */
    dq_dispose();
    if (new_runtime()) return status;
    JSSnapshotResult res;
    char err[256];
    if (JS_ReadSnapshot(rt, base, base_len, delta, delta_len, &host, &res, err, sizeof(err))) {
        JS_FreeRuntime(rt); rt = NULL;
        return error(err);
    }
    if (res.context_count != 1 || res.root_count != 1) {
        for (int i = 0; i < res.root_count; i++) JS_FreeValueRT(rt, res.roots[i]);
        for (int i = 0; i < res.context_count; i++) JS_FreeContext(res.contexts[i]);
        JS_FreeSnapshotResult(rt, &res);
        JS_FreeRuntime(rt); rt = NULL;
        return error("expected one context and one root");
    }
    ctx = res.contexts[0]; pending = res.roots[0];
    JS_FreeSnapshotResult(rt, &res);
    status = JS_IsSuspended(rt) ? 1 : 0;
    if (status == 1) json_output(pending); else text("restored");
    return status;
}
int dq_status(void) { return status; }
const char *dq_output(void) { return output; }
void *dq_alloc(size_t len) { return malloc(len); }
void dq_free(void *ptr) { free(ptr); }
size_t dq_heap_used(void)
{
    if (!rt) return 0;
    JSMemoryUsage usage;
    JS_ComputeMemoryUsage(rt, &usage);
    return usage.memory_used_size;
}
