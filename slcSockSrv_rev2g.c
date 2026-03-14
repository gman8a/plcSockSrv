/*==============================================================================
 * BEGIN-OF-FILE: slcSockSrv_rev2_final.c
 *==============================================================================
 * File: slcSockSrv_rev2_final.c
 * Date: February 5, 2026
 * Authors: Gary Argraves, Claude
 * 
 * Purpose:
 *   Complete SLC Socket Server with ROK responses containing actual data.
 * 
 * Response Format:
 *   ROK:N12:50=123;\n                    (single value)
 *   ROK:N12:0=0,1,2,3,4,5,6,7,8,9;\n     (multiple values)
 *   WOK:wrote_N_elements;\n              (write success)
 *   RNG:error_description;\n             (read error)
 *   VERR:validation_error;\n             (validation error)
 *============================================================================*/
/*================================================================================
 * OMEGA SLC-500 SOCKET SERVER (REVISION 2.0)
 * Architecture: Hybrid Symmetric Surgical-Slab Mirror
 *================================================================================
 * * CORE OPERATIONAL PHILOSOPHY:
 * This driver is designed to bridge high-speed asynchronous network requests 
 * with the legacy synchronous constraints of the Allen-Bradley SLC 500. 
 * It prioritizes PLC CPU health by minimizing PCCC packet overhead and 
 * preventing backplane lockups caused by massive block transfers.
 *
 * 1. TRIPLE-SLAB ATOMIC MIRROR:
 * - The PLC data table (e.g., N12:0-255) is logically partitioned into three 
 * "Slabs" (S0: 0-99, S1: 100-199, S2: 200-255).
 * - These slabs act as the primary "Pipe" for block data, ensuring no single 
 * request exceeds the PCCC MTU (~240 bytes), preventing fragmentation.
 *
 * 2. SURGICAL JIT (JUST-IN-TIME) HANDLES:
 * - WRITES: All writes are "Surgical Strikes." A unique handle is created 
 * for the specific word being addressed. This uses a 2-byte PCCC payload, 
 * the smallest possible footprint, to prevent PLC scan-time spikes.
 * - READS: If a client requests a single word (count < 2), the driver uses 
 * the Surgical Handle. This allows for high-speed "truth" checking without 
 * the cost of a 100-word slab read.
 * - PERSISTENCE: Surgical handles are cached in the FileRegistry. If a word 
 * is written to, and later read from, the same handle is reused (Symmetry).
 *
 * 3. SMART DISPATCH LOGIC (THE "THRESHOLD OF PAIN"):
 * - R < 2: Surgical Read (Cached 1-word handle).
 * - R >= 2: Slab Refresh. Triggers a full 100-word read to sync the local 
 * RAM mirror. This allows "forced synchronization" of the mirror.
 * - RM (Read Mirror): Zero-PLC latency. Returns data immediately from the 
 * internal RAM buffer (the "Omega Mirror").
 *
 * 4. BOUNDARY CROSSER PROTECTION (SLAB STITCHING):
 * - Requests spanning slab boundaries (e.g., N12:90,20) are automatically 
 * serialized into multiple atomic slab reads. This maintains data integrity 
 * and keeps the PLC CPU from having to process "messy" fragmented requests.
 *
 * 5. TCP STREAM ROBUSTNESS:
 * - Implements a "Sliding Window" parser. Handles fragmented delivery and 
 * multi-message bursts in a single recv() by scanning for the ';' terminator 
 * and shifting the buffer using memmove().
 *
 * DESIGNER NOTE: 
 * "Fill" commands are deprecated to protect the backplane. The driver acts 
 * as the Omega Originator for the "Accumulated Detail Hop Journal."
 *================================================================================*/

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

#define PLC_TIMEOUT 5000

#define READ_RESP_LEN 2048
#define RECV_BUFFER_SIZE 512 
#define REQ_SIZE RECV_BUFFER_SIZE

#define MAX_REGISTRIES 16

typedef struct {
    char arrayName[16];
    int32_t tid_slabs[3];
    int16_t mirror[256];
    int32_t surgical_tids[256];
} FileRegistry;

static FileRegistry *registry_list[MAX_REGISTRIES] = {0};
static int registry_count = 0;

