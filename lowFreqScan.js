/*==============================================================================
 * BEGIN-OF-FILE: pet_lowFreqScan_v20.js
 *==============================================================================
 * File: pet_lowFreqScan_v20.js
 * Date: February 5, 2026
 * Authors: Gary Argraves, Claude refactor
 * Company: Your Company name
 *
 *  notes: 
 *	- pet is 'PLC Easy Talk', name of a PLC Low-Level Driver
 * 	- actions0.js is for PLC adaptor #0
 *  - the cmd line parameter '0' will cause source load of file: actions0.js 
 *	- this file is setup for compactLogix, not SLC-500; some tag parse differences ex. PCDATA[0] vs N12:7
 *
 * Purpose:
 *   Poll PLC tag values and update proxy-mapped principal tags for warehouse
 *   automation HMI. Handles bitwise proxy mapping from PLC arrays to named
 *   principal tags with real-time updates via Socket.IO to graphic server.
 *   Updated for slcSockSrv v19 with consistent protocol.
 * 
 * Usage:
 *   node pet_lowFreqScan_v20.js <PLC_Adaptor_Number>
 *   
 *   Example: node pet_lowFreqScan_v20.js 0
 *   
 *   Where adaptor number is 0-3 for multi-PLC installations
 * 
 * Features:
 *   - Single PLC adaptor per instance (run multiple for multi-PLC)
 *   - Proxy-to-principal tag mapping with bitwise extraction
 *   - Real-time updates to graphic server via Socket.IO
 *   - Support for Allen-Bradley SLC-500 PLCs via socket server
 *   - Configurable scan intervals per tag group
 *   - Optional trending data recording
 *   - Automatic reconnection on PLC disconnect
 * 
 * Architecture:
 *   - PLC tags (proxy) contain packed bit arrays
 *   - MAPPED tags (principal) are individual named tags
 *   - On value change, proxy bits update corresponding principals
 *   - All updates pushed to HMI via GRAF_IPC Socket.IO connection
 * 
 * Database Notes (converted to in-memory arrays):
 *   - PlcUse field bits:
 *     bit 0: Tag is bitwise proxy for principals
 *     bit 1: Record changes for trending
 *     bit 2: Special non-PLC proxy (script-modified)
 *   - No duplicate PLC tag names per adaptor
 *   - Duplicate principal names allowed
 * 
 * Changes from v19:
 *   - Uses plc_lib_chook.js with proper TCP buffering
 *   - Consistent colon delimiter protocol
 *   - Mirror read support (RM command)
 *   - Better error handling
 *   - Event-driven architecture
 *============================================================================*/

//==============================================================================
// COMMAND LINE ARGUMENT PROCESSING
//==============================================================================

const args = process.argv;

if (args.length < 3) {
    console.log("ERROR: Missing PLC adaptor number");
    console.log(`Usage: node ${process.argv[1]} PLC_Adaptor_Number`);
    console.log("Example: node pet_lowFreqScan.js 0");
    process.exit(1);
}

if (!/^[0-3]$/.test(process.argv[2])) {
    console.log(`ERROR: Invalid adaptor number '${process.argv[2]}'`);
    console.log("Please use adaptor number 0, 1, 2, or 3");
    process.exit(1);
}

const gAdapter_no = process.argv[2];
const moduleName = `LGX_halfSecScan${gAdapter_no}`;
const gAB_SLC500_flag = false;
const use_plc_trending = false;

console.log(`INFO: Starting module ${moduleName} on PLC adaptor ${gAdapter_no}`);

//==============================================================================
// LOGGING SYSTEM INITIALIZATION
//==============================================================================

const log_lib = require('./libs/log_lib.js');
log_lib.set_moduleName(moduleName);

const logMessage = (str, plogServer) => log_lib.log_write_frontend(str, plogServer);
const consoleMessage = (str) => log_lib.log_write_console(str);

logMessage("SUCCESS: Module initialization started");

//==============================================================================
// PLC DRIVER INITIALIZATION
//==============================================================================

const PLCDriver = require('./plc_lib_chook');

const plc = new PLCDriver({
    host: '127.0.0.1',
    port: 9002,
    logFn: logMessage,
    onConnFn: () => {
        logMessage("SUCCESS: PLC connected - testing with PCDATA[1] read");
        setTimeout(() => { plc.read('PCDATA[1]'); }, 5000);
    },
    onDisConnFn: () => {
        logMessage("WARNING: PLC disconnected");
    }
});

//==============================================================================
// PLC EVENT HANDLERS
//==============================================================================

// Read success (standard read)
plc.on('rok', (payload) => {
    if (payload.tag === 'PCDATA[0]') {
        process_inbound_tag_read(payload);
    } else if (payload.single !== null) {
        logMessage(`INFO: Read response - ${payload.tag} = ${payload.single}`);
    }
});

