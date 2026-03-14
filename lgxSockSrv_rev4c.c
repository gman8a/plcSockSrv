/*==============================================================================
 * BEGIN-OF-FILE: lgxSockSrv_rev4a.c
 *==============================================================================
 * File:    lgxSockSrv_rev4a.c
 * Date:    2026-03-09
 * Authors: Gary Argraves & Claude & Gemini (cross banter mojonation)
 *
 * Purpose:
 *   CompactLogix (DINT) socket server — Dual-Registry + BOOL Read Edition.
 *   Extends rev3b with read-only BOOL singleton support loaded from an
 *   external tag file at startup. No BOOL writes. No BOOL mirror.
 *
 * Compile "C" Low-level-driver (LLD):
 *   gcc -o lgxSockSrv lgxSockSrv_rev4a.c -lplctag
 *	 cd ~/mic/plcC;
 *   ./cc1
 *   gcc -o lgxSockSrv_rev4c lgxSockSrv_rev4c.c  -I/usr/local/include -L/usr/local/lib -lplctag
 *       rm ./plcSockSrv
 *       ln -s lgxSockSrv_rev4c plcSockSrv
 *
 * Usage:
 *   ./lgxSockSrv <plc_ip> <path> <port> [bool_tag_file]
 *     plc_ip        : PLC IP address          e.g.  10.13.80.11
 *     path          : backplane/slot path     e.g.  1,0
 *     port          : TCP listen port         e.g.  9002  (PLC#1)  9003 (PLC#2)
 *     bool_tag_file : optional path to BOOL tag list, one tag per line
 *                     e.g.  /etc/plc/bool_tags.txt
 *
 *   Examples:
 *     ./lgxSockSrv 10.13.80.11 1,0 9002
 *     ./lgxSockSrv 10.13.80.11 1,0 9002 /etc/plc/bool_tags.txt
 *
 *   No args: falls back to compiled-in defaults (10.13.80.11 / 1,0 / 9002)
 *
 *   bool_tag_file format — one tag name per line, blank lines ignored:
 *     AIR_OK
 *     SYSTEM_RUNNING
 *     SORTER_START
 *
 *   Client protocol (TCP):
 *     R,PCDATA[0],10;        -> Range read 10 DINTs from index 0
 *     RM,PCDATA[0],10;       -> Mirror read (local cache, no PLC hit)
 *     W,PCDATA[5],100,200;   -> Surgical write: idx5=100, idx6=200
 *     R,MySingleton,;        -> Read a DINT singleton tag
 *     W,MySingleton,42;      -> Write a DINT singleton tag
 *     R,SYSTEM_RUNNING,;     -> Read a BOOL tag  -> ROK:SYSTEM_RUNNING=1;
 *     RM,SYSTEM_RUNNING,;    -> REJECTED         -> VERR:no_mirror_for_bool;
 *     W,SYSTEM_RUNNING,1;    -> REJECTED         -> VERR:bool_write_not_supported;
 *
 * Architecture:
 *   ReadRegistry  - R / RM commands. Owns mirror buffer + DataWindow slabs.
 *                   REG_TYPE_BOOL: no mirror, elem_size=1, read-only hard reads.
 *   WriteRegistry - W command only. Owns cached per-element TIDs. No mirror.
 *   Decoupling ensures Write never allocates mirror memory.
 *
 * Features:
 *   - Dual-registry separation (ReadRegistry / WriteRegistry)
 *   - REG_TYPE_BOOL: read-only, no mirror, elem_size=1, file-loaded tag list
 *   - SINGLETON tag support (no bracket notation, elem_count=1, no index)
 *   - DataWindow mini-slab TID caching on ReadRegistry
 *   - Dynamic growth for both registry types (realloc on demand)
 *   - Registry invalidation (clear_read_registry / clear_write_registry)
 *     on PLC tag errors so bad tags don't stay cached
 *   - Full epoll non-blocking main loop with per-client recv buffering
 *   - Surgical bulk write: each DINT gets its own cached TID
 *   - Mirror NOT updated on write — PLC is sole source of truth
 *==============================================================================*/

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <libplctag.h>
#include <stdbool.h>
#include <ctype.h>
#include <poll.h>
#include <time.h>
#include <fcntl.h>
#include <errno.h>
#include <stdint.h>
#include <sys/epoll.h>

