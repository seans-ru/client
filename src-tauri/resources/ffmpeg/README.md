# Optional ffmpeg (clip export, issue #14)

Клипы (A→B) экспортируются через **ffmpeg** без перекодирования (`-c copy`,
видео + звук). Бинарник **опционален** и по умолчанию не поставляется.

Положите сюда `ffmpeg.exe` (Windows) или `ffmpeg` (macOS/Linux) перед
`tauri build`, и он попадёт в установку:

```
seans.exe
ffmpeg/ffmpeg.exe      ← сюда
mpv/libmpv-2.dll
```

Порядок поиска в рантайме (`capture.rs::resolve_ffmpeg`):

1. `<resource_dir>/ffmpeg/ffmpeg.exe` (эта папка после бандла),
2. `<resource_dir>/ffmpeg.exe`,
3. рядом с `seans.exe`,
4. `PATH`.

Нет ffmpeg → экспорт клипа честно сообщает «ffmpeg не найден» и предлагает
сохранить кадры начала/конца через mpv (`screenshot-to-file`). Скриншоты
работают и без ffmpeg.

Не коммитьте бинарник (см. корневой `.gitignore`).
