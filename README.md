# plcSockSrv
PLC  SocketServer  for A/B SLC-500 and compactLogix using LLD libplctag  

plcSockSrv lets you talk to an A/B PLC using simple read/write commands to a OS port.  
# Example:    
  bash  
  $ echo "R,PCDATA[0],10;" | nc -q1 localhost 9002 ; echo  
   
  response:  
  ROK:PCDATA[0]=0,0,0,1,0,128,446,767,976,0;  

# Design
  It is designed to only read/write data type:  
   DINT from CompactLogix or  
   INT from N12/N25/etc file registry for SLC-500.  
     
It will not read UDT or other complex data structures.  
The design is simple becuase most PLC control can be accomplished using DINT/INT talk.  
  
# 'libplctag' install instructions:
cat install_libplctag.sh  
  
## 1. Install build tools (one-time)
sudo apt-get update  
sudo apt-get install build-essential cmake git  
  
## 2. Clone and build libplctag
git clone https://github.com/libplctag/libplctag.git\
cd libplctag\
mkdir build\
cd build\
cmake .. -DCMAKE_BUILD_TYPE=Release  
make  
sudo make install  
sudo ldconfig  

## 3. Verify  
ldconfig -p | grep libplctag  
Output: libplctag.so.2 (libc6,x86-64) => /usr/local/lib/libplctag.so.2

## 4. Test compilation  
cd ~  
cat > test.c << 'EOF'  
#include <stdio.h>  
#include <plctag.h>  
int main() {  
    printf("libplctag version: %s\n", plc_tag_get_version());  
    return 0;  
}  
EOF  

gcc test.c -o test -lplctag  

./test  
Output: libplctag version: 2.6.14

# Compile command  
gcc lgxSockSrv_rev4c.c -o  lgxSockSrv_rev4c -I/usr/local/include -L/usr/local/lib -lplctag  
rm ./plcSockSrv  
ln -s lgxSockSrv_rev4c plcSockSrv  

# Some app. code files   
  1) lgxSockSrv_rev4c.c  
  2) slcSockSrv_rev2g.c  
  3) plc_lib_chook.js   hooks the plcSockSrv into javascript  
  4) plcSockSrv_ex_01.js   using above chook

