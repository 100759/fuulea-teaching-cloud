#!/usr/bin/env node
// 只读：扫描各班级「教师」区，输出 班级 -> [{role,name,subject}]
// 用法: node scan_class_teachers.js <classes.jsonl> <out.jsonl> [--settle ms]
// classes.jsonl 每行: {"class":"2024级9班","classId":"591219"}
'use strict';
const fs = require('fs');
const { Session } = require(__dirname + '/session.js');
const { BASE } = require(__dirname + '/login.js');

function arg(n, d) { const i = process.argv.indexOf('--' + n); return i === -1 ? d : process.argv[i + 1]; }
const [inPath, outPath] = process.argv.slice(2, 4);
if (!inPath || !outPath) { console.error('用法: node scan_class_teachers.js <classes.jsonl> <out.jsonl>'); process.exit(2); }
const SETTLE = Number(arg('settle', 2200)) || 2200;

const classes = fs.readFileSync(inPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));

const INJECT = `
window.__ft = { text: () => { const m=(document.body.innerText||'').match(/教师\\n([\\s\\S]*?)\\n学生/); return m?m[1]:''; } };
'ok';
`;

function parseTeachers(text) {
  const lines = text.split('\n').map(s => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === '师' || lines[i] === '主') {
      const name = lines[i + 1] || '';
      const subject = lines[i + 2] || '';
      if (name && !/^(师|主|添加)/.test(name)) out.push({ role: lines[i] === '主' ? '班主任' : '教师', name, subject });
      i += 2;
    }
  }
  return out;
}

(async () => {
  const S = new Session();
  const res = [];
  for (const c of classes) {
    await S.goto(`${BASE}/classroom/${c.classId}`, { settle: SETTLE });
    await S.ev(INJECT);
    const text = (await S.val('window.__ft.text()')) || '';
    const teachers = parseTeachers(text);
    res.push({ class: c.class, classId: c.classId, n: teachers.length, teachers, raw: text.replace(/\n+/g, '|') });
    console.log(`${c.class}: ${teachers.map(t => `${t.name}(${t.subject}${t.role === '班主任' ? ',主' : ''})`).join(' ')}`);
  }
  fs.writeFileSync(outPath, res.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log('\n写入', outPath);
  process.exit(0);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
