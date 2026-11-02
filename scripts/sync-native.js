/**
 * 把 mobile/ 下的原生 MIDI 插件源码同步到 Capacitor 生成的 android/ ios/ 工程，
 * 并补齐权限声明（AndroidManifest.xml / Info.plist）与 Xcode 工程引用。
 *
 * 用法：node scripts/sync-native.js
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MOBILE = path.join(ROOT, 'mobile');

const rel = (p) => path.relative(ROOT, p);

function writeIfChanged(dest, content) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && fs.readFileSync(dest, 'utf8') === content) {
        console.log(`  未变化 ${rel(dest)}`);
        return false;
    }
    fs.writeFileSync(dest, content);
    console.log(`  已写入 ${rel(dest)}`);
    return true;
}

function copyFile(src, dest) {
    writeIfChanged(dest, fs.readFileSync(src, 'utf8'));
}

/* ------------------------------- Android ------------------------------- */

const ANDROID_MANIFEST = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const ANDROID_PERMISSIONS = `    <uses-feature android:name="android.software.midi" android:required="false" />
    <uses-feature android:name="android.hardware.usb.host" android:required="false" />
    <uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_ADMIN" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.BLUETOOTH_SCAN" android:usesPermissionFlags="neverForLocation" />
    <uses-permission android:name="android.permission.BLUETOOTH_CONNECT" />
    <uses-permission android:name="android.permission.ACCESS_FINE_LOCATION" android:maxSdkVersion="30" />
    <uses-permission android:name="android.permission.WAKE_LOCK" />
`;

function syncAndroid() {
    const ktDest = path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'sf2ensemble', 'midi', 'MidiBridgePlugin.kt');
    if (!fs.existsSync(path.join(ROOT, 'android'))) {
        console.log('Android 工程不存在，跳过（先执行 npx cap add android）');
        return;
    }
    console.log('Android:');
    // 原生合成（AAudio + TinySoundFont）
    const cppDir = path.join(ROOT, 'android', 'app', 'src', 'main', 'cpp');
    copyFile(path.join(MOBILE, 'android', 'synth', 'CMakeLists.txt'), path.join(cppDir, 'CMakeLists.txt'));
    copyFile(path.join(MOBILE, 'android', 'synth', 'native_synth.cpp'), path.join(cppDir, 'native_synth.cpp'));
    copyFile(path.join(MOBILE, 'android', 'synth', 'vendor', 'tsf.h'), path.join(cppDir, 'vendor', 'tsf.h'));
    copyFile(path.join(MOBILE, 'android', 'SynthBridgePlugin.java'),
        path.join(ROOT, 'android', 'app', 'src', 'main', 'java', 'com', 'sf2ensemble', 'synth', 'SynthBridgePlugin.java'));
    patchAndroidBuild();
    // 使用 Java 实现（app 模块未启用 Kotlin 插件，.kt 不会被编译）
    const legacyKt = path.join(path.dirname(ktDest), 'MidiBridgePlugin.kt');
    if (fs.existsSync(legacyKt)) {
        fs.unlinkSync(legacyKt);
        console.log(`  已移除 ${rel(legacyKt)}`);
    }
    copyFile(path.join(MOBILE, 'android', 'MidiBridgePlugin.java'),
        path.join(path.dirname(ktDest), 'MidiBridgePlugin.java'));

    if (fs.existsSync(ANDROID_MANIFEST)) {
        let xml = fs.readFileSync(ANDROID_MANIFEST, 'utf8');
        if (!xml.includes('android.software.midi')) {
            xml = xml.replace(/(\s*)(<application)/, `$1${ANDROID_PERMISSIONS}$1$2`);
            writeIfChanged(ANDROID_MANIFEST, xml);
        }
    } else {
        console.log('  未找到 AndroidManifest.xml');
    }
}

