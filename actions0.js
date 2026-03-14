/*-----------------------
 * 	 File: actions0.js
	 Date: Jan. 15, 2026
	   by: Gary Argraves
For Company: Your Company 
*/

// default PLC array; used if proxyTagName is the index of this array; 
//	...logic: if (NaN) use-StringName else use-Default_PLC_arr[index];
var default_PLC_arr_proxyTagName = "PCDATA"; // Is Applicable at FMP, Using A/B CompactLogix PLC

apply=(tag)=>{
	if (/^FLASH/.test(tag)) 	return '@heartbeat';
	//if (/^STATUS_/.test(tag))	return '@state_on_off'; //Status

	//--- non-fault objects
	if (/RUNNING$/.test(tag)) 	return '1::*TAGNAME*::green'; // pick level RUNNING
	if (/^M\d{3}$/.test(tag)) 	return '1::*TAGNAME*::green'; // motors RUNNING
	if (/(FULL_|_FULL)/.test(tag)) 	return '0::*TAGNAME*::invisible';
	if (/(MERGE_STOP)/.test(tag)) 	return '0::*TAGNAME*::invisible';
	if (/(ENC_510_FAULT)/.test(tag)) 	return '0::*TAGNAME*::invisible';
	if (/^FLASH/.test(tag)) return '@heartbeat';
	if (/^GATE_/.test(tag)) return '@Igate';
	//
	//--- FAULT objects
	if (/^ES(PC|PB|R|_G)/.test(tag)) 	return '0::*TAGNAME*::invisible'; //0=no fault ; PullCord PushButton, Relay Global 
	if (/^JAM_/.test(tag))		return '0::*TAGNAME*::invisible'; //0=no fault
	if (/^M.*FAULT$/.test(tag)) return '1::*TAGNAME*::red'; //0=no fault
	if (/_FAULT$/i.test(tag)) 	return '1::*TAGNAME*::red'; //0=no fault
	
	if (/Low_Air/i.test(tag)) 		return '@okay';  // Inverse fault:  1=OK 0=Fault;

	if (/^M\d{3}_.*$/.test(tag)) 	return '1::*TAGNAME*::green'; // ...more motors RUNNING; note do lastly/after FAULTS

	//>>>>> DEFAULT <<<<<<
	//return '1::*TAGNAME*::invisible';  ///MARTYS Default
	return '';

	//if (/^FULL_/.test(tag)) return '0::*TAGNAME*::invisible';
	//if (/^JAM_/.test(tag))  return '0::*TAGNAME*::invisible';
	//if (/^ESTOP_/.test(tag)) return '@estop';
	//if (/^RUNNING_/.test(tag)) return '@motor';
	//if (/^FLASH/.test(tag)) return '@heartbeat';

	if (/^FAULT_/.test(tag)){
		//--- faults that are associated with a motor; normal fault, but displays lightgreen for motors OK
		if (/_Motor/.test(tag)) return '@mfault';
		if (/Air_Pres/.test(tag)) return '@Ifault';  // Inverse fault:  1=OK 0=Fault;

		return '@fault'; // 1=fault
	}//if

	// A&O has no Gates;
	if (/^STATUS/.test(tag)) return '@okay'; // or '@state_on_off' ==> On/ Off
	if (/^STATE/.test(tag)) return '@state_on_off'; // or '@state_on_off' ==> On/ Off

	return '';
}//fn

//-----	Proxy
//tagName/ndx,	PlcUse,	scanInterval, styleApply, textApply // description
//------------  -------	------------  ----------  ---------	--------------
var PLC_tagType = [ //start array
[  9,		1,		1000,			'',		'@encoder_PPS'], // Sorter ENCODER Pulses Per second - top banner
[ 13,		1,		1000,			'',		''], // Heartbeat flash_1sec PLC driven
[ 14,		1,		1000,			'',		''], // Heartbeat interlock, driven by node grafserver
[ 19,		1,		2000,			'',		''], // Scan check counter 

[ 20,		1,		2000,			'',		''], // Motors faults /sundry 
[ 21,		1,		2000,			'',		''], // Jam faults
//[ 22,		1,		2000,			'',		''], // Jams2 faults ; not yet set, future use
[ 23,		1,		2000,			'',		''], // Full/Hold Conditions
[ 24,		1,		2000,			'',		''], // Motors running status
[ 25,		1,		2000,			'',		''], // ESTOPS/ ESPullCord ESPushButton 
]; // end array