#define PLC_TIMEOUT        5000
#define READ_RESP_LEN      2048
#define RECV_BUFFER_SIZE   1024
#define MAX_REGISTRIES     256
#define MAX_BOOL_TAGS      512
#define BOOL_TAG_NAME_LEN   64

/*==============================================================================
 * BOOL TAG TABLE — loaded from file at startup
 *============================================================================*/

/* doc_bool_table(){
   Runtime BOOL tag table loaded from optional 4th arg file.
   One tag name per line. Blank lines silently skipped.
   is_bool_tag() does a simple linear search — table is small,
   called only at registry creation time, not per-request.
   No BOOL writes permitted. No BOOL mirror allocated.
*/
static char  bool_tag_table[MAX_BOOL_TAGS][BOOL_TAG_NAME_LEN];
static int   bool_tag_count = 0;

bool is_bool_tag(const char *name) {
    for (int i = 0; i < bool_tag_count; i++)
        if (strcmp(bool_tag_table[i], name) == 0) return true;
    return false;
}

void load_bool_tags(const char *filepath) {
    FILE *f = fopen(filepath, "r");
    if (!f) {
        printf("WARNING load_bool_tags  cannot open file: %s — no BOOL tags loaded\n",
               filepath);
        return;
    }
    char line[BOOL_TAG_NAME_LEN];
    while (fgets(line, sizeof(line), f)) {
        /* Strip trailing newline / whitespace */
        char *end = line + strlen(line) - 1;
        while (end >= line && (*end == '\n' || *end == '\r' || *end == ' ')) *end-- = '\0';
        if (line[0] == '\0') continue; /* skip blank lines */
        if (bool_tag_count >= MAX_BOOL_TAGS) {
            printf("WARNING load_bool_tags  MAX_BOOL_TAGS=%d reached, truncating\n",
                   MAX_BOOL_TAGS);
            break;
        }
        strncpy(bool_tag_table[bool_tag_count++], line, BOOL_TAG_NAME_LEN - 1);
    }
    fclose(f);
    printf("SUCCESS load_bool_tags  loaded %d BOOL tags from %s\n",
           bool_tag_count, filepath);
}

/*==============================================================================
 * DATA STRUCTURES
 *============================================================================*/

/*------------------------------------------------------------------------------
 * DataWindow: a cached libplctag TID covering [offset .. offset+size-1]
 *----------------------------------------------------------------------------*/
/* doc_data_window(){
   A mini-slab: one plc_tag_create handle for a contiguous element range.
   Cached inside ReadRegistry so repeated reads reuse the same TID.
   Created on first access via get_or_create_window().
   BOOL tags always have offset=0, size=1, elem_size=1.
*/
typedef struct {
    int32_t tid;
    int     offset;
    int     size;
} DataWindow;

/*------------------------------------------------------------------------------
 * RegType: SINGLETON and ARRAY are DINT. BOOL is scalar, elem_size=1.
 *----------------------------------------------------------------------------*/
typedef enum {
    REG_TYPE_SINGLETON,   /* DINT scalar, no index                  */
    REG_TYPE_ARRAY,       /* DINT array,  indexed with [n]          */
    REG_TYPE_BOOL         /* BOOL scalar, read-only, no mirror      */
} RegType;

/*------------------------------------------------------------------------------
 * ReadRegistry: R and RM commands
 *   - REG_TYPE_BOOL: mirror=NULL always, elem_size=1 in tag attrs
 *   - mirror[]     : local copy of last PLC read, indexed by element position
 *   - windows[]    : cached DataWindow slabs for hard reads
 *   - type         : SINGLETON or ARRAY
 *----------------------------------------------------------------------------*/
typedef struct {
    char       baseName[64];
    RegType    type;
    int32_t   *mirror;
    int        mirror_size;
    DataWindow *windows;
    int        window_count;
    int        window_capacity;
} ReadRegistry;

/*------------------------------------------------------------------------------
 * WriteRegistry: owned by W (surgical write) only
 *   - W command only — DINT types only
 *   - surgicalTids[]: one cached TID per element index, zero = not yet created
 *   - type          : SINGLETON or ARRAY
 *   No mirror. No DataWindows. Writes never read back.
 *----------------------------------------------------------------------------*/
typedef struct {
    char     baseName[64];
    RegType  type;
    int32_t *surgicalTids;
    int      tid_size;
} WriteRegistry;

