/*==============================================================================
 * BEGIN-OF-FILE: grafSrv.js
 *==============================================================================
 * File: grafSrv.js
 * Date: February 5, 2026
 * Authors: Gary Argraves (concept: Marty Carangelo), Claude
 * Company: Your company name here 
 * 
 * Purpose:
 *   Main graphics server for warehouse automation HMI. Serves multiple
 *   web browser clients via WebSockets, manages PLC communication, and
 *   processes style/text application rules for real-time display updates.
 * 
 * Usage:
 *   node grafSrv.js
 *   
 * Architecture:
 *   - Port 2500: WAN HMI web clients (Socket.IO)
 *   - Port 2503: LAN lowFreqScan IPC clients (Socket.IO)
 *   - PLC connection via plc_lib_chook driver
 *   - MySQL for persistent data queries
 * 
 * Features:
 *   - Multi-client HMI web serving with real-time updates
 *   - C-like and legacy cryptic text/style application syntax
 *   - Macro system for reusable display patterns
 *   - PLC read/write request handling
 *   - Database query/command processing
 *   - SIGUSR2 signal handling for client reload
 *   - CORS support for cross-origin requests
 * 
 * Apply Syntax (C-like):
 *   if($v){ $T>.LABEL=visible; $T>.OBJECT=visible; }
 *   if(!$v){ $t>.ALERT=invisible; }
 *   
 *   Variables: $v=value, $V=VALUE, $T=TAGNAME, $t=tagname, $B=BLANK
 *   Operators: >.  (target selector), = (assignment), / (delimiter)
 *   
 * Apply Syntax (Legacy cryptic):
 *   1::*TAGNAME*::JAM:::0::*TAGNAME*::CLEAR
 *   
 * Signal Handling:
 *   kill -SIGUSR2 <pid>  - Triggers HMI client reload
 *   See: ~/wic/ccs/reload_html_client
 *============================================================================*/

const moduleName = 'grafSrv';

//==============================================================================
// LOGGING SYSTEM INITIALIZATION
//==============================================================================

const wic_lib_path = './libs';
const log_lib = require(`${wic_lib_path}/log_lib.js`);

log_lib.set_moduleName(moduleName);

const logMessage = (str, plogServer) => log_lib.log_write_frontend(str, plogServer);
const consoleMessage = (str) => log_lib.log_write_console(str);

logMessage("SUCCESS: Graphics server initialization started");

//==============================================================================
// SQL CONNECTION INITIALIZATION
//==============================================================================

const sql_lib = require(`${wic_lib_path}/sql_lib.js`);
sql_lib.set_logMessage_fn(logMessage);

const mysql_conn = sql_lib.get_mysql_connection();

/**
 * Execute SQL SELECT query with callback
 * @param {Object|String} data - Query object or string
 * @param {Function} callback - Callback(err, results, fields)
 */
function sql_select(data, callback) {
    const q = (typeof data.query !== 'undefined') ? data.query : data;
    mysql_conn.query(q, function(err, results, fields) {
        if (err) {
            logMessage(`ERROR: SQL query failed - ${err.message}\nStack: ${err.stack}`);
            throw err;
        }
        callback(err, results, fields);
    });
}

// Keep SQL connection alive
setInterval(() => {
    sql_lib.sql_query('SELECT 1');
}, 10000);

//==============================================================================
// PLC DRIVER INITIALIZATION (NEW CONNECTION METHOD)
//==============================================================================

const PLCDriver = require('./plc_lib_chook');

const plc = new PLCDriver({
    host: '127.0.0.1',
    port: 9002,
    logFn: logMessage,
    onConnFn: () => {
        logMessage("SUCCESS: PLC connected to graphics server");
    },
    onDisConnFn: () => {
        logMessage("WARNING: PLC disconnected from graphics server");
    }
});

// PLC Event Handlers
plc.on('rok', (payload) => {
    if (payload.single !== null) {
        logMessage(`INFO: PLC read response - ${payload.tag} = ${payload.single}`);
    } else {
        // Array response - pass to HMI handler
        hmi_plc.plc_handler(payload);
    }
});

plc.on('rmok', (payload) => {
	//console.log(payload);
	//{ tag: 'N12:27', values: [ 0 ], single: 0, raw: 'RMOK:N12:27=0' }

    if (payload.single !== null) {
        logMessage(`INFO: PLC mirror read response - ${payload.tag} = ${payload.single}`);
    } else {
        hmi_plc.plc_handler(payload);
    }
});

plc.on('wok', (payload) => {
    console.log(`SUCCESS: PLC write completed - ${payload.spec}`);
});