typedef struct {
    int fd;
    char recv_buffer[RECV_BUFFER_SIZE];
    int buffer_pos;
    time_t last_activity;
} ClientState;

typedef struct {
    char plc_ip[64], plc_path[32], plc_cpu[16];
    int server_port;
} config_t;

config_t config = { "192.168.40.124", "1,0", "slc", 9002 };

void send_response(int fd, const char *response) {
    int len = strlen(response);
    int sent = send(fd, response, len, MSG_NOSIGNAL);
    if (sent < 0) {
        fprintf(stderr, "WARNING: Send failed on fd %d: %s\n", fd, strerror(errno));
    }
}

FileRegistry* get_file_registry(const char *anchor) {
    for (int i = 0; i < registry_count; i++) {
        if (strcmp(registry_list[i]->arrayName, anchor) == 0) {
            return registry_list[i];
        }
    }
    
    if (registry_count >= MAX_REGISTRIES) return NULL;
    
    FileRegistry *new_fr = (FileRegistry *)calloc(1, sizeof(FileRegistry));
    if (!new_fr) return NULL;
    
    strncpy(new_fr->arrayName, anchor, sizeof(new_fr->arrayName) - 1);
    
    int sizes[3] = {100, 100, 56};
    int offsets[3] = {0, 100, 200};
    
    for (int i = 0; i < 3; i++) {
        char attrs[512];
        snprintf(attrs, sizeof(attrs), 
                 "protocol=ab-eip&gateway=%s&path=%s&cpu=%s&elem_size=2&elem_count=%d&name=%s:%d",
                 config.plc_ip, config.plc_path, config.plc_cpu, 
                 sizes[i], anchor, offsets[i]);
        
        new_fr->tid_slabs[i] = plc_tag_create(attrs, PLC_TIMEOUT);
        if (new_fr->tid_slabs[i] < 0) {
            free(new_fr);
            return NULL;
        }
        
        int timeout = 0;
        while (plc_tag_status(new_fr->tid_slabs[i]) == PLCTAG_STATUS_PENDING) {
            usleep(10000);
            if (++timeout > 500) {
                free(new_fr);
                return NULL;
            }
        }
    }
    
    registry_list[registry_count++] = new_fr;
    printf("SUCCESS: Registry for %s (TIDs: %d,%d,%d)\n", 
           anchor, new_fr->tid_slabs[0], new_fr->tid_slabs[1], new_fr->tid_slabs[2]);
    
    return new_fr;
}

int32_t get_surgical_handle(FileRegistry *fr, int arrayIndex) {
    if (arrayIndex < 0 || arrayIndex >= 256) return -1;
    
    if (fr->surgical_tids[arrayIndex] != 0) {
        return fr->surgical_tids[arrayIndex];
    }
    
    char attrs[256];
    snprintf(attrs, sizeof(attrs), 
             "protocol=ab-eip&gateway=%s&path=%s&cpu=%s&elem_size=2&elem_count=1&name=%s:%d",
             config.plc_ip, config.plc_path, config.plc_cpu, 
             fr->arrayName, arrayIndex);
    
    int32_t new_tid = plc_tag_create(attrs, PLC_TIMEOUT);
    if (new_tid < 0) return -1;
    
    int timeout = 0;
    while (plc_tag_status(new_tid) == PLCTAG_STATUS_PENDING) {
        usleep(10000);
        if (++timeout > 500) return -1;
    }
    
    fr->surgical_tids[arrayIndex] = new_tid;
    printf("INFO: Surgical handle for %s:%d (TID %d)\n", 
           fr->arrayName, arrayIndex, new_tid);
    
    return new_tid;
}

