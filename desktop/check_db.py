import sqlite3
import os

db_path = r'C:\Users\7\.goodagent\knowledge.db'
if not os.path.exists(db_path):
    print('Database file not found:', db_path)
else:
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # Get all tables
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = cursor.fetchall()
    print('Tables:', [t[0] for t in tables])
    
    # For each table, show schema and record count
    for table in tables:
        table_name = table[0]
        print(f'\n--- Table: {table_name} ---')
        
        # Get table info
        cursor.execute(f'PRAGMA table_info({table_name})')
        columns = cursor.fetchall()
        print('Columns:')
        for col in columns:
            print(f'  {col[1]} ({col[2]})')
        
        # Get record count
        cursor.execute(f'SELECT COUNT(*) FROM {table_name}')
        count = cursor.fetchone()[0]
        print(f'Record count: {count}')
        
        # Sample data if has title/content columns
        if count > 0:
            # Check for common columns
            col_names = [col[1] for col in columns]
            if 'title' in col_names and 'path' in col_names:
                cursor.execute(f'SELECT id, title, path FROM {table_name} LIMIT 3')
                rows = cursor.fetchall()
                print('Sample records:')
                for row in rows:
                    print(f'  ID: {row[0]}, Title: {row[1][:50]}..., Path: {row[2]}')
    
    conn.close()