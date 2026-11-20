import fs from 'node:fs';
fs.rmSync('dist', { recursive: true, force: true });
fs.mkdirSync('dist');
fs.copyFileSync('index.html', 'dist/index.html');
fs.copyFileSync('playgama-bridge-config.json', 'dist/playgama-bridge-config.json');
fs.cpSync('src', 'dist', { recursive: true });
console.log('build ok');
