FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY requirements.lock ./
RUN pip install --no-cache-dir --require-hashes -r requirements.lock && useradd --uid 10001 --create-home app
COPY shared ./shared
COPY services/auth ./services/auth
USER app
EXPOSE 8000
CMD ["uvicorn", "services.auth.app.main:app", "--host", "0.0.0.0", "--port", "8000"]
