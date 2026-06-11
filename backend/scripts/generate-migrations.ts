import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

// ESM 模块中获取 __dirname 的替代方案
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 添加 IF NOT EXISTS 到各种 SQL 语句
function addIfNotExists(sql: string): string {
  return sql
    // 处理 CREATE TABLE 语句
    .replace(/CREATE TABLE (`?\w+`?)/g, 'CREATE TABLE IF NOT EXISTS $1')
    // 处理 CREATE INDEX 语句
    .replace(/CREATE (UNIQUE )?INDEX (`?\w+`?)/g, 'CREATE $1INDEX IF NOT EXISTS $2')
    // 处理 DROP INDEX 语句
    .replace(/DROP INDEX (`?\w+`?)/g, 'DROP INDEX IF EXISTS $1');
}

// 生成迁移文件
async function generateMigrations() {
  const migrationsDir = path.join(__dirname, '..', 'drizzle');
  const outputFile = path.join(__dirname, '..', 'src', 'db', 'generated-migrations.ts');

  // 确保目录存在
  const outputDir = path.dirname(outputFile);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // 读取所有 SQL 文件
  const files = fs.readdirSync(migrationsDir)
    .filter(file => file.endsWith('.sql'))
    .sort();

  // 生成迁移数组
  const migrations = files.map(file => {
    const content = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    // 对每个 SQL 语句添加 IF NOT EXISTS
    const modifiedContent = content
      .split('--> statement-breakpoint')
      .map(stmt => addIfNotExists(stmt.trim()))
      .filter(stmt => stmt.length > 0)
      .join('\n--> statement-breakpoint\n');

    return {
      name: file,
      content: modifiedContent.replace(/`/g, '\\`') // 转义反引号
    };
  });

  // 生成 TypeScript 文件内容
  const fileContent = `// 此文件由 generate-migrations.ts 自动生成
// 请不要手动修改

export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
${migrations.map(m => `  {
    name: "${m.name}",
    sql: \`${m.content}\`
  }`).join(',\n')}
];
`;

  // 写入文件
  fs.writeFileSync(outputFile, fileContent, 'utf-8');
  console.log(`已生成迁移文件: ${outputFile}`);
}

generateMigrations().catch(console.error);