plc.on('fok', (payload) => {
    console.log(`SUCCESS: PLC fill completed - ${payload.spec}`);
});

plc.on('plc_comm_error', (error) => {
    console.error(`ERROR: PLC communication failed - ${error.msg}`);
    console.error(`  Spec: ${error.spec}`);
});

plc.on('plc_validation_error', (error) => {
    console.error(`ERROR: PLC validation failed - ${error.msg}`);
    console.error(`  Spec: ${error.spec}`);
});

plc.on('plc_data_error', (error) => {
    console.error(`ERROR: PLC data error - ${error.msg}`);
    console.error(`  Bad spec: ${error.spec}`);
});

plc.on('plc_warning', (warning) => {
    console.warn(`WARNING: ${warning.msg}`);
});

plc.on('plc_unknown', (data) => {
    console.warn(`WARNING: Unknown PLC response - ${data.raw}`);
});

// Connect to PLC
plc.connect();

//==============================================================================
// UTILITY FUNCTIONS
//==============================================================================

RegExp.quote = function(str) {
    return (str + '').replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
};

//==============================================================================
// LOW FREQUENCY SCANNER SERVER (PORT 2503)
//==============================================================================

const lowFreqServer = require('http').createServer();
const lowFreq_server = require('socket.io')(lowFreqServer);

lowFreq_server.listen(2503);
logMessage("SUCCESS: LowFreq scanner server listening on port 2503");

lowFreq_server.sockets.on('connection', function(socket) {
    logMessage("INFO: LowFreqScan socket connected");
    
    socket.on('error', function() {
        console.log("%j", arguments);
    });
    
    socket.on('disconnect', () => {
        socket.destroy;
        logMessage('INFO: LowFreqScan client socket disconnected');
    });
    
    // Tag change from lowFreqScan
    socket.on('tagChange', (action) => {
        do_text_and_style_apply(action);
    });
    
    // Request initial update
    socket.emit('needFirstUpdate'); // tells lowFreqScan to send update
    
    socket.on('needFirstUpdate', (actions) => {
        logMessage("INFO: Received initial update from lowFreqScan");
        for (let j = 0; j < actions.length; j++) {
            do_text_and_style_apply(actions[j], true);
        }
    });
});

//==============================================================================
// GRAPHICS SERVER - HMI WEB CLIENTS (PORT 2500)
//==============================================================================

const cors = require('cors');
const httpServer = require("http").createServer();
const io = require('socket.io')(httpServer, {
    cors: {
        origins: ["10.13.80.10"],
        handlePreflightRequest: (req, res) => {
            res.writeHead(200, {
                "Access-Control-Allow-Origin": "10.13.80.10",
                "Access-Control-Allow-Methods": "GET,POST",
                "Access-Control-Allow-Headers": "my-custom-header",
                "Access-Control-Allow-Credentials": true
            });
            res.end();
        }
    }
});

io.listen(2500);
logMessage("SUCCESS: Graphics server listening on port 2500");

io.sockets.on('connection', function(socket) {
    const remoteIP = socket.request.connection.remoteAddress;
    logMessage(`INFO: HMI web client connected - IP: ${remoteIP}, Socket: ${socket.id}`);
    
    socket.emit('welcome', { message: 'hi' });
    
    socket.on('sayhi', console.log);
    
    socket.on('error', function() {
        console.log("%j", arguments);
    });
    
    socket.on('disconnect', function() {
        logMessage(`INFO: HMI web client disconnected - IP: ${remoteIP}, Socket: ${socket.id}`);
        socket.destroy;
    });
    
    // Database SELECT queries
    socket.on('requestDB', function(data, callback) {
        // Skip logging frequent calls
        if (!/(active_scanners|packLaneStatus)/.test(data)) {
            logMessage(`INFO: Database query - ${JSON.stringify(data)}`);
        }
        sql_lib.getFromDatabase(data, function(data, results) {
            callback(data, results);
        });
    });
    
    // Database INSERT/UPDATE commands
    socket.on('commandDB', function(data) {
        logMessage(`INFO: Database command - ${JSON.stringify(data)}`);
        const q = (typeof data.query !== 'undefined') ? data.query : data;
        sql_lib.sql_query(q);
    });
    
    // PLC write requests
    socket.on('plcWriteRequest', function(data) {
        logMessage(`INFO: PLC write request - ${JSON.stringify(data)}`);
        plc.write(data.tag, data.value);
    });
    
    // PLC read requests
    socket.on('plcReadRequest', function(data) {
        logMessage(`INFO: PLC read request - ${JSON.stringify(data)}`);
        plc.read(data.tag);
    });
    
    // Request initial update
    socket.on('needFirstUpdate', function() {
        console.log("INFO: HMI client requesting initial update");
        lowFreq_server.emit('needFirstUpdate');
    });
    
    // Local tag updates (single client only)
    socket.on('needLocalUpdate', function(action) {
        console.log(`INFO: Local update request - tag: ${action.tagName}`);
        do_text_and_style_apply(action);
    });
});

