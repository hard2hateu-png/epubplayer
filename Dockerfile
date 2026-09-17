FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PORT=8000 POCKET_THREADS=2 HF_HOME=/srv/data/huggingface
WORKDIR /srv
RUN pip install torch==2.8.0 --index-url https://download.pytorch.org/whl/cpu
COPY requirements.txt ./
RUN pip install -r requirements.txt
COPY app ./app
COPY server ./server
# Hugging Face's authenticated identity endpoint is /api/whoami-v2.
# Patch the standalone setup validator at image build time without touching TTS behavior.
RUN sed -i 's#https://huggingface.co/api/whoami#https://huggingface.co/api/whoami-v2#g' server/server.py
RUN mkdir -p /srv/data/models /srv/data/out
CMD ["sh", "-c", "exec uvicorn server.server:app --host 0.0.0.0 --port ${PORT:-8000}"]
