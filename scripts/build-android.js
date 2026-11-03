/**
 * 构建 Android APK。
 * - 自动准备 JDK 17（Adoptium，下载到 .tools/jdk17）
 * - 使用镜像 init script 加速依赖下载
 * - 产出 android/app/build/outputs/apk/debug/app-debug.apk
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const TOOLS = path.join(ROOT, '.tools');
const JDK_DIR = path.join(TOOLS, 'jdk21');
const JDK_ZIP = path.join(TOOLS, 'jdk21.zip');
const JDK_MIN = 21; // Capacitor / AGP 需要 Java 21 工具链
// 优先国内镜像（Adoptium 官方源会重定向到 GitHub，国内网络常不可达）
const JDK_URLS = [
    'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/x64/windows/OpenJDK21U-jdk_x64_windows_hotspot_21.0.13_9.zip',
    'https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse',
];

function run(cmd, args, opts = {}) {
    console.log(`> ${cmd} ${args.join(' ')}`);
    const r = spawnSync(cmd, args, { stdio: 'inherit', shell: true, cwd: ROOT, ...opts });
    return r.status === 0;
}

function findJavaExe(dir, depth = 2) {
    if (!fs.existsSync(dir)) return null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory() && depth > 0) {
            const found = findJavaExe(p, depth - 1);
            if (found) return found;
        }
    }
    const candidate = path.join(dir, 'bin', 'java.exe');
    return fs.existsSync(candidate) ? candidate : null;
}

function javaMajor(javaExe) {
    const r = spawnSync(`"${javaExe}"`, ['-version'], { encoding: 'utf8', shell: true });
    const out = `${r.stdout || ''}${r.stderr || ''}`;
    const m = out.match(/version "(\d+)/);
    return m ? Number(m[1]) : 0;
}

async function ensureJdk() {
    const fromEnv = process.env.JAVA_HOME && findJavaExe(process.env.JAVA_HOME, 0);
    if (fromEnv && javaMajor(fromEnv) >= JDK_MIN) {
        console.log(`使用 JAVA_HOME=${process.env.JAVA_HOME}`);
        return path.dirname(path.dirname(fromEnv));
    }
    const local = findJavaExe(JDK_DIR, 2);
    if (local && javaMajor(local) >= JDK_MIN) {
        console.log(`使用本地 JDK：${local}`);
        return path.dirname(path.dirname(local));
    }
    console.log(`未找到 JDK ${JDK_MIN}，正在下载 OpenJDK ${JDK_MIN}（约 190 MB）…`);
    fs.mkdirSync(TOOLS, { recursive: true });
    let buf = null;
    for (const url of JDK_URLS) {
        try {
            console.log(`  尝试：${url}`);
            const res = await fetch(url);
            if (!res.ok) continue;
            buf = Buffer.from(await res.arrayBuffer());
            if (buf.length > 50 * 1024 * 1024) break;
            buf = null;
        } catch (e) {
            console.log(`  失败：${e.message}`);
        }
    }
    if (!buf) throw new Error(`JDK 下载失败，请手动安装 JDK ${JDK_MIN} 并设置 JAVA_HOME`);
    fs.writeFileSync(JDK_ZIP, buf);
    console.log(`已下载 ${(buf.length / 1048576).toFixed(1)} MB，解压中…`);
    if (!run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path "${JDK_ZIP}" -DestinationPath "${JDK_DIR}" -Force`])) {
        throw new Error('JDK 解压失败');
    }
    fs.unlinkSync(JDK_ZIP);
    const javaExe = findJavaExe(JDK_DIR, 2);
    if (!javaExe) throw new Error('解压后未找到 java.exe');
    return path.dirname(path.dirname(javaExe));
}

/**
 * 补齐 local.properties（SDK 路径）并把 Gradle 发行包换为国内镜像，
 * 避免 services.gradle.org 在受限网络下超时。
 */
function prepareAndroidProject() {
    const androidDir = path.join(ROOT, 'android');
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ||
        path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk');
    const localProps = path.join(androidDir, 'local.properties');
    const content = `sdk.dir=${sdk.replace(/\\/g, '\\\\')}\n`;
    if (!fs.existsSync(localProps) || fs.readFileSync(localProps, 'utf8') !== content) {
        fs.writeFileSync(localProps, content);
        console.log(`已写入 ${path.relative(ROOT, localProps)} -> ${sdk}`);
    }

    const wrapper = path.join(androidDir, 'gradle', 'wrapper', 'gradle-wrapper.properties');
    if (fs.existsSync(wrapper)) {
        let text = fs.readFileSync(wrapper, 'utf8');
        const m = text.match(/distributionUrl=.*?gradle-([\d.]+-all)\.zip/);
        if (text.includes('services.gradle.org') && m) {
            text = text.replace(
                /distributionUrl=.*/,
                `distributionUrl=https\\://mirrors.cloud.tencent.com/gradle/gradle-${m[1]}.zip`
            );
        }
        text = text.replace(/networkTimeout=\d+/, 'networkTimeout=120000');
        fs.writeFileSync(wrapper, text);
        console.log('Gradle 发行包已切换为国内镜像');
    }
}

(async () => {
    const javaHome = await ensureJdk();
    const androidDir = path.join(ROOT, 'android');
    if (!fs.existsSync(androidDir)) {
        console.error('缺少 android 工程，请先执行：npx cap add android');
        process.exit(1);
    }
    prepareAndroidProject(javaHome);

    const args = [
        path.join(androidDir, 'gradlew.bat'),
        'assembleDebug',
        '--init-script', path.join(ROOT, 'scripts', 'gradle-mirrors.gradle'),
    ];
    const toolOpts = '-Dfile.encoding=UTF-8 -Duser.language=en -Duser.country=US';
    const prevTool = process.env.JAVA_TOOL_OPTIONS || '';
    const javaToolOptions = prevTool ? `${prevTool} ${toolOpts}` : toolOpts;
    const ok = run(args[0], args.slice(1), {
        cwd: androidDir,
        env: {
            ...process.env,
            JAVA_HOME: javaHome,
            ANDROID_HOME: process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk'),
            JAVA_TOOL_OPTIONS: javaToolOptions,
            GRADLE_OPTS: (process.env.GRADLE_OPTS || '') + ' -Dorg.gradle.console=plain',
        },
    });
    const apk = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
    if (ok && fs.existsSync(apk)) {
        console.log(`\nAPK 构建成功：${path.relative(ROOT, apk)}  (${(fs.statSync(apk).size / 1048576).toFixed(1)} MB)`);
    } else if (ok) {
        console.log('\nGradle 构建完成，但未找到预期的 APK 输出。');
    } else {
        process.exit(1);
    }
})().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