static ReadRegistry  *read_pool[MAX_REGISTRIES]  = {0};
static WriteRegistry *write_pool[MAX_REGISTRIES] = {0};
static int read_count  = 0;
static int write_count = 0;

/*------------------------------------------------------------------------------
 * Per-client recv state for the epoll loop
 *----------------------------------------------------------------------------*/
typedef struct {
    int  fd;
    char recv_buffer[RECV_BUFFER_SIZE];
    int  buffer_pos;
} ClientState;

typedef struct {
    char plc_ip[64], plc_path[32], plc_cpu[16];
    int  server_port;
} config_t;

/* Defaults — overridden by command-line args at runtime */
config_t config = { "10.13.80.11", "1,0", "LGX", 9002 };

/*==============================================================================
 * STARTUP: ARG PARSING
 *============================================================================*/

/* doc_parse_args(){
   parse_args: populate config from argv at startup.
   Usage: ./lgxSockSrv <plc_ip> <path> <port> [bool_tag_file]
   First three args required together; missing args fall back to compiled defaults.
   4th arg (bool_tag_file) is optional — no file means no BOOL tag support.
   CPU type is constant "LGX" — not exposed as an arg.
*/
void parse_args(int argc, char *argv[]) {
    if (argc < 4) {
        printf("INFO  parse_args  no args supplied — using compiled defaults\n");
        printf("INFO  parse_args  plc_ip=%s path=%s port=%d\n",
               config.plc_ip, config.plc_path, config.server_port);
        return;
    }
    strncpy(config.plc_ip,   argv[1], sizeof(config.plc_ip)   - 1);
    strncpy(config.plc_path, argv[2], sizeof(config.plc_path) - 1);
    config.server_port = atoi(argv[3]);
    /* cpu stays "LGX" — constant across all CompactLogix targets */
    printf("INFO  parse_args  plc_ip=%s path=%s port=%d cpu=%s\n",
           config.plc_ip, config.plc_path, config.server_port, config.plc_cpu);
    if (argc >= 5)
        load_bool_tags(argv[4]);
    else
        printf("INFO  parse_args  no bool_tag_file supplied — BOOL support disabled\n");
}

/*==============================================================================
 * UTILITIES
 *============================================================================*/

void send_response(int fd, const char *response) {
    send(fd, response, strlen(response), MSG_NOSIGNAL);
}

/*------------------------------------------------------------------------------
 * wait_for_tag: spin-wait on PLCTAG_STATUS_PENDING with a hard iteration cap
 *----------------------------------------------------------------------------*/
static void wait_for_tag(int32_t tid) {
    int t = 0;
    while (plc_tag_status(tid) == PLCTAG_STATUS_PENDING && ++t < 500)
        usleep(10000);
}

/*==============================================================================
 * READ REGISTRY MANAGEMENT
 *============================================================================*/

/* doc_read_registry(){
   ReadRegistry lifecycle:
     get_read_registry()    - lookup or create; resolves BOOL/SINGLETON/ARRAY
     grow_read_registry()   - realloc mirror on demand (DINT types only)
     get_or_create_window() - find or create cached DataWindow slab
     clear_read_registry()  - invalidate on PLC error (baseName zeroed)
   BOOL path: mirror is never allocated, elem_size=1 in plc_tag_create attrs.
*/

ReadRegistry* get_read_registry(const char *base, bool is_array) {
    for (int i = 0; i < read_count; i++)
        if (strcmp(read_pool[i]->baseName, base) == 0) return read_pool[i];

    ReadRegistry *rr = calloc(1, sizeof(ReadRegistry));
    strcpy(rr->baseName, base);

    if (is_bool_tag(base)) {
        rr->type        = REG_TYPE_BOOL;
        rr->mirror      = NULL;   /* BOOL: no mirror, ever */
        rr->mirror_size = 0;
        printf("INFO  get_read_registry  NEW BOOL baseName=%s\n", base);
    } else if (is_array) {
        rr->type        = REG_TYPE_ARRAY;
        rr->mirror_size = 256;
        rr->mirror      = calloc(rr->mirror_size, sizeof(int32_t));
        printf("INFO  get_read_registry  NEW ARRAY baseName=%s\n", base);
    } else {
        rr->type        = REG_TYPE_SINGLETON;
        rr->mirror_size = 1;
        rr->mirror      = calloc(1, sizeof(int32_t));
        printf("INFO  get_read_registry  NEW SINGLETON baseName=%s\n", base);
    }

    read_pool[read_count++] = rr;
    return rr;
}

