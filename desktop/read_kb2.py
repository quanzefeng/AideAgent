import sqlite3

db_path = r'C:\Users\7\.goodagent\knowledge.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Search for Claude Code related notes in kb_notes
cursor.execute("""
    SELECT id, title, rel_path, word_count 
    FROM kb_notes 
    WHERE title LIKE '%Claude%' OR title LIKE '%claude%' OR rel_path LIKE '%claude%'
""")
rows = cursor.fetchall()
print(f"Found {len(rows)} Claude Code related notes\n")

for row in rows:
    note_id, title, rel_path, word_count = row
    print(f"=== ID: {note_id} | Title: {title} | Path: {rel_path} | Words: {word_count} ===")
    
    # Get full content from kb_fts
    cursor.execute("SELECT body FROM kb_fts WHERE rowid = ?", (note_id,))
    content_row = cursor.fetchone()
    if content_row and content_row[0]:
        print(content_row[0])
    else:
        # Try alternative: match by rel_path
        cursor.execute("SELECT body FROM kb_fts WHERE rel_path = ?", (rel_path,))
        content_row = cursor.fetchone()
        if content_row and content_row[0]:
            print(content_row[0])
        else:
            print("[No content found in kb_fts]")
    print("\n" + "="*80 + "\n")

conn.close()
