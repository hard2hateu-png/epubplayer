FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PORT=8000 POCKET_THREADS=2 HF_HOME=/srv/data/huggingface
WORKDIR /srv
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY app ./app
COPY server ./server
COPY build_patch_speed.py ./build_patch_speed.py
# Hugging Face's authenticated identity endpoint is /api/whoami-v2.
# Patch the standalone setup validator at image build time without touching TTS behavior.
RUN sed -i 's#https://huggingface.co/api/whoami#https://huggingface.co/api/whoami-v2#g' server/server.py
# Railway currently caps this service at ~1 GB RAM. Pocket TTS supports dynamic int8
# quantization for CPU inference; use it for both built-in and cloning-capable model loads.
RUN sed -i 's/TTSModel.load_model(config=str(LOCAL_CONFIG))/TTSModel.load_model(config=str(LOCAL_CONFIG), quantize=True)/g; s/TTSModel.load_model(language="english")/TTSModel.load_model(language="english", quantize=True)/g' server/server.py
# Voice-prompt encoding has a large transient memory spike. Keep a 15-second conditioning
# window on the 1 GB Railway service; this stays within Pocket TTS's recommended range.
RUN sed -i 's/SR \* 30/SR * 15/g' server/server.py
# Keep live PCM at 1x. Finished playback speed is generated server-side with FFmpeg atempo,
# so iPhone Safari never changes playbackRate and cannot raise the voice pitch.
RUN python build_patch_speed.py && rm build_patch_speed.py
RUN mkdir -p /srv/data/models /srv/data/out
CMD ["sh", "-c", "exec uvicorn server.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
