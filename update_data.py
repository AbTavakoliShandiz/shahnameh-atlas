#!/usr/bin/env python3
"""
هر بار که دیتابیس را در DB Browser for SQLite ویرایش کردید، این اسکریپت را اجرا کنید.

اجرا:
    python3 update_data.py Shahnameh_Atlas.db

این اسکریپت دو کار می‌کند:
  ۱) یک نسخه‌ی «بهینه‌شده برای httpvfs» از دیتابیس می‌سازد (اندیس‌های لازم +
     اندازه‌ی صفحه‌ی کوچک‌تر برای درخواست‌های Range کاراتر) و آن را به‌جای
     Shahnameh_Atlas.db در همین پوشه می‌گذارد.
  ۲) stats-data.js را بازسازی می‌کند (آمار سبک، برای صفحه‌ی اصلی/فوتر).

⚠️ نکته‌ی مهم: فایل Shahnameh_Atlas.db تولیدشده را **در Cloudflare Pages آپلود نکنید.**
Cloudflare Pages هنوز از HTTP Range Requests (206 Partial Content) پشتیبانی
نمی‌کند (باگ شناخته‌شده‌ی خودشان)، و بدون آن sql.js-httpvfs کار نمی‌کند.
این فایل را باید جداگانه در یک باکت Cloudflare R2 آپلود کنید (که Range را
درست پشتیبانی می‌کند) — توضیح کامل مراحل در README.md، بخش «هاست دیتابیس
روی R2» آمده. بقیه‌ی فایل‌های سایت (html/js/css) همچنان مثل قبل در
Cloudflare Pages می‌روند — فقط این یک فایل جای دیگری میزبانی می‌شود.
"""
import sys
import json
import shutil
import sqlite3
import pathlib

PUBLIC_EDITION = "M"

# اندیس‌هایی که برای کوئری‌های اصلی اطلس لازم‌اند (بدون این‌ها httpvfs مجبور
# می‌شود کل جدول را بخواند). هرکدام اگر جدول/ستونش نبود، بی‌خطر رد می‌شود.
INDEXES = [
    ("idx_beyts_edition", "core_beyts", "edition"),
    ("idx_beyts_section", "core_beyts", "section_code"),
    ("idx_beyts_era", "core_beyts", "era_id"),
    ("idx_events_beyt", "know_beyt_events", "beyt_code"),
    ("idx_events_actor", "know_beyt_events", "actor_entity_id"),
    ("idx_events_target", "know_beyt_events", "target_entity_id"),
    ("idx_entrel_source", "know_entity_relations", "source_entity_id"),
    ("idx_entrel_target", "know_entity_relations", "target_entity_id"),
    ("idx_evrel_source", "know_event_relations", "source_event_id"),
    ("idx_evrel_target", "know_event_relations", "target_event_id"),
    ("idx_beytconcepts_concept", "know_beyt_concepts", "concept_id"),
    ("idx_beytconcepts_beyt", "know_beyt_concepts", "beyt_code"),
    ("idx_beytentities_entity", "know_beyt_entities", "entity_id"),
    ("idx_beytentities_beyt", "know_beyt_entities", "beyt_code"),
    ("idx_pageimages_lookup", "core_page_images", "edition, volume, page_number"),
    ("idx_meanings_beyt", "core_beyt_meanings", "beyt_code"),
    ("idx_audiots_beyt", "core_beyt_audio_timestamps", "beyt_code"),
]

def optimize_for_httpvfs(db_path: pathlib.Path):
    con = sqlite3.connect(str(db_path), isolation_level=None)  # autocommit، برای VACUUM لازم است
    cur = con.cursor()

    added, skipped = 0, 0
    for name, table, cols in INDEXES:
        try:
            cur.execute(f"CREATE INDEX IF NOT EXISTS {name} ON {table} ({cols})")
            added += 1
        except sqlite3.OperationalError:
            skipped += 1  # جدول/ستون هنوز وجود ندارد — طبیعی است

    # اندازه‌ی صفحه‌ی کوچک‌تر یعنی هر درخواست Range داده‌ی کمتری برمی‌گرداند
    # (به توصیه‌ی مستندات sql.js-httpvfs). تغییر page_size فقط با VACUUM اعمال می‌شود.
    cur.execute("PRAGMA journal_mode = DELETE")
    cur.execute("PRAGMA page_size = 1024")
    cur.execute("VACUUM")
    con.close()
    return added, skipped