void grow_read_registry(ReadRegistry *rr, int needed) {
    if (rr->type == REG_TYPE_BOOL) return; /* BOOL never grows a mirror */
    if (needed <= rr->mirror_size) return;
    int new_size = (needed >= 512) ? needed + 64 : 512;
    rr->mirror = realloc(rr->mirror, new_size * sizeof(int32_t));
    memset(rr->mirror + rr->mirror_size, 0,
           (new_size - rr->mirror_size) * sizeof(int32_t));
    rr->mirror_size = new_size;
    printf("INFO  grow_read_registry  baseName=%s new_size=%d\n",
           rr->baseName, new_size);
}

/*------------------------------------------------------------------------------
 * get_or_create_window
 *   BOOL:      offset=0, size=1, elem_size=1 in attrs string
 *   SINGLETON: offset=0, size=1, elem_size=4
 *   ARRAY:     offset=start, size=count, elem_size=4
 *----------------------------------------------------------------------------*/
DataWindow* get_or_create_window(ReadRegistry *rr, int start, int count) {
    /* Search existing windows */
    for (int i = 0; i < rr->window_count; i++)
        if (rr->windows[i].offset == start && rr->windows[i].size == count)
            return &rr->windows[i];

    /* Grow window array if needed */
    if (rr->window_count >= rr->window_capacity) {
        rr->window_capacity = (rr->window_capacity == 0) ? 4 : rr->window_capacity * 2;
        rr->windows = realloc(rr->windows, rr->window_capacity * sizeof(DataWindow));
    }

    DataWindow *w = &rr->windows[rr->window_count++];
    w->offset = start;
    w->size   = count;

    char attrs[256];
    if (rr->type == REG_TYPE_BOOL) {
        /* BOOL: elem_size=1, no index bracket */
        snprintf(attrs, sizeof(attrs),
            "protocol=ab-eip&gateway=%s&path=%s&cpu=%s"
            "&elem_size=1&elem_count=1&name=%s",
            config.plc_ip, config.plc_path, config.plc_cpu,
            rr->baseName);
    } else if (rr->type == REG_TYPE_ARRAY) {
        snprintf(attrs, sizeof(attrs),
            "protocol=ab-eip&gateway=%s&path=%s&cpu=%s"
            "&elem_size=4&elem_count=%d&name=%s[%d]",
            config.plc_ip, config.plc_path, config.plc_cpu,
            count, rr->baseName, start);
    } else {
        /* SINGLETON */
        snprintf(attrs, sizeof(attrs),
            "protocol=ab-eip&gateway=%s&path=%s&cpu=%s"
            "&elem_size=4&elem_count=1&name=%s",
            config.plc_ip, config.plc_path, config.plc_cpu,
            rr->baseName);
    }

    printf("INFO  get_or_create_window  plc_tag_create: %s\n", attrs);
    w->tid = plc_tag_create(attrs, PLC_TIMEOUT);
    wait_for_tag(w->tid);

    if (w->tid < 0)
        printf("ERROR get_or_create_window  bad tid<0 baseName=%s\n", rr->baseName);
    return w;
}

void clear_read_registry(const char *base) {
    for (int i = 0; i < read_count; i++) {
        if (strcmp(read_pool[i]->baseName, base) == 0) {
            printf("WARNING clear_read_registry  invalidating baseName=%s index=%d\n",
                   base, i);
            read_pool[i]->baseName[0] = '\0';
            break;
        }
    }
}

/*==============================================================================
 * WRITE REGISTRY MANAGEMENT
 *============================================================================*/

/* doc_write_registry(){
   WriteRegistry lifecycle — DINT only, BOOL writes are rejected at dispatcher.
     get_write_registry()   - lookup or create SINGLETON or ARRAY
     grow_write_registry()  - realloc surgicalTids[] on demand
     clear_write_registry() - invalidate on PLC error
*/

