/*==============================================================================
 * BEGIN-OF-FILE: plc_lib_chook.js
 *==============================================================================
 * File: plc_lib_chook.js
 * Date: February 5, 2026
 * Authors: Gary Argraves, Claude
 * 
 * Purpose:
 *   Node.js driver for SLC Socket Server v19 with proper TCP stream buffering,
 *   consistent colon delimiter protocol, and event-driven architecture.
 * 
 * Protocol (v2.0):
 *   Request:  <CMD>,<params>;\n
 *   Response: <STATUS>:<payload>;\n
 *   
 *   All responses use COLON delimiter (consistent)
 *   All messages terminate with ;\n
 * 
 * Usage:
 *   const PLCDriver = require('./plc_lib_chook');
 *   
 *   const plc = new PLCDriver({
 *       host: '127.0.0.1',
 *       port: 9002,
 *       logFn: console.log,
 *       onConnFn: () => console.log('Connected'),
 *       onDisConnFn: () => console.log('Disconnected')
 *   });
 *   
 *   plc.on('rok', (payload) => console.log('Read OK:', payload));
 *   plc.on('rmok', (payload) => console.log('Mirror Read OK:', payload));
 *   
 *   plc.connect();
 *   plc.read('N12:27');
 *   plc.read('N12:0', 10);
 *   plc.write('N12:99', 1);
 * 
 * Features:
 *   - Proper TCP stream buffering (handles fragmentation)
 *   - Consistent colon delimiter parsing
 *   - Event-driven architecture (EventEmitter)
 *   - Automatic reconnection on disconnect
 *   - All status codes supported (ROK, RMOK, WOK, errors)
 *   - Mirror read support (RM command)
 *============================================================================*/

const net = require('net');
const EventEmitter = require('events');

//==============================================================================
// PLC DRIVER CLASS
//==============================================================================

class PLCDriver extends EventEmitter {
    constructor(config = {}) {
        super();
        
        // Configuration
        this.host = config.host || '127.0.0.1';
        this.port = config.port || 9002;
        this.logFn = config.logFn || console.log;
        this.onConnFn = config.onConnFn || null;
        this.onDisConnFn = config.onDisConnFn || null;
        this.reconnectDelay = config.reconnectDelay || 5000;
        this.autoReconnect = config.autoReconnect !== false;
        
        // Connection state
        this.client = null;
        this.isConnected = false;
        this.reconnectTimer = null;
        
        // TCP stream buffer for incomplete messages
        this.receiveBuffer = '';
        
        // Request queue (optional - for future expansion)
        this.requestQueue = [];
        this.processingRequest = false;
    }
    
    //==========================================================================
    // CONNECTION MANAGEMENT
    //==========================================================================
    
    /**
     * Connect to PLC socket server
     */
    connect() {
        if (this.client) {
            this.logFn('[PLC_CHOOK] WARNING: Already connected or connecting');
            return;
        }
        
        this.logFn(`[PLC_CHOOK] INFO: Connecting to ${this.host}:${this.port}`);
        
        this.client = new net.Socket();
        
        // Connection established
        this.client.on('connect', () => {
            this.isConnected = true;
            this.receiveBuffer = '';  // Clear buffer on new connection
            this.logFn('[PLC_CHOOK] SUCCESS: Connected to PLC server');
            
            if (this.onConnFn) {
                this.onConnFn();
            }
            
            this.emit('connected');
        });
        
        // Data received
        this.client.on('data', (data) => {
            this.handleIncomingData(data);
        });
        
        // Connection closed
        this.client.on('close', () => {
            this.isConnected = false;
            this.logFn('[PLC_CHOOK] WARNING: Connection closed');
            
            if (this.onDisConnFn) {
                this.onDisConnFn();
            }
            
            this.emit('disconnected');
            
            this.client = null;
            
            // Auto-reconnect
            if (this.autoReconnect) {
                this.scheduleReconnect();
            }
        });
        
        // Connection error
        this.client.on('error', (err) => {
            this.logFn(`[PLC_CHOOK] ERROR: Connection error - ${err.message}`);
            this.emit('connection_error', err);
        });
        
        // Attempt connection
        this.client.connect(this.port, this.host);
    }

