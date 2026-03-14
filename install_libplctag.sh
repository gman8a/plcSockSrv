# 1. Install build tools (one-time)
sudo apt-get update
sudo apt-get install build-essential cmake git

# 2. Clone and build libplctag
git clone https://github.com/libplctag/libplctag.git
cd libplctag
mkdir build
cd build
cmake .. -DCMAKE_BUILD_TYPE=Release
make
sudo make install
sudo ldconfig

# 3. Verify
ldconfig -p | grep libplctag
# Output: libplctag.so.2 (libc6,x86-64) => /usr/local/lib/libplctag.so.2

# 4. Test compilation
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
# Output: libplctag version: 2.6.14

