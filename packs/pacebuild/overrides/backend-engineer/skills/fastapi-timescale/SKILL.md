---
name: fastapi-timescale-patterns
description: Backend (FastAPI + TimescaleDB) değişikliklerinde pattern rehberi
triggers:
  - backend task
  - fastapi
  - timescaledb
  - database
  - api endpoint
always: false
---

# FastAPI + TimescaleDB Patterns

## PATTERN 1 — Hypertable iddiasını doğrula
"TimescaleDB kullanıyoruz" demeden önce:
→ `create_hypertable()` çağrısı bir migration/init script'te var mı?
→ Yoksa sistem düz PostgreSQL'dir. Bunu açıkça belirt, yanlış iddiayla devam etme.
(Geçmiş: hypertable yok, models.py'dan kaldırılmış, düz PG — PACE-9)

## PATTERN 2 — Healthcheck + bağımlılık sırası
docker-compose.yml'de `depends_on` var ama `condition: service_healthy` yok mu?
→ Ekle. Yoksa backend DB hazır değilken başlar, bağlantı hatası alır.
Minimum healthcheck:
```yaml
healthcheck:
  test: ["CMD-SHELL", "pg_isready -U $$POSTGRES_USER -d $$POSTGRES_DB"]
  interval: 5s
  timeout: 5s
  retries: 5
```

## PATTERN 3 — Event şemasına uy, kırma
Mevcut `/api/v1/events` şeması: timestamp, camera_id, class_name, confidence,  
bbox_json, track_id, worker_count, vehicle_count.  
Yeni alan ekliyorsan: şemayı GENIŞLET, var olanı değiştirme/silme.  
Frontend ve cv-engine bu şemayı biliyor — kırarsan her yer kırılır.

## PATTERN 4 — site_id / camera_id her yeni tabloda
İleride çoklu kamera desteği planlanıyor (PACE-9 notu).  
Yeni tablo/model oluştururken bu alanları baştan ekle.  
Sonradan eklemek = migration + geçmiş veri maliyeti.

## PATTERN 5 — Silent error yasak
```python
# YANLIŞ — demo güvenilirliği öldürür
try:
    db.add(event); db.commit()
except Exception:
    pass  # sessiz yutma

# DOĞRU
try:
    db.add(event); db.commit()
except Exception as e:
    logger.error(f"Event write failed: {e}")
    raise  # veya HTTP 500 dön
```

## Bitişte doğrula
- [ ] Hypertable durumu netleştirildi (var/yok belirtildi)
- [ ] Healthcheck docker-compose'da mevcut
- [ ] Event şeması kırılmadı
- [ ] site_id/camera_id yeni tablolarda var
- [ ] try/except bloklarında error log mevcut