    /**
     * Total Shutdown - Prevents auto-reconnect
     */
    shutdown() {
        this.logFn("INFO: Shutting down PLC driver...");
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }

        if (this.client) {
            /**
             * SHUTDOWN PATTERN: Same as connect() socket replacement
             * removeAllListeners() prevents 'close' event from triggering
             * reconnect logic during intentional shutdown.
             */
            this.client.removeAllListeners();
            this.client.destroy();
            this.client = null;
        }

        this.isConnected = false;
        this.onDisConnFn();
        this.logFn("SUCCESS: PLC driver shutdown complete");
    }
    
    /**
     * Disconnect from PLC server
     */
    disconnect() {
        this.autoReconnect = false;  // Disable auto-reconnect
        
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        
        if (this.client) {
            this.client.destroy();
            this.client = null;
        }
        
        this.isConnected = false;
        this.logFn('[PLC_CHOOK] INFO: Disconnected');
    }
    
    /**
     * Schedule reconnection attempt
     */
    scheduleReconnect() {
        if (this.reconnectTimer) {
            return;  // Already scheduled
        }
        
        this.logFn(`[PLC_CHOOK] INFO: Reconnecting in ${this.reconnectDelay}ms`);
        
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, this.reconnectDelay);
    }
    
    //==========================================================================
    // TCP STREAM HANDLING - PROPER BUFFERING
    //==========================================================================
    
    /**
     * Handle incoming TCP data with proper buffering until ;\n terminator
     * @param {Buffer} data - Incoming TCP data
     */
    handleIncomingData(data) {
        // Append to receive buffer
        this.receiveBuffer += data.toString();
        
        // Process all complete messages (terminated with ;\n)
        let terminatorIndex;
        while ((terminatorIndex = this.receiveBuffer.indexOf(';\n')) !== -1) {
            // Extract complete message (without ;\n)
            const msg = this.receiveBuffer.substring(0, terminatorIndex).trim();
            
            // Remove processed message from buffer (including ;\n)
            this.receiveBuffer = this.receiveBuffer.substring(terminatorIndex + 2);
            
            // Skip empty messages
            if (!msg) continue;
            
            // Parse and route message
            this.parseMessage(msg);
        }
        
        // Buffer overflow protection
        if (this.receiveBuffer.length > 10000) {
            this.logFn('[PLC_CHOOK] ERROR: Receive buffer overflow - clearing');
            this.logFn(`[PLC_CHOOK] Buffer sample: ${this.receiveBuffer.substring(0, 200)}...`);
            this.receiveBuffer = '';
            this.emit('plc_comm_error', { 
                msg: 'Receive buffer overflow', 
                spec: 'buffer_overflow' 
            });
        }
    }
    
    //==========================================================================
    // MESSAGE PARSING - CONSISTENT COLON DELIMITER
    //==========================================================================
    
    /**
     * Parse complete message with consistent colon delimiter
     * @param {String} msg - Complete message (without ;\n)
     */
    parseMessage(msg) {
        // All messages use colon delimiter: STATUS:payload
        const colonIndex = msg.indexOf(':');
        
        if (colonIndex === -1) {
            this.logFn(`[PLC_CHOOK] ERROR: No colon delimiter in message: ${msg}`);
            this.emit('plc_unknown', { raw: msg, status: null, payload: null });
            return;
        }
        
        const status = msg.substring(0, colonIndex);	//ex. WOK  or WNG  or ROK or RNG
        const payload = msg.substring(colonIndex + 1);	//ex. N12:0=0,1,2,3 
        
        // Validate status code (2-4 characters)
        if (!status || status.length < 2 || status.length > 4) {
            this.logFn(`[PLC_CHOOK] ERROR: Invalid status '${status}' in message: ${msg}`);
            this.emit('plc_unknown', { raw: msg, status, payload });
            return;
        }
        
        // Route to appropriate handler
        this.routeMessage(status, payload, msg);
    }
    
    /**
     * Route parsed message to appropriate event handler
     * @param {String} status - Status code (ROK, CERR, etc.)
     * @param {String} payload - Message payload after colon
     * @param {String} rawMsg - Original complete message
     */
    routeMessage(status, payload, rawMsg) {
        switch (status) {
            // ===== SUCCESS CODES =====
            
            case 'ROK': {
                // Read OK: ROK:N12:27=123
                const parsed = this.parseReadResponse(rawMsg);
                if (parsed) {
                    this.emit('rok', parsed);
                } else {
                    this.logFn(`[PLC_CHOOK] ERROR: Failed to parse ROK response: ${rawMsg}`);
                }
                break;
            }
            
            case 'RMOK': {
                // Mirror Read OK: RMOK:N12:0=0,1,2,3
                const parsed = this.parseReadResponse(rawMsg);
                if (parsed) {
                    this.emit('rmok', parsed);
                } else {
                    this.logFn(`[PLC_CHOOK] ERROR: Failed to parse RMOK response: ${rawMsg}`);
                }
                break;
            }
            
            case 'WOK': {
                // Write OK: WOK:noerr
                this.emit('wok', { spec: payload });
                break;
            }
            
            // ===== ERROR CODES (now use colon) =====
            
            case 'CERR': {
                // Communication Error: CERR:timeout
                this.logFn(`[PLC_CHOOK] ERROR: Communication error - ${payload}`);
                this.emit('plc_comm_error', { msg: payload, spec: payload });
                break;
            }
            
            case 'DERR': {
                // Data Error: DERR:bad_value
                this.logFn(`[PLC_CHOOK] ERROR: Data error - ${payload}`);
                this.emit('plc_data_error', { msg: payload, spec: payload });
                break;
            }
            
            case 'VERR': {
                // Validation Error: VERR:invalid_format
                this.logFn(`[PLC_CHOOK] ERROR: Validation error - ${payload}`);
                this.emit('plc_validation_error', { msg: payload, spec: payload });
                break;
            }
            
            case 'WARN': {
                // Warning: WARN:slow_response
                this.logFn(`[PLC_CHOOK] WARNING: ${payload}`);
                this.emit('plc_warning', { msg: payload });
                break;
            }
            
            case 'RNG': {
                // Read Not Good: RNG:plc_read_timeout
                this.logFn(`[PLC_CHOOK] ERROR: Read failed - ${payload}`);
                this.emit('plc_comm_error', { 
                    msg: `Read failed: ${payload}`, 
                    spec: payload 
                });
                break;
            }
            
            case 'WNG': {
                // Write Not Good: WNG:plc_write_failed
                this.logFn(`[PLC_CHOOK] ERROR: Write failed - ${payload}`);
                this.emit('plc_comm_error', { 
                    msg: `Write failed: ${payload}`, 
                    spec: payload 
                });
                break;
            }
            
            case 'RMNG': {
                // Read Mirror Not Good: RMNG:mirror_error
                this.logFn(`[PLC_CHOOK] ERROR: Mirror read failed - ${payload}`);
                this.emit('plc_comm_error', { 
                    msg: `Mirror read failed: ${payload}`, 
                    spec: payload 
                });
                break;
            }
            
            // ===== UNKNOWN STATUS =====
            
            default: {
                this.logFn(`[PLC_CHOOK] WARNING: Unknown status '${status}' in message: ${rawMsg}`);
                this.emit('plc_unknown', { 
                    raw: rawMsg, 
                    status,
                    payload 
                });
            }
        }
    }
    
    /**
     * Parse read response (ROK/RMOK)
     * Format: ROK:N12:27=123  or  RMOK:N12:0=0,1,2,3
     * @param {String} msg - Complete message
     * @returns {Object|null} - {tag, values, single}
     */
    parseReadResponse(msg) {
        try {
            // Format: ROK:N12:27=123  or  RMOK:N12:0=0,1,2,3
			// Format: ROK:PCDATA[1]=32    ROK:HANDLE=12
            const parts = msg.split(':');
            if (parts.length < 2) return null;

            const eqIndex = parts[1].indexOf('=');
            if (eqIndex === -1) return null;

            const status = parts[0];  // ROK or RMOK
			const [tag, valuesStr] = parts[1].split('=');
            
            const values = valuesStr.split(',').map(v => parseInt(v.trim(), 10));
            const single = (values.length === 1) ? values[0] : null;
            
            return { tag, values, single };
            
        } catch (e) {
            this.logFn(`[PLC_CHOOK] ERROR: Parse error - ${e.message}`);
            return null;
        }
    }
    
    //==========================================================================
    // PLC COMMANDS - PUBLIC API
    //==========================================================================
    
    /**
     * Send raw command to PLC server
     * @param {String} command - Raw command string (without terminator)
     */
    send(command) {
        if (!this.isConnected || !this.client) {
            this.logFn('[PLC_CHOOK] ERROR: Not connected - cannot send command');
            return false;
        }
        
        // Ensure command ends with ;\n
        let cmd = command.trim();
        if (!cmd.endsWith(';\n')) {
            if (!cmd.endsWith(';')) {
                cmd += ';';
            }
            cmd += '\n';
        }
        
        try {
            this.client.write(cmd);
            return true;
        } catch (e) {
            this.logFn(`[PLC_CHOOK] ERROR: Send failed - ${e.message}`);
            return false;
        }
    }
    
    /**
     * Read tag value(s) from PLC
     * @param {String} tag - Tag name (e.g., "N12:27")
     * @param {Number} count - Number of elements to read (default: 1)
     */
    read(tag, count = 1) {
        const cmd = (count === 1) 
            ? `R,${tag};\n`
            : `R,${tag},${count};\n`;
        
        return this.send(cmd);
    }
    
    /**
     * Read tag value(s) from RAM mirror (fast)
     * @param {String} tag - Tag name (e.g., "N12:0")
     * @param {Number} count - Number of elements to read (default: 1)
     */
    readMirror(tag, count = 1) {
        const cmd = (count === 1)
            ? `RM,${tag};\n`
            : `RM,${tag},${count};\n`;
        
        return this.send(cmd);
    }
    
    /**
     * Write value(s) to PLC tag
     * @param {String} tag - Tag name (e.g., "N12:99")
     * @param {Number|Array} values - Single value or array of values
     */
    write(tag, values) {
        const valArray = Array.isArray(values) ? values : [values];
        const valStr = valArray.join(',');
        const cmd = `W,${tag},${valStr};\n`;
        
        return this.send(cmd);
    }
}