//==============================================================================
// HMI PLC MODULE INITIALIZATION
//==============================================================================

const hmi_plc = require('./graf_plc_hmi_chook.js');
hmi_plc.initialize({ plc_conn: plc, graf_io: io });

const macros = hmi_plc.get_macros();
logMessage("SUCCESS: Apply macros loaded\n" + JSON.stringify(macros, null, 4));

//==============================================================================
// SIGNAL HANDLERS
//==============================================================================

/**
 * Handle SIGUSR2 to trigger client reload
 * Usage: kill -SIGUSR2 <pid>
 * See: ~/wic/ccs/reload_html_client
 */
process.on('SIGUSR2', () => {
    logMessage('INFO: Received SIGUSR2 - emitting reload command to clients');
    io.emit('reload', { do_reload: "YES" });
});

//==============================================================================
// TEXT AND STYLE APPLICATION FUNCTIONS
//==============================================================================

/**
 * Parse target array syntax
 * Example: tag1>.[tag[2], tag[3]] -> ["tag1>.", "tag[2], tag[3]"]
 */
function parse_target(target) {
    const p1 = target.split('[')[0];
    const y = target.slice(target.indexOf('[') + 1);
    const p2 = y.slice(0, y.length - 1);
    return [p1, p2];
}

/**
 * C-like text application
 * Syntax: if($v){ $T>.LABEL=visible; } / if(!$v){ $t>.ALERT=invisible; }
 */