/** 给 app 模块加上 NDK 构建（CMake）并把 minSdk 提到 26（AAudio 要求） */
function patchAndroidBuild() {
    const gradle = path.join(ROOT, 'android', 'app', 'build.gradle');
    if (fs.existsSync(gradle)) {
        let text = fs.readFileSync(gradle, 'utf8');
        if (!text.includes('ndkVersion')) {
            text = text.replace(/(android \{\s*\n)/, '$1    ndkVersion "25.2.9519653"\n');
        }
        if (!text.includes('externalNativeBuild')) {
            text = text.replace(/(\n    buildTypes \{)/, `
    externalNativeBuild {
        cmake {
            path "src/main/cpp/CMakeLists.txt"
            version "3.18.1"
        }
    }
$1`);
        }
        writeIfChanged(gradle, text);
    }

    const vars = path.join(ROOT, 'android', 'variables.gradle');
    if (fs.existsSync(vars)) {
        let text = fs.readFileSync(vars, 'utf8');
        if (/minSdkVersion = 2[0-5]\b/.test(text)) {
            text = text.replace(/minSdkVersion = \d+/, 'minSdkVersion = 26');
            writeIfChanged(vars, text);
        }
    }
}

/* --------------------------------- iOS --------------------------------- */

const IOS_PLIST_ENTRIES = `\t<key>NSBluetoothAlwaysUsageDescription</key>
\t<string>需要连接蓝牙 MIDI 手柄进行演奏</string>
\t<key>NSBluetoothPeripheralUsageDescription</key>
\t<string>需要连接蓝牙 MIDI 手柄进行演奏</string>
\t<key>UIBackgroundModes</key>
\t<array>
\t\t<string>audio</string>
\t</array>
`;

function syncIos() {
    const iosApp = path.join(ROOT, 'ios', 'App', 'App');
    if (!fs.existsSync(path.join(ROOT, 'ios'))) {
        console.log('iOS 工程不存在，跳过（在 macOS 上先执行 npx cap add ios）');
        return;
    }
    console.log('iOS:');
    copyFile(path.join(MOBILE, 'ios', 'MidiBridge.swift'), path.join(iosApp, 'MidiBridge.swift'));
    copyFile(path.join(MOBILE, 'ios', 'MidiBridge.m'), path.join(iosApp, 'MidiBridge.m'));

    const plist = path.join(iosApp, 'Info.plist');
    if (fs.existsSync(plist)) {
        let text = fs.readFileSync(plist, 'utf8');
        if (!text.includes('NSBluetoothAlwaysUsageDescription')) {
            text = text.replace(/(\s*)(<\/dict>)/, `$1${IOS_PLIST_ENTRIES}$1$2`);
            writeIfChanged(plist, text);
        }
    } else {
        console.log('  未找到 Info.plist');
    }

    patchXcodeProject(path.join(ROOT, 'ios', 'App', 'App.xcodeproj', 'project.pbxproj'));
}

/** 把新增的 Swift / ObjC 文件加入 Xcode 工程（Capacitor 不会自动添加） */
function patchXcodeProject(pbx) {
    if (!fs.existsSync(pbx)) {
        console.log('  未找到 project.pbxproj，请手动把 MidiBridge.swift / MidiBridge.m 拖入 Xcode 工程');
        return;
    }
    let text = fs.readFileSync(pbx, 'utf8');
    if (text.includes('MidiBridge.swift')) {
        console.log('  Xcode 工程已包含 MidiBridge');
        return;
    }
    const anchor = '/* AppDelegate.swift */';
    if (!text.includes(anchor)) {
        console.log('  未找到 AppDelegate.swift 锚点，请手动添加文件到 Xcode 工程');
        return;
    }
    const hex = (n) => 'F1A2B3C4' + String(n).padStart(16, '0');
    const swiftRef = hex(1);
    const mRef = hex(2);
    const swiftBuild = hex(3);
    const mBuild = hex(4);

    try {
        // 1) 文件引用
        text = text.replace(
            /(\/\* AppDelegate\.swift \*\/ = \{isa = PBXFileReference;[^}]*\}\n)/,
            `$1\t\t${swiftRef} /* MidiBridge.swift */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.swift; path = MidiBridge.swift; sourceTree = "<group>"; };\n\t\t${mRef} /* MidiBridge.m */ = {isa = PBXFileReference; lastKnownFileType = sourcecode.c.objc; path = MidiBridge.m; sourceTree = "<group>"; };\n`
        );
        // 2) 编译文件
        text = text.replace(
            /(\/\* AppDelegate\.swift in Sources \*\/ = \{isa = PBXBuildFile;[^}]*\}\n)/,
            `$1\t\t${swiftBuild} /* MidiBridge.swift in Sources */ = {isa = PBXBuildFile; fileRef = ${swiftRef} /* MidiBridge.swift */; };\n\t\t${mBuild} /* MidiBridge.m in Sources */ = {isa = PBXBuildFile; fileRef = ${mRef} /* MidiBridge.m */; };\n`
        );
        // 3) group children
        text = text.replace(/\/\* AppDelegate\.swift \*\/,/g, `/* AppDelegate.swift */,\n\t\t\t\t${swiftRef} /* MidiBridge.swift */,\n\t\t\t\t${mRef} /* MidiBridge.m */,`);
        // 4) Sources 编译阶段
        text = text.replace(/\/\* AppDelegate\.swift in Sources \*\/,/g, `/* AppDelegate.swift in Sources */,\n\t\t\t\t${swiftBuild} /* MidiBridge.swift in Sources */,\n\t\t\t\t${mBuild} /* MidiBridge.m in Sources */,`);
        writeIfChanged(pbx, text);
    } catch (e) {
        console.log('  Xcode 工程修补失败，请手动把文件加入工程：' + e.message);
    }
}

console.log('同步原生 MIDI 插件：');
syncAndroid();
syncIos();
console.log('完成。之后执行 npx cap sync 以同步 Web 资源。');
