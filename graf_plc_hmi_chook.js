
/*==============================================================================
 * BEGIN-OF-FILE: graf_plc_hmi.js
 *==============================================================================
 * File: graf_plc_hmi.js
 * Date: February 5, 2026
 * Authors: Gary Argraves, Claude
 * Company: Your company name here 
 * 
 * Purpose:
 *   HMI-specific PLC event handlers and macro definitions for warehouse
 *   automation graphic server. Provides style/text application macros and
 *   manages periodic updates to connected HMI clients.
 * 
 * Usage:
 *   const hmi_plc = require('./graf_plc_hmi.js');
 *   hmi_plc.initialize({plc_conn, graf_io});
 *   
 * Features:
 *   - Macro-based style and text application (@lane_full, @motor, etc.)
 *   - PLC heartbeat interlock generation
 *   - Real-time server time/date emission to clients
 *   - HMI client count tracking
 *   - Periodic PLC polling for application-specific data
 * 
 * Macro System:
 *   Uses @ prefix for reusable style/text patterns:
 *   - @lane_full, @lane_jam: Conveyor lane status
 *   - @estop, @fault: Safety and fault conditions
 *   - @motor, @gate: Actuator states
 *   - @heartbeat: PLC connection status
 *   - @state_on_off: Generic on/off states
 * 
 * Apply Syntax:
 *   Variables: $v=value, $V=VALUE, $T=TAGNAME, $t=tagname, $B=BLANK
 *   Format: if($v){ $T=CLASS;} / if(!$v){ $t=CLASS;}
 *============================================================================*/

//==============================================================================
// MACRO DEFINITIONS - STYLE AND TEXT APPLICATION PATTERNS
//==============================================================================

const APPLY_MACROS = [
    // Lane Status Macros
    ["lane_full",       "if($v){ $T=FULL;}   / if(!$v){ $t=CLEAR;}",      "if($V){$T=Full;} / if(!$v){$t=  . ;}"],
    ["lane_full_50",    "if($v){ $T=FULL50;} / if(!$v){ $t=CLEAR;}",      "if($V){$T=Part Full;} / if(!$v){$t=  . ;}"],
    ["lane_jam",        "if($v){ $T=JAM;}    / if(!$v){ $t=CLEAR;}",      "if($V){$T=Jam;} / if(!$v){$t=  -  ;}"],
    
    // Safety and Fault Macros
    ["estop",           "if(!$v){ $T=ESTOP;} / if ($v){ $t=ESTOP_CLEAR;}","if (!$V){$T=Estop;} / if ($v){$t= - ;}"],
    ["Iestop",          "if ($v){ $T=ESTOP;} / if(!$v){ $t=ESTOP_CLEAR;}","if ( $V){$T=Estop;} / if(!$v){$t= - ;}"],
    ["fault",           "if ($v){$T=FAULT;} / if(!$v){ $t=CLEAR;}",       "if ($V){$T=Fault;} / if(!$v){$t= - ;}"],
    ["Ifault",          "if(!$v){$T=FAULT;} / if ($v){ $t=CLEAR;}",       "if(!$V){$T=Fault;} / if ($v){$t= - ;}"],
    ["mfault",          "if ($v){$T=FAULT;} / if(!$v){ $t=SMALL_OK;}",    "if ($V){$T=Fault;} / if(!$v){$t=$t;}"],
    
    // Status Indicators
    ["heartbeat",       "if($V){ $T=HB1;}   / if(!$v){ $T=HB0;}",         "if($v){$T=X} / if(!$v){$T=O}"],
    ["okay",            "if ($v){ $T=OKAY;} / if(!$v){ $t=FAULT;}",       "if  ($V){$T=Okay;} / if(!$v){$t=Fault;}"],
    ["Iokay",           "if(!$v){ $T=OKAY;} / if ($v){ $t=FAULT;}",       "if (!$V){$T=Okay;} / if ($v){$t=Fault;}"],
    
    // Actuator States
    ["state_on_off",    "if($v){ $T=STATE_ON;} / if(!$v){ $t=STATE_OFF;}","if ($V){$T=On;} / if(!$v){$t=Off;}"],
    ["Istate_on_off",   "if(!$v){ $T=STATE_ON;} / if($v){ $t=STATE_OFF;}","if (!$V){$T=On;} / if($v){$t=Off;}"],
    ["gate",            "if ($v){ $T=GATE_OPEN;} / if(!$v){ $t=GATE_CLOSE;}", "if  ($V){$T=Open;} / if(!$v){$t=Close;}"],
    ["Igate",           "if(!$v){ $T=GATE_OPEN;} / if ($v){ $t=GATE_CLOSE;}", "if (!$V){$T=Open;} / if ($v){$t=Close;}"],
    ["motor",           "if ($v){$T=MOTOR_ON;} / if(!$v){ $t=MOTOR_OFF;}","if ($V){$T=$T;} / if(!$v){$t=$t;}"],
    ["solenoid",        "if($v){ $T=SOL_ON;} / if(!$v){ $t=SOL_OFF;}",   "if ($V){$T=Fire;} / if(!$v){$t= - ;}"],
    
    // Sensor States
    ["pe",              "if(!$v){ $T=PE_BLOCK;} / if($v){ $t=PE_OPEN;}",  "if (!$V){$T=Blk;} / if($v){$t= . ;}"],
    ["ms",              "if(!$v){ $T=MS_OPEN;}  / if($v){ $t=MS_MADE;}",  "if (!$V){$T= - ;} / if($v){$t= Made ;}"],
    
    // Specialized
    ["release",         "if($v){ $T=HELD;}   / if(!$v){ $t=RELEASE;}",    "if ($V){$T=Held;} / if(!$v){$t= releasing;}"],
    ["tamper",          "if($v){ $T=HOME;}   / if(!$v){ $t=TAMP;}",       "if ($V){$T=Home;} / if(!$v){$t=Tamp;}"],
    
    // Display Values
    ["encoder_PPS",     "",                                                "if(1){$T=$V;}"],
    ["number_display",  "",                                                "if(1){$T=$V;}"],
];