WriteRegistry* get_write_registry(const char *base, bool is_array) {
    for (int i = 0; i < write_count; i++)
        if (strcmp(write_pool[i]->baseName, base) == 0) return write_pool[i];

    WriteRegistry *wr = calloc(1, sizeof(WriteRegistry));
    strcpy(wr->baseName, base);
    wr->type = is_array ? REG_TYPE_ARRAY : REG_TYPE_SINGLETON;

    if (is_array) {
        wr->tid_size     = 256;
        wr->surgicalTids = calloc(wr->tid_size, sizeof(int32_t));
    } else {
        /* SINGLETON: only needs one TID slot */
        wr->tid_size     = 1;
        wr->surgicalTids = calloc(1, sizeof(int32_t));
    }
    write_pool[write_count++] = wr;
    printf("INFO  get_write_registry  NEW baseName=%s type=%s\n",
           base, is_array ? "ARRAY" : "SINGLETON");
    return wr;
}

void grow_write_registry(WriteRegistry *wr, int idx) {
    if (idx < wr->tid_size) return;
    int new_size = (idx >= 512) ? idx + 64 : 512;
    wr->surgicalTids = realloc(wr->surgicalTids, new_size * sizeof(int32_t));
    for (int i = wr->tid_size; i < new_size; i++) wr->surgicalTids[i] = 0;
    wr->tid_size = new_size;
    printf("INFO  grow_write_registry  baseName=%s new_size=%d\n",
           wr->baseName, new_size);
}

void clear_write_registry(const char *base) {
    for (int i = 0; i < write_count; i++) {
        if (strcmp(write_pool[i]->baseName, base) == 0) {
            printf("WARNING clear_write_registry  invalidating baseName=%s index=%d\n",
                   base, i);
            write_pool[i]->baseName[0] = '\0';
            break;
        }
    }
}

/*==============================================================================
 * COMMAND HANDLERS
 *============================================================================*/

/*------------------------------------------------------------------------------
 * handle_surgical_write — DINT only
 *   BOOL writes are rejected before this function is ever called.
 *   Iterates comma-separated payload. Each DINT value gets its own cached TID.
 *   SINGLETON: only one token consumed; index always 0.
 *   ARRAY:     advances current_idx per token.
 *   Mirror is NEVER updated — PLC is sole source of truth.
 *----------------------------------------------------------------------------*/
void handle_surgical_write(int fd, WriteRegistry *wr, int start_idx, char *payload) {
    char *token = strtok(payload, ",");
    int   ok    = 0, err = 0, curr = start_idx;

    while (token != NULL) {
        int32_t val       = (int32_t)atoi(token);
        int32_t write_tid = 0;

        if (wr->type == REG_TYPE_SINGLETON) {
            /* Singleton: TID lives at slot 0 */
            if (wr->surgicalTids[0] == 0) {
                char attr[256];
                snprintf(attr, sizeof(attr),
                    "protocol=ab-eip&gateway=%s&path=%s&cpu=%s"
                    "&elem_size=4&elem_count=1&name=%s",
                    config.plc_ip, config.plc_path, config.plc_cpu,
                    wr->baseName);
                wr->surgicalTids[0] = plc_tag_create(attr, PLC_TIMEOUT);
                wait_for_tag(wr->surgicalTids[0]);
            }
            write_tid = wr->surgicalTids[0];
        } else {
            /* Array: one TID per element index */
            grow_write_registry(wr, curr);
            if (wr->surgicalTids[curr] == 0) {
                char attr[256];
                snprintf(attr, sizeof(attr),
                    "protocol=ab-eip&gateway=%s&path=%s&cpu=%s"
                    "&elem_size=4&elem_count=1&name=%s[%d]",
                    config.plc_ip, config.plc_path, config.plc_cpu,
                    wr->baseName, curr);
                wr->surgicalTids[curr] = plc_tag_create(attr, PLC_TIMEOUT);
                wait_for_tag(wr->surgicalTids[curr]);
            }
            write_tid = wr->surgicalTids[curr];
        }

        if (write_tid > 0
            && plc_tag_set_int32(write_tid, 0, val) == PLCTAG_STATUS_OK) {
            if (plc_tag_write(write_tid, PLC_TIMEOUT) == PLCTAG_STATUS_OK) ok++;
            else {
                printf("ERROR handle_surgical_write  plc_tag_write failed "
                       "baseName=%s idx=%d — invalidating registry\n",
                       wr->baseName, curr);
                clear_write_registry(wr->baseName);
                err++;
                break; /* registry gone, no point continuing this payload */
            }
        } else {
            printf("ERROR handle_surgical_write  bad TID or set_int32 failed "
                   "baseName=%s idx=%d tid=%d — invalidating registry\n",
                   wr->baseName, curr, write_tid);
            clear_write_registry(wr->baseName);
            err++;
            break; /* registry gone, no point continuing this payload */
        }

        if (wr->type == REG_TYPE_SINGLETON) break; /* one DINT only */
        curr++;
        token = strtok(NULL, ",");
    }

    char resp[64];
    snprintf(resp, sizeof(resp), "WOK:%d,WERR:%d;\n", ok, err);
    send_response(fd, resp);
}

