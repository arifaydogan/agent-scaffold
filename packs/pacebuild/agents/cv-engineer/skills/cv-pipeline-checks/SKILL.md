---
name: cv-pipeline-checks
description: cv-engine değişikliklerinde zorunlu kontrol listesi
triggers:
  - cv-engine task
  - tracking
  - bbox
  - bytetrack
  - model.track
always: false
---

# CV Pipeline Checks

cv-engine dosyasına dokunmadan önce bu 4 kontrolü yap. Geç değil, şimdi.

## KONTROL 1 — Tracker config var mı?
`model.track()` çağrısı bir config dosyasına referans veriyor mu?
→ O dosyanın repoda GERÇEKTEN var olduğunu doğrula.
→ Yoksa: Ultralytics default tracker kullan VEYA dosyayı oluştur.
→ ASLA "zaten vardır" varsayma. (Geçmiş: bytetrack.yaml yoktu, runtime çöktü — PACE-7)

## KONTROL 2 — Koordinat sistemi tutarlı mı?
| Fonksiyon | Beklediği |
|---|---|
| cv2.rectangle, draw_detection_overlay | PİKSEL (0..width, 0..height) |
| /api/v1/events bbox_json | NORMALİZE (0.0..1.0) |
İkisini karıştırma. Her bbox kullanımında hangisi olduğunu kontrol et.
(Geçmiş: normalize → draw fn gönderildi, kutular hatalı çizildi — PACE-7)

## KONTROL 3 — Track ID kalıcı mı?
model.track() her frame'de aynı nesneye aynı ID veriyor mu?
→ model() (detect) ile model.track() farkını bil. Detect = her frame yeni ID.
→ track_id set'ten sayım yapılıyorsa, ID'lerin persist ettiğini doğrula.

## KONTROL 4 — Event gönderimi dedup'lı mı?
Her frame'de ayrı POST gidiyorsa → backend'de overcounting riski var.
Bu task'ın kapsamına dedup girmiyorsa: mevcut davranışı BOZMA, sadece belgele.
(Geçmiş: frame-level POST + dedup yok = PACE-18 kök nedeni)

## Bitişte doğrula
- [ ] bytetrack.yaml (veya seçilen config) repoda var
- [ ] bbox: draw = piksel, POST = normalize — ayrı tutuldu
- [ ] track_id persistence test edildi
- [ ] event POST davranışı değişmediyse veya dedup eklendiyse belgelenmiş
