import sqlite3
import sys
import io

# Force UTF-8 output
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

db_path = r'C:\Users\7\.goodagent\knowledge.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Search for Claude Code related notes
cursor.execute("""
    SELECT id, title, rel_path, word_count 
    FROM kb_notes 
    WHERE title LIKE '%Claude%' OR title LIKE '%claude%' OR rel_path LIKE '%claude%'
""")
rows = cursor.fetchall()

output = []
output.append(f"Found {len(rows)} Claude Code related notes\n")

for row in rows:
    note_id, title, rel_path, word_count = row
    output.append(f"=== ID: {note_id} | Title: {title} | Path: {rel_path} | Words: {word_count} ===")
    
    # Try to get full content from kb_fts using rel_path
    cursor.execute("SELECT body FROM kb_fts WHERE rel_path = ?", (rel_path,))
    content_row = cursor.fetchone()
    if content_row and content_row[0]:
        output.append(content_row[0])
    else:
        # Try by rowid
        cursor.execute("SELECT body FROM kb_fts WHERE rowid = ?", (note_id,))
        content_row = cursor.fetchone()
        if content_row and content_row[0]:
            output.append(content_row[0])
        else:
            output.append("[No content found in kb_fts]")
    
    output.append("\n" + "="*80 + "\n")

conn.close()

# Write to file
result = "\n".join(output)
with open(r'D:\GoodAgent\desktop\kb_claude_code.txt', 'w', encoding='utf-8') as f:
    f.write(result)

print(f"Written {len(result)} chars to kb_claude_code.txt")