/*------------------------------------------------------------------------------
 * handle_read
 *   R  (is_mirror=false) : hard read from PLC via cached DataWindow slab.
 *                          DINT: updates mirror. BOOL: no mirror updated.
 *   RM (is_mirror=true)  : DINT/SINGLETON: returns mirror. BOOL: rejected.
 *
 *   Response formats:
 *     ROK:PCDATA[0]=10,20,30;\n       (ARRAY)
 *     ROK:MySingleton=42;\n           (SINGLETON)
 *     ROK:SYSTEM_RUNNING=1;\n         (BOOL)
 *     VERR:no_mirror_for_bool;\n      (RM on BOOL)
 *----------------------------------------------------------------------------*/
void handle_read(int fd, ReadRegistry *rr, int idx, char *payload, bool is_mirror) {
    int count = 1;

    /* --- BOOL path --- */
    if (rr->type == REG_TYPE_BOOL) {
        if (is_mirror) {
            send_response(fd, "VERR:no_mirror_for_bool;\n");
            return;
        }
        DataWindow *win = get_or_create_window(rr, 0, 1);
        if (win->tid < 0) {
            send_response(fd, "RERR:read_failed;\n");
            clear_read_registry(rr->baseName);
            return;
        }
        if (plc_tag_read(win->tid, PLC_TIMEOUT) != PLCTAG_STATUS_OK) {
            printf("ERROR handle_read  BOOL plc_tag_read failed baseName=%s\n",
                   rr->baseName);
            send_response(fd, "RERR:read_failed;\n");
            clear_read_registry(rr->baseName);
            return;
        }
        uint8_t bval = plc_tag_get_uint8(win->tid, 0);
        char resp[128];
        snprintf(resp, sizeof(resp), "ROK:%s=%d;\n", rr->baseName, bval ? 1 : 0);
        send_response(fd, resp);
        return;
    }

    /* --- SINGLETON path --- */
    if (rr->type == REG_TYPE_SINGLETON) {
        idx   = 0; /* safety */
        count = 1;
        printf("INFO  handle_read  SINGLETON=%s is_mirror=%d\n",
               rr->baseName, is_mirror);
    } else {
        /* --- ARRAY path --- */
        if (payload[0]) count = atoi(payload);
        /* Bounds guard */
        grow_read_registry(rr, idx + count);
        if (idx < 0 || idx + count > rr->mirror_size) {
            send_response(fd, "VERR:out_of_bounds;\n");
            return;
        }
    }

    printf("INFO  handle_read  baseName=%s idx=%d count=%d is_mirror=%d\n",
           rr->baseName, idx, count, is_mirror);

    if (!is_mirror) {
        /* Hard read path: use cached DataWindow slab */
        DataWindow *win = get_or_create_window(rr, idx, count);
        if (win->tid < 0) {
            send_response(fd, "RERR:read_failed;\n");
            clear_read_registry(rr->baseName);
            return;
        }
        if (plc_tag_read(win->tid, PLC_TIMEOUT) != PLCTAG_STATUS_OK) {
            printf("ERROR handle_read  plc_tag_read failed baseName=%s\n",
                   rr->baseName);
            send_response(fd, "RERR:read_failed;\n");
            clear_read_registry(rr->baseName);
            return;
        }
        /* Populate mirror from fresh PLC data */
        for (int i = 0; i < count; i++)
            rr->mirror[idx + i] = plc_tag_get_int32(win->tid, i * 4);
    } else {
        /* Mirror read: just return cached values */
        if (!rr->mirror) {
            send_response(fd, "VERR:no_mirror;\n");
            return;
        }
    }

    /* Build response */
    char *resp = malloc(READ_RESP_LEN);
    int   pos;
    if (rr->type == REG_TYPE_ARRAY)
        pos = snprintf(resp, READ_RESP_LEN, "%s:%s[%d]=",
                       is_mirror ? "RMOK" : "ROK", rr->baseName, idx);
    else
        pos = snprintf(resp, READ_RESP_LEN, "%s:%s=",
                       is_mirror ? "RMOK" : "ROK", rr->baseName);

    for (int i = 0; i < count; i++) {
        int32_t val = rr->mirror[idx + i];
        pos += snprintf(resp + pos, READ_RESP_LEN - pos,
                        "%d%s", val, (i < count - 1) ? "," : ";\n");
    }
    send_response(fd, resp);
    free(resp);
}