void handle_write_path(int fd, FileRegistry *fr, char *payload) {
    printf("INFO: Write - %s, payload=%s\n", fr->arrayName, payload);
    
    char *token = strtok(payload, ",");
    if (!token) {
        send_response(fd, "VERR:missing_index;\n");
        return;
    }
    
    int current_idx = atoi(token);
    int write_ok = 0, write_fail = 0;
    
    while ((token = strtok(NULL, ",")) != NULL && current_idx < 256) {
        int16_t val = (int16_t)atoi(token);
        
        int32_t tid = get_surgical_handle(fr, current_idx);
        if (tid < 0) {
            write_fail++;
            current_idx++;
            continue;
        }
        
        if (plc_tag_set_int16(tid, 0, val) == PLCTAG_STATUS_OK) {
			if (plc_tag_write(tid, PLC_TIMEOUT) == PLCTAG_STATUS_OK) {

				// SUCCESS: The PLC acknowledged the command.
				// DO NOT update fr->mirror[target_idx] here.
				// False positive risk: Mirror must only be updated by a subsequent R command
				// to confirm the write actually took effect in the PLC memory.
				// fr->mirror[current_idx] = val;

				write_ok++;
				printf("SUCCESS: %s:%d = %d\n", fr->arrayName, current_idx, val);
			} 
		}
		else {
            write_fail++;
        }

        current_idx++;
    }
    
    char response[256];
    if (write_fail == 0) {
        snprintf(response, sizeof(response), "WOK:wrote_%d_elements;\n", write_ok);
    } else {
        snprintf(response, sizeof(response), "WNG:wrote_%d_failed_%d;\n", 
                 write_ok, write_fail);
    }
    send_response(fd, response);
}

void handle_read_path(int fd, FileRegistry *fr, char *payload) {
    int start_idx = 0, count = 1;
    
    char *token = strtok(payload, ",");
    if (token) start_idx = atoi(token);
    
    token = strtok(NULL, ",");
    if (token) count = atoi(token);
    
    printf("INFO: Read - %s:%d, count=%d\n", fr->arrayName, start_idx, count);
    
    if (start_idx < 0 || start_idx >= 256) {
        send_response(fd, "VERR:index_out_of_range;\n");
        return;
    }
    
    if (count < 1) count = 1;
    
    int end_idx = start_idx + count - 1;
    if (end_idx >= 256) {
        end_idx = 255;
        count = end_idx - start_idx + 1;
    }
    
    bool read_ok = false;
    
    // CASE 1: SURGICAL (single element)
    if (count == 1) {
        int32_t tid = get_surgical_handle(fr, start_idx);
        if (tid < 0) {
            send_response(fd, "RNG:surgical_handle_failed;\n");
            return;
        }
        
        if (plc_tag_read(tid, PLC_TIMEOUT) == PLCTAG_STATUS_OK) {
            fr->mirror[start_idx] = plc_tag_get_int16(tid, 0);
            read_ok = true;
        } else {
            send_response(fd, "RNG:plc_read_failed;\n");
            return;
        }
    }
    
    // CASE 2: BOUNDARY CROSSING
    else if ((start_idx <= 99 && end_idx > 99) || 
             (start_idx <= 199 && end_idx > 199)) {
        
        bool error = false;
        
        if (start_idx <= 99) {
            if (plc_tag_read(fr->tid_slabs[0], PLC_TIMEOUT) == PLCTAG_STATUS_OK) {
                for (int i = 0; i < 100; i++) {
                    fr->mirror[i] = plc_tag_get_int16(fr->tid_slabs[0], i * 2);
                }
            } else error = true;
        }
        
        if (start_idx <= 199 && end_idx >= 100) {
            if (plc_tag_read(fr->tid_slabs[1], PLC_TIMEOUT) == PLCTAG_STATUS_OK) {
                for (int i = 0; i < 100; i++) {
                    fr->mirror[100 + i] = plc_tag_get_int16(fr->tid_slabs[1], i * 2);
                }
            } else error = true;
        }
        
        if (end_idx >= 200) {
            if (plc_tag_read(fr->tid_slabs[2], PLC_TIMEOUT) == PLCTAG_STATUS_OK) {
                for (int i = 0; i < 56; i++) {
                    fr->mirror[200 + i] = plc_tag_get_int16(fr->tid_slabs[2], i * 2);
                }
            } else error = true;
        }
        
        if (error) {
            send_response(fd, "RNG:multi_slab_read_failed;\n");
            return;
        }
        
        read_ok = true;
    }
    
    // CASE 3: SINGLE SLAB
    else {
        int slab_id = (start_idx < 100) ? 0 : (start_idx < 200 ? 1 : 2);
        
        if (plc_tag_read(fr->tid_slabs[slab_id], PLC_TIMEOUT) == PLCTAG_STATUS_OK) {
            int base = slab_id * 100;
            int limit = (slab_id == 2) ? 56 : 100;
            
            for (int i = 0; i < limit; i++) {
                fr->mirror[base + i] = plc_tag_get_int16(fr->tid_slabs[slab_id], i * 2);
            }
            
            read_ok = true;
        } else {
            send_response(fd, "RNG:slab_read_failed;\n");
            return;
        }
    }
    
    // BUILD ROK RESPONSE WITH ACTUAL DATA VALUES
    if (read_ok) {
        char *resp = malloc(READ_RESP_LEN);
        if (!resp) {
            send_response(fd, "RNG:memory_allocation_failed;\n");
            return;
        }
        
        // Format: ROK:N12:50=123 or ROK:N12:0=0,1,2,3,4,5
        int resp_len = snprintf(resp, READ_RESP_LEN, "ROK:%s:%d=", fr->arrayName, start_idx);
        
        for (int i = 0; i < count; i++) {
            if (start_idx + i >= 256) break;
            
            resp_len += snprintf(resp + resp_len, READ_RESP_LEN - resp_len, "%d%s", 
                                (int)fr->mirror[start_idx + i], 
                                (i < count - 1) ? "," : ";\n");
        }
        
        send_response(fd, resp);
        free(resp);
        
        printf("SUCCESS: Sent ROK with %d values\n", count);
    }
}

