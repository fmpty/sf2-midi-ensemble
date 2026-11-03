package com.sf2.ensemble;

import android.webkit.JavascriptInterface;

import com.sf2ensemble.synth.SynthBridgePlugin;

/**
 * 屏幕钢琴直连 JNI，绕过 Capacitor 插件桥，降低 Pad 触屏演奏延迟。
 */
public class PianoJsBridge {

    @JavascriptInterface
    public void noteOn(int channel, int note, int velocity) {
        if (channel < 0) channel = 0;
        if (channel > 15) channel = 15;
        note &= 127;
        velocity = Math.max(1, Math.min(127, velocity));
        try {
            SynthBridgePlugin.nativeNoteOn(channel, note, velocity);
        } catch (Throwable ignored) {
        }
    }

    @JavascriptInterface
    public void noteOff(int channel, int note) {
        if (channel < 0) channel = 0;
        if (channel > 15) channel = 15;
        note &= 127;
        try {
            SynthBridgePlugin.nativeNoteOff(channel, note);
        } catch (Throwable ignored) {
        }
    }
}