//==============================================================================
// MODULE EXPORTS
//==============================================================================

module.exports = PLCDriver;

/*==============================================================================
 * USAGE EXAMPLES
 *============================================================================*/

/*
// Example 1: Basic usage
const PLCDriver = require('./plc_lib_chook');

const plc = new PLCDriver({
    host: '127.0.0.1',
    port: 9002,
    logFn: console.log,
    onConnFn: () => {
        console.log('Connected to PLC server');
        
        // Test read
        plc.read('N12:27');
        
        // Test mirror read (fast)
        plc.readMirror('N12:0', 10);
    },
    onDisConnFn: () => {
        console.log('Disconnected from PLC server');
    }
});

// Set up event handlers
plc.on('rok', (payload) => {
    console.log('Read OK:', payload);
    // {tag: 'N12:27', values: [123], single: 123}
});

plc.on('rmok', (payload) => {
    console.log('Mirror Read OK:', payload);
    // {tag: 'N12:0', values: [0,1,2,3,4,5,6,7,8,9], single: null}
});

plc.on('wok', (payload) => {
    console.log('Write OK:', payload);
});

plc.on('plc_comm_error', (error) => {
    console.error('PLC Error:', error.msg);
});

// Connect
plc.connect();

// Later: write a value
setTimeout(() => {
    plc.write('N12:99', 1);
}, 2000);

// Example 2: Polling loop
setInterval(() => {
    if (plc.isConnected) {
        plc.readMirror('N12:0', 101);  // Read N12:0 through N12:100
    }
}, 1000);

// Example 3: Write multiple values
plc.write('N12:50', [10, 20, 30, 40, 50]);

// Example 5: Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down...');
    plc.disconnect();
    process.exit(0);
});
*/

/*==============================================================================
 * END-OF-FILE: plc_lib_chook.js
 *============================================================================*/