void handle_mirror_read(FileRegistry *fr, int fd, char *payload) {
    int start_idx = 0, count = 1;
    char *token = strtok(payload, ",");
    if (token) start_idx = atoi(token);
    token = strtok(NULL, ",");
    if (token) count = atoi(token);

    // Limit count to avoid buffer overruns on the local socket response
    if (count > 256) count = 256;
    
    printf("INFO: Read Mirror - %s:%d, count=%d\n", fr->arrayName, start_idx, count);

    char response[READ_RESP_LEN];
    int pos = sprintf(response, "RMOK:%s:%d=", fr->arrayName, start_idx);

    // Stream the data directly from the Omega RAM Mirror
    for (int i = 0; i < count && (start_idx + i) < 256; i++) {
		if (!i)
        	 pos += sprintf(response + pos, "%d", fr->mirror[start_idx + i]);
        else pos += sprintf(response + pos, ",%d", fr->mirror[start_idx + i]);
    }
    
    strcat(response, ";\n");
    send_response(fd, response);
}

void handle_request(int fd, const char *request, int msg_len) {
    char buf[REQ_SIZE];
    strncpy(buf, request, msg_len);
    buf[msg_len] = '\0';
    printf("INFO: Raw Message: >%s<\n", buf);
    
	//--- clean tail
    int len = strlen(buf);
    while (len > 0 && (buf[len-1] < 33 || buf[len-1] == ';')) buf[--len] = '\0';

	//--- clean head    
    char *p = buf;
    while (*p && *p < 33) p++;

	//=== test got nothing
    if (*p == '\0') return;
   
	// 1. Parsing with the colon-consistent protocol 
    char command[8] = {0}, arrayName[16] = {0}, payload[REQ_SIZE] = {0};
   
	//-- fast-lean-no_frills cmd parsing; *** Client to take-care ***
    if (sscanf(p, "%7[^,],%15[^:]:%1023s", command, arrayName, payload) < 3) {
        send_response(fd, "VERR:malformed_request;\n"); // Validation Error
        return;
    }
   
	// After parsing arrayName; Capitalize ; n12:71 --> N12:71
    for(int i = 0; arrayName[i]; i++) arrayName[i] = toupper(arrayName[i]); 

    printf("INFO: cmd=%s, anchor=%s, payload=%s\n", command, arrayName, payload);
    
    FileRegistry *fr = get_file_registry(arrayName);
    if (!fr) {
        send_response(fd, "CERR:registry_failed;\n");
        return;
    }

    // 2. The Triad Dispatch
    if (command[0] == 'W') {
        handle_write_path(fd, fr, payload);
	} else if (strcmp(command, "RM") == 0) {
    	handle_mirror_read(fr, fd, payload);
    } else if (command[0] == 'R') {
        handle_read_path(fd, fr, payload);
    } else {
        send_response(fd, "VERR:unknown_command;\n");
    }
}