/*==============================================================================
 * REQUEST DISPATCHER
 *============================================================================*/
/* doc_handle_request(){
   Protocol:  CMD,ANCHOR[idx],PAYLOAD;
     CMD      : R | RM | W
     ANCHOR   : PLC tag name, optional [n] for array access
     PAYLOAD  : count (R/RM) or comma-separated values (W)
   BOOL tags  : R only. RM -> VERR. W -> VERR. Detected via is_bool_tag().
   Singletons : no bracket in ANCHOR, not in bool table -> REG_TYPE_SINGLETON
   Arrays     : bracket present -> REG_TYPE_ARRAY
*/
void handle_request(int fd, const char *request, int msg_len) {
    char buf[256];
    int  safe_len = (msg_len < (int)sizeof(buf) - 1) ? msg_len : (int)sizeof(buf) - 1;
    memcpy(buf, request, safe_len);
    buf[safe_len] = '\0';

    /* Strip leading/trailing whitespace and trailing semicolons */
    char *p = buf;
    while (*p && *p < 33) p++;
    char *end = p + strlen(p) - 1;
    while (end > p && (*end < 33 || *end == ';')) *end-- = '\0';

    char command[8], rawAnchor[64], payload[256] = {0};
    if (sscanf(p, "%7[^,],%63[^,],%255s", command, rawAnchor, payload) < 2) return;

    /* Parse index from anchor */
    int   idx      = 0;
    bool  is_array = false;
    char  base[64] = {0};
    char *bracket  = strchr(rawAnchor, '[');

    if (bracket) {
        is_array = true;
        strncpy(base, rawAnchor, bracket - rawAnchor);
        sscanf(bracket, "[%d]", &idx);
    } else {
        strcpy(base, rawAnchor);
    }

    printf("\nINFO  handle_request  cmd=%s anchor=%s base=%s idx=%d payload=%s\n",
           command, rawAnchor, base, idx, payload);

    /*--------------------------------------------------------------------------
     * BOOL WRITE GUARD — architectural boundary, do not remove.
     *
     * BOOL writes from the network layer are permanently prohibited.
     * This is not a missing feature — it is a deliberate safety boundary.
     *
     * REASON:
     *   PLC BOOL outputs (SOL_110, SORTER_START, SYSTEM_ENABLE, etc.) sit at
     *   the OUTPUT end of the PLC ladder logic chain. That chain exists to
     *   enforce interlocks: E-stop conditions, jam detection, speed limits,
     *   upstream/downstream zone coordination, and equipment protection logic.
     *
     *   Writing a BOOL directly from the network layer bypasses that entire
     *   chain. The network layer becomes the authority over a physical device
     *   output, with no interlock protection between the command and the
     *   hardware. In a conveyor environment this risks motor burnout, jams,
     *   and worker safety incidents.
     *
     * CORRECT PATTERNS for downstream layers that need to influence a BOOL:
     *
     *   1) DINT tag ownership:
     *      Define a DINT tag for the purpose. PLC ladder reads it, decides
     *      whether to honor it, sets the BOOL output through its own logic.
     *      The PLC remains authority over its outputs at all times.
     *
     *   2) Action DINT command word:
     *      A DINT where individual bits carry request meaning:
     *        bit 0 = request start,  bit 1 = request reset,
     *        bit 2 = request horn,   bit 3 = request divert, etc.
     *      PLC ladder scans the word, honors requests through interlock chain,
     *      clears the bit on acknowledgment. Proper request/acknowledge
     *      handshake. Network layer makes requests — PLC decides.
     *
     * ARCHITECTURAL LAW:
     *   Network layer   -> makes requests via DINT
     *   PLC ladder      -> owns authority over all BOOL outputs
     *   This server     -> enforces the boundary
     *--------------------------------------------------------------------------*/
    if (command[0] == 'W' && is_bool_tag(base)) {
        printf("WARNING handle_request  BOOL write rejected baseName=%s\n", base);
        send_response(fd, "VERR:bool_write_not_supported;\n");
        return;
    }

    if (command[0] == 'W') {
        WriteRegistry *wr = get_write_registry(base, is_array);
        if (!wr) return;
        handle_surgical_write(fd, wr, idx, payload);
    } else {
        /* R or RM — is_bool_tag() resolved inside get_read_registry */
        ReadRegistry *rr = get_read_registry(base, is_array);
        if (!rr) return;
        handle_read(fd, rr, idx, payload, (command[1] == 'M'));
    }
}

