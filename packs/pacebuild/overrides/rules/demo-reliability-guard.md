# Demo Reliability Guard

Bu proje 3-4 hafta içinde canlı yatırımcı demosunda gösterilecek.
Aşağıdaki 4 pattern demo günü sessizce başarısızlığa yol açar.
Her PR'dan önce kontrol et.

## ANTİPATTERN 1 — Sessiz fallback (EN KRİTİK)
```typescript
// YANLIŞ — backend ölüyse bile "çalışıyor" görünür
const data = await fetchFromBackend().catch(() => MOCK_DATA);

// DOĞRU — durum görünür olmalı
const result = await fetchFromBackend().catch(() => null);
if (!result) {
  return <StatusBadge status="BAĞLANTI YOK — örnek veri" />;
}
```

(Geçmiş: page.tsx'te tam bu pattern vardı — PACE-26 yorum)

## ANTİPATTERN 2 — Yutulmuş hata
```python
# YANLIŞ
except Exception:
    pass

# DOĞRU — en azından logla
except Exception as e:
    logger.error(f"[PACE-XX] {e}")
    raise
```

## ANTİPATTERN 3 — Hardcoded "servis hazır" varsayımı
```python
# YANLIŞ — DB henüz hazır olmayabilir
conn = psycopg2.connect(DB_URL)  # retry yok

# DOĞRU — en az basit retry
for attempt in range(5):
    try:
        conn = psycopg2.connect(DB_URL); break
    except Exception:
        time.sleep(2)
```

## ANTİPATTERN 4 — Test edilmemiş unhappy path
Stream koparsa ne olur? Kamera sinyali giderse? Model yüklenemezse?  
→ Fix etmek zorunda değilsin. Ama davranışı NAME et:  
  PR açıklamasına yaz: "Stream koparsa: [ne olur / placeholder mı / crash mı]"  
  Demo günü sürpriz olmasın.

## PR kontrol listesi
- [ ] Sessiz fallback yok (veya varsa görünür durum göstergesiyle)
- [ ] try/except'lerde logger.error + raise var
- [ ] Servis bağlantısında retry/timeout var
- [ ] Unhappy path davranışı PR açıklamasında belgelenmiş
