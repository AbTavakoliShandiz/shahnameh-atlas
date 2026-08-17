#!/usr/bin/env python3
"""
هر بار که دیتابیس را در DB Browser for SQLite ویرایش کردید، این اسکریپت را اجرا کنید.

اجرا:
    python3 update_data.py Shahnameh_Atlas.db

این اسکریپت سه کار می‌کند:
  ۱) یک نسخه‌ی «بهینه‌شده برای httpvfs» از دیتابیس می‌سازد (اندیس‌های لازم +
     اندازه‌ی صفحه‌ی کوچک‌تر برای درخواست‌های Range کاراتر).
  ۲) این فایل بهینه‌شده را به تکه‌های کوچک‌تر (chunk) می‌شکند — چون GitHub Pages
     پاسخ‌های HEAD را gzip می‌کند و این باعث می‌شود sql.js-httpvfs نتواند طول
     واقعی فایل را در «حالت full» تشخیص دهد (خطای «Length of the file not known»).
     راه‌حل رسمی خودِ کتابخانه دقیقاً همین «حالت chunked» است.
  ۳) stats-data.js و db-meta.js را بازسازی می‌کند.

⚠️ خروجی این اسکریپت چند فایل `Shahnameh_Atlas.db.0000`, `Shahnameh_Atlas.db.0001`, …
است، نه یک فایل تکی `Shahnameh_Atlas.db`. همه‌ی این فایل‌ها باید در ریپازیتوری
GitHub آپلود شوند (فایل تکی قدیمی دیگر توسط سایت خوانده نمی‌شود).
"""
import sys
import json
import shutil
import sqlite3
import pathlib
import hashlib

PUBLIC_EDITION = "M"
SERVER_CHUNK_SIZE = 90 * 1024 * 1024  # ۹۰ مگابایت — عمداً خیلی بزرگ‌تر از هر پایگاه‌داده‌ی واقعی این
# پروژه (سقف GitHub Pages برای هر فایل، ۱۰۰ مگابایت است). دلیل این‌که "chunk" هنوز
# لازم است (حتی وقتی همیشه فقط یک تکه تولید می‌شود): این تنها راه است که از باگ
# gzip/HEAD گیت‌هاب (سرگذشتش در README) دور بزنیم بدون افتادن در باگ دیگری از خودِ
# کتابخانه — وقتی یک خواندن (read) از مرز بین دو تکه رد شود، sql.js-httpvfs
# نسخه‌ی ۰.۸.۱۲ داده را به‌جای خطا دادن، بی‌صدا کوتاه می‌کند (چون فرمول محاسبه‌ی
# URL فقط بایت شروع را می‌بیند، نه پایان). با یک‌تکه‌ای‌کردن عملی فایل (چون حجم
# پروژه از ۹۰ مگابایت کمتر است)، اصلاً مرزی برای رد شدن باقی نمی‌ماند.
SUFFIX_LENGTH = 4  # تا ۹۹۹۹ تکه (چند ده گیگابایت) پشتیبانی می‌شود

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

def split_into_chunks(db_path: pathlib.Path, out_dir: pathlib.Path, prefix: str):
    """
    فایل بهینه‌شده را به تکه‌های SERVER_CHUNK_SIZE بایتی می‌شکند، با نام‌گذاری
    prefix + شماره‌ی صفرپرشده (مثل Shahnameh_Atlas.db.0000) — دقیقاً همان قراردادی
    که sql.js-httpvfs در «حالت chunked» انتظار دارد. تکه‌های قبلی (اگر مانده باشند) پاک می‌شوند.
    """
    for old in out_dir.glob(f"{prefix}.[0-9][0-9][0-9][0-9]"):
        old.unlink()

    total_bytes = db_path.stat().st_size
    chunk_count = 0
    with open(db_path, "rb") as f:
        while True:
            data = f.read(SERVER_CHUNK_SIZE)
            if not data:
                break
            chunk_name = f"{prefix}.{str(chunk_count).zfill(SUFFIX_LENGTH)}"
            (out_dir / chunk_name).write_bytes(data)
            chunk_count += 1
    return total_bytes, chunk_count

def main():
    if len(sys.argv) != 2:
        print("استفاده: python3 update_data.py path/to/YourDatabase.db")
        sys.exit(1)

    src = pathlib.Path(sys.argv[1])
    if not src.exists():
        print(f"فایل پیدا نشد: {src}")
        sys.exit(1)

    here = pathlib.Path(__file__).parent
    optimized = here / "_optimized_tmp.db"  # فایل موقت، فقط برای ساخت تکه‌ها؛ در ریپازیتوری آپلود نمی‌شود

    # روی یک نسخه‌ی کپی کار می‌کنیم تا فایل اصلی شما دست‌نخورده بماند
    shutil.copy2(src, optimized)
    added, skipped = optimize_for_httpvfs(optimized)

    db_prefix = "Shahnameh_Atlas.db"
    total_bytes, chunk_count = split_into_chunks(optimized, here, db_prefix)

    # هش محتوا برای cache-bust — چون ممکن است فایلی مثل Shahnameh_Atlas.db.0000
    # از نسخه‌ی قبلی (با محتوای کاملاً متفاوت) در کش مرورگر یا CDN گیت‌هاب مانده
    # باشد. با تغییر این مقدار در هر آپدیت، httpvfs مجبور می‌شود نسخه‌ی تازه را
    # بخواهد، نه نسخه‌ی کش‌شده‌ی قدیمی با همان نام فایل.
    content_hash = hashlib.sha256(optimized.read_bytes()).hexdigest()[:12]

    (here / "db-meta.js").write_text(
        f"const DB_LENGTH_BYTES = {total_bytes};\n"
        f"const DB_URL_PREFIX = {json.dumps(db_prefix + '.')};\n"
        f"const DB_SERVER_CHUNK_SIZE = {SERVER_CHUNK_SIZE};\n"
        f"const DB_SUFFIX_LENGTH = {SUFFIX_LENGTH};\n"
        f"const DB_CACHE_BUST = {json.dumps(content_hash)};\n",
        encoding="utf-8",
    )

    # --- stats-data.js (بدون تغییر نسبت به قبل) ---
    con = sqlite3.connect(str(optimized))
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

    optimized_size_mb = total_bytes / (1024*1024)
    optimized.unlink()  # فایل موقت را پاک می‌کنیم؛ فقط تکه‌ها می‌مانند

    print(f"دیتابیس بهینه و تکه‌تکه شد: {chunk_count} فایل، مجموعاً {optimized_size_mb:.1f} مگابایت")
    print(f"({added} اندیس ساخته شد، {skipped} مورد رد شد — طبیعی است.)")
    print(f"stats-data.js و db-meta.js بازسازی شدند.")
    print(f"وضعیت فعلی (فقط نسخه‌ی {PUBLIC_EDITION}): {stats}")
    if beyts_m == 0:
        print("\n⚠️  هشدار: صفر بیت با edition='M' در این دیتابیس یافت شد.")
        print("   یعنی سایت عمومی فعلاً هیچ بیتی نشان نمی‌دهد.")
    print(f"\n📦 فایل‌هایی که باید در گیت‌هاب آپلود کنید: {db_prefix}.0000 تا {db_prefix}.{str(chunk_count-1).zfill(SUFFIX_LENGTH)}، به‌علاوه‌ی db-meta.js و stats-data.js")

if __name__ == "__main__":
    main()
