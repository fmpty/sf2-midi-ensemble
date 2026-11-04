/**
 * Gradle 前：选用已完整安装的 NDK，并写入 android/app/build.gradle 的 ndkVersion。
 * 优先 28（16KB 页），若 28 目录损坏则提示删除并重装，或回退到本机最高可用版本。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PREFERRED = ['28.0.13004108', '27.2.12479018', '26.3.11579264', '25.2.9519653'];

function sdkRoot() {
    return (
        process.env.ANDROID_HOME ||
        process.env.ANDROID_SDK_ROOT ||
        path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk')
    );
}

function isValidNdkDir(dir) {
    return fs.existsSync(path.join(dir, 'source.properties'));
}

function listInstalledNdks(ndkRoot) {
    if (!fs.existsSync(ndkRoot)) return [];
    return fs.readdirSync(ndkRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

function pickNdkVersion(ndkRoot) {
    const installed = listInstalledNdks(ndkRoot);
    for (const want of PREFERRED) {
        if (!installed.includes(want)) continue;
        if (isValidNdkDir(path.join(ndkRoot, want))) return want;
    }
    const valid = installed.filter((v) => isValidNdkDir(path.join(ndkRoot, v)));
    valid.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return valid[0] || null;
}

function patchGradleNdkVersion(version) {
    const gradle = path.join(ROOT, 'android', 'app', 'build.gradle');
    let text = fs.readFileSync(gradle, 'utf8');
    if (!text.includes('ndkVersion')) {
        text = text.replace(/(android \{\s*\n)/, `$1    ndkVersion "${version}"\n`);
    } else {
        text = text.replace(/ndkVersion "[^"]+"/, `ndkVersion "${version}"`);
    }
    fs.writeFileSync(gradle, text);
}

function findProjectJdkHome() {
    const tools = path.join(ROOT, '.tools', 'jdk21');
    if (!fs.existsSync(tools)) return process.env.JAVA_HOME || '';
    const stack = [tools];
    while (stack.length) {
        const cur = stack.pop();
        for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
            const p = path.join(cur, ent.name);
            if (ent.isDirectory()) stack.push(p);
        }
        const java = path.join(cur, 'bin', 'java.exe');
        if (fs.existsSync(java)) return path.dirname(path.dirname(java));
    }
    return process.env.JAVA_HOME || '';
}

function tryInstallNdk28(sdk, ndkRoot) {
    const sdkmanager = path.join(sdk, 'cmdline-tools', 'latest', 'bin', 'sdkmanager.bat');
    if (!fs.existsSync(sdkmanager)) {
        const alt = path.join(sdk, 'tools', 'bin', 'sdkmanager.bat');
        if (!fs.existsSync(alt)) return false;
    }
    const bin = fs.existsSync(sdkmanager) ? sdkmanager : path.join(sdk, 'tools', 'bin', 'sdkmanager.bat');
    const javaHome = findProjectJdkHome();
    console.log('正在通过 sdkmanager 安装 NDK 28.0.13004108（约需数分钟）…');
    const r = spawnSync(bin, ['--install', 'ndk;28.0.13004108'], {
        stdio: 'inherit',
        shell: true,
        env: {
            ...process.env,
            ANDROID_HOME: sdk,
            ANDROID_SDK_ROOT: sdk,
            ...(javaHome ? { JAVA_HOME: javaHome } : {}),
        },
    });
    return r.status === 0 && isValidNdkDir(path.join(ndkRoot, '28.0.13004108'));
}

function main() {
    const sdk = sdkRoot();
    const ndkRoot = path.join(sdk, 'ndk');
    const broken28 = path.join(ndkRoot, '28.0.13004108');
    if (fs.existsSync(broken28) && !isValidNdkDir(broken28)) {
        console.warn('\n[ensure-ndk] NDK 28.0.13004108 目录不完整（缺少 source.properties），Gradle 会报 CXX1101。');
        console.warn(`  损坏目录：${broken28}`);
        console.warn('  正在删除空壳目录以便重装…');
        try {
            fs.rmSync(broken28, { recursive: true, force: true });
        } catch (e) {
            console.error(`  无法删除，请手动删掉该文件夹后重试 F6：${e.message}`);
            process.exit(1);
        }
        if (!tryInstallNdk28(sdk, ndkRoot)) {
            console.warn('  自动安装 NDK 28 未成功。请在 Android Studio → SDK Manager → NDK 勾选 28.0.13004108 安装。');
        }
    }

    let version = pickNdkVersion(ndkRoot);
    if (!version) {
        console.error('\n[ensure-ndk] 未找到任何完整 NDK。请安装 Android SDK NDK（建议 28.0.13004108）。');
        process.exit(1);
    }

    patchGradleNdkVersion(version);
    if (version !== '28.0.13004108') {
        console.warn(`[ensure-ndk] 使用 NDK ${version}（非 28 时 16KB 页对齐校验可能失败，建议装齐 NDK 28）。`);
    } else {
        console.log(`[ensure-ndk] 使用 NDK ${version}`);
    }
}

main();
