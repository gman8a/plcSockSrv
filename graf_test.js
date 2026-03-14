//////////////////////////////////////////////////////////////////////////
// Client to low Freq socket
//
//  	sudo apt-get install npm
//		npm install socket.io-client
//
//	https://gist.github.com/luciopaiva/e6f60bd6e156714f0c5505c2be8e06d8
//////////////////////////////////////////////////////////////////////////
//socket-io. client is the code for the client-side implementation of socket.io. 
//That code may be used either by a browser client or by a server process that is initiating a socket.io connection 
//	to some other server (thus playing the client-side role in a socket.io connection).

var fault_store1={};

const
    io2 = require("socket.io-client");
	lowFreq_io = io2.connect("http://localhost:2500");


	lowFreq_io.on('welcome', function(data){ console.log(data); });		
//	lowFreq_io.on('time', function(data){ console.log(data); });		
//	lowFreq_io.on('FLASH_1SEC', function(data){ console.log(data); });		

//	lowFreq_io.on('PCDATA[61]', function(data){ console.log('sorter encoder PPS: ', data); });
//	lowFreq_io.on('PANDA_HMI', function(data){ console.log('PANDA_HMI: ', data); });		
//
//	lowFreq_io.on('LAST_SHIP_DIVERT', function(data){ console.log('LAST_SHIP_DIVERT: ', data); });		
//	lowFreq_io.on('HOST_NOT_AVAILABLE', function(data){ console.log('HOST_NOT_AVAILABLE: ', data); });		

	lowFreq_io.on('targetedAddClass', function(data){ 
			//if(/flash/i.test(data.target)) 
				console.log('Add: ',data); 
			//if(isFault_on_add(data)) 
			fault_store1[data.target] = isFault_on_add(data);
	});
	
	lowFreq_io.on('targetedRemoveClass', function(data){
			//if(/flash/i.test(data.target))  
				console.log('Remove: ',data); 
			fault_store1[data.target] = isFault_on_remove(data);
	});
		
	lowFreq_io.on('targetedTextChange', function(data){ 
		//if(/flash/i.test(data.target))  
			console.log('Text: ',data); 
		});		

	lowFreq_io.on('targetedDoNothingClass', function(data){ console.log('DoNothing: ',data); });		

	setTimeout( ()=>{
		lowFreq_io.emit('needFirstUpdate');
	}, 5000);

//--- pickup from pClass, Marty's way 1
//--- Marty is not using textApply for fault; but instead is using styleApply w/pClass = visible or invisbile
isFault_on_add = (data) => {
	switch(true){
		case (  /^JAM_/.test(data.target) && data.pClass == 'invisible'):	return ""; break; //fault class
		case (/^ESTOP_/.test(data.target) && data.pClass == 'invisible'): 	return ""; break;
		case (/^FAULT_/.test(data.target) && data.pClass == 'red'):			return "Fault"; break;
	}//sw
	return '';
}//fn
isFault_on_remove = (data) => {
	switch(true){
		case (  /^JAM_/.test(data.target) && data.pClass == 'invisible'):	return "Jam"; break; //fault class
		case (/^ESTOP_/.test(data.target) && data.pClass == 'invisible'): 	return "Estop"; break;
		case (/^FAULT_/.test(data.target) && data.pClass == 'red'):			return ""; break;
	}//sw
	return '';
}//fn

setInterval( ()=>{
	//console.log(fault_store1);

},6000);