#define MAX_EVENTS 32  // aka MAX_CLIENTS
#define BUF_SIZE 1024

int set_nonblocking(int fd) {
    int flags = fcntl(fd, F_GETFL, 0);
    return fcntl(fd, F_SETFL, flags | O_NONBLOCK);
}

int main() {
    int listen_sock, epoll_fd;
    struct epoll_event ev, events[MAX_EVENTS];

    // Map FDs to ClientStates (In a real app, use a hash map or array indexed by FD)
    ClientState *states[65535] = {0}; 

    listen_sock = socket(AF_INET, SOCK_STREAM, 0);

	int opt = 1;
	setsockopt(listen_sock, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    set_nonblocking(listen_sock);

    struct sockaddr_in addr = { .sin_family = AF_INET, .sin_port = htons( config.server_port), .sin_addr.s_addr = INADDR_ANY };
    bind(listen_sock, (struct sockaddr *)&addr, sizeof(addr));
    listen(listen_sock, SOMAXCONN);

    epoll_fd = epoll_create1(0);
    ev.events = EPOLLIN; 
    ev.data.fd = listen_sock;
    epoll_ctl(epoll_fd, EPOLL_CTL_ADD, listen_sock, &ev);

    printf("==================================================\n");
    printf("SLC Socket Server rev2f (using epoll)- Port %d\n", config.server_port);
    printf("PLC: ip= %s path= %s cpu= %s\n", config.plc_ip, config.plc_path, config.plc_cpu);
    printf("Surgical Write Architecture\n");
    printf("==================================================\n\n");

    while (1) {
        int nfds = epoll_wait(epoll_fd, events, MAX_EVENTS, -1);

        for (int i = 0; i < nfds; i++) {
            int fd = events[i].data.fd;

            if (fd == listen_sock) {
                // --- ACCEPT NEW CLIENTS ---
                while (1) { // Accept all pending connections
                    struct sockaddr_in client_addr;
                    socklen_t addrlen = sizeof(client_addr);
                    int conn_sock = accept(listen_sock, (struct sockaddr *)&client_addr, &addrlen);
                    if (conn_sock == -1) break; 

                    set_nonblocking(conn_sock);
                    
                    // Initialize the structure for AL handling
                    ClientState *cs = calloc(1, sizeof(ClientState));
                    cs->fd = conn_sock;
                    states[conn_sock] = cs;

                    ev.events = EPOLLIN | EPOLLET; // Edge-Triggered
                    ev.data.fd = conn_sock;
                    epoll_ctl(epoll_fd, EPOLL_CTL_ADD, conn_sock, &ev);
                }
            } else {
                // --- HANDLE DATA (EDGE TRIGGERED) ---
                ClientState *cs = states[fd];
                char temp[BUF_SIZE];
                int done = 0;

                while (1) { // MUST read until EAGAIN in ET mode
                    ssize_t count = recv(fd, temp, sizeof(temp), 0);
                    
                    if (count > 0) {
                        // Append to our Residual buffer
                        if (cs->buffer_pos + count < BUF_SIZE) {
                            memcpy(cs->recv_buffer + cs->buffer_pos, temp, count);
                            cs->buffer_pos += count;
                            
                            // Process your "Surgical" protocol (look for ;)
                            char *term;
                            while ((term = memchr(cs->recv_buffer, ';', cs->buffer_pos))) {
                                int msg_len = (term - cs->recv_buffer) + 1;
                                
                                handle_request(fd, cs->recv_buffer, msg_len);

                                // Slide Window
                                memmove(cs->recv_buffer, term + 1, cs->buffer_pos - msg_len);
                                cs->buffer_pos -= msg_len;
                            }
                        }
                    } else if (count == 0) {
                        done = 1; break; // Peer closed
                    } else {
                        if (errno != EAGAIN) done = 1; // Real error
                        break; // Data drained (EAGAIN)
                    }
                }

                if (done) {
                    printf("Closing fd %d\n", fd);
                    close(fd);
                    free(states[fd]);
                    states[fd] = NULL;
                }
            }
        }
    }
}

/*==============================================================================
 * END-OF-FILE: slcSockSrv_rev2_final.c
 *============================================================================*/
