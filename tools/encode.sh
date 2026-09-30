#!/bin/bash
# turn a 30fps PNG sequence into an mp4 that X accepts: encode.sh FRAME_DIR OUT.mp4
set -e
ffmpeg -v error -y -framerate 30 -i "$1/%05d.png" \
  -vf "scale=1920:1080:flags=lanczos:out_color_matrix=bt709:out_range=tv,format=yuv420p" \
  -c:v libx264 -profile:v high -crf 16 -preset slow -pix_fmt yuv420p -color_range tv -colorspace bt709 -color_primaries bt709 -color_trc bt709 -movflags +faststart "$2"
ffprobe -v error -select_streams v:0 -show_entries stream=pix_fmt,color_range,width,height,nb_frames -of csv=p=0 "$2"