//==============================================================================
// MODULE STATE
//==============================================================================

let PLC_heartbeat = 0;
let plc = null;
let io = null;

//==============================================================================
// PLC EVENT HANDLERS
//==============================================================================

/**
 * Handle PLC read responses for HMI-specific tags
 * Note: This is a placeholder for future implementation with new PLC driver
 */
function handlePlcReadResponse(payload) {
    // Placeholder for application-specific PLC tag handling
    // Previously handled PCDATA tags for ship divert, host status, weights
   
	console.log(payload);
 
    if (payload.tag && payload.single !== null) {
        console.log(`INFO: HMI-specific tag read - ${payload.tag} = ${payload.single}`);
    }

	/*
	//--- example use is to emit to the graphic clients
	// the client can make the request or spawned in this file (preferred).
	switch(true){
		case /PCDATA\[10\]/.test(payload.tag):
			io.emit('LAST_SHIP_DIVERT', payload.single);
			break;
	}//sw
	*/
}

//==============================================================================
// PERIODIC TASKS
//==============================================================================

/**
 * Initialize periodic 1-second tasks:
 * - Server date/time emission
 * - HMI client count tracking
 * - PLC heartbeat interlock
 * - Application-specific PLC polling
 */
function startPeriodicTasks() {
    setInterval(() => {
        // Emit server date/time
        const d = new Date();
        io.emit('time', {
            time: d.toJSON(),
            local: d.toLocaleString()
        });
        
        // Emit HMI client count
        io.emit('HMI_client_count', io.engine.clientsCount);
        
        // Toggle PLC heartbeat
        PLC_heartbeat ^= 1;
        plc.write('PCDATA[14]', PLC_heartbeat);
        
        // Poll application-specific data if clients connected
        if (io.engine.clientsCount > 0) {
            //plc.read("N12:27"); // Lane fulls and jams
            //plc.send("RM,N12:27;"); // Lane fulls and jams 
        }
        
    }, 1000);
}

//==============================================================================
// MACRO ACCESS
//==============================================================================

/**
 * Get all macros as dictionary
 * @returns {Object} Macro name -> {styleApply, textApply}
 */
function getMacros() {
    const macros = {};
    for (let i = 0; i < APPLY_MACROS.length; i++) {
        macros[APPLY_MACROS[i][0]] = {
            styleApply: APPLY_MACROS[i][1],
            textApply: APPLY_MACROS[i][2]
        };
    }
    return macros;
}

//==============================================================================
// MODULE EXPORTS
//==============================================================================

module.exports = {
    /**
     * Initialize module with PLC connection and Socket.IO instance
     * @param {Object} data - {plc_conn, graf_io}
     */
    initialize: (data) => {
        plc = data.plc_conn;
        io = data.graf_io;
        
        console.log("SUCCESS: HMI PLC module initialized");
        
        // Start periodic tasks
        startPeriodicTasks();
    },
    
    /**
     * Get macro definitions
     * @returns {Object} Macro dictionary
     */
    get_macros: getMacros,
    
    /**
     * Handle PLC responses (legacy compatibility)
     * @param {Object} data - PLC response data
     */
    plc_handler: handlePlcReadResponse,
};

/*==============================================================================
 * END-OF-FILE: graf_plc_hmi.js
 *============================================================================*/
