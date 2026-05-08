#!/bin/bash
source "../../../../emsdk/emsdk_env.sh"
SRC="main.cpp ../../libs/stb_vorbis/stb_vorbis.c ../../libs/tinf/tinflate.c"
PROJ="OpenLara_wasm"
FLAGS="-s WASM=1 -g -O3 -ffast-math -std=c++11 -s ALLOW_MEMORY_GROWTH=1 -s USE_WEBGL2=1 -Wall -I../../"
em++ $SRC $FLAGS -s EXPORTED_RUNTIME_METHODS="['ccall','getValue','writeArrayToMemory']" -s EXPORTED_FUNCTIONS="['_main', '_malloc', '_free']" -o $PROJ.js \
    --preload-file ./level/1/TITLE.PSX \
    --preload-file ./level/1/GYM.PSX \
    --preload-file ./level/1/LEVEL1.PSX \
    --preload-file ./audio/1/dummy \
    --preload-file ./audio/2/dummy \
    --preload-file ./audio/3/dummy \
    --preload-file ./level/2/dummy \
    --preload-file ./level/3/dummy
# gzip -9 -f $PROJ.data $PROJ.js
