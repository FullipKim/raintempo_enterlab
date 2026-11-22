// 사용: node scripts/merge-rules.mjs <기존 규칙 파일> > firestore.rules
// 기존 규칙(홈페이지·쓸닥 등)의 마지막 두 닫는 괄호 앞에 rt_ 규칙을 끼워 넣는다. 이미 있으면 교체한다.
import fs from 'node:fs';
const base = fs.readFileSync(process.argv[2] || 'rules/site.rules', 'utf8');
const frag = fs.readFileSync(new URL('../firestore.rt.rules', import.meta.url), 'utf8').trimEnd();
const START = '// ───── 레인템포랩 내부 어드민 (rt_ 컬렉션) ─────', END = '// ───── 내부 어드민 끝 ─────';
let src = base;
const a = src.indexOf(START), b = src.indexOf(END);
if (a >= 0 && b > a) src = src.slice(0, src.lastIndexOf('\n', a) + 1) + src.slice(b + END.length + 1);
const m = src.match(/\}\s*\}\s*$/);
if (!m) throw new Error('규칙 끝(}}) 을 찾지 못했습니다');
process.stdout.write(src.slice(0, m.index).trimEnd() + '\n\n' + frag + '\n  }\n}\n');
