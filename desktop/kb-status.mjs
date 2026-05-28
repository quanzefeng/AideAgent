import * as kbs from './knowledge-store.mjs';
const status = kbs.getStatus();
console.log('=== 知识库状态 ===');
console.log(JSON.stringify(status, null, 2));

if (status.noteCount > 0) {
  console.log('\n=== 笔记列表 ===');
  const list = kbs.listNotes(0, 50);
  console.log(`总计: ${list.total} 篇笔记`);
  for (const n of list.notes) {
    console.log(`  - [${n.id}] ${n.title} (${n.rel_path})`);
  }
}