function text_apply_C_like(action) {
    try {
        var applications = action.txtApply
            .replace(/\$T/ig, action.tagName)
            .replace(/\$V/ig, action.value)
            .replace(/\$B/ig, '');
    } catch (e) {
        logMessage(`ERROR: Text apply failed - ${JSON.stringify(action)}\nError: ${JSON.stringify(e)}`);
        return;
    }
    
    const app_arr = applications.split('/');
    for (let i = 0; i < app_arr.length; i++) {
        const app = app_arr[i].trim();
        
        if (/if *\(/i.test(app)) {
            const logic = app.split('{')[0].split('if')[1];
            let _gX1;
            
            try {
                eval(`_gX1 = ${logic}`);
            } catch (e) {
                logMessage(`ERROR: Invalid logic in text apply - if(${logic})\nExpression: ${app}\nError: ${JSON.stringify(e)}`);
                continue;
            }
            
            if (_gX1) {
                const targetValues = app.split('{')[1].split('}')[0];
                const a = targetValues.split(';');
                
                for (let i = 0; i < a.length; i++) {
                    if (a[i].trim()) {
                        const data = {
                            target: a[i].split('=')[0].trim(),
                            text: a[i].split('=')[1].trim(),
                            adaptor: action.adapter,
                        };
                        
                        // Handle array of targets
                        if (/\[[^0-9].*\]$/.test(data.target)) {
                            const [p1, p2] = parse_target(data.target);
                            const targets = p2.split(',');
                            for (let i = 0; i < targets.length; i++) {
                                data.target = p1.trim() + targets[i].trim();
                                io.emit('targetedTextChange', data);
                            }
                        } else {
                            io.emit('targetedTextChange', data);
                        }
                    }
                }
            }
        }
    }
}

/**
 * C-like style application
 * Syntax: if($v){ $T>.LABEL=CLASS; } / if(!$v){ $t>.ALERT=CLASS; }
 */
function style_apply_C_like(action, remove_flag = true) {
    try {
        var applications = action.styleApply
            .replace(/\$T/ig, action.tagName)
            .replace(/\$V/ig, action.value)
            .replace(/\$B/ig, '');
    } catch (e) {
        logMessage(`ERROR: Style apply failed - ${JSON.stringify(action)}\nError: ${JSON.stringify(e)}`);
        return;
    }
    
    const app_arr = applications.split('/');
    for (let i = 0; i < app_arr.length; i++) {
        const app = app_arr[i].trim();
        
        if (/if *\(/i.test(app)) {
            const logic = app.split('{')[0].split('if')[1];
            let _gX1;
            
            try {
                eval(`_gX1 = ${logic}`);
            } catch (e) {
                logMessage(`ERROR: Invalid logic in style apply - if(${logic})\nExpression: ${app}\nError: ${JSON.stringify(e)}`);
                continue;
            }
            
            const targetValues = app.split('{')[1].split('}')[0];
            const a = targetValues.split(';');
            
            for (let i = 0; i < a.length; i++) {
                if (a[i].trim()) {
                    const data = {
                        target: a[i].split('=')[0].trim(),
                        pClass: a[i].split('=')[1].trim(),
                        adaptor: action.adapter,
                    };
                    
                    // Handle array of targets
                    if (/\[[^0-9].*\]$/.test(data.target)) {
                        const [p1, p2] = parse_target(data.target);
                        const targets = p2.split(',');
                        for (let i = 0; i < targets.length; i++) {
                            data.target = p1.trim() + targets[i].trim();
                            if (_gX1) {
                                io.emit('targetedAddClass', data);
                            } else if (remove_flag) {
                                io.emit('targetedRemoveClass', data);
                            }
                        }
                    } else {
                        if (_gX1) {
                            if (!/FLASH_1SEC/.test(data.target)) {
                                console.log('INFO: Adding class -', data);
                            }
                            io.emit('targetedAddClass', data);
                        } else if (remove_flag) {
                            io.emit('targetedRemoveClass', data);
                        }
                    }
                }
            }
        }
    }
}

/**
 * Legacy cryptic text application
 * Syntax: value::target::text:::value::target::text
 */
function text_apply_cryptic(action) {
    let applications = action.txtApply
        .replace(/\*TAGNAME\*/g, action.tagName)
        .replace(/\*VALUE\*/g, action.value);
    applications = applications.split(":::");
    
    for (let n = 0; n < applications.length; n++) {
        const application = applications[n].split("::");
        if ((application[0] == action.value) || (application[0] == '*')) {
            io.emit('targetedTextChange', {
                target: application[1],
                text: application[2]
            });
        }
    }
}

/**
 * Legacy cryptic style application
 * Syntax: value::target::class:::value::target::class
 */
function style_apply_cryptic(action, remove_flag = true) {
    let applications = action.styleApply.replace(/\*TAGNAME\*/g, action.tagName);
    applications = applications.split(":::");
    
    for (let m = 0; m < applications.length; m++) {
        const application = applications[m].split("::");
        if ((application[0] == action.value) || (application[0] == '*')) {
            io.emit('targetedAddClass', {
                target: application[1],
                pClass: application[2]
            });
        } else if (remove_flag) {
            io.emit('targetedRemoveClass', {
                target: application[1],
                pClass: application[2]
            });
        }
    }
}

/**
 * Main text and style application dispatcher
 * Handles both C-like and cryptic syntax, including macros
 */
function do_text_and_style_apply(action, remove_flag = true) {
    // Text Apply
    function textApply() {
        if (/if *\(/i.test(action.txtApply)) {
            text_apply_C_like(action);
        } else if (/\S+::\S+::\S+/.test(action.txtApply)) {
            text_apply_cryptic(action);
        } else if (action.txtApply) {
            console.log("ERROR: Unknown text apply format -", action);
        }
    }
    
    // Style Apply
    function styleApply() {
        if (/if *\(/i.test(action.styleApply)) {
            style_apply_C_like(action, remove_flag);
        } else if (/\S+::\S+::\S+/.test(action.styleApply)) {
            style_apply_cryptic(action, remove_flag);
        } else if (action.styleApply) {
            console.log("ERROR: Unknown style apply format -", action);
        }
    }
    
    // Check for text apply macros
    if (/^@.+/.test(action.txtApply.trim())) {
        const name = action.txtApply.split('@')[1].split(' ')[0].trim();
        if (macros[name] !== undefined) {
            action.txtApply = macros[name].textApply;
            textApply();
        } else {
            logMessage(`ERROR: Unknown text apply macro - ${name}`);
        }
    } else {
        textApply();
    }
    
    // Check for style apply macros
    let flag = false;
    try {
        flag = /^@.+/.test(action.styleApply.trim());
    } catch (e) {
        console.log("ERROR: Style apply parse failed -", action);
        console.log(e);
        flag = false;
    }
    
    if (flag) {
        const name = action.styleApply.split('@')[1].split(' ')[0].trim();
        if (macros[name] !== undefined) {
            action.styleApply = macros[name].styleApply;
            styleApply();
        } else {
            logMessage(`ERROR: Unknown style apply macro - ${name}`);
        }
    } else {
        styleApply();
    }
}

logMessage("SUCCESS: Graphics server fully initialized and ready");

/*==============================================================================
 * END-OF-FILE: grafSrv.js
 *============================================================================*/
