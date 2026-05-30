import sqlite3
import os
from collections import Counter

db_path = r'C:\Users\7\.goodagent\knowledge.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Get all notes with title, path, and tags
cursor.execute("SELECT id, title, rel_path, tags, word_count FROM kb_notes")
notes = cursor.fetchall()

print(f"Total notes: {len(notes)}\n")

# Display all notes
print("=== All Notes ===")
for note in notes:
    note_id, title, rel_path, tags, word_count = note
    print(f"ID: {note_id}, Title: {title[:60]}{'...' if len(title) > 60 else ''}")
    print(f"   Path: {rel_path}")
    print(f"   Tags: {tags or 'None'}")
    print(f"   Word count: {word_count}")
    print()

# Analyze by directory structure
print("\n=== Directory Structure Analysis ===")
path_counter = Counter()
for note in notes:
    rel_path = note[2]
    if rel_path:
        # Extract top-level directory
        parts = rel_path.split('/')
        if len(parts) > 1:
            top_dir = parts[0]
            path_counter[top_dir] += 1

print("Top-level directories:")
for directory, count in path_counter.most_common():
    print(f"  {directory}: {count} notes")

# Analyze tags
print("\n=== Tag Analysis ===")
tag_counter = Counter()
for note in notes:
    tags = note[3]
    if tags:
        # Split comma-separated tags
        for tag in tags.split(','):
            tag = tag.strip()
            if tag:
                tag_counter[tag] += 1

print("Most common tags:")
for tag, count in tag_counter.most_common(10):
    print(f"  {tag}: {count} notes")

# Search for Claude-related notes (as seen in kb_claude_code.txt)
print("\n=== Claude Code Related Notes ===")
cursor.execute("SELECT id, title, rel_path FROM kb_notes WHERE title LIKE '%Claude%' OR title LIKE '%claude%' OR rel_path LIKE '%claude%'")
claude_notes = cursor.fetchall()
print(f"Found {len(claude_notes)} Claude-related notes:")
for note in claude_notes:
    print(f"  ID: {note[0]}, Title: {note[1]}, Path: {note[2]}")

conn.close()