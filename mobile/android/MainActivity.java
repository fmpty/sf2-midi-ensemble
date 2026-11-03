package com.sf2.ensemble;

import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.WindowManager;
import android.webkit.WebView;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.sf2ensemble.midi.MidiBridgePlugin;
import com.sf2ensemble.synth.SynthBridgePlugin;

public class MainActivity extends BridgeActivity {

    private boolean pianoJsAttached = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MidiBridgePlugin.class);
        registerPlugin(SynthBridgePlugin.class);
        super.onCreate(savedInstanceState);
        getWindow().getDecorView().setBackgroundColor(Color.parseColor("#0e1116"));
        applyImmersive();
        tintWebViewBackground();
    }

    @Override
    public void onStart() {
        super.onStart();
        attachPianoJsBridge();
        tintWebViewBackground();
    }

    @Override
    public void onResume() {
        super.onResume();
        attachPianoJsBridge();
        tintWebViewBackground();
    }

    /** 屏幕钢琴：WebView JavascriptInterface → nativeNoteOn/Off */
    private void attachPianoJsBridge() {
        if (pianoJsAttached || getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        webView.addJavascriptInterface(new PianoJsBridge(), "Sf2PianoNative");
        pianoJsAttached = true;
    }

    /** WebView 默认白底，在 HTML/CSS 就绪前会闪白屏 */
    private void tintWebViewBackground() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView != null) {
            webView.setBackgroundColor(Color.parseColor("#0e1116"));
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersive();
    }

    /** 全屏沉浸：内容延伸到状态栏/导航栏，手势边缘唤出系统栏 */
    private void applyImmersive() {
        WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        WindowInsetsControllerCompat ctrl =
                WindowCompat.getInsetsController(getWindow(), getWindow().getDecorView());
        if (ctrl == null) return;
        ctrl.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        ctrl.hide(WindowInsetsCompat.Type.statusBars() | WindowInsetsCompat.Type.navigationBars());
    }
}
