import sqlite3

db_path = r'C:\Users\7\.goodagent\knowledge.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Find all Claude Code related notes
cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
tables = cursor.fetchall()
print("Tables:", tables)

# Try to find Claude Code content
for table_name in [t[0] for t in tables]:
    try:
        cursor.execute(f"PRAGMA table_info({table_name})")
        cols = [c[1] for c in cursor.fetchall()]
        print(f"\nTable '{table_name}' columns: {cols}")
        
        if 'title' in cols and 'content' in cols:
            cursor.execute(f"SELECT id, title, path FROM {table_name} WHERE title LIKE '%Claude%' OR title LIKE '%claude%' OR path LIKE '%claude%'")
            rows = cursor.fetchall()
            print(f"  Claude Code related rows: {len(rows)}")
            for row in rows:
                print(f"    ID: {row[0]}, Title: {row[1]}, Path: {row[2]}")
                
                # Get full content
                cursor.execute(f"SELECT content FROM {table_name} WHERE id = ?", (row[0],))
                content = cursor.fetchone()
                if content:
                    print(f"    Content length: {len(content[0])} chars")
                    print(f"    Content preview: {content[0][:200]}...")
                    print("    --- FULL CONTENT ---")
                    print(content[0])
                    print("    --- END CONTENT ---")
    except Exception as e:
        print(f"  Error with table {table_name}: {e}")

conn.close()
