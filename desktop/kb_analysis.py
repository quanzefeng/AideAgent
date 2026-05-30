import sqlite3
from collections import Counter

db_path = r'C:\Users\7\.goodagent\knowledge.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get all notes
cursor.execute('SELECT id, title, rel_path, tags, word_count FROM kb_notes')
notes = cursor.fetchall()
print(f'Total notes: {len(notes)}')

# Directory structure
dir_counter = Counter()
dir_notes = {}
for note in notes:
    rel_path = note[2]
    if rel_path:
        parts = rel_path.split('/')
        if len(parts) > 1:
            top_dir = parts[0]
            dir_counter[top_dir] += 1
            if top_dir not in dir_notes:
                dir_notes[top_dir] = []
            dir_notes[top_dir].append((note[0], note[1], rel_path))

print('\n=== Top-Level Directories ===')
for d, c in dir_counter.most_common():
    print(f'  {d}: {c} notes')

# Tags
tag_counter = Counter()
for note in notes:
    tags = note[3]
    if tags:
        for tag in tags.split(','):
            tag = tag.strip()
            if tag:
                tag_counter[tag] += 1
print('\n=== Top Tags ===')
for tag, c in tag_counter.most_common(20):
    print(f'  {tag}: {c}')

# Show notes per directory
print('\n=== Notes by Directory ===')
for d, c in dir_counter.most_common():
    print(f'\n--- {d} ({c} notes) ---')
    for nid, title, path in dir_notes[d]:
        title_short = title[:80]
        print(f'  [{nid}] {title_short}')
        print(f'        {path}')

conn.close()