def main():
    if len(sys.argv) != 2:
        print("استفاده: python3 update_data.py path/to/YourDatabase.db")
        sys.exit(1)

    src = pathlib.Path(sys.argv[1])
    if not src.exists():
        print(f"فایل پیدا نشد: {src}")
        sys.exit(1)

    here = pathlib.Path(__file__).parent
    dest = here / "Shahnameh_Atlas.db"

    # روی یک نسخه‌ی کپی کار می‌کنیم تا فایل اصلی شما دست‌نخورده بماند
    shutil.copy2(src, dest)
    added, skipped = optimize_for_httpvfs(dest)

    # --- stats-data.js (بدون تغییر نسبت به قبل) ---
    con = sqlite3.connect(str(dest))
    cur = con.cursor()

    def count(table):
        try:
            cur.execute(f"SELECT COUNT(*) FROM {table}")
            return cur.fetchone()[0]
        except sqlite3.OperationalError:
            return 0

    def scalar(sql, default=0):
        try:
            cur.execute(sql)
            r = cur.fetchone()
            return r[0] if r and r[0] is not None else default
        except sqlite3.OperationalError:
            return default

    beyts_m = scalar(f"SELECT COUNT(*) FROM core_beyts WHERE edition='{PUBLIC_EDITION}'")
    events_m = scalar(f"""
        SELECT COUNT(*) FROM know_beyt_events be
        JOIN core_beyts cb ON cb.code = be.beyt_code AND cb.edition='{PUBLIC_EDITION}'
    """)
    beyt_entity_links_m = scalar(f"""
        SELECT COUNT(*) FROM know_beyt_entities be
        JOIN core_beyts cb ON cb.code = be.beyt_code AND cb.edition='{PUBLIC_EDITION}'
    """)
    beyt_concept_links_m = scalar(f"""
        SELECT COUNT(*) FROM know_beyt_concepts bc
        JOIN core_beyts cb ON cb.code = bc.beyt_code AND cb.edition='{PUBLIC_EDITION}'
    """)
    sections_total = count("core_sections")
    sections_with_data = scalar(f"""
        SELECT COUNT(DISTINCT section_code) FROM core_beyts
        WHERE edition='{PUBLIC_EDITION}' AND code IN (SELECT beyt_code FROM know_beyt_concepts)
    """)
    sections_progress_pct = round(
        (sections_with_data * 100.0 / sections_total) if sections_total else 0, 1
    )

    stats = {
        "public_edition": PUBLIC_EDITION,
        "beyts": beyts_m,
        "entities": count("know_entities"),
        "concepts": count("know_concepts"),
        "events": events_m,
        "entity_relations": count("know_entity_relations"),
        "event_relations": count("know_event_relations"),
        "sections": sections_total,
        "sections_with_data": sections_with_data,
        "sections_progress_pct": sections_progress_pct,
        "dynasties": count("core_dynasties"),
        "beyt_entity_links": beyt_entity_links_m,
        "beyt_concept_links": beyt_concept_links_m,
        "audio_clips": count("core_audio_files"),
        "alternate_meanings": count("core_beyt_meanings"),
        "articles": count("res_articles"),
    }
    con.close()
    (here / "stats-data.js").write_text(
        "const ATLAS_STATS = " + json.dumps(stats, ensure_ascii=False) + ";",
        encoding="utf-8",
    )

    db_size_mb = dest.stat().st_size / (1024*1024)
    print(f"Shahnameh_Atlas.db بهینه‌سازی شد ({db_size_mb:.1f} مگابایت) — {added} اندیس ساخته شد، {skipped} مورد رد شد (طبیعی).")
    print(f"stats-data.js بازسازی شد.")
    print(f"وضعیت فعلی (فقط نسخه‌ی {PUBLIC_EDITION}): {stats}")
    if beyts_m == 0:
        print("\n⚠️  هشدار: صفر بیت با edition='M' در این دیتابیس یافت شد.")
        print("   یعنی سایت عمومی فعلاً هیچ بیتی نشان نمی‌دهد.")

if __name__ == "__main__":
    main()