//-----Principal tagName ProxyTag/Ndx	Bit	 style, text Apply
//---------------------	-------------	---- -------------------
var MAPPED_tagType = [

//---- Top banner status ----
[ "FLASH_1SEC",			   14,	    0, '', ''], // heartbeat

[ "SYSTEM_RUNNING",		   20,	    9, '@state_on_off', '@state_on_off'], // top banner

[ "Air_Pressure",          21,     10, '@okay', '@okay'], // top banner
[ "LOW_AIR",               21,     10, '@okay', '@okay'], // martys tag

[ "PLC_BATTERY",           21,     11, '@Iokay', '@Iokay'], // martys tag
[ "FAULT_PLC_Battery_Low", 21,     11, '@Iokay', '@Iokay'], //

[ "MASTER_RELAY",          25,      7, '@Istate_on_off', '@Istate_on_off'], // top banner; Master Control Relay (MCR) and estop are the same thing
[ "ESTOP_GLOBAL",          25,      9, '@Istate_on_off', '@Istate_on_off'], 

// -- end top banner

[ "M202_FAULT",   20, 0, '', '' ], // 2nd Level Pick Belt Motor FAULT
[ "M208_FAULT",   20, 1, '', '' ], // Belt Between 2 Lvl Pick Area and Decline FAULT
[ "M244_FAULT",   20, 2, '', '' ], // Decline Motor FAULT
[ "M239_FAULT",   20, 3, '', '' ], // 180 Deg Curve FAULT
[ "M227_FAULT",   20, 4, '', '' ], // 1st Level Pick Belt Motor FAULT
[ "M109_FAULT",   20, 5, '', '' ], // ACC from 1st Level Pick to Sorter FAULT
[ "M301_FAULT",   20, 6, '', '' ], // Brake Spacer Belt FAULT
[ "M302_FAULT",   20, 7, '', '' ], // Sorter Motor FAULT
[ "PMDR_FAULT",   20, 8, '', '' ], // MDR 480V Power FAULT/SAFETY RELAY

[ "JAM_302_10",   21, 0, '', ''], // scanner trigger/induct eye 
[ "JAM_302_20",   21, 1, '', ''], // Lane1 Entry PE JAM Fault 
[ "JAM_313_10",   21, 2, '', ''], // Lane1 Spur Jam Fault
[ "JAM_302_30",   21, 3, '', ''], // Lane2 Entry PE Jam Fault
[ "JAM_315_10",   21, 4, '', ''], // Lane2 Spur Jam Fault
[ "JAM_302_40",   21, 5, '', ''], // Lane3 Entry JAM Fault
[ "JAM_317_10",   21, 6, '', ''], // Lane3 Spur Jam Fault
[ "SCANNER_FAULT",21, 8, '', ''], // scan_check error; aka SERVER_RESPONSE_LOSS
[ "ENC_FAULT",    21, 9, '', ''], // Encoder Fault

// PCDATA[22] Jams2 reserved; not yet used, future

[ "LANE_1_FULL",  23, 0, '', ''], // sorter lane 1 full
[ "LANE_2_FULL",  23, 1, '', ''], //		|    2
[ "LANE_3_FULL",  23, 2, '', ''], //        |    3
[ "LANE_4_FULL",  23, 3, '', ''], // Sorter Overflow Full, aka: off-end of sorter full

[ "M202_RUNNING", 24, 0, '', ''], // 2nd Level Pick Belt Motor RUNNING
[ "M208_RUNNING", 24, 1, '', ''], // Belt Between 2 Lvl Pick Area and Decline RUNNING
[ "M239_RUNNING", 24, 2, '', ''], // 180 Deg Curve RUNNING
[ "M244_RUNNING", 24, 3, '', ''], // Decline Motor RUNNING
[ "M227_RUNNING", 24, 4, '', ''], // 1st Level Pick Belt Motor RUNNING
[ "M109_RUNNING", 24, 5, '', ''], // ACC from 1st Level Pick to Sorter RUNNING
[ "M301_RUNNING", 24, 6, '', ''], // Brake Spacer Belt RUNNING
[ "M302_RUNNING", 24, 7, '', ''], // Sorter Motor RUNNING
[ "PMDR_ENGAGED", 24, 8, '', ''], // MDR 480V Power ENGAGED

[ "ESPC_202A",    25, 0, '','' ], // 2nd Lvl Pick Belt Estop (TOP)
[ "ESPC_202B",    25, 1, '','' ], // 2nd Lvl Pick Belt Estop (BOTTOM)
[ "ESPC_206",     25, 2, '','' ], // 2nd Lvl Curve to Decline Estop
[ "ESPC_227A",    25, 3, '','' ], // 1st Lvl Pick Belt Estop (TOP)
[ "ESPC_227B",    25, 4, '','' ], // 1st Lvl Pick Belt Estop (BOTTOM)
[ "ESPC_106",     25, 5, '','' ], // Transport before Sorter Estop
[ "ESPC_302A",    25, 6, '','' ], // Sorter Estop (Top)
[ "ESR1",         25, 7, '','' ], // Safety Relay Engaged, aka 'MCR' Master Control Relay
[ "ESPB_101",     25, 8, '','' ], // ESTOP MAIN at Panel Push Button
[ "ES_GLOBAL",    25, 9, '','' ], // Any ESTOP active, includes 'MCR'

]; // end array  MAPPED_tagType

// test which tags have no styleApply
if(true){
	for (let i=0; i<MAPPED_tagType.length; i++){
		let tag = MAPPED_tagType[i][0]; 
		let a = apply(tag);

		//--- make 1stage output for trending file: hmi_proxy.txt
		if(false){
			console.log(`${i}	 ${tag.split("_wb_")[0].padEnd(50," ")}	 xxxxx	 PCDATA[${MAPPED_tagType[i][1]}].${MAPPED_tagType[i][2]}`);
		}//if

		if (a) {
			// directly modify the arrays above, instead of being done in lowFreqScan_noSQL.js
			if (!MAPPED_tagType[i][3] ) MAPPED_tagType[i][3] = a; // keep any present setting

			// Marty only uses Style apply
			if(/^@/.test(a)) // if is a macro apply, then also put the textApply with same.
				if (!MAPPED_tagType[i][4] )	MAPPED_tagType[i][4] = a; //	ditto
		}
		else{
			console.log("==> Oops, need a styleApply for tag: ", tag);
		}
	}//for
}//if

console.dir(MAPPED_tagType,  { maxArrayLength: null, depth: null } );

//end of file


