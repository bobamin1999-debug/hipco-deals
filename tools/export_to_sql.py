"""Turn exported records (one JSON file per record, in folders named after the collection)
into seed.sql for Supabase -> SQL Editor. Existing records with the same id are replaced.

    python3 tools/export_to_sql.py <export_dir> seed.sql
    <export_dir>/deals/HIP-26073.json, <export_dir>/config/settings.json, <export_dir>/clients/unipak.json ...
"""
import json, pathlib, sys

def main(src, out):
    rows = []
    for f in sorted(pathlib.Path(src).glob("*/*.json")):
        doc = json.loads(f.read_text(encoding="utf-8"))
        data = doc.get("data", doc) if isinstance(doc, dict) and "data" in doc and "id" in doc else doc
        rows.append((f.parent.name, f.stem, data))
    def q(s):
        return "'" + s.replace("'", "''") + "'"
    lines = ["-- HIPCO Deals data import. Paste into Supabase -> SQL Editor -> Run.", "begin;"]
    for col, rid, data in rows:
        lines.append(f"insert into public.kv (col, id, data) values ({q(col)}, {q(rid)}, {q(json.dumps(data, ensure_ascii=False))}::jsonb)"
                     " on conflict (col, id) do update set data = excluded.data;")
    lines.append("commit;")
    lines.append(f"-- {len(rows)} records")
    pathlib.Path(out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"{len(rows)} records -> {out}")

if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