// Mirror read success (fast RAM read)
plc.on('rmok', (payload) => {
    if (payload.tag === 'PCDATA[0]') {
        process_inbound_tag_read(payload);
    } else if (payload.single !== null) {
        logMessage(`INFO: Mirror read response - ${payload.tag} = ${payload.single}`);
    }
});

// Write success
plc.on('wok', (payload) => {
    console.log(`SUCCESS: Write completed - ${payload.spec}`);
});

// Fill success
plc.on('fok', (payload) => {
    console.log(`SUCCESS: Fill completed - ${payload.spec}`);
});

// Communication errors
plc.on('plc_comm_error', (error) => {
    console.error(`ERROR: PLC communication failed - ${error.msg}`);
});

// Validation errors
plc.on('plc_validation_error', (error) => {
    console.error(`ERROR: PLC validation failed - ${error.msg}`);
});

// Data errors
plc.on('plc_data_error', (error) => {
    console.error(`ERROR: PLC data error - ${error.msg}`);
});

// Warnings
plc.on('plc_warning', (warning) => {
    console.warn(`WARNING: ${warning.msg}`);
});

// Unknown responses
plc.on('plc_unknown', (data) => {
    console.warn(`WARNING: Unknown PLC response - ${data.raw}`);
});

//==============================================================================
// SOCKET.IO CLIENT FOR GRAPHIC SERVER COMMUNICATION
//==============================================================================

const io = require("socket.io-client");
const GRAF_IPC = io.connect("http://localhost:2503");

GRAF_IPC.on('needFirstUpdate', function() {
    console.log("INFO: Graphic server requesting initial update");
    GRAF_IPC.emit('needFirstUpdate', actions);
});

//==============================================================================
// UTILITY FUNCTIONS
//==============================================================================

RegExp.quote = function(str) {
    return (str + '').replace(/[.?*+^$[\]\\(){}|-]/g, "\\$&");
};

//==============================================================================
// ACTION TABLE LOADING
//==============================================================================

const fs = require('fs');

let actions = [];
let UID = 0;

try {
    const data = fs.readFileSync(`actions${gAdapter_no}.js`, 'utf8');
    eval(data); // Builds PLC_tagType and MAPPED_tagType arrays
    
    logMessage(`SUCCESS: Loaded PLC_tagType array - ${PLC_tagType.length} entries`);
    logMessage(`SUCCESS: Loaded MAPPED_tagType array - ${MAPPED_tagType.length} entries`);
    
    //const default_PLC_arr_proxyTagName = "PCDATA";
    let cnts = { plc: 0, mapped: 0 };
    
    // Parse PLC_tagType array to JSON
    for (let i = 0; i < PLC_tagType.length; i++) {
        const r = PLC_tagType[i];
        cnts.plc++;
        
        let tagName;
        if (isNaN(r[0])) {
            tagName = r[0];
        } else if (gAB_SLC500_flag) {
            tagName = `${default_PLC_arr_proxyTagName}:${r[0]}`;
        } else {
            tagName = `${default_PLC_arr_proxyTagName}[${r[0]}]`;
        }
        
        actions.push({
            UID: ++UID,
            tagType: 'PLC',
            adapter: Number(gAdapter_no),
            tagName,
            PlcUse: Number(r[1]),
            scanInterval_ms: 500, // Fixed 500ms scan interval
            styleApply: r[3],
            txtApply: r[4],
            value: 0,
            lastValue: 0,
            tagNameProxy: '',
            bitNum: 0,
        });
    }
    
    // Parse MAPPED_tagType array to JSON
    for (let i = 0; i < MAPPED_tagType.length; i++) {
        const r = MAPPED_tagType[i];
        
        // Skip if no styleApply or textApply
        if (r[3] === "" && r[4] === "") continue;
        
        cnts.mapped++;
        
        let tagNameProxy;
        if (isNaN(r[1])) {
            tagNameProxy = r[1];
        } else if (gAB_SLC500_flag) {
            tagNameProxy = `${default_PLC_arr_proxyTagName}:${r[1]}`;
        } else {
            tagNameProxy = `${default_PLC_arr_proxyTagName}[${r[1]}]`;
        }
        
        actions.push({
            UID: ++UID,
            tagType: "MAPPED",
            adapter: Number(gAdapter_no),
            tagName: r[0],
            tagNameProxy,
            bitNum: Number(r[2]),
            styleApply: r[3],
            txtApply: r[4],
            value: 0,
            lastValue: 0,
            PlcUse: 0,
            scanInterval_ms: 0,
        });
    }
    
    logMessage(`SUCCESS: Action table created - PLC: ${cnts.plc}, MAPPED: ${cnts.mapped}`);
    
} catch (err) {
    console.error("ERROR: Failed to load action table");
    console.error(err);
    process.exit(1);
}

