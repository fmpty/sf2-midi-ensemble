/**
 * 本地静态服务：输出目录为 npm run build 生成的 www/
 * Web MIDI 需要安全上下文：默认 http://127.0.0.1 可用；手机同 WiFi 访问请用 --https
 */
const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const CERT_DIR = path.join(__dirname, '.certs');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.sf2': 'application/octet-stream',
    '.sf3': 'application/octet-stream',
    '.dls': 'application/octet-stream',
    '.sfogg': 'application/octet-stream',
    '.wasm': 'application/wasm',
};

function parseArgs() {
    const argv = process.argv.slice(2);
    let port = Number(process.env.PORT) || 8765;
    let host = '127.0.0.1';
    let httpsOn = false;
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--https') httpsOn = true;
        else if (a === '--lan' || a === '--host') host = '0.0.0.0';
        else if (a === '-p' || a === '--port') {
            port = Number(argv[++i]) || port;
        } else if (/^\d+$/.test(a)) port = Number(a);
    }
    return { port, host, httpsOn };
}

function ensureWww() {
    if (!fs.existsSync(path.join(WWW, 'index.html'))) {
        console.error('未找到 www/index.html，请先执行：npm run build');
        process.exit(1);
    }
}

function safePath(urlPath) {
    const decoded = decodeURIComponent(urlPath.split('?')[0]);
    const rel = decoded.replace(/^\/+/, '') || 'index.html';
    const abs = path.normalize(path.join(WWW, rel));
    if (!abs.startsWith(WWW)) return null;
    return abs;
}

function sendFile(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        'Content-Type': type,
        'Content-Length': stat.size,
        'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
}

function handler(req, res) {
    const urlPath = req.url === '/' ? '/index.html' : req.url;
    const filePath = safePath(urlPath);
    if (!filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }
  let target = filePath;
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) {
        target = path.join(target, 'index.html');
    }
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
    }
    try {
        sendFile(res, target);
    } catch (e) {
        res.writeHead(500);
        res.end(String(e.message || e));
    }
}

function ensureTlsMaterial() {
    const cert = path.join(CERT_DIR, 'cert.pem');
    const key = path.join(CERT_DIR, 'key.pem');
    if (fs.existsSync(cert) && fs.existsSync(key)) return { cert, key };
    fs.mkdirSync(CERT_DIR, { recursive: true });
    try {
        execSync(
            `openssl req -x509 -newkey rsa:2048 -keyout "${key}" -out "${cert}" -days 825 -nodes -subj "/CN=localhost"`,
            { stdio: 'ignore' },
        );
    } catch {
        console.error('无法生成 HTTPS 证书（需要系统安装 openssl）。请仅用 http://127.0.0.1，或手动把 cert.pem/key.pem 放到 tools/.certs/');
        process.exit(1);
    }
    return { cert, key };
}

function localIp() {
    const os = require('node:os');
    const nets = os.networkInterfaces();
    const out = [];
    for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
            if (net.family === 'IPv4' && !net.internal) out.push(net.address);
        }
    }
    return out;
}

function main() {
    const { port, host, httpsOn } = parseArgs();
    ensureWww();
    let server;
    if (httpsOn) {
        const { cert, key } = ensureTlsMaterial();
        server = https.createServer(
            { cert: fs.readFileSync(cert), key: fs.readFileSync(key) },
            handler,
        );
    } else {
        server = http.createServer(handler);
    }

    server.listen(port, host, () => {
        const scheme = httpsOn ? 'https' : 'http';
        const loopback = `${scheme}://127.0.0.1:${port}/`;
        console.log(`SF2 MIDI Ensemble（Web）`);
        console.log(`  本机：${loopback}`);
        if (host === '0.0.0.0') {
            const ips = localIp();
            for (const ip of ips) console.log(`  局域网：${scheme}://${ip}:${port}/`);
            if (!httpsOn) {
                console.log('  提示：手机 Web MIDI 需 HTTPS，请改用：npm run web:https -- --lan');
            } else {
                console.log('  提示：自签证书需在手机上信任或忽略警告；Chrome 桌面可用 Web MIDI（含蓝牙）');
            }
        }
        console.log('  推荐浏览器：Chrome / Edge（支持 Web MIDI + 蓝牙 BLE-MIDI）');
    });
}

main();