/*==============================================================================
 * MAIN — epoll non-blocking server loop
 *============================================================================*/
int main(int argc, char *argv[]) {
    parse_args(argc, argv);

    int listen_sock = socket(AF_INET, SOCK_STREAM, 0);
    if (listen_sock < 0) { perror("socket"); return 1; }

    int opt = 1;
    setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr = {
        .sin_family      = AF_INET,
        .sin_port        = htons(config.server_port),
        .sin_addr.s_addr = INADDR_ANY
    };
    if (bind(listen_sock, (struct sockaddr *)&addr, sizeof(addr)) < 0) {
        perror("bind"); return 1;
    }
    listen(listen_sock, 10);
    fcntl(listen_sock, F_SETFL, O_NONBLOCK);

    int epoll_fd = epoll_create1(0);
    struct epoll_event ev = { .events = EPOLLIN, .data.fd = listen_sock };
    epoll_ctl(epoll_fd, EPOLL_CTL_ADD, listen_sock, &ev);

    struct epoll_event events[32];
    static ClientState *states[65535];
    memset(states, 0, sizeof(states));

    printf("SUCCESS  LGX Dual-Registry Server V4a Online — port %d  BOOL tags: %d\n",
           config.server_port, bool_tag_count);

    while (1) {
        int nfds = epoll_wait(epoll_fd, events, 32, -1);
        for (int i = 0; i < nfds; i++) {
            int fd = events[i].data.fd;

            if (fd == listen_sock) {
                int conn = accept(listen_sock, NULL, NULL);
                if (conn < 0) continue;
                fcntl(conn, F_SETFL, O_NONBLOCK);
                ClientState *cs = calloc(1, sizeof(ClientState));
                cs->fd          = conn;
                states[conn]    = cs;
                ev.events       = EPOLLIN | EPOLLET;
                ev.data.fd      = conn;
                epoll_ctl(epoll_fd, EPOLL_CTL_ADD, conn, &ev);
                printf("INFO  main  client connected fd=%d\n", conn);
            } else {
                char    tmp[1024];
                ssize_t n = recv(fd, tmp, sizeof(tmp), 0);
                if (n <= 0) {
                    epoll_ctl(epoll_fd, EPOLL_CTL_DEL, fd, NULL);
                    close(fd);
                    free(states[fd]);
                    states[fd] = NULL;
                    printf("INFO  main  client disconnected fd=%d\n", fd);
                    continue;
                }

                ClientState *cs = states[fd];
                if (cs->buffer_pos + n < RECV_BUFFER_SIZE) {
                    memcpy(cs->recv_buffer + cs->buffer_pos, tmp, n);
                    cs->buffer_pos += n;

                    char *term;
                    while ((term = memchr(cs->recv_buffer, ';', cs->buffer_pos))) {
                        int consumed = (int)(term - cs->recv_buffer) + 1;
                        handle_request(fd, cs->recv_buffer, consumed);
                        memmove(cs->recv_buffer, term + 1,
                                cs->buffer_pos - consumed);
                        cs->buffer_pos -= consumed;
                    }
                } else {
                    printf("WARNING main  recv buffer overflow fd=%d — dropping\n", fd);
                    cs->buffer_pos = 0;
                }
            }
        }
    }
    return 0;
}
/*==============================================================================
 * END-OF-FILE: lgxSockSrv_rev4a.c
 *==============================================================================*/