//==============================================================================
// DATABASE REPLACEMENT FUNCTIONS (IN-MEMORY)
//==============================================================================

/**
 * Get all principal (MAPPED) tags
 * SQL equivalent: SELECT UID, tagName, value, tagNameProxy, bitNum 
 *                 FROM active_actions WHERE tagType='MAPPED'
 */
function actions_get_principals() {
    const results = [];
    for (let i = 0; i < actions.length; i++) {
        const r = actions[i];
        if (r.tagType === 'MAPPED') {
            results.push({
                UID: r.UID,
                tagName: r.tagName,
                value: r.value,
                tagNameProxy: r.tagNameProxy,
                bitNum: r.bitNum
            });
        }
    }
    return results;
}

/**
 * Get all PLC scan tags for this adaptor
 * SQL equivalent: SELECT tagName, scanInterval_ms, PlcUse, UID 
 *                 FROM active_actions 
 *                 WHERE (tagType='PLC' OR (PlcUse & 4)=4) AND adapter=?
 */
function actions_get_PLC_scan_tags() {
    const results = [];
    for (let i = 0; i < actions.length; i++) {
        const r = actions[i];
        if ((r.tagType === 'PLC' || (r.PlcUse & 4)) && r.adapter == gAdapter_no) {
            results.push({
                UID: r.UID,
                tagName: r.tagName,
                PlcUse: r.PlcUse,
                scanInterval_ms: r.scanInterval_ms
            });
        }
    }
    return results;
}

/**
 * Get value for specific tag name
 * SQL equivalent: SELECT tagName, value FROM active_actions WHERE tagName=?
 */
function actions_get_value(tagName) {
    for (let i = 0; i < actions.length; i++) {
        const r = actions[i];
        if (r.tagName === tagName) {
            return [{ UID: r.UID, tagName: r.tagName, value: r.value }];
        }
    }
    return [];
}

/**
 * Update value by UID
 * SQL equivalent: UPDATE active_actions SET value=?, valueUpdated='Y' WHERE UID=?
 */
function actions_set_value_by_UID(UID, value) {
    for (let i = 0; i < actions.length; i++) {
        if (actions[i].UID === UID) {
            actions[i].value = value;
            GRAF_IPC.emit('tagChange', actions[i]);
            break;
        }
    }
}

/**
 * Update value by tag name
 * SQL equivalent: UPDATE active_actions SET value=?, lastValue=?, valueUpdated='Y' 
 *                 WHERE tagName=? AND adapter=?
 */
function actions_set_value_by_tagName(tagName, value, lastValue) {
    for (let i = 0; i < actions.length; i++) {
        if (actions[i].tagName === tagName) {
            actions[i].value = value;
            actions[i].lastValue = lastValue;
            GRAF_IPC.emit('tagChange', actions[i]);
			//console.log('---set value by tag ', tagName,value,lastValue);
            break;
        }
    }
}

//==============================================================================
// TAG PROCESSING
//==============================================================================

// Get all principal tags for proxy mapping
const map_dict = actions_get_principals();

// Storage for last PLC read values
const gLastValue = {};

// One-shot synchronization flag (cleared after 3 seconds)
let oneshot_sync_flag = true;
setTimeout(() => {
    oneshot_sync_flag = false;
    logMessage("INFO: Initial synchronization period complete");
}, 3000);

// Trending array
const gTrend_arr = [];

/**
 * Process inbound PLC tag read (PCDATA[0] to PCDATA[99])
 */
function process_inbound_tag_read(data) {
	// console.log(data);
	/*
	{
	  tag: 'PCDATA[0]',
	  values: [
		   0,  0, 0,   1,   0,   5,   10,
		  15, 20, 1,  99,   4, 904,    1,
		   0,  0, 0,   0,   0, 437, 1011,
		1281,  0, 5, 512, 635,   0,    0,
		   0,  0
	  ],
	  single: null
	}
	*/
    const val_arr = data.values;
    const keys = Object.keys(gScan);
    const key = keys[0]; // Single 500ms class
    
    for (let j = 0; j < gScan[key].length; j++) {
        const tagName = gScan[key][j];
        
        // Process only PCDATA[0] to PCDATA[99] tags
        if (/PCDATA\[\d\d?\]/.test(tagName)) {
            //const ndx = parseInt(tagName.split(':').pop(), 10);
			const ndx = parseInt(tagName.split('[')[1].split(']')[0], 10);
			
            if (ndx >= 0 && ndx < val_arr.length) {
                const value = val_arr[ndx];
                update_tags({ plcTagName: tagName, value });
            }
        }
    }
}

/**
 * Update both principal (MAPPED) and proxy (PLC) tags
 */
function update_tags(data) {
	//console.log(data);
	/*
	{ plcTagName: 'PCDATA[9]', value: 0 }
	{ plcTagName: 'PCDATA[13]', value: 1 }
	{ plcTagName: 'PCDATA[14]', value: 0 }
	{ plcTagName: 'PCDATA[19]', value: 461 }
	{ plcTagName: 'PCDATA[20]', value: 1011 }
	{ plcTagName: 'PCDATA[21]', value: 1281 }
	{ plcTagName: 'PCDATA[22]', value: 0 }
	{ plcTagName: 'PCDATA[23]', value: 5 }
	{ plcTagName: 'PCDATA[24]', value: 512 }
	{ plcTagName: 'PCDATA[25]', value: 635 }

	{ plcTagName: 'PCDATA[9]', value: 1 }
	{ plcTagName: 'PCDATA[13]', value: 1 }
	{ plcTagName: 'PCDATA[14]', value: 0 }
	{ plcTagName: 'PCDATA[19]', value: 461 }
	{ plcTagName: 'PCDATA[20]', value: 1011 }
	{ plcTagName: 'PCDATA[21]', value: 1281 }
	{ plcTagName: 'PCDATA[22]', value: 0 }
	{ plcTagName: 'PCDATA[23]', value: 5 }
	{ plcTagName: 'PCDATA[24]', value: 512 }
	{ plcTagName: 'PCDATA[25]', value: 635 }
	*/
    const proxy = {
        tagName: data.plcTagName,
        curr_value: data.value,
        last_value: gLastValue[data.plcTagName]
    };
    
    // Skip if value unchanged (except during one-shot sync)
    if (proxy.last_value === proxy.curr_value && !oneshot_sync_flag) {
        return;
    }
    
    // Save last value
    gLastValue[proxy.tagName] = proxy.curr_value;
    
    // Update all principal/mapped tags that reference this proxy
    for (let i = 0; i < map_dict.length; i++) {
        if (map_dict[i].tagNameProxy === proxy.tagName) {
            // Extract bit value
            const mask = 1 << map_dict[i].bitNum;
            const new_value = (proxy.curr_value & mask) ? '1' : '0';
            
			//console.log(map_dict[i], new_value, map_dict[i].value);

            // Update if changed
            if (new_value !== map_dict[i].value) {
                map_dict[i].value = new_value;
                
                // Skip logging for heartbeat tag
                if (!/PCDATA\[1[34]\]/.test(data.plcTagName)) { // PCDATA[13] and PCDATA[14]
                    console.log('INFO: Updated principal -', data, map_dict[i]);
                }
                
                actions_set_value_by_UID(map_dict[i].UID, new_value);
            }
        }
    }
    
    // Update proxy tag
    actions_set_value_by_tagName(proxy.tagName, proxy.curr_value, proxy.last_value);
    
    // Record trending if enabled
    if (gTrend_arr.includes(data.plcTagName)) {
        const last = proxy.last_value === undefined ? 0 : proxy.last_value;
        logMessage(`~T ${Date.now().toString().slice(0, 10)} ${proxy.tagName} ${last} ${proxy.curr_value}`);
    }
}

//==============================================================================
// SCAN INTERVAL SETUP
//==============================================================================

const gScan = {};
const results = actions_get_PLC_scan_tags();

for (let i = 0; i < results.length; i++) {
    const scanIntName = `ms${results[i].scanInterval_ms}`;
    
    if (!gScan[scanIntName]) {
        gScan[scanIntName] = [];
    }
    
    gScan[scanIntName].push(results[i].tagName);
    
    // Add to trending array if configured
    if (use_plc_trending && (results[i].PlcUse & 2) === 2) {
        gTrend_arr.push(results[i].tagName);
    }
}

const keys = Object.keys(gScan);
logMessage(`INFO: Scan intervals configured - ${JSON.stringify(keys)}`);

//==============================================================================
// PLC CONNECTION AND POLLING
//==============================================================================

plc.connect();

// Poll PLC at 1 Hz using mirror read (fast RAM access)
setInterval(() => {
    if (plc.isConnected) {
		plc.read('PCDATA[0]',30); 
    }
}, 1000);

logMessage("SUCCESS: PLC polling started at 1 Hz using mirror reads");

//==============================================================================
// GRACEFUL SHUTDOWN
//==============================================================================

process.on('SIGINT', () => {
    console.log("\nINFO: Shutting down gracefully...");
    plc.disconnect();
    process.exit(0);
});

/*==============================================================================
 * END-OF-FILE: pet_lowFreqScan_v20.js
 *============================================================================*/
